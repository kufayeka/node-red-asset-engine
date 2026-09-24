const fs = require("fs");
const path = require("path");
const { createAssetStore } = require("./AssetStoreFactory");
const { AssetSchemaService } = require("./AssetSchemaService");

class AssetStoreRepository {
  constructor(RED, storeOptions) {
    this.RED = RED;
    this.storeOptions = storeOptions || {};
    this.schemaService = new AssetSchemaService();
    this.store = null;
    this.storagePath = null;
    this.saveTimer = null;
    this.saveFirstPendingAt = 0;
    this.unsubscribe = null;
    this.debounceMs = 400;
    // A plain trailing debounce never fires while something keeps changing faster than
    // debounceMs (a 100ms timer, a PLC poll...) -- values were then never persisted at all
    // (observed: assets.json ~10h stale on a running system). Cap the wait instead.
    this.maxSaveWaitMs = 2000;

    this.initProcessHooks();
  }

  getStoragePath() {
    if (this.storagePath && fs.existsSync(path.dirname(this.storagePath))) {
      return this.storagePath;
    }
    if (this.RED && this.RED.settings && this.RED.settings.assetStoragePath) {
      this.storagePath = this.RED.settings.assetStoragePath;
    } else if (this.RED && this.RED.settings && this.RED.settings.userDir) {
      this.storagePath = path.join(this.RED.settings.userDir, "assets.json");
    } else {
      const dataDir = path.join(process.cwd(), "data");
      if (fs.existsSync(dataDir)) {
        this.storagePath = path.join(dataDir, "assets.json");
      } else {
        this.storagePath = path.join(process.cwd(), "assets.json");
      }
    }
    return this.storagePath;
  }

  loadPersistedSection() {
    const filePath = this.getStoragePath();
    if (!filePath) return { assets: [], attributeTemplates: [], historians: [] };
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        if (content && content.trim()) {
          const parsed = JSON.parse(content);
          if (this.RED && this.RED.log) {
            this.RED.log.info(`[kufayeka-asset-engine] Loaded persisted assets & values from ${filePath}`);
          }
          return parsed;
        }
      }
    } catch (err) {
      if (this.RED && this.RED.log) {
        this.RED.log.warn(`[kufayeka-asset-engine] Failed to load ${filePath}: ${err.message}`);
      }
    }
    return { assets: [], attributeTemplates: [], historians: [] };
  }

  savePersistedSection(section) {
    // Synchronous by design: only used on the shutdown/flush path, where the
    // process may exit immediately after and an async write could be lost.
    const filePath = this.getStoragePath();
    if (!filePath) return;
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify(section, null, 2);
      fs.writeFileSync(tempPath, data, "utf-8");

      let renamed = false;
      let lastErr = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.renameSync(tempPath, filePath);
          renamed = true;
          break;
        } catch (err) {
          lastErr = err;
          if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
            const start = Date.now();
            while (Date.now() - start < (attempt + 1) * 25) { /* spin wait */ }
          } else {
            break;
          }
        }
      }

      if (!renamed) {
        try {
          fs.copyFileSync(tempPath, filePath);
          try { fs.unlinkSync(tempPath); } catch (e) {}
        } catch (copyErr) {
          try { fs.unlinkSync(tempPath); } catch (e) {}
          throw lastErr || copyErr;
        }
      }
    } catch (err) {
      if (this.RED && this.RED.log) {
        this.RED.log.error(`[kufayeka-asset-engine] Failed to save ${filePath}: ${err.message}`);
      }
    }
  }

  savePersistedSectionAsync(section) {
    // Non-blocking: used on the hot debounce path so serializing/writing a large
    // asset state can never stall the event loop that concurrent tag reads/writes run on.
    const filePath = this.getStoragePath();
    if (!filePath) return Promise.resolve();

    if (!this.writeQueue) {
      this.writeQueue = Promise.resolve();
    }

    this.writeQueue = this.writeQueue.then(async () => {
      const dir = path.dirname(filePath);
      const data = JSON.stringify(section, null, 2);
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;

      try {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(tempPath, data, "utf-8");

        let renamed = false;
        let lastError = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await fs.promises.rename(tempPath, filePath);
            renamed = true;
            break;
          } catch (err) {
            lastError = err;
            if (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES") {
              await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 30));
            } else {
              break;
            }
          }
        }

        if (!renamed) {
          try {
            await fs.promises.copyFile(tempPath, filePath);
            await fs.promises.unlink(tempPath).catch(() => {});
          } catch (copyErr) {
            await fs.promises.unlink(tempPath).catch(() => {});
            throw lastError || copyErr;
          }
        }
      } catch (err) {
        if (this.RED && this.RED.log) {
          this.RED.log.error(`[kufayeka-asset-engine] Failed to save ${filePath}: ${err.message}`);
        }
      }
    }).catch(() => {});

    return this.writeQueue;
  }

  // Debounced (debounceMs after the last change), but never later than maxSaveWaitMs after
  // the FIRST unsaved change -- so a continuously changing store still saves every ~2s.
  scheduleDebouncedSave() {
    const now = Date.now();
    if (this.saveTimer) {
      if (now - this.saveFirstPendingAt >= this.maxSaveWaitMs) return; // due: let it fire
      clearTimeout(this.saveTimer);
    } else {
      this.saveFirstPendingAt = now;
    }
    const untilMax = this.saveFirstPendingAt + this.maxSaveWaitMs - now;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.store) {
        this.savePersistedSectionAsync(this.store.getState());
      }
    }, Math.max(0, Math.min(this.debounceMs, untilMax)));
  }

  flushSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.store) {
      this.savePersistedSection(this.store.getState());
    }
  }

  initProcessHooks() {
    this.flushHandler = () => this.flushSave();

    if (this.RED && this.RED.events) {
      this.RED.events.once("flows:stopping", this.flushHandler);
      this.RED.events.once("flows:stopped", this.flushHandler);
    }

    process.once("beforeExit", this.flushHandler);
    process.once("SIGINT", this.flushHandler);
    process.once("SIGTERM", this.flushHandler);
  }

  ensureStore(initialSection) {
    if (this.store) return this.store;

    let seed = initialSection;
    if (!seed || (Array.isArray(seed.assets) && seed.assets.length === 0 && Array.isArray(seed.attributeTemplates) && seed.attributeTemplates.length === 0)) {
      seed = this.loadPersistedSection();
    }

    const normalizedSeed = this.schemaService.normalizeSection(seed || {});
    this.store = createAssetStore(normalizedSeed, this.storeOptions);

    // Auto-persist: Listen to all state/attribute mutations and debounce save to disk
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    this.unsubscribe = this.store.subscribe((meta) => {
      this.scheduleDebouncedSave();
    });

    return this.store;
  }

  getStore() {
    return this.store;
  }
}

module.exports = {
  AssetStoreRepository
};
