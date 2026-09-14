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

  describe("opt-in sparkplugType (attribute declares a SPECIFIC Sparkplug DataType, 1-34)", function () {
    it("an attribute's own sparkplugType wins over the generic valueType-based mapping", function () {
      mapping.mapValueTypeToSparkplugType({ valueType: "number", sparkplugType: "Int16" }).should.equal("Int16");
      mapping.mapValueTypeToSparkplugType({ valueType: "number", sparkplugType: "Float" }).should.equal("Float");
      mapping.mapValueTypeToSparkplugType({ valueType: "array", sparkplugType: "Int32Array" }).should.equal("Int32Array");
    });

    it("an unrecognized sparkplugType name is ignored, falling back to the generic mapping (never publishes a bogus type name)", function () {
      mapping.mapValueTypeToSparkplugType({ valueType: "number", sparkplugType: "NotARealType" }).should.equal("Double");
    });

    it("a blank/unset sparkplugType behaves exactly like the legacy string-only calling convention", function () {
      mapping.mapValueTypeToSparkplugType({ valueType: "boolean" }).should.equal("Boolean");
      mapping.mapValueTypeToSparkplugType({ valueType: "string" }).should.equal("String");
    });

    it("toSparkplugMetric passes numeric opt-in types through as a plain number, letting sparkplugCodec do the real clamping", function () {
      var m = mapping.toSparkplugMetric({ value: -5, valueType: "number", sparkplugType: "Int8", ts: 1 }, "Delta");
      m.should.deepEqual({ name: "Delta", type: "Int8", value: -5, timestamp: 1 });
    });

    it("toSparkplugMetric passes an array opt-in type through as-is", function () {
      var m = mapping.toSparkplugMetric({ value: [1, 2, 3], valueType: "array", sparkplugType: "Int32Array", ts: 1 }, "Samples");
      m.type.should.equal("Int32Array");
      m.value.should.deepEqual([1, 2, 3]);
    });

    it("toSparkplugMetric passes a Bytes opt-in type's value through untouched (Buffer, base64 string, or byte array — sparkplugCodec's own toBuffer() accepts all three)", function () {
      var m = mapping.toSparkplugMetric({ value: "aGVsbG8=", valueType: "string", sparkplugType: "Bytes", ts: 1 }, "Blob");
      m.type.should.equal("Bytes");
      m.value.should.equal("aGVsbG8=");
    });

    it("toSparkplugMetric passes a DataSet opt-in type's friendly {columns,types,rows} value through untouched", function () {
      var shape = { columns: ["a"], types: ["Int32"], rows: [[1]] };
      var m = mapping.toSparkplugMetric({ value: shape, valueType: "object", sparkplugType: "DataSet", ts: 1 }, "Table");
      m.type.should.equal("DataSet");
      m.value.should.equal(shape);
    });

    it("isNull still short-circuits BEFORE any opt-in-type coercion, same as the generic path", function () {
      var m = mapping.toSparkplugMetric({ value: null, valueType: "number", sparkplugType: "Int32", ts: 1 }, "X");
      m.should.deepEqual({ name: "X", type: "Int32", isNull: true, timestamp: 1 });
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

  describe("\"JsonString\" — a wire-alias of \"String\", not a real Sparkplug DataType", function () {
    it("mapValueTypeToSparkplugType resolves it to the real wire type \"String\"", function () {
      mapping.mapValueTypeToSparkplugType({ valueType: "object", sparkplugType: "JsonString" }).should.equal("String");
    });

    it("coerceValueForSparkplug JSON.stringifies a plain JS object/array value", function () {
      mapping.coerceValueForSparkplug({ a: 1 }, "object", "JsonString").should.equal(JSON.stringify({ a: 1 }));
      mapping.coerceValueForSparkplug([1, 2, 3], "array", "JsonString").should.equal(JSON.stringify([1, 2, 3]));
    });

    it("coerceValueForSparkplug passes already-JSON-text through unchanged (no double-escaping)", function () {
      var text = JSON.stringify({ a: 1 });
      mapping.coerceValueForSparkplug(text, "string", "JsonString").should.equal(text);
    });

    it("coerceValueForSparkplug stringifies a plain (non-JSON) string too", function () {
      mapping.coerceValueForSparkplug("hello", "string", "JsonString").should.equal(JSON.stringify("hello"));
    });

    it("toSparkplugMetric publishes type \"String\" with a JSON-stringified value, for an attribute opted into JsonString", function () {
      var metric = mapping.toSparkplugMetric({ name: "Config", value: { retries: 3 }, valueType: "object", sparkplugType: "JsonString", ts: 1 }, "Config");
      metric.type.should.equal("String");
      metric.value.should.equal(JSON.stringify({ retries: 3 }));
    });
  });

  describe("buildSparkplugProperties / buildSparkplugMetadata — engineering metadata, all optional", function () {
    it("builds engUnit/engHigh/engLow/Deadband only from whatever the attribute actually has set", function () {
      mapping.buildSparkplugProperties({ unit: "kPa", numberMax: 100, numberMin: 0, deadband: 0.5 })
        .should.deepEqual({ engUnit: "kPa", engHigh: 100, engLow: 0, Deadband: 0.5 });
    });

    it("returns undefined (no `properties` at all) when nothing is set", function () {
      should.not.exist(mapping.buildSparkplugProperties({}));
    });

    it("omits individual keys whose source field is null/blank rather than publishing a fake zero/empty", function () {
      mapping.buildSparkplugProperties({ unit: "", numberMax: 100, numberMin: null, deadband: null })
        .should.deepEqual({ engHigh: 100 });
    });

    it("buildSparkplugMetadata builds {description} only when the attribute has one, else undefined", function () {
      mapping.buildSparkplugMetadata({ description: "Air pressure sensor" }).should.deepEqual({ description: "Air pressure sensor" });
      should.not.exist(mapping.buildSparkplugMetadata({ description: "" }));
      should.not.exist(mapping.buildSparkplugMetadata({}));
    });

    it("toSparkplugMetric attaches properties/metadata onto the metric only when present", function () {
      var withBoth = mapping.toSparkplugMetric({ name: "P", value: 7.6, valueType: "number", unit: "kPa", numberMax: 100, numberMin: 0, description: "desc", ts: 1 }, "P");
      withBoth.properties.should.deepEqual({ engUnit: "kPa", engHigh: 100, engLow: 0 });
      withBoth.metadata.should.deepEqual({ description: "desc" });

      var withNeither = mapping.toSparkplugMetric({ name: "Q", value: 1, valueType: "number", ts: 1 }, "Q");
      withNeither.should.not.have.property("properties");
      withNeither.should.not.have.property("metadata");
    });

    it("properties/metadata are attached even on an isNull metric", function () {
      var metric = mapping.toSparkplugMetric({ name: "P", value: null, valueType: "number", unit: "kPa", ts: 1 }, "P");
      metric.isNull.should.equal(true);
      metric.properties.should.deepEqual({ engUnit: "kPa" });
    });
  });
});
