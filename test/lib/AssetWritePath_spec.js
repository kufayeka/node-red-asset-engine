const should = require("should");
const { AssetStoreRepository } = require("../../lib/asset/AssetStoreRepository");
const { createAssetStore } = require("../../lib/asset/AssetStoreFactory");
const { AttributeScriptEngine } = require("../../lib/asset/AttributeScriptEngine");

describe("Asset write path (persistence max-wait + indexed fast path)", function () {
  describe("AssetStoreRepository.scheduleDebouncedSave", function () {
    function repoWithCountingSave() {
      const repo = new AssetStoreRepository({ settings: {}, log: { info() {}, warn() {}, error() {} }, events: { on() {}, once() {} } });
      repo.debounceMs = 40;
      repo.maxSaveWaitMs = 200;
      repo.store = { getState: () => ({}) };
      repo.saves = [];
      repo.savePersistedSectionAsync = () => { repo.saves.push(Date.now()); };
      return repo;
    }

    it("still saves while changes keep arriving faster than the debounce (no starvation)", function (done) {
      const repo = repoWithCountingSave();
      const t0 = Date.now();
      const tick = setInterval(() => repo.scheduleDebouncedSave(), 10); // faster than debounceMs
      setTimeout(() => {
        clearInterval(tick);
        clearTimeout(repo.saveTimer);
        try {
          repo.saves.length.should.be.aboveOrEqual(2, "a continuously changing store must still be saved periodically");
          (repo.saves[0] - t0).should.be.belowOrEqual(260); // first save no later than ~maxSaveWaitMs
          done();
        } catch (e) { done(e); }
      }, 700);
    });

    it("keeps the plain debounce when changes are sparse (one save after a burst)", function (done) {
      const repo = repoWithCountingSave();
      repo.scheduleDebouncedSave(); repo.scheduleDebouncedSave(); repo.scheduleDebouncedSave();
      setTimeout(() => {
        try { repo.saves.length.should.equal(1); done(); } catch (e) { done(e); }
      }, 150);
    });
  });

  describe("indexed fast path gives the same results as rebuilding from the template", function () {
    function store() {
      return createAssetStore({
        attributeTemplates: [{ id: "t", name: "T", attributes: [
          { name: "n", valueType: "number", default: 0, numberAllowDecimal: false },
          { name: "s", valueType: "string", default: "" },
          { name: "a", valueType: "number", default: 0 },
          { name: "b", valueType: "number", default: 0 },
          { name: "result", valueType: "number", default: 0, script: { enabled: true, code: "return a * b;", trigger: { mode: "watch", watch: ["a", "b"] } } }
        ] }],
        assets: [{ id: "x", name: "Dev", parentId: null, templateIds: ["t"] }]
      }, { scriptEngine: new AttributeScriptEngine() });
    }

    it("coerces repeated writes exactly like the first (slow-path) write", function () {
      const s = store();
      s.setAttribute("Dev.n", "12.7");          // first write: slow path, fills the cache
      s.setAttribute("Dev.n", "8.9");           // fast path
      // same coercion as a fresh store doing that write as its first (slow-path) write
      const fresh = store(); fresh.setAttribute("Dev.n", "8.9");
      s.getValue("Dev.n").should.equal(fresh.getValue("Dev.n"));
      s.setAttribute("Dev.s", 42); s.setAttribute("Dev.s", 43);
      const fresh2 = store(); fresh2.setAttribute("Dev.s", 43);
      s.getValue("Dev.s").should.equal(fresh2.getValue("Dev.s"));
    });

    it("keeps ts as the write timestamp string and the rest of the attribute definition", function () {
      const s = store();
      s.setAttribute("Dev.a", 1); s.setAttribute("Dev.a", 2);
      const m = s.getAttributes("Dev.a")[0];
      m.value.should.equal(2);
      m.ts.should.be.a.String();
      m.type.should.equal("number");
      m.path.should.equal("Dev.a");
    });

    it("a batch write feeds the watch script the complete new inputs (no a_new * b_old)", function () {
      const s = store();
      const seen = [];
      s.subscribe((meta) => (meta.change.changes || []).forEach((c) => { if (c.attributeName === "result") seen.push(c.value); }));
      s.setAttributes([{ path: "Dev.a", value: 10 }, { path: "Dev.b", value: 20 }]);
      seen.should.eql([200]);
      s.setAttributes([{ path: "Dev.a", value: 3 }, { path: "Dev.b", value: 4 }]); // fast path now
      seen.should.eql([200, 12]);
      s.getValue("Dev.result").should.equal(12);
    });

    it("a schema change (replace) resets the fast-path cache: new type is honoured", function () {
      const s = store();
      s.setAttribute("Dev.n", 5); s.setAttribute("Dev.n", 6);
      const state = s.getState();
      state.attributeTemplates[0].attributes[0].valueType = "string";
      s.replace(state);
      s.setAttribute("Dev.n", 7);
      s.getValue("Dev.n").should.equal("7");
    });
  });
});
