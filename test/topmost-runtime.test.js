"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const createTopmostRuntime = require("../src/topmost-runtime");

class FakeWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.destroyed = !!options.destroyed;
    this.visible = options.visible !== false;
    this.calls = [];
  }

  isDestroyed() {
    return this.destroyed;
  }

  isVisible() {
    return this.visible;
  }

  setAlwaysOnTop(...args) {
    this.calls.push(["setAlwaysOnTop", ...args]);
  }

  setVisibleOnAllWorkspaces(...args) {
    this.calls.push(["setVisibleOnAllWorkspaces", ...args]);
  }
}

function makeTimers() {
  const intervals = [];
  const timeouts = [];
  return {
    intervals,
    timeouts,
    setInterval(fn, ms) {
      const id = { fn, ms, cleared: false };
      intervals.push(id);
      return id;
    },
    clearInterval(id) {
      id.cleared = true;
    },
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

describe("topmost runtime Windows recovery", () => {
  it("reasserts the pet and hit windows at the Windows topmost level", () => {
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
    });

    runtime.reassertWinTopmost();

    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(hitWin.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
  });

  it("guards main-window topmost loss by nudging input routing and scheduling recovery", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const forceEye = [];
    const positions = [];
    let syncCount = 0;
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getPetWindowBounds: () => ({ x: 10, y: 20, width: 100, height: 100 }),
      applyPetWindowPosition: (x, y) => positions.push([x, y]),
      setForceEyeResend: (value) => forceEye.push(value),
      syncHitWin: () => { syncCount += 1; },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);

    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(positions, [[11, 20], [10, 20]]);
    assert.deepStrictEqual(forceEye, [true]);
    assert.strictEqual(syncCount, 1);
    assert.strictEqual(timers.timeouts.length, 1);
    assert.strictEqual(timers.timeouts[0].ms, createTopmostRuntime.HWND_RECOVERY_DELAY_MS);

    timers.timeouts[0].fn();
    assert.deepStrictEqual(forceEye, [true, true]);
    assert.strictEqual(win.calls.length, 2);
    assert.deepStrictEqual(positions, [[11, 20], [10, 20]]);
  });

  it("does not accumulate repeated topmost nudges while recovery is pending", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const positions = [];
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getPetWindowBounds: () => ({ x: 10, y: 20, width: 100, height: 100 }),
      applyPetWindowPosition: (x, y) => positions.push([x, y]),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);
    win.emit("always-on-top-changed", null, false);

    assert.deepStrictEqual(positions, [
      [11, 20],
      [10, 20],
    ]);

    timers.timeouts.at(-1).fn();
    assert.deepStrictEqual(positions, [
      [11, 20],
      [10, 20],
    ]);
  });

  it("restores the original position only when the immediate nudge-back was swallowed", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const positions = [];
    const current = { x: 10, y: 20, width: 100, height: 100 };
    let swallowImmediateRestore = true;
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getPetWindowBounds: () => ({ ...current }),
      applyPetWindowPosition: (x, y) => {
        positions.push([x, y]);
        if (swallowImmediateRestore && x === 10 && y === 20) return;
        current.x = x;
        current.y = y;
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);
    assert.deepStrictEqual(current, { x: 11, y: 20, width: 100, height: 100 });

    swallowImmediateRestore = false;
    timers.timeouts[0].fn();

    assert.deepStrictEqual(positions, [[11, 20], [10, 20], [10, 20]]);
    assert.deepStrictEqual(current, { x: 10, y: 20, width: 100, height: 100 });
  });

  it("does not restore stale nudge coordinates after the pet legitimately moved", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const positions = [];
    const current = { x: 10, y: 20, width: 100, height: 100 };
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getPetWindowBounds: () => ({ ...current }),
      applyPetWindowPosition: (x, y) => {
        positions.push([x, y]);
        current.x = x;
        current.y = y;
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);
    current.x = 500;
    current.y = 500;
    timers.timeouts[0].fn();

    assert.deepStrictEqual(positions, [[11, 20], [10, 20]]);
    assert.deepStrictEqual(current, { x: 500, y: 500, width: 100, height: 100 });
  });

  it("starts a fresh nudge for a repeated topmost loss after the pet legitimately moved", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const positions = [];
    const current = { x: 10, y: 20, width: 100, height: 100 };
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getPetWindowBounds: () => ({ ...current }),
      applyPetWindowPosition: (x, y) => {
        positions.push([x, y]);
        current.x = x;
        current.y = y;
      },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);
    current.x = 500;
    current.y = 500;
    win.emit("always-on-top-changed", null, false);

    assert.deepStrictEqual(positions, [
      [11, 20],
      [10, 20],
      [501, 500],
      [500, 500],
    ]);
    assert.deepStrictEqual(current, { x: 500, y: 500, width: 100, height: 100 });
  });

  it("does not restore a topmost nudge over an active drag", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const positions = [];
    let dragging = false;
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getPetWindowBounds: () => ({ x: 10, y: 20, width: 100, height: 100 }),
      applyPetWindowPosition: (x, y) => positions.push([x, y]),
      isDragLocked: () => dragging,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);
    dragging = true;
    timers.timeouts[0].fn();

    assert.deepStrictEqual(positions, [[11, 20], [10, 20]]);
  });

  it("skips the nudge path while dragging or mini transitions own movement", () => {
    const win = new FakeWindow();
    const positions = [];
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      isDragLocked: () => true,
      applyPetWindowPosition: (x, y) => positions.push([x, y]),
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);

    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(positions, []);
  });

  it("watchdog reasserts visible helper windows and keeps them out of the taskbar", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const permissionBubble = new FakeWindow();
    const hiddenPermissionBubble = new FakeWindow({ visible: false });
    const updateBubble = new FakeWindow();
    const sessionHud = new FakeWindow();
    const contextMenuOwner = new FakeWindow();
    const kept = [];
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      getPendingPermissions: () => [
        { bubble: permissionBubble },
        { bubble: hiddenPermissionBubble },
      ],
      getUpdateBubbleWindow: () => updateBubble,
      getSessionHudWindow: () => sessionHud,
      getContextMenuOwner: () => contextMenuOwner,
      keepOutOfTaskbar: (window) => kept.push(window),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    runtime.startTopmostWatchdog();
    runtime.startTopmostWatchdog();

    assert.strictEqual(timers.intervals.length, 1);
    assert.strictEqual(timers.intervals[0].ms, createTopmostRuntime.TOPMOST_WATCHDOG_MS);
    timers.intervals[0].fn();

    for (const window of [win, hitWin, permissionBubble, updateBubble, sessionHud]) {
      assert.deepStrictEqual(window.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    }
    assert.deepStrictEqual(hiddenPermissionBubble.calls, []);
    assert.deepStrictEqual(contextMenuOwner.calls, []);
    assert.deepStrictEqual(kept, [win, hitWin, permissionBubble, updateBubble, sessionHud, contextMenuOwner]);

    runtime.stopTopmostWatchdog();
    assert.strictEqual(timers.intervals[0].cleared, true);
  });

  it("cleanup clears both the watchdog interval and pending HWND recovery", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    runtime.startTopmostWatchdog();
    runtime.scheduleHwndRecovery();
    runtime.cleanup();

    assert.strictEqual(timers.intervals.length, 1);
    assert.strictEqual(timers.timeouts.length, 1);
    assert.strictEqual(timers.intervals[0].cleared, true);
    assert.strictEqual(timers.timeouts[0].cleared, true);
  });

  it("detects work-area edge proximity using the injected work-area resolver", () => {
    const runtime = createTopmostRuntime({
      isWin: true,
      getNearestWorkArea: () => ({ x: 0, y: 0, width: 500, height: 400 }),
    });

    assert.strictEqual(runtime.isNearWorkAreaEdge({ x: 1, y: 50, width: 80, height: 80 }), true);
    assert.strictEqual(runtime.isNearWorkAreaEdge({ x: 100, y: 50, width: 80, height: 80 }), false);
  });
});

describe("topmost runtime macOS visibility", () => {
  it("uses native macOS stationary visibility without Electron fallback when available", () => {
    const win = new FakeWindow();
    const stationaryCalls = [];
    const runtime = createTopmostRuntime({
      isMac: true,
      getWin: () => win,
      applyStationaryCollectionBehavior: (window) => {
        stationaryCalls.push(window);
        return true;
      },
    });

    runtime.reapplyMacVisibility();

    assert.deepStrictEqual(win.calls, [
      ["setAlwaysOnTop", true, createTopmostRuntime.MAC_TOPMOST_LEVEL],
    ]);
    assert.deepStrictEqual(stationaryCalls, [win]);
  });

  it("reapplies native visibility first and falls back to Electron cross-space visibility", () => {
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const permissionBubble = new FakeWindow();
    const updateBubble = new FakeWindow();
    const sessionHud = new FakeWindow();
    const contextMenuOwner = new FakeWindow();
    const stationaryCalls = [];
    const runtime = createTopmostRuntime({
      isMac: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      getPendingPermissions: () => [{ bubble: permissionBubble }],
      getUpdateBubbleWindow: () => updateBubble,
      getSessionHudWindow: () => sessionHud,
      getContextMenuOwner: () => contextMenuOwner,
      getShowDock: () => false,
      applyStationaryCollectionBehavior: (window) => {
        stationaryCalls.push(window);
        return false;
      },
    });

    runtime.reapplyMacVisibility();

    for (const window of [win, hitWin, permissionBubble, updateBubble, sessionHud, contextMenuOwner]) {
      assert.deepStrictEqual(window.calls, [
        ["setAlwaysOnTop", true, createTopmostRuntime.MAC_TOPMOST_LEVEL],
        ["setVisibleOnAllWorkspaces", true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        }],
      ]);
    }
    assert.strictEqual(stationaryCalls.length, 12);
  });

  it("honors deferred macOS visibility markers", () => {
    const win = new FakeWindow();
    win.__clawdMacDeferredVisibilityUntil = Date.now() + 10000;
    const runtime = createTopmostRuntime({
      isMac: true,
      getWin: () => win,
      applyStationaryCollectionBehavior: () => false,
    });

    runtime.reapplyMacVisibility();

    assert.deepStrictEqual(win.calls, []);
  });
});
