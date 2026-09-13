// Shared fake `mqtt` module for every Sparkplug-related spec file.
//
// This MUST be a single shared helper, not one fake-install per spec file:
// nodes/sparkplug-edge-node.js's own top-level `const mqtt = require("mqtt")`
// is evaluated exactly ONCE per mocha process (Node's require cache is keyed
// by absolute path, shared across every spec file) — whichever spec file
// mocha happens to require FIRST "wins" that one evaluation, permanently
// closing over whatever `mqtt` was in require.cache at that moment. A
// second spec file installing its OWN separate fake (with its own separate
// tracking variable) has no effect on the ALREADY-cached module — its own
// "lastFakeClient" would just stay null forever while the real client
// instances go to the FIRST spec file's fake instead, surfacing as
// "Cannot read properties of null" inside a nested async callback, which
// mocha only sees as a timeout. Discovered exactly this way, the hard way.
const { EventEmitter } = require("events");

class FakeMqttClient extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    // Real mqtt.Client stores connect options as `.options`, not `.opts` —
    // and reads `.options.will` fresh on every (re)connect, which is
    // exactly what nodes/sparkplug-edge-node.js's "reconnect" handler
    // relies on when it mutates `client.options.will.payload` to carry a
    // freshly-bumped bdSeq into the NEXT session's Will registration.
    this.options = opts;
    this.connected = false;
    this.published = []; // [{topic, payload (Buffer), opts}]
    this.subscriptions = []; // [[topic,...]]
    this.ended = false;
  }
  publish(topic, payload, opts, cb) {
    this.published.push({ topic: topic, payload: payload, opts: opts });
    if (typeof cb === "function") cb();
  }
  subscribe(topics, opts, cb) {
    this.subscriptions.push(topics);
    if (typeof cb === "function") cb(null);
  }
  end(force, opts, cb) {
    this.ended = true;
    if (typeof cb === "function") cb();
  }
  simulateConnect() {
    this.connected = true;
    this.emit("connect");
  }
  // Mirrors mqtt.js's own _reconnect(): emits "reconnect" (giving listeners
  // a chance to mutate this.options.will before the next session's CONNECT
  // is built from it), THEN "connect" for the new session — a real dropped
  // connection is always a "reconnect" followed by a fresh "connect", never
  // just the latter.
  simulateReconnect() {
    this.emit("reconnect");
    this.connected = true;
    this.emit("connect");
  }
  simulateMessage(topic, buffer) {
    this.emit("message", topic, buffer);
  }
}

var lastFakeClient = null;
const mqttModulePath = require.resolve("mqtt");
require.cache[mqttModulePath] = {
  id: mqttModulePath,
  filename: mqttModulePath,
  loaded: true,
  exports: {
    connect: function (url, opts) {
      lastFakeClient = new FakeMqttClient(url, opts);
      return lastFakeClient;
    }
  }
};

module.exports = {
  FakeMqttClient: FakeMqttClient,
  getLastFakeClient: function () { return lastFakeClient; },
  resetLastFakeClient: function () { lastFakeClient = null; }
};
