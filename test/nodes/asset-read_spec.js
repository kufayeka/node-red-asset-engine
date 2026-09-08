const should = require("should");
const helper = require("node-red-node-test-helper");
const readNode = require("../../nodes/asset-read.js");
const pluginFactory = require("../../lib/asset-plugin.js");

describe("kufayeka-asset-read Node", function() {
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
            { name: "Speed", valueType: "number", default: 1450, unit: "RPM" },
            { name: "Status", valueType: "string", default: "RUNNING" }
          ]
        },
        {
          id: "tmpl-plant",
          name: "PlantTemplate",
          attributes: [
            { name: "SiteName", valueType: "string", default: "Factory A" }
          ]
        }
      ],
      assets: [
        {
          id: "p1",
          name: "Plant1",
          parentId: null,
          templateIds: ["tmpl-plant"],
          attributes: {
            SiteName: { value: "Factory A" }
          }
        },
        {
          id: "m1",
          name: "Motor1",
          parentId: "p1",
          templateIds: ["tmpl-motor"],
          attributes: {
            Speed: { value: 1450 },
            Status: { value: "RUNNING" }
          }
        }
      ],
      historians: []
    });
  }

  it("should load node successfully", function(done) {
    const flow = [{ id: "n1", type: "kufayeka-asset-read", name: "Read Node" }];
    helper.load(readNode, flow, function() {
      const n1 = helper.getNode("n1");
      n1.should.have.property("name", "Read Node");
      done();
    });
  });

  it("should read asset attribute value into msg.payload", function(done) {
    const flow = [
      { id: "n1", type: "kufayeka-asset-read", path: "Plant1.Motor1.Speed", property: "payload", propertyType: "msg", outputMode: "value", wires: [["n2"]] },
      { id: "n2", type: "helper" }
    ];

    helper.load(readNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.should.have.property("payload", 1450);
        done();
      });

      n1.receive({ payload: "trigger" });
    });
  });

  it("should read full attribute object when outputMode is 'attribute'", function(done) {
    const flow = [
      { id: "n1", type: "kufayeka-asset-read", path: "Plant1.Motor1.Speed", property: "attr", propertyType: "msg", outputMode: "attribute", wires: [["n2"]] },
      { id: "n2", type: "helper" }
    ];

    helper.load(readNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.should.have.property("attr");
        msg.attr.should.have.property("attributeName", "Speed");
        msg.attr.should.have.property("value", 1450);
        msg.attr.should.have.property("unit", "RPM");
        done();
      });

      n1.receive({});
    });
  });

  it("should read dynamic path from msg.assetPath", function(done) {
    const flow = [
      { id: "n1", type: "kufayeka-asset-read", property: "payload", propertyType: "msg", outputMode: "value", wires: [["n2"]] },
      { id: "n2", type: "helper" }
    ];

    helper.load(readNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.payload.should.equal("RUNNING");
        done();
      });

      n1.receive({ assetPath: "Plant1.Motor1.Status" });
    });
  });
});
