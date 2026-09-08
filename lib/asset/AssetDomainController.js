const { AssetStateService } = require("./AssetStateService");
const { AttributeScriptEngine } = require("./AttributeScriptEngine");

/**
 * Public facade for the asset domain.
 * Exposes all read/write/query/hierarchy operations.
 */
class AssetDomainController {
  constructor(RED) {
    this.domain = "asset";
    this.RED = RED;
    // Shared by every store this controller ever creates so compiled scripts are cached once,
    // and passed as `assetController` so scripts can use `%Path.To.Asset.attr` absolute access.
    this.scriptEngine = new AttributeScriptEngine();
    this.stateService = new AssetStateService(RED, { scriptEngine: this.scriptEngine, assetController: this });
  }

  initialize(initialSection) {
    return this.stateService.initialize(initialSection);
  }

  replaceState(nextState, persist) {
    return this.stateService.replaceState(nextState, persist);
  }

  applySchema(schemaSection) {
    return this.stateService.applySchema(schemaSection);
  }

  getStore() {
    return this.stateService.getStore();
  }

  getState() {
    return this.stateService.getState();
  }

  persist() {
    this.stateService.persistCurrentState();
  }

  query(pathValue) {
    return this.requireStore().query(pathValue);
  }

  get(pathValue, defaultValue) {
    return this.requireStore().getValue(pathValue, defaultValue);
  }

  getValue(pathValue, defaultValue) {
    return this.requireStore().getValue(pathValue, defaultValue);
  }

  getAll(pathValue) {
    return this.requireStore().getAttributes(pathValue);
  }

  getAttributes(pathValue) {
    return this.requireStore().getAttributes(pathValue);
  }

  set(pathValue, value) {
    return this.requireStore().setAttribute(pathValue, value);
  }

  setAttribute(pathValue, value) {
    return this.requireStore().setAttribute(pathValue, value);
  }

  setMany(items) {
    return this.requireStore().setAttributes(items);
  }

  setAttributes(items) {
    return this.requireStore().setAttributes(items);
  }

  findByValue(pathValue, expectedValue, options) {
    return this.requireStore().findAttributesByValue(pathValue, expectedValue, options);
  }

  findAttributesByValue(pathValue, expectedValue, options) {
    return this.requireStore().findAttributesByValue(pathValue, expectedValue, options);
  }

  hierarchy(options) {
    return this.requireStore().getHierarchy(options);
  }

  getHierarchy(options) {
    return this.requireStore().getHierarchy(options);
  }

  subscribe(listener) {
    return this.requireStore().subscribe(listener);
  }

  requireStore() {
    let store = this.getStore();
    if (!store) {
      store = this.initialize();
    }
    return store;
  }
}

module.exports = {
  AssetDomainController
};
