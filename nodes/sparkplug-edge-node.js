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

// [tck-id-topic-structure-namespace-valid-group-id] / [-valid-edge-node-id]:
// "The format of the Group ID [or edge_node_id] MUST be a valid UTF-8
// string with the exception of the reserved characters of + (plus), /
// (forward slash), and # (number sign)." (spec §4.1.2/§4.1.4, p.18-19).
// Using any of these silently corrupts the topic (an extra "/" splits into
// a phantom segment, "+"/"#" collide with MQTT's own wildcard syntax on
// subscribe) — so this is checked eagerly at config time rather than
// discovered later as "Ignition can't see my data".
var RESERVED_SPARKPLUG_ID_CHARS = /[+/#]/;
function invalidSparkplugIdReason(value, label) {
  if (RESERVED_SPARKPLUG_ID_CHARS.test(value)) {
    return label + " \"" + value + "\" contains a reserved Sparkplug character (+, /, or #) — see spec §4.1.2/§4.1.4.";
  }
  return null;
}

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
    // Optional — spec §3.5/§5.4 (p.16, p.35-36): "Specifying a Primary Host
    // is not required for an Edge Node. But it is often desired." Blank
    // (the default) preserves the original always-birth-immediately
    // behavior exactly.
    var primaryHostId = (config.primaryHostId || "").trim();
    var primaryHostStateTopic = primaryHostId ? (NAMESPACE + "/STATE/" + primaryHostId) : null;

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
    // true whenever this Edge Node has not yet (re-)confirmed its configured
    // Primary Host is online — while true, publishBirth()/onAssetChange()
    // must not publish anything (spec §5.4, p.35-36: the Edge Node "must
    // wait until the Primary Host Application is online... before the Edge
    // Node publishes its NBIRTH and DBIRTH messages"). Stays permanently
    // false when no primaryHostId is configured.
    var waitingForPrimaryHost = !!primaryHostId;
    var primaryHostOnline = false;
    var primaryHostLastTs = null;
    // Set while this node itself is tearing down and reconnecting in
    // response to its Primary Host going offline (§16/handlePrimaryHostState)
    // — distinguishes that self-inflicted, expected "close" event from a
    // real unexpected disconnect, the same way `closing` distinguishes a
    // real Node-RED shutdown from one.
    var restartingForPrimaryHost = false;
    // Tracks which top-level assets ("Devices") have already been BIRTHed
    // in the current session, so a later schema change can tell a newly
    // added asset (needs a fresh DBIRTH) apart from a removed one (needs a
    // DDEATH) — see reconcileDevices().
    var knownDevices = {};

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
      waitingForPrimaryHost = false;
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
      knownDevices = {};
      hierarchy.forEach(function (rootNode) {
        publishDeviceBirth(rootNode);
        knownDevices[rootNode.name] = true;
      });
      setStatus({ fill: "green", shape: "dot", text: "online (" + hierarchy.length + " device" + (hierarchy.length === 1 ? "" : "s") + ")" });
    }

    // [tck-id-message-flow-device-birth-publish-nbirth-wait]: "A Device can
    // publish a DBIRTH as long as an NBIRTH has been sent previously and the
    // MQTT session is active" — a Device is explicitly allowed to birth
    // mid-session, not only right after the Edge Node's own NBIRTH. This is
    // what lets reconcileDevices() below birth a newly-added top-level asset
    // immediately, instead of waiting for the next reconnect/rebirth.
    function publishDeviceBirth(rootNode) {
      // Unlike Group ID/Edge Node ID (fixed at config time, checked once at
      // connect() below), a Device ID comes from a live asset name the user
      // can rename at any time — checked here, per publish, as a best-effort
      // warning rather than a refusal: an already-malformed name shouldn't
      // newly break a deploy that previously "worked" (just badly).
      var deviceIdError = invalidSparkplugIdReason(rootNode.name, "Device ID");
      if (deviceIdError) node.warn("Sparkplug: " + deviceIdError + " Its topic will be malformed.");
      var dbirthTopic = NAMESPACE + "/" + node.groupId + "/DBIRTH/" + node.edgeNodeId + "/" + rootNode.name;
      var payload = sparkplug.encodePayload({
        timestamp: Date.now(),
        seq: nextSeq(),
        metrics: collectDeviceMetrics(rootNode)
      });
      client.publish(dbirthTopic, payload, { qos: 0, retain: false });
    }

    // Spec §6.4.26 DDEATH (p.94): "The DDEATH messages are published by an
    // Edge Node on behalf of an attached device. If the Edge Node determines
    // that a device is no longer accessible... the Edge Node should publish
    // a DDEATH." Here, "no longer accessible" == removed from the deployed
    // asset schema (a re-applied kufayeka-asset-schema no longer lists it as
    // a top-level asset) — this Edge Node has no other notion of a Device
    // going offline independently of the whole Node.
    function publishDeviceDeath(deviceName) {
      var ddeathTopic = NAMESPACE + "/" + node.groupId + "/DDEATH/" + node.edgeNodeId + "/" + deviceName;
      // [tck-id-payloads-ddeath-seq]/[-seq-inc]: DDEATH DOES participate in
      // the shared node-wide seq counter (unlike NDEATH, which must NOT
      // include one at all) — see nextSeq().
      var payload = sparkplug.encodePayload({ timestamp: Date.now(), seq: nextSeq(), metrics: [] });
      client.publish(ddeathTopic, payload, { qos: 0, retain: false });
    }

    // Diffs the CURRENT top-level asset list against knownDevices (as of
    // the last birth or reconciliation): a newly-appeared one gets an
    // immediate DBIRTH, a since-vanished one gets a DDEATH. Triggered off
    // "schema.applied" change events (see onAssetChange) — a schema re-apply
    // is the only way the top-level asset list can change at runtime.
    function reconcileDevices() {
      if (!client || !client.connected || waitingForPrimaryHost) return;
      var hierarchy = asset.getHierarchy({ populateAttributes: true }) || [];
      var current = {};
      hierarchy.forEach(function (rootNode) { current[rootNode.name] = rootNode; });

      Object.keys(knownDevices).forEach(function (name) {
        if (!Object.prototype.hasOwnProperty.call(current, name)) {
          publishDeviceDeath(name);
          delete knownDevices[name];
        }
      });
      Object.keys(current).forEach(function (name) {
        if (!Object.prototype.hasOwnProperty.call(knownDevices, name)) {
          publishDeviceBirth(current[name]);
          knownDevices[name] = true;
        }
      });
    }

    function onAssetChange(meta) {
      if (!client || !client.connected || waitingForPrimaryHost) return;
      if (meta && meta.change && meta.change.type === "schema.applied") {
        reconcileDevices();
      }
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
        // A "JsonString"-opted-in attribute is published as a plain
        // Sparkplug String (see sparkplugMapping.js's SPARKPLUG_TYPE_ALIASES)
        // holding JSON-source text — parse it back before writing, since
        // asset.setAttribute doesn't otherwise know to (AssetStoreIndex.js's
        // write path stores whatever it's given as-is, without consulting
        // coerceAttributeValue). Left as the raw string if it doesn't
        // actually parse, rather than dropping the write.
        var coerced = value;
        if (typeof value === "string") {
          var matches = asset.getAttributes(fullPath);
          var match = matches && matches[0];
          if (match && match.sparkplugType === "JsonString") {
            try { coerced = JSON.parse(value); } catch (e) { /* not valid JSON text -- write the raw string */ }
          }
        }
        asset.setAttribute(fullPath, coerced);
      } catch (e) {
        node.warn("Sparkplug: failed to apply incoming write to \"" + fullPath + "\": " + describeError(e));
      }
    }

    // Publishes NDEATH (best-effort — waits up to 1.5s for the PUBACK, then
    // gives up rather than hanging) and then always runs `afterEnd`. Shared
    // by the node's own graceful-shutdown close handler and by
    // handlePrimaryHostState()'s spec-mandated "Primary Host went offline"
    // restart below — both need the exact same "tell the bus we're gone,
    // but don't wait forever" behavior.
    function publishDeathThenEnd(afterEnd) {
      var finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        afterEnd();
      }
      if (!client.connected) { finish(); return; }
      var graceTimer = setTimeout(finish, 1500);
      client.publish(nodeDeathTopic, deathPayloadBuffer(), { qos: 1 }, function () {
        clearTimeout(graceTimer);
        finish();
      });
    }

    // Spec §5.4 (p.36-37), the optional Primary Host mechanism: while
    // waiting to birth, a STATE online=true confirmation lets the deferred
    // birth proceed; once birthed, a STATE online=false MUST immediately
    // NDEATH and restart the whole connection process from scratch (a fresh
    // session will re-verify Primary Host state before re-birthing).
    function handlePrimaryHostState(buf) {
      var state;
      try {
        state = JSON.parse(buf.toString());
      } catch (e) {
        node.warn("Sparkplug: failed to parse Primary Host STATE payload on \"" + primaryHostStateTopic + "\": " + describeError(e));
        return;
      }
      var ts = typeof state.timestamp === "number" ? state.timestamp : null;
      var online = state.online === true;

      // [tck-id-message-flow-edge-node-birth-publish-phid-wait-timestamp]:
      // ignore a STATE message older than the last one accepted -- unless
      // none has been accepted yet, in which case this one is unconditionally
      // the latest/valid one.
      if (primaryHostLastTs !== null && ts !== null && ts < primaryHostLastTs) return;
      if (ts !== null) primaryHostLastTs = ts;

      if (online) {
        primaryHostOnline = true;
        if (waitingForPrimaryHost) {
          try {
            publishBirth();
          } catch (e) {
            node.warn("Sparkplug: failed to publish birth after Primary Host came online: " + describeError(e));
          }
        }
        return;
      }

      primaryHostOnline = false;
      if (waitingForPrimaryHost) return; // already waiting -- nothing new to do

      // [tck-id-message-flow-edge-node-birth-publish-phid-offline]: "it MUST
      // immediately publish an NDEATH message and disconnect from the MQTT
      // Server and start the connection establishment process over."
      waitingForPrimaryHost = true;
      restartingForPrimaryHost = true;
      setStatus({ fill: "yellow", shape: "ring", text: "primary host \"" + primaryHostId + "\" offline, restarting session" });
      publishDeathThenEnd(function () {
        client.end(true, {}, function () {
          restartingForPrimaryHost = false;
          connect();
        });
      });
    }

    function onMessage(topic, buf) {
      if (primaryHostStateTopic && topic === primaryHostStateTopic) {
        handlePrimaryHostState(buf);
        return;
      }
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

        var subscribeTopics = [nodeCmdTopic, deviceCmdTopicFilter];
        if (primaryHostId) {
          // Every fresh session re-verifies Primary Host state from
          // scratch, even across a reconnect — [tck-id-message-flow-edge-
          // node-birth-publish-phid-wait]: MUST verify via STATE before
          // publishing NBIRTH/DBIRTH. STATE is published retained (spec
          // §6.4.27), so in the common case this resolves in one round trip.
          waitingForPrimaryHost = true;
          primaryHostOnline = false;
          subscribeTopics = [primaryHostStateTopic].concat(subscribeTopics);
          setStatus({ fill: "yellow", shape: "ring", text: "waiting for primary host \"" + primaryHostId + "\"" });
        }

        client.subscribe(subscribeTopics, { qos: 1 }, function (err) {
          if (err) node.warn("Sparkplug: failed to subscribe to command topics: " + describeError(err));
        });
        if (!unsubscribeAssetChanges) {
          unsubscribeAssetChanges = asset.subscribe(onAssetChange);
        }

        if (!primaryHostId) {
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
        }
        // else: publishBirth() is deferred until handlePrimaryHostState()
        // confirms the configured Primary Host is online.
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
        if (!closing && !restartingForPrimaryHost) {
          setStatus({ fill: "red", shape: "ring", text: "disconnected" });
          node.warn("Sparkplug: MQTT connection closed (client will auto-reconnect)");
        }
      });
      client.on("error", function (err) {
        setStatus({ fill: "red", shape: "ring", text: "error" });
        node.warn("Sparkplug MQTT error: " + describeError(err));
      });
    }

    // [tck-id-topic-structure-namespace-valid-group-id] / [-valid-edge-node-
    // id]: fail fast on a Group/Edge Node ID that would silently produce a
    // broken topic, rather than connecting anyway and leaving "why can't
    // Ignition see my data" as a mystery.
    var configIdError = invalidSparkplugIdReason(node.groupId, "Group ID") || invalidSparkplugIdReason(node.edgeNodeId, "Edge Node ID");
    if (configIdError) {
      node.error("Sparkplug: " + configIdError + " Refusing to connect.");
      setStatus({ fill: "red", shape: "ring", text: "invalid Group ID / Edge Node ID" });
    } else {
      connect();
    }

    node.on("close", function (done) {
      closing = true;
      if (unsubscribeAssetChanges) {
        unsubscribeAssetChanges();
        unsubscribeAssetChanges = null;
      }
      if (!client) { done(); return; }
      // Covers the real reported race too: an in-process/embedded broker
      // node (or the real broker) can vanish in the SAME "Stopping flows"
      // pass this node's own close handler runs in, sometimes microseconds
      // earlier — publishDeathThenEnd() already skips the doomed publish
      // when that's already happened (see its own !client.connected check).
      publishDeathThenEnd(function () {
        // force=true: don't wait for any in-flight packet to ack — by this
        // point we've either gotten our NDEATH ack already or given up on
        // it, so there's nothing left worth a graceful drain.
        client.end(true, {}, function () { done(); });
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
