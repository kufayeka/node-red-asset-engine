const should = require("should");

// See test/helpers/fakeMqtt.js for why this MUST be a single shared helper.
const fakeMqtt = require("../helpers/fakeMqtt");

const helper = require("node-red-node-test-helper");
const sparkplugInModule = require("../../nodes/sparkplug-in.js");
const codec = require("../../lib/sparkplug/sparkplugCodec");

describe("kufayeka-sparkplug-in", function () {
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

  function loadNode(configOverrides, done) {
    var flow = [Object.assign({
      id: "n1", type: "kufayeka-sparkplug-in", wires: [["n2"]],
      brokerUrl: "mqtt://fake-broker", groupFilter: "+", edgeNodeFilter: "+"
    }, configOverrides || {}), { id: "n2", type: "helper" }];
    helper.load(sparkplugInModule, flow, done);
  }

  function publishAndCapture(client, topic, encoded, cb) {
    var n2 = helper.getNode("n2");
    n2.once("input", function (msg) { cb(msg); });
    client.simulateMessage(topic, encoded);
  }

  it("subscribes to both node-level and device-level Sparkplug topic filters on connect", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      client.subscriptions.length.should.equal(1);
      var topics = client.subscriptions[0];
      topics.should.containEql("spBv1.0/+/+/+");
      topics.should.containEql("spBv1.0/+/+/+/+");
      done();
    });
  });

  it("decodes a compliant DBIRTH and reports no compliance issues, with correctly parsed topic metadata", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();

      var encoded = codec.encodePayload({
        timestamp: Date.now(),
        seq: 0,
        metrics: [{ name: "Speed", type: "Double", value: 10 }]
      });

      publishAndCapture(client, "spBv1.0/TestGroup/DBIRTH/Edge1/Plant1", encoded, function (msg) {
        msg.sparkplug.should.deepEqual({
          namespace: "spBv1.0", groupId: "TestGroup", messageType: "DBIRTH", edgeNodeId: "Edge1", deviceId: "Plant1"
        });
        msg.payload.metrics[0].name.should.equal("Speed");
        msg.complianceIssues.should.be.empty();
        done();
      });
    });
  });

  it("flags an NBIRTH missing its mandatory bdSeq and \"Node Control/Rebirth\" metrics", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();

      var encoded = codec.encodePayload({ timestamp: Date.now(), seq: 0, metrics: [] });

      publishAndCapture(client, "spBv1.0/TestGroup/NBIRTH/Edge1", encoded, function (msg) {
        msg.complianceIssues.should.containEql('NBIRTH is missing its mandatory "bdSeq" metric');
        msg.complianceIssues.should.containEql('NBIRTH is missing the mandatory "Node Control/Rebirth" metric');
        done();
      });
    });
  });

  it("flags an NBIRTH that doesn't reset seq to 0 (only NBIRTH resets -- see the DBIRTH tests below)", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();

      var encoded = codec.encodePayload({
        timestamp: Date.now(), seq: 5,
        metrics: [{ name: "bdSeq", type: "Int64", value: 1 }, { name: "Node Control/Rebirth", type: "Boolean", value: false }]
      });

      publishAndCapture(client, "spBv1.0/TestGroup/NBIRTH/Edge1", encoded, function (msg) {
        msg.complianceIssues.should.containEql("NBIRTH must reset seq to 0, got 5");
        done();
      });
    });
  });

  it("does NOT flag a DBIRTH for continuing the seq counter instead of resetting to 0 (real bug: DBIRTH is NOT required to reset, only NBIRTH is)", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();

      var nbirth = codec.encodePayload({
        timestamp: Date.now(), seq: 0,
        metrics: [{ name: "bdSeq", type: "Int64", value: 1 }, { name: "Node Control/Rebirth", type: "Boolean", value: false }]
      });
      publishAndCapture(client, "spBv1.0/TestGroup/NBIRTH/Edge1", nbirth, function () {
        // [tck-id-topics-dbirth-seq]/[tck-id-payloads-dbirth-seq-inc] (spec
        // p.32, p.92): a DBIRTH's seq "MUST have a value of one greater
        // than the previous MQTT message" -- i.e. 1 here, NOT 0.
        var dbirth = codec.encodePayload({ timestamp: Date.now(), seq: 1, metrics: [{ name: "Speed", type: "Double", value: 1 }] });
        publishAndCapture(client, "spBv1.0/TestGroup/DBIRTH/Edge1/Plant1", dbirth, function (msg) {
          msg.complianceIssues.should.be.empty();
          done();
        });
      });
    });
  });

  it("flags a DBIRTH whose seq doesn't continue from the prior NBIRTH", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();

      var nbirth = codec.encodePayload({
        timestamp: Date.now(), seq: 0,
        metrics: [{ name: "bdSeq", type: "Int64", value: 1 }, { name: "Node Control/Rebirth", type: "Boolean", value: false }]
      });
      publishAndCapture(client, "spBv1.0/TestGroup/NBIRTH/Edge1", nbirth, function () {
        var dbirth = codec.encodePayload({ timestamp: Date.now(), seq: 9, metrics: [{ name: "Speed", type: "Double", value: 1 }] });
        publishAndCapture(client, "spBv1.0/TestGroup/DBIRTH/Edge1/Plant1", dbirth, function (msg) {
          msg.complianceIssues.should.containEql("seq gap: expected 1 but got 9 (a message for this edge node may have been lost or delivered out of order)");
          done();
        });
      });
    });
  });

  it("flags a seq gap between two DDATA messages for the SAME edge node", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();

      var first = codec.encodePayload({ timestamp: Date.now(), seq: 1, metrics: [{ name: "Speed", type: "Double", value: 1 }] });
      publishAndCapture(client, "spBv1.0/TestGroup/DDATA/Edge1/Plant1", first, function (msg) {
        msg.complianceIssues.should.be.empty(); // nothing to compare against yet (first message seen for this edge node)

        var second = codec.encodePayload({ timestamp: Date.now(), seq: 9, metrics: [{ name: "Speed", type: "Double", value: 2 }] });
        publishAndCapture(client, "spBv1.0/TestGroup/DDATA/Edge1/Plant1", second, function (msg2) {
          msg2.complianceIssues.should.containEql("seq gap: expected 2 but got 9 (a message for this edge node may have been lost or delivered out of order)");
          done();
        });
      });
    });
  });

  it("does NOT flag an NDEATH for lacking a seq (NDEATH must NOT include one)", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      var encoded = codec.encodePayload({ timestamp: Date.now(), metrics: [{ name: "bdSeq", type: "Int64", value: 1 }] });
      publishAndCapture(client, "spBv1.0/TestGroup/NDEATH/Edge1", encoded, function (msg) {
        msg.complianceIssues.should.be.empty();
        done();
      });
    });
  });

  it("flags a DDEATH that's missing its required seq (unlike NDEATH, DDEATH MUST include one)", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      var encoded = codec.encodePayload({ timestamp: Date.now(), metrics: [] });
      publishAndCapture(client, "spBv1.0/TestGroup/DDEATH/Edge1/Plant1", encoded, function (msg) {
        msg.complianceIssues.should.containEql("DDEATH is missing its required sequence number");
        done();
      });
    });
  });

  it("flags an NCMD that incorrectly carries a seq number (NCMD/DCMD MUST NOT include one)", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      var encoded = codec.encodePayload({ timestamp: Date.now(), seq: 3, metrics: [{ name: "Node Control/Rebirth", type: "Boolean", value: true }] });
      publishAndCapture(client, "spBv1.0/TestGroup/NCMD/Edge1", encoded, function (msg) {
        msg.complianceIssues.should.containEql("NCMD messages MUST NOT include a sequence number, but one was present");
        done();
      });
    });
  });

  it("flags a DATA message missing its required seq entirely", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      var encoded = codec.encodePayload({ timestamp: Date.now(), metrics: [{ name: "Speed", type: "Double", value: 1 }] });
      publishAndCapture(client, "spBv1.0/TestGroup/DDATA/Edge1/Plant1", encoded, function (msg) {
        msg.complianceIssues.should.containEql("DDATA is missing its required sequence number");
        done();
      });
    });
  });

  it("flags a duplicate metric name within the same payload", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();

      var encoded = codec.encodePayload({
        timestamp: Date.now(), seq: 0,
        metrics: [{ name: "Speed", type: "Double", value: 1 }, { name: "Speed", type: "Double", value: 2 }]
      });

      publishAndCapture(client, "spBv1.0/TestGroup/DDATA/Edge1/Plant1", encoded, function (msg) {
        msg.complianceIssues.should.containEql('duplicate metric name in the same payload: "Speed"');
        done();
      });
    });
  });

  it("reports a decode failure as a compliance issue instead of crashing, for a message that isn't valid Sparkplug protobuf", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();

      publishAndCapture(client, "spBv1.0/TestGroup/DDATA/Edge1/Plant1", Buffer.from("not-a-protobuf-payload"), function (msg) {
        should.equal(msg.payload, null);
        msg.complianceIssues.length.should.be.above(0);
        msg.complianceIssues[0].should.match(/failed to decode payload/);
        done();
      });
    });
  });

  it("closes without hanging (client.end is called) even mid-reconnect", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      client.connected = false; // simulate a drop, same shape as the edge-node close race

      helper.unload().then(function () {
        client.ended.should.equal(true);
        done();
      });
    });
  });
});
