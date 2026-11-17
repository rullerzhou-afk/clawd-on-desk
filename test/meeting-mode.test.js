"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  MEETING_MODE_DURATIONS_MIN,
  createMeetingModeController,
  formatMeetingEndTime,
} = require("../src/meeting-mode");

function makeHarness({ petHidden = false, dnd = false } = {}) {
  const state = { petHidden, dnd, now: 1_000_000, timers: [], calls: [], changes: [] };
  const controller = createMeetingModeController({
    hidePet: () => { state.calls.push("hidePet"); state.petHidden = true; },
    showPet: () => { state.calls.push("showPet"); state.petHidden = false; },
    isPetHidden: () => state.petHidden,
    enableDnd: () => { state.calls.push("enableDnd"); state.dnd = true; },
    disableDnd: () => { state.calls.push("disableDnd"); state.dnd = false; },
    isDnd: () => state.dnd,
    onChange: (s) => state.changes.push(s),
    now: () => state.now,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      state.timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
  });
  state.liveTimer = () => state.timers.filter((t) => !t.cleared).at(-1);
  state.fire = () => {
    const timer = state.liveTimer();
    timer.cleared = true;
    timer.fn();
  };
  return { controller, state };
}

describe("meeting mode controller (#1382)", () => {
  it("offers 30, 60 and 120 minutes", () => {
    assert.deepStrictEqual([...MEETING_MODE_DURATIONS_MIN], [30, 60, 120]);
  });

  it("start turns on DND, hides the pet and arms a timer for the duration", () => {
    const { controller, state } = makeHarness();
    assert.strictEqual(controller.start(30), true);
    assert.deepStrictEqual(state.calls, ["enableDnd", "hidePet"]);
    assert.deepStrictEqual(controller.getState(), { active: true, endsAt: 1_000_000 + 30 * 60_000 });
    assert.strictEqual(state.liveTimer().ms, 30 * 60_000);
    assert.strictEqual(state.changes.length, 1);
  });

  it("timeout restores both and reports inactive", () => {
    const { controller, state } = makeHarness();
    controller.start(60);
    state.now += 60 * 60_000;
    state.fire();
    assert.deepStrictEqual(state.calls, ["enableDnd", "hidePet", "disableDnd", "showPet"]);
    assert.strictEqual(state.petHidden, false);
    assert.strictEqual(state.dnd, false);
    assert.deepStrictEqual(controller.getState(), { active: false, endsAt: 0 });
  });

  it("only undoes what it changed: a pet hidden before stays hidden, DND on before stays on", () => {
    const { controller, state } = makeHarness({ petHidden: true, dnd: true });
    controller.start(30);
    assert.deepStrictEqual(state.calls, []);
    controller.end("menu");
    assert.deepStrictEqual(state.calls, []);
    assert.strictEqual(state.petHidden, true);
    assert.strictEqual(state.dnd, true);
  });

  it("restores only the half it changed", () => {
    const { controller, state } = makeHarness({ petHidden: false, dnd: true });
    controller.start(30);
    assert.deepStrictEqual(state.calls, ["hidePet"]);
    controller.end("menu");
    assert.deepStrictEqual(state.calls, ["hidePet", "showPet"]);
    assert.strictEqual(state.dnd, true);
  });

  it("starting again while active extends the end time without re-snapshotting", () => {
    const { controller, state } = makeHarness();
    controller.start(30);
    state.now += 10 * 60_000;
    controller.start(60);
    assert.deepStrictEqual(state.calls, ["enableDnd", "hidePet"]);
    assert.strictEqual(controller.getState().endsAt, state.now + 60 * 60_000);
    assert.strictEqual(state.timers.filter((t) => !t.cleared).length, 1);
    controller.end("menu");
    assert.strictEqual(state.petHidden, false);
    assert.strictEqual(state.dnd, false);
  });

  it("checkExpiry after sleep ends an overdue meeting and re-arms an early one", () => {
    const { controller, state } = makeHarness();
    controller.start(30);
    state.now += 10 * 60_000;
    assert.strictEqual(controller.checkExpiry(), false);
    assert.strictEqual(state.liveTimer().ms, 20 * 60_000);
    state.now += 45 * 60_000; // the machine slept past the end
    assert.strictEqual(controller.checkExpiry(), true);
    assert.strictEqual(controller.isActive(), false);
    assert.strictEqual(state.liveTimer(), undefined);
  });

  it("a timer that fires early (clock skew) re-arms instead of ending", () => {
    const { controller, state } = makeHarness();
    controller.start(30);
    state.now += 29 * 60_000;
    state.fire();
    assert.strictEqual(controller.isActive(), true);
    assert.strictEqual(state.liveTimer().ms, 60_000);
  });

  it("noteUserOverride ends an active meeting and is a no-op otherwise", () => {
    const { controller, state } = makeHarness();
    assert.strictEqual(controller.noteUserOverride("pet-shown"), false);
    controller.start(30);
    assert.strictEqual(controller.noteUserOverride("wake"), true);
    assert.strictEqual(controller.isActive(), false);
    assert.strictEqual(state.petHidden, false);
    assert.strictEqual(state.dnd, false);
  });

  it("re-entrant overrides during the restore do not recurse", () => {
    const state = { petHidden: false, dnd: false, now: 0 };
    let controller;
    const nested = [];
    controller = createMeetingModeController({
      hidePet: () => { state.petHidden = true; },
      // main.js routes the user-facing setters through noteUserOverride; the
      // restore must not loop back through them.
      showPet: () => { nested.push(controller.noteUserOverride("pet-shown")); state.petHidden = false; },
      isPetHidden: () => state.petHidden,
      enableDnd: () => { state.dnd = true; },
      disableDnd: () => { nested.push(controller.noteUserOverride("wake")); state.dnd = false; },
      isDnd: () => state.dnd,
      now: () => state.now,
      setTimeout: () => ({}),
      clearTimeout: () => {},
    });
    controller.start(30);
    assert.strictEqual(controller.end("menu"), true);
    assert.deepStrictEqual(nested, [false, false]);
    assert.strictEqual(controller.isActive(), false);
  });

  it("rejects bad durations", () => {
    const { controller, state } = makeHarness();
    for (const bad of [0, -5, NaN, "x", undefined]) {
      assert.strictEqual(controller.start(bad), false);
    }
    assert.deepStrictEqual(state.calls, []);
    assert.strictEqual(controller.isActive(), false);
  });

  it("end when inactive does nothing", () => {
    const { controller, state } = makeHarness();
    assert.strictEqual(controller.end("menu"), false);
    assert.deepStrictEqual(state.changes, []);
  });

  it("formats the end time as hours and minutes", () => {
    const at = new Date(2026, 10, 17, 14, 5).getTime();
    assert.match(formatMeetingEndTime(at, "en"), /2:05|14:05/);
    assert.match(formatMeetingEndTime(at, "zh"), /14:05/);
    assert.match(formatMeetingEndTime(at, "not a locale !!"), /14:05|2:05/);
  });
});
