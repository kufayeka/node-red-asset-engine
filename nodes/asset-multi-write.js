const { getAssetController } = require("../lib/asset-plugin");

module.exports = function(RED) {
  function AssetMultiWriteNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.rules = Array.isArray(config.rules) ? config.rules : [];

    node.on("input", function(msg, send, done) {
      send = send || function() { node.send.apply(node, arguments); };
      done = done || function(err) { if (err) node.error(err, msg); };

      const asset = RED.asset || getAssetController(RED);
      if (!asset) {
        node.status({ fill: "red", shape: "ring", text: "engine not ready" });
        return done(new Error("Asset Engine is not ready"));
      }

      // Step 1: Evaluate all configured rules asynchronously
      const evalPromises = (node.rules || []).map((rule) => {
        return new Promise((resolve, reject) => {
          const targetPath = (rule.path || "").trim();
          if (!targetPath) return resolve(null);

          RED.util.evaluateNodeProperty(
            rule.property,
            rule.propertyType || "msg",
            node,
            msg,
            (err, val) => {
              if (err) return reject(err);
              resolve({ path: targetPath, value: val });
            }
          );
        });
      });

      Promise.all(evalPromises)
        .then((evaluatedItems) => {
          const itemsToWrite = evaluatedItems.filter(Boolean);

          // Step 2: Check for dynamic writes from msg.writes or msg.batchWrites
          if (Array.isArray(msg.writes)) {
            for (const item of msg.writes) {
              if (item && item.path !== undefined && item.value !== undefined) {
                itemsToWrite.push({ path: String(item.path).trim(), value: item.value });
              }
            }
          } else if (msg.writes && typeof msg.writes === "object") {
            for (const [p, v] of Object.entries(msg.writes)) {
              itemsToWrite.push({ path: String(p).trim(), value: v });
            }
          }

          if (itemsToWrite.length === 0) {
            node.status({ fill: "yellow", shape: "dot", text: "no items to write" });
            send(msg);
            return done();
          }

          // Step 3: Perform batch update
          const results = asset.setAttributes(itemsToWrite);
          const changedMatches = [];
          for (const res of results) {
            if (res && Array.isArray(res.matches)) {
              changedMatches.push(...res.matches);
            }
          }

          msg._assetChanged = changedMatches;
          node.status({ fill: "green", shape: "dot", text: `wrote ${itemsToWrite.length} items` });
          send(msg);
          done();
        })
        .catch((err) => {
          node.status({ fill: "red", shape: "dot", text: err.message });
          done(err);
        });
    });
  }

  RED.nodes.registerType("kufayeka-asset-multi-write", AssetMultiWriteNode);
};
