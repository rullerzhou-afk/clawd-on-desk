"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeQuietHours, validateQuietHours, getQuietHoursInterval,
  createQuietHoursScheduler } = require("../src/quiet-hours");
const config = { enabled: true, days: [5], start: "22:00", end: "08:00", hidePet: true };
function date(day, hour, minute = 0) { return new Date(2026, 9, day, hour, minute); }
function harness(initial = {}) {
  let time = date(2, 23), prefs = { ...config }, state = { dnd: false, hidden: false, ...initial };
  const changes = [];
  const scheduler = createQuietHoursScheduler({ getConfig: () => prefs, getState: () => ({ ...state }),
    now: () => time, applyState: (patch) => { changes.push(patch); Object.assign(state, patch); } });
  return { scheduler, state, changes, time: (next) => { time = next; }, config: (next) => { prefs = next; } };
}
test("overnight belongs to Friday, including Saturday morning, with an exclusive end", () => {
  assert.ok(getQuietHoursInterval(config, date(2, 22)));
  assert.equal(getQuietHoursInterval(config, date(3, 7)), getQuietHoursInterval(config, date(2, 23)));
  assert.equal(getQuietHoursInterval(config, date(3, 8)), null);
  assert.equal(getQuietHoursInterval(config, date(1, 23)), null);
  assert.equal(getQuietHoursInterval(config, date(2, 21, 59)), null);
});
test("daytime and disabled intervals", () => {
  const daytime = { ...config, start: "09:00", end: "17:00" };
  assert.ok(getQuietHoursInterval(daytime, date(2, 9)));
  assert.equal(getQuietHoursInterval(daytime, date(2, 17)), null);
  assert.equal(getQuietHoursInterval({ ...config, enabled: false }, date(2, 23)), null);
});
test("invalid equal times, weekdays and malformed inputs fail closed", () => {
  for (const value of [null, {}, { ...config, start: "24:00" }, { ...config, end: "22:00" },
    { ...config, days: [] }, { ...config, days: [1, 1] }, { ...config, days: [7] }]) {
    assert.equal(validateQuietHours(value).ok, false);
    assert.equal(normalizeQuietHours(value).enabled, false);
  }
  const a = normalizeQuietHours(null), b = normalizeQuietHours(null);
  a.days.push(0); assert.notDeepEqual(a.days, b.days);
});
test("restores only transitions it owned, preserving preexisting manual sleep/hide", () => {
  for (const initial of [{}, { dnd: true }, { hidden: true }, { dnd: true, hidden: true }]) {
    const h = harness(initial), before = { ...h.state };
    h.scheduler.poll(); assert.deepEqual(h.state, { dnd: true, hidden: true });
    h.scheduler.poll(); h.time(date(3, 8)); h.scheduler.poll();
    assert.deepEqual(h.state, before); h.scheduler.dispose();
  }
});
test("manual visibility pauses current interval and restores schedule-owned DND", () => {
  const h = harness(); h.scheduler.poll();
  h.scheduler.noteManualChange("hidden"); h.state.hidden = false;
  h.scheduler.poll(); assert.deepEqual(h.state, { dnd: false, hidden: false });
  h.time(date(9, 23)); h.scheduler.poll();
  assert.deepEqual(h.state, { dnd: true, hidden: true }); h.scheduler.dispose();
});
test("manual sleep persists beyond scheduled end", () => {
  const h = harness(); h.scheduler.poll(); h.scheduler.noteManualChange("dnd");
  h.state.dnd = true; h.time(date(3, 9)); h.scheduler.poll();
  assert.deepEqual(h.state, { dnd: true, hidden: false }); h.scheduler.dispose();
});
test("disable or schedule change restores baseline immediately", () => {
  const h = harness(); h.scheduler.poll(); h.config({ ...config, enabled: false }); h.scheduler.poll();
  assert.deepEqual(h.state, { dnd: false, hidden: false });
  h.config(config); h.scheduler.poll(); h.config({ ...config, hidePet: false }); h.scheduler.poll();
  assert.deepEqual(h.state, { dnd: true, hidden: false }); h.scheduler.dispose();
});
test("external state changes are respected and failures are retried", () => {
  const h = harness(); h.scheduler.poll(); h.state.hidden = false; h.scheduler.poll();
  assert.deepEqual(h.state, { dnd: false, hidden: false }); h.scheduler.dispose();
  let fail = true, state = { dnd: false, hidden: false }, time = date(2, 23);
  const scheduler = createQuietHoursScheduler({ getConfig: () => config, getState: () => state,
    now: () => time, applyState: (patch) => { if (fail) throw Error("failed"); Object.assign(state, patch); } });
  scheduler.poll(); assert.equal(state.dnd, false); fail = false; scheduler.poll();
  fail = true; time = date(3, 9); scheduler.poll(); assert.equal(state.dnd, true);
  fail = false; scheduler.poll(); assert.deepEqual(state, { dnd: false, hidden: false }); scheduler.dispose();
});
test("lifecycle starts only once and quit can avoid restoring UI", () => {
  let starts = 0, clears = 0;
  const state = { dnd: false, hidden: false };
  const s = createQuietHoursScheduler({ getConfig: () => config, getState: () => state,
    now: () => date(2, 23), applyState: (p) => Object.assign(state, p),
    setInterval: () => { starts++; return 1; }, clearInterval: () => { clears++; } });
  s.start(); s.start(); assert.equal(starts, 1); s.dispose({ restore: false });
  assert.equal(clears, 1); assert.equal(state.dnd, true); s.poll(); s.start(); assert.equal(starts, 1);
});
test("paused manual override retries a failed restoration of the other field", () => {
  let fail = false;
  const state = { dnd: false, hidden: false };
  const s = createQuietHoursScheduler({ getConfig: () => config, getState: () => state,
    now: () => date(2, 23), applyState: (p) => {
      if (fail && "hidden" in p) throw Error("temporary"); Object.assign(state, p);
    } });
  s.poll(); fail = true; s.noteManualChange("dnd"); state.dnd = false;
  assert.equal(state.hidden, true); fail = false; s.poll();
  assert.deepEqual(state, { dnd: false, hidden: false }); s.dispose();
});
test("deferred mini visibility restoration retains ownership and retries next poll", () => {
  let deferred = false, time = date(2, 23);
  const state = { dnd: false, hidden: false };
  const s = createQuietHoursScheduler({ getConfig: () => config, getState: () => state,
    now: () => time, applyState: (p) => {
      if (deferred && "hidden" in p) return { deferred: true }; Object.assign(state, p);
    } });
  s.poll(); time = date(3, 8); deferred = true; s.poll();
  assert.deepEqual(state, { dnd: false, hidden: true });
  deferred = false; s.poll(); assert.equal(state.hidden, false); s.dispose();
});
test("partial acquisition followed by a renderer exception still restores baseline", () => {
  let fail = true, time = date(2, 23);
  const state = { dnd: false, hidden: false };
  const s = createQuietHoursScheduler({ getConfig: () => config, getState: () => state,
    now: () => time, applyState: (p) => { Object.assign(state, p); if (fail) { fail = false; throw Error("renderer"); } } });
  s.poll(); assert.equal(state.dnd, true); s.poll(); time = date(3, 8); s.poll();
  assert.deepEqual(state, { dnd: false, hidden: false }); s.dispose();
});
