const { AssetSchemaService } = require("./AssetSchemaService");
const { AssetStoreIndex } = require("./AssetStoreIndex");

function normalizeAssetSection(input) {
  return new AssetSchemaService().normalizeSection(input || {});
}

function createAssetStore(initialSection, options) {
  options = options || {};
  const templateService = new AssetSchemaService();
  const initialState = templateService.normalizeSection(initialSection || {});
  let revision = 0;
  let updatedAt = new Date().toISOString();
  const listeners = new Set();
  const index = new AssetStoreIndex(initialState, templateService);

  // Wires attribute-template calculation scripts into the write path. Kept optional so stores
  // created without a scriptEngine (most tests, and any embedding that doesn't need this
  // feature) behave exactly as before.
  if (options.scriptEngine) {
    index.scriptRunner = (scriptCfg, assetId, attributeName, rawValue, currentValue, prevSelf) =>
      options.scriptEngine.evaluate({
        code: scriptCfg.code,
        assetId,
        attributeName,
        self: rawValue,
        current: currentValue,
        prevSelf,
        getSibling: (name) => {
          const effective = index.getEffectiveAttributeDef(assetId, name);
          return effective ? { found: true, value: effective.value } : { found: false };
        },
        setSibling: (name, val) => {
          const assetPath = index.assetPathById.get(assetId);
          if (assetPath) {
            if (options.assetController && typeof options.assetController.setAttribute === "function") {
              return options.assetController.setAttribute(`${assetPath}.${name}`, val);
            }
            const changedMatches = index.setAttribute(`${assetPath}.${name}`, val);
            if (changedMatches.length > 0) {
              emitChange({
                type: "attribute.set",
                pattern: `${assetPath}.${name}`,
                changes: changedMatches.map((item) => ({ ...item }))
              });
            }
            return changedMatches;
          }
        },
        assetController: options.assetController || null
      });
  }

  const emitChange = (change) => {
    change = change || { type: "state.replace", changes: [] };
    revision += 1;
    updatedAt = new Date().toISOString();
    const meta = { revision, updatedAt, change };
    for (const listener of listeners) {
      try {
        listener(meta);
      } catch (error) {
        console.error("asset store listener error:", error);
      }
    }
  };

  return {
    getState() {
      return index.getState();
    },
    getSnapshot() {
      return { state: index.getState(), revision, updatedAt };
    },
    getRevision() {
      return revision;
    },
    getUpdatedAt() {
      return updatedAt;
    },
    getHistorianTargets() {
      return index.getHistorianTargets();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replace(nextState) {
      const normalizedNext = templateService.normalizeSection(nextState);
      const replaced = index.replaceState(normalizedNext);
      const changed = replaced.changedMatches;
      if (changed.length > 0) emitChange({ type: "attribute.set", pattern: "*", changes: changed });
      else emitChange({ type: "state.replace", changes: [] });
      return index.getState();
    },
    // Applies a schema-only section (attributeTemplates + asset structure, e.g. from a
    // deployed config node) while preserving whatever live attribute VALUES are already
    // held in memory for matching asset ids. Unlike replace(), this never wipes runtime
    // tag values just because the flow (structure) was redeployed.
    applySchema(schemaSection) {
      schemaSection = schemaSection || {};
      const rawAssets = (schemaSection.assets || []).map((assetDef) => {
        const existingLive = index.assetById.get(assetDef.id);
        const preservedValues =
          existingLive && existingLive.attributes && Object.keys(existingLive.attributes).length ? existingLive.attributes : {};
        return { ...assetDef, attributes: preservedValues };
      });
      const normalizedNext = templateService.normalizeSection({
        assets: rawAssets,
        attributeTemplates: schemaSection.attributeTemplates,
        historians: schemaSection.historians
      });
      const replaced = index.replaceState(normalizedNext);
      emitChange({ type: "schema.applied", changes: replaced.changedMatches });
      return index.getState();
    },
    query(pathValue) {
      return index.query(pathValue);
    },
    getAttribute(pathValue, defaultValue) {
      return index.getValue(pathValue, defaultValue);
    },
    getValue(pathValue, defaultValue) {
      return index.getValue(pathValue, defaultValue);
    },
    getAttributes(pathValue) {
      return index.getAttributes(pathValue);
    },
    setAttribute(pathValue, value) {
      const changedMatches = index.setAttribute(pathValue, value);
      // getLastWriteBatch() covers this write PLUS any "watch"-mode attributes that cascaded off
      // it (e.g. writing `a` also recomputes a sibling `result = a * b`) — broadcast all of it, not
      // just what the caller explicitly asked to write, so live monitors/subscribers never see a
      // stale derived value.
      const fullBatch = index.getLastWriteBatch();
      if (fullBatch.length > 0) {
        emitChange({
          type: "attribute.set",
          pattern: pathValue,
          changes: fullBatch.map((item) => ({ ...item }))
        });
      }
      return changedMatches;
    },
    setAttributes(items) {
      items = items || [];
      const results = index.setAttributes(items);
      const fullBatch = index.getLastWriteBatch();
      if (fullBatch.length > 0) {
        emitChange({
          type: "attribute.set",
          pattern: results.length === 1 ? results[0].path : "__batch__",
          changes: fullBatch.map((item) => ({ ...item }))
        });
      }
      return results;
    },
    findAttributesByValue(pathValue, expectedValue, options) {
      return index.findAttributesByValue(pathValue, expectedValue, options);
    },
    getHierarchy(options) {
      return index.getHierarchy(options);
    },
    // --- Attribute-template calculation script support ---
    listScriptedAttributes() {
      return index.listScriptedAttributes();
    },
    getPendingRawValue(assetId, attributeName) {
      return index.getPendingRawValue(assetId, attributeName);
    },
    getSiblingValue(assetId, attributeName) {
      const effective = index.getEffectiveAttributeDef(assetId, attributeName);
      return effective ? { found: true, value: effective.value } : { found: false };
    },
    getLastSelf(assetId, attributeName) {
      return index.getLastSelf(assetId, attributeName);
    },
    setLastSelf(assetId, attributeName, value) {
      index.setLastSelf(assetId, attributeName, value);
    },
    commitComputedValue(assetId, attributeName, value) {
      const match = index.commitComputedValue(assetId, attributeName, value);
      const fullBatch = index.getLastWriteBatch();
      if (fullBatch.length > 0) {
        emitChange({ type: "attribute.set", pattern: match ? match.path : "", changes: fullBatch.map((item) => ({ ...item })) });
      } else if (match) {
        emitChange({ type: "attribute.set", pattern: match.path, changes: [{ ...match }] });
      }
      return match;
    },
    get index() {
      return index;
    },
    get attributeByPath() {
      return index.attributeByPath;
    },
    get assetByPath() {
      return index.assetByPath;
    }
  };
}

module.exports = {
  createAssetStore,
  normalizeAssetSection
};
