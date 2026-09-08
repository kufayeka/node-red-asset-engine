const util = require("util");
const vm = require("vm");
const { createAssetProxy, preprocessAssetScript } = require("../lib/asset/AssetProxy");
const { getAssetController } = require("../lib/asset-plugin");

module.exports = function(RED) {
  "use strict";

  function sendResults(node, send, _msgid, msgs, cloneFirstMessage) {
    if (msgs == null) return;
    send = send || function() { node.send.apply(node, arguments); };
    if (!Array.isArray(msgs)) msgs = [msgs];
    let msgCount = 0;
    for (let m = 0; m < msgs.length; m++) {
      if (msgs[m]) {
        if (!Array.isArray(msgs[m])) {
          msgs[m] = [msgs[m]];
        }
        for (let n = 0; n < msgs[m].length; n++) {
          let msg = msgs[m][n];
          if (msg !== null && msg !== undefined) {
            if (typeof msg === "object" && !Buffer.isBuffer(msg) && !Array.isArray(msg)) {
              if (msgCount === 0 && cloneFirstMessage !== false) {
                msgs[m][n] = RED.util.cloneMessage(msgs[m][n]);
                msg = msgs[m][n];
              }
              msg._msgid = _msgid;
              msgCount++;
            } else {
              node.error("Function node returned a non-object message");
            }
          }
        }
      }
    }
    if (msgCount > 0) {
      send(msgs);
    }
  }

  function updateErrorInfo(err, kind = "body") {
    if (err && err.stack) {
      const stack = err.stack.toString();
      const m = /^([^:]+):([^:]+):(\d+).*/.exec(stack);
      if (m) {
        const line = parseInt(m[3], 10) - 1;
        err.message += ` (${kind}: line ${line})`;
      }
    }
  }

  function AssetFunctionNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    node.name = n.name;
    node.func = n.func || "\nreturn msg;";
    node.outputs = n.outputs || 1;
    node.timeout = (n.timeout || 0) * 1000;
    node.ini = n.initialize ? n.initialize.trim() : "";
    node.fin = n.finalize ? n.finalize.trim() : "";
    node.outstandingTimers = [];
    node.outstandingIntervals = [];

    // Create execution sandbox
    function buildSandbox(msg, send, done) {
      const assetController = RED.asset || getAssetController(RED);

      const sandbox = {
        // Standard JS runtime primitives & constructors
        Object,
        Array,
        String,
        Number,
        Boolean,
        RegExp,
        Math,
        JSON,
        Promise,
        Error,
        TypeError,
        RangeError,
        SyntaxError,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURI,
        decodeURI,
        encodeURIComponent,
        decodeURIComponent,
        Symbol,
        Map,
        Set,
        WeakMap,
        WeakSet,
        Proxy,
        Reflect,
        Intl,
        console,
        util,
        Buffer,
        Date,
        URL,
        URLSearchParams,
        RED: {
          util: RED.util
        },
        node: {
          id: node.id,
          name: node.name,
          outputCount: node.outputs,
          log: (...args) => node.log(...args),
          error: (...args) => node.error(...args),
          warn: (...args) => node.warn(...args),
          debug: (...args) => node.debug(...args),
          trace: (...args) => node.trace(...args),
          status: (...args) => node.status(...args),
          send: (msgs, cloneMsg) => sendResults(node, send, msg ? msg._msgid : null, msgs, cloneMsg),
          done: done || (() => {})
        },
        context: {
          set: (...args) => node.context().set(...args),
          get: (...args) => node.context().get(...args),
          keys: (...args) => node.context().keys(...args),
          get global() { return node.context().global; },
          get flow() { return node.context().flow; }
        },
        flow: {
          set: (...args) => node.context().flow.set(...args),
          get: (...args) => node.context().flow.get(...args),
          keys: (...args) => node.context().flow.keys(...args)
        },
        global: {
          set: (...args) => node.context().global.set(...args),
          get: (...args) => node.context().global.get(...args),
          keys: (...args) => node.context().global.keys(...args)
        },
        env: {
          get: (envVar) => RED.util.getSetting(node, envVar)
        },
        setTimeout: function(fn, delay, ...args) {
          const timerId = setTimeout(() => {
            const idx = node.outstandingTimers.indexOf(timerId);
            if (idx > -1) node.outstandingTimers.splice(idx, 1);
            try {
              fn(...args);
            } catch (err) {
              node.error(err);
            }
          }, delay);
          node.outstandingTimers.push(timerId);
          return timerId;
        },
        clearTimeout: function(id) {
          clearTimeout(id);
          const idx = node.outstandingTimers.indexOf(id);
          if (idx > -1) node.outstandingTimers.splice(idx, 1);
        },
        setInterval: function(fn, delay, ...args) {
          const timerId = setInterval(() => {
            try {
              fn(...args);
            } catch (err) {
              node.error(err);
            }
          }, delay);
          node.outstandingIntervals.push(timerId);
          return timerId;
        },
        clearInterval: function(id) {
          clearInterval(id);
          const idx = node.outstandingIntervals.indexOf(id);
          if (idx > -1) node.outstandingIntervals.splice(idx, 1);
        }
      };

      if (assetController) {
        // Root Proxy `$`
        const rootProxy = createAssetProxy("", assetController);
        sandbox.$ = rootProxy;
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

        // Populate dynamic root asset proxies (e.g. Plant1, Line1) from live state
        try {
          const state = assetController.getState();
          if (state && Array.isArray(state.assets)) {
            for (const a of state.assets) {
              if (a && a.name && !a.parentId) {
                const proxy = createAssetProxy(a.name, assetController);
                sandbox[a.name] = proxy;
                sandbox[`$${a.name}`] = proxy;
              }
            }
          }
        } catch {
          // ignore
        }
      }

      // Wrap sandbox in Proxy to catch any dynamic root asset or $ variable
      const dynamicSandbox = new Proxy(sandbox, {
        has(target, key) {
          if (key in target) return true;
          if (typeof global !== "undefined" && key in global) return true;
          if (typeof key === "string" && assetController) {
            const store = assetController.requireStore();
            if (store && store.assetByPath && store.assetByPath.has(key)) return true;
            if (key.startsWith("$")) return true;
          }
          return false;
        },
        get(target, key) {
          if (key in target) return target[key];
          if (typeof key === "string" && assetController) {
            const store = assetController.requireStore();
            if (store && store.assetByPath && store.assetByPath.has(key)) {
              return createAssetProxy(key, assetController);
            }
            if (key.startsWith("$")) {
              if (key === "$") return target.$;
              const rootName = key.slice(1);
              return createAssetProxy(rootName, assetController);
            }
          }
          if (typeof global !== "undefined" && key in global) {
            return global[key];
          }
          return undefined;
        },
        set(target, key, val) {
          target[key] = val;
          return true;
        }
      });

      return dynamicSandbox;
    }

    // Compile scripts
    try {
      // 1. Main Function script
      const processedFunc = preprocessAssetScript(node.func);
      const functionText =
        "var results = null;\n" +
        "results = (async function(msg, __send__, __done__){\n" +
        "  var __msgid__ = msg ? msg._msgid : null;\n" +
        processedFunc + "\n" +
        "})(msg, __send__, __done__);";

      node.script = new vm.Script(functionText, {
        filename: `AssetFunction node: ${node.id}${node.name ? ` [${node.name}]` : ""}`,
        displayErrors: true
      });

      // 2. Initialize (On Start) script
      if (node.ini) {
        const processedIni = preprocessAssetScript(node.ini);
        const iniText =
          "(async function(__send__, __done__){\n" +
          processedIni + "\n" +
          "})(__send__, __done__);";
        node.iniScript = new vm.Script(iniText, {
          filename: `AssetFunction init: ${node.id}`,
          displayErrors: true
        });
      }

      // 3. Finalize (On Stop) script
      if (node.fin) {
        const processedFin = preprocessAssetScript(node.fin);
        const finText =
          "(async function(){\n" +
          processedFin + "\n" +
          "})();";
        node.finScript = new vm.Script(finText, {
          filename: `AssetFunction finalize: ${node.id}`,
          displayErrors: true
        });
      }
    } catch (err) {
      updateErrorInfo(err, "compile");
      node.error(err);
      return;
    }

    // Run On Start script if defined
    if (node.iniScript) {
      const iniSandbox = buildSandbox(null, node.send.bind(node), () => {});
      const context = vm.createContext(iniSandbox);
      try {
        const promise = node.iniScript.runInContext(context, { timeout: node.timeout || 10000 });
        if (promise && typeof promise.then === "function") {
          promise.catch((err) => {
            updateErrorInfo(err, "setup");
            node.error(err);
          });
        }
      } catch (err) {
        updateErrorInfo(err, "setup");
        node.error(err);
      }
    }

    // Main input handler
    node.on("input", function(msg, send, done) {
      send = send || function() { node.send.apply(node, arguments); };
      done = done || function(err) { if (err) node.error(err, msg); };

      if (!node.script) {
        done();
        return;
      }

      const sandbox = buildSandbox(msg, send, done);
      sandbox.msg = msg;
      sandbox.__send__ = send;
      sandbox.__done__ = done;

      const context = vm.createContext(sandbox);

      try {
        const runOptions = {};
        if (node.timeout > 0) {
          runOptions.timeout = node.timeout;
          runOptions.breakOnSigint = true;
        }

        const executionPromise = node.script.runInContext(context, runOptions);

        if (executionPromise && typeof executionPromise.then === "function") {
          executionPromise
            .then((results) => {
              sendResults(node, send, msg._msgid, results, false);
              done();
            })
            .catch((err) => {
              console.error("DEBUG ASYNC SCRIPT ERROR:", err);
              updateErrorInfo(err, "body");
              node.error(err, msg);
              done(err);
            });
        } else {
          sendResults(node, send, msg._msgid, executionPromise, false);
          done();
        }
      } catch (err) {
        console.error("DEBUG SYNC SCRIPT ERROR:", err);
        updateErrorInfo(err, "body");
        node.error(err, msg);
        done(err);
      }
    });

    // Cleanup on close
    node.on("close", function(removed, done) {
      // Clear timers and intervals
      while (node.outstandingTimers.length > 0) {
        clearTimeout(node.outstandingTimers.pop());
      }
      while (node.outstandingIntervals.length > 0) {
        clearInterval(node.outstandingIntervals.pop());
      }

      if (node.finScript) {
        const finSandbox = buildSandbox(null, () => {}, () => {});
        const context = vm.createContext(finSandbox);
        try {
          const promise = node.finScript.runInContext(context, { timeout: 2000 });
          if (promise && typeof promise.then === "function") {
            promise.finally(() => done()).catch(() => done());
            return;
          }
        } catch {
          // ignore finalize errors on shutdown
        }
      }
      done();
    });
  }

  RED.nodes.registerType("kufayeka-asset-function", AssetFunctionNode);
};
