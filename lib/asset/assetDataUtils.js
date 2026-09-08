// Legacy numeric-width variants (int8/uint8/.../float64) collapsed into "number"
const LEGACY_NUMBER_TYPES = new Set(["int8", "uint8", "int16", "uint16", "int32", "uint32", "float32", "float64", "number"]);

function normalizeValueType(rawType) {
  const t = String(rawType || "string");
  if (LEGACY_NUMBER_TYPES.has(t)) return "number";
  const types = new Set(["boolean", "string", "array", "object"]);
  if (types.has(t)) return t;
  return "string";
}

function defaultValueForType(valueType) {
  if (valueType === "number") return 0;
  if (valueType === "boolean") return false;
  if (valueType === "array") return [];
  if (valueType === "object") return {};
  return "";
}

function coerceAttributeValue(valueType, value, options) {
  options = options || {};
  const nullable = options.nullable === true;
  const fallback = options.defaultValue !== undefined ? options.defaultValue : defaultValueForType(valueType);
  const source = value == null ? (nullable ? null : fallback) : value;

  if (source == null) return null;

  if (valueType === "number") {
    const parsed = Number(source);
    if (!Number.isFinite(parsed)) return Number(fallback || 0);
    const truncated = options.numberAllowDecimal === false ? Math.trunc(parsed) : parsed;
    return options.numberAllowNegative === false ? Math.max(0, truncated) : truncated;
  }

  if (valueType === "boolean") {
    if (typeof source === "boolean") return source;
    if (typeof source === "number") return source !== 0;
    const normalized = String(source).trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
    return Boolean(fallback);
  }

  if (valueType === "array") {
    if (Array.isArray(source)) return source;
    return Array.isArray(fallback) ? fallback : [];
  }

  if (valueType === "object") {
    return source && typeof source === "object" && !Array.isArray(source)
      ? source
      : fallback && typeof fallback === "object" && !Array.isArray(fallback)
        ? fallback
        : {};
  }

  return String(source);
}

function toObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function splitPath(pathValue) {
  return String(pathValue || "")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getAssetPath(assetId, assetById) {
  const asset = assetById.get(assetId);
  if (!asset) return "";
  const parts = [asset.name];
  let parentId = asset.parentId;
  while (parentId) {
    const parent = assetById.get(parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts.join(".");
}

function valuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  const leftType = typeof left;
  const rightType = typeof right;
  if (leftType !== "object" || rightType !== "object" || left === null || right === null) return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function valuesLooselyEqual(left, right) {
  if (valuesEqual(left, right)) return true;
  if (typeof left === "object" || typeof right === "object") {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }
  // eslint-disable-next-line eqeqeq
  return left == right;
}

function matches(pattern, value) {
  return pattern === "*" || pattern === value;
}

module.exports = {
  normalizeValueType,
  defaultValueForType,
  coerceAttributeValue,
  toObject,
  splitPath,
  getAssetPath,
  valuesEqual,
  valuesLooselyEqual,
  matches
};
