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
