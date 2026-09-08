const should = require("should");
const helper = require("node-red-node-test-helper");
const multiWriteNode = require("../../nodes/asset-multi-write.js");
const pluginFactory = require("../../lib/asset-plugin.js");

describe("kufayeka-asset-multi-write Node", function() {
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
            { name: "Status", valueType: "string", default: "IDLE" }
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
            Status: { value: "IDLE" }
          }
        }
      ],
      historians: []
    });
  }

  it("should write multiple configured rules", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-multi-write",
        rules: [
          { path: "Plant1.Motor1.Speed", property: "speed", propertyType: "msg" },
          { path: "Plant1.Motor1.Status", property: "status", propertyType: "msg" }
        ],
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(multiWriteNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        helper._RED.asset.getValue("Plant1.Motor1.Speed").should.equal(1800);
        helper._RED.asset.getValue("Plant1.Motor1.Status").should.equal("ACTIVE");
        done();
      });

      n1.receive({ speed: 1800, status: "ACTIVE" });
    });
  });

  it("should write dynamic dictionary from msg.writes", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-multi-write",
        rules: [],
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(multiWriteNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        helper._RED.asset.getValue("Plant1.Motor1.Speed").should.equal(3200);
        helper._RED.asset.getValue("Plant1.Motor1.Status").should.equal("OVERDRIVE");
        done();
      });

      n1.receive({
        writes: {
          "Plant1.Motor1.Speed": 3200,
          "Plant1.Motor1.Status": "OVERDRIVE"
        }
      });
    });
  });
});
