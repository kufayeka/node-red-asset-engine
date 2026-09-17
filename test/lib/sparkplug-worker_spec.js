const should = require("should");
const { EventEmitter } = require("events");

// See test/helpers/fakeMqtt.js for why this MUST be a single shared helper
// (installed before anything else requires "mqtt" for real).
const fakeMqtt = require("../helpers/fakeMqtt");
const codec = require("../../lib/sparkplug/sparkplugCodec");

// lib/sparkplug-worker.js is a plain, require()-able Node.js module even
// though its production home is a worker_threads.Worker — this is where all
// the wire-level Sparkplug mechanics this split moved off the main thread
// (bdSeq/seq counters, topic construction, encode/decode, the Will
// lifecycle, the Primary-Host-offline restart sequence) actually live now,
// so it's tested the same way nodes/sparkplug-edge-node.js used to be
// tested before the split: the shared fakeMqtt helper for require("mqtt"),
// plus a fake require("worker_threads") providing a controllable
// parentPort/workerData, since this file talks to the outside world
// exclusively through those.
class FakeParentPort extends EventEmitter {
  // Emits "message" too (not just recording into .posted) — a test that
  // waits via .on("message", ...) for something the worker posts (rather
  // than just inspecting .posted synchronously afterward) needs this.
  postMessage(msg) { this.posted.push(msg); this.emit("message", msg); }
}
FakeParentPort.prototype.posted = null;

function decodedPublishesOf(client) {
  return client.published.map(function (p) { return { topic: p.topic, opts: p.opts, payload: codec.decodePayload(p.payload) }; });
}

function loadWorker(workerData) {
  delete require.cache[require.resolve("../../lib/sparkplug-worker.js")];
  var parentPort = new FakeParentPort();
  parentPort.posted = [];
  var workerThreadsPath = require.resolve("worker_threads");
  var real = require.cache[workerThreadsPath];
  require.cache[workerThreadsPath] = {
    id: workerThreadsPath, filename: workerThreadsPath, loaded: true,
    exports: Object.assign({}, real ? real.exports : {}, { parentPort: parentPort, workerData: workerData })
  };
  require("../../lib/sparkplug-worker.js");
  // Restore the ORIGINAL cache entry (not just delete it) — worker_threads is
  // a built-in module, and other code in this same process (including a real
  // worker_threads.Worker constructed elsewhere, e.g.
  // sparkplug-worker-integration_spec.js) may hold references that assume
  // the module identity stays stable. Deleting it instead of restoring it
  // was observed to intermittently break unrelated tests elsewhere in the
  // full suite.
  if (real) require.cache[workerThreadsPath] = real;
  else delete require.cache[workerThreadsPath];
  return parentPort;
}

function baseWorkerData(overrides) {
  return Object.assign({
    brokerUrl: "mqtt://fake-broker", groupId: "TestGroup", edgeNodeId: "Edge1",
    clientId: "test-client", keepAlive: 30, protocolVersion: 4, reconnectPeriod: 5000, connectTimeout: 30000,
    primaryHostStateTopic: null
  }, overrides || {});
}

describe("lib/sparkplug-worker.js (the Sparkplug MQTT worker thread)", function () {
  afterEach(function () {
    fakeMqtt.resetLastFakeClient();
  });

  it("connects with the exact broker/credentials/keepAlive/protocolVersion/reconnectPeriod/connectTimeout/clientId given via workerData", function () {
    loadWorker(baseWorkerData({ username: "u", password: "p" }));
    var client = fakeMqtt.getLastFakeClient();
    client.url.should.equal("mqtt://fake-broker");
    client.options.username.should.equal("u");
    client.options.password.should.equal("p");
    client.options.clientId.should.equal("test-client");
    client.options.keepalive.should.equal(30);
    client.options.protocolVersion.should.equal(4);
    client.options.reconnectPeriod.should.equal(5000);
    client.options.connectTimeout.should.equal(30000);
  });

  it("registers a Will (NDEATH, QoS 1, not retained) carrying the current bdSeq at connect time", function () {
    loadWorker(baseWorkerData());
    var client = fakeMqtt.getLastFakeClient();
    client.options.will.topic.should.equal("spBv1.0/TestGroup/NDEATH/Edge1");
    client.options.will.qos.should.equal(1);
    client.options.will.retain.should.equal(false);
    var willMetric = codec.decodePayload(client.options.will.payload).metrics.find(function (m) { return m.name === "bdSeq"; });
    should.exist(willMetric);
  });

  it("subscribes to NCMD + DCMD (and the Primary Host STATE topic, when configured) at QoS 1 on connect", function () {
    loadWorker(baseWorkerData({ primaryHostStateTopic: "spBv1.0/STATE/Ignition" }));
    var client = fakeMqtt.getLastFakeClient();
    client.simulateConnect();
    client.subscriptions[0].should.deepEqual(["spBv1.0/STATE/Ignition", "spBv1.0/TestGroup/NCMD/Edge1", "spBv1.0/TestGroup/DCMD/Edge1/+"]);
  });

  it("on connect, reports status \"connected\" to the main thread", function () {
    var parentPort = loadWorker(baseWorkerData());
    fakeMqtt.getLastFakeClient().simulateConnect();
    parentPort.posted.some(function (m) { return m.type === "status" && m.status === "connected"; }).should.equal(true);
  });

  it("{type:\"birth\"} publishes an NBIRTH containing bdSeq + the mandatory \"Node Control/Rebirth\"=false metric, QoS 0, not retained, and resets seq", function () {
    var parentPort = loadWorker(baseWorkerData());
    var client = fakeMqtt.getLastFakeClient();
    client.simulateConnect();
    parentPort.emit("message", { type: "birth" });

    var nbirth = decodedPublishesOf(client).find(function (p) { return p.topic === "spBv1.0/TestGroup/NBIRTH/Edge1"; });
    should.exist(nbirth);
    nbirth.opts.qos.should.equal(0);
    nbirth.opts.retain.should.equal(false);
    nbirth.payload.seq.should.equal(0); // NBIRTH always resets seq
    should.exist(nbirth.payload.metrics.find(function (m) { return m.name === "bdSeq"; }));
    var rebirthMetric = nbirth.payload.metrics.find(function (m) { return m.name === "Node Control/Rebirth"; });
    should.exist(rebirthMetric, "NBIRTH is missing the mandatory \"Node Control/Rebirth\" metric");
    rebirthMetric.type.should.equal("Boolean");
    rebirthMetric.value.should.equal(false);
  });

  it("{type:\"deviceBirth\"} publishes a DBIRTH with the given metrics at QoS 0, not retained, seq continuing from NBIRTH", function () {
    var parentPort = loadWorker(baseWorkerData());
    var client = fakeMqtt.getLastFakeClient();
    client.simulateConnect();
    parentPort.emit("message", { type: "birth" }); // seq 0
    parentPort.emit("message", { type: "deviceBirth", deviceId: "Plant1", metrics: [{ name: "Status", type: "String", value: "OK" }] });

    var dbirth = decodedPublishesOf(client).find(function (p) { return p.topic === "spBv1.0/TestGroup/DBIRTH/Edge1/Plant1"; });
    should.exist(dbirth);
    dbirth.opts.qos.should.equal(0);
    dbirth.opts.retain.should.equal(false);
    dbirth.payload.seq.should.equal(1); // continues after NBIRTH's seq 0
    dbirth.payload.metrics[0].name.should.equal("Status");
    dbirth.payload.metrics[0].value.should.equal("OK");
  });

  it("{type:\"deviceData\"} publishes a DDATA with the given metrics", function () {
    var parentPort = loadWorker(baseWorkerData());
    var client = fakeMqtt.getLastFakeClient();
    client.simulateConnect();
    parentPort.emit("message", { type: "deviceData", deviceId: "Plant1", metrics: [{ name: "Motor1/Speed", type: "Double", value: 77 }] });

    var ddata = decodedPublishesOf(client).find(function (p) { return p.topic === "spBv1.0/TestGroup/DDATA/Edge1/Plant1"; });
    should.exist(ddata);
    ddata.payload.metrics[0].value.should.equal(77);
  });

  it("{type:\"deviceDeath\"} publishes a DDEATH with a required seq number and no metrics", function () {
    var parentPort = loadWorker(baseWorkerData());
    var client = fakeMqtt.getLastFakeClient();
    client.simulateConnect();
    parentPort.emit("message", { type: "deviceDeath", deviceId: "Plant2" });

    var ddeath = decodedPublishesOf(client).find(function (p) { return p.topic === "spBv1.0/TestGroup/DDEATH/Edge1/Plant2"; });
    should.exist(ddeath, "DDEATH for the removed device was not published");
    should.exist(ddeath.payload.seq, "DDEATH must include a sequence number");
    ddeath.payload.metrics.should.deepEqual([]);
  });

  it("advances bdSeq (and refreshes the registered Will) on every underlying mqtt reconnect, not just node startup", function () {
    var parentPort = loadWorker(baseWorkerData());
    var client = fakeMqtt.getLastFakeClient();
    client.simulateConnect();
    var firstBdSeq = codec.decodePayload(client.options.will.payload).metrics[0].value;

    // A library-level auto-reconnect (network blip, broker restart) is a
    // genuinely NEW MQTT session — bdSeq must be different this time, or
    // this session's Will (and NBIRTH) would be indistinguishable from the
    // previous one's to a Host Application.
    client.simulateReconnect();
    var secondBdSeq = codec.decodePayload(client.options.will.payload).metrics[0].value;
    secondBdSeq.should.not.equal(firstBdSeq);

    parentPort.emit("message", { type: "birth" });
    var nbirth = decodedPublishesOf(client).find(function (p) { return p.topic === "spBv1.0/TestGroup/NBIRTH/Edge1"; });
    var nbirthBdSeq = nbirth.payload.metrics.find(function (m) { return m.name === "bdSeq"; }).value;
    nbirthBdSeq.should.equal(secondBdSeq);
  });

  it("an incoming NCMD is decoded and forwarded to the main thread as {type:\"ncmd\", metrics}", function () {
    var parentPort = loadWorker(baseWorkerData());
    var client = fakeMqtt.getLastFakeClient();
    client.simulateConnect();
    var payload = codec.encodePayload({ timestamp: 1, metrics: [{ name: "Plant1/Status", type: "String", value: "MAINTENANCE" }] });
    client.simulateMessage("spBv1.0/TestGroup/NCMD/Edge1", payload);

    var ncmdMsgs = parentPort.posted.filter(function (m) { return m.type === "ncmd"; });
    ncmdMsgs.length.should.equal(1);
    ncmdMsgs[0].metrics[0].name.should.equal("Plant1/Status");
  });

  it("an incoming DCMD is decoded and forwarded to the main thread as {type:\"dcmd\", deviceId, metrics}", function () {
    var parentPort = loadWorker(baseWorkerData());
    var client = fakeMqtt.getLastFakeClient();
    client.simulateConnect();
    var payload = codec.encodePayload({ timestamp: 1, metrics: [{ name: "Motor1/Speed", type: "Double", value: 123 }] });
    client.simulateMessage("spBv1.0/TestGroup/DCMD/Edge1/Plant1", payload);

    var dcmdMsgs = parentPort.posted.filter(function (m) { return m.type === "dcmd"; });
    dcmdMsgs.length.should.equal(1);
    dcmdMsgs[0].deviceId.should.equal("Plant1");
    dcmdMsgs[0].metrics[0].value.should.equal(123);
  });

  it("a message on the configured Primary Host STATE topic is parsed and forwarded as {type:\"primary-host-state\", online, timestamp}", function () {
    var parentPort = loadWorker(baseWorkerData({ primaryHostStateTopic: "spBv1.0/STATE/Ignition" }));
    var client = fakeMqtt.getLastFakeClient();
    client.simulateConnect();
    client.simulateMessage("spBv1.0/STATE/Ignition", Buffer.from(JSON.stringify({ online: true, timestamp: 42 })));

    var stateMsgs = parentPort.posted.filter(function (m) { return m.type === "primary-host-state"; });
    stateMsgs.length.should.equal(1);
    stateMsgs[0].online.should.equal(true);
    stateMsgs[0].timestamp.should.equal(42);
  });

  it("a message that fails to decode posts a decode-error instead of throwing", function () {
    var parentPort = loadWorker(baseWorkerData());
    var client = fakeMqtt.getLastFakeClient();
    client.simulateConnect();
    client.simulateMessage("spBv1.0/TestGroup/NCMD/Edge1", Buffer.from([0xff, 0xff, 0xff]));

    parentPort.posted.some(function (m) { return m.type === "decode-error"; }).should.equal(true);
  });

  it("{type:\"restart-connection\"} publishes NDEATH, ends the client, then connects a fresh session (Primary Host went offline)", function () {
    var parentPort = loadWorker(baseWorkerData());
    var firstClient = fakeMqtt.getLastFakeClient();
    firstClient.simulateConnect();
    firstClient.published = [];

    parentPort.emit("message", { type: "restart-connection" });

    var death = decodedPublishesOf(firstClient).find(function (p) { return p.topic === "spBv1.0/TestGroup/NDEATH/Edge1"; });
    should.exist(death, "NDEATH was not published before restarting");
    firstClient.ended.should.equal(true);

    var secondClient = fakeMqtt.getLastFakeClient();
    secondClient.should.not.equal(firstClient);
  });

  it("does not attempt an NDEATH publish when the client is already disconnected (the reported Ctrl+C race)", function () {
    var parentPort = loadWorker(baseWorkerData());
    var client = fakeMqtt.getLastFakeClient();
    client.simulateConnect();
    client.connected = false;
    client.published = [];

    parentPort.emit("message", { type: "close" });

    client.published.should.be.empty();
    client.ended.should.equal(true);
  });

  it("{type:\"close\"} publishes NDEATH, ends the client, and posts \"closed\" back to the main thread", function () {
    var parentPort = loadWorker(baseWorkerData());
    var client = fakeMqtt.getLastFakeClient();
    client.simulateConnect();

    parentPort.emit("message", { type: "close" });

    var death = decodedPublishesOf(client).find(function (p) { return p.topic === "spBv1.0/TestGroup/NDEATH/Edge1"; });
    should.exist(death, "NDEATH was not published on clean shutdown");
    client.ended.should.equal(true);
    parentPort.posted.some(function (m) { return m.type === "closed"; }).should.equal(true);
  });
});
