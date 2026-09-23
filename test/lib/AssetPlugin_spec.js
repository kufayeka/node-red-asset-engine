const should = require("should");
const pluginFactory = require("../../lib/asset-plugin");

describe("AssetPlugin (Runtime & Admin REST API)", function() {
  let mockRED;
  let registeredRoutes = {};
  let publishedComms = [];
  let registeredPlugin = null;

  beforeEach(function() {
    registeredRoutes = { get: {}, put: {}, post: {}, delete: {} };
    publishedComms = [];
    registeredPlugin = null;

    mockRED = {
      settings: {
        functionGlobalContext: {}
      },
      log: {
        info: () => {},
        warn: () => {},
        error: () => {}
      },
      plugins: {
        registerPlugin: (id, def) => {
          registeredPlugin = { id, def };
        }
      },
      comms: {
        publish: (topic, data) => {
          publishedComms.push({ topic, data });
        }
      },
      httpAdmin: {
        get: (route, auth, handler) => {
          registeredRoutes.get[route] = handler || auth;
        },
        put: (route, auth, handler) => {
          registeredRoutes.put[route] = handler || auth;
        },
        post: (route, auth, handler) => {
          registeredRoutes.post[route] = handler || auth;
        }
      },
      auth: {
        needsPermission: () => (req, res, next) => next()
      }
    };
  });

  it("should register runtime plugin and attach RED.asset and globals", function() {
    const exportsResult = pluginFactory(mockRED);
    should.exist(mockRED.asset);
    should.exist(mockRED.settings.functionGlobalContext.asset);
    should.exist(mockRED.settings.functionGlobalContext.$);
    should.exist(registeredPlugin);
    registeredPlugin.id.should.equal("kufayeka-asset-engine");
  });

  it("should trigger comms publish on asset changes when plugin is added", function(done) {
    pluginFactory(mockRED);
    registeredPlugin.def.onadd();

    mockRED.asset.replaceState({
      attributeTemplates: [
        { id: "tmpl-motor", name: "MotorTemplate", attributes: [{ name: "Speed", valueType: "number", default: 0 }] }
      ],
      assets: [
        { id: "m1", name: "Motor1", parentId: null, templateIds: ["tmpl-motor"], attributes: { Speed: { value: 1200 } } }
      ]
    });

    mockRED.asset.setAttribute("Motor1.Speed", 1750);
    // Attribute writes reach the editor batched (asset-plugin.js createAssetChangeBatcher).
    setTimeout(function () {
      try {
        publishedComms.some(c => c.topic === "assets/changed").should.be.true();
        done();
      } catch (e) { done(e); }
    }, 150);
  });

  it("should batch attribute writes into one merged assets/changed per window (last value wins) and never publish kufayeka/asset", function(done) {
    pluginFactory(mockRED);
    registeredPlugin.def.onadd();
    mockRED.asset.replaceState({
      attributeTemplates: [
        { id: "tmpl-motor", name: "MotorTemplate", attributes: [{ name: "Speed", valueType: "number", default: 0 }, { name: "Temp", valueType: "number", default: 0 }] }
      ],
      assets: [
        { id: "m1", name: "Motor1", parentId: null, templateIds: ["tmpl-motor"], attributes: { Speed: { value: 1 }, Temp: { value: 1 } } }
      ]
    });
    publishedComms.length = 0;

    for (let i = 2; i <= 50; i++) mockRED.asset.setAttribute("Motor1.Speed", i);
    mockRED.asset.setAttribute("Motor1.Temp", 99);
    publishedComms.filter(c => c.topic === "assets/changed").length.should.equal(0, "nothing sent synchronously per write");

    setTimeout(function () {
      try {
        const sent = publishedComms.filter(c => c.topic === "assets/changed");
        // The asset controller is a module-level singleton, so an earlier
        // test's onadd() listener is still subscribed too — each listener
        // must have sent exactly ONE merged message (not 50).
        sent.length.should.be.within(1, 3);
        sent.forEach(function (s) {
          s.data.change.type.should.equal("attribute.set");
          const changes = s.data.change.changes;
          changes.map(c => c.path).should.eql(["Motor1.Speed", "Motor1.Temp"]);
          changes[0].value.should.equal(50);
          changes[1].value.should.equal(99);
        });
        publishedComms.some(c => c.topic === "kufayeka/asset").should.be.false();
        done();
      } catch (e) { done(e); }
    }, 150);
  });

  it("should register all REST admin endpoints", function() {
    pluginFactory(mockRED);

    should.exist(registeredRoutes.get["/api/assets"]);
    should.exist(registeredRoutes.get["/api/assets/hierarchy"]);
    should.exist(registeredRoutes.get["/api/assets/query"]);
    should.exist(registeredRoutes.get["/api/assets/find"]);
    should.exist(registeredRoutes.get["/api/assets/value/*"]);
    should.exist(registeredRoutes.put["/api/assets/value/*"]);
    should.exist(registeredRoutes.post["/api/assets/values/batch"]);
    should.exist(registeredRoutes.put["/api/assets/values/batch"]);
  });

  it("should handle GET /api/assets/hierarchy handler correctly", function(done) {
    pluginFactory(mockRED);
    const handler = registeredRoutes.get["/api/assets/hierarchy"];

    const req = { query: { populated: "true" } };
    const res = {
      json: function(data) {
        data.should.have.property("status", "ok");
        data.should.have.property("data").which.is.an.Array();
        done();
      }
    };

    handler(req, res);
  });

  it("should handle GET and PUT /api/assets/value/* handlers", function(done) {
    pluginFactory(mockRED);
    mockRED.asset.replaceState({
      attributeTemplates: [
        { id: "tmpl-motor", name: "MotorTemplate", attributes: [{ name: "Speed", valueType: "number", default: 0 }] }
      ],
      assets: [
        { id: "m1", name: "Motor1", parentId: null, templateIds: ["tmpl-motor"], attributes: { Speed: { value: 1200 } } }
      ]
    });
    const getHandler = registeredRoutes.get["/api/assets/value/*"];
    const putHandler = registeredRoutes.put["/api/assets/value/*"];

    const putReq = {
      params: { 0: "Motor1.Speed" },
      body: { value: 3450 }
    };
    const putRes = {
      json: function(data) {
        data.should.have.property("status", "ok");
        data.should.have.property("count");

        // Verify GET returns the new value
        const getReq = { params: { 0: "Motor1.Speed" } };
        const getRes = {
          json: function(getData) {
            getData.should.have.property("status", "ok");
            getData.value.should.equal(3450);
            done();
          }
        };
        getHandler(getReq, getRes);
      }
    };

    putHandler(putReq, putRes);
  });
});
