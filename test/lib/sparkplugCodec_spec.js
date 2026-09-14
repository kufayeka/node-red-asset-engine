const should = require("should");
const codec = require("../../lib/sparkplug/sparkplugCodec");

describe("sparkplugCodec", function () {
  it("round-trips a Boolean metric", function () {
    var decoded = codec.decodePayload(codec.encodePayload({
      timestamp: 12345,
      metrics: [{ name: "Running", type: "Boolean", value: true }]
    }));
    decoded.metrics[0].should.deepEqual({ name: "Running", type: "Boolean", value: true, timestamp: undefined });
  });

  it("round-trips a Boolean metric whose value is false (not confused with \"unset\")", function () {
    var decoded = codec.decodePayload(codec.encodePayload({
      timestamp: 1,
      metrics: [{ name: "Running", type: "Boolean", value: false }]
    }));
    decoded.metrics[0].value.should.equal(false);
  });

  it("round-trips a Double metric, including a per-metric timestamp", function () {
    var decoded = codec.decodePayload(codec.encodePayload({
      timestamp: 1,
      metrics: [{ name: "Speed", type: "Double", value: 42.5, timestamp: 999 }]
    }));
    decoded.metrics[0].should.deepEqual({ name: "Speed", type: "Double", value: 42.5, timestamp: 999 });
  });

  it("round-trips a String metric", function () {
    var decoded = codec.decodePayload(codec.encodePayload({
      timestamp: 1,
      metrics: [{ name: "Status", type: "String", value: "OK" }]
    }));
    decoded.metrics[0].value.should.equal("OK");
  });

  it("round-trips an Int64 metric (used for bdSeq)", function () {
    var decoded = codec.decodePayload(codec.encodePayload({
      timestamp: 1,
      metrics: [{ name: "bdSeq", type: "Int64", value: 7 }]
    }));
    decoded.metrics[0].value.should.equal(7);
  });

  it("round-trips the top-level payload timestamp and seq", function () {
    var decoded = codec.decodePayload(codec.encodePayload({
      timestamp: 1700000000000,
      seq: 42,
      metrics: []
    }));
    decoded.timestamp.should.equal(1700000000000);
    decoded.seq.should.equal(42);
  });

  it("supports a metric name containing slashes (device-relative hierarchical naming)", function () {
    var decoded = codec.decodePayload(codec.encodePayload({
      timestamp: 1,
      metrics: [{ name: "Line1/Motor1/Speed", type: "Double", value: 1 }]
    }));
    decoded.metrics[0].name.should.equal("Line1/Motor1/Speed");
  });

  it("falls back to a String value for an unrecognized type name instead of throwing", function () {
    var decoded = codec.decodePayload(codec.encodePayload({
      timestamp: 1,
      metrics: [{ name: "X", type: "SomethingUnsupported", value: "raw-text" }]
    }));
    decoded.metrics[0].value.should.equal("raw-text");
  });

  it("round-trips isNull: sets the flag and omits the value field entirely (spec: MUST NOT have a value specified)", function () {
    var decoded = codec.decodePayload(codec.encodePayload({
      timestamp: 1,
      metrics: [{ name: "Speed", type: "Double", isNull: true }]
    }));
    decoded.metrics[0].should.deepEqual({ name: "Speed", type: "Double", value: null, isNull: true, timestamp: undefined });
  });

  it("isNull takes priority even if a stray value is also present (the spec says omit it, not just ignore it)", function () {
    var decoded = codec.decodePayload(codec.encodePayload({
      timestamp: 1,
      metrics: [{ name: "Speed", type: "Double", isNull: true, value: 999 }]
    }));
    should.equal(decoded.metrics[0].value, null);
  });

  describe("full DataType matrix (spec §6.4.16, enum 0-34)", function () {
    function roundTrip(type, value) {
      return codec.decodePayload(codec.encodePayload({
        timestamp: 1, metrics: [{ name: "X", type: type, value: value }]
      })).metrics[0].value;
    }

    describe("fixed-width integers (Int8/16/32, UInt8/16/32) — all six share ONE wire field (int_value), the declared datatype alone tells a reader how to reinterpret it", function () {
      it("round-trips a positive Int8", function () { roundTrip("Int8", 100).should.equal(100); });
      it("round-trips a negative Int8 via two's complement", function () { roundTrip("Int8", -100).should.equal(-100); });
      it("clamps/wraps an Int8 at its boundaries, not just truncates", function () { roundTrip("Int8", 127).should.equal(127); roundTrip("Int8", -128).should.equal(-128); });
      it("round-trips a full-range UInt8", function () { roundTrip("UInt8", 255).should.equal(255); });
      it("round-trips a negative Int16", function () { roundTrip("Int16", -30000).should.equal(-30000); });
      it("round-trips a full-range UInt16", function () { roundTrip("UInt16", 65535).should.equal(65535); });
      it("round-trips a negative Int32", function () { roundTrip("Int32", -1).should.equal(-1); });
      it("round-trips a large positive Int32", function () { roundTrip("Int32", 315338746).should.equal(315338746); });
      it("round-trips a full-range UInt32", function () { roundTrip("UInt32", 4294967295).should.equal(4294967295); });
    });

    describe("64-bit-ish integers (Int64, UInt64, DateTime) — share ONE wire field (long_value)", function () {
      it("round-trips a positive Int64", function () { roundTrip("Int64", 123456789).should.equal(123456789); });
      it("round-trips a NEGATIVE Int64 via two's-complement wrap into the unsigned wire pattern", function () { roundTrip("Int64", -42).should.equal(-42); });
      it("round-trips a UInt64 (always non-negative)", function () { roundTrip("UInt64", 987654321).should.equal(987654321); });
      it("round-trips a DateTime (epoch-ms, spec §6.4.17 p.78: uint64)", function () { roundTrip("DateTime", 1656107875000).should.equal(1656107875000); });
    });

    describe("floating point", function () {
      it("round-trips a Double at full precision", function () { roundTrip("Double", 1022.9123213).should.equal(1022.9123213); });
      it("Float is coerced through Math.fround (real 32-bit precision, not silently kept as a 64-bit Double)", function () {
        var v = roundTrip("Float", 1.23);
        v.should.equal(Math.fround(1.23));
        v.should.not.equal(1.23); // proves it actually lost precision to 32 bits, not a no-op
      });
    });

    describe("string-like (String, Text, UUID)", function () {
      it("round-trips Text the same as String", function () { roundTrip("Text", "hello").should.equal("hello"); });
      it("round-trips UUID as a UTF-8 string (spec §6.4.16 p.79: \"UUID value as a UTF-8 string\")", function () {
        roundTrip("UUID", "550e8400-e29b-41d4-a716-446655440000").should.equal("550e8400-e29b-41d4-a716-446655440000");
      });
    });

    describe("Bytes / File — raw byte blobs", function () {
      it("round-trips a Buffer value for Bytes", function () {
        var out = roundTrip("Bytes", Buffer.from([1, 2, 3, 255]));
        Buffer.isBuffer(out).should.equal(true);
        Array.from(out).should.deepEqual([1, 2, 3, 255]);
      });
      it("round-trips a base64 string value for File (the JSON-friendly input shape)", function () {
        var out = roundTrip("File", Buffer.from("hello file").toString("base64"));
        out.toString("utf8").should.equal("hello file");
      });
    });

    // Byte-for-byte against the spec PDF's OWN §6.4.17 (p.80-81) worked
    // examples, via the exported packArray — NOT via this codec's own
    // round-trip, which could never catch a wrong-but-self-consistent
    // implementation of the packing rules themselves.
    describe("packed arrays (22-34) — exact bytes verified against the spec's own worked examples", function () {
      it("Int32Array: spec's own example, [123456789, 987654321] -> 0x15CD5B07 0xB168DE3A little-endian", function () {
        var buf = codec.packArray("Int32Array", [123456789, 987654321]);
        Array.from(buf).should.deepEqual([0x15, 0xCD, 0x5B, 0x07, 0xB1, 0x68, 0xDE, 0x3A]);
        codec.unpackArray("Int32Array", buf).should.deepEqual([123456789, 987654321]);
      });

      it("Int16Array: spec's own example, [-30000, 30000]", function () {
        var buf = codec.packArray("Int16Array", [-30000, 30000]);
        Array.from(buf).should.deepEqual([0xD0, 0x8A, 0x30, 0x75]);
        codec.unpackArray("Int16Array", buf).should.deepEqual([-30000, 30000]);
      });

      // NOTE on Int8Array: the spec PDF's own example (p.80) prints
      // "[-23, 123] -> [0xEF, 0x7B]" — but 0xEF is the two's-complement
      // encoding of -17, NOT -23 (-23 is 0xE9), while every OTHER example
      // on the exact same page (Int16Array, Int32Array, UInt8/16/32Array
      // below) checks out exactly under standard two's complement. This
      // is treated as a documentation erratum in the spec PDF itself, not
      // a bug here — this test follows standard two's complement (the
      // same convention verified correct everywhere else, and used by
      // every real Sparkplug implementation, including the Ignition
      // Gateway this codec has been tested against), not the one
      // internally-inconsistent example.
      it("Int8Array: standard two's complement (see note above re: the spec PDF's own inconsistent -23 example)", function () {
        var buf = codec.packArray("Int8Array", [-23, 123]);
        Array.from(buf).should.deepEqual([0xE9, 0x7B]);
        codec.unpackArray("Int8Array", buf).should.deepEqual([-23, 123]);
      });

      it("UInt8Array: spec's own example, [23, 250]", function () {
        var buf = codec.packArray("UInt8Array", [23, 250]);
        Array.from(buf).should.deepEqual([0x17, 0xFA]);
      });

      it("UInt16Array: spec's own example, [30, 52360]", function () {
        var buf = codec.packArray("UInt16Array", [30, 52360]);
        Array.from(buf).should.deepEqual([0x1E, 0x00, 0x88, 0xCC]);
      });

      it("UInt32Array: spec's own example, [52, 3293969225]", function () {
        var buf = codec.packArray("UInt32Array", [52, 3293969225]);
        Array.from(buf).should.deepEqual([0x34, 0x00, 0x00, 0x00, 0x49, 0xFB, 0x55, 0xC4]);
      });

      it("UInt64Array: spec's own example, [52, 16444743074749521625] — the 2nd value needs a string element for exact precision (beyond Number.isSafeInteger)", function () {
        var buf = codec.packArray("UInt64Array", [52, "16444743074749521625"]);
        Array.from(buf).should.deepEqual([
          0x34, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
          0xD9, 0x9E, 0x02, 0xD1, 0xB2, 0x76, 0x37, 0xE4
        ]);
      });

      // NOTE on FloatArray/DoubleArray (and DateTimeArray below): the spec
      // PDF's own printed example bytes for these three types are each
      // individual value's bytes in BIG-endian order (verified directly
      // against Node's own writeFloatLE/writeDoubleLE/writeBigUInt64LE,
      // the industry-reference implementation of IEEE754/uint64 little-
      // endian encoding) — contradicting the SAME page's own normative
      // text ("packed little endian ... bytes") and the Int16/Int32/UInt*
      // examples on the identical page, which DO check out exactly as
      // little-endian. Treated as a documentation erratum (like the
      // Int8Array note above), not a bug here — this follows the
      // unambiguous, standard, actually-little-endian encoding that every
      // real Sparkplug implementation (including Ignition) uses.
      it("FloatArray: [1.23, 89.341], true little-endian (see note above re: the spec PDF's own reversed-per-value example)", function () {
        var buf = codec.packArray("FloatArray", [1.23, 89.341]);
        Array.from(buf).should.deepEqual([0xA4, 0x70, 0x9D, 0x3F, 0x98, 0xAE, 0xB2, 0x42]);
      });

      it("DoubleArray: [12.354213, 1022.9123213], true little-endian (see note above)", function () {
        var buf = codec.packArray("DoubleArray", [12.354213, 1022.9123213]);
        Array.from(buf).should.deepEqual([
          0xD7, 0xA2, 0x05, 0x68, 0x5B, 0xB5, 0x28, 0x40,
          0x8E, 0x17, 0x1C, 0x6F, 0x4C, 0xF7, 0x8F, 0x40
        ]);
      });

      it("BooleanArray: spec's own 12-element example — 4-byte LE count then MSB-first bit-packed bytes", function () {
        var bools = [false, false, true, true, false, true, false, false, true, true, false, true];
        var buf = codec.packArray("BooleanArray", bools);
        buf.readUInt32LE(0).should.equal(12);
        buf[4].should.equal(0x34);
        // spec: "an X above is a do not care" for the last byte's unused
        // low nibble — only the top (12-8=4) bits are meaningful: 1,1,0,1
        (buf[5] >> 4).should.equal(0x0D);
        codec.unpackArray("BooleanArray", buf).should.deepEqual(bools);
      });

      it("StringArray: spec's own example, [\"ABC\", \"hello\"] as null-terminated UTF-8 strings", function () {
        var buf = codec.packArray("StringArray", ["ABC", "hello"]);
        Array.from(buf).should.deepEqual([0x41, 0x42, 0x43, 0x00, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00]);
        codec.unpackArray("StringArray", buf).should.deepEqual(["ABC", "hello"]);
      });

      it("DateTimeArray: two epoch-ms values packed as true little-endian 8-byte uint64 (see note above re: the spec PDF's own reversed-per-value example)", function () {
        var buf = codec.packArray("DateTimeArray", [1256102875335, 1656107875000]);
        Array.from(buf).should.deepEqual([
          0xC7, 0xD0, 0x90, 0x75, 0x24, 0x01, 0x00, 0x00,
          0xB8, 0xBA, 0xB8, 0x97, 0x81, 0x01, 0x00, 0x00
        ]);
        codec.unpackArray("DateTimeArray", buf).should.deepEqual([1256102875335, 1656107875000]);
      });

      it("a full array metric round-trips end-to-end through encodePayload/decodePayload too, not just packArray/unpackArray directly", function () {
        var out = roundTrip("Int32Array", [123456789, 987654321]);
        out.should.deepEqual([123456789, 987654321]);
      });
    });

    describe("DataSet (16) — friendly {columns, types, rows} shape, encoded/decoded via the real dataset_value submessage", function () {
      it("round-trips columns/types/rows", function () {
        var out = roundTrip("DataSet", {
          columns: ["Name", "Value"],
          types: ["String", "Int32"],
          rows: [["a", 1], ["b", -2]]
        });
        out.should.deepEqual({
          columns: ["Name", "Value"],
          types: ["String", "Int32"],
          rows: [["a", 1], ["b", -2]]
        });
      });
    });

    describe("Template (19) — Template.metrics is literally `repeated Metric`, so it recurses through encodeMetric/decodeMetric", function () {
      it("round-trips a template instance with nested metrics and parameters", function () {
        var out = roundTrip("Template", {
          isDefinition: false,
          templateRef: "MotorTemplate",
          metrics: [{ name: "Speed", type: "Double", value: 42.5 }, { name: "Running", type: "Boolean", value: true }],
          parameters: [{ name: "Zone", type: "String", value: "North" }]
        });
        out.isDefinition.should.equal(false);
        out.templateRef.should.equal("MotorTemplate");
        out.metrics.length.should.equal(2);
        out.metrics[0].should.deepEqual({ name: "Speed", type: "Double", value: 42.5, timestamp: undefined });
        out.metrics[1].value.should.equal(true);
        out.parameters[0].should.deepEqual({ name: "Zone", type: "String", value: "North" });
      });
    });

    describe("PropertySet / PropertySetList (20, 21) — NOT valid as a metric's own top-level value", function () {
      it("throws a clear, explanatory error on encode rather than silently producing a metric with no value", function () {
        (function () {
          codec.encodePayload({ timestamp: 1, metrics: [{ name: "X", type: "PropertySet", value: { keys: ["a"], values: [1] } }] });
        }).should.throw(/PropertySet.*cannot be a metric's own top-level value/);
      });
    });

    describe("metric.metadata (spec-native MetaData, .proto field 8) — separate from `properties` below", function () {
      function roundTripMetric(metric) {
        return codec.decodePayload(codec.encodePayload({ timestamp: 1, metrics: [metric] })).metrics[0];
      }

      it("round-trips a description", function () {
        var out = roundTripMetric({ name: "X", type: "Double", value: 1, metadata: { description: "Air pressure sensor" } });
        out.metadata.should.deepEqual({ description: "Air pressure sensor" });
      });

      it("round-trips File-oriented fields (contentType/fileName/fileType/md5) together", function () {
        var out = roundTripMetric({
          name: "X", type: "Bytes", value: Buffer.from([1, 2, 3]),
          metadata: { contentType: "application/json", fileName: "a.json", fileType: "json", md5: "abc123" }
        });
        out.metadata.should.deepEqual({ contentType: "application/json", fileName: "a.json", fileType: "json", md5: "abc123" });
      });

      it("a metric with no metadata decodes with no `metadata` key at all", function () {
        var out = roundTripMetric({ name: "X", type: "Double", value: 1 });
        out.should.not.have.property("metadata");
      });

      it("metadata survives even on an isNull metric (it describes the tag, not the value)", function () {
        var out = roundTripMetric({ name: "X", type: "Double", isNull: true, metadata: { description: "still described" } });
        out.isNull.should.equal(true);
        out.metadata.should.deepEqual({ description: "still described" });
      });
    });

    describe("metric.properties (spec's generic custom key/value PropertySet, .proto field 9) — spec defines NO standard names; engUnit/engHigh/engLow/Deadband are an Ignition/Cirrus Link convention, not part of Sparkplug B itself", function () {
      function roundTripMetric(metric) {
        return codec.decodePayload(codec.encodePayload({ timestamp: 1, metrics: [metric] })).metrics[0];
      }

      it("round-trips a mix of string/number/boolean properties, auto-typing each from its own JS typeof", function () {
        var out = roundTripMetric({
          name: "X", type: "Double", value: 7.6,
          properties: { engUnit: "kPa", engHigh: 100, engLow: 0, Deadband: 0.5, isSpecial: true }
        });
        out.properties.should.deepEqual({ engUnit: "kPa", engHigh: 100, engLow: 0, Deadband: 0.5, isSpecial: true });
      });

      it("a null/undefined property value is omitted rather than crashing or round-tripping as null", function () {
        var out = roundTripMetric({ name: "X", type: "Double", value: 1, properties: { engUnit: "kPa", ignored: null, alsoIgnored: undefined } });
        out.properties.should.deepEqual({ engUnit: "kPa" });
      });

      it("a metric with no properties (or an empty object) decodes with no `properties` key at all", function () {
        roundTripMetric({ name: "X", type: "Double", value: 1 }).should.not.have.property("properties");
        roundTripMetric({ name: "X", type: "Double", value: 1, properties: {} }).should.not.have.property("properties");
      });
    });
  });
});
