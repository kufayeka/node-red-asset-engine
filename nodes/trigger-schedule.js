const { scheduleTask } = require("cronosjs");

/**
 * Centralized schedule config node — one shared clock, many consumers (attribute calculation
 * scripts, and potentially other flow nodes) subscribe to its "trigger" event instead of each
 * running their own independent setInterval/cronosjs job. Scheduling semantics (repeat in
 * seconds, or a crontab expression covering both "interval between times" and "at specific
 * times") and the runtime logic itself are a direct port of node-red's own inject node
 * (packages/node_modules/@node-red/nodes/core/common/20-inject.js) so behavior — including
 * DST/day-of-week handling via cronosjs — matches exactly.
 */
module.exports = function(RED) {
  function TriggerScheduleNode(n) {
    RED.nodes.createNode(this, n);
    const node = this;

    node.repeat = n.repeat;
    node.crontab = n.crontab;
    node.once = n.once;
    node.onceDelay = (n.onceDelay || 0.1) * 1000;
    node.intervalId = null;
    node.cronJob = null;
    node.onceTimeout = null;

    // Broadcast on RED.events (process-wide, always available) instead of requiring consumers
    // to hold a live reference via RED.nodes.getNode(id) — that made every consumer's setup
    // order-dependent on this exact node already being constructed, which frequently wasn't the
    // case (config nodes and the flows that reference them get constructed in no guaranteed
    // order). A consumer only needs this node's ID (already known from its own config) to listen
    // on "kufayeka-trigger-schedule:<id>", so subscribing never depends on this node existing yet.
    function fire() {
      const payload = { ts: Date.now() };
      node.emit("trigger", payload);
      if (RED.events) {
        RED.events.emit("kufayeka-trigger-schedule:" + node.id, payload);
      }
      if (RED.comms && RED.comms.publish) {
        RED.comms.publish("kufayeka/schedule/" + node.id, payload);
        RED.comms.publish("kufayeka-trigger-schedule/" + node.id, payload);
      }
    }

    node.repeaterSetup = function() {
      const repeatSec = Number(node.repeat);
      if (!isNaN(repeatSec) && repeatSec > 0) {
        node.intervalId = setInterval(fire, repeatSec * 1000);
      } else if (node.crontab) {
        try {
          node.cronJob = scheduleTask(node.crontab, fire);
        } catch (err) {
          node.error(`Invalid schedule: ${err.message}`);
        }
      }
    };

    function startOnce() {
      node.onceTimeout = setTimeout(function() {
        fire();
        node.repeaterSetup();
      }, node.onceDelay);
    }

    if (node.once) {
      // Don't start the countdown immediately at construction time — a short onceDelay can
      // elapse and fire "trigger" before every consumer (a kufayeka-inject node, or an
      // attribute's shared-trigger scheduler) has finished constructing and attached its
      // listener, silently losing the only fire since "once" never repeats. Wait until the
      // whole flow has finished starting instead, so every listener is guaranteed attached.
      if (RED.events) {
        RED.events.once("flows:started", startOnce);
      } else {
        startOnce();
      }
    } else {
      node.repeaterSetup();
    }

    node.on("close", function() {
      if (RED.events) RED.events.removeListener("flows:started", startOnce);
      if (node.onceTimeout) clearTimeout(node.onceTimeout);
      if (node.intervalId) clearInterval(node.intervalId);
      if (node.cronJob && typeof node.cronJob.stop === "function") node.cronJob.stop();
    });
  }

  RED.nodes.registerType("kufayeka-trigger-schedule", TriggerScheduleNode);
};
