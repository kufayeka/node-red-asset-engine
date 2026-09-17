// Real worker_threads.Worker + a real embedded MQTT broker (aedes) — proves
// the actual thread-spawning/postMessage PLUMBING works, not just the
// encode/decode/spec-compliance logic (already covered, without any real
// thread or network, by sparkplug-worker_spec.js). This is the one part of
// the worker-thread split that genuinely can't be verified by continuing to
// fake require("mqtt")/require("worker_threads") in-process, since that's
// exactly the seam being exercised here.
const assert = require("assert");
const net = require("net");
const path = require("path");
const { Worker } = require("worker_threads");
const { Aedes } = require("aedes");
const codec = require("../../lib/sparkplug/sparkplugCodec");

// Other spec files in this same mocha process (test/lib/sparkplug-worker_spec.js,
// test/nodes/sparkplug-in_spec.js, etc.) require test/helpers/fakeMqtt.js,
// which permanently overwrites require.cache["mqtt"] with a fake for the
// REST OF THE PROCESS (mocha requires every *_spec.js file up front, so this
// can happen before or after this file's own top-level code runs, depending
// on glob file order — verified NOT to be simple alphabetical sort). This
// test needs the REAL mqtt module for its "observer" client (the
// worker_threads.Worker it drives always gets the real one regardless,
// since a worker has its own independent module registry). Grab a real,
// fresh reference for OUR OWN use, then immediately put back whatever was
// cached before — leaving the shared cache disturbed (even briefly) was
// observed to make unrelated sparkplug-in/out specs elsewhere in the suite
// hang, presumably by letting some other file's later (re-)require see the
// real module where it expected the fake.
const mqttModulePath = require.resolve("mqtt");
const cachedMqttEntry = require.cache[mqttModulePath];
delete require.cache[mqttModulePath];
const mqtt = require("mqtt");
if (cachedMqttEntry) require.cache[mqttModulePath] = cachedMqttEntry;
else delete require.cache[mqttModulePath];

const TIMEOUT_MS = 15000;

function waitForMessage(worker, predicate, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      worker.off("message", onMsg);
      reject(new Error("timed out waiting for a matching worker message"));
    }, timeoutMs);
    function onMsg(msg) {
      if (predicate(msg)) {
        clearTimeout(timer);
        worker.off("message", onMsg);
        resolve(msg);
      }
    }
    worker.on("message", onMsg);
  });
}

describe("lib/sparkplug-worker.js (real worker_threads.Worker + real embedded MQTT broker)", function () {
  this.timeout(TIMEOUT_MS + 5000);

  var broker, server, port, worker, observer;

  before(async function () {
    broker = await Aedes.createBroker();
    server = net.createServer(broker.handle.bind(broker));
    await new Promise(function (resolve) { server.listen(0, "127.0.0.1", resolve); });
    port = server.address().port;
  });

  after(async function () {
    await new Promise(function (resolve) { server.close(resolve); });
    await new Promise(function (resolve) { broker.close(resolve); });
  });

  afterEach(async function () {
    if (observer) { observer.end(true); observer = null; }
    if (worker) { await worker.terminate().catch(function () { }); worker = null; }
  });

  it("connects to a real broker, publishes a real NBIRTH on the wire, and relays an incoming DCMD back already-decoded", async function () {
    worker = new Worker(path.join(__dirname, "..", "..", "lib", "sparkplug-worker.js"), {
      workerData: {
        brokerUrl: "mqtt://127.0.0.1:" + port, groupId: "G1", edgeNodeId: "E1", clientId: "test-edge-node",
        keepAlive: 30, protocolVersion: 4, reconnectPeriod: 1000, connectTimeout: 5000, primaryHostStateTopic: null
      }
    });

    await waitForMessage(worker, function (m) { return m.type === "status" && m.status === "connected"; }, TIMEOUT_MS);

    observer = mqtt.connect("mqtt://127.0.0.1:" + port, { clientId: "test-observer" });
    await new Promise(function (resolve) { observer.on("connect", resolve); });
    await new Promise(function (resolve) { observer.subscribe("spBv1.0/G1/NBIRTH/E1", { qos: 0 }, resolve); });

    const nbirthSeen = new Promise(function (resolve) {
      observer.once("message", function (topic, buf) { resolve(codec.decodePayload(buf)); });
    });
    worker.postMessage({ type: "birth" });
    const nbirth = await nbirthSeen;
    assert.ok(nbirth.metrics.some(function (m) { return m.name === "bdSeq"; }), "a real observer on the wire saw a proper NBIRTH with bdSeq");

    const dcmdRelayed = waitForMessage(worker, function (m) { return m.type === "dcmd" && m.deviceId === "Motor1"; }, TIMEOUT_MS);
    const dcmdBuf = codec.encodePayload({ timestamp: Date.now(), metrics: [{ name: "Speed", type: "Double", value: 55 }] });
    observer.publish("spBv1.0/G1/DCMD/E1/Motor1", dcmdBuf, { qos: 0 });
    const relayed = await dcmdRelayed;
    assert.strictEqual(relayed.metrics[0].value, 55);
  });

  it("close: publishes a real NDEATH on the wire and terminates cleanly", async function () {
    worker = new Worker(path.join(__dirname, "..", "..", "lib", "sparkplug-worker.js"), {
      workerData: {
        brokerUrl: "mqtt://127.0.0.1:" + port, groupId: "G2", edgeNodeId: "E2", clientId: "test-edge-node-2",
        keepAlive: 30, protocolVersion: 4, reconnectPeriod: 1000, connectTimeout: 5000, primaryHostStateTopic: null
      }
    });
    await waitForMessage(worker, function (m) { return m.type === "status" && m.status === "connected"; }, TIMEOUT_MS);

    observer = mqtt.connect("mqtt://127.0.0.1:" + port, { clientId: "test-observer-2" });
    await new Promise(function (resolve) { observer.on("connect", resolve); });
    await new Promise(function (resolve) { observer.subscribe("spBv1.0/G2/NDEATH/E2", { qos: 0 }, resolve); });

    const ndeathSeen = new Promise(function (resolve) { observer.once("message", function () { resolve(); }); });
    const closedAck = waitForMessage(worker, function (m) { return m.type === "closed"; }, TIMEOUT_MS);
    worker.postMessage({ type: "close" });
    await Promise.all([ndeathSeen, closedAck]);
  });
});
