const should = require("should");
const { createAssetStore } = require("../../lib/asset/AssetStoreFactory");

describe("AssetStore & AssetStoreIndex", function() {
  let sampleState;

  beforeEach(function() {
    sampleState = {
      attributeTemplates: [
        {
          id: "tmpl-motor",
          name: "MotorTemplate",
          attributes: [
            { name: "Speed", valueType: "number", default: 0, unit: "RPM", description: "Motor Speed" },
            { name: "Running", valueType: "boolean", default: false, description: "Running State" },
            { name: "Status", valueType: "string", default: "IDLE" }
          ]
        },
        {
          id: "tmpl-sensor",
          name: "SensorTemplate",
          attributes: [
            { name: "Temperature", valueType: "number", default: 25.0, unit: "C" },
            { name: "Pressure", valueType: "number", default: 1.0, unit: "bar" }
          ]
        },
        {
          id: "tmpl-plant",
          name: "PlantTemplate",
          attributes: [
            { name: "SiteName", valueType: "string", default: "Jakarta Main" }
          ]
        }
      ],
      assets: [
        {
          id: "plant-1",
          name: "Plant1",
          parentId: null,
          templateIds: ["tmpl-plant"],
          attributes: {
            SiteName: { value: "Jakarta Main" }
          }
        },
        {
          id: "line-1",
          name: "Line1",
          parentId: "plant-1",
          attributes: {}
        },
        {
          id: "motor-1",
          name: "Motor1",
          parentId: "line-1",
          templateIds: ["tmpl-motor"],
          attributes: {
            Speed: { value: 1200 } // Overriding template default
          }
        },
        {
          id: "motor-2",
          name: "Motor2",
          parentId: "line-1",
          templateIds: ["tmpl-motor"],
          attributes: {
            Speed: { value: 1800 },
            Running: { value: true }
          }
        },
        {
          id: "sensor-1",
          name: "Sensor1",
          parentId: "line-1",
          templateIds: ["tmpl-sensor"],
          attributes: {}
        }
      ],
      historians: [
        { id: "default", name: "Default InfluxDB", enabled: true }
      ]
    };
  });

  it("should initialize store and build index correctly", function() {
    const store = createAssetStore(sampleState);
    const state = store.getState();
    state.assets.length.should.equal(5);
    state.attributeTemplates.length.should.equal(3);
  });

  describe("Value Reads & Template Inheritance", function() {
    it("should resolve inherited template attributes with defaults", function() {
      const store = createAssetStore(sampleState);
      // Motor1 inherited Running from tmpl-motor (default: false)
      store.getValue("Plant1.Line1.Motor1.Running").should.equal(false);
      store.getValue("Plant1.Line1.Motor1.Status").should.equal("IDLE");
    });

    it("should resolve overridden attribute values", function() {
      const store = createAssetStore(sampleState);
      // Motor1 overrides Speed to 1200
      store.getValue("Plant1.Line1.Motor1.Speed").should.equal(1200);
      // Motor2 overrides Speed to 1800 and Running to true
      store.getValue("Plant1.Line1.Motor2.Speed").should.equal(1800);
      store.getValue("Plant1.Line1.Motor2.Running").should.equal(true);
    });

    it("should return fallback defaultValue if path does not exist", function() {
      const store = createAssetStore(sampleState);
      const val = store.getValue("Plant1.Line1.NonExistent.Attr", 999);
      val.should.equal(999);
    });

    it("should return array of values for wildcard path", function() {
      const store = createAssetStore(sampleState);
      const speeds = store.getValue("Plant1.Line1.*.Speed");
      Array.isArray(speeds).should.be.true();
      speeds.should.containEql(1200);
      speeds.should.containEql(1800);
    });
  });

  describe("Queries & Path Matching", function() {
    it("should query exact asset path", function() {
      const store = createAssetStore(sampleState);
      const results = store.query("Plant1.Line1.Motor1");
      results.length.should.equal(1);
      results[0].kind.should.equal("asset");
      results[0].path.should.equal("Plant1.Line1.Motor1");
    });

    it("should query exact attribute path", function() {
      const store = createAssetStore(sampleState);
      const results = store.query("Plant1.Line1.Motor1.Speed");
      results.length.should.equal(1);
      results[0].kind.should.equal("attribute");
      results[0].value.should.equal(1200);
      results[0].unit.should.equal("RPM");
    });

    it("should query attributes using wildcards", function() {
      const store = createAssetStore(sampleState);
      const results = store.query("Plant1.Line1.*.*");
      // Motor1 has 3 attrs, Motor2 has 3 attrs, Sensor1 has 2 attrs -> Total 8
      results.length.should.equal(8);
    });

    it("should return attributes using getAttributes()", function() {
      const store = createAssetStore(sampleState);
      const attrs = store.getAttributes("Plant1.Line1.Sensor1.*");
      attrs.length.should.equal(2);
      attrs.map(a => a.attributeName).should.containEql("Temperature");
      attrs.map(a => a.attributeName).should.containEql("Pressure");
    });
  });

  describe("Value Writes & Batch Updates", function() {
    it("should set single attribute value and update index", function() {
      const store = createAssetStore(sampleState);
      const changed = store.setAttribute("Plant1.Line1.Motor1.Speed", 2500);
      changed.length.should.equal(1);
      changed[0].value.should.equal(2500);
      store.getValue("Plant1.Line1.Motor1.Speed").should.equal(2500);
    });

    it("should update multiple targets when setting wildcard path", function() {
      const store = createAssetStore(sampleState);
      const changed = store.setAttribute("Plant1.Line1.*.Speed", 3000);
      changed.length.should.equal(2);
      store.getValue("Plant1.Line1.Motor1.Speed").should.equal(3000);
      store.getValue("Plant1.Line1.Motor2.Speed").should.equal(3000);
    });

    it("should perform batch writes with setAttributes", function() {
      const store = createAssetStore(sampleState);
      const results = store.setAttributes([
        { path: "Plant1.Line1.Motor1.Speed", value: 1111 },
        { path: "Plant1.Line1.Motor2.Speed", value: 2222 },
        { path: "Plant1.Line1.Sensor1.Temperature", value: 99.9 }
      ]);
      results.length.should.equal(3);
      store.getValue("Plant1.Line1.Motor1.Speed").should.equal(1111);
      store.getValue("Plant1.Line1.Motor2.Speed").should.equal(2222);
      store.getValue("Plant1.Line1.Sensor1.Temperature").should.equal(99.9);
    });
  });

  describe("Value Search & findAttributesByValue", function() {
    it("should find attributes matching exact value", function() {
      const store = createAssetStore(sampleState);
      const result = store.findAttributesByValue("Plant1.Line1.*.Running", true);
      result.count.should.equal(1);
      result.matches[0].path.should.equal("Plant1.Line1.Motor2.Running");
    });

    it("should find attributes loosely matching number as string", function() {
      const store = createAssetStore(sampleState);
      const result = store.findAttributesByValue("Plant1.Line1.*.Speed", "1200", { strict: false });
      result.count.should.equal(1);
      result.matches[0].path.should.equal("Plant1.Line1.Motor1.Speed");
    });
  });

  describe("Hierarchy Generation", function() {
    it("should build complete nested hierarchy tree with effective attributes", function() {
      const store = createAssetStore(sampleState);
      const tree = store.getHierarchy({ populateAttributes: true });
      tree.length.should.equal(1);
      tree[0].name.should.equal("Plant1");
      tree[0].children.length.should.equal(1);
      tree[0].children[0].name.should.equal("Line1");

      const lineChildren = tree[0].children[0].children;
      lineChildren.length.should.equal(3);
      const motor1Node = lineChildren.find(c => c.name === "Motor1");
      motor1Node.effectiveAttributes.length.should.equal(3);
      motor1Node.effectiveAttributes.find(a => a.name === "Speed").value.should.equal(1200);
    });
  });

  describe("Change Subscriptions & Events", function() {
    it("should notify subscriber when attribute changes", function(done) {
      const store = createAssetStore(sampleState);

      const unsubscribe = store.subscribe(function(meta) {
        meta.should.have.property("revision");
        meta.should.have.property("change");
        meta.change.type.should.equal("attribute.set");
        meta.change.changes[0].path.should.equal("Plant1.Line1.Motor1.Speed");
        meta.change.changes[0].value.should.equal(4500);
        unsubscribe();
        done();
      });

      store.setAttribute("Plant1.Line1.Motor1.Speed", 4500);
    });
  });

  describe("applySchema (deploy-time schema reapply, e.g. from a config node)", function() {
    it("should preserve live values for assets that still exist in the new schema", function() {
      const store = createAssetStore(sampleState);
      store.setAttribute("Plant1.Line1.Motor1.Speed", 9999);

      // Redeploy with the exact same structure (as a config node would resend on every deploy)
      store.applySchema({
        attributeTemplates: sampleState.attributeTemplates,
        assets: sampleState.assets.map((a) => ({ id: a.id, name: a.name, parentId: a.parentId, templateIds: a.templateIds || [] })),
        historians: sampleState.historians
      });

      store.getValue("Plant1.Line1.Motor1.Speed").should.equal(9999);
    });

    it("should apply template defaults for a newly added asset in the schema", function() {
      const store = createAssetStore(sampleState);

      store.applySchema({
        attributeTemplates: sampleState.attributeTemplates,
        assets: [
          ...sampleState.assets.map((a) => ({ id: a.id, name: a.name, parentId: a.parentId, templateIds: a.templateIds || [] })),
          { id: "motor-3", name: "Motor3", parentId: "line-1", templateIds: ["tmpl-motor"] }
        ],
        historians: sampleState.historians
      });

      store.getValue("Plant1.Line1.Motor3.Speed").should.equal(0);
      // Existing asset values remain untouched by the schema-only reapply
      store.getValue("Plant1.Line1.Motor1.Speed").should.equal(1200);
    });

    it("should drop values for an asset removed from the schema", function() {
      const store = createAssetStore(sampleState);
      store.setAttribute("Plant1.Line1.Motor2.Speed", 7777);

      store.applySchema({
        attributeTemplates: sampleState.attributeTemplates,
        assets: sampleState.assets
          .filter((a) => a.id !== "motor-2")
          .map((a) => ({ id: a.id, name: a.name, parentId: a.parentId, templateIds: a.templateIds || [] })),
        historians: sampleState.historians
      });

      store.query("Plant1.Line1.Motor2").length.should.equal(0);
      store.getValue("Plant1.Line1.Motor1.Speed").should.equal(1200);
    });
  });
});
