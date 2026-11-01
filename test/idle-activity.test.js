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
  let state = "idle";
  let theme = THEME;
  let canPlay = true;
  const controller = createIdleActivityController({
    getTheme: () => theme,
    getCurrentState: () => state,
    canPlay: () => canPlay,
    getIdleRestSvg: () => "idle.svg",
    sendToRenderer: (...args) => sent.push(args),
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
});

test("disabled mode never plays and never schedules", () => {
  const h = harness();
  h.clock.advance(600000);
  h.controller.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.controller.isAnimating(), false);
});

test("plays an idle activity after the first delay and restores the resting visual", () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.controller.tick();
  h.clock.advance(19999);
  h.controller.tick();
  assert.equal(h.sent.length, 0, "must wait for the first-delay window");

  h.clock.advance(1);
  h.controller.tick();
  assert.deepEqual(h.sent[0], ["state-change", "idle", "think.svg"]);
  assert.equal(h.controller.isAnimating(), true);

  h.clock.advance(3000);
  assert.deepEqual(h.sent.at(-1), ["state-change", "idle", "idle.svg"]);
  assert.equal(h.controller.isAnimating(), false);

  // The next beat waits for the steady interval instead of the first delay.
  h.clock.advance(59000);
  h.controller.tick();
  assert.equal(h.sent.length, 2);
  h.clock.advance(10000);
  h.controller.tick();
  assert.equal(h.sent.length, 3);
});

test("a real state change keeps the real visual instead of restoring idle", () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.controller.tick();
  h.clock.advance(20000);
  h.controller.tick();
  assert.equal(h.sent.length, 1);

  h.setState("working");
  h.clock.advance(3000);
  assert.equal(h.sent.length, 1, "restore must not overwrite a working visual");
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

test("disabling cancels a playing beat and its restore timer", () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.controller.tick();
  h.clock.advance(20000);
  h.controller.tick();
  assert.equal(h.controller.isAnimating(), true);

  h.controller.setEnabled(false);
  assert.equal(h.controller.isAnimating(), false);
  h.clock.advance(10000);
  assert.equal(h.sent.length, 1, "cancel must not send a late restore");
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
