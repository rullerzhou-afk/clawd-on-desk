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
    this.bounds = options.bounds || null;
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

  getBounds() {
    return this.bounds ? { ...this.bounds } : { x: 0, y: 0, width: 0, height: 0 };
  }

  setOpacity(value) {
    this.calls.push(["setOpacity", value]);
  }

  setIgnoreMouseEvents(...args) {
    this.calls.push(["setIgnoreMouseEvents", ...args]);
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

  it("reassertWinTopmost stands down while a fullscreen app is foreground (#538)", () => {
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => true,
    });

    runtime.reassertWinTopmost();

    // Drag-move (near a work-area edge), drag-end, and HWND recovery all funnel
    // through reassertWinTopmost; under a fullscreen foreground none of them may
    // claw the pet/hit windows back over the game (#538 drag regression).
    assert.deepStrictEqual(win.calls, []);
    assert.deepStrictEqual(hitWin.calls, []);
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

  it("re-tops the hit window when the render window loses topmost (no z-order inversion)", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      getPetWindowBounds: () => ({ x: 10, y: 20, width: 100, height: 100 }),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);

    // Render window re-topped, then the hit window re-topped above it — without
    // the fix only `win` would be re-asserted, leaving the hit layer beneath.
    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(hitWin.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
  });

  it("re-tops only the guarded window when a non-render window loses topmost", () => {
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const bubble = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
    });

    runtime.guardAlwaysOnTop(bubble);
    bubble.emit("always-on-top-changed", null, false);

    // A bubble/HUD losing topmost must not drag the pet's render+hit pair into
    // a re-assert; only the bubble itself is re-topped.
    assert.deepStrictEqual(bubble.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(win.calls, []);
    assert.deepStrictEqual(hitWin.calls, []);
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

  it("cleanup clears the watchdog, focusable poll, and pending HWND recovery", () => {
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
    runtime.startFocusablePoll();
    runtime.scheduleHwndRecovery();
    runtime.cleanup();

    assert.strictEqual(timers.intervals.length, 2);
    assert.strictEqual(timers.timeouts.length, 1);
    assert.ok(timers.intervals.every((interval) => interval.cleared));
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

  it("watchdog stands down on the pet/hit windows when a fullscreen app is foreground (#538)", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const permissionBubble = new FakeWindow();
    const kept = [];
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      getPendingPermissions: () => [{ bubble: permissionBubble }],
      isForegroundFullscreen: () => true,
      keepOutOfTaskbar: (window) => kept.push(window),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    runtime.startTopmostWatchdog();
    timers.intervals[0].fn();

    // Pet + hit windows: no topmost re-assert (don't interrupt the game)...
    assert.deepStrictEqual(win.calls, []);
    assert.deepStrictEqual(hitWin.calls, []);
    // ...but taskbar maintenance still runs (non-focus-stealing).
    assert.ok(kept.includes(win) && kept.includes(hitWin));
    // Permission bubbles are deliberate interruptions — they keep re-asserting.
    assert.deepStrictEqual(permissionBubble.calls, [
      ["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL],
    ]);
  });

  it("watchdog reasserts normally when no fullscreen app is foreground", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => false,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    runtime.startTopmostWatchdog();
    timers.intervals[0].fn();

    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(hitWin.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
  });

  it("watchdog tick runs the cloak self-heal hook on every normal tick (#525)", () => {
    const timers = makeTimers();
    const recoveries = [];
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => new FakeWindow(),
      getHitWin: () => new FakeWindow(),
      isForegroundFullscreen: () => false,
      recoverCloakedPet: () => recoveries.push("tick"),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    runtime.startTopmostWatchdog();
    timers.intervals[0].fn();
    timers.intervals[0].fn();

    assert.equal(recoveries.length, 2);
  });

  it("watchdog skips the cloak self-heal while standing down for a fullscreen app (#525/§8.3)", () => {
    const timers = makeTimers();
    const recoveries = [];
    let overlay = false;
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => new FakeWindow(),
      getHitWin: () => new FakeWindow(),
      isForegroundFullscreen: () => true,
      getFullscreenOverlay: () => overlay,
      recoverCloakedPet: () => recoveries.push("tick"),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    runtime.startTopmostWatchdog();
    // Stand-down (fullscreen + overlay off): recovery must not fire.
    timers.intervals[0].fn();
    assert.equal(recoveries.length, 0);
    // Overlay mode keeps re-asserting, so recovery may run again.
    overlay = true;
    timers.intervals[0].fn();
    assert.equal(recoveries.length, 1);
  });

  it("focusable poll drops hit-window activation under fullscreen and restores it otherwise (#538/#562)", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const focusableCalls = [];
    let fullscreen = true;
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => fullscreen,
      setHitWinFocusable: (focusable) => focusableCalls.push(focusable),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    runtime.startFocusablePoll();

    // Up-front sync: starting while already fullscreen drops activation
    // immediately, not after a full poll interval — closes the startup/restore
    // window where the hit window (created focusable: true) could still steal
    // the game's focus (#562). The poll runs at the ~1s focusable cadence, NOT
    // the 5s watchdog.
    assert.deepStrictEqual(focusableCalls, [false]);
    assert.strictEqual(timers.intervals[0].ms, createTopmostRuntime.FOCUSABLE_POLL_MS);

    runtime.startFocusablePoll();

    // Idempotent: a second start neither registers another interval nor re-syncs.
    assert.strictEqual(timers.intervals.length, 1);
    assert.deepStrictEqual(focusableCalls, [false]);

    // Leaving fullscreen restores activation on the next tick (drag needs it, #545).
    fullscreen = false;
    timers.intervals[0].fn();
    assert.deepStrictEqual(focusableCalls, [false, true]);

    runtime.stopFocusablePoll();
    assert.strictEqual(timers.intervals[0].cleared, true);
  });

  it("watchdog no longer toggles hit-window activation — that moved to the focusable poll (#562)", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const focusableCalls = [];
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => true,
      setHitWinFocusable: (focusable) => focusableCalls.push(focusable),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    runtime.startTopmostWatchdog();
    timers.intervals[0].fn();

    // The watchdog handles only topmost/taskbar now; activation rides the
    // separate fast poll so it can flip within ~1s of entering fullscreen.
    assert.deepStrictEqual(focusableCalls, []);
  });

  it("guardAlwaysOnTop still reasserts helper windows while a fullscreen app is foreground (#538)", () => {
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const bubble = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => true,
    });

    runtime.guardAlwaysOnTop(bubble);
    bubble.emit("always-on-top-changed", null, false);

    // Permission/update/HUD windows are deliberate interruptions; fullscreen
    // only suppresses pet + hit layer recovery.
    assert.deepStrictEqual(bubble.calls, [
      ["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL],
    ]);
    assert.deepStrictEqual(win.calls, []);
    assert.deepStrictEqual(hitWin.calls, []);
  });

  it("guardAlwaysOnTop does not fight topmost loss while a fullscreen app is foreground (#538)", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getPetWindowBounds: () => ({ x: 100, y: 100, width: 200, height: 200 }),
      isForegroundFullscreen: () => true,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);

    // No re-top, no 1px nudge, and no HWND-recovery timer scheduled.
    assert.deepStrictEqual(win.calls, []);
    assert.strictEqual(timers.timeouts.length, 0);
  });

  it("guardAlwaysOnTop does not fight hit-window topmost loss while a fullscreen app is foreground (#538)", () => {
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => true,
    });

    runtime.guardAlwaysOnTop(hitWin);
    hitWin.emit("always-on-top-changed", null, false);

    // The hit layer is the other half of the pet pair — under a fullscreen
    // foreground it must stand down too, not just the render window. Without
    // the hitLayerWin branch this would fall through to the else and re-top the
    // hit window back over the game.
    assert.deepStrictEqual(hitWin.calls, []);
    assert.deepStrictEqual(win.calls, []);
  });

  // ── #562 fullscreen-overlay mode (opt-in via the fullscreenOverlay pref) ──
  // The pet floats ON TOP of a foreground fullscreen app instead of standing
  // down. Topmost keeps re-asserting, but the hit window stays non-activating so
  // a click can't steal the game's foreground — cursor-drag needs no activation.

  it("reassertWinTopmost floats on top under fullscreen when overlay mode is on (#562)", () => {
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => true,
      getFullscreenOverlay: () => true,
    });

    runtime.reassertWinTopmost();

    // Overlay mode deliberately keeps re-topping over the fullscreen app rather
    // than standing down (#538), so the pet stays visible and draggable.
    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(hitWin.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
  });

  it("watchdog floats the pet on top under fullscreen overlay (#562)", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => true,
      getFullscreenOverlay: () => true,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    runtime.startTopmostWatchdog();
    timers.intervals[0].fn();

    // Topmost keeps re-asserting so the pet floats over the game (overlay opts
    // out of the #538 stand-down). The decoupled focusable decision rides the
    // focusable poll instead — see the overlay focusable-poll test below.
    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(hitWin.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
  });

  it("focusable poll keeps the hit window non-activating even in overlay mode (#562)", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const focusableCalls = [];
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => true,
      getFullscreenOverlay: () => true,
      setHitWinFocusable: (focusable) => focusableCalls.push(focusable),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    runtime.startFocusablePoll();

    // Overlay floats the pet on top (topmost), but focus must STILL never be
    // stolen from the fullscreen game — float-on-top and don't-steal-focus are
    // independent. The up-front sync drops activation immediately, overlay or not.
    assert.deepStrictEqual(focusableCalls, [false]);
  });

  it("guardAlwaysOnTop re-tops the hit layer over a fullscreen app in overlay mode (#562)", () => {
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => true,
      getFullscreenOverlay: () => true,
      getPetWindowBounds: () => ({ x: 100, y: 100, width: 200, height: 200 }),
    });

    runtime.guardAlwaysOnTop(hitWin);
    hitWin.emit("always-on-top-changed", null, false);

    // Unlike the #538 stand-down, overlay mode re-tops the hit layer back over
    // the fullscreen app so the pet stays on top and draggable.
    assert.deepStrictEqual(hitWin.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
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

  it("forces a mid-IME-edit text-input bubble non-topmost but keeps it cross-space visible", () => {
    // While its input is focused, the bubble must drop out of always-on-top so
    // the IME candidate window can surface (permission.js handleImeEditing), but
    // stay cross-space visible so a Space switch mid-edit doesn't strand it. It
    // must NOT get topmost or the native stationary path (both re-occlude IME).
    const bubble = new FakeWindow();
    bubble.__clawdMacImeEditing = true;
    bubble.__clawdMacTextInputBubble = true;
    const stationaryCalls = [];
    const runtime = createTopmostRuntime({
      isMac: true,
      getPendingPermissions: () => [{ bubble }],
      getShowDock: () => false,
      applyStationaryCollectionBehavior: (win) => {
        stationaryCalls.push(win);
        return true;
      },
    });

    runtime.reapplyMacVisibility();

    assert.deepStrictEqual(bubble.calls, [
      ["setAlwaysOnTop", false],
      ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
    ]);
    assert.deepStrictEqual(stationaryCalls, [], "must not run the native SkyLight path mid-edit");
  });

  it("forces a mid-IME-edit non-text-input window non-topmost without cross-space", () => {
    // Defensive: the editing flag is only ever set on text-input bubbles, but if
    // it lands on any other window the branch still just drops always-on-top.
    const win = new FakeWindow();
    win.__clawdMacImeEditing = true;
    const runtime = createTopmostRuntime({
      isMac: true,
      getWin: () => win,
      applyStationaryCollectionBehavior: () => true,
    });

    runtime.reapplyMacVisibility();

    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", false]]);
  });

  it("keeps a text-input bubble cross-space visible via Electron, skipping the native SkyLight path", () => {
    // The native stationary path delegates the window into a SkyLight private
    // space that occludes the OS IME candidate window, so text-input bubbles
    // opt out of it (permission.js __clawdMacTextInputBubble) and rely on
    // Electron's own cross-space visibility instead.
    const bubble = new FakeWindow();
    bubble.__clawdMacTextInputBubble = true;
    const stationaryCalls = [];
    const runtime = createTopmostRuntime({
      isMac: true,
      getPendingPermissions: () => [{ bubble }],
      getShowDock: () => false,
      applyStationaryCollectionBehavior: (win) => {
        stationaryCalls.push(win);
        return true;
      },
    });

    runtime.reapplyMacVisibility();

    assert.deepStrictEqual(bubble.calls, [
      ["setAlwaysOnTop", true, createTopmostRuntime.MAC_TOPMOST_LEVEL],
      ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true, skipTransformProcessType: true }],
    ]);
    assert.deepStrictEqual(stationaryCalls, []);
  });
});

describe("IME editing pet dodge (#640)", () => {
  function makeDodgeSetup(overrides = {}) {
    const pet = new FakeWindow();
    const hit = new FakeWindow();
    const bubble = new FakeWindow({ bounds: { x: 100, y: 100, width: 300, height: 200 } });
    bubble.__clawdMacImeEditing = true;
    bubble.__clawdMacTextInputBubble = true;
    const runtime = createTopmostRuntime({
      isMac: true,
      getWin: () => pet,
      getHitWin: () => hit,
      getPendingPermissions: () => [{ bubble }],
      // Sprite rect intersecting the bubble unless overridden — in the
      // production { left, top, right, bottom } hit-geometry shape, which is
      // exactly what the first real-machine run caught the arbiter mishandling.
      getHitRectScreen: () => ({ left: 320, top: 240, right: 440, bottom: 360 }),
      imeEditingFadeMs: 0,
      applyStationaryCollectionBehavior: () => true,
      ...overrides,
    });
    return { pet, hit, bubble, runtime };
  }

  it("fades the pet and lets clicks through while the editing bubble overlaps the sprite", () => {
    const { pet, hit, runtime } = makeDodgeSetup();

    runtime.syncImeEditingPetDodge();

    assert.deepStrictEqual(pet.calls, [
      ["setOpacity", createTopmostRuntime.IME_EDIT_PET_FADE_OPACITY],
    ]);
    assert.deepStrictEqual(hit.calls, [["setIgnoreMouseEvents", true]]);
  });

  it("is edge-triggered: repeated syncs while overlapping do not repeat window calls", () => {
    const { pet, hit, runtime } = makeDodgeSetup();

    runtime.syncImeEditingPetDodge();
    runtime.syncImeEditingPetDodge();
    runtime.syncImeEditingPetDodge();

    assert.strictEqual(pet.calls.length, 1);
    assert.strictEqual(hit.calls.length, 1);
  });

  it("restores the pet when the text field blurs (flag cleared)", () => {
    const { pet, hit, bubble, runtime } = makeDodgeSetup();

    runtime.syncImeEditingPetDodge();
    delete bubble.__clawdMacImeEditing;
    runtime.syncImeEditingPetDodge();

    assert.deepStrictEqual(pet.calls, [
      ["setOpacity", createTopmostRuntime.IME_EDIT_PET_FADE_OPACITY],
      ["setOpacity", 1],
    ]);
    assert.deepStrictEqual(hit.calls, [
      ["setIgnoreMouseEvents", true],
      ["setIgnoreMouseEvents", false],
    ]);
  });

  it("restores the pet when the editing bubble is removed (closed mid-edit)", () => {
    const perms = [];
    const { pet, hit, bubble, runtime } = makeDodgeSetup({
      getPendingPermissions: () => perms,
    });
    perms.push({ bubble });

    runtime.syncImeEditingPetDodge();
    perms.length = 0;
    runtime.syncImeEditingPetDodge();

    assert.deepStrictEqual(pet.calls.map((c) => c[0]), ["setOpacity", "setOpacity"]);
    assert.deepStrictEqual(pet.calls[1], ["setOpacity", 1]);
    assert.deepStrictEqual(hit.calls[1], ["setIgnoreMouseEvents", false]);
  });

  it("does nothing while editing without geometric overlap", () => {
    const { pet, hit, runtime } = makeDodgeSetup({
      getHitRectScreen: () => ({ left: 900, top: 900, right: 1020, bottom: 1020 }),
    });

    runtime.syncImeEditingPetDodge();

    assert.deepStrictEqual(pet.calls, []);
    assert.deepStrictEqual(hit.calls, []);
  });

  it("falls back to the pet window bounds when no sprite rect is available", () => {
    const { pet, runtime } = makeDodgeSetup({
      getHitRectScreen: () => null,
      getPetWindowBounds: () => ({ x: 150, y: 150, width: 200, height: 200 }),
    });

    runtime.syncImeEditingPetDodge();

    assert.deepStrictEqual(pet.calls, [
      ["setOpacity", createTopmostRuntime.IME_EDIT_PET_FADE_OPACITY],
    ]);
  });

  it("does nothing off macOS", () => {
    const { pet, hit, runtime } = makeDodgeSetup({ isMac: false });

    runtime.syncImeEditingPetDodge();

    assert.deepStrictEqual(pet.calls, []);
    assert.deepStrictEqual(hit.calls, []);
  });

  it("runs as part of reapplyMacVisibility so every visibility pass self-heals", () => {
    const { pet, hit, runtime } = makeDodgeSetup();

    runtime.reapplyMacVisibility();

    assert.deepStrictEqual(
      pet.calls.filter((c) => c[0] === "setOpacity"),
      [["setOpacity", createTopmostRuntime.IME_EDIT_PET_FADE_OPACITY]]
    );
    assert.deepStrictEqual(
      hit.calls.filter((c) => c[0] === "setIgnoreMouseEvents"),
      [["setIgnoreMouseEvents", true]]
    );
  });

  // #640/F3: Electron's setIgnoreMouseEvents makes no promise about toggling
  // mid-gesture, so the click-through write is deferred while a drag is in
  // flight; the fade is not (the mid-drag fade transition is the hands-on-
  // verified experience). Drag-lock release re-runs the sync to apply it.
  describe("drag-lock deferral", () => {
    it("fades mid-drag but defers the click-through write", () => {
      const { pet, hit, runtime } = makeDodgeSetup({ isDragLocked: () => true });

      runtime.syncImeEditingPetDodge();

      assert.deepStrictEqual(pet.calls, [
        ["setOpacity", createTopmostRuntime.IME_EDIT_PET_FADE_OPACITY],
      ], "the fade still runs mid-drag");
      assert.deepStrictEqual(hit.calls, [],
        "the ignore-mouse write must wait until the drag ends");
    });

    it("applies the deferred click-through on the first sync after the drag ends", () => {
      let dragging = true;
      const { pet, hit, runtime } = makeDodgeSetup({ isDragLocked: () => dragging });

      runtime.syncImeEditingPetDodge();
      dragging = false;
      runtime.syncImeEditingPetDodge();

      assert.deepStrictEqual(hit.calls, [["setIgnoreMouseEvents", true]]);
      assert.strictEqual(pet.calls.length, 1,
        "the fade already ran mid-drag; the post-drag sync only applies the write");

      runtime.syncImeEditingPetDodge();
      assert.strictEqual(hit.calls.length, 1, "the applied write is edge-triggered");
    });

    it("skips the write entirely when the overlap ended before the drag did", () => {
      let dragging = true;
      const { pet, hit, bubble, runtime } = makeDodgeSetup({ isDragLocked: () => dragging });

      runtime.syncImeEditingPetDodge();       // overlap while dragging → fade only
      delete bubble.__clawdMacImeEditing;     // edit ends mid-drag
      runtime.syncImeEditingPetDodge();       // fade back, still no write
      dragging = false;
      runtime.syncImeEditingPetDodge();       // drag ends: nothing left to apply

      assert.deepStrictEqual(pet.calls.map((c) => c[1]), [
        createTopmostRuntime.IME_EDIT_PET_FADE_OPACITY, 1,
      ]);
      assert.deepStrictEqual(hit.calls, [],
        "never went click-through, so nothing to undo");
    });
  });

  // #640: external opacity writers (theme-switch fade) restore to this value
  // instead of a hardcoded 1, so a theme reload mid-edit lands back on the
  // dodge baseline rather than planting an opaque pet over the input box.
  it("getPetTargetOpacity tracks the dodge state", () => {
    const { bubble, runtime } = makeDodgeSetup();

    assert.strictEqual(runtime.getPetTargetOpacity(), 1,
      "before any sync the baseline is full opacity");

    runtime.syncImeEditingPetDodge();
    assert.strictEqual(
      runtime.getPetTargetOpacity(),
      createTopmostRuntime.IME_EDIT_PET_FADE_OPACITY,
      "while dodging, the baseline is the faded value"
    );

    delete bubble.__clawdMacImeEditing;
    runtime.syncImeEditingPetDodge();
    assert.strictEqual(runtime.getPetTargetOpacity(), 1,
      "after the edit ends the baseline returns to full opacity");
  });
});
