// kufayeka-sparkplug-edge-node is a CONFIG node — Node-RED never shows
// config nodes in the palette and never gives them a box on the canvas, so
// there is no way to create or even SEE one without some regular node
// referencing it (exactly how core's "mqtt in"/"mqtt out" are what actually
// let you create/see an "mqtt-broker" config node). This node is that
// reference point for kufayeka-sparkplug-edge-node: drop it on any flow tab,
// pick (or "Add new...") an Edge Node config in its edit dialog, deploy —
// its box then mirrors that Edge Node's live connection status.
module.exports = function (RED) {
  function SparkplugStatusNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    var edgeNode = RED.nodes.getNode(config.edgeNode);

    if (!edgeNode) {
      node.status({ fill: "red", shape: "ring", text: "no Edge Node config selected" });
      return;
    }

    function mirrorStatus(status) {
      node.status(status);
    }
    edgeNode.on("sparkplug-status", mirrorStatus);

    node.on("close", function (done) {
      edgeNode.removeListener("sparkplug-status", mirrorStatus);
      done();
    });
  }

  RED.nodes.registerType("kufayeka-sparkplug-status", SparkplugStatusNode);
};
