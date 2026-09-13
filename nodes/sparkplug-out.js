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

// This node acts as a generic Sparkplug WRITER — a stand-in for a real
// Sparkplug Host Application (Ignition, Chariot, ...) so you can test the
// Edge Node's write path and rebirth-request handling from a plain Node-RED
// flow, without standing up a full Host first. It never publishes
// NBIRTH/DBIRTH/DDATA itself — only NCMD/DCMD, exactly the two message
// types a Host/gateway is allowed to originate (spec §4.1.3, p.19).
module.exports = function (RED) {
  function SparkplugOutNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    var brokerUrl = config.brokerUrl || "mqtt://localhost:1883";
    var username = node.credentials && node.credentials.username;
    var password = node.credentials && node.credentials.password;
    var defaultGroupId = config.groupId || "";
    var defaultEdgeNodeId = config.edgeNodeId || "";
    var defaultDeviceId = config.deviceId || "";

    var client = null;
    var closing = false;
    var connected = false;

    function updateStatus() {
      node.status(connected
        ? { fill: "green", shape: "dot", text: "connected" }
        : { fill: "red", shape: "ring", text: "disconnected" });
    }

    function connect() {
      node.status({ fill: "yellow", shape: "ring", text: "connecting" });
      client = mqtt.connect(brokerUrl, {
        username: username,
        password: password,
        // No identity to protect here (see sparkplug-in.js's own note on
        // the same choice) — several sparkplug-out nodes may legitimately
        // point at the same broker at once.
        clientId: "kufayeka-sparkplug-out-" + node.id
      });
      client.on("connect", function () {
        connected = true;
        updateStatus();
      });
      client.on("reconnect", function () {
        connected = false;
        node.status({ fill: "yellow", shape: "ring", text: "reconnecting" });
      });
      client.on("close", function () {
        connected = false;
        if (!closing) updateStatus();
      });
      client.on("error", function (err) {
        connected = false;
        node.status({ fill: "red", shape: "ring", text: "error" });
        node.warn("Sparkplug Out MQTT error: " + describeError(err));
      });
    }

    connect();

    // Resolves what to publish from one incoming msg:
    //  - msg.command === "rebirth" (or no metrics/payload given at all) ->
    //    the standard "Node Control/Rebirth" NCMD request.
    //  - msg.metrics (array of {name,type,value[,isNull]}) if given, else
    //  - msg.payload treated as a single {name,type,value} metric shorthand.
    function resolveMetrics(msg) {
      if (msg.command === "rebirth") {
        return { metrics: [{ name: "Node Control/Rebirth", type: "Boolean", value: true }], forceNodeLevel: true };
      }
      if (Array.isArray(msg.metrics)) {
        return { metrics: msg.metrics, forceNodeLevel: false };
      }
      if (msg.payload && typeof msg.payload === "object" && msg.payload.name) {
        return { metrics: [msg.payload], forceNodeLevel: false };
      }
      return null;
    }

    node.on("input", function (msg, send, done) {
      send = send || function () { node.send.apply(node, arguments); };
      done = done || function (err) { if (err) node.error(err, msg); };

      if (!client || !connected) {
        done(new Error("Sparkplug Out: not connected to the broker yet"));
        return;
      }

      var sp = msg.sparkplug || {};
      var groupId = sp.groupId || defaultGroupId;
      var edgeNodeId = sp.edgeNodeId || defaultEdgeNodeId;
      var deviceId = sp.deviceId !== undefined ? sp.deviceId : defaultDeviceId;

      if (!groupId || !edgeNodeId) {
        done(new Error("Sparkplug Out: groupId/edgeNodeId not set (configure a default in the node, or set msg.sparkplug.groupId/edgeNodeId)"));
        return;
      }

      var resolved = resolveMetrics(msg);
      if (!resolved) {
        done(new Error("Sparkplug Out: nothing to publish — set msg.command=\"rebirth\", or msg.metrics (array), or msg.payload ({name,type,value})"));
        return;
      }
      if (resolved.forceNodeLevel) deviceId = ""; // a rebirth request is always a node-level (NCMD) command

      var isDeviceScoped = !!deviceId;
      var topic = isDeviceScoped
        ? NAMESPACE + "/" + groupId + "/DCMD/" + edgeNodeId + "/" + deviceId
        : NAMESPACE + "/" + groupId + "/NCMD/" + edgeNodeId;

      var payload;
      try {
        payload = sparkplug.encodePayload({ timestamp: Date.now(), metrics: resolved.metrics });
      } catch (e) {
        done(new Error("Sparkplug Out: failed to encode payload: " + describeError(e)));
        return;
      }

      // [tck-id-payloads-ncmd-qos]/[-dcmd-qos]: both MUST be published at QoS 0.
      client.publish(topic, payload, { qos: 0, retain: false }, function (err) {
        if (err) {
          done(new Error("Sparkplug Out: publish to \"" + topic + "\" failed: " + describeError(err)));
          return;
        }
        msg.sparkplug = {
          namespace: NAMESPACE,
          groupId: groupId,
          edgeNodeId: edgeNodeId,
          deviceId: isDeviceScoped ? deviceId : undefined,
          messageType: isDeviceScoped ? "DCMD" : "NCMD",
          topic: topic
        };
        send(msg);
        done();
      });
    });

    node.on("close", function (done) {
      closing = true;
      if (!client) { done(); return; }
      // This node never registers a Will or needs a graceful death publish
      // of its own (it's a writer, not an Edge Node identity) — just tear
      // the connection down.
      client.end(true, {}, function () { done(); });
    });
  }

  RED.nodes.registerType("kufayeka-sparkplug-out", SparkplugOutNode, {
    credentials: {
      username: { type: "text" },
      password: { type: "password" }
    }
  });
};
