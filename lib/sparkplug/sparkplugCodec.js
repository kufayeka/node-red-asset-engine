// Minimal Sparkplug B payload codec — loads the OFFICIAL sparkplug_b.proto
// schema (verbatim from Eclipse Tahu, see sparkplug_b.proto in this same
// directory) via `protobufjs`, instead of depending on the "sparkplug-payload"
// npm package: that package pulls in a long-unpatched protobufjs (<=7.6.2)
// carrying several open CRITICAL CVEs (prototype pollution, code injection,
// DoS via crafted input — see this package's package.json) with no fix
// available from its maintainer. Since this codec decodes payloads arriving
// over the network (from whatever else publishes onto the Sparkplug MQTT
// bus), building on a patched, current protobufjs instead is a real security
// requirement here, not just a preference.
//
// Only a practical SUBSET of Sparkplug's DataType matrix is implemented —
// the asset engine's own attribute type system is just
// boolean|string|number|array|object, so only Boolean/String/Double (plus
// Int64 for the protocol's own bdSeq/seq bookkeeping) are ever actually
// produced here. An unrecognized incoming datatype falls back to its raw
// string value rather than throwing, so a message from some OTHER Sparkplug
// participant using a richer type (Template, DataSet, ...) is still readable
// as text instead of crashing the decoder.
const path = require("path");
const protobuf = require("protobufjs");

const root = protobuf.loadSync(path.join(__dirname, "sparkplug_b.proto"));
const PayloadType = root.lookupType("org.eclipse.tahu.protobuf.Payload");

const DataType = {
  Int8: 1, Int16: 2, Int32: 3, Int64: 4, UInt8: 5, UInt16: 6, UInt32: 7, UInt64: 8,
  Float: 9, Double: 10, Boolean: 11, String: 12, DateTime: 13, Text: 14
};
const DATA_TYPE_NAME_BY_NUMBER = Object.keys(DataType).reduce(function (acc, name) {
  acc[DataType[name]] = name;
  return acc;
}, {});

const INT_LIKE_TYPES = [DataType.Int8, DataType.Int16, DataType.Int32, DataType.UInt8, DataType.UInt16, DataType.UInt32];
const LONG_LIKE_TYPES = [DataType.Int64, DataType.UInt64, DataType.DateTime];

function encodeMetric(metric) {
  var typeName = metric.type || "String";
  var datatype = Object.prototype.hasOwnProperty.call(DataType, typeName) ? DataType[typeName] : DataType.String;
  var raw = { name: metric.name, datatype: datatype };
  if (metric.timestamp !== undefined && metric.timestamp !== null) raw.timestamp = metric.timestamp;

  // [tck-id-operational-behavior-data-publish-nbirth-values] (and the
  // DBIRTH/NDATA/DDATA equivalents): a metric whose value is genuinely
  // null/missing MUST set isNull=true and MUST NOT have a value field at
  // all — NOT a fake ""/0/false standing in for "no value". Coercing null
  // into a fake default (this codec's own earlier behavior) is exactly the
  // kind of thing that makes a Host Application unable to tell "the value
  // really is zero" apart from "there is no value yet".
  if (metric.isNull) {
    raw.isNull = true;
    return raw;
  }

  // protobufjs auto-camelCases the .proto's snake_case field names
  // (double_value -> doubleValue) — Type.create() silently drops any key
  // that doesn't match, so using the .proto's own spelling here would
  // silently encode every metric with NO value at all (caught by this
  // codec's own round-trip smoke test, not by verify()/create() erroring).
  if (datatype === DataType.Boolean) {
    raw.booleanValue = !!metric.value;
  } else if (INT_LIKE_TYPES.indexOf(datatype) !== -1) {
    raw.intValue = metric.value >>> 0;
  } else if (LONG_LIKE_TYPES.indexOf(datatype) !== -1) {
    raw.longValue = metric.value;
  } else if (datatype === DataType.Float) {
    raw.floatValue = metric.value;
  } else if (datatype === DataType.Double) {
    raw.doubleValue = metric.value;
  } else {
    // String, Text, and anything else this codec doesn't model explicitly.
    raw.stringValue = metric.value === undefined || metric.value === null ? "" : String(metric.value);
  }
  return raw;
}

function decodeMetric(raw) {
  var datatype = raw.datatype;
  var typeName = DATA_TYPE_NAME_BY_NUMBER[datatype] || "String";
  if (raw.isNull) {
    return { name: raw.name, type: typeName, value: null, isNull: true, timestamp: raw.timestamp };
  }
  var value;
  if (datatype === DataType.Boolean) {
    value = !!raw.booleanValue;
  } else if (INT_LIKE_TYPES.indexOf(datatype) !== -1) {
    value = raw.intValue;
  } else if (LONG_LIKE_TYPES.indexOf(datatype) !== -1) {
    value = raw.longValue; // already a plain Number — see decodePayload's {longs: Number}
  } else if (datatype === DataType.Float) {
    value = raw.floatValue;
  } else if (datatype === DataType.Double) {
    value = raw.doubleValue;
  } else {
    value = raw.stringValue;
  }
  return { name: raw.name, type: typeName, value: value, timestamp: raw.timestamp };
}

// `payload`: { timestamp, seq?, metrics: [{name, value, type, timestamp?}] }
function encodePayload(payload) {
  var raw = {
    timestamp: payload.timestamp,
    metrics: (payload.metrics || []).map(encodeMetric)
  };
  if (payload.seq !== undefined && payload.seq !== null) raw.seq = payload.seq;
  var errMsg = PayloadType.verify(raw);
  if (errMsg) throw new Error("Invalid Sparkplug payload: " + errMsg);
  var message = PayloadType.create(raw);
  return PayloadType.encode(message).finish();
}

// Returns { timestamp, seq, metrics: [{name, value, type, timestamp}] }
function decodePayload(buffer) {
  var message = PayloadType.decode(buffer);
  // {longs: Number} converts every int64/uint64 field (timestamp, seq,
  // long_value, ...) straight to a plain JS Number — safe here since every
  // value this codec ever actually carries (epoch-ms timestamps, small
  // sequence counters) is well within Number.isSafeInteger range. Deliberately
  // NOT {defaults: true}: an optional field that was never actually set (e.g.
  // no per-metric timestamp) should come back as undefined, not a fake
  // zero-value default indistinguishable from "really is 0".
  var obj = PayloadType.toObject(message, { longs: Number });
  return {
    timestamp: obj.timestamp,
    seq: obj.seq,
    metrics: (obj.metrics || []).map(decodeMetric)
  };
}

module.exports = { encodePayload: encodePayload, decodePayload: decodePayload, DataType: DataType };
