const should = require("should");
const helper = require("node-red-node-test-helper");
const writeNode = require("../../nodes/asset-write.js");
const pluginFactory = require("../../lib/asset-plugin.js");

describe("kufayeka-asset-write Node", function() {
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

  it("should write msg.payload to configured asset path", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-write",
        path: "Plant1.Motor1.Speed",
        property: "payload",
        propertyType: "msg",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(writeNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.should.have.property("_assetChanged");
        msg._assetChanged.length.should.equal(1);
        msg._assetChanged[0].value.should.equal(2800);

        helper._RED.asset.getValue("Plant1.Motor1.Speed").should.equal(2800);
        done();
      });

      n1.receive({ payload: 2800 });
    });
  });

  it("should write to dynamic path specified in msg.assetPath", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-write",
        property: "payload",
        propertyType: "msg",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(writeNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        helper._RED.asset.getValue("Plant1.Motor1.Status").should.equal("RUNNING");
        done();
      });

      n1.receive({ assetPath: "Plant1.Motor1.Status", payload: "RUNNING" });
    });
  });
});
