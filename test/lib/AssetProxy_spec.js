const should = require("should");
const {
  createAssetProxy,
  preprocessAssetScript,
  generateAssetDts
} = require("../../lib/asset/AssetProxy");

describe("AssetProxy & Preprocessor", function() {
  describe("preprocessAssetScript", function() {
    it("should transform % identifier into clean identifier", function() {
      const code = "const speed = %Plant1.Line1.Motor1.Speed;";
      const result = preprocessAssetScript(code);
      result.should.equal("const speed = Plant1.Line1.Motor1.Speed;");
    });

    it("should handle multiple % expressions in one script", function() {
      const code = "%Plant1.Tank.Level = %Plant2.Tank.Level + %Plant3.Offset;";
      const result = preprocessAssetScript(code);
      result.should.equal("Plant1.Tank.Level = Plant2.Tank.Level + Plant3.Offset;");
    });

    it("should NOT transpile arithmetic modulo operators", function() {
      const code = "const isEven = (x % 2 === 0); const remainder = count % 10;";
      const result = preprocessAssetScript(code);
      result.should.equal(code);
    });

    it("should handle mixed modulo and % asset path expressions", function() {
      const code = "const val = (%Plant1.Count % 5) + 10;";
      const result = preprocessAssetScript(code);
      result.should.equal("const val = (Plant1.Count % 5) + 10;");
    });

    it("should handle paths with spaces using quoted % syntax", function() {
      const code = 'const speed = %"Plant 1.Line 1.Motor 1.Speed"%;';
      const result = preprocessAssetScript(code);
      result.should.equal('const speed = $["Plant 1.Line 1.Motor 1.Speed"];');
    });

    it("should handle empty, null, or undefined gracefully", function() {
      preprocessAssetScript("").should.equal("");
      preprocessAssetScript(null).should.equal("");
      preprocessAssetScript(undefined).should.equal("");
    });
  });

  describe("createAssetProxy", function() {
    let mockValues = {};
    let mockStore = {
      assetByPath: new Map([
        ["Plant1", { id: "p1", name: "Plant1" }],
        ["Plant1.Line1", { id: "l1", name: "Line1" }],
        ["Plant1.Line1.Motor1", { id: "m1", name: "Motor1" }]
      ]),
      attributeByPath: new Map([
        ["Plant1.Line1.Motor1.Speed", { path: "Plant1.Line1.Motor1.Speed", value: 1500, type: "number" }],
        ["Plant1.Line1.Motor1.Running", { path: "Plant1.Line1.Motor1.Running", value: true, type: "boolean" }],
        ["Plant1.Temp", { path: "Plant1.Temp", value: 45.2, type: "number" }]
      ])
    };

    let mockController = {
      requireStore() {
        return mockStore;
      },
      getValue(path, def) {
        if (mockStore.attributeByPath.has(path)) {
          return mockStore.attributeByPath.get(path).value;
        }
        return def;
      },
      setAttribute(path, val) {
        if (!mockStore.attributeByPath.has(path)) {
          mockStore.attributeByPath.set(path, { path, value: val });
        } else {
          mockStore.attributeByPath.get(path).value = val;
        }
        return [{ path, value: val }];
      }
    };

    it("should read attribute value using dot-notation", function() {
      const $ = createAssetProxy("", mockController);
      $.Plant1.Line1.Motor1.Speed.should.equal(1500);
      $.Plant1.Line1.Motor1.Running.should.equal(true);
      $.Plant1.Temp.should.equal(45.2);
    });

    it("should write attribute value using dot-notation", function() {
      const $ = createAssetProxy("", mockController);
      $.Plant1.Line1.Motor1.Speed = 2200;
      $.Plant1.Line1.Motor1.Speed.should.equal(2200);
      mockStore.attributeByPath.get("Plant1.Line1.Motor1.Speed").value.should.equal(2200);
    });

    it("should support function call getter $(path)", function() {
      const $ = createAssetProxy("", mockController);
      $("Plant1.Line1.Motor1.Speed").should.equal(2200);
      $("Plant1.Temp").should.equal(45.2);
    });

    it("should support function call setter $(path, val)", function() {
      const $ = createAssetProxy("", mockController);
      $("Plant1.Temp", 88.5);
      $("Plant1.Temp").should.equal(88.5);
    });

    it("should support prefix-scoped proxy instances", function() {
      const plant1Proxy = createAssetProxy("Plant1", mockController);
      plant1Proxy.Line1.Motor1.Speed.should.equal(2200);
      plant1Proxy.Temp.should.equal(88.5);

      plant1Proxy.Temp = 50.0;
      plant1Proxy.Temp.should.equal(50.0);
    });

    it("should handle internal properties ($$, __) by returning undefined", function() {
      const $ = createAssetProxy("", mockController);
      should.not.exist($.__proto_test__);
      should.not.exist($.$$custom);
    });
  });

  describe("generateAssetDts", function() {
    it("should generate valid TypeScript definition text from hierarchy", function() {
      const hierarchy = [
        {
          id: "p1",
          name: "Plant1",
          path: "Plant1",
          effectiveAttributes: [
            { name: "Temp", value: 55.4, valueType: "number", unit: "C", description: "Reactor Temperature" }
          ],
          children: [
            {
              id: "l1",
              name: "Line1",
              path: "Plant1.Line1",
              effectiveAttributes: [
                { name: "Speed", value: 100, valueType: "number", unit: "RPM" }
              ]
            }
          ]
        }
      ];

      const dts = generateAssetDts(hierarchy);
      dts.should.be.a.String();
      dts.should.containEql("declare const Plant1: KufayekaAssetTree[\"Plant1\"]");
      dts.should.containEql("declare const $: KufayekaAssetTree");
      dts.should.containEql("declare const asset:");
      dts.should.containEql("\"Temp\": number;");
      dts.should.containEql("\"Speed\": number;");
    });
  });
});
