const { matches, splitPath } = require("../lib/asset/assetDataUtils");
const { getAssetController } = require("../lib/asset-plugin");

function pathMatchesPattern(pattern, testPath) {
  if (!pattern || pattern === "*" || pattern === "**") return true;
  
  // If pattern contains **, convert to regex
  if (pattern.includes("**")) {
    const regexStr = "^" + pattern.split(".").map(part => {
      if (part === "**") return ".*";
      if (part === "*") return "[^.]+";
      return part.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    }).join("\\.") + "$";
    return new RegExp(regexStr).test(testPath);
  }

  const patSegments = splitPath(pattern);
  const testSegments = splitPath(testPath);

  if (patSegments.length === testSegments.length) {
    return patSegments.every((seg, i) => matches(seg, testSegments[i]));
  }

  // Also support partial suffix or prefix match if pattern has fewer segments or ending with attribute name
  if (patSegments.length < testSegments.length && patSegments[patSegments.length - 1] === testSegments[testSegments.length - 1]) {
    // If last segment matches and first segment matches
    if (matches(patSegments[0], testSegments[0])) {
      return true;
    }
  }

  return false;
}

module.exports = function(RED) {
  function AssetWatchNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.watchPath = (config.watchPath || "*").trim();

    node.status({ fill: "grey", shape: "ring", text: "listening" });

    const asset = RED.asset || getAssetController(RED);
    if (!asset) {
      node.status({ fill: "red", shape: "ring", text: "engine not ready" });
      return;
    }

    const unsubscribe = asset.subscribe(function(meta) {
      if (!meta || !meta.change || !Array.isArray(meta.change.changes)) return;

      for (const change of meta.change.changes) {
        if (pathMatchesPattern(node.watchPath, change.path)) {
          node.status({ fill: "green", shape: "dot", text: `${change.path}: ${change.value}` });
          const msg = {
            topic: change.path,
            payload: change.value,
            assetId: change.assetId,
            attributeName: change.attributeName,
            attribute: change,
            meta: meta
          };
          node.send(msg);
        }
      }
    });

    node.on("close", function() {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    });
  }

  RED.nodes.registerType("kufayeka-asset-watch", AssetWatchNode);
};
