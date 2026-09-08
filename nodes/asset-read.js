const { getAssetController } = require("../lib/asset-plugin");

module.exports = function(RED) {
  function AssetReadNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.path = config.path || "";
    node.property = config.property || "payload";
    node.propertyType = config.propertyType || "msg";
    node.outputMode = config.outputMode || "value"; // 'value' | 'attribute' | 'query'

    node.on("input", function(msg, send, done) {
      send = send || function() { node.send.apply(node, arguments); };
      done = done || function(err) { if (err) node.error(err, msg); };

      const asset = RED.asset || getAssetController(RED);
      if (!asset) {
        node.status({ fill: "red", shape: "ring", text: "engine not ready" });
        return done(new Error("Asset Engine is not ready"));
      }

      const targetPath = (msg.assetPath || msg.path || node.path || "").trim();
      if (!targetPath) {
        node.status({ fill: "yellow", shape: "dot", text: "missing path" });
        return done(new Error("No asset path specified"));
      }

      try {
        let result;
        if (node.outputMode === "attribute") {
          result = asset.getAttributes(targetPath);
          if (result.length === 1) result = result[0];
        } else if (node.outputMode === "query") {
          result = asset.query(targetPath);
        } else {
          result = asset.getValue(targetPath);
        }

        if (node.propertyType === "flow") {
          node.context().flow.set(node.property, result);
        } else if (node.propertyType === "global") {
          node.context().global.set(node.property, result);
        } else {
          RED.util.setMessageProperty(msg, node.property, result, true);
        }

        node.status({ fill: "green", shape: "dot", text: `${targetPath}: ${typeof result === "object" ? "OK" : result}` });
        send(msg);
        done();
      } catch (err) {
        node.status({ fill: "red", shape: "dot", text: err.message });
        done(err);
      }
    });
  }

  RED.nodes.registerType("kufayeka-asset-read", AssetReadNode);
};
