// Pure asset-attribute <-> Sparkplug-metric mapping logic — factored out of
// nodes/sparkplug-edge-node.js so the trickiest part (keeping DBIRTH's metric
// names and a later DDATA's metric names IDENTICAL for the same attribute)
// can be unit-tested directly, without needing to mock an MQTT broker.

// asset-engine's own attribute valueType -> the Sparkplug DataType this
// codec actually supports (see sparkplugCodec.js's own comment on why the
// full 34-entry DataType matrix isn't implemented). array/object values are
// JSON-stringified rather than mapped to Sparkplug's DataSet/Template types —
// a real structural mapping is future work, not needed for v1.
function mapValueTypeToSparkplugType(valueType) {
  if (valueType === "boolean") return "Boolean";
  if (valueType === "number") return "Double";
  return "String"; // string, array, object, anything else
}

function coerceValueForSparkplug(value, valueType) {
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

// One `effectiveAttributes[]` entry (from asset.getHierarchy) or one
// `meta.change.changes[]` entry (from asset.subscribe) -> one Sparkplug
// metric, at the given (already device-relative) metric name.
function toSparkplugMetric(attr, relativeName) {
  var valueType = attr.valueType || attr.type; // getHierarchy calls it valueType, change events call it type
  // [tck-id-operational-behavior-data-publish-nbirth-values]: a metric with
  // no real value yet MUST be flagged isNull=true, not coerced into a fake
  // ""/0/false — see sparkplugCodec's encodeMetric, which omits the value
  // field entirely for these. Checked BEFORE coerceValueForSparkplug, which
  // would otherwise silently manufacture one of those fake defaults.
  if (attr.value === undefined || attr.value === null) {
    return {
      name: relativeName,
      type: mapValueTypeToSparkplugType(valueType),
      isNull: true,
      timestamp: toEpochMs(attr.ts)
    };
  }
  return {
    name: relativeName,
    type: mapValueTypeToSparkplugType(valueType),
    value: coerceValueForSparkplug(attr.value, valueType),
    timestamp: toEpochMs(attr.ts)
  };
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
  toEpochMs: toEpochMs,
  toSparkplugMetric: toSparkplugMetric,
  topLevelNameFromPath: topLevelNameFromPath,
  relativeMetricNameFromPath: relativeMetricNameFromPath,
  collectDeviceMetrics: collectDeviceMetrics
};
