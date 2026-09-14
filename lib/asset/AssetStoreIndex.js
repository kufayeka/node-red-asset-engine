const { getAssetPath, matches, splitPath, valuesEqual, valuesLooselyEqual } = require("./assetDataUtils");

// Sentinel returned by resolveWriteValue() to mean "don't commit anything for this target" —
// either the raw value was staged for a timed-trigger script, or its onChange script errored.
const SKIP_WRITE = Symbol("skip-write");

/**
 * Fast O(1) in-memory lookup index for active AssetSection.
 * Owns the keyspace maps: assetById, assetByPath, attributeByPath, childrenByParentId.
 */
class AssetStoreIndex {
  constructor(initialState, templateService) {
    this.templateService = templateService;
    this.attributeTemplatesList = [];
    this.historiansList = [];
    this.templateById = new Map();
    this.assetById = new Map();
    this.assetPathEntries = [];
    this.assetPathById = new Map();
    this.assetByPath = new Map();
    this.attributeMapByAssetId = new Map();
    this.attributeByPath = new Map();
    this.childrenByParentId = new Map();

    // Raw values staged for scripted attributes whose trigger is NOT "onChange" (interval/crontab):
    // writes land here instead of the public value until the schedule fires and consumes them.
    // Keyed by `${assetId}:${attributeName}`.
    this.pendingRawByAttr = new Map();
    // The `self` used in this attribute's MOST RECENT script execution (onChange write or timed
    // trigger fire) — exposed to scripts as `prevSelf` so a single attribute can compute a delta
    // against its own previous raw reading without needing a second, companion attribute just to
    // remember "last raw value". Distinct from `current` (the previous OUTPUT/return value).
    this.lastSelfByAttr = new Map();
    // Optional (scriptCfg, assetId, attributeName, rawValue, currentValue, prevSelf) => computedValue,
    // wired by the store factory. Only consulted for attributes whose script.trigger.mode === "onChange".
    this.scriptRunner = null;

    // Reverse dependency index for "watch" mode: `${assetId}:${attributeName}` (the attribute being
    // WATCHED) -> [{ assetId, attributeName }, ...] (the attribute(s) whose script depends on it).
    // Rebuilt whenever the schema (asset/template structure) changes.
    this.watchersByKey = new Map();

    // Every (assetId, attributeName) actually committed by the MOST RECENT setAttributes()/
    // commitComputedValue() call, direct writes and "watch" cascade recomputations alike — read by
    // AssetStoreFactory right after the call so it can broadcast the FULL set of what changed, not
    // just the attribute(s) the caller explicitly asked to write.
    this.lastWriteBatch = [];

    this.rebuildAllIndexes(initialState);
  }

  getEffectiveAttributeDef(assetId, attributeName) {
    const asset = this.assetById.get(assetId);
    if (!asset) return null;
    return this.templateService.buildEffectiveAttributeForName(asset, this.templateById, attributeName) || null;
  }

  getPendingRawValue(assetId, attributeName) {
    return this.pendingRawByAttr.get(`${assetId}:${attributeName}`) || null;
  }

  clearPendingRawValue(assetId, attributeName) {
    this.pendingRawByAttr.delete(`${assetId}:${attributeName}`);
  }

  getLastSelf(assetId, attributeName) {
    const key = `${assetId}:${attributeName}`;
    if (!this.lastSelfByAttr.has(key)) return { found: false };
    return { found: true, value: this.lastSelfByAttr.get(key) };
  }

  setLastSelf(assetId, attributeName, value) {
    this.lastSelfByAttr.set(`${assetId}:${attributeName}`, value);
  }

  commitComputedValue(assetId, attributeName, value) {
    const ts = new Date().toISOString();
    const writesByAssetId = new Map([[assetId, new Map([[attributeName, { value, ts }]])]]);
    this.applyGroupedAttributeWrites(writesByAssetId);
    this.cascadeWatchTriggers(writesByAssetId);
    this.lastWriteBatch = this.collectAllWrittenAttributes(writesByAssetId);
    const assetPath = this.assetPathById.get(assetId);
    const match = assetPath ? this.attributeByPath.get(`${assetPath}.${attributeName}`) : null;
    return match ? { ...match } : null;
  }

  getLastWriteBatch() {
    return this.lastWriteBatch;
  }

  // Only "schedule"-mode attributes need a subscription to the centralized trigger-schedule
  // broadcast. "onChange" computes on its own direct writes; "watch" computes reactively off its
  // dependencies (see cascadeWatchTriggers()) — neither needs a timer.
  listScriptedAttributes() {
    const out = [];
    for (const [assetId, attrMap] of this.attributeMapByAssetId.entries()) {
      for (const [attributeName, match] of attrMap.entries()) {
        const scriptCfg = match.script;
        if (scriptCfg && scriptCfg.enabled && scriptCfg.trigger && scriptCfg.trigger.mode === "schedule") {
          out.push({ assetId, attributeName, path: match.path, script: scriptCfg });
        }
      }
    }
    return out;
  }

  getState() {
    return {
      assets: Array.from(this.assetById.values()),
      attributeTemplates: this.attributeTemplatesList,
      historians: this.historiansList
    };
  }

  getHistorianTargets() {
    return [...this.historiansList];
  }

  replaceState(nextState) {
    const previousAttributes = this.attributeByPath;
    this.rebuildAllIndexes(nextState);

    const changedMatches = [];
    for (const [path, nextMatch] of this.attributeByPath.entries()) {
      const previousMatch = previousAttributes.get(path);
      if (this.templateService.attributeMatchChanged(previousMatch, nextMatch)) {
        changedMatches.push({ ...nextMatch });
      }
    }

    return { state: this.getState(), changedMatches };
  }

  query(pathValue) {
    const normalizedPath = String(pathValue || "").trim();
    if (!normalizedPath) return [];
    const segments = splitPath(normalizedPath);
    if (segments.length === 0) return [];

    const hasWildcard = segments.some((segment) => segment === "*");
    if (!hasWildcard) {
      return this.queryExactPath(normalizedPath);
    }

    const results = [];
    for (const assetPathEntry of this.assetPathEntries) {
      if (this.matchesAssetPath(segments, assetPathEntry)) {
        const asset = this.assetById.get(assetPathEntry.assetId);
        if (asset) {
          results.push({
            kind: "asset",
            path: assetPathEntry.path,
            assetId: asset.id,
            value: asset
          });
        }
      }

      if (!this.matchesAttributePathPrefix(segments, assetPathEntry)) continue;

      const attributePattern = segments[segments.length - 1];
      results.push(...this.queryAttributesForAsset(assetPathEntry.assetId, attributePattern));
    }

    return results;
  }

  getAttributes(pathValue) {
    const normalizedPath = String(pathValue || "").trim();
    if (!normalizedPath) return [];
    if (!normalizedPath.includes("*")) {
      const direct = this.attributeByPath.get(normalizedPath);
      return direct ? [{ ...direct }] : [];
    }
    return this.query(normalizedPath).filter((item) => item.kind === "attribute");
  }

  getValue(pathValue, defaultValue) {
    const matchesFound = this.getAttributes(pathValue);
    if (matchesFound.length === 0) return defaultValue;
    if (matchesFound.length === 1) return matchesFound[0].value;
    return matchesFound.map((item) => item.value);
  }

  findAttributesByValue(pathValue, expectedValue, options) {
    options = options || {};
    const strict = options.strict === true;
    const matchesFound = this.getAttributes(pathValue).filter((item) =>
      strict ? valuesEqual(item.value, expectedValue) : valuesLooselyEqual(item.value, expectedValue)
    );
    const assetsMap = new Map();
    for (const item of matchesFound) {
      if (assetsMap.has(item.assetId)) continue;
      assetsMap.set(item.assetId, {
        assetId: item.assetId,
        path: this.assetPathById.get(item.assetId) || splitPath(item.path).slice(0, -1).join(".")
      });
    }
    return {
      path: pathValue,
      expectedValue,
      strict,
      count: matchesFound.length,
      assetCount: assetsMap.size,
      matches: matchesFound.map((item) => ({ ...item })),
      assets: Array.from(assetsMap.values())
    };
  }

  getHierarchy(options) {
    options = options || {};
    const populateAttributes = options.populateAttributes !== false;
    const buildNode = (asset) => {
      const children = (this.childrenByParentId.get(asset.id) || []).map(buildNode);
      const baseNode = {
        id: asset.id,
        name: asset.name,
        path: this.assetPathById.get(asset.id) || "",
        parentId: asset.parentId != null ? asset.parentId : null,
        templateIds: Array.isArray(asset.templateIds) ? [...asset.templateIds] : [],
        attributes: JSON.parse(JSON.stringify(asset.attributes || {})),
        children
      };
      if (!populateAttributes) return baseNode;

      const attributeMap = this.attributeMapByAssetId.get(asset.id) || new Map();
      const effectiveAttributes = Array.from(attributeMap.values())
        .map((attribute) => ({
          name: attribute.attributeName,
          description: attribute.description || "",
          value: attribute.value,
          valueType: attribute.type || "custom",
          unit: attribute.unit || "",
          numberMin: attribute.numberMin != null ? attribute.numberMin : null,
          numberMax: attribute.numberMax != null ? attribute.numberMax : null,
          deadband: attribute.deadband != null ? attribute.deadband : null,
          ts: attribute.ts,
          historianEnabled: attribute.historianEnabled === true,
          historianTimeSourcePath: attribute.historianTimeSourcePath || "",
          historianTargetId: attribute.historianTargetId || "default",
          sparkplugType: attribute.sparkplugType || "",
          source: Object.prototype.hasOwnProperty.call(asset.attributes || {}, attribute.attributeName) ? "override" : "template"
        }))
        .sort((left, right) => left.name.localeCompare(right.name));

      return { ...baseNode, effectiveAttributes };
    };

    return (this.childrenByParentId.get(null) || []).map(buildNode);
  }

  setAttribute(pathValue, value) {
    const results = this.setAttributes([{ path: pathValue, value }]);
    return (results[0] && results[0].matches) || [];
  }

  setAttributes(items) {
    items = items || [];
    const writeRequests = this.toAttributeWriteRequests(items);
    if (writeRequests.length === 0) {
      this.lastWriteBatch = [];
      return [];
    }

    const writesByAssetId = this.groupWritesByAsset(writeRequests);
    if (writesByAssetId.size === 0) {
      this.lastWriteBatch = [];
      return writeRequests.map((request) => ({ path: request.path, count: 0, matches: [] }));
    }

    this.applyGroupedAttributeWrites(writesByAssetId);
    this.cascadeWatchTriggers(writesByAssetId);

    const changedAttributesByTarget = this.collectChangedAttributes(writeRequests, writesByAssetId);
    this.lastWriteBatch = this.collectAllWrittenAttributes(writesByAssetId);
    return this.toWriteResults(writeRequests, changedAttributesByTarget);
  }

  // After a batch of direct writes has been committed, recompute every "watch"-mode attribute
  // that depends on any of the just-written attributes — and, transitively, anything that in turn
  // depends on THOSE recomputed attributes (chained formulas). A `visited` guard caps each
  // (assetId, attributeName) to at most one recompute per call, so circular watch graphs
  // (A watches B, B watches A) terminate instead of looping forever.
  //
  // This exists so a derived attribute (e.g. `result = a * b`) is ALWAYS in sync with its inputs
  // the instant they change — no dependency on a separate, independently-clocked poll/schedule
  // that could read a stale `result` between ticks.
  cascadeWatchTriggers(writesByAssetId) {
    const visited = new Set();
    let frontier = writesByAssetId;
    let iterations = 0;
    const MAX_ITERATIONS = 1000;

    while (frontier.size > 0 && iterations < MAX_ITERATIONS) {
      iterations += 1;
      const nextWritesByAssetId = new Map();

      for (const [assetId, attrWrites] of frontier.entries()) {
        for (const attributeName of attrWrites.keys()) {
          const watchers = this.watchersByKey.get(`${assetId}:${attributeName}`);
          if (!watchers || watchers.length === 0) continue;

          for (const watcher of watchers) {
            const watcherKey = `${watcher.assetId}:${watcher.attributeName}`;
            if (visited.has(watcherKey)) continue;
            visited.add(watcherKey);

            const effective = this.getEffectiveAttributeDef(watcher.assetId, watcher.attributeName);
            const scriptCfg = effective && effective.script;
            if (!scriptCfg || !scriptCfg.enabled || !this.scriptRunner) continue;

            const timestamp = new Date().toISOString();
            const prevSelfEntry = this.lastSelfByAttr.has(watcherKey) ? this.lastSelfByAttr.get(watcherKey) : undefined;
            // No raw value was written to the watcher itself — `self` is just its own current
            // value. The script's real inputs come from reading its watched siblings/paths.
            const selfValue = effective.value;
            try {
              const computed = this.scriptRunner(scriptCfg, watcher.assetId, watcher.attributeName, selfValue, effective.value, prevSelfEntry);
              this.lastSelfByAttr.set(watcherKey, selfValue);
              if (!nextWritesByAssetId.has(watcher.assetId)) nextWritesByAssetId.set(watcher.assetId, new Map());
              nextWritesByAssetId.get(watcher.assetId).set(watcher.attributeName, { value: computed, ts: timestamp });
            } catch (err) {
              console.error(`[kufayeka-asset-engine] Watch-trigger script error for ${watcherKey}: ${err.message}`);
            }
          }
        }
      }

      if (nextWritesByAssetId.size === 0) break;

      this.applyGroupedAttributeWrites(nextWritesByAssetId);
      for (const [assetId, attrMap] of nextWritesByAssetId.entries()) {
        if (!writesByAssetId.has(assetId)) writesByAssetId.set(assetId, new Map());
        const target = writesByAssetId.get(assetId);
        for (const [attributeName, val] of attrMap.entries()) target.set(attributeName, val);
      }

      frontier = nextWritesByAssetId;
    }
  }

  collectAllWrittenAttributes(writesByAssetId) {
    const out = [];
    for (const [assetId, attrWrites] of writesByAssetId.entries()) {
      const assetPath = this.assetPathById.get(assetId);
      if (!assetPath) continue;
      for (const attributeName of attrWrites.keys()) {
        const match = this.attributeByPath.get(`${assetPath}.${attributeName}`);
        if (match) out.push({ ...match });
      }
    }
    return out;
  }

  queryExactPath(normalizedPath) {
    const asset = this.assetByPath.get(normalizedPath);
    if (asset) {
      return [
        {
          kind: "asset",
          path: normalizedPath,
          assetId: asset.id,
          value: asset
        }
      ];
    }

    const attribute = this.attributeByPath.get(normalizedPath);
    return attribute ? [{ ...attribute }] : [];
  }

  matchesAssetPath(querySegments, assetPathEntry) {
    return (
      querySegments.length === assetPathEntry.segments.length &&
      querySegments.every((segment, index) => matches(segment, assetPathEntry.segments[index]))
    );
  }

  matchesAttributePathPrefix(querySegments, assetPathEntry) {
    return (
      querySegments.length === assetPathEntry.segments.length + 1 &&
      querySegments.slice(0, -1).every((segment, index) => matches(segment, assetPathEntry.segments[index]))
    );
  }

  queryAttributesForAsset(assetId, attributePattern) {
    const attributes = this.attributeMapByAssetId.get(assetId);
    if (!attributes) return [];

    const matchedAttributes = [];
    for (const [attributeName, match] of attributes.entries()) {
      if (!matches(attributePattern, attributeName)) continue;
      matchedAttributes.push({ ...match });
    }
    return matchedAttributes;
  }

  toAttributeWriteRequests(items) {
    return items
      .filter(
        (item) =>
          !!item &&
          typeof item === "object" &&
          Object.prototype.hasOwnProperty.call(item, "path") &&
          Object.prototype.hasOwnProperty.call(item, "value")
      )
      .map((item) => {
        const path = String(item.path || "");
        return {
          path,
          value: item.value,
          targets: this.resolveTargets(path)
        };
      });
  }

  groupWritesByAsset(writeRequests) {
    const writesByAssetId = new Map();

    for (const request of writeRequests) {
      const timestamp = new Date().toISOString();
      for (const target of request.targets) {
        const finalValue = this.resolveWriteValue(target.assetId, target.attributeName, request.value, timestamp);
        if (finalValue === SKIP_WRITE) continue;

        if (!writesByAssetId.has(target.assetId)) {
          writesByAssetId.set(target.assetId, new Map());
        }
        writesByAssetId.get(target.assetId).set(target.attributeName, {
          value: finalValue,
          ts: timestamp
        });
      }
    }

    return writesByAssetId;
  }

  // Decides what a raw incoming write actually becomes for one (asset, attribute) target:
  //  - no script (or script disabled): pass the raw value straight through, unchanged.
  //  - script enabled, trigger "onChange" or "watch": run the script now with `self` = raw value,
  //    write its result. ("watch"-mode attributes are ALSO recomputed reactively whenever their
  //    watched dependencies change — see cascadeWatchTriggers() — but a direct write to the
  //    attribute itself still runs its own script immediately, same as "onChange".)
  //  - script enabled, trigger "schedule": stash the raw value for the centralized scheduler to
  //    pick up later and DON'T touch the public value now (returns SKIP_WRITE).
  resolveWriteValue(assetId, attributeName, rawValue, timestamp) {
    const effective = this.getEffectiveAttributeDef(assetId, attributeName);
    const scriptCfg = effective && effective.script;
    if (!scriptCfg || !scriptCfg.enabled) return rawValue;

    if (scriptCfg.trigger.mode === "schedule") {
      this.pendingRawByAttr.set(`${assetId}:${attributeName}`, { value: rawValue, ts: timestamp });
      return SKIP_WRITE;
    }

    if (!this.scriptRunner) return rawValue;
    const key = `${assetId}:${attributeName}`;
    const prevSelfEntry = this.lastSelfByAttr.has(key) ? this.lastSelfByAttr.get(key) : undefined;
    try {
      // effective.value is still the value from BEFORE this write (resolveWriteValue runs
      // ahead of applyGroupedAttributeWrites), so it's exactly "current" as of right now.
      const result = this.scriptRunner(scriptCfg, assetId, attributeName, rawValue, effective.value, prevSelfEntry);
      this.lastSelfByAttr.set(key, rawValue);
      return result;
    } catch (err) {
      // The sensor still sent this reading even though the script failed on it — remember it
      // anyway so the NEXT successful run computes its delta against reality, not against
      // whatever came before the failed one.
      this.lastSelfByAttr.set(key, rawValue);
      console.error(`[kufayeka-asset-engine] Attribute script error for asset ${assetId}.${attributeName}: ${err.message}`);
      return SKIP_WRITE;
    }
  }

  applyGroupedAttributeWrites(writesByAssetId) {
    for (const [assetId, attributeWrites] of writesByAssetId.entries()) {
      const currentAsset = this.assetById.get(assetId);
      if (!currentAsset) continue;

      if (!currentAsset.attributes) currentAsset.attributes = {};
      for (const [attributeName, nextValue] of attributeWrites.entries()) {
        currentAsset.attributes[attributeName] = nextValue;
      }

      this.refreshAssetIndexes(currentAsset, attributeWrites.keys());
    }
  }

  refreshAssetIndexes(updatedAsset, writtenNames) {
    this.assetById.set(updatedAsset.id, updatedAsset);

    const assetPath = this.assetPathById.get(updatedAsset.id) || "";
    this.assetByPath.set(assetPath, updatedAsset);
    this.updateAttributeIndexForWrittenNames(updatedAsset, assetPath, writtenNames);
  }

  collectChangedAttributes(writeRequests, writesByAssetId) {
    const changedAttributesByTarget = new Map();

    for (const request of writeRequests) {
      for (const target of request.targets) {
        // Skip targets whose write was staged (timed-trigger script) or dropped (script error) —
        // nothing actually changed for those this call.
        const assetWrites = writesByAssetId.get(target.assetId);
        if (!assetWrites || !assetWrites.has(target.attributeName)) continue;

        const assetPath = this.assetPathById.get(target.assetId);
        if (!assetPath) continue;

        const match = this.attributeByPath.get(`${assetPath}.${target.attributeName}`);
        if (!match) continue;

        changedAttributesByTarget.set(this.targetKey(target), { ...match });
      }
    }

    return changedAttributesByTarget;
  }

  toWriteResults(writeRequests, changedAttributesByTarget) {
    return writeRequests.map((request) => {
      const matches = request.targets
        .map((target) => changedAttributesByTarget.get(this.targetKey(target)))
        .filter((match) => !!match)
        .map((match) => ({ ...match }));

      return {
        path: request.path,
        count: matches.length,
        matches
      };
    });
  }

  targetKey(target) {
    return `${target.assetId}:${target.attributeName}`;
  }

  resolveTargets(pathValue) {
    const normalizedPath = String(pathValue || "").trim();
    if (!normalizedPath) return [];

    if (!normalizedPath.includes("*")) {
      const direct = this.attributeByPath.get(normalizedPath);
      if (direct) {
        return [{ assetId: direct.assetId, attributeName: direct.attributeName }];
      }
    }

    const segments = splitPath(normalizedPath);
    if (segments.length < 2) return [];
    const attributePattern = segments[segments.length - 1];
    if (!attributePattern) return [];
    const assetPatternSegments = segments.slice(0, -1);
    const targets = [];

    for (const entry of this.assetPathEntries) {
      if (entry.segments.length !== assetPatternSegments.length) continue;
      if (!assetPatternSegments.every((segment, index) => matches(segment, entry.segments[index]))) continue;
      const attributeMap = this.attributeMapByAssetId.get(entry.assetId);
      if (!attributeMap) continue;
      if (attributePattern === "*") {
        for (const attributeName of attributeMap.keys()) {
          targets.push({ assetId: entry.assetId, attributeName });
        }
        continue;
      }
      if (attributeMap.has(attributePattern)) {
        targets.push({ assetId: entry.assetId, attributeName: attributePattern });
      }
    }

    return targets;
  }

  rebuildAllIndexes(section) {
    this.attributeTemplatesList = section.attributeTemplates || [];
    this.historiansList = section.historians || [];
    this.templateById = new Map(this.attributeTemplatesList.map((template) => [template.id, template]));
    this.assetById = new Map((section.assets || []).map((asset) => [asset.id, asset]));
    this.assetPathEntries = [];
    this.assetPathById = new Map();
    this.assetByPath = new Map();
    this.attributeMapByAssetId = new Map();
    this.attributeByPath = new Map();
    this.childrenByParentId = new Map();

    for (const asset of this.assetById.values()) {
      const parentKey = asset.parentId != null ? asset.parentId : null;
      const siblings = this.childrenByParentId.get(parentKey) || [];
      siblings.push(asset);
      this.childrenByParentId.set(parentKey, siblings);
    }
    for (const siblings of this.childrenByParentId.values()) {
      siblings.sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));
    }

    for (const asset of this.assetById.values()) {
      const path = getAssetPath(asset.id, this.assetById);
      const entry = {
        assetId: asset.id,
        path,
        segments: splitPath(path)
      };
      this.assetPathEntries.push(entry);
      this.assetPathById.set(asset.id, path);
      this.assetByPath.set(path, asset);
    }

    for (const asset of this.assetById.values()) {
      this.rebuildAttributeIndexForAsset(asset, this.assetPathById.get(asset.id) || "");
    }

    this.buildWatcherIndex();
  }

  // Builds watchersByKey: for every attribute whose script is enabled with trigger.mode === "watch",
  // resolve each entry in trigger.watch to the (assetId, attributeName) it points at — a bare name
  // ("a") is a sibling on the SAME asset as the watching attribute; anything containing "." is an
  // absolute asset-attribute path (an optional leading "%" is stripped, matching the `%Path...`
  // convention used elsewhere in attribute scripts).
  buildWatcherIndex() {
    this.watchersByKey = new Map();
    for (const match of this.attributeByPath.values()) {
      const scriptCfg = match.script;
      if (!scriptCfg || !scriptCfg.enabled || !scriptCfg.trigger || scriptCfg.trigger.mode !== "watch") continue;

      const watchList = Array.isArray(scriptCfg.trigger.watch) ? scriptCfg.trigger.watch : [];
      for (const rawName of watchList) {
        const name = String(rawName || "").trim();
        if (!name) continue;

        let depKey;
        if (name.includes(".")) {
          const depMatch = this.attributeByPath.get(name.replace(/^%/, ""));
          if (!depMatch) continue;
          depKey = `${depMatch.assetId}:${depMatch.attributeName}`;
        } else {
          depKey = `${match.assetId}:${name}`;
        }

        if (!this.watchersByKey.has(depKey)) this.watchersByKey.set(depKey, []);
        this.watchersByKey.get(depKey).push({ assetId: match.assetId, attributeName: match.attributeName });
      }
    }
  }

  rebuildAttributeIndexForAsset(asset, assetPath) {
    const previousMap = this.attributeMapByAssetId.get(asset.id);
    if (previousMap) {
      for (const previous of previousMap.values()) {
        this.attributeByPath.delete(previous.path);
      }
    }

    const nextMap = new Map();
    const effectiveAttributes = this.templateService.buildEffectiveAttributeMap(asset, this.templateById);
    for (const [attributeName, attribute] of effectiveAttributes.entries()) {
      const match = this.toAttributeMatch(asset.id, assetPath, attributeName, attribute);
      nextMap.set(attributeName, match);
      this.attributeByPath.set(match.path, match);
    }
    this.attributeMapByAssetId.set(asset.id, nextMap);
  }

  updateAttributeIndexForWrittenNames(asset, assetPath, writtenNames) {
    const nextMap = this.attributeMapByAssetId.get(asset.id) || new Map();

    for (const attributeName of writtenNames) {
      const previousMatch = nextMap.get(attributeName);
      if (previousMatch) this.attributeByPath.delete(previousMatch.path);

      const effective = this.templateService.buildEffectiveAttributeForName(asset, this.templateById, attributeName);
      if (!effective) {
        nextMap.delete(attributeName);
        continue;
      }
      const match = this.toAttributeMatch(asset.id, assetPath, attributeName, effective);
      nextMap.set(attributeName, match);
      this.attributeByPath.set(match.path, match);
    }

    this.attributeMapByAssetId.set(asset.id, nextMap);
  }

  toAttributeMatch(assetId, assetPath, attributeName, attribute) {
    return {
      kind: "attribute",
      path: `${assetPath}.${attributeName}`,
      assetId,
      attributeName,
      description: attribute.description || "",
      value: attribute.value,
      ts: attribute.ts,
      type: attribute.valueType || "custom",
      unit: attribute.unit || "",
      numberMin: attribute.numberMin != null ? attribute.numberMin : null,
      numberMax: attribute.numberMax != null ? attribute.numberMax : null,
      deadband: attribute.deadband != null ? attribute.deadband : null,
      historianEnabled: attribute.historianEnabled === true,
      historianTimeSourcePath: attribute.historianTimeSourcePath || "",
      historianTargetId: attribute.historianTargetId || "default",
      // Optional opt-in Sparkplug DataType (see AssetSchemaService.js and
      // lib/sparkplug/sparkplugMapping.js) — threaded through here so both
      // getHierarchy()'s effectiveAttributes AND a live change event (which
      // spreads THIS SAME match object — see collectChangedAttributes)
      // carry it to the Sparkplug bridge.
      sparkplugType: attribute.sparkplugType || "",
      script: attribute.script || { enabled: false, code: "", trigger: { mode: "onChange", repeat: 0, crontab: "" } }
    };
  }
}

module.exports = {
  AssetStoreIndex
};
