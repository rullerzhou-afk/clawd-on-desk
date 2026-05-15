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
