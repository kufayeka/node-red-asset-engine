const should = require("should");
const { createAssetStore } = require("../../lib/asset/AssetStoreFactory");
const { AttributeScriptEngine } = require("../../lib/asset/AttributeScriptEngine");
const { AttributeScriptScheduler } = require("../../lib/asset/AttributeScriptScheduler");

describe("Attribute Calculation Scripts", function() {
  let sampleState;

  beforeEach(function() {
    sampleState = {
      attributeTemplates: [
        {
          id: "tmpl-motor",
          name: "MotorTemplate",
          attributes: [
            {
              name: "attr_2",
              valueType: "number",
              default: 0,
              unit: "RPM",
              script: {
                enabled: true,
                code: "const calculation = self / 10;\nreturn calculation;",
                trigger: { mode: "onChange" }
              }
            },
            { name: "thresholdAlarm", valueType: "number", default: 100 },
            { name: "peresentase", valueType: "number", default: 2 },
            {
              name: "hasil",
              valueType: "number",
              default: 0,
              script: {
                enabled: true,
                code: "const hasil = self / thresholdAlarm * peresentase;\nreturn hasil;",
                trigger: { mode: "onChange" }
              }
            },
            {
              name: "slowAvg",
              valueType: "number",
              default: 0,
              script: {
                enabled: true,
                code: "return self;",
                trigger: { mode: "schedule", scheduleId: "sched-1" }
              }
            },
            {
              name: "accumLength",
              valueType: "number",
              default: 0,
              script: {
                enabled: true,
                code: "const delta = self > current ? self - current : 0;\nreturn current + delta;",
                trigger: { mode: "onChange" }
              }
            },
            {
              name: "slowAccum",
              valueType: "number",
              default: 0,
              script: {
                enabled: true,
                code: "return current + self;",
                trigger: { mode: "schedule", scheduleId: "sched-1" }
              }
            },
            {
              name: "encoderTotal",
              valueType: "number",
              default: 0,
              script: {
                enabled: true,
                code: "const delta = (prevSelf === undefined) ? 0 : self - prevSelf;\nreturn current + Math.max(0, delta);",
                trigger: { mode: "onChange" }
              }
            },
            {
              name: "sharedAccum",
              valueType: "number",
              default: 0,
              script: {
                enabled: true,
                code: "return self;",
                trigger: { mode: "schedule", scheduleId: "sched1" }
              }
            },
            { name: "a", valueType: "number", default: 0 },
            { name: "b", valueType: "number", default: 0 },
            {
              name: "result",
              valueType: "number",
              default: 0,
              script: {
                enabled: true,
                code: "return a * b;",
                trigger: { mode: "watch", watch: ["a", "b"] }
              }
            },
            {
              name: "resultDoubled",
              valueType: "number",
              default: 0,
              script: {
                enabled: true,
                code: "return result * 2;",
                trigger: { mode: "watch", watch: ["result"] }
              }
            },
            {
              name: "cycA",
              valueType: "number",
              default: 0,
              script: { enabled: true, code: "return cycB;", trigger: { mode: "watch", watch: ["cycB"] } }
            },
            {
              name: "cycB",
              valueType: "number",
              default: 0,
              script: { enabled: true, code: "return cycA;", trigger: { mode: "watch", watch: ["cycA"] } }
            }
          ]
        }
      ],
      assets: [{ id: "m1", name: "Motor1", parentId: null, templateIds: ["tmpl-motor"], attributes: {} }],
      historians: []
    };
  });

  describe("AttributeScriptEngine (vm sandbox)", function() {
    it("should compute a value using self", function() {
      const engine = new AttributeScriptEngine();
      const result = engine.evaluate({
        code: "const calculation = self / 10;\nreturn calculation;",
        assetId: "m1",
        attributeName: "attr_2",
        self: 107,
        getSibling: () => ({ found: false })
      });
      result.should.equal(10.7);
    });

    it("should resolve sibling attribute names on the same asset", function() {
      const engine = new AttributeScriptEngine();
      const siblings = { thresholdAlarm: 100, peresentase: 2 };
      const result = engine.evaluate({
        code: "const hasil = self / thresholdAlarm * peresentase;\nreturn hasil;",
        assetId: "m1",
        attributeName: "hasil",
        self: 50,
        getSibling: (name) => (name in siblings ? { found: true, value: siblings[name] } : { found: false })
      });
      result.should.equal(1);
    });

    it("should cache compiled scripts across repeated evaluations", function() {
      const engine = new AttributeScriptEngine();
      engine.evaluate({ code: "return self * 2;", assetId: "m1", attributeName: "x", self: 1, getSibling: () => ({ found: false }) });
      engine.evaluate({ code: "return self * 2;", assetId: "m1", attributeName: "x", self: 2, getSibling: () => ({ found: false }) });
      engine.compiledByCode.size.should.equal(1);
    });
  });

  describe("Write-path integration (onChange)", function() {
    it("should write the computed value, not the raw value, for an onChange script", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      store.setAttribute("Motor1.attr_2", 107);
      store.getValue("Motor1.attr_2").should.equal(10.7);
    });

    it("should let an onChange script read sibling attributes on the same asset", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      // thresholdAlarm=100, peresentase=2 (template defaults) -> hasil = 50/100*2 = 1
      store.setAttribute("Motor1.hasil", 50);
      store.getValue("Motor1.hasil").should.equal(1);
    });

    it("should pass the raw value straight through when no scriptEngine is wired", function() {
      const store = createAssetStore(sampleState); // no options -> no scriptEngine
      store.setAttribute("Motor1.attr_2", 107);
      store.getValue("Motor1.attr_2").should.equal(107);
    });

    it("should skip the write (not crash the batch) when the script throws", function() {
      const engine = new AttributeScriptEngine();
      const badState = JSON.parse(JSON.stringify(sampleState));
      badState.attributeTemplates[0].attributes[0].script.code = "throw new Error('boom');";
      const store = createAssetStore(badState, { scriptEngine: engine });

      const changed = store.setAttribute("Motor1.attr_2", 107);
      changed.length.should.equal(0);
      store.getValue("Motor1.attr_2").should.equal(0); // untouched, still template default
    });
  });

  describe("Write-path integration (timed trigger staging)", function() {
    it("should NOT write the public value immediately, only stage the raw value", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      const changed = store.setAttribute("Motor1.slowAvg", 42);
      changed.length.should.equal(0);
      store.getValue("Motor1.slowAvg").should.equal(0); // still template default, untouched

      const asset = store.getState().assets.find((a) => a.name === "Motor1");
      const pending = store.getPendingRawValue(asset.id, "slowAvg");
      pending.value.should.equal(42);
    });

    it("should commit the computed value once the scheduler consumes the staged raw value", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });
      const scheduler = new AttributeScriptScheduler(() => store, engine, null);

      store.setAttribute("Motor1.slowAvg", 42);
      store.getValue("Motor1.slowAvg").should.equal(0);

      const asset = store.getState().assets.find((a) => a.name === "Motor1");
      scheduler.runTrigger(store, { assetId: asset.id, attributeName: "slowAvg", path: "Motor1.slowAvg", script: sampleState.attributeTemplates[0].attributes[4].script });

      store.getValue("Motor1.slowAvg").should.equal(42);
    });

    it("should skip the trigger run when no raw value has arrived for onlyOnWrite policy", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });
      const scheduler = new AttributeScriptScheduler(() => store, engine, null);
      const asset = store.getState().assets.find((a) => a.name === "Motor1");

      const scriptCfg = {
        enabled: true,
        code: "return self + 10;",
        trigger: { mode: "schedule", scheduleId: "sched-1", runPolicy: "onlyOnWrite" }
      };

      scheduler.runTrigger(store, { assetId: asset.id, attributeName: "slowAvg", path: "Motor1.slowAvg", script: scriptCfg });

      store.getValue("Motor1.slowAvg").should.equal(0); // untouched — skipped because no pending write existed
    });

    it("should automatically run the script using current/default value for always policy even if no write arrived", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });
      const scheduler = new AttributeScriptScheduler(() => store, engine, null);
      const asset = store.getState().assets.find((a) => a.name === "Motor1");

      // script reading sibling Speed (default: undefined on this template, or returning current/self)
      const scriptCfg = {
        enabled: true,
        code: "return (self || 0) + 50;",
        trigger: { mode: "schedule", scheduleId: "sched-1", runPolicy: "always" }
      };

      scheduler.runTrigger(store, { assetId: asset.id, attributeName: "slowAvg", path: "Motor1.slowAvg", script: scriptCfg });

      store.getValue("Motor1.slowAvg").should.equal(50); // executed immediately without waiting for write
    });

    it("rebuild() subscribed to RED.events should trigger calculation on schedule event broadcast", function() {
      const { EventEmitter } = require("events");
      const mockRED = { events: new EventEmitter() };
      const engine = new AttributeScriptEngine();
      const schedState = JSON.parse(JSON.stringify(sampleState));
      const attr = schedState.attributeTemplates[0].attributes[4]; // slowAvg
      attr.default = 7;
      attr.script.trigger = { mode: "schedule", scheduleId: "sched-test", runPolicy: "always" };
      const store = createAssetStore(schedState, { scriptEngine: engine });
      const scheduler = new AttributeScriptScheduler(() => store, engine, null, mockRED);

      scheduler.rebuild();
      store.setAttribute("Motor1.slowAvg", 15);
      mockRED.events.emit("kufayeka-trigger-schedule:sched-test");

      store.getValue("Motor1.slowAvg").should.equal(15);
      scheduler.teardown();
    });
  });

  describe("AttributeScriptScheduler.rebuild", function() {
    afterEach(function() {
      // avoid leaking intervals/cron jobs across tests
    });

    it("should discover timed-trigger scripted attributes via listScriptedAttributes", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      const scripted = store.listScriptedAttributes();
      const names = scripted.map((s) => s.attributeName).sort();
      names.should.deepEqual(["sharedAccum", "slowAccum", "slowAvg"]);
    });

    it("should subscribe and unsubscribe to RED.events per scripted attribute without throwing", function() {
      const { EventEmitter } = require("events");
      const mockRED = { events: new EventEmitter() };
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });
      const scheduler = new AttributeScriptScheduler(() => store, engine, null, mockRED);

      scheduler.rebuild();
      scheduler.listeners.size.should.equal(3);
      scheduler.teardown();
      scheduler.listeners.size.should.equal(0);
    });
  });

  describe("`current` — previous value access (accumulator / encoder-jump handling)", function() {
    it("should expose the attribute's own value from before this write as `current` (onChange)", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      // encoder jumps forward: 10 -> accumulate 10; then 25 -> +15 more -> 25 total
      store.setAttribute("Motor1.accumLength", 10);
      store.getValue("Motor1.accumLength").should.equal(10);

      store.setAttribute("Motor1.accumLength", 25);
      store.getValue("Motor1.accumLength").should.equal(25);
    });

    it("should ignore a backward encoder jump using `current` in the script's own guard logic", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      store.setAttribute("Motor1.accumLength", 25);
      // encoder glitches backward to 3 (below current) -> script's own delta<0 guard treats it as 0
      store.setAttribute("Motor1.accumLength", 3);
      store.getValue("Motor1.accumLength").should.equal(25);
    });

    it("should expose `current` for timed-trigger scripts too, via the scheduler", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });
      const scheduler = new AttributeScriptScheduler(() => store, engine, null);
      const asset = store.getState().assets.find((a) => a.name === "Motor1");
      const scriptCfg = sampleState.attributeTemplates[0].attributes[6].script; // slowAccum

      store.setAttribute("Motor1.slowAccum", 5);
      scheduler.runTrigger(store, { assetId: asset.id, attributeName: "slowAccum", path: "Motor1.slowAccum", script: scriptCfg });
      store.getValue("Motor1.slowAccum").should.equal(5); // current(0) + staged self(5)

      store.setAttribute("Motor1.slowAccum", 3);
      scheduler.runTrigger(store, { assetId: asset.id, attributeName: "slowAccum", path: "Motor1.slowAccum", script: scriptCfg });
      store.getValue("Motor1.slowAccum").should.equal(8); // current(5) + staged self(3)
    });
  });

  describe("`prevSelf` — single-attribute delta accumulator (no companion attribute needed)", function() {
    it("should accumulate only the positive deltas across a jumpy encoder sequence using ONE attribute", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      // Real encoder trace from the conversation: 0,10,5,10,35,40,20,68,100,103
      [0, 10, 5, 10, 35, 40, 20, 68, 100, 103].forEach((reading) => {
        store.setAttribute("Motor1.encoderTotal", reading);
      });

      store.getValue("Motor1.encoderTotal").should.equal(128);
    });

    it("should treat the very first run's `prevSelf` as undefined (no phantom initial delta)", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      store.setAttribute("Motor1.encoderTotal", 42);
      store.getValue("Motor1.encoderTotal").should.equal(0); // guarded: prevSelf undefined -> delta 0

      store.setAttribute("Motor1.encoderTotal", 50);
      store.getValue("Motor1.encoderTotal").should.equal(8); // 50 - 42
    });

    it("should still remember prevSelf even when the script throws, so the next delta is correct", function() {
      const engine = new AttributeScriptEngine();
      const throwingState = JSON.parse(JSON.stringify(sampleState));
      throwingState.attributeTemplates[0].attributes[7].script.code =
        "if (self === 5) throw new Error('simulated glitch');\n" +
        "const delta = (prevSelf === undefined) ? 0 : self - prevSelf;\nreturn current + Math.max(0, delta);";
      const store = createAssetStore(throwingState, { scriptEngine: engine });

      store.setAttribute("Motor1.encoderTotal", 10); // total: 0 (first run, prevSelf undefined)
      store.setAttribute("Motor1.encoderTotal", 5); // throws, skipped — but prevSelf still becomes 5
      store.getValue("Motor1.encoderTotal").should.equal(0);

      store.setAttribute("Motor1.encoderTotal", 20); // delta vs prevSelf(5), not vs the stale pre-throw value(10)
      store.getValue("Motor1.encoderTotal").should.equal(15);
    });
  });

  describe("Sibling attribute & cross-asset writes from calculation scripts", function() {
    it("should write to a sibling attribute via direct assignment (e.g. status = 'ALARM')", function() {
      const engine = new AttributeScriptEngine();
      const stateWithAlarm = JSON.parse(JSON.stringify(sampleState));
      stateWithAlarm.attributeTemplates[0].attributes.push(
        { name: "status", valueType: "string", default: "NORMAL" },
        {
          name: "tempCheck",
          valueType: "number",
          default: 0,
          script: {
            enabled: true,
            code: "if (self > 80) { status = 'ALARM'; } else { status = 'NORMAL'; }\nreturn self;",
            trigger: { mode: "onChange" }
          }
        }
      );

      const store = createAssetStore(stateWithAlarm, { scriptEngine: engine });

      store.getValue("Motor1.status").should.equal("NORMAL");

      store.setAttribute("Motor1.tempCheck", 95);
      store.getValue("Motor1.tempCheck").should.equal(95);
      store.getValue("Motor1.status").should.equal("ALARM");

      store.setAttribute("Motor1.tempCheck", 50);
      store.getValue("Motor1.status").should.equal("NORMAL");
    });

    it("should write to a sibling attribute via setSibling() helper function", function() {
      const engine = new AttributeScriptEngine();
      const stateWithAlarm = JSON.parse(JSON.stringify(sampleState));
      stateWithAlarm.attributeTemplates[0].attributes.push(
        { name: "status", valueType: "string", default: "IDLE" },
        {
          name: "runner",
          valueType: "number",
          default: 0,
          script: {
            enabled: true,
            code: "setSibling('status', 'RUNNING');\nreturn self * 2;",
            trigger: { mode: "onChange" }
          }
        }
      );

      const store = createAssetStore(stateWithAlarm, { scriptEngine: engine });
      store.setAttribute("Motor1.runner", 25);
      store.getValue("Motor1.runner").should.equal(50);
      store.getValue("Motor1.status").should.equal("RUNNING");
    });

    it("should write to a sibling attribute via sibling proxy object (sibling.attr = val)", function() {
      const engine = new AttributeScriptEngine();
      const stateWithAlarm = JSON.parse(JSON.stringify(sampleState));
      stateWithAlarm.attributeTemplates[0].attributes.push(
        { name: "status", valueType: "string", default: "IDLE" },
        {
          name: "runner",
          valueType: "number",
          default: 0,
          script: {
            enabled: true,
            code: "sibling.status = 'STOPPED';\nreturn self;",
            trigger: { mode: "onChange" }
          }
        }
      );

      const store = createAssetStore(stateWithAlarm, { scriptEngine: engine });
      store.setAttribute("Motor1.runner", 10);
      store.getValue("Motor1.status").should.equal("STOPPED");
    });

    it("should immediately see the updated sibling value if read again in the same script", function() {
      const engine = new AttributeScriptEngine();
      const stateWithAlarm = JSON.parse(JSON.stringify(sampleState));
      stateWithAlarm.attributeTemplates[0].attributes.push(
        { name: "mode", valueType: "string", default: "OFF" },
        {
          name: "checker",
          valueType: "boolean",
          default: false,
          script: {
            enabled: true,
            code: "mode = 'AUTO';\nreturn mode === 'AUTO';",
            trigger: { mode: "onChange" }
          }
        }
      );

      const store = createAssetStore(stateWithAlarm, { scriptEngine: engine });
      store.setAttribute("Motor1.checker", 1);
      store.getValue("Motor1.checker").should.equal(true);
      store.getValue("Motor1.mode").should.equal("AUTO");
    });

    it("should write across assets using % path and notify subscribers", function() {
      const engine = new AttributeScriptEngine();
      const multiState = {
        attributeTemplates: [
          {
            id: "tmpl-a",
            name: "TemplateA",
            attributes: [
              {
                name: "triggerAttr",
                valueType: "number",
                default: 0,
                script: {
                  enabled: true,
                  code: "%Plant1.Tank1.Level = self * 10;\nreturn self;",
                  trigger: { mode: "onChange" }
                }
              }
            ]
          },
          {
            id: "tmpl-b",
            name: "TemplateB",
            attributes: [{ name: "Level", valueType: "number", default: 0 }]
          }
        ],
        assets: [
          { id: "p1", name: "Plant1", parentId: null, templateIds: [], attributes: {} },
          { id: "t1", name: "Tank1", parentId: "p1", templateIds: ["tmpl-b"], attributes: {} },
          { id: "m1", name: "Motor1", parentId: "p1", templateIds: ["tmpl-a"], attributes: {} }
        ],
        historians: []
      };

      let store;
      const mockAssetController = {
        requireStore: () => store,
        getState: () => store.getState(),
        getValue: (path, def) => store.getValue(path, def),
        setAttribute: (path, val) => store.setAttribute(path, val),
        setAttributes: (items) => store.setAttributes(items)
      };

      store = createAssetStore(multiState, { scriptEngine: engine, assetController: mockAssetController });

      store.getValue("Plant1.Tank1.Level").should.equal(0);
      store.setAttribute("Plant1.Motor1.triggerAttr", 5);
      store.getValue("Plant1.Motor1.triggerAttr").should.equal(5);
      store.getValue("Plant1.Tank1.Level").should.equal(50);
    });

    it("should prevent circular recursion loops without crashing the process", function() {
      const engine = new AttributeScriptEngine();
      const circularState = {
        attributeTemplates: [
          {
            id: "tmpl-circ",
            name: "CircularTmpl",
            attributes: [
              {
                name: "attrA",
                valueType: "number",
                default: 0,
                script: {
                  enabled: true,
                  code: "attrB = self + 1;\nreturn self;",
                  trigger: { mode: "onChange" }
                }
              },
              {
                name: "attrB",
                valueType: "number",
                default: 0,
                script: {
                  enabled: true,
                  code: "attrA = self + 1;\nreturn self;",
                  trigger: { mode: "onChange" }
                }
              }
            ]
          }
        ],
        assets: [{ id: "c1", name: "Node1", parentId: null, templateIds: ["tmpl-circ"], attributes: {} }],
        historians: []
      };

      const store = createAssetStore(circularState, { scriptEngine: engine });

      // Setting attrA triggers attrB write, which tries to trigger attrA write -> intercepted gracefully by execution stack guard
      (() => {
        store.setAttribute("Node1.attrA", 10);
      }).should.not.throw();

      store.getValue("Node1.attrA").should.equal(10);
      store.getValue("Node1.attrB").should.equal(11);
    });
  });

  describe("Shared Trigger Schedule (centralized broadcast via RED.events)", function() {
    const { EventEmitter } = require("events");
    const CHANNEL = "kufayeka-trigger-schedule:sched1";
    // sampleState also carries slowAvg/slowAccum (real setInterval-based triggers) — every
    // rebuild() here creates those too, so always tear the scheduler down afterwards, or the
    // real interval keeps firing for the rest of the mocha process.
    let activeScheduler;

    afterEach(function() {
      if (activeScheduler) activeScheduler.teardown();
      activeScheduler = null;
    });

    function mockRedWithEvents() {
      return { events: new EventEmitter() };
    }

    it("should run the calculation when the schedule broadcasts on RED.events", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });
      const mockRED = mockRedWithEvents();
      activeScheduler = new AttributeScriptScheduler(() => store, engine, null, mockRED);

      activeScheduler.rebuild();
      store.setAttribute("Motor1.sharedAccum", 42); // stages the raw value, no independent timer needed
      mockRED.events.emit(CHANNEL);

      store.getValue("Motor1.sharedAccum").should.equal(42);
    });

    it("should subscribe on RED.events instead of resolving a live node reference", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });
      const mockRED = mockRedWithEvents();
      activeScheduler = new AttributeScriptScheduler(() => store, engine, null, mockRED);

      activeScheduler.rebuild();
      const entry = activeScheduler.listeners.get("m1:sharedAccum");
      entry.channel.should.equal(CHANNEL);
      mockRED.events.listenerCount(CHANNEL).should.equal(1);
    });

    it("should detach its listener on teardown so a torn-down scheduler stops reacting", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });
      const mockRED = mockRedWithEvents();
      activeScheduler = new AttributeScriptScheduler(() => store, engine, null, mockRED);

      activeScheduler.rebuild();
      activeScheduler.teardown();
      mockRED.events.listenerCount(CHANNEL).should.equal(0);

      store.setAttribute("Motor1.sharedAccum", 99);
      mockRED.events.emit(CHANNEL);
      store.getValue("Motor1.sharedAccum").should.equal(0); // untouched — listener was removed
    });

    it("should not accumulate duplicate listeners across repeated rebuild() calls", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });
      const mockRED = mockRedWithEvents();
      activeScheduler = new AttributeScriptScheduler(() => store, engine, null, mockRED);

      activeScheduler.rebuild();
      activeScheduler.rebuild(); // simulate a second schema-change/deploy event
      mockRED.events.listenerCount(CHANNEL).should.equal(1);
    });

    it("should subscribe successfully even before the schedule config node has been constructed", function() {
      // The whole point of broadcasting by ID: rebuild() never resolves a live node object, so
      // subscribing can never fail due to construction order — unlike the old RED.nodes.getNode()
      // approach, which logged "not found" whenever the schedule hadn't constructed yet.
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });
      const mockRED = mockRedWithEvents();
      activeScheduler = new AttributeScriptScheduler(() => store, engine, null, mockRED);

      (() => activeScheduler.rebuild()).should.not.throw();
      activeScheduler.listeners.has("m1:sharedAccum").should.be.true();

      // The schedule node "constructs" and broadcasts later — still received correctly.
      store.setAttribute("Motor1.sharedAccum", 7);
      mockRED.events.emit(CHANNEL);
      store.getValue("Motor1.sharedAccum").should.equal(7);
    });

    it("should log an error and skip silently when RED.events itself is unavailable", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });
      const mockRED = {};
      activeScheduler = new AttributeScriptScheduler(() => store, engine, null, mockRED);

      (() => activeScheduler.rebuild()).should.not.throw();
      activeScheduler.listeners.has("m1:sharedAccum").should.be.false();
    });
  });

  describe("Watch mode — reactive recompute off dependency changes (no independently-clocked poll)", function() {
    it("should recompute `result = a * b` immediately when `a` is written, with no separate schedule tick", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      store.setAttribute("Motor1.a", 90);
      store.setAttribute("Motor1.b", 73);

      store.getValue("Motor1.result").should.equal(6570);
    });

    it("should recompute `result` when only `b` changes, reusing the last-written `a`", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      store.setAttribute("Motor1.a", 10);
      store.setAttribute("Motor1.b", 5);
      store.getValue("Motor1.result").should.equal(50);

      store.setAttribute("Motor1.b", 7);
      store.getValue("Motor1.result").should.equal(70);
    });

    it("should broadcast the cascaded `result` change even though only `a`/`b` were explicitly written — this is what fixes the read-after-write race a consumer would otherwise see", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });
      const events = [];
      store.subscribe((meta) => events.push(meta));

      store.setAttributes([
        { path: "Motor1.a", value: 90 },
        { path: "Motor1.b", value: 73 }
      ]);

      const lastEvent = events[events.length - 1];
      const changedNames = lastEvent.change.changes.map((c) => c.attributeName);
      changedNames.should.containEql("a");
      changedNames.should.containEql("b");
      changedNames.should.containEql("result");
      const resultChange = lastEvent.change.changes.find((c) => c.attributeName === "result");
      resultChange.value.should.equal(6570);
    });

    it("should chain through a second watcher (`resultDoubled` watches `result`, which watches `a`/`b`)", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      store.setAttribute("Motor1.a", 3);
      store.setAttribute("Motor1.b", 4);

      store.getValue("Motor1.result").should.equal(12);
      store.getValue("Motor1.resultDoubled").should.equal(24);
    });

    it("should not infinite-loop on a circular watch graph (cycA watches cycB, cycB watches cycA)", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      // A direct write to cycA cascades into cycB (which watches cycA), which would cascade back
      // into cycA again (which watches cycB) — the `visited` guard must stop this from looping.
      (() => store.setAttribute("Motor1.cycA", 1)).should.not.throw();
    });

    it("should still run its own script (not pass the raw value through) on a direct write to a watch-mode attribute — proves it isn't staged/skipped like 'schedule' mode", function() {
      const engine = new AttributeScriptEngine();
      const store = createAssetStore(sampleState, { scriptEngine: engine });

      // `a` and `b` are both still their default of 0 here, so the script (`return a * b`) computes
      // 0 regardless of the raw value written — the point being it RAN at all instead of being
      // staged into pendingRawByAttr and skipped like "schedule" mode would.
      const changed = store.setAttribute("Motor1.result", 999);
      changed.length.should.equal(1);
      store.getValue("Motor1.result").should.equal(0);
    });
  });
});
