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
});
