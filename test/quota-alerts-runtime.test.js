"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createSettingsController } = require("../src/settings-controller");
const prefs = require("../src/prefs");
const { createQuotaAlertsRuntime } = require("../src/quota-alerts-runtime");

function harness({ unreadable = false } = {}) {
  const controller = createSettingsController({ loadResult: {
    snapshot: prefs.getDefaults(), locked: true, recovered: unreadable,
  } });
  const notices = [], timers = new Map(), power = new EventEmitter();
  let time = Date.UTC(2026, 9, 6), raw = [], nextTimer = 0, dnd = false;
  const runtime = createQuotaAlertsRuntime({
    settingsController: controller, now: () => time,
    state: { getAccountQuotaSnapshot: () => raw },
    getDoNotDisturb: () => dnd,
    notifyQuota: (event) => { notices.push(event); return true; },
    powerMonitor: power,
    setInterval: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id),
  });
  function freshLow() {
    time += 120_000;
    raw = [{ sourceKey: "", host: null, codexQuota: { group: { codexFiveHour: {
      usedPercent: 91, resetAt: time + 3_600_000, windowMinutes: 300, lastSeenAt: time,
    } } } }];
  }
  return { runtime, controller, notices, power, timers, freshLow, dnd: (v) => { dnd = v; } };
}
test("only fresh opted-in quota is observed, and setting changes apply immediately", () => {
  const h = harness();
  h.runtime.start(); h.runtime.start(); h.freshLow(); h.runtime.observeQuota();
  assert.equal(h.notices.length, 0); assert.equal(h.timers.size, 1);
  h.controller.applyUpdate("quotaAlertsEnabled", true);
  assert.equal(h.notices.length, 1); assert.equal(h.notices[0].threshold, 10);
  h.runtime.observeQuota(); assert.equal(h.notices.length, 1);
  h.runtime.dispose(); h.controller.dispose();
});
test("DND and unreadable preferences do not consume notification eligibility", () => {
  const h = harness(); h.controller.applyUpdate("quotaAlertsEnabled", true);
  h.runtime.start(); h.freshLow(); h.dnd(true); h.runtime.observeQuota();
  assert.equal(h.notices.length, 0);
  h.dnd(false); h.runtime.observeQuota(); assert.equal(h.notices.length, 1);
  h.runtime.dispose(); h.controller.dispose();
  const bad = harness({ unreadable: true });
  bad.runtime.start(); bad.freshLow(); bad.runtime.observeQuota();
  assert.equal(bad.notices.length, 0); bad.runtime.dispose(); bad.controller.dispose();
});
test("resume reconciles usage and disposal releases timers/listeners", () => {
  const h = harness(); h.controller.applyUpdate("quotaAlertsEnabled", true);
  h.runtime.start(); h.freshLow(); h.power.emit("resume");
  assert.equal(h.notices.length, 1);
  h.runtime.dispose(); h.runtime.dispose(); h.runtime.start();
  assert.equal(h.timers.size, 0); assert.equal(h.power.listenerCount("resume"), 0);
  h.controller.dispose();
});
test("quota preferences reject invalid values without applying an accompanying opt-in", () => {
  const controller = createSettingsController({ loadResult: { snapshot: prefs.getDefaults(), locked: true } });
  assert.equal(controller.get("quotaAlertsEnabled"), false);
  for (const thresholds of [[], [0], [100], [10, 10], [1, 2, 3, 4, 5, 6], ["20"]]) {
    assert.equal(controller.applyBulk({ quotaAlertsEnabled: true, quotaAlertThresholds: thresholds }).status, "error");
    assert.equal(controller.get("quotaAlertsEnabled"), false);
  }
  for (const key of ["quietHours", "projectBookmarks"]) assert.equal(key in controller.getSnapshot(), false);
  controller.dispose();
});
