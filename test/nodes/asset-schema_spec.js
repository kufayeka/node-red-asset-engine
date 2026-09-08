const should = require("should");
const helper = require("node-red-node-test-helper");
const schemaNode = require("../../nodes/asset-schema.js");

describe("kufayeka-asset-schema Node (config)", function() {
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

  function schemaFlow() {
    return [
      {
        id: "cfg1",
        type: "kufayeka-asset-schema",
        name: "Test Schema",
        attributeTemplates: [
          { id: "tmpl-motor", name: "MotorTemplate", attributes: [{ name: "Speed", valueType: "number", default: 1450, unit: "RPM" }] }
        ],
        assets: [
          { id: "p1", name: "Plant1", parentId: null, templateIds: [] },
          { id: "m1", name: "Motor1", parentId: "p1", templateIds: ["tmpl-motor"] }
        ]
      }
    ];
  }

  it("should apply its schema to the engine on deploy", function(done) {
    helper.load(schemaNode, schemaFlow(), function() {
      helper._RED.asset.getValue("Plant1.Motor1.Speed").should.equal(1450);
      done();
    });
  });

  it("should preserve live values across a redeploy with the same schema", function(done) {
    helper.load(schemaNode, schemaFlow(), function() {
      helper._RED.asset.setAttribute("Plant1.Motor1.Speed", 3200);
      helper._RED.asset.getValue("Plant1.Motor1.Speed").should.equal(3200);

      helper.unload().then(function() {
        // Simulate a redeploy: the config node is reconstructed with the same schema
        helper.load(schemaNode, schemaFlow(), function() {
          helper._RED.asset.getValue("Plant1.Motor1.Speed").should.equal(3200);
          done();
        });
      });
    });
  });

  it("should automatically replace spaces in asset, template, and attribute names with underscores", function(done) {
    const spacedFlow = [
      {
        id: "cfg2",
        type: "kufayeka-asset-schema",
        name: "Spaced Schema",
        attributeTemplates: [
          { id: "tmpl-sensor", name: "Temperature Sensor", attributes: [{ name: "Target Temp", valueType: "number", default: 75, unit: "C" }] }
        ],
        assets: [
          { id: "p1", name: "Building A", parentId: null, templateIds: [] },
          { id: "s1", name: "Boiler Room", parentId: "p1", templateIds: ["tmpl-sensor"] }
        ]
      }
    ];

    helper.load(schemaNode, spacedFlow, function() {
      helper._RED.asset.getValue("Building_A.Boiler_Room.Target_Temp").should.equal(75);
      done();
    });
  });
});
