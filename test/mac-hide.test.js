"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const createMacHideController = require("../src/mac-hide");

function makeHarness(opts = {}) {
  const fakeApp = {
    _hidden: false,
    _shown: 0,
    isHidden() { return this._hidden; },
    show() { this._shown++; },
  };
  const calls = []; // recorded setPetHidden(target) booleans
  let resultQueue = [];
  const setPetHidden = (hidden) => {
    calls.push(hidden);
    return resultQueue.length
      ? resultQueue.shift()
      : { applied: true, deferred: false, changed: true };
  };

  let intervalCb = null;
  const setIntervalFn = (cb) => { intervalCb = cb; return { unref() {} }; };
  const clearIntervalFn = () => { intervalCb = null; };
  let timeouts = [];
  const setTimeoutFn = (cb) => { const id = { cb }; timeouts.push(id); return id; };
  const clearTimeoutFn = (id) => { timeouts = timeouts.filter((t) => t !== id); };

  const ctrl = createMacHideController({
    isMac: opts.isMac !== false,
    app: fakeApp,
    getShowDock: opts.getShowDock || (() => true),
    isPetHidden: opts.isPetHidden || (() => false),
    setPetHidden,
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
  });

  return {
    ctrl,
    fakeApp,
    calls,
    queueResults: (...r) => { resultQueue = r; },
    poll: () => { if (intervalCb) intervalCb(); },
    hasInterval: () => !!intervalCb,
    pendingTimeouts: () => timeouts.length,
    flushTimeouts: () => { const run = timeouts; timeouts = []; run.forEach((t) => t.cb()); },
  };
}

describe("mac-hide controller (#416)", () => {
  it("start() installs the poll only on macOS", () => {
    const mac = makeHarness({ isMac: true });
    mac.ctrl.start();
    assert.equal(mac.hasInterval(), true);

    const other = makeHarness({ isMac: false });
    other.ctrl.start();
    assert.equal(other.hasInterval(), false);
  });

  it("OS hide hides the pet; OS unhide restores it", () => {
    const h = makeHarness();
    h.ctrl.start();

    h.fakeApp._hidden = true;
    h.poll();
    assert.deepEqual(h.calls, [true]);
    assert.equal(h.ctrl._state().hiddenByOsHide, true);

    h.fakeApp._hidden = false;
    h.poll();
    assert.deepEqual(h.calls, [true, false]);
    assert.equal(h.ctrl._state().hiddenByOsHide, false);
  });

  it("a no-op poll (no hidden-state change) drives nothing", () => {
    const h = makeHarness();
    h.ctrl.start();
    h.poll(); // still false
    h.poll();
    assert.deepEqual(h.calls, []);
  });

  it("noteManualChange() releases OS-hide ownership so a later unhide won't restore", () => {
    const h = makeHarness();
    h.ctrl.start();

    h.fakeApp._hidden = true;
    h.poll(); // OS hide -> owns + hides
    h.ctrl.noteManualChange(); // user toggled via tray/shortcut

    h.fakeApp._hidden = false;
    h.poll(); // must NOT restore
    assert.deepEqual(h.calls, [true]);
    assert.equal(h.ctrl._state().hiddenByOsHide, false);
  });

  it("onActivate unhides the app when it is OS-hidden (poll then restores)", () => {
    const h = makeHarness();
    h.ctrl.start();
    h.fakeApp._hidden = true;
    h.ctrl.onActivate();
    assert.equal(h.fakeApp._shown, 1);
    assert.deepEqual(h.calls, []); // restore happens via the poll, not here
  });

  it("onActivate restores a manual hide when Dock is visible and app is not hidden", () => {
    const h = makeHarness({ isPetHidden: () => true, getShowDock: () => true });
    h.ctrl.start();
    h.ctrl.onActivate();
    assert.deepEqual(h.calls, [false]);
  });

  it("onActivate does not restore when the Dock is hidden", () => {
    const h = makeHarness({ isPetHidden: () => true, getShowDock: () => false });
    h.ctrl.start();
    h.ctrl.onActivate();
    assert.deepEqual(h.calls, []);
  });

  it("a mini-transition-deferred hide retries until it applies", () => {
    const h = makeHarness();
    h.queueResults(
      { applied: false, deferred: true, changed: false }, // first attempt deferred
      { applied: true, deferred: false, changed: true },  // retry applies
    );
    h.ctrl.start();

    h.fakeApp._hidden = true;
    h.poll();
    assert.deepEqual(h.calls, [true]);
    assert.equal(h.pendingTimeouts(), 1); // retry scheduled

    h.flushTimeouts();
    assert.deepEqual(h.calls, [true, true]);
    assert.equal(h.pendingTimeouts(), 0);
  });

  it("noteManualChange() cancels a pending mini retry", () => {
    const h = makeHarness();
    h.queueResults({ applied: false, deferred: true, changed: false });
    h.ctrl.start();
    h.fakeApp._hidden = true;
    h.poll(); // OS hide deferred by a mini transition → retry scheduled
    assert.equal(h.pendingTimeouts(), 1);

    h.ctrl.noteManualChange(); // user takes over
    assert.equal(h.pendingTimeouts(), 0); // stale retry must be cancelled

    h.flushTimeouts(); // nothing left to fire
    assert.deepEqual(h.calls, [true]); // only the original deferred attempt
  });

  it("an opposite OS state cancels a pending mini retry", () => {
    const h = makeHarness();
    h.queueResults({ applied: false, deferred: true, changed: false });
    h.ctrl.start();
    h.fakeApp._hidden = true;
    h.poll(); // deferred hide → retry scheduled
    assert.equal(h.pendingTimeouts(), 1);

    h.fakeApp._hidden = false;
    h.poll(); // OS unhid before the retry fired → supersede it
    assert.equal(h.pendingTimeouts(), 0);
    assert.deepEqual(h.calls, [true, false]);
  });

  it("start() does not hide when the app is already hidden at launch", () => {
    const h = makeHarness();
    h.fakeApp._hidden = true; // launched while hidden
    h.ctrl.start();
    h.poll(); // no transition (already true) → no spurious hide
    assert.deepEqual(h.calls, []);
  });

  it("stop() clears both the poll timer and a pending mini retry", () => {
    const h = makeHarness();
    h.queueResults({ applied: false, deferred: true, changed: false });
    h.ctrl.start();
    assert.equal(h.hasInterval(), true);
    h.fakeApp._hidden = true;
    h.poll(); // retry scheduled
    assert.equal(h.pendingTimeouts(), 1);

    h.ctrl.stop();
    assert.equal(h.hasInterval(), false);
    assert.equal(h.pendingTimeouts(), 0);
  });
});
