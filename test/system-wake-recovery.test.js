"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const {
  WAKE_TIMEOUT_MS,
  createSystemWakeRecovery,
  normalizeWakeStatus,
} = require("../src/system-wake-recovery");

function createClock(start = 1000) {
  let current = start;
  let sequence = 0;
  const timers = new Map();

  function setTimeout(callback, delay) {
    const timer = { id: ++sequence, callback, dueAt: current + delay };
    timers.set(timer.id, timer);
    return timer;
  }

  function clearTimeout(timer) {
    if (timer) timers.delete(timer.id);
  }

  function advance(ms) {
    const target = current + ms;
    while (true) {
      const next = [...timers.values()]
        .filter((timer) => timer.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      if (!next) break;
      timers.delete(next.id);
      current = next.dueAt;
      next.callback();
    }
    current = target;
  }

  return {
    now: () => current,
    setTimeout,
    clearTimeout,
    advance,
    pendingCount: () => timers.size,
  };
}

function createHarness() {
  const clock = createClock();
  const powerMonitor = new EventEmitter();
  const ipcMain = new EventEmitter();
  const sent = [];
  const recovered = [];
  const logs = [];
  const errors = [];
  const runtime = createSystemWakeRecovery({
    powerMonitor,
    ipcMain,
    sendToRenderer(channel, payload) {
      sent.push({ channel, payload });
    },
    onRecovered(status, meta) {
      recovered.push({ status, meta });
    },
    log(message) {
      logs.push(message);
    },
    onError(error) {
      errors.push(error);
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  runtime.start();
  return { clock, powerMonitor, ipcMain, sent, recovered, logs, errors, runtime };
}

describe("system wake recovery", () => {
  it("is wired into the Electron main lifecycle", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(main, /powerMonitor/);
    assert.match(main, /systemWakeRecovery = createSystemWakeRecovery\(\{/);
    assert.match(main, /systemWakeRecovery\.start\(\)/);
    assert.match(main, /if \(systemWakeRecovery\) systemWakeRecovery\.dispose\(\)/);
    assert.match(main, /setLowPowerIdlePaused\(false\);[\s\S]*setForceEyeResend\(true\);/);
  });

  it("deduplicates resume/unlock, accepts the matching receipt, and cancels retries", () => {
    const harness = createHarness();
    harness.powerMonitor.emit("resume");

    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0].channel, "system-wake");
    assert.equal(harness.sent[0].payload.trigger, "resume");
    assert.equal(harness.sent[0].payload.attempt, 0);
    const id = harness.sent[0].payload.id;

    harness.ipcMain.emit("system-wake-status", {}, {
      id,
      result: "resumed",
      lowPowerWasPaused: true,
      pauseStyleRemoved: true,
      eyeTrackingReady: true,
      eyeTargetWasCurrentDocument: false,
      objectReloaded: true,
      eyeTargetRebound: true,
      ignoredDomContent: "must not cross the whitelist",
    });
    harness.clock.advance(100);
    harness.powerMonitor.emit("unlock-screen");
    harness.clock.advance(5000);

    assert.equal(harness.sent.length, 1, "acknowledged retries and burst duplicate must be cancelled");
    assert.equal(harness.recovered.length, 1);
    assert.deepEqual(harness.recovered[0].status, {
      id,
      result: "resumed",
      lowPowerWasPaused: true,
      pauseStyleRemoved: true,
      eyeTrackingReady: true,
      eyeTargetWasCurrentDocument: false,
      objectReloaded: true,
      eyeTargetRebound: true,
    });
    assert.equal(harness.logs.length, 1);
    assert.match(harness.logs[0], /result=resumed/);
    assert.equal(harness.errors.length, 0);
  });

  it("retries at bounded delays and writes one timeout result without a receipt", () => {
    const harness = createHarness();
    harness.powerMonitor.emit("resume");
    harness.clock.advance(WAKE_TIMEOUT_MS);

    assert.deepEqual(harness.sent.map((entry) => entry.payload.attempt), [0, 1, 2, 3]);
    assert.equal(harness.logs.length, 1);
    assert.match(harness.logs[0], /result=timeout/);
    assert.equal(harness.runtime.getPendingWakeId(), null);
    assert.equal(harness.clock.pendingCount(), 0);
  });

  it("accepts a late successful receipt after timeout once", () => {
    const harness = createHarness();
    harness.powerMonitor.emit("resume");
    const id = harness.sent[0].payload.id;

    harness.clock.advance(WAKE_TIMEOUT_MS);
    assert.equal(harness.runtime.getPendingWakeId(), null);
    assert.match(harness.logs[0], /result=timeout/);

    harness.ipcMain.emit("system-wake-status", {}, {
      id,
      result: "resumed",
      lowPowerWasPaused: true,
      pauseStyleRemoved: true,
      eyeTrackingReady: true,
      eyeTargetWasCurrentDocument: false,
      objectReloaded: true,
      eyeTargetRebound: true,
    });

    assert.equal(harness.recovered.length, 1);
    assert.equal(harness.recovered[0].meta.trigger, "resume");
    assert.equal(harness.recovered[0].meta.late, true);
    assert.equal(harness.recovered[0].meta.receiptMs, WAKE_TIMEOUT_MS);
    assert.match(harness.logs[1], /result=resumed/);
    assert.match(harness.logs[1], /late=1/);

    harness.ipcMain.emit("system-wake-status", {}, { id, result: "resumed" });
    assert.equal(harness.recovered.length, 1);
  });

  it("ignores malformed and stale receipts", () => {
    const harness = createHarness();
    harness.powerMonitor.emit("resume");
    const id = harness.sent[0].payload.id;

    harness.ipcMain.emit("system-wake-status", {}, { id: "wake-stale-9", result: "resumed" });
    harness.ipcMain.emit("system-wake-status", {}, { id, result: "unknown" });

    assert.equal(harness.recovered.length, 0);
    assert.equal(harness.runtime.getPendingWakeId(), id);
  });

  it("removes owned listeners and pending timers on dispose", () => {
    const harness = createHarness();
    harness.powerMonitor.emit("resume");
    harness.runtime.dispose();

    assert.equal(harness.powerMonitor.listenerCount("resume"), 0);
    assert.equal(harness.powerMonitor.listenerCount("unlock-screen"), 0);
    assert.equal(harness.ipcMain.listenerCount("system-wake-status"), 0);
    assert.equal(harness.clock.pendingCount(), 0);
    harness.clock.advance(5000);
    assert.equal(harness.sent.length, 1);
  });

  it("normalizes only the documented renderer status fields", () => {
    assert.deepEqual(normalizeWakeStatus({
      id: "wake-abc-1",
      result: "no-svg",
      lowPowerWasPaused: 1,
      pauseStyleRemoved: true,
      eyeTrackingReady: false,
      eyeTargetWasCurrentDocument: true,
      objectReloaded: true,
      eyeTargetRebound: true,
      extra: "ignored",
    }), {
      id: "wake-abc-1",
      result: "no-svg",
      lowPowerWasPaused: false,
      pauseStyleRemoved: true,
      eyeTrackingReady: false,
      eyeTargetWasCurrentDocument: true,
      objectReloaded: true,
      eyeTargetRebound: true,
    });
    assert.equal(normalizeWakeStatus({ id: "bad", result: "resumed" }), null);
  });
});
