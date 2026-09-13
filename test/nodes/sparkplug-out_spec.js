const should = require("should");

// See test/helpers/fakeMqtt.js for why this MUST be a single shared helper.
const fakeMqtt = require("../helpers/fakeMqtt");

const helper = require("node-red-node-test-helper");
const sparkplugOutModule = require("../../nodes/sparkplug-out.js");
const codec = require("../../lib/sparkplug/sparkplugCodec");

describe("kufayeka-sparkplug-out", function () {
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
      id: "n1", type: "kufayeka-sparkplug-out", wires: [["n2"]],
      brokerUrl: "mqtt://fake-broker", groupId: "TestGroup", edgeNodeId: "Edge1", deviceId: ""
    }, configOverrides || {}), { id: "n2", type: "helper" }];
    helper.load(sparkplugOutModule, flow, done);
  }

  function lastPublish(client) {
    var p = client.published[client.published.length - 1];
    return { topic: p.topic, opts: p.opts, payload: codec.decodePayload(p.payload) };
  }

  it('publishes a "Node Control/Rebirth" NCMD when msg.command is "rebirth", ignoring any configured Device ID', function (done) {
    loadNode({ deviceId: "Plant1" }, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      var n1 = helper.getNode("n1");

      n1.receive({ command: "rebirth" });

      setTimeout(function () {
        var pub = lastPublish(client);
        pub.topic.should.equal("spBv1.0/TestGroup/NCMD/Edge1"); // node-scoped, no /Plant1 even though configured
        pub.opts.qos.should.equal(0);
        var m = pub.payload.metrics[0];
        m.name.should.equal("Node Control/Rebirth");
        m.type.should.equal("Boolean");
        m.value.should.equal(true);
        done();
      }, 20);
    });
  });

  it("publishes msg.metrics as a DCMD when a Device ID is configured", function (done) {
    loadNode({ deviceId: "Plant1" }, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      var n1 = helper.getNode("n1");

      n1.receive({ metrics: [{ name: "Motor1/Speed", type: "Double", value: 123 }] });

      setTimeout(function () {
        var pub = lastPublish(client);
        pub.topic.should.equal("spBv1.0/TestGroup/DCMD/Edge1/Plant1");
        pub.payload.metrics[0].should.deepEqual({ name: "Motor1/Speed", type: "Double", value: 123, timestamp: undefined });
        done();
      }, 20);
    });
  });

  it("publishes msg.payload as a shorthand single-metric NCMD when no Device ID is configured or given", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      var n1 = helper.getNode("n1");

      n1.receive({ payload: { name: "Plant1/Status", type: "String", value: "MAINTENANCE" } });

      setTimeout(function () {
        var pub = lastPublish(client);
        pub.topic.should.equal("spBv1.0/TestGroup/NCMD/Edge1");
        pub.payload.metrics[0].value.should.equal("MAINTENANCE");
        done();
      }, 20);
    });
  });

  it("msg.sparkplug overrides the node's configured default target per-message", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      var n1 = helper.getNode("n1");

      n1.receive({
        sparkplug: { groupId: "OtherGroup", edgeNodeId: "Edge9", deviceId: "Line1" },
        metrics: [{ name: "X", type: "Double", value: 1 }]
      });

      setTimeout(function () {
        var pub = lastPublish(client);
        pub.topic.should.equal("spBv1.0/OtherGroup/DCMD/Edge9/Line1");
        done();
      }, 20);
    });
  });

  it("forwards msg with msg.sparkplug describing what was actually published, on success", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      var n1 = helper.getNode("n1");
      var n2 = helper.getNode("n2");

      n2.once("input", function (msg) {
        msg.sparkplug.messageType.should.equal("NCMD");
        msg.sparkplug.topic.should.equal("spBv1.0/TestGroup/NCMD/Edge1");
        should.not.exist(msg.sparkplug.deviceId);
        done();
      });

      n1.receive({ payload: { name: "Plant1/Status", type: "String", value: "OK" } });
    });
  });

  it("does not publish anything when neither msg.command, msg.metrics, nor msg.payload provide anything to send", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();
      var n1 = helper.getNode("n1");
      var publishedBefore = client.published.length;

      n1.receive({});

      setTimeout(function () {
        client.published.length.should.equal(publishedBefore);
        done();
      }, 20);
    });
  });

  it("closes without hanging (client.end is called)", function (done) {
    loadNode({}, function () {
      var client = fakeMqtt.getLastFakeClient();
      client.simulateConnect();

      helper.unload().then(function () {
        client.ended.should.equal(true);
        done();
      });
    });
  });
});
