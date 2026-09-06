"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createDragLockWatchdog,
  DEFAULT_STUCK_AFTER_MS,
  DEFAULT_POLL_INTERVAL_MS,
} = require("../src/drag-lock-watchdog");

function createHarness({ locked = false, lastAliveAt = 0, nowMs = 100_000 } = {}) {
  const calls = [];
  let now = nowMs;
  const watchdog = createDragLockWatchdog({
    isDragLocked: () => locked,
    getLastDragAliveAt: () => lastAliveAt,
    forceRelease: (reason) => calls.push(["forceRelease", reason]),
    now: () => now,
    setIntervalFn: (cb, ms) => {
      calls.push(["setInterval", ms]);
      return { cb, ms };
    },
    clearIntervalFn: (t) => calls.push(["clearInterval", t && t.ms]),
    log: (message) => calls.push(["log", message]),
  });
  return {
    watchdog,
    calls,
    advance(ms) { now += ms; },
  };
}

describe("drag-lock-watchdog check()", () => {
  it("reports idle when the lock is not held", () => {
    const h = createHarness({ locked: false, lastAliveAt: 0 });
    assert.strictEqual(h.watchdog.check(), "idle");
    assert.deepStrictEqual(h.calls, []);
  });

  it("reports alive while the heartbeat is fresh", () => {
    const h = createHarness({ locked: true, lastAliveAt: 100_000 - 1_000 });
    assert.strictEqual(h.watchdog.check(), "alive");
    assert.deepStrictEqual(h.calls, []);
  });

  it("releases when the heartbeat is stale beyond the threshold", () => {
    const h = createHarness({ locked: true, lastAliveAt: 100_000 - DEFAULT_STUCK_AFTER_MS });
    assert.strictEqual(h.watchdog.check(), "released");
    assert.deepStrictEqual(
      h.calls.filter((c) => c[0] === "forceRelease").length,
      1,
      "forceRelease should be called exactly once"
    );
  });

  it("stays just under the threshold without releasing", () => {
    const h = createHarness({ locked: true, lastAliveAt: 100_000 - DEFAULT_STUCK_AFTER_MS + 1 });
    assert.strictEqual(h.watchdog.check(), "alive");
  });

  it("is unarmed and never releases without a heartbeat source", () => {
    const watchdog = createDragLockWatchdog({
      isDragLocked: () => true,
      forceRelease: () => assert.fail("must not release when unarmed"),
      now: () => 100_000,
    });
    assert.strictEqual(watchdog.check(), "unarmed");
  });

  it("requires isDragLocked and forceRelease dependencies", () => {
    assert.throws(() => createDragLockWatchdog({}));
  });
});

describe("drag-lock-watchdog start/stop", () => {
  it("starts the poll on the default interval and stops idempotently", () => {
    const h = createHarness();
    h.watchdog.start();
    h.watchdog.start();
    assert.deepStrictEqual(h.calls, [["setInterval", DEFAULT_POLL_INTERVAL_MS]]);
    h.watchdog.stop();
    h.watchdog.stop();
    assert.deepStrictEqual(
      h.calls.filter((c) => c[0] === "clearInterval").length,
      1,
      "exactly one clearInterval"
    );
  });

  it("accepts a custom poll interval", () => {
    const h = createHarness();
    h.watchdog.start(500);
    assert.deepStrictEqual(h.calls, [["setInterval", 500]]);
  });
});
