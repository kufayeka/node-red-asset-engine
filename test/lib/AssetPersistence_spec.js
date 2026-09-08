const fs = require("fs");
const path = require("path");
const os = require("os");
const should = require("should");
const { AssetStoreRepository } = require("../../lib/asset/AssetStoreRepository");
const { AssetStateService } = require("../../lib/asset/AssetStateService");

describe("Asset Persistence (AssetStoreRepository & AssetStateService)", function() {
  let tmpDir;
  let tmpFilePath;
  let mockRED;

  beforeEach(function() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kufayeka-test-"));
    tmpFilePath = path.join(tmpDir, "assets.json");

    mockRED = {
      settings: {
        userDir: tmpDir
      },
      log: {
        info: () => {},
        warn: () => {},
        error: () => {}
      },
      events: {
        on: () => {},
        once: () => {}
      }
    };
  });

  afterEach(function() {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  it("should return empty section if file does not exist", function() {
    const repo = new AssetStoreRepository(mockRED);
    const loaded = repo.loadPersistedSection();
    loaded.should.have.property("assets").which.is.an.Array();
    loaded.assets.length.should.equal(0);
  });

  it("should save and reload asset section to/from disk", function() {
    const repo = new AssetStoreRepository(mockRED);
    const testData = {
      attributeTemplates: [
        { id: "tmpl-pump", name: "PumpTemplate", attributes: [{ name: "Flow", valueType: "number", default: 50.5 }] }
      ],
      assets: [
        { id: "p1", name: "Plant1", parentId: null, templateIds: ["tmpl-pump"], attributes: { Flow: { value: 75.0 } } }
      ],
      historians: []
    };

    repo.savePersistedSection(testData);
    fs.existsSync(tmpFilePath).should.be.true();

    const loaded = repo.loadPersistedSection();
    loaded.assets.length.should.equal(1);
    loaded.assets[0].name.should.equal("Plant1");
    loaded.assets[0].attributes.Flow.value.should.equal(75.0);
  });

  it("should auto-persist state changes on store mutations via debounce", function(done) {
    this.timeout(4000);
    const repo = new AssetStoreRepository(mockRED);
    repo.debounceMs = 30;

    const initial = {
      attributeTemplates: [
        { id: "tmpl-plant", name: "PlantTemplate", attributes: [{ name: "Temp", valueType: "number", default: 20 }] }
      ],
      assets: [
        { id: "p1", name: "Plant1", parentId: null, templateIds: ["tmpl-plant"], attributes: { Temp: { value: 20 } } }
      ],
      historians: []
    };

    const store = repo.ensureStore(initial);
    store.setAttribute("Plant1.Temp", 85);

    const start = Date.now();
    const interval = setInterval(function() {
      if (fs.existsSync(tmpFilePath)) {
        try {
          const content = JSON.parse(fs.readFileSync(tmpFilePath, "utf-8"));
          if (content && content.assets && content.assets[0] && content.assets[0].attributes && content.assets[0].attributes.Temp) {
            clearInterval(interval);
            content.assets[0].attributes.Temp.value.should.equal(85);
            return done();
          }
        } catch (e) {
          // keep polling until valid JSON is written
        }
      }
      if (Date.now() - start > 2000) {
        clearInterval(interval);
        done(new Error("Timeout waiting for auto-persist debounce"));
      }
    }, 20);
  });

  it("should flush save synchronously on demand", function() {
    const repo = new AssetStoreRepository(mockRED);
    const initial = {
      attributeTemplates: [
        { id: "tmpl-plant", name: "PlantTemplate", attributes: [{ name: "Temp", valueType: "number", default: 20 }] }
      ],
      assets: [
        { id: "p1", name: "Plant1", parentId: null, templateIds: ["tmpl-plant"], attributes: { Temp: { value: 10 } } }
      ],
      historians: []
    };

    const store = repo.ensureStore(initial);
    store.setAttribute("Plant1.Temp", 99);
    repo.flushSave();

    fs.existsSync(tmpFilePath).should.be.true();
    const content = JSON.parse(fs.readFileSync(tmpFilePath, "utf-8"));
    content.assets[0].attributes.Temp.value.should.equal(99);
  });

  it("should initialize and replace state via AssetStateService", function() {
    const service = new AssetStateService(mockRED);
    const store = service.initialize({
      assets: [{ id: "a1", name: "PlantA", parentId: null, attributes: {} }]
    });
    service.getState().assets.length.should.equal(1);

    service.replaceState({
      assets: [
        { id: "a1", name: "PlantA", parentId: null, attributes: {} },
        { id: "a2", name: "PlantB", parentId: null, attributes: {} }
      ]
    }, true);

    service.getState().assets.length.should.equal(2);
    fs.existsSync(tmpFilePath).should.be.true();
  });

  it("should handle rapid concurrent async saves without collisions or EPERM", async function() {
    const repo = new AssetStoreRepository(mockRED);
    const promises = [];
    for (let i = 0; i < 15; i++) {
      promises.push(repo.savePersistedSectionAsync({
        assets: [{ id: "a" + i, name: "Asset" + i, parentId: null, attributes: {} }],
        attributeTemplates: [],
        historians: []
      }));
    }
    await Promise.all(promises);
    fs.existsSync(tmpFilePath).should.be.true();
    const content = JSON.parse(fs.readFileSync(tmpFilePath, "utf-8"));
    content.assets[0].name.should.equal("Asset14");
  });
});
