/**
 * Kufayeka Asset Engine - AssetProxy & Script Preprocessor
 * Provides recursive Proxy evaluation for direct `$Plant1.Asset1.Attribute1` reads & writes,
 * transpiles `%` syntax, and generates dynamic TypeScript definitions for Monaco/Ace intellisense.
 */

function createAssetProxy(prefix, assetController) {
  const handler = {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;

      // Handle JS primitive coercions and reflection
      if (prop === "then" || prop === "inspect" || prop === "valueOf" || prop === "toString" || prop === "toJSON" || prop === Symbol.toPrimitive) {
        if (prefix) {
          const val = assetController.getValue(prefix);
          if (prop === "valueOf" || prop === Symbol.toPrimitive) return () => val;
          if (prop === "toString") return () => (val !== undefined && val !== null ? String(val) : "");
          if (prop === "toJSON") return () => val;
        }
        return undefined;
      }

      if (prop.startsWith("$$") || prop.startsWith("__")) return undefined;

      const fullPath = prefix ? `${prefix}.${prop}` : prop;
      const store = assetController.requireStore();

      // 1. Direct Attribute check
      const attr = store.attributeByPath.get(fullPath);
      if (attr !== undefined) {
        return attr.value;
      }

      // 2. Direct Asset check
      const asset = store.assetByPath.get(fullPath);
      if (asset !== undefined) {
        return createAssetProxy(fullPath, assetController);
      }

      // 3. Prefix check (if any attribute starts with fullPath + ".")
      for (const key of store.attributeByPath.keys()) {
        if (key.startsWith(fullPath + ".")) {
          return createAssetProxy(fullPath, assetController);
        }
      }

      // 4. Bracket notation or wildcard fallback (e.g. $["Plant1.Line1.Motor1.Speed"])
      const fallbackVal = assetController.getValue(fullPath);
      if (fallbackVal !== undefined) {
        return fallbackVal;
      }

      return createAssetProxy(fullPath, assetController);
    },

    set(target, prop, value) {
      if (typeof prop !== "string") return false;
      const fullPath = prefix ? `${prefix}.${prop}` : prop;
      assetController.setAttribute(fullPath, value);
      return true;
    },

    apply(target, thisArg, argumentsList) {
      if (argumentsList.length > 0) {
        const subPath = String(argumentsList[0] || "").trim();
        const fullPath = prefix ? `${prefix}.${subPath}` : subPath;
        if (argumentsList.length > 1) {
          assetController.setAttribute(fullPath, argumentsList[1]);
          return argumentsList[1];
        }
        return assetController.getValue(fullPath);
      }
      return assetController.getValue(prefix);
    }
  };

  const dummyTarget = function() {};
  return new Proxy(dummyTarget, handler);
}

/**
 * Preprocesses user code to support `%Plant1.Asset1.Attribute1` or `%"Plant 1.Line 1.Speed"%` syntax in standard V8 JS.
 * Transforms `%"Path With Spaces"%` -> `$["Path With Spaces"]`
 * Transforms `%([a-zA-Z_$][a-zA-Z0-9_$.]*)` -> `$1` (e.g. `%Plant1` -> `Plant1`)
 * Does not match arithmetic modulo `% 10` or `%2`.
 */
function preprocessAssetScript(code) {
  if (!code || typeof code !== "string") return "";
  return code
    .replace(/%["']([^"']+)["']%?/g, (_match, p1) => `$["${p1}"]`)
    .replace(/%\[([^\]]+)\]%?/g, (_match, p1) => `$["${p1}"]`)
    .replace(/%([a-zA-Z_$][a-zA-Z0-9_$.]*)/g, (_match, p1) => p1);
}

/**
 * Builds TypeScript interface definitions for Monaco Editor based on the live Asset hierarchy.
 */
function generateAssetDts(hierarchy) {
  const rootTree = {};

  function insertNode(tree, segments, attrMeta) {
    let current = tree;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!current[seg]) {
        current[seg] = { _isAsset: true, _children: {} };
      }
      current = current[seg]._children;
    }
    const lastSeg = segments[segments.length - 1];
    current[lastSeg] = { _isAttr: true, meta: attrMeta };
  }

  function traverse(assetNode) {
    if (!assetNode) return;
    const path = assetNode.path || assetNode.name || "";
    if (path && Array.isArray(assetNode.effectiveAttributes)) {
      for (const attr of assetNode.effectiveAttributes) {
        const fullPath = `${path}.${attr.name}`;
        const segments = fullPath.split(".").filter(Boolean);
        insertNode(rootTree, segments, attr);
      }
    }
    if (Array.isArray(assetNode.children)) {
      for (const child of assetNode.children) {
        traverse(child);
      }
    }
  }

  if (Array.isArray(hierarchy)) {
    hierarchy.forEach(traverse);
  }

  function renderTree(treeObj, indent = "  ") {
    let lines = [];
    for (const [key, val] of Object.entries(treeObj)) {
      if (val._isAttr) {
        const meta = val.meta || {};
        const jsType = meta.valueType === "number" ? "number" : meta.valueType === "boolean" ? "boolean" : meta.valueType === "json" ? "any" : "string";
        const doc = `/** ${meta.description ? meta.description + " | " : ""}Type: ${meta.valueType || "custom"}${meta.unit ? " (" + meta.unit + ")" : ""} | Current: ${JSON.stringify(meta.value)} */`;
        lines.push(`${indent}${doc}`);
        lines.push(`${indent}"${key}": ${jsType};`);
      } else if (val._isAsset) {
        lines.push(`${indent}"${key}": {`);
        lines.push(renderTree(val._children, indent + "  "));
        lines.push(`${indent}};`);
      }
    }
    return lines.join("\n");
  }

  const dtsContent = `
/**
 * Auto-generated Kufayeka Asset Engine TypeScript Definitions
 */
interface KufayekaAssetTree {
${renderTree(rootTree, "  ")}
  [key: string]: any;
}

${Object.keys(rootTree)
  .map((rootKey) => `declare const ${rootKey}: KufayekaAssetTree["${rootKey}"] & { [key: string]: any };`)
  .join("\n")}

declare const $: KufayekaAssetTree & {
  (path: string, value?: any): any;
  [key: string]: any;
};

declare const asset: {
  get(path: string, defaultValue?: any): any;
  getValue(path: string, defaultValue?: any): any;
  set(path: string, value: any): void;
  setAttribute(path: string, value: any): void;
  setMany(items: Array<{path: string, value: any}>): void;
  query(pathQuery: string): any[];
  findByValue(pathQuery: string, value: any, options?: object): object;
  hierarchy(options?: object): object;
};
`;

  return dtsContent;
}

module.exports = {
  createAssetProxy,
  preprocessAssetScript,
  generateAssetDts
};
