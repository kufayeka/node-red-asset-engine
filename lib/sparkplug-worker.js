// Worker-thread entry for an Asset Engine Sparkplug Edge Node connection.
// Deliberately NOT run on Node-RED's main thread: this owns the actual
// `mqtt.connect()` socket (keepalive, reconnect, Will/bdSeq lifecycle) and
// Protobuf encode/decode, so neither can ever be starved by whatever else
// the main thread is doing — the concrete risk this removes is a false
// NDEATH: if the process handling MQTT keepalive is busy, a broker can
// decide the Edge Node is dead. Standard Node.js `worker_threads` only —
// nothing here touches Node's runtime/kernel or Node-RED core.
//
// This worker owns every WIRE-LEVEL Sparkplug concern: the mqtt client
// itself, the seq (per-session message counter) and bdSeq (per-connection
// Will/birth-death correlation counter, spec §5-ish) counters, topic
// construction, Payload encode/decode, and the Primary-Host-offline-
// triggered "publish NDEATH then reconnect from scratch" sequence. It does
// NOT know about the asset store, calc scripts, or the Primary Host STATE
// state machine's DECISIONS (when to birth, when to restart) — those stay
// on the main thread (nodes/sparkplug-edge-node.js), which only tells this
// worker WHAT to publish (a device's metrics) or WHEN to restart, never HOW.
//
// Protocol with the main thread, all via parentPort.postMessage/on("message"):
//   main -> worker: {type:"birth"}                          -- NBIRTH only (bdSeq/rebirth-flag, worker-owned content)
//                   {type:"deviceBirth", deviceId, metrics}  -- DBIRTH
//                   {type:"deviceDeath", deviceId}           -- DDEATH
//                   {type:"deviceData", deviceId, metrics}   -- DDATA
//                   {type:"restart-connection"}              -- NDEATH, end, fresh connect (Primary Host went offline)
//                   {type:"close"}                           -- NDEATH (best-effort), end
//   worker -> main: {type:"status", status:"connecting"|"connected"|"reconnecting"|"disconnected"|"error", detail}
//                   {type:"ncmd", metrics}
//                   {type:"dcmd", deviceId, metrics}
//                   {type:"primary-host-state", online, timestamp}
//                   {type:"decode-error", topic, error}
//                   {type:"closed"}
const { parentPort, workerData } = require("worker_threads");
const mqtt = require("mqtt");
const sparkplug = require("./sparkplug/sparkplugCodec");

const NAMESPACE = "spBv1.0";

function describeError(err) {
    if (!err) return "(no error object)";
    var parts = [];
    if (err.message) parts.push(err.message);
    if (err.code) parts.push("code=" + err.code);
    if (err.errno !== undefined) parts.push("errno=" + err.errno);
    if (err.reason) parts.push("reason=" + err.reason);
    if (parts.length) return parts.join(" ");
    try { return JSON.stringify(err); } catch (e) { return String(err); }
}

var groupId = workerData.groupId;
var edgeNodeId = workerData.edgeNodeId;
var primaryHostStateTopic = workerData.primaryHostStateTopic || null;

var nodeDeathTopic = NAMESPACE + "/" + groupId + "/NDEATH/" + edgeNodeId;
var nodeBirthTopic = NAMESPACE + "/" + groupId + "/NBIRTH/" + edgeNodeId;
var nodeCmdTopic = NAMESPACE + "/" + groupId + "/NCMD/" + edgeNodeId;
var deviceCmdTopicFilter = NAMESPACE + "/" + groupId + "/DCMD/" + edgeNodeId + "/+";

// Sparkplug's own per-message ordering counter (0-255, wraps), reset to 0 by
// every NBIRTH and incremented by 1 on every message after it.
var seq = 0;
function nextSeq() {
    var s = seq;
    seq = (seq + 1) % 256;
    return s;
}
// Birth/death correlation counter — bumped each time a NEW MQTT session is
// established (both on the very first connect and on every underlying
// reconnect), wraps at 255 (single-byte counter, not ever-growing).
var bdSeq = 0;

var client = null;
var closing = false;
var restarting = false;

function status(status, detail) {
    parentPort.postMessage({ type: "status", status: status, detail: detail });
}

function deathPayloadBuffer() {
    return sparkplug.encodePayload({ timestamp: Date.now(), metrics: [{ name: "bdSeq", type: "Int64", value: bdSeq }] });
}

// Publishes NDEATH (best-effort — waits up to 1.5s for the PUBACK, then
// gives up rather than hanging) and then always runs `afterEnd`. Shared by
// the worker's own graceful-shutdown ("close" message) and by the Primary-
// Host-offline restart ("restart-connection" message) — both need the exact
// same "tell the bus we're gone, but don't wait forever" behavior.
function publishDeathThenEnd(afterEnd) {
    var finished = false;
    function finish() {
        if (finished) return;
        finished = true;
        afterEnd();
    }
    if (!client || !client.connected) { finish(); return; }
    var graceTimer = setTimeout(finish, 1500);
    client.publish(nodeDeathTopic, deathPayloadBuffer(), { qos: 1 }, function () {
        clearTimeout(graceTimer);
        finish();
    });
}

function connect() {
    status("connecting");
    // Wraps at 255 — bdSeq is a single-byte counter, not ever-growing.
    bdSeq = (bdSeq + 1) % 256;
    var connectOpts = {
        username: workerData.username,
        password: workerData.password,
        clientId: workerData.clientId,
        keepalive: workerData.keepAlive,
        protocolVersion: workerData.protocolVersion,
        reconnectPeriod: workerData.reconnectPeriod,
        connectTimeout: workerData.connectTimeout,
        will: { topic: nodeDeathTopic, payload: deathPayloadBuffer(), qos: 1, retain: false }
    };
    if (workerData.rejectUnauthorized !== undefined) connectOpts.rejectUnauthorized = workerData.rejectUnauthorized;
    if (workerData.ca) connectOpts.ca = workerData.ca;
    if (workerData.cert) connectOpts.cert = workerData.cert;
    if (workerData.key) connectOpts.key = workerData.key;

    client = mqtt.connect(workerData.brokerUrl, connectOpts);

    client.on("connect", function () {
        var subscribeTopics = [nodeCmdTopic, deviceCmdTopicFilter];
        if (primaryHostStateTopic) subscribeTopics = [primaryHostStateTopic].concat(subscribeTopics);
        client.subscribe(subscribeTopics, { qos: 1 }, function (err) {
            if (err) status("error", "failed to subscribe to command topics: " + describeError(err));
        });
        status("connected");
    });
    client.on("message", function (topic, buf) {
        if (primaryHostStateTopic && topic === primaryHostStateTopic) {
            var state;
            try {
                state = JSON.parse(buf.toString());
            } catch (e) {
                parentPort.postMessage({ type: "decode-error", topic: topic, error: "failed to parse Primary Host STATE: " + describeError(e) });
                return;
            }
            parentPort.postMessage({ type: "primary-host-state", online: state.online === true, timestamp: typeof state.timestamp === "number" ? state.timestamp : null });
            return;
        }
        var parts = topic.split("/");
        if (parts[0] !== NAMESPACE || parts[1] !== groupId) return;
        var msgType = parts[2];
        var deviceId = parts[4];
        var payload;
        try {
            payload = sparkplug.decodePayload(buf);
        } catch (e) {
            parentPort.postMessage({ type: "decode-error", topic: topic, error: describeError(e) });
            return;
        }
        var metrics = payload.metrics || [];
        if (msgType === "NCMD") {
            parentPort.postMessage({ type: "ncmd", metrics: metrics });
        } else if (msgType === "DCMD" && deviceId) {
            parentPort.postMessage({ type: "dcmd", deviceId: deviceId, metrics: metrics });
        }
    });
    client.on("reconnect", function () {
        // Every one of these is a genuinely NEW MQTT session — the `mqtt`
        // library re-sends a fresh CONNECT (and re-registers the Will) right
        // after this event, reading it straight from client.options.will at
        // that moment (see mqtt/build/lib/client.js's connectPacket.will)
        // rather than reusing whatever buffer was current when mqtt.connect()
        // was first called — so bdSeq must advance HERE too, with the Will
        // buffer regenerated to match, or every reconnect's Will (and the
        // NBIRTH that follows) would keep reusing the very first session's
        // bdSeq, defeating the whole point of the counter.
        bdSeq = (bdSeq + 1) % 256;
        client.options.will.payload = deathPayloadBuffer();
        status("reconnecting");
    });
    client.on("close", function () {
        if (!closing && !restarting) {
            status("disconnected");
        }
    });
    client.on("error", function (err) {
        status("error", describeError(err));
    });
}

parentPort.on("message", function (msg) {
    if (!msg || !client) return;
    if (msg.type === "birth") {
        seq = 0; // NBIRTH always resets the sequence counter, per spec
        var nbirth = sparkplug.encodePayload({
            timestamp: Date.now(),
            seq: nextSeq(),
            metrics: [
                { name: "bdSeq", type: "Int64", value: bdSeq },
                // MANDATORY per spec: every NBIRTH must advertise this exact
                // metric (Boolean, false) so a Host Application knows it can
                // request a rebirth by publishing it back as an NCMD=true.
                { name: "Node Control/Rebirth", type: "Boolean", value: false }
            ]
        });
        client.publish(nodeBirthTopic, nbirth, { qos: 0, retain: false });
        return;
    }
    if (msg.type === "deviceBirth") {
        var dbirthTopic = NAMESPACE + "/" + groupId + "/DBIRTH/" + edgeNodeId + "/" + msg.deviceId;
        var dbirth = sparkplug.encodePayload({ timestamp: Date.now(), seq: nextSeq(), metrics: msg.metrics });
        client.publish(dbirthTopic, dbirth, { qos: 0, retain: false });
        return;
    }
    if (msg.type === "deviceDeath") {
        var ddeathTopic = NAMESPACE + "/" + groupId + "/DDEATH/" + edgeNodeId + "/" + msg.deviceId;
        var ddeath = sparkplug.encodePayload({ timestamp: Date.now(), seq: nextSeq(), metrics: [] });
        client.publish(ddeathTopic, ddeath, { qos: 0, retain: false });
        return;
    }
    if (msg.type === "deviceData") {
        var ddataTopic = NAMESPACE + "/" + groupId + "/DDATA/" + edgeNodeId + "/" + msg.deviceId;
        try {
            var ddata = sparkplug.encodePayload({ timestamp: Date.now(), seq: nextSeq(), metrics: msg.metrics });
            client.publish(ddataTopic, ddata, { qos: 0, retain: false });
        } catch (e) {
            status("error", "failed to encode DDATA for device \"" + msg.deviceId + "\": " + describeError(e));
        }
        return;
    }
    if (msg.type === "restart-connection") {
        // Spec §5.4: on Primary Host going offline after this Edge Node has
        // already birthed, it MUST immediately publish NDEATH and restart
        // the connection establishment process from scratch.
        restarting = true;
        publishDeathThenEnd(function () {
            client.end(true, {}, function () {
                restarting = false;
                connect();
            });
        });
        return;
    }
    if (msg.type === "close") {
        closing = true;
        publishDeathThenEnd(function () {
            client.end(true, {}, function () { parentPort.postMessage({ type: "closed" }); });
        });
    }
});

connect();
