const { coerceAttributeValue, getAssetPath, normalizeValueType, toObject, valuesEqual } = require("./assetDataUtils");

const DEFAULT_HISTORIAN_TARGET = {
  id: "default",
  name: "Default Historian",
  timestampUnit: "us",
  enabled: true
};

function normalizeAsset(input) {
  const src = toObject(input);
  return {
    id: String(src.id != null ? src.id : ""),
    name: String(src.name != null ? src.name : "").replace(/\s+/g, "_"),
    parentId: src.parentId == null ? null : String(src.parentId),
    templateIds: Array.isArray(src.templateIds) ? src.templateIds.map((x) => String(x)) : [],
    attributes: toObject(src.attributes)
  };
}

function normalizeAttributeScript(input) {
  const src = toObject(input);
  const trigger = toObject(src.trigger);
  // mode: "onChange" (default, compute+write immediately on a direct write to THIS attribute) |
  // "schedule" (subscribes to centralized kufayeka-trigger-schedule broadcast) |
  // "watch" (recomputes immediately whenever any attribute in `trigger.watch` changes — no direct
  // write to this attribute needed; use for derived/formula attributes like `result = a * b`)
  let mode = "onChange";
  if (["schedule", "sharedTrigger"].includes(trigger.mode)) mode = "schedule";
  else if (trigger.mode === "watch") mode = "watch";
  const scheduleId = String(trigger.scheduleId || trigger.triggerNodeId || trigger.schedule || "");
  const runPolicy = trigger.runPolicy === "onlyOnWrite" ? "onlyOnWrite" : "always";
  // Each entry is either a bare sibling attribute name ("a") resolved on the SAME asset as this
  // attribute, or an absolute asset-attribute path ("Plant1.Line1.Motor1.a", "%..." also accepted).
  const watch = Array.isArray(trigger.watch) ? trigger.watch.map((w) => String(w || "").trim()).filter(Boolean) : [];
  return {
    enabled: src.enabled === true,
    code: String(src.code != null ? src.code : ""),
    trigger: {
      mode,
      scheduleId,
      runPolicy,
      triggerNodeId: scheduleId, // backwards-compatibility alias
      watch
    }
  };
}

function normalizeAssetAttributeTemplate(input) {
  const src = toObject(input);
  return {
    enabled: src.enabled !== false,
    name: String(src.name != null ? src.name : "").replace(/\s+/g, "_"),
    description: String(src.description != null ? src.description : ""),
    valueType: normalizeValueType(src.valueType || src.type || "string"),
    default: Object.prototype.hasOwnProperty.call(src, "default") ? src.default : src.defaultValue,
    unit: String(src.unit != null ? src.unit : ""),
    script: normalizeAttributeScript(src.script),
    historianEnabled: src.historianEnabled === true,
    historianTimeSourcePath: String(src.historianTimeSourcePath != null ? src.historianTimeSourcePath : ""),
    historianTargetId: String(src.historianTargetId != null ? src.historianTargetId : "default"),
    dashboardVisible: src.dashboardVisible === true,
    dashboardEditable: src.dashboardEditable !== false,
    nullable: src.nullable === true,
    inputType: String(src.inputType || src.inputMode || "text"),
    options: Array.isArray(src.options) ? src.options : [],
    optionsScript: String(src.optionsScript || src.optionsTransformScript || ""),
    numberMin: typeof src.numberMin === "number" ? src.numberMin : null,
    numberMax: typeof src.numberMax === "number" ? src.numberMax : null,
    numberAllowNegative: src.numberAllowNegative !== false,
    numberUseThousandSeparator: src.numberUseThousandSeparator === true,
    numberPrefix: String(src.numberPrefix != null ? src.numberPrefix : ""),
    numberSuffix: String(src.numberSuffix != null ? src.numberSuffix : ""),
    numberAllowDecimal: src.numberAllowDecimal !== false,
    numberPrecision: Math.max(0, Math.min(10, Number(src.numberPrecision != null ? src.numberPrecision : 2) || 0))
  };
}

function normalizeTemplate(input) {
  const src = toObject(input);
  return {
    id: String(src.id != null ? src.id : ""),
    name: String(src.name != null ? src.name : "").replace(/\s+/g, "_"),
    description: String(src.description != null ? src.description : ""),
    attributes: Array.isArray(src.attributes) ? src.attributes.map(normalizeAssetAttributeTemplate) : []
  };
}

function normalizeHistorian(input) {
  const src = toObject(input);
  const id = String(src.id != null ? src.id : "");
  if (!id.length) return null;
  return {
    id,
    name: String(src.name || src.id || ""),
    timestampUnit: String(src.timestampUnit || "us") === "ns" ? "ns" : "us",
    enabled: src.enabled !== false
  };
}

class AssetSchemaService {
  normalizeSection(input) {
    const source = toObject(input || {});
    const rawAssets = Array.isArray(source.assets) ? source.assets.map(normalizeAsset) : [];
    const attributeTemplates = Array.isArray(source.attributeTemplates) ? source.attributeTemplates.map(normalizeTemplate) : [];
    const templateById = new Map((attributeTemplates || []).map((template) => [template.id, template]));
    const assets = rawAssets.map((asset) => {
      const allowedNames = new Set();
      for (const templateId of asset.templateIds || []) {
        const template = templateById.get(templateId);
        if (!template) continue;
        for (const attribute of template.attributes || []) {
          if (attribute.enabled === false) continue;
          const name = String(attribute.name || "").trim();
          if (!name) continue;
          allowedNames.add(name);
        }
      }

      const nextAttributes = {};
      for (const [name, value] of Object.entries(asset.attributes || {})) {
        if (!allowedNames.has(name)) continue;
        nextAttributes[name] = value;
      }
      return { ...asset, attributes: nextAttributes };
    });
    const historiansRaw = Array.isArray(source.historians) ? source.historians : [];
    const historians = [DEFAULT_HISTORIAN_TARGET, ...(historiansRaw.map(normalizeHistorian).filter(Boolean))].filter(
      (h, i, arr) => arr.findIndex((x) => x.id === h.id) === i
    );

    return { assets, attributeTemplates, historians };
  }

  buildEffectiveAttributeMap(asset, templateById) {
    const map = new Map();

    for (const templateId of asset.templateIds || []) {
      const template = templateById.get(templateId);
      if (!template) continue;
      for (const attribute of template.attributes || []) {
        if (attribute.enabled === false) continue;
        if (!map.has(attribute.name)) {
          map.set(attribute.name, {
            value: coerceAttributeValue(attribute.valueType, attribute.default, {
              defaultValue: attribute.default,
              nullable: attribute.nullable === true,
              numberAllowDecimal: attribute.numberAllowDecimal !== false,
              numberAllowNegative: attribute.numberAllowNegative !== false
            }),
            valueType: attribute.valueType,
            description: attribute.description || "",
            defaultValue: attribute.default,
            nullable: attribute.nullable === true,
            unit: attribute.unit != null ? attribute.unit : "",
            numberAllowDecimal: attribute.numberAllowDecimal !== false,
            numberAllowNegative: attribute.numberAllowNegative !== false,
            numberPrecision: Math.max(0, Number(attribute.numberPrecision != null ? attribute.numberPrecision : 0) || 0),
            historianEnabled: attribute.historianEnabled === true,
            historianTimeSourcePath: String(attribute.historianTimeSourcePath != null ? attribute.historianTimeSourcePath : ""),
            historianTargetId: String(attribute.historianTargetId != null ? attribute.historianTargetId : "default"),
            script: attribute.script || { enabled: false, code: "", trigger: { mode: "onChange", repeat: 0, crontab: "" } }
          });
        }
      }
    }

    for (const [name, val] of Object.entries(asset.attributes || {})) {
      const item = val && typeof val === "object" ? val : null;
      const existing = map.get(name);
      const coerceOptions = {
        defaultValue: existing ? existing.defaultValue : undefined,
        nullable: existing ? existing.nullable === true : false,
        numberAllowDecimal: existing ? existing.numberAllowDecimal !== false : true,
        numberAllowNegative: existing ? existing.numberAllowNegative !== false : true
      };
      map.set(name, {
        ...(existing || {}),
        value:
          item && Object.prototype.hasOwnProperty.call(item, "value")
            ? coerceAttributeValue(normalizeValueType(existing ? existing.valueType : "string"), item.value, coerceOptions)
            : coerceAttributeValue(normalizeValueType(existing ? existing.valueType : "string"), val, coerceOptions),
        ts: item && Object.prototype.hasOwnProperty.call(item, "ts") ? String(item.ts) : undefined
      });
    }

    return map;
  }

  buildEffectiveAttributeForName(asset, templateById, attributeName) {
    let base;

    for (const templateId of asset.templateIds || []) {
      const template = templateById.get(templateId);
      if (!template) continue;
      const attribute = (template.attributes || []).find((a) => a.enabled !== false && a.name === attributeName);
      if (!attribute) continue;
      base = {
        value: coerceAttributeValue(attribute.valueType, attribute.default, {
          defaultValue: attribute.default,
          nullable: attribute.nullable === true,
          numberAllowDecimal: attribute.numberAllowDecimal !== false,
          numberAllowNegative: attribute.numberAllowNegative !== false
        }),
        valueType: attribute.valueType,
        description: attribute.description || "",
        defaultValue: attribute.default,
        nullable: attribute.nullable === true,
        unit: attribute.unit != null ? attribute.unit : "",
        numberAllowDecimal: attribute.numberAllowDecimal !== false,
        numberAllowNegative: attribute.numberAllowNegative !== false,
        numberPrecision: Math.max(0, Number(attribute.numberPrecision != null ? attribute.numberPrecision : 0) || 0),
        historianEnabled: attribute.historianEnabled === true,
        historianTimeSourcePath: String(attribute.historianTimeSourcePath != null ? attribute.historianTimeSourcePath : ""),
        historianTargetId: String(attribute.historianTargetId != null ? attribute.historianTargetId : "default"),
        script: attribute.script || { enabled: false, code: "", trigger: { mode: "onChange", repeat: 0, crontab: "" } }
      };
      break; // first template wins
    }

    const hasOverride = Object.prototype.hasOwnProperty.call(asset.attributes || {}, attributeName);
    if (!base && !hasOverride) return undefined;
    if (!hasOverride) return base;

    const val = (asset.attributes || {})[attributeName];
    const item = val && typeof val === "object" ? val : null;
    const valueType = normalizeValueType(base ? base.valueType : "string");
    const coerceOptions = {
      defaultValue: base ? base.defaultValue : undefined,
      nullable: base ? base.nullable === true : false,
      numberAllowDecimal: base ? base.numberAllowDecimal !== false : true,
      numberAllowNegative: base ? base.numberAllowNegative !== false : true
    };
    return {
      ...(base || {}),
      value:
        item && Object.prototype.hasOwnProperty.call(item, "value")
          ? coerceAttributeValue(valueType, item.value, coerceOptions)
          : coerceAttributeValue(valueType, val, coerceOptions),
      ts: item && Object.prototype.hasOwnProperty.call(item, "ts") ? String(item.ts) : undefined
    };
  }

  collectEffectiveAttributeMatches(section) {
    const templateById = new Map((section.attributeTemplates || []).map((template) => [template.id, template]));
    const assetById = new Map((section.assets || []).map((asset) => [asset.id, asset]));
    const out = new Map();

    for (const asset of section.assets || []) {
      const assetPath = getAssetPath(asset.id, assetById);
      if (!assetPath) continue;
      const attributes = this.buildEffectiveAttributeMap(asset, templateById);
      for (const [name, attribute] of attributes.entries()) {
        out.set(`${asset.id}:${name}`, {
          kind: "attribute",
          path: `${assetPath}.${name}`,
          assetId: asset.id,
          attributeName: name,
          value: attribute.value,
          ts: attribute.ts,
          type: attribute.valueType || "custom",
          unit: attribute.unit || "",
          historianEnabled: attribute.historianEnabled === true,
          historianTimeSourcePath: attribute.historianTimeSourcePath || "",
          historianTargetId: attribute.historianTargetId || "default"
        });
      }
    }

    return out;
  }

  attributeMatchChanged(prev, next) {
    if (!prev) return true;
    if (!valuesEqual(prev.value, next.value)) return true;
    if ((prev.ts || "") !== (next.ts || "")) return true;
    if (prev.type !== next.type) return true;
    if (prev.unit !== next.unit) return true;
    if (prev.historianEnabled !== next.historianEnabled) return true;
    if (prev.historianTimeSourcePath !== next.historianTimeSourcePath) return true;
    if (prev.historianTargetId !== next.historianTargetId) return true;
    if (JSON.stringify(prev.script || null) !== JSON.stringify(next.script || null)) return true;
    return false;
  }
}

module.exports = {
  AssetSchemaService,
  DEFAULT_HISTORIAN_TARGET
};
