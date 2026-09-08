const should = require("should");
const helper = require("node-red-node-test-helper");
const watchNode = require("../../nodes/asset-watch.js");
const pluginFactory = require("../../lib/asset-plugin.js");

describe("kufayeka-asset-watch Node", function() {
  before(function(done) {
    helper.init(require.resolve("node-red"));
    helper.startServer(done);
  });

  after(function(done) {
    helper.stopServer(done);
  });

  afterEach(function() {
    return helper.unload();
  });

  function setupEngineWithData(RED) {
    const plugin = pluginFactory(RED);
    const asset = RED.asset;
    asset.replaceState({
      attributeTemplates: [
        {
          id: "tmpl-motor",
          name: "MotorTemplate",
          attributes: [
            { name: "Speed", valueType: "number", default: 0 },
            { name: "Status", valueType: "string", default: "STOPPED" }
          ]
        }
      ],
      assets: [
        {
          id: "p1",
          name: "Plant1",
          parentId: null,
          attributes: {}
        },
        {
          id: "m1",
          name: "Motor1",
          parentId: "p1",
          templateIds: ["tmpl-motor"],
          attributes: {
            Speed: { value: 0 },
            Status: { value: "STOPPED" }
          }
        }
      ],
      historians: []
    });
  }

  it("should trigger message on watched exact attribute change", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-watch",
        watchPath: "Plant1.Motor1.Speed",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(watchNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.should.have.property("topic", "Plant1.Motor1.Speed");
        msg.should.have.property("payload", 1550);
        msg.should.have.property("attributeName", "Speed");
        done();
      });

      // Trigger attribute change in engine
      helper._RED.asset.setAttribute("Plant1.Motor1.Speed", 1550);
    });
  });

  it("should trigger message on wildcard watch pattern", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-watch",
        watchPath: "Plant1.*.*",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(watchNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.should.have.property("topic", "Plant1.Motor1.Status");
        msg.should.have.property("payload", "STARTING");
        done();
      });

      helper._RED.asset.setAttribute("Plant1.Motor1.Status", "STARTING");
    });
  });
});
