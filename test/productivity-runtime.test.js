"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { createSettingsController } = require("../src/settings-controller");
const prefs = require("../src/prefs");
const { createProductivityRuntime } = require("../src/productivity-runtime");
function harness({ unreadable = false } = {}) {
  const snapshot = prefs.getDefaults();
  snapshot.quietHours = { enabled: true, days: [5], start: "22:00", end: "08:00", hidePet: true };
  const controller = createSettingsController({ loadResult: { snapshot, locked: true, recovered: unreadable } });
  const state = { dnd: false, hidden: false }, hides = [], notices = [], timers = new Map(), power = new EventEmitter();
  let time = new Date(2026, 9, 2, 23).getTime(), raw = [], nextTimer = 0;
  const runtime = createProductivityRuntime({ settingsController: controller, now: () => time,
    state: { enableDoNotDisturb: () => { state.dnd = true; }, disableDoNotDisturb: () => { state.dnd = false; },
      getAccountQuotaSnapshot: () => raw },
    petWindowRuntime: { isPetHidden: () => state.hidden, setPetHidden: (v, opts) => { hides.push(opts); state.hidden = v; } },
    getDoNotDisturb: () => state.dnd, notifyQuota: (event) => { notices.push(event); return true; },
    powerMonitor: power, setInterval: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id) });
  return { runtime, controller, state, hides, notices, power, timers,
    time: (next) => { time = next; }, raw: (next) => { raw = next; } };
}
test("settings changes and resume immediately reconcile quiet hours, preserving fullscreen ownership", () => {
  const h = harness(); h.runtime.start(); h.runtime.start();
  assert.deepEqual(h.state, { dnd: true, hidden: true }); assert.equal(h.timers.size, 2);
  assert.deepEqual(h.hides, [{ manual: false }]);
  assert.equal(h.controller.applyUpdate("quietHours", { ...h.controller.get("quietHours"), enabled: false }).status, "ok");
  assert.deepEqual(h.state, { dnd: false, hidden: false });
  h.controller.applyUpdate("quietHours", { ...h.controller.get("quietHours"), enabled: true });
  h.time(new Date(2026, 9, 3, 9).getTime()); h.power.emit("resume");
  assert.deepEqual(h.state, { dnd: false, hidden: false });
  h.runtime.dispose(); assert.equal(h.timers.size, 0); assert.equal(h.power.listenerCount("resume"), 0);
  h.runtime.start(); assert.equal(h.timers.size, 0); h.controller.dispose();
});
test("unreadable preferences never turn on automation or notifications", () => {
  const h = harness({ unreadable: true }); h.runtime.start(); h.runtime.observeQuota();
  assert.deepEqual(h.state, { dnd: false, hidden: false }); assert.deepEqual(h.notices, []);
  h.runtime.dispose(); h.controller.dispose();
});
test("unmerged fresh windows honor DND and notify once after manual wake", () => {
  const h = harness(); h.controller.applyUpdate("quotaAlertsEnabled", true); h.runtime.start();
  const observed = new Date(2026, 9, 2, 23, 2).getTime(); h.time(observed);
  h.raw([{ sourceKey: "", host: null, codexQuota: { group: { codexFiveHour: {
    usedPercent: 91, resetAt: observed + 3_600_000, windowMinutes: 300, lastSeenAt: observed,
  } } } }]);
  h.runtime.observeQuota(); assert.equal(h.notices.length, 0);
  h.runtime.noteManualChange("dnd"); h.state.dnd = false; h.runtime.observeQuota();
  assert.equal(h.notices.length, 1); assert.equal(h.notices[0].threshold, 10);
  h.runtime.observeQuota(); assert.equal(h.notices.length, 1);
  h.runtime.dispose(); h.controller.dispose();
});
test("new preferences default safely and reject invalid edits atomically", () => {
  const snapshot = prefs.getDefaults();
  assert.equal(snapshot.quotaAlertsEnabled, false); assert.equal(snapshot.quietHours.enabled, false);
  assert.deepEqual(snapshot.projectBookmarks, []);
  const c = createSettingsController({ loadResult: { snapshot, locked: true } });
  for (const thresholds of [[], [0], [100], [10, 10], [1, 2, 3, 4, 5, 6], ["20"]]) {
    assert.equal(c.applyBulk({ quotaAlertsEnabled: true, quotaAlertThresholds: thresholds }).status, "error");
    assert.equal(c.get("quotaAlertsEnabled"), false);
  }
  assert.equal(c.applyUpdate("quietHours", { ...snapshot.quietHours, start: "25:00" }).status, "error");
  assert.equal(c.applyUpdate("projectBookmarks", [{ id: "a", name: "a", cwd: "relative", launchMode: "folder" }]).status, "error");
  c.dispose();
});
