// Asset engine capacity benchmark — how many attributes, and how many value
// changes per second, one asset store sustains on THIS machine.
//
//   node bench/capacity.js                 # default sizes
//   node bench/capacity.js 1000 50000      # custom attribute counts
//
// Model: N attributes = N/100 assets x 100 attributes (one template), the same
// shape a PLC gateway produces (one asset per device, D0..D99). Measured per
// size, all on the main thread, with the real script engine and one change
// listener attached (what the runtime plugin subscribes):
//   load     - createAssetStore() time and heap after load
//   write    - sustained changes/s for 3s, written as batches of B changes
//              (B = 1 and B = 10: "one DCMD / one PLC scan with B changed tags"),
//              plus per-batch latency p50/p99
//   save     - one persistence pass exactly as AssetStoreRepository does it:
//              getState() + JSON.stringify(section, null, 2) — both synchronous,
//              so this is also the longest main-thread stall a save causes
// Not included: MQTT/Sparkplug encode+publish, editor comms, Nexa, disk I/O,
// flows. Those are separate costs on top (see README / end-to-end benchmark).
"use strict";

const os = require("os");
const { createAssetStore } = require("../lib/asset/AssetStoreFactory");
const { AttributeScriptEngine } = require("../lib/asset/AttributeScriptEngine");

const ATTRS_PER_ASSET = 100;
const RUN_MS = 3000;
const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const SIZES = sizes.length ? sizes : [1000, 10000, 50000, 100000, 200000];

function mb(bytes) { return (bytes / 1048576).toFixed(0); }
function pct(sorted, q) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]; }

function build(nAttrs) {
  const nAssets = Math.max(1, Math.round(nAttrs / ATTRS_PER_ASSET));
  const attributes = [];
  for (let i = 0; i < ATTRS_PER_ASSET; i++) attributes.push({ name: "D" + i, valueType: "number", default: 0 });
  const assets = [];
  for (let d = 0; d < nAssets; d++) assets.push({ id: "a" + d, name: "Dev" + d, parentId: null, templateIds: ["t"] });
  const paths = [];
  for (let d = 0; d < nAssets; d++) { const p = []; for (let i = 0; i < ATTRS_PER_ASSET; i++) p.push("Dev" + d + ".D" + i); paths.push(p); }
  return { nAssets, section: { attributeTemplates: [{ id: "t", name: "Plc", attributes }], assets }, paths };
}

function sustained(store, paths, nAssets, batch) {
  const lat = [];
  let changes = 0, k = 0, dev = 0;
  const t0 = process.hrtime.bigint();
  const end = t0 + BigInt(RUN_MS) * 1000000n;
  for (;;) {
    const now = process.hrtime.bigint();
    if (now >= end) break;
    const items = new Array(batch);
    const base = (k * 7) % (ATTRS_PER_ASSET - batch + 1);
    for (let i = 0; i < batch; i++) items[i] = { path: paths[dev][base + i], value: k + i };
    const b0 = process.hrtime.bigint();
    store.setAttributes(items);
    lat.push(Number(process.hrtime.bigint() - b0) / 1000);
    changes += batch; k++; dev = (dev + 1) % nAssets;
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  lat.sort((a, b) => a - b);
  return { perSec: Math.round(changes / secs), p50: pct(lat, 0.5), p99: pct(lat, 0.99) };
}

function main() {
  const cpu = os.cpus();
  console.log(`# ${cpu[0].model.trim()} | ${cpu.length} threads | ${(os.totalmem() / 1073741824).toFixed(1)} GB RAM | Node ${process.version} | ${os.platform()}`);
  console.log(`# one asset store on one thread; ${ATTRS_PER_ASSET} attributes per asset; ${RUN_MS / 1000}s per write run\n`);
  console.log("| attributes | assets | load ms | heap MB | changes/s (batch 1) | p99 µs | changes/s (batch 10) | p99 µs | save: getState+stringify ms | save size MB |");
  console.log("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const n of SIZES) {
    if (global.gc) global.gc();
    const { nAssets, section, paths } = build(n);
    const l0 = process.hrtime.bigint();
    const store = createAssetStore(section, { scriptEngine: new AttributeScriptEngine() });
    const loadMs = Number(process.hrtime.bigint() - l0) / 1e6;
    let events = 0;
    store.subscribe(() => { events++; });
    if (global.gc) global.gc();
    const heap = process.memoryUsage().heapUsed;
    sustained(store, paths, nAssets, 10); // warm-up (JIT)
    const w1 = sustained(store, paths, nAssets, 1);
    const w10 = sustained(store, paths, nAssets, 10);
    const s0 = process.hrtime.bigint();
    const json = JSON.stringify(store.getState(), null, 2);
    const saveMs = Number(process.hrtime.bigint() - s0) / 1e6;
    console.log(`| ${n.toLocaleString("en")} | ${nAssets.toLocaleString("en")} | ${loadMs.toFixed(0)} | ${mb(heap)} | ${w1.perSec.toLocaleString("en")} | ${w1.p99.toFixed(0)} | ${w10.perSec.toLocaleString("en")} | ${w10.p99.toFixed(0)} | ${saveMs.toFixed(0)} | ${(json.length / 1048576).toFixed(1)} |`);
  }
}

main();
