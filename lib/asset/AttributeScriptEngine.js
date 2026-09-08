const vm = require("vm");
const { createAssetProxy, preprocessAssetScript } = require("./AssetProxy");

/**
 * Executes attribute-template calculation scripts (`self`, sibling attribute names, and
 * `%Path.To.Asset.attr` absolute references) in a vm sandbox — the same sandboxing approach
 * already used by the `kufayeka-asset-function` node, so no new execution model is introduced.
 *
 * Scripts are compiled once per distinct source string and reused across every write, since
 * `new vm.Script(...)` is far more expensive than `vm.createContext(...)` + `runInContext(...)`.
 */
class AttributeScriptEngine {
  constructor() {
    this.compiledByCode = new Map();
    this.activeExecutionStack = new Set();
  }

  getCompiled(code, label) {
    let compiled = this.compiledByCode.get(code);
    if (compiled) return compiled;

    console.log(`[kufayeka-asset-engine] Compiling new script version for ${label} (${code.length} chars)`);
    const processed = preprocessAssetScript(code);
    const wrapped = `(function(){\n${processed}\n})();`;
    compiled = new vm.Script(wrapped, { filename: label || "attribute-script", displayErrors: true });
    this.compiledByCode.set(code, compiled);
    return compiled;
  }

  /**
   * @param {object} options
   * @param {string} options.code - user script source (must `return` the final value)
   * @param {string} options.assetId
   * @param {string} options.attributeName
   * @param {*} options.self - the raw incoming value being calculated
   * @param {*} [options.current] - this attribute's own value as it stood BEFORE this write —
   *   the "previous value" for accumulators, deltas, encoder-jump handling, low-pass filters, etc.
   * @param {*} [options.prevSelf] - the `self` from this attribute's own PREVIOUS script run —
   *   lets one attribute compute a delta against its own last raw reading without needing a
   *   second, companion attribute just to remember "last raw value". `undefined` on the first
   *   ever run.
   * @param {(name: string) => {found: boolean, value?: *}} [options.getSibling] - resolves another
   *   attribute name on the SAME asset instance. Never triggers that attribute's own script.
   * @param {(name: string, value: *) => *} [options.setSibling] - writes another attribute
   *   on the SAME asset instance.
   * @param {object} [options.assetController] - enables `%Plant1.Line1.Motor1.attr` absolute
   *   path access and root-asset proxies, same as the asset-function node.
   */
  evaluate({ code, assetId, attributeName, self, current, prevSelf, getSibling, setSibling, assetController }) {
    const execKey = `${assetId}:${attributeName}`;
    if (this.activeExecutionStack.has(execKey)) {
      console.warn(`[kufayeka-asset-engine] Circular script execution prevented for ${execKey}`);
      return self;
    }

    this.activeExecutionStack.add(execKey);
    try {
      const compiled = this.getCompiled(code, `attribute-script:${assetId}.${attributeName}`);
      const sandboxCache = new Map();

      const sandbox = {
        self,
        current,
        prevSelf,
        Math,
        JSON,
        Number,
        String,
        Boolean,
        Date,
        Error,
        TypeError,
        RangeError,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        console,
        setSibling: (name, val) => {
          if (typeof setSibling === "function") {
            setSibling(name, val);
          }
          sandboxCache.set(name, val);
          return val;
        }
      };

      // Sibling proxy object: `sibling.attributeName` for explicit reads & writes
      sandbox.sibling = new Proxy({}, {
        get(t, prop) {
          if (typeof prop !== "string") return undefined;
          if (sandboxCache.has(prop)) return sandboxCache.get(prop);
          const s = getSibling ? getSibling(prop) : { found: false };
          return s.found ? s.value : undefined;
        },
        set(t, prop, val) {
          if (typeof prop !== "string") return false;
          if (typeof setSibling === "function") {
            setSibling(prop, val);
          }
          sandboxCache.set(prop, val);
          return true;
        }
      });

      if (assetController) {
        sandbox.$ = createAssetProxy("", assetController);
        sandbox.asset = {
          get: (path, fallback) => assetController.getValue(path, fallback),
          getValue: (path, fallback) => assetController.getValue(path, fallback),
          set: (path, val) => assetController.setAttribute(path, val),
          setAttribute: (path, val) => assetController.setAttribute(path, val),
          setMany: (items) => assetController.setAttributes(items),
          query: (pattern) => assetController.query(pattern),
          find: (pattern, val, opts) => assetController.findAttributesByValue(pattern, val, opts),
          findByValue: (pattern, val, opts) => assetController.findAttributesByValue(pattern, val, opts),
          hierarchy: (opts) => assetController.getHierarchy(opts)
        };

        // Populate dynamic root asset proxies (e.g. Plant1, Line1)
        try {
          const state = assetController.getState ? assetController.getState() : null;
          if (state && Array.isArray(state.assets)) {
            for (const a of state.assets) {
              if (a && a.name && !a.parentId) {
                const proxy = createAssetProxy(a.name, assetController);
                sandbox[a.name] = proxy;
                sandbox[`$${a.name}`] = proxy;
              }
            }
          }
        } catch (e) {
          // ignore
        }
      }

      const proxied = new Proxy(sandbox, {
        has() {
          return true;
        },
        get(target, key) {
          if (typeof key !== "string") return target[key];
          if (sandboxCache.has(key)) return sandboxCache.get(key);
          if (key in target) return target[key];

          const sibling = getSibling ? getSibling(key) : { found: false };
          if (sibling.found) return sibling.value;

          if (assetController) {
            const store = assetController.requireStore ? assetController.requireStore() : null;
            if (store && store.assetByPath && store.assetByPath.has(key)) {
              return createAssetProxy(key, assetController);
            }
          }

          return undefined;
        },
        set(target, key, val) {
          if (typeof key !== "string") return false;

          // Preserve internal sandbox keys like self, current, prevSelf, Math, etc.
          if (key in target && key !== "sibling") {
            target[key] = val;
            return true;
          }

          const sibling = getSibling ? getSibling(key) : { found: false };
          if (sibling.found) {
            if (typeof setSibling === "function") {
              setSibling(key, val);
            }
            sandboxCache.set(key, val);
            return true;
          }

          // Non-sibling assignments in script are stored locally in sandbox
          target[key] = val;
          return true;
        }
      });

      const context = vm.createContext(proxied);
      return compiled.runInContext(context, { timeout: 2000 });
    } finally {
      this.activeExecutionStack.delete(execKey);
    }
  }
}

module.exports = { AttributeScriptEngine };
