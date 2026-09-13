# @kufayeka/node-red-asset-engine

> **Industrial Asset & Tag Engine Plugin with Calculation Scripts, Centralized Schedules, and Rich Edit Dialogs for Node-RED**

`@kufayeka/node-red-asset-engine` is a powerful Node-RED plugin and node suite designed for SCADA, IIoT, and industrial telemetry. It provides hierarchical asset tree management, dynamic attribute inheritance, template schemas, calculation scripts (with Monaco/Ace IntelliSense), and real-time synchronization.

---

## 🌟 Features

- **Hierarchical Asset Tree:** Model complex plants, lines, machines, and components (`Plant1.Line1.Motor1`).
- **Template Schemas:** Reusable attribute templates with inheritance and instant property resolution.
- **Attribute Calculation Scripts:**
  - Execute custom JavaScript calculations on attribute write.
  - Supports `self`, `current`, `prevSelf`, sibling attribute access (`setSibling()`, `sibling.attr`), and cross-asset `%Path` notation.
  - Calculation Trigger Modes:
    - **On Value Change:** Immediate recomputation upon incoming write.
    - **Watch Attributes:** Instant recalculation when any watched attribute changes.
    - **Trigger Schedule:** Centralized interval / crontab schedule execution.
- **Centralized Trigger Schedules:** Reusable timers for both Calculation Scripts and canvas nodes (`kufayeka-inject`).
- **Rich Sidebar Management:**
  - **Asset Manager:** Master-detail tree list with per-asset live watch monitoring and instant attribute overrides.
  - **Asset Templates:** Template and attribute schema editor.
  - **Trigger Schedules:** Centralized schedule manager.
- **Monaco & Ace IntelliSense:** Dynamic TypeScript `.d.ts` declaration generator providing real-time autocomplete for `%Path` and `$` root proxy variables.
- **Node Suite:**
  - `kufayeka-asset-schema` (Config Node)
  - `kufayeka-asset-read` & `kufayeka-asset-multi-read`
  - `kufayeka-asset-write` & `kufayeka-asset-multi-write`
  - `kufayeka-asset-watch`
  - `kufayeka-asset-function`
  - `kufayeka-inject` & `kufayeka-trigger-schedule`
  - `kufayeka-sparkplug-edge-node`, `kufayeka-sparkplug-status` & `kufayeka-sparkplug-in`
    (MQTT Sparkplug B — see **[SPARKPLUG.md](SPARKPLUG.md)** for architecture, message-flow
    diagrams, and a line-by-line spec compliance table)

---

## 🚀 Installation

Install directly into your Node-RED user directory (typically `~/.node-red`):

```bash
cd ~/.node-red
npm install @kufayeka/node-red-asset-engine
```

Or install via Node-RED Palette Manager.

---

## 🔗 Integration with Nexa Dashboard (`@kufayeka/node-red-nexa-dashboard`)

Nexa Dashboard (the drag-drop HMI/SCADA screen builder plugin in this same monorepo)
links to this engine **in-process**, via the exported `getAssetController(RED)` escape
hatch in `lib/asset-plugin.js` — never through `RED.asset` directly, since every
Node-RED plugin gets its own fresh `RED` API object and a plain property assignment like
`RED.asset = asset` would only ever be visible to the plugin that set it.

**Current status, stated plainly:** Nexa's backend subscribes once to this engine's
`subscribe(...)` change stream and republishes every change over
`RED.comms.publish("nexa/value", meta)` for potential live-preview use in the editor.
Nothing currently *consumes* that channel — there is no picker UI yet for binding a Nexa
component property to an asset tag path, even though the component contract already
reserves a `bindable` field for exactly that purpose. If you're looking for "does this
already stream a Modbus/OPC-UA tag live into an HMI screen" — not yet; see Nexa
Dashboard's own README, §10 (Known Limitations & Roadmap), for the accurate state of that
integration and what a straightforward next step looks like.

---

## 🧪 Running Tests

```bash
npm test
```

---

## 📄 License

MIT © Kufayeka
