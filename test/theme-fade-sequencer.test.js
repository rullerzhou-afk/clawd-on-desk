"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const createThemeFadeSequencer = require("../src/theme-fade-sequencer");

class FakeContents extends EventEmitter {
  constructor() {
    super();
    this.reloadCount = 0;
  }

  reload() {
    this.reloadCount += 1;
  }

  listenerCountForLoad() {
    return this.listenerCount("did-finish-load");
  }
}

class FakeWindow {
  constructor() {
    this.destroyed = false;
    this.webContents = new FakeContents();
    this.opacityWrites = [];
  }

  isDestroyed() {
    return this.destroyed;
  }
}

function makeTimers() {
  const timeouts = [];
  return {
    timeouts,
    setTimeout(fn, ms) {
      const id = { fn, ms, cleared: false };
      timeouts.push(id);
      return id;
    },
    clearTimeout(id) {
      id.cleared = true;
    },
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function activeTimeout(timers) {
  return timers.timeouts.find((timer) => !timer.cleared);
}

function createHarness(options = {}) {
  const renderWin = new FakeWindow();
  const hitWin = new FakeWindow();
  const timers = makeTimers();
  const animations = [];
  const sequencer = createThemeFadeSequencer({
    getRenderWindow: () => renderWin,
    getHitWindow: () => hitWin,
    ...(options.getRestoreOpacity ? { getRestoreOpacity: options.getRestoreOpacity } : {}),
    fadeOutMs: 10,
    fadeInMs: 20,
    fallbackMs: 30,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    animateWindowOpacity: (win, targetOpacity, animationOptions) => {
      const entry = {
        win,
        targetOpacity,
        options: animationOptions,
        resolve: null,
        promise: null,
      };
      entry.promise = new Promise((resolve) => {
        entry.resolve = resolve;
      });
      animations.push(entry);
      if (options.autoResolveAnimation !== false) {
        entry.resolve(true);
      }
      return entry.promise;
    },
    setWindowOpacity: (win, value) => {
      if (win) win.opacityWrites.push(value);
      return !!win;
    },
  });
  return { animations, hitWin, renderWin, sequencer, timers };
}

describe("theme fade sequencer", () => {
  it("reloads both windows after fade-out and finishes once both are ready", async () => {
    const { animations, hitWin, renderWin, sequencer } = createHarness();
    const finishes = [];

    sequencer.run({ onReloadFinished: (info) => finishes.push(info.reason) });
    await flushMicrotasks();

    assert.strictEqual(animations[0].targetOpacity, 0);
    assert.strictEqual(animations[0].options.durationMs, 10);
    assert.strictEqual(renderWin.webContents.reloadCount, 1);
    assert.strictEqual(hitWin.webContents.reloadCount, 1);

    renderWin.webContents.emit("did-finish-load");
    assert.deepStrictEqual(finishes, []);
    hitWin.webContents.emit("did-finish-load");
    await flushMicrotasks();

    assert.deepStrictEqual(finishes, ["loaded"]);
    assert.strictEqual(animations[1].targetOpacity, 1);
    assert.strictEqual(animations[1].options.durationMs, 20);
    assert.strictEqual(renderWin.webContents.listenerCountForLoad(), 0);
    assert.strictEqual(hitWin.webContents.listenerCountForLoad(), 0);
  });

  it("uses fallback if one window never finishes loading", async () => {
    const { hitWin, renderWin, sequencer, timers } = createHarness();
    const events = [];

    sequencer.run({
      onReloadFinished: () => events.push("loaded"),
      onFallback: (info) => events.push(info.reason),
    });
    await flushMicrotasks();

    renderWin.webContents.emit("did-finish-load");
    activeTimeout(timers).fn();
    await flushMicrotasks();

    assert.deepStrictEqual(events, ["fallback"]);
    assert.strictEqual(renderWin.webContents.listenerCountForLoad(), 0);
    assert.strictEqual(hitWin.webContents.listenerCountForLoad(), 0);
  });

  it("invalidates stale callbacks when a newer sequence starts", async () => {
    const { hitWin, renderWin, sequencer } = createHarness();
    const finishes = [];

    sequencer.run({ onReloadFinished: () => finishes.push("old") });
    await flushMicrotasks();
    sequencer.run({ onReloadFinished: () => finishes.push("new") });
    await flushMicrotasks();

    renderWin.webContents.emit("did-finish-load");
    hitWin.webContents.emit("did-finish-load");
    await flushMicrotasks();

    assert.deepStrictEqual(finishes, ["new"]);
  });

  it("cancels a previous fade-out immediately when a new sequence starts", async () => {
    const { animations, sequencer } = createHarness({ autoResolveAnimation: false });

    sequencer.run();
    assert.strictEqual(animations.length, 1);
    assert.strictEqual(animations[0].targetOpacity, 0);
    assert.strictEqual(animations[0].options.cancelSignal.cancelled, false);

    sequencer.run();

    assert.strictEqual(animations[0].options.cancelSignal.cancelled, true);
    assert.strictEqual(animations.length, 2);
    assert.strictEqual(animations[1].targetOpacity, 0);
  });

  it("uses fallback if fade-out never settles", async () => {
    const { animations, renderWin, sequencer, timers } = createHarness({ autoResolveAnimation: false });
    const events = [];

    sequencer.run({
      onReloadFinished: () => events.push("loaded"),
      onFallback: (info) => events.push(info.reason),
    });

    assert.strictEqual(animations.length, 1);
    assert.strictEqual(animations[0].targetOpacity, 0);
    activeTimeout(timers).fn();
    await flushMicrotasks();

    assert.deepStrictEqual(events, ["fallback"]);
    assert.deepStrictEqual(renderWin.opacityWrites, []);
    assert.strictEqual(animations.length, 2);
    assert.strictEqual(animations[1].targetOpacity, 1);
  });

  it("does not leak prior opacity writes after mid-ramp cancellation", async () => {
    const { animations, hitWin, renderWin, sequencer } = createHarness({ autoResolveAnimation: false });

    sequencer.run();
    const oldFade = animations[0];
    sequencer.run();
    oldFade.resolve(false);
    await flushMicrotasks();

    assert.strictEqual(renderWin.webContents.reloadCount, 0);
    assert.strictEqual(hitWin.webContents.reloadCount, 0);
    assert.deepStrictEqual(renderWin.opacityWrites, []);
  });

  it("cleanup removes listeners and clears fallback timer", async () => {
    const { animations, hitWin, renderWin, sequencer, timers } = createHarness({ autoResolveAnimation: false });

    sequencer.run();
    animations[0].resolve(true);
    await flushMicrotasks();

    assert.strictEqual(renderWin.webContents.listenerCountForLoad(), 1);
    assert.strictEqual(hitWin.webContents.listenerCountForLoad(), 1);
    assert.strictEqual(timers.timeouts.length, 2);
    assert.strictEqual(timers.timeouts.filter((timer) => !timer.cleared).length, 1);

    sequencer.cleanup();

    assert.ok(timers.timeouts.every((timer) => timer.cleared));
    assert.strictEqual(renderWin.webContents.listenerCountForLoad(), 0);
    assert.strictEqual(hitWin.webContents.listenerCountForLoad(), 0);
  });

  it("cleanup cancels an active opacity animation", () => {
    const { animations, sequencer } = createHarness({ autoResolveAnimation: false });

    sequencer.run();
    sequencer.cleanup();

    assert.strictEqual(animations[0].options.cancelSignal.cancelled, true);
  });
});

// #640: while the pet dodges an editing bubble, its baseline opacity is the
// faded dodge value — a theme reload finishing mid-edit must not snap the pet
// back to 1 on top of the box being typed into.
describe("theme fade sequencer restore opacity (#640)", () => {
  it("fades back in to getRestoreOpacity instead of a hardcoded 1", async () => {
    const { animations, hitWin, renderWin, sequencer } = createHarness({
      getRestoreOpacity: () => 0.18,
    });

    sequencer.run();
    await flushMicrotasks();
    renderWin.webContents.emit("did-finish-load");
    hitWin.webContents.emit("did-finish-load");
    await flushMicrotasks();

    assert.strictEqual(animations[1].targetOpacity, 0.18,
      "fade-in must land on the dodge baseline, not full opacity");
  });

  it("fallback fade-in also lands on getRestoreOpacity", async () => {
    const { animations, sequencer, timers } = createHarness({
      autoResolveAnimation: false,
      getRestoreOpacity: () => 0.18,
    });

    sequencer.run();
    activeTimeout(timers).fn();
    await flushMicrotasks();

    assert.strictEqual(animations[1].targetOpacity, 0.18);
  });

  it("reads the restore value at restore time, not at run() time", async () => {
    let base = 1;
    const { animations, hitWin, renderWin, sequencer } = createHarness({
      getRestoreOpacity: () => base,
    });

    sequencer.run();
    await flushMicrotasks();
    base = 0.18; // dodge engaged while the reload was in flight
    renderWin.webContents.emit("did-finish-load");
    hitWin.webContents.emit("did-finish-load");
    await flushMicrotasks();

    assert.strictEqual(animations[1].targetOpacity, 0.18);
  });

  it("converges on the current baseline when the dodge flips during the fade-in", async () => {
    // The dodge runs its own animateWindowOpacity loop with a separate cancel
    // signal — last writer wins. Whoever finishes last must land on the
    // CURRENT baseline, so fade-in completion re-reads it.
    let base = 1;
    const { animations, hitWin, renderWin, sequencer } = createHarness({
      autoResolveAnimation: false,
      getRestoreOpacity: () => base,
    });

    sequencer.run();
    animations[0].resolve(true); // fade-out done → reload starts
    await flushMicrotasks();
    renderWin.webContents.emit("did-finish-load");
    hitWin.webContents.emit("did-finish-load");
    await flushMicrotasks();

    assert.strictEqual(animations[1].targetOpacity, 1,
      "fade-in starts toward the baseline read at start");

    base = 0.18;                 // dodge engages while the fade-in is running
    animations[1].resolve(true); // fade-in loop finishes (has written 1)
    await flushMicrotasks();

    assert.deepStrictEqual(renderWin.opacityWrites, [0.18],
      "completion must re-read the baseline and converge");
  });

  it("does not double-write when the baseline held still through the fade-in", async () => {
    const { animations, hitWin, renderWin, sequencer } = createHarness({
      autoResolveAnimation: false,
      getRestoreOpacity: () => 0.18,
    });

    sequencer.run();
    animations[0].resolve(true);
    await flushMicrotasks();
    renderWin.webContents.emit("did-finish-load");
    hitWin.webContents.emit("did-finish-load");
    await flushMicrotasks();
    animations[1].resolve(true);
    await flushMicrotasks();

    assert.deepStrictEqual(renderWin.opacityWrites, [],
      "an unchanged baseline needs no converge write");
  });

  it("clamps garbage restore values back to 1", async () => {
    const { animations, hitWin, renderWin, sequencer } = createHarness({
      getRestoreOpacity: () => { throw new Error("boom"); },
    });

    sequencer.run();
    await flushMicrotasks();
    renderWin.webContents.emit("did-finish-load");
    hitWin.webContents.emit("did-finish-load");
    await flushMicrotasks();

    assert.strictEqual(animations[1].targetOpacity, 1);
  });
});
