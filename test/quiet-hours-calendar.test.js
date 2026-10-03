"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { getQuietHoursInterval, createQuietHoursScheduler } = require("../src/quiet-hours");

const BASE = { enabled: true, days: [5], start: "22:00", end: "08:00", hidePet: false };

// Keep TZ out of the parent test process: changing it globally would make
// concurrently running tests and date-based provider fixtures nondeterministic.
function observeDst(times) {
  const parentTz = process.env.TZ;
  const script = `
    const { getQuietHoursInterval, createQuietHoursScheduler } = require(process.argv[3]);
    const config = JSON.parse(process.argv[1]);
    const times = JSON.parse(process.argv[2]);
    const state = { dnd: false, hidden: false }, changes = [];
    let current;
    const scheduler = createQuietHoursScheduler({
      getConfig: () => config, getState: () => ({ ...state }), now: () => current,
      applyState: (patch) => { changes.push(patch); Object.assign(state, patch); },
    });
    const observations = times.map((time) => {
      current = new Date(time);
      scheduler.poll();
      return { interval: getQuietHoursInterval(config, current),
        offset: current.getTimezoneOffset(), hour: current.getHours(),
        dnd: state.dnd, changeCount: changes.length };
    });
    scheduler.dispose({ restore: false });
    process.stdout.write(JSON.stringify({ observations, changes }));
  `;
  const output = execFileSync(process.execPath, ["-e", script,
    JSON.stringify({ ...BASE, days: [6] }), JSON.stringify(times),
    path.join(__dirname, "..", "src", "quiet-hours.js")], {
    encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
    env: { ...process.env, TZ: "America/New_York" },
  });
  assert.equal(process.env.TZ, parentTz);
  return JSON.parse(output);
}

function clockHarness(t, initial = new Date(2026, 9, 2, 21)) {
  let current = initial;
  const state = { dnd: false, hidden: false }, changes = [];
  const scheduler = createQuietHoursScheduler({ getConfig: () => BASE,
    getState: () => ({ ...state }), now: () => current,
    applyState: (patch) => { changes.push(patch); Object.assign(state, patch); } });
  t.after(() => scheduler.dispose({ restore: false }));
  return { scheduler, state, changes, at(date) { current = date; scheduler.poll(); } };
}

test("spring DST gap keeps Saturday ownership and restores at local 08:00", () => {
  const result = observeDst(["2026-03-08T06:59:00Z", "2026-03-08T07:00:00Z", "2026-03-08T12:00:00Z"]);
  assert.deepEqual(result.observations.map((entry) => entry.hour), [1, 3, 8]);
  assert.deepEqual(result.observations.map((entry) => entry.offset), [300, 240, 240]);
  assert.deepEqual(result.observations.map((entry) => entry.interval), ["2026-3-7:22:00", "2026-3-7:22:00", null]);
  assert.deepEqual(result.observations.map((entry) => entry.changeCount), [1, 1, 2]);
  assert.deepEqual(result.changes, [{ dnd: true }, { dnd: false }]);
});

test("fall DST repeated hour does not reacquire DND or repeat presentation side effects", () => {
  const result = observeDst(["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z", "2026-11-01T13:00:00Z"]);
  assert.deepEqual(result.observations.map((entry) => entry.hour), [1, 1, 8]);
  assert.deepEqual(result.observations.map((entry) => entry.offset), [240, 300, 300]);
  assert.deepEqual(result.observations.map((entry) => entry.interval), ["2026-10-31:22:00", "2026-10-31:22:00", null]);
  assert.deepEqual(result.observations.map((entry) => entry.changeCount), [1, 1, 2]);
  assert.deepEqual(result.changes, [{ dnd: true }, { dnd: false }]);
});

test("overnight intervals retain the previous weekday across month and year boundaries", () => {
  const thursday = { ...BASE, days: [4] };
  assert.equal(getQuietHoursInterval(thursday, new Date(2026, 4, 1, 7)), "2026-4-30:22:00");
  assert.equal(getQuietHoursInterval(thursday, new Date(2027, 0, 1, 7)), "2026-12-31:22:00");
  assert.equal(getQuietHoursInterval(thursday, new Date(2027, 0, 1, 8)), null);
  assert.equal(getQuietHoursInterval({ ...BASE, days: [2] }, new Date(2028, 2, 1, 7)), "2028-2-29:22:00");
});

test("an overnight end at midnight is exclusive and belongs to the starting day", () => {
  const config = { ...BASE, end: "00:00" };
  assert.equal(getQuietHoursInterval(config, new Date(2026, 9, 2, 21, 59, 59)), null);
  assert.equal(getQuietHoursInterval(config, new Date(2026, 9, 2, 22)), "2026-10-2:22:00");
  assert.equal(getQuietHoursInterval(config, new Date(2026, 9, 2, 23, 59, 59)), "2026-10-2:22:00");
  assert.equal(getQuietHoursInterval(config, new Date(2026, 9, 3, 0)), null);
});

test("a daytime start at midnight includes only the selected current weekday", () => {
  const config = { ...BASE, days: [6], start: "00:00" };
  assert.equal(getQuietHoursInterval(config, new Date(2026, 9, 2, 23, 59)), null);
  assert.equal(getQuietHoursInterval(config, new Date(2026, 9, 3, 0)), "2026-10-3:00:00");
  assert.equal(getQuietHoursInterval(config, new Date(2026, 9, 3, 7, 59, 59)), "2026-10-3:00:00");
  assert.equal(getQuietHoursInterval(config, new Date(2026, 9, 3, 8)), null);
});

test("a clock jump that skips an entire quiet interval does not replay it", (t) => {
  const h = clockHarness(t);
  h.scheduler.poll();
  h.at(new Date(2026, 9, 3, 9));
  assert.deepEqual(h.state, { dnd: false, hidden: false });
  assert.deepEqual(h.changes, []);
});

test("a resume or backward clock adjustment reconciles the current local interval", (t) => {
  const h = clockHarness(t);
  h.scheduler.poll();
  h.at(new Date(2026, 9, 3, 7));
  assert.equal(h.state.dnd, true);
  h.at(new Date(2026, 9, 3, 9));
  assert.equal(h.state.dnd, false);
  h.at(new Date(2026, 9, 3, 7));
  assert.equal(h.state.dnd, true);
  h.at(new Date(2026, 9, 3, 8));
  assert.equal(h.state.dnd, false);
  assert.deepEqual(h.changes, [{ dnd: true }, { dnd: false }, { dnd: true }, { dnd: false }]);
});

test("leaving a paused interval on a clock adjustment ends that manual override", (t) => {
  const h = clockHarness(t, new Date(2026, 9, 2, 23));
  h.scheduler.poll();
  h.scheduler.noteManualChange("dnd");
  h.state.dnd = false;
  h.at(new Date(2026, 9, 3, 7));
  assert.equal(h.state.dnd, false, "same overnight episode remains paused");
  h.at(new Date(2026, 9, 3, 9));
  h.at(new Date(2026, 9, 3, 7));
  assert.equal(h.state.dnd, true, "re-entry after an out-of-interval observation starts a new episode");
});
