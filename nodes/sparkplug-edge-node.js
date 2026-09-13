const mqtt = require("mqtt");
const sparkplug = require("../lib/sparkplug/sparkplugCodec");
const { getAssetController } = require("../lib/asset-plugin");
const {
  toSparkplugMetric,
  topLevelNameFromPath,
  relativeMetricNameFromPath,
  collectDeviceMetrics
} = require("../lib/sparkplug/sparkplugMapping");

const NAMESPACE = "spBv1.0";

// `err.message` alone was showing up completely EMPTY in practice (a real
// user-reported "Sparkplug MQTT error:" with nothing after the colon) —
// some errors the `mqtt` package (or Node's own net/tls layer underneath
// it) emits aren't plain Error instances with a normal .message, or carry
// the actually-useful detail on a different field (.code, .errno,
// .reason, a nested .cause). Dumping the whole thing is the only way to
// not lose that information a second time.
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

module.exports = function (RED) {
  function SparkplugEdgeNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;

    node.groupId = config.groupId || "Kufayeka";
    node.edgeNodeId = config.edgeNodeId || node.id;
    var brokerUrl = config.brokerUrl || "mqtt://localhost:1883";
    var username = node.credentials && node.credentials.username;
    var password = node.credentials && node.credentials.password;

    var asset = RED.asset || getAssetController(RED);
    if (!asset) {
      node.error("Asset engine not available — is @kufayeka/node-red-asset-engine's plugin loaded?");
      return;
    }

    // Sparkplug's own per-message ordering counter (0-255, wraps), reset to
    // 0 by every NBIRTH and incremented by 1 on every message after it —
    // lets a Host Application detect a dropped/out-of-order message.
    var seq = 0;
    function nextSeq() {
      var s = seq;
      seq = (seq + 1) % 256;
      return s;
    }
    // Birth/death correlation counter — bumped each time a NEW MQTT session
    // is established, so a Host Application can tell a Death certificate
    // apart from a stale one belonging to an earlier session. Wraps at 255
    // per [tck-id-message-flow-edge-node-birth-publish-will-message-payload-
    // bdSeq] (bdSeq is a single-byte counter, not an ever-growing one).
    // Deliberate v1 gap: NOT persisted across Node-RED restarts (starts at 0
    // every time). It IS bumped on every underlying `mqtt` reconnect, not
    // just node startup — see the "reconnect" handler below.
    var bdSeq = 0;

    var client = null;
    var unsubscribeAssetChanges = null;
    var closing = false;

    // A config node has no box of its own on the canvas, so its status is
    // otherwise invisible — re-emitted as an event so a companion
    // kufayeka-sparkplug-status node (dropped on any flow tab, referencing
    // this config node) can mirror it onto something the user can actually
    // see. Config nodes are plain Node-RED Nodes (EventEmitters), so this
    // needs nothing beyond .emit()/.on() — see nodes/sparkplug-status.js.
    function setStatus(status) {
      node.status(status);
      node.emit("sparkplug-status", status);
    }

    var nodeDeathTopic = NAMESPACE + "/" + node.groupId + "/NDEATH/" + node.edgeNodeId;
    var nodeBirthTopic = NAMESPACE + "/" + node.groupId + "/NBIRTH/" + node.edgeNodeId;
    var nodeCmdTopic = NAMESPACE + "/" + node.groupId + "/NCMD/" + node.edgeNodeId;
    var deviceCmdTopicFilter = NAMESPACE + "/" + node.groupId + "/DCMD/" + node.edgeNodeId + "/+";

    function deathPayloadBuffer() {
      return sparkplug.encodePayload({
        timestamp: Date.now(),
        metrics: [{ name: "bdSeq", type: "Int64", value: bdSeq }]
      });
    }

    function publishBirth() {
      seq = 0; // NBIRTH always resets the sequence counter, per spec
      var nbirth = sparkplug.encodePayload({
        timestamp: Date.now(),
        seq: nextSeq(),
        metrics: [
          { name: "bdSeq", type: "Int64", value: bdSeq },
          // MANDATORY per spec (tck-id-topics-nbirth-rebirth-metric /
          // -operational-behavior-data-commands-rebirth-*): every NBIRTH
          // must advertise this exact metric (Boolean, false) so a Host
          // Application knows it can request a rebirth by publishing it
          // back as an NCMD with value true — see onMessage's NCMD branch,
          // which already implements the RECEIVING half of this contract.
          { name: "Node Control/Rebirth", type: "Boolean", value: false }
        ]
      });
      // QoS 0, NOT 1: [tck-id-payloads-nbirth-qos]/[-dbirth-qos] — Sparkplug
      // relies on its OWN seq/bdSeq numbering (not MQTT QoS) to let a Host
      // Application detect a lost or out-of-order Birth.
      client.publish(nodeBirthTopic, nbirth, { qos: 0, retain: false });

      var hierarchy = asset.getHierarchy({ populateAttributes: true }) || [];
      hierarchy.forEach(function (rootNode) {
        var dbirthTopic = NAMESPACE + "/" + node.groupId + "/DBIRTH/" + node.edgeNodeId + "/" + rootNode.name;
        var payload = sparkplug.encodePayload({
          timestamp: Date.now(),
          seq: nextSeq(),
          metrics: collectDeviceMetrics(rootNode)
        });
        client.publish(dbirthTopic, payload, { qos: 0, retain: false });
      });
      setStatus({ fill: "green", shape: "dot", text: "online (" + hierarchy.length + " device" + (hierarchy.length === 1 ? "" : "s") + ")" });
    }

    function onAssetChange(meta) {
      if (!client || !client.connected) return;
      var changes = (meta && meta.change && meta.change.changes) || [];
      if (!changes.length) return;
      // One bulk write (setAttributes/applySchema) can touch several
      // top-level assets (Devices) at once, but a Sparkplug DDATA is always
      // scoped to exactly one Device — group by Device before publishing.
      var byDevice = {};
      changes.forEach(function (c) {
        if (!c || !c.path) return;
        var topName = topLevelNameFromPath(c.path);
        var relName = relativeMetricNameFromPath(c.path, topName);
        if (!relName) return; // change on the root asset's own "self" record, not an attribute
        (byDevice[topName] = byDevice[topName] || []).push(toSparkplugMetric(c, relName));
      });
      Object.keys(byDevice).forEach(function (deviceId) {
        var topic = NAMESPACE + "/" + node.groupId + "/DDATA/" + node.edgeNodeId + "/" + deviceId;
        try {
          var payload = sparkplug.encodePayload({ timestamp: Date.now(), seq: nextSeq(), metrics: byDevice[deviceId] });
          client.publish(topic, payload, { qos: 0, retain: false });
        } catch (e) {
          // asset.subscribe()'s own caller (AssetStoreFactory's emitChange)
          // already wraps every listener in a try/catch, so a throw here
          // wouldn't crash anything either way — but without this it'd only
          // ever show up as a generic, unhelpful
          // "asset store listener error:" in the console, with no hint this
          // was actually a Sparkplug encoding problem for THIS device.
          node.warn("Sparkplug: failed to publish DDATA for device \"" + deviceId + "\": " + describeError(e));
        }
      });
    }

    // Both NCMD (no Device segment — treated as a direct dotted attribute
    // path) and DCMD (deviceId + a Device-relative slash-separated metric
    // name) end up at the exact same place: applying the write through
    // asset.setAttribute, the SAME entry point src/nodes/asset-write.js uses
    // — a Sparkplug write is not a second, parallel write path, just another
    // caller of the one real one.
    function applyIncomingMetric(fullPath, value) {
      try {
        asset.setAttribute(fullPath, value);
      } catch (e) {
        node.warn("Sparkplug: failed to apply incoming write to \"" + fullPath + "\": " + describeError(e));
      }
    }

    function onMessage(topic, buf) {
      var parts = topic.split("/");
      if (parts[0] !== NAMESPACE || parts[1] !== node.groupId) return;
      var msgType = parts[2];
      var deviceId = parts[4];
      var payload;
      try {
        payload = sparkplug.decodePayload(buf);
      } catch (e) {
        node.warn("Sparkplug: failed to decode incoming payload on \"" + topic + "\": " + describeError(e));
        return;
      }
      var metrics = payload.metrics || [];

      if (msgType === "NCMD") {
        // Standard Sparkplug convention: a Host Application sends
        // "Node Control/Rebirth"=true when it needs a fresh NBIRTH+DBIRTH
        // (e.g. it just (re)connected and missed the original one).
        var rebirthRequested = metrics.some(function (m) { return m.name === "Node Control/Rebirth" && m.value === true; });
        if (rebirthRequested) {
          publishBirth();
          return;
        }
        metrics.forEach(function (m) {
          if (m && m.name) applyIncomingMetric(m.name.split("/").join("."), m.value);
        });
        return;
      }

      if (msgType === "DCMD" && deviceId) {
        metrics.forEach(function (m) {
          if (m && m.name) applyIncomingMetric(deviceId + "." + m.name.split("/").join("."), m.value);
        });
      }
    }

    function connect() {
      setStatus({ fill: "yellow", shape: "ring", text: "connecting" });
      // Wraps at 255, per [tck-id-message-flow-edge-node-birth-publish-will-
      // message-payload-bdSeq]: "MUST NOT be included... unless the value
      // would be greater than 255... MUST have a value of 0" — bdSeq is a
      // single-byte counter, not an ever-growing one.
      bdSeq = (bdSeq + 1) % 256;
      client = mqtt.connect(brokerUrl, {
        username: username,
        password: password,
        // STABLE, not random-per-connect: a random suffix here would defeat
        // one of MQTT's own built-in safety nets — a broker disconnects
        // whatever OLDER session is using the SAME clientId the moment a
        // new CONNECT claims it, which is exactly what should happen if
        // this same Edge Node identity somehow ends up double-connected
        // (e.g. two Node-RED instances misconfigured with the same
        // groupId/edgeNodeId). A random ID lets both sit there instead.
        clientId: "kufayeka-sparkplug-" + node.groupId + "-" + node.edgeNodeId,
        will: {
          topic: nodeDeathTopic,
          payload: deathPayloadBuffer(),
          qos: 1,
          retain: false
        }
      });

      client.on("connect", function () {
        node.log("Sparkplug Edge Node \"" + node.edgeNodeId + "\" connected to " + brokerUrl);
        try {
          publishBirth();
        } catch (e) {
          // An uncaught throw HERE (e.g. sparkplugCodec's encodePayload
          // rejecting a malformed metric via Payload.verify()) would
          // otherwise escape as an uncaught exception inside this "connect"
          // handler — which doesn't cleanly surface as an MQTT "error"
          // event, so without this it just silently corrupts the birth
          // sequence instead of being visible anywhere.
          node.warn("Sparkplug: failed to publish birth: " + describeError(e));
        }
        client.subscribe([nodeCmdTopic, deviceCmdTopicFilter], { qos: 1 }, function (err) {
          if (err) node.warn("Sparkplug: failed to subscribe to command topics: " + describeError(err));
        });
        if (!unsubscribeAssetChanges) {
          unsubscribeAssetChanges = asset.subscribe(onAssetChange);
        }
      });
      client.on("message", onMessage);
      client.on("reconnect", function () {
        // Every one of these is a genuinely NEW MQTT session — the `mqtt`
        // library re-sends a fresh CONNECT (and re-registers the Will)
        // right after this event, reading it straight from
        // `client.options.will` at that moment (see mqtt/build/lib/
        // client.js's connectPacket.will) rather than reusing whatever
        // buffer was current when mqtt.connect() was first called. So
        // bdSeq must advance HERE too, and the Will buffer must be
        // regenerated with it — otherwise every reconnect's Will (and the
        // NBIRTH that follows once "connect" fires again) would keep
        // reusing the very first session's bdSeq, defeating the whole
        // point of the counter.
        bdSeq = (bdSeq + 1) % 256;
        client.options.will.payload = deathPayloadBuffer();
        setStatus({ fill: "yellow", shape: "ring", text: "reconnecting" });
      });
      client.on("close", function () {
        if (!closing) {
          setStatus({ fill: "red", shape: "ring", text: "disconnected" });
          node.warn("Sparkplug: MQTT connection closed (client will auto-reconnect)");
        }
      });
      client.on("error", function (err) {
        setStatus({ fill: "red", shape: "ring", text: "error" });
        node.warn("Sparkplug MQTT error: " + describeError(err));
      });
    }

    connect();

    node.on("close", function (done) {
      closing = true;
      if (unsubscribeAssetChanges) {
        unsubscribeAssetChanges();
        unsubscribeAssetChanges = null;
      }
      if (!client) { done(); return; }

      var finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        // force=true: don't wait for any in-flight packet to ack — by this
        // point we've either gotten our NDEATH ack already or given up on
        // it, so there's nothing left worth a graceful drain.
        client.end(true, {}, function () { done(); });
      }

      // If the broker connection is already gone (a very real race: an
      // in-process/embedded broker node — or the real broker — can vanish
      // in the SAME "Stopping flows" pass this node's own close handler
      // runs in, sometimes microseconds earlier), there is no live session
      // to gracefully tell anything to, and `mqtt` is almost certainly
      // already spinning on its own auto-reconnect (ECONNREFUSED every
      // `reconnectPeriod`). Waiting on a publish() ack that can now never
      // arrive is exactly what caused the observed "Close timed out" hang
      // and endless ECONNREFUSED spam after Ctrl+C — so skip straight to
      // ending the client instead of trying to publish through a
      // connection that isn't there.
      if (!client.connected) {
        finish();
        return;
      }

      // A graceful shutdown publishes NDEATH itself (qos 1, "at least once")
      // rather than leaving it purely to the broker's Will delivery — the
      // Will only fires on an UNGRACEFUL drop, so this covers the
      // "Node-RED was deployed/stopped cleanly" case too. But don't wait
      // forever for the PUBACK: if the connection drops mid-publish (the
      // same race as above, just a beat later), fall back to ending
      // anyway after a short grace period rather than hanging until
      // Node-RED's own close-timeout kills this handler.
      var graceTimer = setTimeout(finish, 1500);
      client.publish(nodeDeathTopic, deathPayloadBuffer(), { qos: 1 }, function () {
        clearTimeout(graceTimer);
        finish();
      });
    });
  }

  RED.nodes.registerType("kufayeka-sparkplug-edge-node", SparkplugEdgeNode, {
    credentials: {
      username: { type: "text" },
      password: { type: "password" }
    }
  });
};
