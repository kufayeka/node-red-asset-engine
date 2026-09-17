const should = require("should");

// See test/helpers/fakeWorker.js for why this MUST be a single shared helper
// (installed before anything else calls nodes/sparkplug-edge-node.js's
// _setWorkerFactoryForTests) rather than something this file sets up on its
// own — this spec file and sparkplug-edge-node_spec.js both load
// nodes/sparkplug-edge-node.js, and that module is only ever require()'d for
// real ONCE per mocha process. The actual mqtt.connect()/Protobuf codec now
// live in a worker_threads.Worker (lib/sparkplug-worker.js), so this fakes
// the worker, not require("mqtt") (that's test/helpers/fakeMqtt.js, used by
// test/lib/sparkplug-worker_spec.js instead).
const fakeWorker = require("../helpers/fakeWorker");

const helper = require("node-red-node-test-helper");
const edgeNodeModule = require("../../nodes/sparkplug-edge-node.js");
const statusNodeModule = require("../../nodes/sparkplug-status.js");
const pluginFactory = require("../../lib/asset-plugin.js");

describe("kufayeka-sparkplug-status", function () {
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

  function loadFlow(done) {
    var flow = [
      {
        id: "edge1", type: "kufayeka-sparkplug-edge-node",
        groupId: "TestGroup", edgeNodeId: "Edge1", brokerUrl: "mqtt://fake-broker"
      },
      { id: "status1", type: "kufayeka-sparkplug-status", edgeNode: "edge1", name: "My Status" }
    ];
    helper.load([edgeNodeModule, statusNodeModule], flow, done);
  }

  it("mirrors the referenced Edge Node's connection status onto its own node box", function (done) {
    loadFlow(function () {
      pluginFactory(helper._RED);
      helper._RED.asset.replaceState({ attributeTemplates: [], assets: [], historians: [] });

      var statusNode = helper.getNode("status1");
      var seen = [];
      statusNode.status = function (s) { seen.push(s); };

      fakeWorker.getLastFakeWorker().simulateStatus("connected");

      var online = seen.find(function (s) { return s.fill === "green"; });
      should.exist(online, "status node never saw the Edge Node's \"online\" status");
      online.text.should.match(/online/);
      done();
    });
  });

  it("shows an error status (not a crash) when no Edge Node config is selected", function (done) {
    var flow = [{ id: "status1", type: "kufayeka-sparkplug-status", name: "Orphan Status" }];
    helper.load(statusNodeModule, flow, function () {
      var statusNode = helper.getNode("status1");
      should.exist(statusNode);
      done();
    });
  });
});
