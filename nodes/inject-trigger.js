/**
 * Thin flow node that just forwards a shared kufayeka-trigger-schedule's broadcast as a msg — it
 * never runs its own timer. Listens on RED.events (process-wide) keyed by the schedule's node ID
 * instead of holding a live RED.nodes.getNode(id) reference, so it works regardless of whether
 * the referenced schedule node has been constructed yet (config nodes and the nodes that
 * reference them are constructed in no guaranteed order). Multiple of these — and attribute
 * calculation scripts using the "sharedTrigger" mode — can all reference the SAME schedule ID so
 * they fire from the identical clock tick, exactly like the built-in inject node except
 * centralized.
 */
module.exports = function(RED) {
  function KufayekaInjectNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.topic = config.topic || "";

    if (!config.schedule) {
      node.status({ fill: "red", shape: "ring", text: "no schedule selected" });
      return;
    }

    node.status({ fill: "grey", shape: "ring", text: "waiting" });

    const channel = "kufayeka-trigger-schedule:" + config.schedule;
    const onTrigger = () => {
      node.status({ fill: "green", shape: "dot", text: "triggered " + new Date().toLocaleTimeString() });
      node.send({ payload: Date.now(), topic: node.topic });
    };
    RED.events.on(channel, onTrigger);

    node.on("close", function() {
      RED.events.removeListener(channel, onTrigger);
    });
  }

  RED.nodes.registerType("kufayeka-inject", KufayekaInjectNode);
};
