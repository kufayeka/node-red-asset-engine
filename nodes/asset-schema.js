const { getAssetController } = require("../lib/asset-plugin");

module.exports = function(RED) {
  function AssetSchemaNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    let hasSpaces = false;

    const rawTemplates = Array.isArray(config.attributeTemplates) ? config.attributeTemplates : [];
    const rawAssets = Array.isArray(config.assets) ? config.assets : [];

    node.attributeTemplates = rawTemplates.map((t) => {
      const tpl = { ...t };
      if (tpl.name && /\s/.test(tpl.name)) hasSpaces = true;
      tpl.name = String(tpl.name || "").replace(/\s+/g, "_");
      if (Array.isArray(tpl.attributes)) {
        tpl.attributes = tpl.attributes.map((attr) => {
          const a = { ...attr };
          if (a.name && /\s/.test(a.name)) hasSpaces = true;
          a.name = String(a.name || "").replace(/\s+/g, "_");
          return a;
        });
      }
      return tpl;
    });

    node.assets = rawAssets.map((a) => {
      const asset = { ...a };
      if (asset.name && /\s/.test(asset.name)) hasSpaces = true;
      asset.name = String(asset.name || "").replace(/\s+/g, "_");
      return asset;
    });

    node.historians = Array.isArray(config.historians) ? config.historians : [];

    if (hasSpaces && RED.log) {
      RED.log.warn(
        `[kufayeka-asset-engine] Warning: Detected spaces in asset/template/attribute names in schema '${node.name || node.id}'. Automatically replaced spaces with underscores (_).`
      );
    }

    const asset = RED.asset || getAssetController(RED);
    if (asset) {
      asset.applySchema({
        attributeTemplates: node.attributeTemplates,
        assets: node.assets,
        historians: node.historians
      });
      if (RED.log) {
        RED.log.info(
          `[kufayeka-asset-engine] Applied asset schema from config node '${node.name || node.id}' ` +
            `(${node.assets.length} assets, ${node.attributeTemplates.length} templates)`
        );
      }
    }
  }

  RED.nodes.registerType("kufayeka-asset-schema", AssetSchemaNode);
};
