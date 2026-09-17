const path = require("path");
const { Worker } = require("worker_threads");
const { getAssetController } = require("../lib/asset-plugin");
const {
  toSparkplugMetric,
  topLevelNameFromPath,
  relativeMetricNameFromPath,
  collectDeviceMetrics
} = require("../lib/sparkplug/sparkplugMapping");

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

// Test-only seam: a real worker_threads.Worker can't be driven by faking
// require("mqtt") in the TEST process (a worker has its own, independent
// module registry) — so tests substitute this factory instead, the same
// spirit as node-red-nexa-dashboard's cm6-code-editor.js override and
// nexa-sparkplug.js's own _setWorkerFactoryForTests. Never overridden
// outside tests.
var workerFactory = function (workerData) {
  return new Worker(path.join(__dirname, "..", "lib", "sparkplug-worker.js"), { workerData: workerData });
};
function _setWorkerFactoryForTests(fn) { workerFactory = fn; }

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
    var primaryHostStateTopic = primaryHostId ? ("spBv1.0/STATE/" + primaryHostId) : null;

    // Spec-conformant MQTT session parameters — genuinely configurable
    // (library defaults otherwise); QoS/retain/Clean Session stay hardcoded
    // in the worker (spec-mandated, not a preference — see the edit
    // dialog's own note next to these).
    var keepAlive = config.keepAlive !== undefined && config.keepAlive !== "" ? Number(config.keepAlive) : 30;
    var protocolVersion = config.protocolVersion ? Number(config.protocolVersion) : 4;
    var reconnectPeriod = config.reconnectPeriod !== undefined && config.reconnectPeriod !== "" ? Number(config.reconnectPeriod) : 5000;
    var connectTimeout = config.connectTimeout !== undefined && config.connectTimeout !== "" ? Number(config.connectTimeout) : 30000;
    var clientIdOverride = (config.clientIdOverride || "").trim();
    var rejectUnauthorized = node.credentials && node.credentials.rejectUnauthorized !== undefined
      ? node.credentials.rejectUnauthorized !== "false" : true;
    var ca = node.credentials && node.credentials.ca;
    var cert = node.credentials && node.credentials.cert;
    var key = node.credentials && node.credentials.key;

    var asset = RED.asset || getAssetController(RED);
    if (!asset) {
      node.error("Asset engine not available — is @kufayeka/node-red-asset-engine's plugin loaded?");
      return;
    }

    var worker = null;
    var unsubscribeAssetChanges = null;
    // true whenever this Edge Node has not yet (re-)confirmed its configured
    // Primary Host is online — while true, publishBirth()/onAssetChange()
    // must not publish anything (spec §5.4, p.35-36: the Edge Node "must
    // wait until the Primary Host Application is online... before the Edge
    // Node publishes its NBIRTH and DBIRTH messages"). Stays permanently
    // false when no primaryHostId is configured.
    var waitingForPrimaryHost = !!primaryHostId;
    var primaryHostOnline = false;
    var primaryHostLastTs = null;
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

    // Publishes an NBIRTH (worker-owned content: bdSeq + rebirth flag) then
    // one DBIRTH per current top-level asset ("Device").
    function publishBirth() {
      waitingForPrimaryHost = false;
      worker.postMessage({ type: "birth" });

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
      worker.postMessage({ type: "deviceBirth", deviceId: rootNode.name, metrics: collectDeviceMetrics(rootNode) });
    }

    // Spec §6.4.26 DDEATH (p.94): "The DDEATH messages are published by an
    // Edge Node on behalf of an attached device. If the Edge Node determines
    // that a device is no longer accessible... the Edge Node should publish
    // a DDEATH." Here, "no longer accessible" == removed from the deployed
    // asset schema (a re-applied kufayeka-asset-schema no longer lists it as
    // a top-level asset) — this Edge Node has no other notion of a Device
    // going offline independently of the whole Node.
    function publishDeviceDeath(deviceName) {
      worker.postMessage({ type: "deviceDeath", deviceId: deviceName });
    }

    // Diffs the CURRENT top-level asset list against knownDevices (as of
    // the last birth or reconciliation): a newly-appeared one gets an
    // immediate DBIRTH, a since-vanished one gets a DDEATH. Triggered off
    // "schema.applied" change events (see onAssetChange) — a schema re-apply
    // is the only way the top-level asset list can change at runtime.
    function reconcileDevices() {
      if (!worker || waitingForPrimaryHost) return;
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
      if (!worker || waitingForPrimaryHost) return;
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
        worker.postMessage({ type: "deviceData", deviceId: deviceId, metrics: byDevice[deviceId] });
      });
    }

    // Spec §5.4 (p.36-37), the optional Primary Host mechanism: while
    // waiting to birth, a STATE online=true confirmation lets the deferred
    // birth proceed; once birthed, a STATE online=false MUST immediately
    // NDEATH and restart the whole connection process from scratch (a fresh
    // session will re-verify Primary Host state before re-birthing).
    function handlePrimaryHostState(online, ts) {
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
      setStatus({ fill: "yellow", shape: "ring", text: "primary host \"" + primaryHostId + "\" offline, restarting session" });
      worker.postMessage({ type: "restart-connection" });
    }

    function handleWorkerMessage(msg) {
      if (!msg) return;
      if (msg.type === "status") {
        if (msg.status === "connecting") {
          setStatus({ fill: "yellow", shape: "ring", text: "connecting" });
        } else if (msg.status === "connected") {
          node.log("Sparkplug Edge Node \"" + node.edgeNodeId + "\" connected to " + brokerUrl);
          if (!unsubscribeAssetChanges) unsubscribeAssetChanges = asset.subscribe(onAssetChange);
          if (primaryHostId) {
            // Every fresh session re-verifies Primary Host state from
            // scratch, even across a reconnect — MUST verify via STATE
            // before publishing NBIRTH/DBIRTH.
            waitingForPrimaryHost = true;
            primaryHostOnline = false;
            setStatus({ fill: "yellow", shape: "ring", text: "waiting for primary host \"" + primaryHostId + "\"" });
          } else {
            try {
              publishBirth();
            } catch (e) {
              node.warn("Sparkplug: failed to publish birth: " + describeError(e));
            }
          }
        } else if (msg.status === "reconnecting") {
          setStatus({ fill: "yellow", shape: "ring", text: "reconnecting" });
        } else if (msg.status === "disconnected") {
          setStatus({ fill: "red", shape: "ring", text: "disconnected" });
          node.warn("Sparkplug: MQTT connection closed (client will auto-reconnect)");
        } else if (msg.status === "error") {
          setStatus({ fill: "red", shape: "ring", text: "error" });
          node.warn("Sparkplug MQTT error: " + (msg.detail || ""));
        }
        return;
      }
      if (msg.type === "ncmd") {
        // Standard Sparkplug convention: a Host Application sends
        // "Node Control/Rebirth"=true when it needs a fresh NBIRTH+DBIRTH
        // (e.g. it just (re)connected and missed the original one).
        var rebirthRequested = msg.metrics.some(function (m) { return m.name === "Node Control/Rebirth" && m.value === true; });
        if (rebirthRequested) {
          publishBirth();
          return;
        }
        msg.metrics.forEach(function (m) {
          if (m && m.name) applyIncomingMetric(m.name.split("/").join("."), m.value);
        });
        return;
      }
      if (msg.type === "dcmd") {
        msg.metrics.forEach(function (m) {
          if (m && m.name) applyIncomingMetric(msg.deviceId + "." + m.name.split("/").join("."), m.value);
        });
        return;
      }
      if (msg.type === "primary-host-state") {
        handlePrimaryHostState(msg.online, msg.timestamp);
        return;
      }
      if (msg.type === "decode-error") {
        node.warn("Sparkplug: failed to decode incoming payload on \"" + msg.topic + "\": " + msg.error);
      }
    }

    function connect() {
      worker = workerFactory({
        brokerUrl: brokerUrl,
        username: username,
        password: password,
        groupId: node.groupId,
        edgeNodeId: node.edgeNodeId,
        primaryHostStateTopic: primaryHostStateTopic,
        // STABLE, not random-per-connect: a random suffix here would defeat
        // one of MQTT's own built-in safety nets — a broker disconnects
        // whatever OLDER session is using the SAME clientId the moment a
        // new CONNECT claims it, which is exactly what should happen if
        // this same Edge Node identity somehow ends up double-connected
        // (e.g. two Node-RED instances misconfigured with the same
        // groupId/edgeNodeId). A random ID lets both sit there instead.
        clientId: clientIdOverride || ("kufayeka-sparkplug-" + node.groupId + "-" + node.edgeNodeId),
        keepAlive: keepAlive,
        protocolVersion: protocolVersion,
        reconnectPeriod: reconnectPeriod,
        connectTimeout: connectTimeout,
        rejectUnauthorized: rejectUnauthorized,
        ca: ca, cert: cert, key: key
      });
      worker.on("message", handleWorkerMessage);
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
      if (unsubscribeAssetChanges) {
        unsubscribeAssetChanges();
        unsubscribeAssetChanges = null;
      }
      if (!worker) { done(); return; }
      var finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        worker.terminate().catch(function () { });
        done();
      }
      // Covers the real reported race too: an in-process/embedded broker
      // node (or the real broker) can vanish in the SAME "Stopping flows"
      // pass this node's own close handler runs in — the worker's own
      // publishDeathThenEnd already skips the doomed publish when that's
      // already happened.
      var graceTimer = setTimeout(finish, 1500);
      worker.once("message", function (msg) {
        if (msg && msg.type === "closed") {
          clearTimeout(graceTimer);
          finish();
        }
      });
      worker.postMessage({ type: "close" });
    });
  }

  RED.nodes.registerType("kufayeka-sparkplug-edge-node", SparkplugEdgeNode, {
    credentials: {
      username: { type: "text" },
      password: { type: "password" },
      rejectUnauthorized: { type: "text" },
      ca: { type: "text" },
      cert: { type: "text" },
      key: { type: "text" }
    }
  });
};

module.exports._setWorkerFactoryForTests = _setWorkerFactoryForTests;
