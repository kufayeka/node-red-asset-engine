// Pure asset-attribute <-> Sparkplug-metric mapping logic — factored out of
// nodes/sparkplug-edge-node.js so the trickiest part (keeping DBIRTH's metric
// names and a later DDATA's metric names IDENTICAL for the same attribute)
// can be unit-tested directly, without needing to mock an MQTT broker.
const { DataType: SPARKPLUG_DATA_TYPE } = require("./sparkplugCodec");

// Groupings used by coerceValueForSparkplug below to decide what shape of
// JS value to hand sparkplugCodec.js's encodeMetric — the actual bit-level
// work (clamping, LE array packing, DataSet/Template submessages, ...) all
// happens THERE, not in this file; this is just "does the value look like
// a number/array/etc" routing.
var NUMERIC_SPARKPLUG_TYPES = [
  "Int8", "Int16", "Int32", "Int64", "UInt8", "UInt16", "UInt32", "UInt64", "Float", "Double", "DateTime"
];
var ARRAY_SPARKPLUG_TYPES = [
  "Int8Array", "Int16Array", "Int32Array", "Int64Array", "UInt8Array", "UInt16Array", "UInt32Array", "UInt64Array",
  "FloatArray", "DoubleArray", "BooleanArray", "StringArray", "DateTimeArray"
];

// "JsonString" is NOT a real Sparkplug DataType (it has no entry in
// SPARKPLUG_DATA_TYPE/the .proto's enum) — it's an alias attributes can opt
// into so the Attribute Template editor's Default Value (and the Asset
// Manager's live Value editor) default to a JSON-editing widget instead of
// a plain text box, purely for a nicer authoring experience. On the WIRE
// it's indistinguishable from "String" (Sparkplug has no native JSON type);
// coerceValueForSparkplug below is what actually does the
// JSON.stringify/parse round-trip, keyed off the ORIGINAL "JsonString"
// name, not this resolved one.
var SPARKPLUG_TYPE_ALIASES = { JsonString: "String" };

// asset-engine's own attribute valueType -> the Sparkplug DataType to
// publish/expect it as. Accepts EITHER a plain valueType string (legacy
// calling convention, unchanged: "boolean"->Boolean, "number"->Double,
// everything else->String) OR an attribute-like object.
//
// When given an object, an attribute can OPT IN to a SPECIFIC Sparkplug
// DataType (any of the full 1-34 matrix — see the Attribute Template
// editor's "Sparkplug Type" field) via `attr.sparkplugType`, e.g. "Int16",
// "Float", "Bytes", "Int32Array", "DataSet", or the "JsonString" alias
// above. This is checked FIRST and, when set to a recognized name, wins
// outright. Every EXISTING attribute (sparkplugType left blank/unset)
// falls through to the exact same generic boolean/number/other mapping as
// before — this is purely additive, not a change to the asset engine's
// own core type system (valueType/coerceAttributeValue in
// assetDataUtils.js are untouched).
function mapValueTypeToSparkplugType(valueTypeOrAttr) {
  var attr = (valueTypeOrAttr && typeof valueTypeOrAttr === "object") ? valueTypeOrAttr : null;
  var explicit = attr ? attr.sparkplugType : undefined;
  if (explicit && Object.prototype.hasOwnProperty.call(SPARKPLUG_TYPE_ALIASES, explicit)) {
    return SPARKPLUG_TYPE_ALIASES[explicit];
  }
  if (explicit && Object.prototype.hasOwnProperty.call(SPARKPLUG_DATA_TYPE, explicit)) {
    return explicit;
  }
  var valueType = attr ? (attr.valueType || attr.type) : valueTypeOrAttr;
  if (valueType === "boolean") return "Boolean";
  if (valueType === "number") return "Double";
  return "String"; // string, array, object, anything else
}

// `sparkplugType`, when given, is what mapValueTypeToSparkplugType just
// decided for this SAME attribute — used to route a value opted into a
// specific rich type (Int16, Bytes, an array type, DataSet, Template, ...)
// through with minimal reshaping, trusting sparkplugCodec.js's encodeMetric
// to do the real per-type work. Omitted (undefined), this behaves EXACTLY
// as before — every existing call site/attribute is unaffected.
//
// Callers pass the attribute's ORIGINAL `sparkplugType` here (e.g.
// "JsonString"), NOT the wire-resolved name mapValueTypeToSparkplugType
// returns ("String") — this function needs the distinction to know when to
// JSON-stringify; the resolved name is only for the metric's own `type`
// field, sent separately.
function coerceValueForSparkplug(value, valueType, sparkplugType) {
  if (sparkplugType === "JsonString") {
    // A value already stored as JSON-source text (e.g. typed straight into
    // the "json" editor and saved as a raw string) is passed through as-is
    // to avoid double-escaping; anything else (an actual JS object/array/
    // number/etc., e.g. from a calc script) gets stringified.
    if (typeof value === "string") {
      try { JSON.parse(value); return value; } catch (e) { /* not JSON text -- fall through */ }
    }
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  if (sparkplugType && NUMERIC_SPARKPLUG_TYPES.indexOf(sparkplugType) !== -1) {
    return typeof value === "number" ? value : (parseFloat(value) || 0);
  }
  if (sparkplugType === "Boolean") return !!value;
  if (sparkplugType === "Bytes" || sparkplugType === "File") {
    // sparkplugCodec's own toBuffer() already accepts a Buffer, a plain
    // byte array, OR a base64 string — no reshaping needed here. The
    // "weird" types get to stay as whatever the calc script produced,
    // by design.
    return value;
  }
  if (sparkplugType && ARRAY_SPARKPLUG_TYPES.indexOf(sparkplugType) !== -1) {
    return Array.isArray(value) ? value : [];
  }
  if (sparkplugType === "DataSet" || sparkplugType === "Template") {
    return value; // pass the friendly {columns,types,rows}/{metrics,...} shape straight through
  }
  // --- generic fallback: identical to this function's original,
  // pre-opt-in behavior, for every attribute that hasn't set sparkplugType.
  if (valueType === "array" || valueType === "object") {
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  if (valueType === "boolean") return !!value;
  if (valueType === "number") return typeof value === "number" ? value : (parseFloat(value) || 0);
  return value === undefined || value === null ? "" : String(value);
}

function toEpochMs(ts) {
  if (ts === undefined || ts === null) return Date.now();
  var n = new Date(ts).getTime();
  return isNaN(n) ? Date.now() : n;
}

// Builds a metric's `properties` bag (custom key/value metadata, spec
// §3.1.4) from whatever engineering-metadata fields the attribute happens
// to have set — every one of these is optional/nullable, so an attribute
// that hasn't configured any of them (the overwhelming majority, today)
// produces no `properties` at all, identical to before this existed.
// `engUnit`/`engHigh`/`engLow` are the Ignition/Cirrus Link convention
// (NOT part of the Sparkplug spec itself, which defines no standard
// property names — see this repo's SPARKPLUG.md); `Deadband` is included
// mainly for THIS project's own future historian to read back (a
// swinging-door/exception-based compression threshold), not because any
// Host Application is known to require it.
function buildSparkplugProperties(attr) {
  var props = {};
  if (attr.unit) props.engUnit = attr.unit;
  if (typeof attr.numberMax === "number") props.engHigh = attr.numberMax;
  if (typeof attr.numberMin === "number") props.engLow = attr.numberMin;
  if (typeof attr.deadband === "number") props.Deadband = attr.deadband;
  return Object.keys(props).length ? props : undefined;
}

// `metadata.description` is spec-NATIVE (unlike `properties`, above) — see
// sparkplugCodec.js's own comment on MetaData vs PropertySet.
function buildSparkplugMetadata(attr) {
  return attr.description ? { description: attr.description } : undefined;
}

// One `effectiveAttributes[]` entry (from asset.getHierarchy) or one
// `meta.change.changes[]` entry (from asset.subscribe) -> one Sparkplug
// metric, at the given (already device-relative) metric name.
function toSparkplugMetric(attr, relativeName) {
  var valueType = attr.valueType || attr.type; // getHierarchy calls it valueType, change events call it type
  // Passing the whole `attr` (not just valueType) is what lets an
  // attribute opt into a specific Sparkplug DataType via its own
  // `sparkplugType` field — see mapValueTypeToSparkplugType's own comment.
  var sparkplugType = mapValueTypeToSparkplugType(attr);
  var properties = buildSparkplugProperties(attr);
  var metadata = buildSparkplugMetadata(attr);
  // [tck-id-operational-behavior-data-publish-nbirth-values]: a metric with
  // no real value yet MUST be flagged isNull=true, not coerced into a fake
  // ""/0/false — see sparkplugCodec's encodeMetric, which omits the value
  // field entirely for these. Checked BEFORE coerceValueForSparkplug, which
  // would otherwise silently manufacture one of those fake defaults.
  if (attr.value === undefined || attr.value === null) {
    var nullMetric = { name: relativeName, type: sparkplugType, isNull: true, timestamp: toEpochMs(attr.ts) };
    if (properties) nullMetric.properties = properties;
    if (metadata) nullMetric.metadata = metadata;
    return nullMetric;
  }
  var metric = {
    name: relativeName,
    type: sparkplugType,
    // The attribute's OWN (unresolved) sparkplugType, e.g. "JsonString" —
    // NOT the wire-resolved `sparkplugType` above ("String") — is what
    // coerceValueForSparkplug needs to decide whether to JSON-stringify;
    // for every other attribute the two are identical, so this changes
    // nothing for them.
    value: coerceValueForSparkplug(attr.value, valueType, attr.sparkplugType || sparkplugType),
    timestamp: toEpochMs(attr.ts)
  };
  if (properties) metric.properties = properties;
  if (metadata) metric.metadata = metadata;
  return metric;
}

// The FIRST dot-segment of an asset path is always the top-level (root)
// asset's own name — this and relativeMetricNameFromPath must stay exact
// inverses of collectDeviceMetrics' own path-building below, or a DDATA's
// metric names would silently stop matching what DBIRTH already declared
// for them (a real Sparkplug Host Application keys off metric name/alias
// established at birth, so a name mismatch is a bug, not cosmetic).
function topLevelNameFromPath(path) {
  var idx = path.indexOf(".");
  return idx === -1 ? path : path.substring(0, idx);
}

function relativeMetricNameFromPath(path, topLevelName) {
  var rest = path.length > topLevelName.length ? path.slice(topLevelName.length + 1) : "";
  return rest.split(".").join("/");
}

// Walks one getHierarchy() root node (a top-level asset == one Sparkplug
// Device) into a flat metrics list for its DBIRTH, using the SAME
// dot-to-slash relative naming relativeMetricNameFromPath produces for a
// later DDATA — e.g. asset "Plant1" > "Line1" > "Motor1" attribute "Speed"
// becomes metric "Line1/Motor1/Speed" under Device "Plant1" either way.
function collectDeviceMetrics(rootNode) {
  var metrics = [];
  function walk(node, prefixParts) {
    (node.effectiveAttributes || []).forEach(function (attr) {
      var relName = prefixParts.concat([attr.name]).join("/");
      metrics.push(toSparkplugMetric(attr, relName));
    });
    (node.children || []).forEach(function (child) {
      walk(child, prefixParts.concat([child.name]));
    });
  }
  walk(rootNode, []);
  return metrics;
}

module.exports = {
  mapValueTypeToSparkplugType: mapValueTypeToSparkplugType,
  coerceValueForSparkplug: coerceValueForSparkplug,
  buildSparkplugProperties: buildSparkplugProperties,
  buildSparkplugMetadata: buildSparkplugMetadata,
  toEpochMs: toEpochMs,
  toSparkplugMetric: toSparkplugMetric,
  topLevelNameFromPath: topLevelNameFromPath,
  relativeMetricNameFromPath: relativeMetricNameFromPath,
  collectDeviceMetrics: collectDeviceMetrics
};
