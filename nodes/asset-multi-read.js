const { getAssetController } = require("../lib/asset-plugin");

module.exports = function(RED) {
  function AssetMultiReadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.paths = Array.isArray(config.paths) ? config.paths : [];
    node.property = config.property || "payload";
    node.propertyType = config.propertyType || "msg";
    node.outputMode = config.outputMode || "value"; // 'value' | 'attribute' | 'map'

    node.on("input", function(msg, send, done) {
      send = send || function() { node.send.apply(node, arguments); };
      done = done || function(err) { if (err) node.error(err, msg); };

      const asset = RED.asset || getAssetController(RED);
      if (!asset) {
        node.status({ fill: "red", shape: "ring", text: "engine not ready" });
        return done(new Error("Asset Engine is not ready"));
      }

      // Allow dynamic override from msg.paths or msg.assetPaths or fallback to configured paths
      let targetPaths = [];
      if (Array.isArray(msg.paths)) {
        targetPaths = msg.paths;
      } else if (Array.isArray(msg.assetPaths)) {
        targetPaths = msg.assetPaths;
      } else if (typeof msg.paths === "string" && msg.paths.trim()) {
        targetPaths = msg.paths.split(",").map(p => p.trim()).filter(Boolean);
      } else {
        targetPaths = (node.paths || []).map(p => String(p || "").trim()).filter(Boolean);
      }

      if (targetPaths.length === 0) {
        node.status({ fill: "yellow", shape: "dot", text: "no paths configured" });
        return done(new Error("No asset paths specified"));
      }

      try {
        let result;
        let count = 0;

        if (node.outputMode === "attribute") {
          const list = [];
          for (const p of targetPaths) {
            const matches = asset.getAttributes(p);
            list.push(...matches);
            count += matches.length;
          }
          result = list;
        } else if (node.outputMode === "map") {
          const map = {};
          for (const p of targetPaths) {
            const matches = asset.getAttributes(p);
            for (const m of matches) {
              map[m.path] = m.value;
              count++;
            }
          }
          result = map;
        } else {
          // 'value' mode: array of values
          const values = [];
          for (const p of targetPaths) {
            const matches = asset.getAttributes(p);
            for (const m of matches) {
              values.push(m.value);
              count++;
            }
          }
          result = values;
        }

        if (node.propertyType === "flow") {
          node.context().flow.set(node.property, result);
        } else if (node.propertyType === "global") {
          node.context().global.set(node.property, result);
        } else {
          RED.util.setMessageProperty(msg, node.property, result, true);
        }

        node.status({ fill: "green", shape: "dot", text: `read ${count} items` });
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "dot", text: err.message });
        done(err);
      }
    });
  }

  RED.nodes.registerType("kufayeka-asset-multi-read", AssetMultiReadNode);
};
