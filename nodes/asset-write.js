const { getAssetController } = require("../lib/asset-plugin");

module.exports = function(RED) {
  function AssetWriteNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.path = config.path || "";
    node.property = config.property || "payload";
    node.propertyType = config.propertyType || "msg";

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

      RED.util.evaluateNodeProperty(node.property, node.propertyType, node, msg, (err, val) => {
        if (err) {
          node.status({ fill: "red", shape: "dot", text: err.message });
          return done(err);
        }

        try {
          const changed = asset.setAttribute(targetPath, val);
          msg._assetChanged = changed;
          node.status({ fill: "green", shape: "dot", text: `${targetPath} = ${typeof val === "object" ? "JSON" : val}` });
          send(msg);
          done();
        } catch (setErr) {
          node.status({ fill: "red", shape: "dot", text: setErr.message });
          done(setErr);
        }
      });
    });
  }

  RED.nodes.registerType("kufayeka-asset-write", AssetWriteNode);
};
