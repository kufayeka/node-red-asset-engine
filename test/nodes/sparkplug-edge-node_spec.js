const should = require("should");

const helper = require("node-red-node-test-helper");
const edgeNodeModule = require("../../nodes/sparkplug-edge-node.js");
const pluginFactory = require("../../lib/asset-plugin.js");

// The actual mqtt.connect()/Protobuf codec/bdSeq/seq/topic-construction now
// live in a worker_threads.Worker (lib/sparkplug-worker.js — see its own
// header comment for the full protocol and why). A real worker runs in its
// own isolated module registry, so faking require("mqtt") in THIS test
// process (test/helpers/fakeMqtt.js, still used by
// test/lib/sparkplug-worker_spec.js for exactly that file) can't reach it.
// This spec instead substitutes the worker itself, via the SHARED
// test/helpers/fakeWorker.js (also used by sparkplug-status_spec.js — same
// "single shared helper" reasoning as fakeMqtt.js), and tests only the MAIN
// THREAD's decisions: what metrics to birth from the asset store, when to
// defer for a Primary Host, how to apply an incoming write. Wire-level
// concerns (bdSeq wrapping, QoS, topic strings, seq numbers) are covered by
// test/lib/sparkplug-worker_spec.js instead.
const fakeWorker = require("../helpers/fakeWorker");

function lastFakeWorker() { return fakeWorker.getLastFakeWorker(); }
function postedOf(type) {
  return lastFakeWorker().posted.filter(function (m) { return m.type === type; });
}
function deviceBirthFor(deviceId) {
  return postedOf("deviceBirth").find(function (m) { return m.deviceId === deviceId; });
}

describe("kufayeka-sparkplug-edge-node", function () {
  before(function (done) {
    helper.init(require.resolve("node-red"));
    helper.startServer(done);
  });
  after(function (done) {
    helper.stopServer(done);
  });
  afterEach(function () {
    fakeWorker.resetLastFakeWorker();
    return helper.unload();
  });

  function loadEdgeNode(configOverrides, done) {
    var config = Object.assign({
      id: "n1", type: "kufayeka-sparkplug-edge-node",
      groupId: "TestGroup", edgeNodeId: "Edge1", brokerUrl: "mqtt://fake-broker"
    }, configOverrides || {});
    helper.load(edgeNodeModule, [config], done);
  }

  // Plant1 (root asset -> Sparkplug Device "Plant1") with a direct attribute
  // "Status", plus a nested child asset Motor1 (-> flattened into Plant1's
  // OWN metrics as "Motor1/Speed", NOT a second Device — this project chose
  // "Device per TOP-LEVEL asset" specifically, see collectDeviceMetrics).
  function setupAssets(RED) {
    pluginFactory(RED);
    RED.asset.replaceState({
      // Attributes must be declared via an attributeTemplate — an asset's
      // own `attributes: {...}` are OVERRIDES of a template-declared
      // attribute's value, not a way to define a brand new ad-hoc one (see
      // AssetSchemaService's effective-attribute resolution). Skipping this
      // was a real bug in this test's first draft: setAttribute() on an
      // attribute with no backing template silently matches nothing, so
      // no DDATA ever fired and every assertion depending on it threw.
      attributeTemplates: [
        { id: "tmpl-plant", name: "PlantTemplate", attributes: [{ name: "Status", valueType: "string", default: "OK" }] },
        // nullable:true is required here: AssetSchemaService's own coercion
        // (see coerceAttributeValue in assetDataUtils.js) silently replaces a
        // null write with the template's default value UNLESS the attribute
        // template opts into nullable — otherwise our own is_null test below
        // would never actually observe a null value at all.
        { id: "tmpl-motor", name: "MotorTemplate", attributes: [{ name: "Speed", valueType: "number", default: 0, nullable: true }] }
      ],
      assets: [
        { id: "p1", name: "Plant1", parentId: null, templateIds: ["tmpl-plant"], attributes: { Status: { value: "OK" } } },
        { id: "m1", name: "Motor1", parentId: "p1", templateIds: ["tmpl-motor"], attributes: { Speed: { value: 10 } } }
      ],
      historians: []
    });
    return RED.asset;
  }

  it("passes the worker its groupId/edgeNodeId/broker/clientId and the new spec-conformant connection parameters", function (done) {
    loadEdgeNode({ keepAlive: 45, protocolVersion: 5, reconnectPeriod: 2000, connectTimeout: 10000, clientIdOverride: "my-id" }, function () {
      var wd = lastFakeWorker().workerData;
      wd.groupId.should.equal("TestGroup");
      wd.edgeNodeId.should.equal("Edge1");
      wd.brokerUrl.should.equal("mqtt://fake-broker");
      wd.clientId.should.equal("my-id");
      wd.keepAlive.should.equal(45);
      wd.protocolVersion.should.equal(5);
      wd.reconnectPeriod.should.equal(2000);
      wd.connectTimeout.should.equal(10000);
      done();
    });
  });

  it("publishes NBIRTH then one DBIRTH for the top-level asset, with correctly-named/typed metrics", function (done) {
    loadEdgeNode({}, function () {
      setupAssets(helper._RED);
      lastFakeWorker().simulateStatus("connected");

      postedOf("birth").length.should.equal(1);
      var dbirth = deviceBirthFor("Plant1");
      should.exist(dbirth, "DBIRTH for Plant1 was not posted to the worker");

      var status = dbirth.metrics.find(function (m) { return m.name === "Status"; });
      var speed = dbirth.metrics.find(function (m) { return m.name === "Motor1/Speed"; });
      should.exist(status, "root-level attribute Status missing from DBIRTH metrics");
      status.value.should.equal("OK");
      should.exist(speed, "nested attribute Motor1/Speed missing from DBIRTH metrics");
      speed.value.should.equal(10);
      speed.type.should.equal("Double");
      done();
    });
  });

  it("end-to-end: an attribute template's opt-in sparkplugType flows all the way from schema to a properly-typed DBIRTH metric", function (done) {
    loadEdgeNode({}, function () {
      var RED = helper._RED;
      pluginFactory(RED);
      RED.asset.replaceState({
        attributeTemplates: [{
          id: "tmpl", name: "T",
          attributes: [
            // Full round trip through the REAL schema/hierarchy/mapping
            // pipeline (not just the pure functions in isolation) — a
            // signed Int16 written as -1000 must survive as -1000, typed
            // as "Int16" in the metrics array handed to the worker.
            { name: "Delta", valueType: "number", default: 0, sparkplugType: "Int16" },
            { name: "Samples", valueType: "array", default: [], sparkplugType: "Int32Array" }
          ]
        }],
        assets: [{ id: "p1", name: "Plant1", parentId: null, templateIds: ["tmpl"], attributes: { Delta: { value: -1000 }, Samples: { value: [1, -2, 3] } } }],
        historians: []
      });
      lastFakeWorker().simulateStatus("connected");

      var dbirth = deviceBirthFor("Plant1");
      should.exist(dbirth);
      var delta = dbirth.metrics.find(function (m) { return m.name === "Delta"; });
      var samples = dbirth.metrics.find(function (m) { return m.name === "Samples"; });
      should.exist(delta);
      delta.type.should.equal("Int16");
      delta.value.should.equal(-1000);
      should.exist(samples);
      samples.type.should.equal("Int32Array");
      samples.value.should.deepEqual([1, -2, 3]);
      done();
    });
  });

  it("publishes a deviceData message with the SAME metric name DBIRTH used, when the underlying asset attribute changes", function (done) {
    loadEdgeNode({}, function () {
      var asset = setupAssets(helper._RED);
      lastFakeWorker().simulateStatus("connected");
      lastFakeWorker().posted = []; // only care about what happens AFTER birth from here on

      asset.setAttribute("Plant1.Motor1.Speed", 77);

      var ddata = postedOf("deviceData").find(function (m) { return m.deviceId === "Plant1"; });
      should.exist(ddata, "deviceData for Plant1 was not posted after an attribute change");
      var speed = ddata.metrics.find(function (m) { return m.name === "Motor1/Speed"; });
      should.exist(speed);
      speed.value.should.equal(77);
      done();
    });
  });

  it("publishes isNull:true (not a fake 0/\"\"/false) for an attribute whose value is genuinely null", function (done) {
    loadEdgeNode({}, function () {
      var asset = setupAssets(helper._RED);
      lastFakeWorker().simulateStatus("connected");
      lastFakeWorker().posted = [];

      asset.setAttribute("Plant1.Motor1.Speed", null);

      var ddata = postedOf("deviceData").find(function (m) { return m.deviceId === "Plant1"; });
      should.exist(ddata, "deviceData for Plant1 was not posted after setting the attribute to null");
      var speed = ddata.metrics.find(function (m) { return m.name === "Motor1/Speed"; });
      should.exist(speed);
      speed.isNull.should.equal(true);
      should.not.exist(speed.value);
      done();
    });
  });

  it("applies an incoming DCMD write the same way the internal asset-write node would", function (done) {
    loadEdgeNode({}, function () {
      var asset = setupAssets(helper._RED);
      lastFakeWorker().simulateStatus("connected");

      lastFakeWorker().simulateDcmd("Plant1", [{ name: "Motor1/Speed", value: 123 }]);

      asset.getValue("Plant1.Motor1.Speed").should.equal(123);
      done();
    });
  });

  it("end-to-end: engUnit/engHigh/engLow/Deadband properties and a metadata description flow from the attribute template into DBIRTH", function (done) {
    loadEdgeNode({}, function () {
      var RED = helper._RED;
      pluginFactory(RED);
      RED.asset.replaceState({
        attributeTemplates: [{
          id: "tmpl", name: "T",
          attributes: [{
            name: "air_pressure", valueType: "number", default: 0,
            description: "Air pressure sensor", unit: "kPa", numberMin: 0, numberMax: 100, deadband: 0.5
          }]
        }],
        assets: [{ id: "p1", name: "Plant1", parentId: null, templateIds: ["tmpl"], attributes: { air_pressure: { value: 7.6 } } }],
        historians: []
      });
      lastFakeWorker().simulateStatus("connected");

      var dbirth = deviceBirthFor("Plant1");
      var metric = dbirth.metrics.find(function (m) { return m.name === "air_pressure"; });
      should.exist(metric);
      metric.value.should.equal(7.6);
      metric.properties.should.deepEqual({ engUnit: "kPa", engHigh: 100, engLow: 0, Deadband: 0.5 });
      metric.metadata.should.deepEqual({ description: "Air pressure sensor" });
      done();
    });
  });

  it("end-to-end: a \"JsonString\"-opted-in attribute round-trips a real JS object through DBIRTH and an incoming DCMD write-back", function (done) {
    loadEdgeNode({}, function () {
      var RED = helper._RED;
      pluginFactory(RED);
      RED.asset.replaceState({
        attributeTemplates: [{
          id: "tmpl", name: "T",
          attributes: [{ name: "Config", valueType: "object", default: {}, sparkplugType: "JsonString" }]
        }],
        assets: [{ id: "p1", name: "Plant1", parentId: null, templateIds: ["tmpl"], attributes: { Config: { value: { retries: 3 } } } }],
        historians: []
      });
      var asset = RED.asset;
      lastFakeWorker().simulateStatus("connected");

      // 1. DBIRTH's metrics carry it as a real Sparkplug String, JSON-stringified.
      var dbirth = deviceBirthFor("Plant1");
      var metric = dbirth.metrics.find(function (m) { return m.name === "Config"; });
      should.exist(metric);
      metric.type.should.equal("String");
      metric.value.should.equal(JSON.stringify({ retries: 3 }));

      // 2. A Host Application writing back JSON-source text via DCMD must
      // land as a real JS object again — asset.setAttribute otherwise has
      // no reason to parse a plain string for an "object" attribute (see
      // sparkplug-edge-node.js's applyIncomingMetric).
      lastFakeWorker().simulateDcmd("Plant1", [{ name: "Config", value: JSON.stringify({ retries: 5, mode: "fast" }) }]);

      asset.getValue("Plant1.Config").should.deepEqual({ retries: 5, mode: "fast" });
      done();
    });
  });

  it("applies an incoming NCMD write as a direct dotted attribute path (no Device segment)", function (done) {
    loadEdgeNode({}, function () {
      var asset = setupAssets(helper._RED);
      lastFakeWorker().simulateStatus("connected");

      lastFakeWorker().simulateNcmd([{ name: "Plant1/Status", value: "MAINTENANCE" }]);

      asset.getValue("Plant1.Status").should.equal("MAINTENANCE");
      done();
    });
  });

  it("re-publishes NBIRTH+DBIRTH on a \"Node Control/Rebirth\" NCMD (standard Sparkplug rebirth request)", function (done) {
    loadEdgeNode({}, function () {
      setupAssets(helper._RED);
      lastFakeWorker().simulateStatus("connected");
      lastFakeWorker().posted = []; // only care about what happens AFTER the initial birth

      lastFakeWorker().simulateNcmd([{ name: "Node Control/Rebirth", value: true }]);

      postedOf("birth").length.should.equal(1);
      should.exist(deviceBirthFor("Plant1"));
      done();
    });
  });

  describe("Primary Host STATE handshake (optional, spec §5.4)", function () {
    it("defers NBIRTH/DBIRTH until the configured Primary Host STATE says online=true", function (done) {
      loadEdgeNode({ primaryHostId: "Ignition" }, function () {
        setupAssets(helper._RED);
        lastFakeWorker().workerData.primaryHostStateTopic.should.equal("spBv1.0/STATE/Ignition");
        lastFakeWorker().simulateStatus("connected");

        postedOf("birth").length.should.equal(0); // still waiting -- nothing birthed yet

        lastFakeWorker().simulatePrimaryHostState(true, 1);

        postedOf("birth").length.should.equal(1);
        should.exist(deviceBirthFor("Plant1"));
        done();
      });
    });

    it("immediately restarts the connection when the Primary Host goes offline after being online, and re-defers the next birth", function (done) {
      loadEdgeNode({ primaryHostId: "Ignition" }, function () {
        setupAssets(helper._RED);
        lastFakeWorker().simulateStatus("connected");
        lastFakeWorker().simulatePrimaryHostState(true, 1);
        lastFakeWorker().posted = []; // only care about what happens after the birth now

        lastFakeWorker().simulatePrimaryHostState(false, 2);

        postedOf("restart-connection").length.should.equal(1);

        // [tck-id-message-flow-edge-node-birth-publish-phid-offline]: "...
        // start the connection establishment process over" -- the SAME
        // worker reconnects internally and reports "connected" again; this
        // must wait for Primary Host confirmation again, not assume it's
        // still online.
        lastFakeWorker().posted = [];
        lastFakeWorker().simulateStatus("connected");
        postedOf("birth").length.should.equal(0);
        done();
      });
    });

    it("ignores a stale STATE message older than the last one already accepted", function (done) {
      loadEdgeNode({ primaryHostId: "Ignition" }, function () {
        setupAssets(helper._RED);
        lastFakeWorker().simulateStatus("connected");

        lastFakeWorker().simulatePrimaryHostState(true, 100);
        lastFakeWorker().posted = [];
        // An out-of-order, OLDER "offline" arriving after a newer "online"
        // must be ignored -- otherwise a network reordering could bounce a
        // perfectly healthy session.
        lastFakeWorker().simulatePrimaryHostState(false, 50);

        lastFakeWorker().posted.length.should.equal(0);
        done();
      });
    });
  });

  describe("dynamic per-Device DBIRTH/DDEATH on a schema re-apply (spec §5.6, §6.4.26)", function () {
    function applySchemaWithTopLevelAssets(RED, assetNames) {
      RED.asset.applySchema({
        attributeTemplates: [{ id: "tmpl", name: "T", attributes: [{ name: "Status", valueType: "string", default: "OK" }] }],
        assets: assetNames.map(function (name, i) {
          return { id: "asset-" + i, name: name, parentId: null, templateIds: ["tmpl"], attributes: {} };
        }),
        historians: []
      });
    }

    it("posts a deviceBirth for a newly-added top-level asset via applySchema, without needing a reconnect", function (done) {
      loadEdgeNode({}, function () {
        pluginFactory(helper._RED);
        applySchemaWithTopLevelAssets(helper._RED, ["Plant1"]);
        lastFakeWorker().simulateStatus("connected");
        lastFakeWorker().posted = [];

        applySchemaWithTopLevelAssets(helper._RED, ["Plant1", "Plant2"]);

        should.exist(deviceBirthFor("Plant2"));
        postedOf("birth").length.should.equal(0); // no reconnect/rebirth needed for this
        done();
      });
    });

    it("posts a deviceDeath for a top-level asset removed via applySchema", function (done) {
      loadEdgeNode({}, function () {
        pluginFactory(helper._RED);
        applySchemaWithTopLevelAssets(helper._RED, ["Plant1", "Plant2"]);
        lastFakeWorker().simulateStatus("connected");
        lastFakeWorker().posted = [];

        applySchemaWithTopLevelAssets(helper._RED, ["Plant1"]); // Plant2 removed

        var ddeath = postedOf("deviceDeath").find(function (m) { return m.deviceId === "Plant2"; });
        should.exist(ddeath, "deviceDeath for the removed Plant2 was not posted");
        done();
      });
    });
  });

  it("refuses to connect at all when the configured Group ID contains a reserved Sparkplug character", function (done) {
    loadEdgeNode({ groupId: "Bad+Group" }, function () {
      // No worker should have been created at all -- the fake tracker stays
      // null, proving connect() itself was never run.
      should.not.exist(lastFakeWorker());
      done();
    });
  });

  it("refuses to connect at all when the configured Edge Node ID contains a reserved Sparkplug character", function (done) {
    loadEdgeNode({ edgeNodeId: "Edge/1" }, function () {
      should.not.exist(lastFakeWorker());
      done();
    });
  });

  it("warns but still posts a deviceBirth when a DEVICE (asset) name contains a reserved Sparkplug character, rather than refusing outright", function (done) {
    loadEdgeNode({}, function () {
      var RED = helper._RED;
      pluginFactory(RED);
      RED.asset.replaceState({
        attributeTemplates: [{ id: "tmpl", name: "T", attributes: [{ name: "Status", valueType: "string", default: "OK" }] }],
        assets: [{ id: "p1", name: "Bad/Plant", parentId: null, templateIds: ["tmpl"], attributes: {} }],
        historians: []
      });
      lastFakeWorker().simulateStatus("connected");

      should.exist(deviceBirthFor("Bad/Plant"), "the (malformed but best-effort) deviceBirth was still posted");
      done();
    });
  });

  it("close() posts a graceful close message and terminates the worker only after it acknowledges", function (done) {
    loadEdgeNode({}, function () {
      setupAssets(helper._RED);
      lastFakeWorker().simulateStatus("connected");
      var worker = lastFakeWorker();

      helper.unload().then(function () {
        var closeMsgs = worker.posted.filter(function (m) { return m.type === "close"; });
        closeMsgs.length.should.equal(1);
        worker.terminated.should.equal(true);
        done();
      });
      // The worker acknowledges asynchronously, same as the real one would
      // after its own NDEATH-then-end sequence completes.
      setImmediate(function () { worker.emit("message", { type: "closed" }); });
    });
  });

  it("close() still resolves (doesn't hang) even if the worker never acknowledges — the 1.5s grace-timer fallback", function (done) {
    this.timeout(4000);
    loadEdgeNode({}, function () {
      setupAssets(helper._RED);
      lastFakeWorker().simulateStatus("connected");
      var worker = lastFakeWorker();
      // Deliberately never emitting {type:"closed"} back.

      helper.unload().then(function () {
        worker.terminated.should.equal(true);
        done();
      });
    });
  });
});
