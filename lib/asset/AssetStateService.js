const { AssetSchemaService } = require("./AssetSchemaService");
const { AssetStoreRepository } = require("./AssetStoreRepository");

class AssetStateService {
  constructor(RED, storeOptions) {
    this.RED = RED;
    this.schemaService = new AssetSchemaService();
    this.repository = new AssetStoreRepository(RED, storeOptions);
  }

  initialize(initialSection) {
    return this.repository.ensureStore(initialSection);
  }

  replaceState(nextState, persist) {
    const normalized = this.schemaService.normalizeSection(nextState || {});
    const store = this.initialize(normalized);
    const result = store.replace(normalized);
    if (persist === true) {
      this.repository.savePersistedSection(result);
    }
    return result;
  }

  // Deploy-time entry point for a schema-carrying config node: applies asset structure
  // and attribute templates while preserving whatever live values are already in memory.
  applySchema(schemaSection) {
    const store = this.initialize();
    return store.applySchema(schemaSection || {});
  }

  getStore() {
    return this.repository.getStore();
  }

  getState() {
    const store = this.getStore();
    return store ? store.getState() : null;
  }

  persistCurrentState() {
    this.repository.flushSave();
  }
}

module.exports = {
  AssetStateService
};
