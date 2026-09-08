const should = require("should");
const helper = require("node-red-node-test-helper");
const multiReadNode = require("../../nodes/asset-multi-read.js");
const pluginFactory = require("../../lib/asset-plugin.js");

describe("kufayeka-asset-multi-read Node", function() {
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
            { name: "Speed", valueType: "number", default: 1500, unit: "RPM" },
            { name: "Status", valueType: "string", default: "RUNNING" },
            { name: "Current", valueType: "number", default: 12.5, unit: "A" }
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
            Speed: { value: 1500 },
            Status: { value: "RUNNING" },
            Current: { value: 12.5 }
          }
        }
      ],
      historians: []
    });
  }

  it("should read multiple paths as array of values", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-multi-read",
        paths: ["Plant1.Motor1.Speed", "Plant1.Motor1.Current"],
        property: "payload",
        propertyType: "msg",
        outputMode: "value",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(multiReadNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.payload.should.be.an.Array();
        msg.payload.length.should.equal(2);
        msg.payload[0].should.equal(1500);
        msg.payload[1].should.equal(12.5);
        done();
      });

      n1.receive({});
    });
  });

  it("should read multiple paths as map dictionary", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-multi-read",
        paths: ["Plant1.Motor1.Speed", "Plant1.Motor1.Status"],
        property: "payload",
        propertyType: "msg",
        outputMode: "map",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(multiReadNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.payload.should.be.an.Object();
        msg.payload.should.have.property("Plant1.Motor1.Speed", 1500);
        msg.payload.should.have.property("Plant1.Motor1.Status", "RUNNING");
        done();
      });

      n1.receive({});
    });
  });

  it("should support dynamic msg.paths override", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-multi-read",
        paths: [],
        property: "payload",
        propertyType: "msg",
        outputMode: "map",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(multiReadNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.payload.should.have.property("Plant1.Motor1.Current", 12.5);
        done();
      });

      n1.receive({ paths: ["Plant1.Motor1.Current"] });
    });
  });
});
