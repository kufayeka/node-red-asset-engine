const path = require("path");
const { AssetDomainController } = require("./asset/AssetDomainController");
const { AttributeScriptScheduler } = require("./asset/AttributeScriptScheduler");

let assetControllerInstance = null;
let scriptSchedulerInstance = null;

function getAssetController(RED) {
  if (RED && RED.asset) {
    return RED.asset;
  }
  if (!assetControllerInstance) {
    assetControllerInstance = new AssetDomainController(RED);
    assetControllerInstance.initialize();
  }
  if (RED) {
    RED.asset = assetControllerInstance;
  }
  return assetControllerInstance;
}

function getScriptScheduler(asset, RED) {
  if (!scriptSchedulerInstance) {
    scriptSchedulerInstance = new AttributeScriptScheduler(() => asset.getStore(), asset.scriptEngine, asset, RED);
  }
  return scriptSchedulerInstance;
}

function parseBoolean(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  const s = String(raw).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return fallback;
}

function decodeWildcardPath(req) {
  const raw = req.params[0] || req.params.encodedPath || "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const { createAssetProxy } = require("./asset/AssetProxy");

module.exports = function(RED) {
  const asset = getAssetController(RED);

  // 1. Expose asset engine and $ root proxy to RED and function global context
  RED.asset = asset;
  if (RED.settings && RED.settings.functionGlobalContext) {
    try {
      RED.settings.functionGlobalContext.asset = asset;
      RED.settings.functionGlobalContext.$ = createAssetProxy("", asset);
    } catch {
      // ignore if frozen
    }
  }

  // 2. Register runtime plugin and comms emitter
  if (RED.plugins && RED.plugins.registerPlugin) {
    RED.plugins.registerPlugin("kufayeka-asset-engine", {
      type: "node-red-runtime-plugin",
      onadd: function() {
        if (RED.log) RED.log.info("[kufayeka-asset-engine] Runtime Asset Engine plugin initialized");

        // Attribute-template calculation scripts with a timed trigger (interval/crontab) need
        // their schedule (re)built whenever the schema changes — new/removed assets or
        // templates mean different (assetId, attributeName) pairs need timers.
        const scheduler = getScriptScheduler(asset, RED);
        scheduler.rebuild();
        asset.subscribe(function(meta) {
          if (RED.comms && RED.comms.publish) {
            RED.comms.publish("assets/changed", meta);
            RED.comms.publish("kufayeka/asset", meta);
          }
          if (meta && meta.change && (meta.change.type === "schema.applied" || meta.change.type === "state.replace")) {
            scheduler.rebuild();
          }
        });
      }
    });
  }

  // 3. Mount Admin REST API Routes on RED.httpAdmin
  if (RED.httpAdmin) {
    // CodeMirror 6 bundle for the "asset function" node's editors and the
    // attribute calculation-script dialog (lib/cm6/, built by build.js into
    // dist/) — replaces RED.editor.createEditor (ace/monaco) for those two
    // dialogs; see lib/cm6/cm6-code-editor.js for why. dist/ is gitignored,
    // run `npm run build` after checkout.
    RED.httpAdmin.get("/asset-engine/_cm6-editor.js", function (req, res) {
      res.type("application/javascript");
      res.sendFile(path.join(__dirname, "..", "dist", "asset-engine-cm6.bundle.js"));
    });

    const auth = RED.auth && RED.auth.needsPermission ? RED.auth.needsPermission("flows.read") : (req, res, next) => next();
    const authWrite = RED.auth && RED.auth.needsPermission ? RED.auth.needsPermission("flows.write") : (req, res, next) => next();

    const handleGetSystem = (req, res) => {
      res.json({ status: "ok", data: asset.getState() });
    };

    const handlePutSystem = (req, res) => {
      const updated = asset.replaceState(req.body || {}, false);
      res.json({ status: "ok", data: updated });
    };

    const handlePutSchema = (req, res) => {
      const updated = asset.replaceState(req.body || {}, true);
      res.json({ status: "ok", data: updated });
    };

    const handleGetHierarchy = (req, res) => {
      const populatedRaw = req.query.populated;
      const populated = populatedRaw === undefined ? true : parseBoolean(populatedRaw, true);
      const hierarchy = asset.getHierarchy({ populateAttributes: populated });
      res.json({ status: "ok", data: hierarchy });
    };

    const handleGetQuery = (req, res) => {
      const pathQuery = String(req.query.path || "").trim();
      const results = asset.query(pathQuery);
      res.json({ status: "ok", data: results });
    };

    const handleFindByValue = (req, res) => {
      const pathQuery = String(req.query.path || "*.*.*").trim();
      const rawValue = req.query.value;
      const strict = parseBoolean(req.query.strict, false);
      const result = asset.findAttributesByValue(pathQuery, rawValue, { strict });
      res.json({ status: "ok", data: result });
    };

    const handleHistorianTags = (req, res) => {
      const pathQuery = String(req.query.path || "*.*.*").trim();
      const matches = asset.getAttributes(pathQuery).filter((m) => m.historianEnabled === true);
      res.json({ status: "ok", data: matches });
    };

    const handleGetValue = (req, res) => {
      const pathQuery = decodeWildcardPath(req);
      if (!pathQuery) return res.status(400).json({ status: "error", message: "Asset path required" });
      const matches = asset.getAttributes(pathQuery);
      const value = matches.length === 1 ? matches[0].value : matches.map((m) => m.value);
      res.json({ status: "ok", path: pathQuery, value, matches });
    };

    const handlePutValue = (req, res) => {
      const pathQuery = decodeWildcardPath(req);
      if (!pathQuery) return res.status(400).json({ status: "error", message: "Asset path required" });
      const val = req.body && Object.prototype.hasOwnProperty.call(req.body, "value") ? req.body.value : req.body;
      const changed = asset.setAttribute(pathQuery, val);
      res.json({ status: "ok", path: pathQuery, count: changed.length, matches: changed });
    };

    const handleBatchRead = (req, res) => {
      const paths = Array.isArray(req.body && req.body.paths) ? req.body.paths : [];
      const results = paths.map((p) => {
        const matches = asset.getAttributes(p);
        const value = matches.length === 1 ? matches[0].value : matches.map((m) => m.value);
        return { path: p, value, matches };
      });
      res.json({ status: "ok", data: results });
    };

    const handleBatchWrite = (req, res) => {
      const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
      const results = asset.setAttributes(items);
      res.json({ status: "ok", data: results });
    };

    // Mount on /api/assets/* and /assets/*
    const routePrefixes = ["/api/assets", "/assets"];
    for (const prefix of routePrefixes) {
      RED.httpAdmin.get(`${prefix}`, auth, handleGetSystem);
      RED.httpAdmin.get(`${prefix}/system`, auth, handleGetSystem);
      RED.httpAdmin.put(`${prefix}`, authWrite, handlePutSystem);
      RED.httpAdmin.put(`${prefix}/system`, authWrite, handlePutSystem);
      RED.httpAdmin.put(`${prefix}/schema`, authWrite, handlePutSchema);
      RED.httpAdmin.get(`${prefix}/hierarchy`, auth, handleGetHierarchy);
      RED.httpAdmin.get(`${prefix}/query`, auth, handleGetQuery);
      RED.httpAdmin.get(`${prefix}/find`, auth, handleFindByValue);
      RED.httpAdmin.get(`${prefix}/find-by-value`, auth, handleFindByValue);
      RED.httpAdmin.get(`${prefix}/historian-tags`, auth, handleHistorianTags);
      RED.httpAdmin.post(`${prefix}/values\\:batch`, auth, handleBatchRead);
      RED.httpAdmin.post(`${prefix}/values/batch`, auth, handleBatchRead);
      RED.httpAdmin.put(`${prefix}/values\\:batch`, authWrite, handleBatchWrite);
      RED.httpAdmin.put(`${prefix}/values/batch`, authWrite, handleBatchWrite);
      RED.httpAdmin.get(`${prefix}/value/*`, auth, handleGetValue);
      RED.httpAdmin.put(`${prefix}/value/*`, authWrite, handlePutValue);
    }
  }

  return {
    asset: asset,
    getAssetController: () => asset
  };
};

module.exports.getAssetController = getAssetController;
