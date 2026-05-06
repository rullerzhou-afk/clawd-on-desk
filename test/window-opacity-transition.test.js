const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { animateWindowOpacity } = require("../src/window-opacity-transition");

function createFakeTimers() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    setTimeout: (fn, delay) => {
      const timer = { fn, due: now + delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cancelled = true;
    },
    advance(ms) {
      now += ms;
      timers.sort((a, b) => a.due - b.due);
      for (const timer of [...timers]) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
        if (!timer.cancelled && timer.due <= now) timer.fn();
      }
    },
  };
}

describe("window opacity transition", () => {
  it("animates a BrowserWindow opacity to the target value", async () => {
    const timers = createFakeTimers();
    const opacityValues = [];
    const win = {
      isDestroyed: () => false,
      getOpacity: () => opacityValues.at(-1) ?? 1,
      setOpacity: (value) => opacityValues.push(value),
    };

    const done = animateWindowOpacity(win, 0, {
      durationMs: 40,
      frameMs: 20,
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    timers.advance(20);
    timers.advance(20);
    assert.strictEqual(await done, true);
    assert.ok(opacityValues.length >= 2);
    assert.strictEqual(opacityValues.at(-1), 0);
  });

  it("resolves false without leaving pending timers when the window is unavailable", async () => {
    const timers = createFakeTimers();
    const result = await animateWindowOpacity(null, 0, {
      durationMs: 40,
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    assert.strictEqual(result, false);
  });

  it("clamps opacity targets to Electron's valid range", async () => {
    const values = [];
    const win = {
      isDestroyed: () => false,
      getOpacity: () => 0.5,
      setOpacity: (value) => values.push(value),
    };

    const result = await animateWindowOpacity(win, 2, { durationMs: 0 });

    assert.strictEqual(result, true);
    assert.strictEqual(values.at(-1), 1);
  });

  it("stops writing opacity after cancellation", async () => {
    const timers = createFakeTimers();
    const values = [];
    const cancelSignal = { cancelled: false };
    const win = {
      isDestroyed: () => false,
      getOpacity: () => values.at(-1) ?? 1,
      setOpacity: (value) => values.push(value),
    };

    const done = animateWindowOpacity(win, 0, {
      durationMs: 100,
      frameMs: 20,
      now: timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      cancelSignal,
    });

    timers.advance(20);
    cancelSignal.cancelled = true;
    const countAfterCancel = values.length;
    timers.advance(20);

    assert.strictEqual(await done, false);
    assert.strictEqual(values.length, countAfterCancel);
  });
});
