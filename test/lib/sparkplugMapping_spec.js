const should = require("should");
const mapping = require("../../lib/sparkplug/sparkplugMapping");

describe("sparkplugMapping", function () {
  describe("mapValueTypeToSparkplugType / coerceValueForSparkplug", function () {
    it("maps boolean/number to Boolean/Double, everything else to String", function () {
      mapping.mapValueTypeToSparkplugType("boolean").should.equal("Boolean");
      mapping.mapValueTypeToSparkplugType("number").should.equal("Double");
      mapping.mapValueTypeToSparkplugType("string").should.equal("String");
      mapping.mapValueTypeToSparkplugType("array").should.equal("String");
      mapping.mapValueTypeToSparkplugType("object").should.equal("String");
    });

    it("JSON-stringifies array/object values (no native Sparkplug DataSet/Template mapping in v1)", function () {
      mapping.coerceValueForSparkplug([1, 2, 3], "array").should.equal("[1,2,3]");
      mapping.coerceValueForSparkplug({ a: 1 }, "object").should.equal(JSON.stringify({ a: 1 }));
    });

    it("coerces a non-boolean truthy/falsy value to a real boolean", function () {
      mapping.coerceValueForSparkplug("true", "boolean").should.equal(true);
      mapping.coerceValueForSparkplug(0, "boolean").should.equal(false);
    });

    it("coerces a stringly-typed number", function () {
      mapping.coerceValueForSparkplug("42.5", "number").should.equal(42.5);
    });
  });

  describe("toSparkplugMetric — null/missing values", function () {
    it("a null attribute value produces isNull:true with no value field (not a fake default)", function () {
      var m = mapping.toSparkplugMetric({ value: null, valueType: "number", ts: 1 }, "Speed");
      m.should.deepEqual({ name: "Speed", type: "Double", isNull: true, timestamp: 1 });
    });

    it("an undefined attribute value (never yet set) is ALSO isNull, same as an explicit null", function () {
      var m = mapping.toSparkplugMetric({ valueType: "string", ts: 1 }, "Status");
      m.isNull.should.equal(true);
      should.not.exist(m.value);
    });

    it("a real (non-null) value is NOT flagged isNull", function () {
      var m = mapping.toSparkplugMetric({ value: 0, valueType: "number", ts: 1 }, "Count");
      should.not.exist(m.isNull);
      m.value.should.equal(0); // the actual bug this guards against: 0 must not be mistaken for "no value"
    });
  });

  describe("topLevelNameFromPath / relativeMetricNameFromPath — must stay exact inverses of collectDeviceMetrics", function () {
    it("extracts the top-level asset name from a nested dotted path", function () {
      mapping.topLevelNameFromPath("Plant1.Line1.Motor1.Speed").should.equal("Plant1");
    });

    it("a path with no dots IS the top-level name (attribute directly on the root asset)", function () {
      mapping.topLevelNameFromPath("Plant1").should.equal("Plant1");
    });

    it("converts the remaining dotted segments to slash-separated, device-relative form", function () {
      mapping.relativeMetricNameFromPath("Plant1.Line1.Motor1.Speed", "Plant1").should.equal("Line1/Motor1/Speed");
    });

    it("an attribute directly on the top-level asset has no leading slash", function () {
      mapping.relativeMetricNameFromPath("Plant1.Status", "Plant1").should.equal("Status");
    });
  });

  describe("collectDeviceMetrics — DBIRTH metric names must match what a later DDATA computes for the SAME attribute", function () {
    var rootNode = {
      id: "p1", name: "Plant1",
      effectiveAttributes: [{ name: "Status", value: "OK", valueType: "string", ts: 1 }],
      children: [{
        id: "l1", name: "Line1",
        effectiveAttributes: [],
        children: [{
          id: "m1", name: "Motor1",
          effectiveAttributes: [{ name: "Speed", value: 42.5, valueType: "number", ts: 2 }],
          children: []
        }]
      }]
    };

    it("names a root-level attribute with no prefix", function () {
      var metrics = mapping.collectDeviceMetrics(rootNode);
      var status = metrics.find(function (m) { return m.name === "Status"; });
      should.exist(status);
      status.value.should.equal("OK");
    });

    it("names a deeply-nested attribute with its slash-joined ancestor path", function () {
      var metrics = mapping.collectDeviceMetrics(rootNode);
      var speed = metrics.find(function (m) { return m.name === "Line1/Motor1/Speed"; });
      should.exist(speed);
      speed.value.should.equal(42.5);
      speed.type.should.equal("Double");
    });

    it("a DDATA change on the SAME nested attribute computes the IDENTICAL metric name DBIRTH used", function () {
      // This is the correctness property the whole bridge depends on: a
      // Sparkplug Host Application correlates DDATA back to a metric only
      // BIRTH already declared, by name — if these two ever diverge for the
      // same attribute, the Host silently drops every update for it.
      var dbirthName = mapping.collectDeviceMetrics(rootNode).find(function (m) { return m.value === 42.5; }).name;
      var changePath = "Plant1.Line1.Motor1.Speed"; // the "path" a real asset.subscribe() change carries
      var topName = mapping.topLevelNameFromPath(changePath);
      var ddataName = mapping.relativeMetricNameFromPath(changePath, topName);
      ddataName.should.equal(dbirthName);
    });
  });
});
