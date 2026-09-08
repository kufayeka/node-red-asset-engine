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

  it("should trigger comms publish on asset changes when plugin is added", function() {
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
    publishedComms.length.should.be.greaterThan(0);
    publishedComms.some(c => c.topic === "assets/changed" || c.topic === "kufayeka/asset").should.be.true();
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
