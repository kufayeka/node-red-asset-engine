const should = require("should");
const helper = require("node-red-node-test-helper");
const functionNode = require("../../nodes/asset-function.js");
const pluginFactory = require("../../lib/asset-plugin.js");

describe("kufayeka-asset-function Node", function() {
  this.timeout(10000);

  before(function(done) {
    this.timeout(10000);
    helper.init(require.resolve("node-red"));
    helper.startServer(done);
  });

  after(function(done) {
    this.timeout(10000);
    helper.stopServer(done);
  });

  afterEach(function() {
    return helper.unload();
  });

  function setupEngineWithData(RED) {
    const plugin = pluginFactory(RED);
    const asset = RED.asset;
    asset.replaceState({
      attributeTemplates: [
        {
          id: "tmpl-motor",
          name: "MotorTemplate",
          attributes: [
            { name: "Speed", valueType: "number", default: 1000 },
            { name: "Status", valueType: "string", default: "IDLE" },
            { name: "Counter", valueType: "number", default: 0 }
          ]
        },
        {
          id: "tmpl-plant",
          name: "PlantTemplate",
          attributes: [
            { name: "Site", valueType: "string", default: "HQ" }
          ]
        }
      ],
      assets: [
        {
          id: "p1",
          name: "Plant1",
          parentId: null,
          templateIds: ["tmpl-plant"],
          attributes: {
            Site: { value: "HQ" }
          }
        },
        {
          id: "m1",
          name: "Motor1",
          parentId: "p1",
          templateIds: ["tmpl-motor"],
          attributes: {
            Speed: { value: 1000 },
            Status: { value: "IDLE" },
            Counter: { value: 0 }
          }
        }
      ],
      historians: []
    });
  }

  it("should read % asset attribute and return in msg.payload", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-function",
        func: "msg.payload = %Plant1.Motor1.Speed;\nreturn msg;",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(functionNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.payload.should.equal(1000);
        done();
      });

      n1.receive({});
    });
  });

  it("should write % asset attribute directly from script", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-function",
        func: "%Plant1.Motor1.Speed = msg.payload;\nreturn msg;",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(functionNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");
      console.log("TEST 2: n1 exists?", !!n1, "n2 exists?", !!n2);

      n2.on("input", function(msg) {
        try {
          const val = helper._RED.asset.getValue("Plant1.Motor1.Speed");
          console.log("TEST 2 STORE VALUE AFTER WRITE:", val);
          val.should.equal(3500);
          done();
        } catch (err) {
          console.error("TEST 2 ASSERTION ERROR:", err);
          done(err);
        }
      });

      console.log("TEST 2 SENDING TO N1");
      n1.receive({ payload: 3500 });
    });
  });

  it("should handle mixed % asset paths and modulo arithmetic operations", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-function",
        func: "const current = %Plant1.Motor1.Counter;\nconst mod = (current + msg.val) % 5;\n%Plant1.Motor1.Counter = mod;\nmsg.payload = mod;\nreturn msg;",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(functionNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.payload.should.equal(3);
        helper._RED.asset.getValue("Plant1.Motor1.Counter").should.equal(3);
        done();
      });

      n1.receive({ val: 8 }); // (0 + 8) % 5 = 3
    });
  });

  it("should support $ root proxy syntax and asset API methods", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-function",
        func: "const s = $.Plant1.Motor1.Status;\nasset.set('Plant1.Motor1.Status', 'RUNNING');\nmsg.prevStatus = s;\nmsg.currentStatus = asset.get('Plant1.Motor1.Status');\nreturn msg;",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(functionNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.prevStatus.should.equal("IDLE");
        msg.currentStatus.should.equal("RUNNING");
        helper._RED.asset.getValue("Plant1.Motor1.Status").should.equal("RUNNING");
        done();
      });

      n1.receive({});
    });
  });

  it("should support async / await and JS globals in sandbox", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-function",
        func: "const rounded = Math.round(45.7);\nconst date = new Date(1700000000000).toISOString();\nconst json = JSON.parse('{\"test\": 123}');\nconst asyncVal = await Promise.resolve(rounded * 2);\nmsg.payload = { rounded, date, json, asyncVal };\nreturn msg;",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    helper.load(functionNode, flow, function() {
      setupEngineWithData(helper._RED);
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.payload.rounded.should.equal(46);
        msg.payload.asyncVal.should.equal(92);
        msg.payload.json.test.should.equal(123);
        done();
      });

      n1.receive({});
    });
  });

  it("should run On Start (initialize) script", function(done) {
    const flow = [
      {
        id: "n1",
        type: "kufayeka-asset-function",
        initialize: "%Plant1.Motor1.Speed = 500;",
        func: "msg.payload = %Plant1.Motor1.Speed;\nreturn msg;",
        wires: [["n2"]]
      },
      { id: "n2", type: "helper" }
    ];

    // The node's "On Start" script runs at construction time (inside helper.load()),
    // so the engine must already be seeded before load — seeding afterwards would
    // both miss the asset the init script writes to and overwrite its effect.
    setupEngineWithData(helper._RED);

    helper.load(functionNode, flow, function() {
      const n1 = helper.getNode("n1");
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.payload.should.equal(500);
        done();
      });

      n1.receive({});
    });
  });
});
