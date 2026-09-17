// Shared fake worker_threads.Worker for nodes/sparkplug-edge-node.js specs.
//
// This MUST be a single shared helper, not one fake-install per spec file —
// same reasoning as test/helpers/fakeMqtt.js: nodes/sparkplug-edge-node.js's
// own module-level `workerFactory` override is installed exactly ONCE per
// mocha process (Node's require cache is keyed by absolute path, shared
// across every spec file). test/nodes/sparkplug-edge-node_spec.js and
// test/nodes/sparkplug-status_spec.js both load a real Edge Node and need to
// reach whichever FakeWorker instance it just created — a second spec file
// installing its OWN separate override would just never see the instances
// the OTHER file's tests create.
const { EventEmitter } = require("events");
const edgeNodeModule = require("../../nodes/sparkplug-edge-node.js");

class FakeWorker extends EventEmitter {
  constructor(workerData) {
    super();
    this.workerData = workerData;
    this.posted = []; // every {type, ...} message posted TO this worker
    this.terminated = false;
  }
  postMessage(msg) { this.posted.push(msg); }
  terminate() { this.terminated = true; return Promise.resolve(); }
  simulateStatus(status, detail) { this.emit("message", { type: "status", status: status, detail: detail }); }
  simulateNcmd(metrics) { this.emit("message", { type: "ncmd", metrics: metrics }); }
  simulateDcmd(deviceId, metrics) { this.emit("message", { type: "dcmd", deviceId: deviceId, metrics: metrics }); }
  simulatePrimaryHostState(online, timestamp) {
    this.emit("message", { type: "primary-host-state", online: online, timestamp: timestamp === undefined ? null : timestamp });
  }
}

var lastFakeWorker = null;
edgeNodeModule._setWorkerFactoryForTests(function (workerData) {
  lastFakeWorker = new FakeWorker(workerData);
  return lastFakeWorker;
});

module.exports = {
  FakeWorker: FakeWorker,
  getLastFakeWorker: function () { return lastFakeWorker; },
  resetLastFakeWorker: function () { lastFakeWorker = null; }
};
