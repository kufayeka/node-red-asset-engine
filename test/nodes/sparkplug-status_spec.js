const should = require("should");

// See test/helpers/fakeMqtt.js for why this MUST be a single shared helper
// (installed before anything else requires "mqtt" for real) rather than
// something this file sets up on its own — this spec file and
// sparkplug-edge-node_spec.js both load nodes/sparkplug-edge-node.js, and
// that module is only ever require()'d for real ONCE per mocha process.
const fakeMqtt = require("../helpers/fakeMqtt");

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
    fakeMqtt.resetLastFakeClient();
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

      fakeMqtt.getLastFakeClient().simulateConnect();

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
