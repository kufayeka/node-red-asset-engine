const should = require("should");

// See test/helpers/fakeMqtt.js for why this MUST be a single shared helper
// (installed before anything else requires "mqtt" for real) rather than
// something this file sets up on its own.
const fakeMqtt = require("../helpers/fakeMqtt");

const helper = require("node-red-node-test-helper");
const edgeNodeModule = require("../../nodes/sparkplug-edge-node.js");
const pluginFactory = require("../../lib/asset-plugin.js");
const codec = require("../../lib/sparkplug/sparkplugCodec");

function decodedPublishesOf(client) {
  return client.published.map(function (p) {
    return { topic: p.topic, payload: codec.decodePayload(p.payload) };
  });
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
    fakeMqtt.resetLastFakeClient();
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

  it("publishes NBIRTH then one DBIRTH for the top-level asset, with correctly-named/typed metrics", function (done) {
    loadEdgeNode({}, function () {
      setupAssets(helper._RED);
      fakeMqtt.getLastFakeClient().simulateConnect();

      var publishes = decodedPublishesOf(fakeMqtt.getLastFakeClient());
      var nbirth = publishes.find(function (p) { return p.topic === "spBv1.0/TestGroup/NBIRTH/Edge1"; });
      var dbirth = publishes.find(function (p) { return p.topic === "spBv1.0/TestGroup/DBIRTH/Edge1/Plant1"; });

      should.exist(nbirth, "NBIRTH was not published");
      should.exist(nbirth.payload.metrics.find(function (m) { return m.name === "bdSeq"; }), "NBIRTH is missing its bdSeq metric");
      // [tck-id-topics-nbirth-rebirth-metric]: mandatory on every NBIRTH —
      // this is how a Host Application knows it CAN request a rebirth.
      var rebirthMetric = nbirth.payload.metrics.find(function (m) { return m.name === "Node Control/Rebirth"; });
      should.exist(rebirthMetric, "NBIRTH is missing the mandatory \"Node Control/Rebirth\" metric");
      rebirthMetric.type.should.equal("Boolean");
      rebirthMetric.value.should.equal(false);

      should.exist(dbirth, "DBIRTH for Plant1 was not published");
      var status = dbirth.payload.metrics.find(function (m) { return m.name === "Status"; });
      var speed = dbirth.payload.metrics.find(function (m) { return m.name === "Motor1/Speed"; });
      should.exist(status, "root-level attribute Status missing from DBIRTH");
      status.value.should.equal("OK");
      should.exist(speed, "nested attribute Motor1/Speed missing from DBIRTH");
      speed.value.should.equal(10);
      speed.type.should.equal("Double");

      // [tck-id-payloads-nbirth-qos] / [-dbirth-qos]: MUST be QoS 0, not 1 —
      // Sparkplug's own seq/bdSeq numbers (not MQTT QoS) are what let a Host
      // Application detect a lost Birth.
      var rawNbirth = fakeMqtt.getLastFakeClient().published.find(function (p) { return p.topic === "spBv1.0/TestGroup/NBIRTH/Edge1"; });
      var rawDbirth = fakeMqtt.getLastFakeClient().published.find(function (p) { return p.topic === "spBv1.0/TestGroup/DBIRTH/Edge1/Plant1"; });
      rawNbirth.opts.qos.should.equal(0);
      rawDbirth.opts.qos.should.equal(0);

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
            // Full round trip through the REAL schema/hierarchy/mapping/
            // codec pipeline (not just the pure functions in isolation) —
            // a signed Int16 written as -1000 must survive as -1000, typed
            // as "Int16" on the wire, not silently flattened to a Double.
            { name: "Delta", valueType: "number", default: 0, sparkplugType: "Int16" },
            { name: "Samples", valueType: "array", default: [], sparkplugType: "Int32Array" }
          ]
        }],
        assets: [{ id: "p1", name: "Plant1", parentId: null, templateIds: ["tmpl"], attributes: { Delta: { value: -1000 }, Samples: { value: [1, -2, 3] } } }],
        historians: []
      });
      fakeMqtt.getLastFakeClient().simulateConnect();

      var dbirth = decodedPublishesOf(fakeMqtt.getLastFakeClient()).find(function (p) { return p.topic === "spBv1.0/TestGroup/DBIRTH/Edge1/Plant1"; });
      should.exist(dbirth);
      var delta = dbirth.payload.metrics.find(function (m) { return m.name === "Delta"; });
      var samples = dbirth.payload.metrics.find(function (m) { return m.name === "Samples"; });
      should.exist(delta);
      delta.type.should.equal("Int16");
      delta.value.should.equal(-1000);
      should.exist(samples);
      samples.type.should.equal("Int32Array");
      samples.value.should.deepEqual([1, -2, 3]);
      done();
    });
  });

  it("advances bdSeq (and refreshes the registered Will) on every underlying mqtt reconnect, not just node startup", function (done) {
    loadEdgeNode({}, function () {
      setupAssets(helper._RED);
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();

      var firstNbirth = decodedPublishesOf(client).find(function (p) { return p.topic === "spBv1.0/TestGroup/NBIRTH/Edge1"; });
      var firstBdSeq = firstNbirth.payload.metrics.find(function (m) { return m.name === "bdSeq"; }).value;

      client.published = [];
      // A library-level auto-reconnect (network blip, broker restart) is a
      // genuinely NEW MQTT session — bdSeq must be different this time, or
      // this session's Will (and NBIRTH) would be indistinguishable from
      // the previous one's to a Host Application.
      client.simulateReconnect();

      var secondNbirth = decodedPublishesOf(client).find(function (p) { return p.topic === "spBv1.0/TestGroup/NBIRTH/Edge1"; });
      var secondBdSeq = secondNbirth.payload.metrics.find(function (m) { return m.name === "bdSeq"; }).value;

      secondBdSeq.should.not.equal(firstBdSeq);

      // The Will re-registered for this session must already carry the
      // SAME new bdSeq as the NBIRTH that just followed it — mqtt.js reads
      // client.options.will fresh right when it builds each CONNECT
      // packet (see mqtt/build/lib/client.js), so this has to already be
      // updated by the time "reconnect" handling finishes, not later.
      var willMetric = codec.decodePayload(client.options.will.payload).metrics.find(function (m) { return m.name === "bdSeq"; });
      should.exist(willMetric);
      willMetric.value.should.equal(secondBdSeq);

      done();
    });
  });

  it("publishes DDATA with the SAME metric name DBIRTH used, when the underlying asset attribute changes", function (done) {
    loadEdgeNode({}, function () {
      var asset = setupAssets(helper._RED);
      fakeMqtt.getLastFakeClient().simulateConnect();
      fakeMqtt.getLastFakeClient().published = []; // only care about what happens AFTER birth from here on

      asset.setAttribute("Plant1.Motor1.Speed", 77);

      var publishes = decodedPublishesOf(fakeMqtt.getLastFakeClient());
      var ddata = publishes.find(function (p) { return p.topic === "spBv1.0/TestGroup/DDATA/Edge1/Plant1"; });
      should.exist(ddata, "DDATA for Plant1 was not published after an attribute change");
      var speed = ddata.payload.metrics.find(function (m) { return m.name === "Motor1/Speed"; });
      should.exist(speed);
      speed.value.should.equal(77);

      done();
    });
  });

  it("publishes isNull:true (not a fake 0/\"\"/false) for an attribute whose value is genuinely null", function (done) {
    loadEdgeNode({}, function () {
      var asset = setupAssets(helper._RED);
      fakeMqtt.getLastFakeClient().simulateConnect();
      fakeMqtt.getLastFakeClient().published = [];

      asset.setAttribute("Plant1.Motor1.Speed", null);

      var publishes = decodedPublishesOf(fakeMqtt.getLastFakeClient());
      var ddata = publishes.find(function (p) { return p.topic === "spBv1.0/TestGroup/DDATA/Edge1/Plant1"; });
      should.exist(ddata, "DDATA for Plant1 was not published after setting the attribute to null");
      var speed = ddata.payload.metrics.find(function (m) { return m.name === "Motor1/Speed"; });
      should.exist(speed);
      speed.isNull.should.equal(true);
      should.not.exist(speed.value);

      done();
    });
  });

  it("applies an incoming DCMD write the same way the internal asset-write node would", function (done) {
    loadEdgeNode({}, function () {
      var asset = setupAssets(helper._RED);
      fakeMqtt.getLastFakeClient().simulateConnect();

      var payload = codec.encodePayload({
        timestamp: Date.now(),
        metrics: [{ name: "Motor1/Speed", type: "Double", value: 123 }]
      });
      fakeMqtt.getLastFakeClient().simulateMessage("spBv1.0/TestGroup/DCMD/Edge1/Plant1", payload);

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
      fakeMqtt.getLastFakeClient().simulateConnect();

      var dbirth = decodedPublishesOf(fakeMqtt.getLastFakeClient()).find(function (p) { return p.topic === "spBv1.0/TestGroup/DBIRTH/Edge1/Plant1"; });
      var metric = dbirth.payload.metrics.find(function (m) { return m.name === "air_pressure"; });
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
      fakeMqtt.getLastFakeClient().simulateConnect();

      // 1. DBIRTH publishes it as a real Sparkplug String, JSON-stringified.
      var dbirth = decodedPublishesOf(fakeMqtt.getLastFakeClient()).find(function (p) { return p.topic === "spBv1.0/TestGroup/DBIRTH/Edge1/Plant1"; });
      var metric = dbirth.payload.metrics.find(function (m) { return m.name === "Config"; });
      should.exist(metric);
      metric.type.should.equal("String");
      metric.value.should.equal(JSON.stringify({ retries: 3 }));

      // 2. A Host Application writing back JSON-source text via DCMD must
      // land as a real JS object again — asset.setAttribute otherwise has
      // no reason to parse a plain string for an "object" attribute (see
      // sparkplug-edge-node.js's applyIncomingMetric).
      var payload = codec.encodePayload({
        timestamp: Date.now(),
        metrics: [{ name: "Config", type: "String", value: JSON.stringify({ retries: 5, mode: "fast" }) }]
      });
      fakeMqtt.getLastFakeClient().simulateMessage("spBv1.0/TestGroup/DCMD/Edge1/Plant1", payload);

      asset.getValue("Plant1.Config").should.deepEqual({ retries: 5, mode: "fast" });
      done();
    });
  });

  it("applies an incoming NCMD write as a direct dotted attribute path (no Device segment)", function (done) {
    loadEdgeNode({}, function () {
      var asset = setupAssets(helper._RED);
      fakeMqtt.getLastFakeClient().simulateConnect();

      var payload = codec.encodePayload({
        timestamp: Date.now(),
        metrics: [{ name: "Plant1/Status", type: "String", value: "MAINTENANCE" }]
      });
      fakeMqtt.getLastFakeClient().simulateMessage("spBv1.0/TestGroup/NCMD/Edge1", payload);

      asset.getValue("Plant1.Status").should.equal("MAINTENANCE");
      done();
    });
  });

  it("re-publishes NBIRTH+DBIRTH on a \"Node Control/Rebirth\" NCMD (standard Sparkplug rebirth request)", function (done) {
    loadEdgeNode({}, function () {
      setupAssets(helper._RED);
      fakeMqtt.getLastFakeClient().simulateConnect();
      fakeMqtt.getLastFakeClient().published = []; // only care about what happens AFTER the initial birth

      var payload = codec.encodePayload({
        timestamp: Date.now(),
        metrics: [{ name: "Node Control/Rebirth", type: "Boolean", value: true }]
      });
      fakeMqtt.getLastFakeClient().simulateMessage("spBv1.0/TestGroup/NCMD/Edge1", payload);

      var topics = fakeMqtt.getLastFakeClient().published.map(function (p) { return p.topic; });
      topics.should.containEql("spBv1.0/TestGroup/NBIRTH/Edge1");
      topics.should.containEql("spBv1.0/TestGroup/DBIRTH/Edge1/Plant1");
      done();
    });
  });

  describe("Primary Host STATE handshake (optional, spec §5.4)", function () {
    it("defers NBIRTH/DBIRTH until the configured Primary Host STATE says online=true", function (done) {
      loadEdgeNode({ primaryHostId: "Ignition" }, function () {
        setupAssets(helper._RED);
        var client = fakeMqtt.getLastFakeClient();
        client.simulateConnect();

        client.published.should.be.empty(); // still waiting -- nothing birthed yet
        client.subscriptions[0].should.containEql("spBv1.0/STATE/Ignition");

        client.simulateMessage("spBv1.0/STATE/Ignition", Buffer.from(JSON.stringify({ online: true, timestamp: 1 })));

        var topics = client.published.map(function (p) { return p.topic; });
        topics.should.containEql("spBv1.0/TestGroup/NBIRTH/Edge1");
        topics.should.containEql("spBv1.0/TestGroup/DBIRTH/Edge1/Plant1");
        done();
      });
    });

    it("immediately NDEATHs and restarts the whole connection when the Primary Host goes offline after being online", function (done) {
      loadEdgeNode({ primaryHostId: "Ignition" }, function () {
        setupAssets(helper._RED);
        var firstClient = fakeMqtt.getLastFakeClient();
        firstClient.simulateConnect();
        firstClient.simulateMessage("spBv1.0/STATE/Ignition", Buffer.from(JSON.stringify({ online: true, timestamp: 1 })));
        firstClient.published = []; // only care about what happens after the birth now

        firstClient.simulateMessage("spBv1.0/STATE/Ignition", Buffer.from(JSON.stringify({ online: false, timestamp: 2 })));

        var deaths = decodedPublishesOf(firstClient).filter(function (p) { return p.topic === "spBv1.0/TestGroup/NDEATH/Edge1"; });
        deaths.length.should.equal(1);
        firstClient.ended.should.equal(true);

        // [tck-id-message-flow-edge-node-birth-publish-phid-offline]: "...
        // start the connection establishment process over" -- a brand new
        // client/session, which must wait for Primary Host confirmation
        // again rather than assuming it's still online.
        var secondClient = fakeMqtt.getLastFakeClient();
        secondClient.should.not.equal(firstClient);
        secondClient.simulateConnect();
        secondClient.published.should.be.empty();
        secondClient.subscriptions[0].should.containEql("spBv1.0/STATE/Ignition");
        done();
      });
    });

    it("ignores a stale STATE message older than the last one already accepted", function (done) {
      loadEdgeNode({ primaryHostId: "Ignition" }, function () {
        setupAssets(helper._RED);
        var client = fakeMqtt.getLastFakeClient();
        client.simulateConnect();

        client.simulateMessage("spBv1.0/STATE/Ignition", Buffer.from(JSON.stringify({ online: true, timestamp: 100 })));
        client.published = [];
        // An out-of-order, OLDER "offline" arriving after a newer "online"
        // must be ignored -- otherwise a network reordering could bounce
        // a perfectly healthy session.
        client.simulateMessage("spBv1.0/STATE/Ignition", Buffer.from(JSON.stringify({ online: false, timestamp: 50 })));

        client.published.should.be.empty();
        client.ended.should.equal(false);
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

    it("publishes a DBIRTH for a newly-added top-level asset via applySchema, without needing a reconnect", function (done) {
      loadEdgeNode({}, function () {
        pluginFactory(helper._RED);
        applySchemaWithTopLevelAssets(helper._RED, ["Plant1"]);
        var client = fakeMqtt.getLastFakeClient();
        client.simulateConnect();
        client.published = [];

        applySchemaWithTopLevelAssets(helper._RED, ["Plant1", "Plant2"]);

        var topics = client.published.map(function (p) { return p.topic; });
        topics.should.containEql("spBv1.0/TestGroup/DBIRTH/Edge1/Plant2");
        topics.should.not.containEql("spBv1.0/TestGroup/NBIRTH/Edge1"); // no reconnect/rebirth needed for this
        done();
      });
    });

    it("publishes a DDEATH (with a required seq number) for a top-level asset removed via applySchema", function (done) {
      loadEdgeNode({}, function () {
        pluginFactory(helper._RED);
        applySchemaWithTopLevelAssets(helper._RED, ["Plant1", "Plant2"]);
        var client = fakeMqtt.getLastFakeClient();
        client.simulateConnect();
        client.published = [];

        applySchemaWithTopLevelAssets(helper._RED, ["Plant1"]); // Plant2 removed

        var ddeath = decodedPublishesOf(client).find(function (p) { return p.topic === "spBv1.0/TestGroup/DDEATH/Edge1/Plant2"; });
        should.exist(ddeath, "DDEATH for the removed Plant2 was not published");
        should.exist(ddeath.payload.seq, "DDEATH must include a sequence number");
        done();
      });
    });
  });

  it("refuses to connect at all when the configured Group ID contains a reserved Sparkplug character", function (done) {
    loadEdgeNode({ groupId: "Bad+Group" }, function () {
      // No mqtt.connect() call should have happened at all -- the fake
      // client tracker stays null, proving connect() itself was never run.
      should.not.exist(fakeMqtt.getLastFakeClient());
      done();
    });
  });

  it("refuses to connect at all when the configured Edge Node ID contains a reserved Sparkplug character", function (done) {
    loadEdgeNode({ edgeNodeId: "Edge/1" }, function () {
      should.not.exist(fakeMqtt.getLastFakeClient());
      done();
    });
  });

  it("warns but still publishes a DBIRTH when a DEVICE (asset) name contains a reserved Sparkplug character, rather than refusing outright", function (done) {
    loadEdgeNode({}, function () {
      var RED = helper._RED;
      pluginFactory(RED);
      RED.asset.replaceState({
        attributeTemplates: [{ id: "tmpl", name: "T", attributes: [{ name: "Status", valueType: "string", default: "OK" }] }],
        assets: [{ id: "p1", name: "Bad/Plant", parentId: null, templateIds: ["tmpl"], attributes: {} }],
        historians: []
      });
      fakeMqtt.getLastFakeClient().simulateConnect();

      var publishes = decodedPublishesOf(fakeMqtt.getLastFakeClient());
      var dbirth = publishes.find(function (p) { return p.topic === "spBv1.0/TestGroup/DBIRTH/Edge1/Bad/Plant"; });
      should.exist(dbirth, "the (malformed but best-effort) DBIRTH was still published");
      done();
    });
  });

  it("closes promptly instead of hanging when the broker is already gone at shutdown time (the reported Ctrl+C bug)", function (done) {
    loadEdgeNode({}, function () {
      setupAssets(helper._RED);
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      // Simulates the exact race reported in production: an embedded/local
      // broker (or the real one) drops out from under this node in the
      // SAME shutdown pass its own "close" handler runs in — by the time
      // close fires, the client is already disconnected, still silently
      // trying to reconnect underneath (ECONNREFUSED). Before the fix, the
      // close handler unconditionally tried to publish NDEATH and waited
      // on a PUBACK that could never arrive, hanging until Node-RED's own
      // close-timeout killed it with "Error stopping node: Close timed
      // out" — this asserts helper.unload()'s promise actually resolves
      // (mocha's own 2000ms test timeout is the backstop if it hangs
      // again) and that no doomed publish is even attempted.
      client.connected = false;
      client.published = [];

      helper.unload().then(function () {
        client.published.should.be.empty();
        client.ended.should.equal(true);
        done();
      });
    });
  });

  it("publishes NDEATH on a clean shutdown (node 'close'), in addition to the MQTT Will already registered for an ungraceful one", function (done) {
    loadEdgeNode({}, function () {
      setupAssets(helper._RED);
      fakeMqtt.getLastFakeClient().simulateConnect();
      var client = fakeMqtt.getLastFakeClient(); // helper.unload() below will null out module-level state via afterEach

      // A node's "close" handler is invoked by Node-RED's own flow-teardown
      // (triggered here via helper.unload(), same as every other test's
      // afterEach already does implicitly) — not by calling .close()
      // directly on the node instance, which isn't how node-red-node-test-
      // helper's lifecycle works. The Will payload registered at connect()
      // time already carries the bdSeq/death shape — this asserts the
      // GRACEFUL path publishes the equivalent message itself too, rather
      // than relying solely on the broker to deliver the Will (which only
      // fires on an ungraceful drop).
      helper.unload().then(function () {
        var death = client.published.find(function (p) { return p.topic === "spBv1.0/TestGroup/NDEATH/Edge1"; });
        should.exist(death, "NDEATH was not published on clean shutdown");
        client.ended.should.equal(true);
        done();
      });
    });
  });
});
