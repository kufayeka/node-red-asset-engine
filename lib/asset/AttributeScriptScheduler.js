/**
 * Subscribes attribute calculation scripts to centralized `kufayeka-trigger-schedule`
 * broadcasts on RED.events.
 *
 * All internal interval, cron, and repeat timers have been removed from this scheduler
 * because timing is 100% centralized in the shared trigger-schedule config nodes.
 */
class AttributeScriptScheduler {
  constructor(getStore, scriptEngine, assetController, RED) {
    this.getStore = getStore;
    this.scriptEngine = scriptEngine;
    this.assetController = assetController;
    this.RED = RED || null;
    this.listeners = new Map(); // key -> { channel, listener }
  }

  rebuild() {
    this.teardown();
    const store = this.getStore();
    if (!store || typeof store.listScriptedAttributes !== "function") return;

    const scripted = store.listScriptedAttributes();
    console.log(`[kufayeka-asset-engine] Scheduler rebuild: ${scripted.length} scheduled attribute(s) — ${scripted.map((s) => s.path).join(", ") || "(none)"}`);

    for (const item of scripted) {
      const trigger = item.script.trigger || {};
      const scheduleId = trigger.scheduleId || trigger.triggerNodeId || trigger.schedule;
      if (!scheduleId) continue;

      const key = `${item.assetId}:${item.attributeName}`;
      const fireScheduled = () => this.runTrigger(store, item);

      if (this.RED && this.RED.events) {
        const channel = "kufayeka-trigger-schedule:" + scheduleId;
        this.RED.events.on(channel, fireScheduled);
        this.listeners.set(key, { channel, listener: fireScheduled });
      } else {
        console.warn(`[kufayeka-asset-engine] RED.events unavailable — cannot subscribe ${item.path} to schedule '${scheduleId}'`);
      }
    }
  }

  runTrigger(store, item, options) {
    options = options || {};
    const trigger = (item.script && item.script.trigger) || {};
    // runPolicy: "always" (default, continuous calculation on schedule) | "onlyOnWrite" (only when new raw write arrived)
    const runPolicy = trigger.runPolicy || (options.allowDefaultSelf !== undefined ? (options.allowDefaultSelf ? "always" : "onlyOnWrite") : "always");

    const pending = store.getPendingRawValue(item.assetId, item.attributeName);
    const currentValue = store.getSiblingValue(item.assetId, item.attributeName);

    let selfValue;
    if (pending) {
      selfValue = pending.value;
      if (typeof store.clearPendingRawValue === "function") {
        store.clearPendingRawValue(item.assetId, item.attributeName);
      }
    } else if (runPolicy === "always") {
      selfValue = currentValue.found ? currentValue.value : undefined;
    } else {
      return; // onlyOnWrite policy: skip since no pending write arrived
    }

    const prevSelfEntry = store.getLastSelf(item.assetId, item.attributeName);
    try {
      const computed = this.scriptEngine.evaluate({
        code: item.script.code,
        assetId: item.assetId,
        attributeName: item.attributeName,
        self: selfValue,
        current: currentValue.found ? currentValue.value : undefined,
        prevSelf: prevSelfEntry.found ? prevSelfEntry.value : undefined,
        getSibling: (name) => store.getSiblingValue(item.assetId, name),
        setSibling: (name, val) => {
          const assetPath = store.index ? store.index.assetPathById.get(item.assetId) : null;
          if (assetPath) {
            if (this.assetController && typeof this.assetController.setAttribute === "function") {
              return this.assetController.setAttribute(`${assetPath}.${name}`, val);
            }
            return store.setAttribute(`${assetPath}.${name}`, val);
          }
        },
        assetController: this.assetController
      });
      store.commitComputedValue(item.assetId, item.attributeName, computed);
      if (selfValue !== undefined) {
        store.setLastSelf(item.assetId, item.attributeName, selfValue);
      }
    } catch (err) {
      if (selfValue !== undefined) {
        store.setLastSelf(item.assetId, item.attributeName, selfValue);
      }
      console.error(`[kufayeka-asset-engine] Script error for ${item.path}: ${err.message}`);
    }
  }

  teardown() {
    if (this.RED && this.RED.events) {
      for (const { channel, listener } of this.listeners.values()) {
        this.RED.events.removeListener(channel, listener);
      }
    }
    this.listeners.clear();
  }
}

module.exports = { AttributeScriptScheduler };
