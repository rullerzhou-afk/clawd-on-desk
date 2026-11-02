"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createIdleActivityController,
  listIdleActivityStates,
  normalizeFrequency,
  pickDuration,
} = require("../src/idle-activity");

function fakeClock() {
  let nowMs = 0;
  let nextId = 0;
  const timers = [];
  return {
    now: () => nowMs,
    get pendingTimers() { return timers.length; },
    setTimeout(fn, ms) {
      const timer = { id: ++nextId, at: nowMs + ms, fn };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        nowMs = due.at;
        due.fn();
      }
      nowMs = target;
    },
  };
}

const THEME = {
  states: {
    idle: ["idle.svg"],
    roam: ["roam.svg"],
    sleeping: ["sleep.svg"],
    waking: ["waking.svg"],
    yawning: ["yawning.svg"],
    dozing: ["dozing.svg"],
    collapsing: ["collapsing.svg"],
    dizzy: ["dizzy.svg"],
    error: ["error.svg"],
    notification: ["notify.svg"],
    thinking: ["think.svg"],
    working: ["work.svg"],
    attention: ["happy.svg"],
    sweeping: ["sweep.svg"],
    "mini-idle": ["mini.svg"],
    happy: ["custom-happy.svg"],
  },
  timings: { autoReturn: { attention: 4000, sweeping: 300000 } },
};

function harness(overrides = {}) {
  const clock = fakeClock();
  const sent = [];
  const restores = [];
  let generation = 0;
  let currentGeneration = null;
  let state = "idle";
  let theme = THEME;
  let canPlay = true;
  const controller = createIdleActivityController({
    getTheme: () => theme,
    getCurrentState: () => state,
    canPlay: () => canPlay,
    restoreIdleVisual: () => restores.push(clock.now()),
    isVisualGenerationCurrent: (value) => value === currentGeneration,
    sendToRenderer: (...args) => {
      const visualGeneration = ++generation;
      currentGeneration = visualGeneration;
      sent.push({ args, visualGeneration });
      return { visualGeneration };
    },
    random: () => 0,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    ...overrides,
  });
  return {
    controller,
    clock,
    sent,
    restores,
    settle: (settlement = {}, index = sent.length - 1) => {
      const request = sent[index];
      request.args[3].onLogicalSettlement({
        status: "committed",
        visualGeneration: request.visualGeneration,
        ...settlement,
      });
    },
    setCurrentGeneration: (value) => { currentGeneration = value; },
    setState: (value) => { state = value; },
    setTheme: (value) => { theme = value; },
    setCanPlay: (value) => { canPlay = value; },
  };
}

test("lists only decorative states with their own visuals", () => {
  const states = listIdleActivityStates(THEME).map((entry) => entry.state);
  assert.deepEqual(states, ["thinking", "working", "attention", "sweeping", "happy"]);
  assert.deepEqual(listIdleActivityStates(null), []);
});

test("frequency and duration inputs are normalized and bounded", () => {
  assert.equal(normalizeFrequency("high"), "high");
  assert.equal(normalizeFrequency("nope"), "medium");
  assert.equal(normalizeFrequency(undefined), "medium");
  assert.ok(pickDuration(THEME, "sweeping", () => 0) <= 8000);
  assert.ok(pickDuration(THEME, "sweeping", () => 0) >= 2000);
  assert.equal(pickDuration(THEME, "thinking", () => 0), 2550);
  assert.equal(pickDuration(THEME, "attention", () => 0), 3400);
  assert.equal(pickDuration({ timings: { autoReturn: { attention: 100 } } }, "attention", () => 0), 2000);
});

test("disabled mode never plays and never schedules", () => {
  const h = harness();
  h.clock.advance(600000);
  h.controller.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.controller.isAnimating(), false);
});

test("waits for committed display before timing the beat and restoring rest", () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.controller.tick();
  h.clock.advance(19999);
  h.controller.tick();
  assert.equal(h.sent.length, 0, "must wait for the first-delay window");

  h.clock.advance(1);
  h.controller.tick();
  assert.deepEqual(h.sent[0].args.slice(0, 3), ["state-change", "idle", "think.svg"]);
  assert.equal(h.controller.isAnimating(), true);

  h.clock.advance(10000);
  assert.deepEqual(h.restores, [], "sending alone must not arm the duration timer");
  assert.equal(h.controller.isAnimating(), true);
  h.settle();
  h.clock.advance(2549);
  assert.deepEqual(h.restores, []);
  h.clock.advance(1);
  assert.deepEqual(h.restores, [32550]);
  assert.equal(h.controller.isAnimating(), false);

  // The next beat waits for the steady interval instead of the first delay.
  h.clock.advance(59999);
  h.controller.tick();
  assert.equal(h.sent.length, 1);
  h.clock.advance(1);
  h.controller.tick();
  assert.equal(h.sent.length, 2);
});

test("a real state change keeps the real visual instead of restoring idle", () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.controller.tick();
  h.clock.advance(20000);
  h.controller.tick();
  assert.equal(h.sent.length, 1);
  h.settle();

  h.setState("working");
  h.clock.advance(3000);
  assert.deepEqual(h.restores, [], "restore must not overwrite a working visual");
  assert.equal(h.controller.isAnimating(), false);
});

test("environment gates hold the beat and retry later", () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.setCanPlay(false);
  h.controller.tick();
  h.clock.advance(20000);
  h.controller.tick();
  assert.equal(h.sent.length, 0);

  h.setCanPlay(true);
  h.clock.advance(3999);
  h.controller.tick();
  assert.equal(h.sent.length, 0, "a held beat retries after the retry delay");
  h.clock.advance(1);
  h.controller.tick();
  assert.equal(h.sent.length, 1);
});

test("a theme without decorative states is a no-op", () => {
  const h = harness();
  h.setTheme({ states: { idle: ["idle.svg"], sleeping: ["sleep.svg"] } });
  h.controller.setEnabled(true);
  h.controller.tick();
  h.clock.advance(20000);
  h.controller.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.controller.isAnimating(), false);
});

function startBeat(h) {
  h.controller.setEnabled(true);
  h.controller.tick();
  h.clock.advance(20000);
  h.controller.tick();
}

test("ticks cannot overlap an unsettled or committed beat with an expired deadline", () => {
  const h = harness();
  startBeat(h);
  h.controller.tick();
  h.clock.advance(1000);
  h.controller.tick();
  assert.equal(h.sent.length, 1);
  h.settle();
  h.controller.tick();
  h.clock.advance(1000);
  h.controller.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.controller.isAnimating(), true);
});

test("an expired deadline only plays after the logical state returns to idle", () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.controller.tick();
  h.setState("working");
  h.clock.advance(20000);
  h.controller.tick();
  assert.equal(h.sent.length, 0);
  h.setState("idle");
  h.controller.tick();
  assert.equal(h.sent.length, 1);
});

for (const [frequency, delay] of [["high", 12000], ["low", 30000]]) {
  test(`${frequency} frequency uses its first delay and re-times an existing idle deadline`, () => {
    const h = harness();
    h.controller.setEnabled(true);
    h.controller.tick();
    h.clock.advance(5000);
    h.controller.setFrequency(frequency);
    assert.equal(h.controller.frequency, frequency);
    h.controller.tick();
    h.clock.advance(delay - 1);
    h.controller.tick();
    assert.equal(h.sent.length, 0);
    h.clock.advance(1);
    h.controller.tick();
    assert.equal(h.sent.length, 1);
  });
}

for (const [frequency, repeat] of [["high", 30000], ["low", 120000]]) {
  test(`changing to ${frequency} during playback preserves the beat and uses the new repeat interval`, () => {
    const h = harness();
    startBeat(h);
    h.settle();
    h.clock.advance(1000);
    h.controller.setFrequency(frequency);
    assert.equal(h.controller.frequency, frequency);
    assert.equal(h.controller.isAnimating(), true);
    h.controller.tick();
    assert.equal(h.sent.length, 1);
    h.clock.advance(1549);
    assert.deepEqual(h.restores, []);
    h.clock.advance(1);
    assert.deepEqual(h.restores, [22550]);
    h.clock.advance(repeat - 1);
    h.controller.tick();
    assert.equal(h.sent.length, 1);
    h.clock.advance(1);
    h.controller.tick();
    assert.equal(h.sent.length, 2);
  });
}

test("a superseding generation releases the animation gate immediately and prevents restore", () => {
  const h = harness();
  startBeat(h);
  h.settle();
  assert.equal(h.controller.isAnimating(), true);
  h.setCurrentGeneration(2);
  assert.equal(h.controller.isAnimating(), false);
  h.clock.advance(3000);
  assert.deepEqual(h.restores, []);
});

for (const status of ["superseded", "failed"]) {
  test(`${status} settlement abandons the beat and waits for the repeat delay`, () => {
    const h = harness();
    startBeat(h);
    h.settle({ status });
    assert.equal(h.controller.isAnimating(), false);
    h.clock.advance(59999);
    h.controller.tick();
    assert.equal(h.sent.length, 1, "a failed asset must not be retried on the next tick");
    assert.deepEqual(h.restores, []);
    h.clock.advance(1);
    h.controller.tick();
    assert.equal(h.sent.length, 2);
    h.settle({}, 0);
    assert.equal(h.controller.isAnimating(), true, "a late old settlement cannot end the new beat");
    h.clock.advance(3000);
    assert.deepEqual(h.restores, [], "a late old settlement cannot arm the new beat's timer");
  });
}

for (const [reason, settlement, prepare] of [
  ["invalid generation", { visualGeneration: 1.5 }, () => {}],
  ["missing generation", { visualGeneration: undefined }, () => {}],
  ["stale generation", {}, (h) => h.setCurrentGeneration(2)],
  ["non-idle state", {}, (h) => h.setState("working")],
]) {
  test(`committed settlement with ${reason} abandons without restoring`, () => {
    const h = harness(reason === "invalid generation" || reason === "missing generation"
      ? { isVisualGenerationCurrent: () => true }
      : {});
    startBeat(h);
    prepare(h);
    h.settle(settlement);
    assert.equal(h.controller.isAnimating(), false);
    h.setState("idle");
    h.clock.advance(3000);
    assert.deepEqual(h.restores, []);
    h.controller.tick();
    assert.equal(h.sent.length, 1);
    h.clock.advance(56999);
    h.controller.tick();
    assert.equal(h.sent.length, 1);
    h.clock.advance(1);
    h.controller.tick();
    assert.equal(h.sent.length, 2, "the repeat delay starts when the beat is abandoned");
  });
}

test("synchronous delivery failure cannot leave a playing beat or restore timer", () => {
  let deliveries = 0;
  const h = harness({
    sendToRenderer: (channel, state, svg, options) => {
      deliveries++;
      options.onLogicalSettlement({ status: "failed", visualGeneration: 1 });
      return { visualGeneration: 1 };
    },
  });
  startBeat(h);
  assert.equal(h.controller.isAnimating(), false);
  h.clock.advance(59999);
  h.controller.tick();
  assert.equal(deliveries, 1);
  assert.deepEqual(h.restores, []);
  h.clock.advance(1);
  h.controller.tick();
  assert.equal(deliveries, 2);
});

for (const request of [undefined, {}, { visualGeneration: 1.5 }]) {
  test(`delivery without a safe generation abandons: ${JSON.stringify(request)}`, () => {
    let deliveries = 0;
    let settle;
    const h = harness({
      sendToRenderer: (channel, state, svg, options) => {
        deliveries++;
        settle = options.onLogicalSettlement;
        return request;
      },
    });
    startBeat(h);
    assert.equal(h.controller.isAnimating(), false);
    settle({ status: "committed", visualGeneration: 1 });
    h.clock.advance(59999);
    h.controller.tick();
    assert.equal(deliveries, 1);
    assert.deepEqual(h.restores, []);
    h.clock.advance(1);
    h.controller.tick();
    assert.equal(deliveries, 2);
  });
}

test("timeout recovery uses the generation from settlement for ownership and restore", () => {
  const h = harness();
  startBeat(h);
  h.clock.advance(10000);
  h.setCurrentGeneration(2);
  assert.equal(h.controller.isAnimating(), true, "an unsettled recovery still holds the gate");
  h.settle({ visualGeneration: 2 });
  assert.equal(h.controller.isAnimating(), true);
  h.clock.advance(2550);
  assert.deepEqual(h.restores, [32550]);
});

for (const committed of [false, true]) {
  test(`disabling restores an owned ${committed ? "committed" : "unsettled"} beat exactly once`, () => {
    const h = harness();
    startBeat(h);
    if (committed) h.settle();
    h.controller.setEnabled(false);
    assert.equal(h.controller.isAnimating(), false);
    assert.deepEqual(h.restores, [20000]);
    h.settle();
    h.controller.setEnabled(false);
    h.clock.advance(10000);
    assert.deepEqual(h.restores, [20000], "late settlement and timer must not restore again");
  });
}

for (const takeover of ["generation", "state"]) {
  test(`disabling after ${takeover} takeover leaves the new visual alone`, () => {
    const h = harness();
    startBeat(h);
    h.settle();
    if (takeover === "generation") h.setCurrentGeneration(2);
    else h.setState("working");
    h.controller.setEnabled(false);
    h.clock.advance(10000);
    assert.deepEqual(h.restores, []);
    assert.equal(h.controller.isAnimating(), false);
  });
}

for (const committed of [false, true]) {
  test(`cancel clears an ${committed ? "committed" : "unsettled"} beat without restoring`, () => {
    const h = harness();
    startBeat(h);
    if (committed) h.settle();
    assert.equal(h.clock.pendingTimers, committed ? 1 : 0);
    h.controller.cancel();
    assert.equal(h.clock.pendingTimers, 0);
    h.settle();
    h.clock.advance(10000);
    assert.equal(h.controller.isAnimating(), false);
    assert.deepEqual(h.restores, []);
  });
}

test("cancel restarts the first delay on the next idle tick", () => {
  const h = harness();
  startBeat(h);
  h.settle();
  h.controller.cancel();
  h.controller.tick();
  assert.equal(h.sent.length, 1);
  h.clock.advance(19999);
  h.controller.tick();
  assert.equal(h.sent.length, 1);
  h.clock.advance(1);
  h.controller.tick();
  assert.equal(h.sent.length, 2);
});

test("entering idle discards an expired deadline and waits for a fresh first delay", () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.controller.tick();
  h.setState("working");
  h.clock.advance(100000);
  h.setState("idle");
  h.controller.noteIdleEntered();
  h.controller.tick();
  assert.equal(h.sent.length, 0);
  h.clock.advance(19999);
  h.controller.tick();
  assert.equal(h.sent.length, 0);
  h.clock.advance(1);
  h.controller.tick();
  assert.equal(h.sent.length, 1);
});

test("entering idle during a beat preserves its duration and repeat schedule", () => {
  const h = harness();
  startBeat(h);
  h.controller.noteIdleEntered();
  h.settle();
  h.clock.advance(1000);
  h.controller.noteIdleEntered();
  h.controller.tick();
  assert.equal(h.controller.isAnimating(), true);
  assert.equal(h.sent.length, 1);
  h.clock.advance(1550);
  assert.deepEqual(h.restores, [22550]);
  h.clock.advance(59999);
  h.controller.tick();
  assert.equal(h.sent.length, 1);
  h.clock.advance(1);
  h.controller.tick();
  assert.equal(h.sent.length, 2);
});
