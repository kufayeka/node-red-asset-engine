const mqtt = require("mqtt");
const sparkplug = require("../lib/sparkplug/sparkplugCodec");

const NAMESPACE = "spBv1.0";

// See nodes/sparkplug-edge-node.js's own copy of this helper for why plain
// `err.message` isn't enough — some errors from `mqtt`/net/tls carry the
// useful detail on .code/.errno/.reason instead, or nowhere normal at all.
function describeError(err) {
  if (!err) return "(no error object)";
  var parts = [];
  if (err.message) parts.push(err.message);
  if (err.code) parts.push("code=" + err.code);
  if (err.errno !== undefined) parts.push("errno=" + err.errno);
  if (err.reason) parts.push("reason=" + err.reason);
  if (parts.length) return parts.join(" ");
  try {
    return JSON.stringify(err);
  } catch (e) {
    return String(err);
  }
}

// A handful of structural spec checks that can be judged from ONE decoded
// payload plus a little per-edge-node running state (the seq counter).
// This is deliberately not the full TCK — see the node's own help text for
// what it does NOT check (STATE/Primary Host handshake, DataSet/Template
// metrics, metric aliasing, full DataType matrix, etc.).
function checkCompliance(msgType, payload, state) {
  var issues = [];
  var metrics = payload.metrics || [];

  if (payload.timestamp === undefined || payload.timestamp === null) {
    issues.push('payload is missing its top-level "timestamp"');
  }

  var seenNames = {};
  metrics.forEach(function (m) {
    if (!m || !m.name) {
      issues.push("a metric in this payload has an empty/missing name");
      return;
    }
    if (seenNames[m.name]) {
      issues.push('duplicate metric name in the same payload: "' + m.name + '"');
    }
    seenNames[m.name] = true;
  });

  var isBirth = msgType === "NBIRTH" || msgType === "DBIRTH";
  var isDeath = msgType === "NDEATH" || msgType === "DDEATH";
  var isCommand = msgType === "NCMD" || msgType === "DCMD";

  if (msgType === "NBIRTH") {
    // [tck-id-message-flow-edge-node-birth-publish-will-message-payload-bdSeq]
    if (!metrics.some(function (m) { return m.name === "bdSeq"; })) {
      issues.push('NBIRTH is missing its mandatory "bdSeq" metric');
    }
    // [tck-id-topics-nbirth-rebirth-metric]
    var rebirth = metrics.find(function (m) { return m.name === "Node Control/Rebirth"; });
    if (!rebirth) {
      issues.push('NBIRTH is missing the mandatory "Node Control/Rebirth" metric');
    } else if (rebirth.type !== "Boolean") {
      issues.push('"Node Control/Rebirth" metric must be type Boolean, got "' + rebirth.type + '"');
    }
  }

  if (isBirth && payload.seq !== 0) {
    issues.push("a BIRTH message must reset seq to 0, got " + payload.seq);
  }

  // seq is one shared, node-wide counter across NBIRTH/DBIRTH/NDATA/DDATA —
  // NOT a per-device one — and isn't meaningful on command/death messages,
  // so only THOSE four participate in continuity tracking here.
  if (!isDeath && !isCommand && payload.seq !== undefined && payload.seq !== null) {
    if (!isBirth && state.lastSeq !== null) {
      var expected = (state.lastSeq + 1) % 256;
      if (payload.seq !== expected) {
        issues.push(
          "seq gap: expected " + expected + " but got " + payload.seq +
          " (a message for this edge node may have been lost or delivered out of order)"
        );
      }
    }
    state.lastSeq = payload.seq;
  }

  return issues;
}

module.exports = function (RED) {
  function SparkplugInNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    var brokerUrl = config.brokerUrl || "mqtt://localhost:1883";
    var username = node.credentials && node.credentials.username;
    var password = node.credentials && node.credentials.password;
    var groupFilter = config.groupFilter && config.groupFilter.trim() ? config.groupFilter.trim() : "+";
    var edgeNodeFilter = config.edgeNodeFilter && config.edgeNodeFilter.trim() ? config.edgeNodeFilter.trim() : "+";

    var nodeTopicFilter = NAMESPACE + "/" + groupFilter + "/+/" + edgeNodeFilter;
    var deviceTopicFilter = NAMESPACE + "/" + groupFilter + "/+/" + edgeNodeFilter + "/+";

    var client = null;
    var closing = false;
    var connected = false;
    var msgCount = 0;
    var issueCount = 0;
    // seq continuity is scoped per (groupId, edgeNodeId) — a single monitor
    // node can watch many edge nodes at once via wildcards, and each has
    // its own independent seq counter.
    var edgeStates = {};

    function updateStatus() {
      if (!connected) {
        node.status({ fill: "red", shape: "ring", text: "disconnected" });
        return;
      }
      if (issueCount > 0) {
        node.status({ fill: "yellow", shape: "dot", text: msgCount + " msg(s), " + issueCount + " issue(s)" });
      } else {
        node.status({ fill: "green", shape: "dot", text: msgCount + " msg(s)" });
      }
    }

    function onMessage(topic, buf) {
      var parts = topic.split("/");
      if (parts[0] !== NAMESPACE) return;
      var groupId = parts[1];
      var msgType = parts[2];
      var edgeNodeId = parts[3];
      var deviceId = parts[4]; // undefined for node-level (NBIRTH/NDATA/NCMD/NDEATH) messages

      var sparkplugMeta = {
        namespace: parts[0],
        groupId: groupId,
        messageType: msgType,
        edgeNodeId: edgeNodeId,
        deviceId: deviceId
      };

      var payload;
      try {
        payload = sparkplug.decodePayload(buf);
      } catch (e) {
        msgCount++;
        issueCount++;
        updateStatus();
        node.send({
          topic: topic,
          payload: null,
          sparkplug: sparkplugMeta,
          complianceIssues: ["failed to decode payload as a Sparkplug B protobuf: " + describeError(e)]
        });
        return;
      }

      var stateKey = groupId + "/" + edgeNodeId;
      if (!edgeStates[stateKey]) edgeStates[stateKey] = { lastSeq: null };
      var issues = checkCompliance(msgType, payload, edgeStates[stateKey]);

      msgCount++;
      issueCount += issues.length;
      updateStatus();

      node.send({
        topic: topic,
        payload: payload,
        sparkplug: sparkplugMeta,
        complianceIssues: issues
      });
    }

    function connect() {
      node.status({ fill: "yellow", shape: "ring", text: "connecting" });
      client = mqtt.connect(brokerUrl, {
        username: username,
        password: password,
        // A random-ish, unique-per-node clientId is the RIGHT call here —
        // unlike the Edge Node (nodes/sparkplug-edge-node.js), this node
        // has no identity to protect: it's a passive monitor, and you may
        // legitimately want several of these watching the same broker at
        // once (e.g. two different debugging flows). A stable/shared
        // clientId would make them kick each other off instead.
        clientId: "kufayeka-sparkplug-in-" + node.id
      });

      client.on("connect", function () {
        connected = true;
        node.log("Sparkplug In \"" + node.id + "\" connected to " + brokerUrl);
        client.subscribe([nodeTopicFilter, deviceTopicFilter], { qos: 0 }, function (err) {
          if (err) node.warn("Sparkplug In: failed to subscribe: " + describeError(err));
        });
        updateStatus();
      });
      client.on("message", onMessage);
      client.on("reconnect", function () {
        connected = false;
        node.status({ fill: "yellow", shape: "ring", text: "reconnecting" });
      });
      client.on("close", function () {
        connected = false;
        if (!closing) {
          updateStatus();
          node.warn("Sparkplug In: MQTT connection closed (client will auto-reconnect)");
        }
      });
      client.on("error", function (err) {
        connected = false;
        node.status({ fill: "red", shape: "ring", text: "error" });
        node.warn("Sparkplug In MQTT error: " + describeError(err));
      });
    }

    connect();

    node.on("close", function (done) {
      closing = true;
      if (!client) { done(); return; }
      // This node never publishes anything, so — unlike the Edge Node's
      // close handler — there's no graceful-publish-then-wait-for-ack step
      // that could hang if the broker is already gone; just tear down.
      client.end(true, {}, function () { done(); });
    });
  }

  RED.nodes.registerType("kufayeka-sparkplug-in", SparkplugInNode, {
    credentials: {
      username: { type: "text" },
      password: { type: "password" }
    }
  });
};
