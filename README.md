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

---

## 🚀 Installation

Install directly into your Node-RED user directory (typically `~/.node-red`):

```bash
cd ~/.node-red
npm install @kufayeka/node-red-asset-engine
```

Or install via Node-RED Palette Manager.

---

## 🧪 Running Tests

```bash
npm test
```

---

## 📄 License

MIT © Kufayeka
