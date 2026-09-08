const should = require("should");
const helper = require("node-red-node-test-helper");
const triggerScheduleNode = require("../../nodes/trigger-schedule.js");
const injectNode = require("../../nodes/inject-trigger.js");

describe("kufayeka-inject Node (shared trigger schedule consumer)", function() {
  before(function(done) {
    helper.init(require.resolve("node-red"));
    helper.startServer(done);
  });

  after(function(done) {
    helper.stopServer(done);
  });

  afterEach(function() {
    return helper.unload();
  });

  function flow() {
    return [
      { id: "sched1", type: "kufayeka-trigger-schedule", name: "Test Schedule", repeat: "", crontab: "", once: false, onceDelay: 0.1 },
      { id: "n1", type: "kufayeka-inject", name: "Inject1", schedule: "sched1", topic: "hello", wires: [["n2"]] },
      { id: "n2", type: "helper" }
    ];
  }

  it("should send a msg when the referenced schedule fires", function(done) {
    helper.load([triggerScheduleNode, injectNode], flow(), function() {
      const n2 = helper.getNode("n2");

      n2.on("input", function(msg) {
        msg.should.have.property("topic", "hello");
        msg.should.have.property("payload");
        done();
      });

      helper._events.emit("kufayeka-trigger-schedule:sched1");
    });
  });

  it("should stop forwarding once the node is closed (listener detached)", function(done) {
    helper.load([triggerScheduleNode, injectNode], flow(), function() {
      const n2 = helper.getNode("n2");
      let received = 0;
      n2.on("input", function() { received++; });

      helper.unload().then(function() {
        helper._events.emit("kufayeka-trigger-schedule:sched1");
        setTimeout(function() {
          received.should.equal(0);
          done();
        }, 50);
      });
    });
  });

  it("should let two kufayeka-inject nodes referencing the SAME schedule both fire from one trigger", function(done) {
    const twoInjectFlow = [
      { id: "sched1", type: "kufayeka-trigger-schedule", name: "Shared" },
      { id: "n1", type: "kufayeka-inject", schedule: "sched1", wires: [["n3"]] },
      { id: "n2", type: "kufayeka-inject", schedule: "sched1", wires: [["n3"]] },
      { id: "n3", type: "helper" }
    ];
    helper.load([triggerScheduleNode, injectNode], twoInjectFlow, function() {
      const n3 = helper.getNode("n3");
      let count = 0;
      n3.on("input", function() {
        count++;
        if (count === 2) done();
      });
      helper._events.emit("kufayeka-trigger-schedule:sched1");
    });
  });

  it("should still deliver a real 'once' fire to a consumer even though the countdown only starts on flows:started (not at construction)", function(done) {
    const onceFlow = [
      { id: "sched1", type: "kufayeka-trigger-schedule", name: "Once Schedule", repeat: "", crontab: "", once: true, onceDelay: 0.05 },
      { id: "n1", type: "kufayeka-inject", schedule: "sched1", topic: "boot", wires: [["n2"]] },
      { id: "n2", type: "helper" }
    ];
    helper.load([triggerScheduleNode, injectNode], onceFlow, function() {
      // By the time this callback runs, "flows:started" has already fired (that's what
      // helper.load() itself waits for) — the countdown only STARTS at that point, so the
      // actual fire is still onceDelay away. A pre-fix implementation (counting down from
      // node construction instead) would already have missed it here.
      const n2 = helper.getNode("n2");
      n2.on("input", function(msg) {
        msg.should.have.property("topic", "boot");
        done();
      });
    });
  });
});
