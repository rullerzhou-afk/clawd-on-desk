"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const createTopmostRuntime = require("../src/topmost-runtime");
const createPetWindowRuntime = require("../src/pet-window-runtime");

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

  // PR #751 Codex review #12 (rework batch B-7): added so a real
  // pet-window-runtime instance can be assembled against this same fake
  // window (see the "assembly: main.js's real applyPetWindowPosition wrapper
  // shape..." test below) — genuinely mutates .bounds like a real
  // BrowserWindow, unlike the other methods here which only log a call.
  setBounds(next) {
    this.calls.push(["setBounds", next]);
    this.bounds = { ...next };
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

  // PR #751 Codex review #12 (rework batch B-7, non-blocking): every
  // applyPetWindowPosition spy in this file now captures the 3rd argument
  // too (opts), not just (x, y). applyFreshNudge() (src/topmost-runtime.js)
  // deliberately passes {force:true} on both its calls — plan §12.12's
  // safety line, since the whole point of a nudge is a real native write —
  // and main.js's real applyPetWindowPosition wrapper used to silently drop
  // a 3rd argument entirely (found and fixed earlier in this same PR #751
  // rework, batch A: it broke this exact force:true). A spy that only ever
  // recorded (x, y) could never have caught that regression. restorePendingNudge()'s
  // own call (src/topmost-runtime.js:418) passes no options at all — expect
  // `undefined` there, not force:true, to keep that distinction visible.
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
      applyPetWindowPosition: (x, y, opts) => positions.push([x, y, opts]),
      setForceEyeResend: (value) => forceEye.push(value),
      syncHitWin: () => { syncCount += 1; },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);

    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(positions, [[11, 20, { force: true }], [10, 20, { force: true }]]);
    assert.deepStrictEqual(forceEye, [true]);
    assert.strictEqual(syncCount, 1);
    assert.strictEqual(timers.timeouts.length, 1);
    assert.strictEqual(timers.timeouts[0].ms, createTopmostRuntime.HWND_RECOVERY_DELAY_MS);

    timers.timeouts[0].fn();
    assert.deepStrictEqual(forceEye, [true, true]);
    assert.strictEqual(win.calls.length, 2);
    assert.deepStrictEqual(positions, [[11, 20, { force: true }], [10, 20, { force: true }]]);
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
      applyPetWindowPosition: (x, y, opts) => positions.push([x, y, opts]),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);
    win.emit("always-on-top-changed", null, false);

    assert.deepStrictEqual(positions, [
      [11, 20, { force: true }],
      [10, 20, { force: true }],
    ]);

    timers.timeouts.at(-1).fn();
    assert.deepStrictEqual(positions, [
      [11, 20, { force: true }],
      [10, 20, { force: true }],
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
      applyPetWindowPosition: (x, y, opts) => {
        positions.push([x, y, opts]);
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

    // The third entry is restorePendingNudge()'s own call
    // (src/topmost-runtime.js:418) — it passes no options at all (undefined),
    // unlike applyFreshNudge()'s two force:true calls above it.
    assert.deepStrictEqual(positions, [[11, 20, { force: true }], [10, 20, { force: true }], [10, 20, undefined]]);
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
      applyPetWindowPosition: (x, y, opts) => {
        positions.push([x, y, opts]);
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

    assert.deepStrictEqual(positions, [[11, 20, { force: true }], [10, 20, { force: true }]]);
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
      applyPetWindowPosition: (x, y, opts) => {
        positions.push([x, y, opts]);
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
      [11, 20, { force: true }],
      [10, 20, { force: true }],
      [501, 500, { force: true }],
      [500, 500, { force: true }],
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
      applyPetWindowPosition: (x, y, opts) => positions.push([x, y, opts]),
      isDragLocked: () => dragging,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);
    dragging = true;
    timers.timeouts[0].fn();

    assert.deepStrictEqual(positions, [[11, 20, { force: true }], [10, 20, { force: true }]]);
  });

  it("skips the nudge path while dragging or mini transitions own movement", () => {
    const win = new FakeWindow();
    const positions = [];
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      isDragLocked: () => true,
      applyPetWindowPosition: (x, y, opts) => positions.push([x, y, opts]),
    });

    runtime.guardAlwaysOnTop(win);
    win.emit("always-on-top-changed", null, false);

    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(positions, []);
  });

  // PR #751 Codex review #12 (rework batch B-7): every test above injects
  // applyPetWindowPosition as a bare spy — none of them can catch a bug in
  // the SEAM between topmost-runtime.js and the real main.js wrapper itself.
  // That seam is exactly where this PR's own predecessor bug lived (src/main.js
  // ~line 1163's applyPetWindowPosition(x, y, opts) wrapper used to be
  // (x, y) only, silently dropping force:true — found and fixed earlier in
  // this same PR #751 rework, batch A). This assembles a REAL
  // pet-window-runtime instance behind a function with that exact
  // (x, y, opts) => petWindowRuntime.applyPetWindowPosition(x, y, opts)
  // shape, standing in for main.js's actual wrapper, and proves force:true
  // survives the full chain end to end: a second nudge call landing on a
  // rect the window is ALREADY at still issues a native setBounds (the
  // runtime's own same-rect skip — applyPetWindowBounds's
  // `if (opts.force || !sameRect(cur, m.bounds)) win.setBounds(...)` — would
  // otherwise swallow it). A 2-param wrapper shape would silently drop
  // force:true and make the second setBounds never happen.
  it("assembly: a main.js-shaped 3-arg applyPetWindowPosition wrapper forwards force:true through to a real runtime's same-rect setBounds", () => {
    const win = new FakeWindow({ bounds: { x: 10, y: 20, width: 100, height: 100 } });
    const petWindowRuntime = createPetWindowRuntime({
      isWin: true,
      getRenderWindow: () => win,
      getPrimaryWorkAreaSafe: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    });

    // Mirrors src/main.js's actual current wrapper shape verbatim (see the
    // structural cross-check against the real file below) — NOT topmost.js's
    // own injected option, which is always correct by construction. The
    // point is to prove THIS shape, standing in for main.js, doesn't drop opts.
    function applyPetWindowPosition(x, y, opts) {
      return petWindowRuntime.applyPetWindowPosition(x, y, opts);
    }

    applyPetWindowPosition(50, 60, { force: true });
    assert.deepStrictEqual(win.getBounds(), { x: 50, y: 60, width: 100, height: 100 });
    const setBoundsCallsAfterFirst = win.calls.filter((c) => c[0] === "setBounds").length;
    assert.strictEqual(setBoundsCallsAfterFirst, 1, "sanity: the first call is a genuine rect change (10,20 -> 50,60)");

    // Same exact (x, y, opts) again: the window is ALREADY at (50, 60), so
    // this is now a genuine same-rect case. Without force:true reaching the
    // runtime (the batch-A regression), this second call would be silently
    // skipped — win.setBounds() would not fire again.
    applyPetWindowPosition(50, 60, { force: true });
    const setBoundsCallsAfterSecond = win.calls.filter((c) => c[0] === "setBounds").length;
    assert.strictEqual(
      setBoundsCallsAfterSecond, 2,
      "force:true must reach the runtime through this wrapper shape and still issue a native setBounds on a same-rect call"
    );
  });

  it("main.js's actual applyPetWindowPosition wrapper still has the 3-arg (x, y, opts) shape the assembly test above mirrors", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.ok(
      mainSource.includes("function applyPetWindowPosition(x, y, opts) { return petWindowRuntime.applyPetWindowPosition(x, y, opts); }"),
      "src/main.js's applyPetWindowPosition wrapper must keep forwarding all 3 arguments — a silent regression back to (x, y) would make force:true a no-op again, invisibly to every spy-based test in this file"
    );
  });

  it("watchdog reasserts visible helper windows and keeps them out of the taskbar", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const permissionBubble = new FakeWindow();
    const hiddenPermissionBubble = new FakeWindow({ visible: false });
    const updateBubble = new FakeWindow();
    const sessionHud = new FakeWindow();
    const quotaRing = new FakeWindow();
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
      getQuotaRingWindow: () => quotaRing,
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

    for (const window of [win, hitWin, permissionBubble, updateBubble, sessionHud, quotaRing]) {
      assert.deepStrictEqual(window.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    }
    assert.deepStrictEqual(hiddenPermissionBubble.calls, []);
    assert.deepStrictEqual(contextMenuOwner.calls, []);
    assert.deepStrictEqual(kept, [win, hitWin, permissionBubble, updateBubble, sessionHud, quotaRing, contextMenuOwner]);

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

  it("uses one fullscreen native observation for both focusability and auto-hide per poll tick", () => {
    const timers = makeTimers();
    let probeCalls = 0;
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => new FakeWindow(),
      getHitWin: () => new FakeWindow(),
      isForegroundFullscreen: () => {
        probeCalls += 1;
        return "game-1";
      },
      getFullscreenAutoHide: () => true,
      isFullscreenAutoHidden: () => false,
      setFullscreenAutoHidden: () => ({ applied: true, deferred: false, changed: true }),
      setHitWinFocusable: () => {},
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    runtime.startFocusablePoll();
    assert.strictEqual(probeCalls, 1, "the up-front sync must share one foreground snapshot");
    timers.intervals[0].fn();
    assert.strictEqual(probeCalls, 2, "each interval tick must make only one native probe call");
  });

  it("can reassert topmost from a cached non-fullscreen observation without probing again", () => {
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    let probeCalls = 0;
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => {
        probeCalls += 1;
        return true;
      },
    });

    runtime.reassertWinTopmost(false);

    assert.strictEqual(probeCalls, 0);
    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(hitWin.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
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

  it("an explicit auto-hide Show stays topmost even when fullscreenOverlay is off (#935)", () => {
    const timers = makeTimers();
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      isForegroundFullscreen: () => "game-1",
      getFullscreenOverlay: () => false,
      getFullscreenAutoHide: () => true,
      isFullscreenAutoHidden: () => false,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    runtime.noteFullscreenAutoHideOverride();
    runtime.reassertWinTopmost();
    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(hitWin.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);

    win.calls.length = 0;
    hitWin.calls.length = 0;
    runtime.startTopmostWatchdog();
    timers.intervals[0].fn();
    assert.deepStrictEqual(win.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);
    assert.deepStrictEqual(hitWin.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]]);

    hitWin.calls.length = 0;
    runtime.guardAlwaysOnTop(hitWin);
    hitWin.emit("always-on-top-changed", null, false);
    assert.deepStrictEqual(hitWin.calls, [["setAlwaysOnTop", true, createTopmostRuntime.WIN_TOPMOST_LEVEL]],
      "the always-on-top guard must not turn an explicit Show into an invisible logical state");
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
    const quotaRing = new FakeWindow();
    const contextMenuOwner = new FakeWindow();
    const stationaryCalls = [];
    const runtime = createTopmostRuntime({
      isMac: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      getPendingPermissions: () => [{ bubble: permissionBubble }],
      getUpdateBubbleWindow: () => updateBubble,
      getSessionHudWindow: () => sessionHud,
      getQuotaRingWindow: () => quotaRing,
      getContextMenuOwner: () => contextMenuOwner,
      getShowDock: () => false,
      applyStationaryCollectionBehavior: (window) => {
        stationaryCalls.push(window);
        return false;
      },
    });

    runtime.reapplyMacVisibility();

    for (const window of [win, hitWin, permissionBubble, updateBubble, sessionHud, quotaRing, contextMenuOwner]) {
      assert.deepStrictEqual(window.calls, [
        ["setAlwaysOnTop", true, createTopmostRuntime.MAC_TOPMOST_LEVEL],
        ["setVisibleOnAllWorkspaces", true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        }],
      ]);
    }
    assert.strictEqual(stationaryCalls.length, 14);
  });

  it("reasserts only presentation-visible permission windows", () => {
    const visibleBubble = new FakeWindow();
    const hiddenBubble = new FakeWindow({ visible: false });
    const queueWindow = new FakeWindow();
    const runtime = createTopmostRuntime({
      isMac: true,
      getPendingPermissions: () => [{ bubble: visibleBubble }, { bubble: hiddenBubble }],
      getPermissionPresentationWindows: () => [visibleBubble, queueWindow],
      applyStationaryCollectionBehavior: () => true,
    });

    runtime.reapplyMacVisibility();

    assert.ok(visibleBubble.calls.length > 0);
    assert.ok(queueWindow.calls.length > 0);
    assert.deepStrictEqual(hiddenBubble.calls, [],
      "overflow-hidden request windows must not be reasserted in the background");
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
  function makeDodgeSetup({ deDelegateResult = true, ...overrides } = {}) {
    const pet = new FakeWindow();
    const hit = new FakeWindow();
    const bubble = new FakeWindow({ bounds: { x: 100, y: 100, width: 300, height: 200 } });
    // #640 phase 2: the dodge triggers on overlapping a TEXT-INPUT bubble, set
    // at bubble creation — NOT on a focused field (__clawdMacImeEditing). No ime
    // flag here on purpose: the pet must step back the moment the bubble appears,
    // before the user ever clicks into the box.
    bubble.__clawdMacTextInputBubble = true;
    // I5: syncImeEditingPetDodge() now reports its intent through this
    // injected setter (pet-window-runtime's single ignore-mouse writer)
    // instead of calling hit.setIgnoreMouseEvents() directly. The real
    // setImeEditingPetDodge() dedupes against its own `imeEditingPetDodge`
    // flag, which STARTS AT false (not an unset sentinel) and short-circuits
    // before ever touching applyHitInputState() — mirror both the dedup and
    // its false starting value here, or a false->false call after a drag
    // (nothing ever actually went click-through) would wrongly still reach
    // hit.setIgnoreMouseEvents() in this test double.
    let lastAppliedDodge = false;
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
      // Record which native primitive ran on each window: applyStationary
      // re-delegates into the private space (on top); deDelegate pulls it out
      // (behind). deDelegateResult toggles the fade-fallback path (#640 phase 2).
      applyStationaryCollectionBehavior: (window) => {
        window.calls.push(["applyStationary"]);
        return true;
      },
      deDelegateWindowFromStationarySpace: (window, level) => {
        window.calls.push(["deDelegate", level]);
        return deDelegateResult;
      },
      setImeEditingPetDodge: (value) => {
        const next = !!value;
        if (next === lastAppliedDodge) return;
        lastAppliedDodge = next;
        hit.setIgnoreMouseEvents(next);
      },
      ...overrides,
    });
    return { pet, hit, bubble, runtime };
  }

  it("drops the pet behind the bubble and lets clicks through while it overlaps the sprite", () => {
    const { pet, hit, runtime } = makeDodgeSetup();

    runtime.syncImeEditingPetDodge();

    // Native path: both pet windows de-delegated out of the private space
    // (behind the bubble); the render window stays fully opaque.
    assert.deepStrictEqual(pet.calls, [["deDelegate", 0], ["setOpacity", 1]]);
    assert.deepStrictEqual(hit.calls, [["deDelegate", 0], ["setIgnoreMouseEvents", true]]);
  });

  it("is edge-triggered: repeated syncs while overlapping do not repeat window calls", () => {
    const { pet, hit, runtime } = makeDodgeSetup();

    runtime.syncImeEditingPetDodge();
    runtime.syncImeEditingPetDodge();
    runtime.syncImeEditingPetDodge();

    assert.strictEqual(pet.calls.length, 2, "deDelegate + setOpacity, once");
    assert.strictEqual(hit.calls.length, 2, "deDelegate + ignore-mouse, once");
  });

  it("stays behind while the bubble is up regardless of field focus (blur does NOT restore)", () => {
    const { pet, hit, bubble, runtime } = makeDodgeSetup();

    runtime.syncImeEditingPetDodge();          // bubble overlaps → pet drops behind
    bubble.__clawdMacImeEditing = true;        // user focuses the field
    runtime.syncImeEditingPetDodge();
    delete bubble.__clawdMacImeEditing;         // user blurs the field, bubble still up
    runtime.syncImeEditingPetDodge();

    // Focus/blur must not retrigger anything — the trigger is overlap, not focus.
    // The pet stepped back exactly once and stays there while the bubble is up.
    assert.deepStrictEqual(pet.calls, [["deDelegate", 0], ["setOpacity", 1]]);
    assert.deepStrictEqual(hit.calls, [["deDelegate", 0], ["setIgnoreMouseEvents", true]]);
  });

  it("restores the pet when the text-input bubble goes away (flag cleared)", () => {
    const { pet, hit, bubble, runtime } = makeDodgeSetup();

    runtime.syncImeEditingPetDodge();
    delete bubble.__clawdMacTextInputBubble;
    runtime.syncImeEditingPetDodge();

    assert.deepStrictEqual(pet.calls, [
      ["deDelegate", 0], ["setOpacity", 1],
      ["applyStationary"], ["setOpacity", 1],
    ]);
    assert.deepStrictEqual(hit.calls, [
      ["deDelegate", 0], ["setIgnoreMouseEvents", true],
      ["applyStationary"], ["setIgnoreMouseEvents", false],
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

    assert.deepStrictEqual(
      pet.calls.map((c) => c[0]),
      ["deDelegate", "setOpacity", "applyStationary", "setOpacity"]
    );
    assert.deepStrictEqual(pet.calls[pet.calls.length - 1], ["setOpacity", 1]);
    assert.deepStrictEqual(hit.calls[hit.calls.length - 1], ["setIgnoreMouseEvents", false]);
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

    assert.deepStrictEqual(pet.calls, [["deDelegate", 0], ["setOpacity", 1]]);
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

    // The dodge fires at the end of the pass: the pet is de-delegated behind the
    // bubble and left fully opaque, and the hit window goes click-through.
    assert.deepStrictEqual(
      pet.calls.filter((c) => c[0] === "deDelegate"),
      [["deDelegate", 0]]
    );
    assert.deepStrictEqual(
      pet.calls.filter((c) => c[0] === "setOpacity"),
      [["setOpacity", 1]]
    );
    assert.deepStrictEqual(
      hit.calls.filter((c) => c[0] === "setIgnoreMouseEvents"),
      [["setIgnoreMouseEvents", true]]
    );
  });

  it("keeps the pet de-delegated on later passes instead of re-delegating it on top", () => {
    const { pet, hit, runtime } = makeDodgeSetup();

    runtime.reapplyMacVisibility();  // establishes the overlap + de-delegation
    pet.calls.length = 0;
    hit.calls.length = 0;
    runtime.reapplyMacVisibility();  // second pass while still overlapping

    // apply() must re-de-delegate the pet windows, NOT re-run applyStationary
    // (which would re-insert them into the private absolute-level space on top).
    assert.deepStrictEqual(pet.calls, [["deDelegate", 0]]);
    assert.deepStrictEqual(hit.calls, [["deDelegate", 0]]);
  });

  // #640/F3: Electron's setIgnoreMouseEvents makes no promise about toggling
  // mid-gesture, so the click-through write is deferred while a drag is in
  // flight; the space moves (de-delegate / applyStationary) are not — they are
  // the same class of setLevel/space op the visibility pass already runs on
  // these windows mid-drag, and dropping the pet behind is the hands-on-verified
  // mid-drag experience. Drag-lock release re-runs the sync to apply the write.
  describe("drag-lock deferral", () => {
    it("drops the pet behind mid-drag but defers the click-through write", () => {
      const { pet, hit, runtime } = makeDodgeSetup({ isDragLocked: () => true });

      runtime.syncImeEditingPetDodge();

      assert.deepStrictEqual(pet.calls, [["deDelegate", 0], ["setOpacity", 1]],
        "the render window steps back mid-drag");
      assert.deepStrictEqual(hit.calls, [["deDelegate", 0]],
        "the hit window drops behind, but the ignore-mouse write waits for drag end");
    });

    it("applies the deferred click-through on the first sync after the drag ends", () => {
      let dragging = true;
      const { pet, hit, runtime } = makeDodgeSetup({ isDragLocked: () => dragging });

      runtime.syncImeEditingPetDodge();
      dragging = false;
      runtime.syncImeEditingPetDodge();

      assert.deepStrictEqual(hit.calls, [["deDelegate", 0], ["setIgnoreMouseEvents", true]]);
      assert.strictEqual(pet.calls.length, 2,
        "the render step already ran mid-drag; the post-drag sync only applies the write");

      runtime.syncImeEditingPetDodge();
      assert.strictEqual(hit.calls.length, 2, "the applied write is edge-triggered");
    });

    it("skips the write entirely when the overlap ended before the drag did", () => {
      let dragging = true;
      const { pet, hit, bubble, runtime } = makeDodgeSetup({ isDragLocked: () => dragging });

      runtime.syncImeEditingPetDodge();       // overlap while dragging → step back
      delete bubble.__clawdMacTextInputBubble; // bubble closes mid-drag
      runtime.syncImeEditingPetDodge();       // restore, still no write
      dragging = false;
      runtime.syncImeEditingPetDodge();       // drag ends: nothing left to apply

      assert.deepStrictEqual(pet.calls.map((c) => c[0]),
        ["deDelegate", "setOpacity", "applyStationary", "setOpacity"]);
      assert.ok(!hit.calls.some((c) => c[0] === "setIgnoreMouseEvents"),
        "never went click-through, so nothing to undo");
    });
  });

  // #640 phase 2: when native de-delegation is unavailable (FFI load failure
  // returns false) the pet falls back to fading in place instead of dropping
  // behind, and stays in the private space (on top) so apply() keeps
  // re-delegating rather than de-delegating it.
  describe("fade fallback when native de-delegation is unavailable", () => {
    it("fades the pet instead of dropping it behind when de-delegation returns false", () => {
      const { pet, hit, runtime } = makeDodgeSetup({ deDelegateResult: false });

      runtime.syncImeEditingPetDodge();

      assert.deepStrictEqual(pet.calls, [
        ["deDelegate", 0],
        ["setOpacity", createTopmostRuntime.IME_EDIT_PET_FADE_OPACITY],
      ]);
      assert.deepStrictEqual(hit.calls, [["deDelegate", 0], ["setIgnoreMouseEvents", true]]);
    });

    it("does not de-delegate pet windows on later passes in fallback mode", () => {
      const { pet, runtime } = makeDodgeSetup({ deDelegateResult: false });

      runtime.reapplyMacVisibility();
      pet.calls.length = 0;
      runtime.reapplyMacVisibility();

      // Faded-in-place → the pet must stay in the private space, so apply()
      // re-delegates it and never de-delegates.
      assert.ok(!pet.calls.some((c) => c[0] === "deDelegate"));
      assert.ok(pet.calls.some((c) => c[0] === "applyStationary"));
    });

    it("getPetTargetOpacity reports the faded baseline in fallback mode", () => {
      const { bubble, runtime } = makeDodgeSetup({ deDelegateResult: false });

      runtime.syncImeEditingPetDodge();
      assert.strictEqual(
        runtime.getPetTargetOpacity(),
        createTopmostRuntime.IME_EDIT_PET_FADE_OPACITY,
        "while fading in place, the baseline is the faded value"
      );

      delete bubble.__clawdMacTextInputBubble;
      runtime.syncImeEditingPetDodge();
      assert.strictEqual(runtime.getPetTargetOpacity(), 1);
    });
  });

  // #640 phase 2: external opacity writers (theme-switch fade) restore to this
  // value instead of a hardcoded 1. On the native path the de-delegated pet is
  // fully opaque (just behind), so the baseline stays 1 throughout.
  it("getPetTargetOpacity stays 1 when the pet is de-delegated behind the bubble", () => {
    const { bubble, runtime } = makeDodgeSetup();

    assert.strictEqual(runtime.getPetTargetOpacity(), 1,
      "before any sync the baseline is full opacity");

    runtime.syncImeEditingPetDodge();
    assert.strictEqual(runtime.getPetTargetOpacity(), 1,
      "de-delegated behind the bubble, the pet is fully opaque");

    delete bubble.__clawdMacTextInputBubble;
    runtime.syncImeEditingPetDodge();
    assert.strictEqual(runtime.getPetTargetOpacity(), 1);
  });
});

// ── #935: fullscreen auto-hide sync on the focusable poll ──
//
// The 1s focusable poll already tracks the fullscreen state (#562); the
// auto-hide rides the same tick, edge-triggered. The pet hides within ~1s of a
// fullscreen app taking the foreground and restores within ~1s of it leaving.
// A manual show (noteFullscreenAutoHideOverride, fired by pet-window-runtime's
// setPetHidden(false)) binds an override to the fullscreen APP — identified by
// the probe's opaque id — so it survives foreground excursions of any length
// (alt-tab, tray menus, transient probe errors) and ends only when a DIFFERENT
// fullscreen app takes the foreground.
describe("fullscreen auto-hide sync (#935)", () => {
  function createAutoHideHarness({ fsApp = null, pref = true, applyResult, isWindowAlive } = {}) {
    const timers = makeTimers();
    const win = new FakeWindow();
    const hitWin = new FakeWindow();
    const state = { fsApp, pref, autoHidden: false, foregroundId: null, observationReliable: true };
    const setCalls = [];
    const runtime = createTopmostRuntime({
      isWin: true,
      getWin: () => win,
      getHitWin: () => hitWin,
      // The probe reports an opaque id for the fullscreen foreground app, or
      // false when there is none (win-fullscreen-detect contract).
      isForegroundFullscreen: () => state.fsApp || false,
      getForegroundFullscreenObservation: () => ({
        reliable: state.observationReliable,
        foregroundId: state.foregroundId != null
          ? state.foregroundId
          : (typeof state.fsApp === "string" ? state.fsApp : null),
        fullscreenId: state.fsApp || null,
      }),
      isFullscreenWindowAlive: isWindowAlive || (() => null),
      getFullscreenAutoHide: () => state.pref,
      isFullscreenAutoHidden: () => state.autoHidden,
      setFullscreenAutoHidden: (value) => {
        setCalls.push(value);
        if (applyResult) {
          const result = applyResult(value);
          if (result.applied) state.autoHidden = value;
          return result;
        }
        state.autoHidden = value;
        return { applied: true, deferred: false, changed: true };
      },
      setHitWinFocusable: () => {},
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    return {
      state,
      setCalls,
      runtime,
      start: () => runtime.startFocusablePoll(),
      tick: () => timers.intervals[0].fn(),
    };
  }

  it("hides on entering fullscreen and restores on leaving, edge-triggered", () => {
    const h = createAutoHideHarness();
    h.start();
    h.tick();
    assert.deepStrictEqual(h.setCalls, []);

    h.state.fsApp = "app-1";
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);
    h.tick();
    // Steady fullscreen: no per-tick re-writes.
    assert.deepStrictEqual(h.setCalls, [true]);

    h.state.fsApp = null;
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, false]);
  });

  it("never touches the setter while the pref is off", () => {
    const h = createAutoHideHarness({ pref: false });
    h.start();
    h.tick();
    h.state.fsApp = "app-1";
    h.tick();
    h.tick();
    h.state.fsApp = null;
    h.tick();
    assert.deepStrictEqual(h.setCalls, []);
  });

  it("does not arm a future override from a Show gesture while the pref is off", () => {
    const h = createAutoHideHarness({ pref: false });
    h.runtime.noteFullscreenAutoHideOverride();
    h.state.pref = true;
    h.state.fsApp = "app-1";
    h.start();
    assert.deepStrictEqual(h.setCalls, [true]);
  });

  it("the up-front sync hides immediately when the poll starts mid-fullscreen", () => {
    const h = createAutoHideHarness({ fsApp: "app-1" });
    h.start();
    // Same rationale as the focusable up-front sync: starting (or re-arming)
    // while a fullscreen app is already foreground must not leave the pet
    // floating for a full poll interval.
    assert.deepStrictEqual(h.setCalls, [true]);
  });

  it("a hotkey show mid-fullscreen latches the override for that app", () => {
    const h = createAutoHideHarness();
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);

    // The global hotkey shows the pet without moving the foreground:
    // setPetHidden(false) clears the auto flag and reports the intent.
    h.state.autoHidden = false;
    h.runtime.noteFullscreenAutoHideOverride();
    h.tick();
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true], "the sync must not re-hide an overridden app");

    // The app exits; a DIFFERENT fullscreen app auto-hides again.
    h.state.fsApp = null;
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);
    h.state.fsApp = "app-2";
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, true]);
  });

  it("a Show Pet click from the tray menu survives the foreground blip back to the game", () => {
    const h = createAutoHideHarness();
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);

    // Right-clicking the tray icon moves the foreground off the fullscreen
    // app, so the sync restores the pet before the user even clicks the item.
    h.state.fsApp = null;
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, false]);

    // The Show Pet click lands as a visible no-op — but it still reports the
    // user's intent.
    h.runtime.noteFullscreenAutoHideOverride();

    // Refocusing the game binds the override to it: no re-hide.
    h.state.fsApp = "app-1";
    h.tick();
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, false], "the override must survive the tray foreground blip");
  });

  it("a tray Show still binds to the same fullscreen episode after the fallback grace window", () => {
    const h = createAutoHideHarness();
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);

    // Opening the tray takes foreground away from the game and auto-restores
    // the pet. Keep the menu/other window foreground far beyond the old 15s
    // arming window before the explicit Show gesture lands.
    h.state.fsApp = null;
    h.state.foregroundId = "tray";
    for (let i = 0; i < createTopmostRuntime.FSAUTOHIDE_OVERRIDE_GRACE_TICKS * 3; i++) h.tick();
    assert.deepStrictEqual(h.setCalls, [true, false]);

    h.runtime.noteFullscreenAutoHideOverride();
    h.state.fsApp = "app-1";
    h.state.foregroundId = null;
    h.tick();
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, false],
      "the explicit Show must not expire while the original fullscreen episode is still alive");
  });

  it("drops a definitively dead remembered HWND before arming a Show override", () => {
    let alive = true;
    const h = createAutoHideHarness({ isWindowAlive: () => alive });
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    h.state.fsApp = null;
    h.state.foregroundId = "tray";
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, false]);

    alive = false;
    h.runtime.noteFullscreenAutoHideOverride();
    for (let i = 0; i < createTopmostRuntime.FSAUTOHIDE_OVERRIDE_GRACE_TICKS; i++) h.tick();

    // Even if Windows eventually reuses the same numeric handle, the stale
    // episode no longer grants an unbounded override. Only the ordinary grace
    // remains, and it has expired here.
    h.state.fsApp = "app-1";
    h.state.foregroundId = null;
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, false, true]);
  });

  it("fails open when remembered HWND liveness is unavailable", () => {
    const h = createAutoHideHarness({ isWindowAlive: () => null });
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    h.state.fsApp = null;
    h.state.foregroundId = "tray";
    for (let i = 0; i < createTopmostRuntime.FSAUTOHIDE_OVERRIDE_GRACE_TICKS * 3; i++) h.tick();

    h.runtime.noteFullscreenAutoHideOverride();
    h.state.fsApp = "app-1";
    h.state.foregroundId = null;
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, false]);
  });

  it("the override survives alt-tab excursions of any length back to the same app", () => {
    const h = createAutoHideHarness();
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    h.state.autoHidden = false;
    h.runtime.noteFullscreenAutoHideOverride();
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);

    // Alt-tab away for far longer than the arming grace — also the shape of a
    // transient probe error, which fails closed to "not fullscreen".
    h.state.fsApp = null;
    for (let i = 0; i < createTopmostRuntime.FSAUTOHIDE_OVERRIDE_GRACE_TICKS * 3; i++) h.tick();

    // Back to the SAME app: the override is bound to it and must hold.
    h.state.fsApp = "app-1";
    h.tick();
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true], "returning to the overridden app must not re-hide");
  });

  it("a different fullscreen app ends the override and auto-hides", () => {
    const h = createAutoHideHarness();
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    h.state.autoHidden = false;
    h.runtime.noteFullscreenAutoHideOverride();
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);

    h.state.fsApp = null;
    h.tick();
    h.state.fsApp = "app-2";
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, true], "the NEXT fullscreen app is a new episode");
  });

  it("a confirmed exit ends the override before the same HWND enters fullscreen again", () => {
    const h = createAutoHideHarness();
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    h.state.autoHidden = false;
    h.runtime.noteFullscreenAutoHideOverride();
    h.tick();

    // The same foreground HWND is now a normal window: this is a real F11
    // exit, not an Alt-Tab/tray excursion to a different HWND.
    h.state.fsApp = null;
    h.state.foregroundId = "app-1";
    h.tick();

    h.state.fsApp = "app-1";
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, true],
      "re-entering fullscreen in the same window is a new episode");
  });

  it("does not clear a bound override on unreliable non-fullscreen probe failures", () => {
    const h = createAutoHideHarness();
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    h.state.autoHidden = false;
    h.runtime.noteFullscreenAutoHideOverride();
    h.tick();

    h.state.fsApp = null;
    h.state.foregroundId = "app-1";
    h.state.observationReliable = false;
    h.tick();
    h.state.fsApp = "app-1";
    h.state.observationReliable = true;
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);
  });

  it("an armed override that never sees a fullscreen app decays after the grace window", () => {
    const h = createAutoHideHarness();
    h.start();

    // A show gesture on the plain desktop still signals intent...
    h.runtime.noteFullscreenAutoHideOverride();
    // ...but with no fullscreen app to bind to it burns down tick by tick.
    for (let i = 0; i < createTopmostRuntime.FSAUTOHIDE_OVERRIDE_GRACE_TICKS; i++) h.tick();

    // A fullscreen app starting after the grace window hides normally.
    h.state.fsApp = "app-1";
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);
  });

  it("an identity-less fullscreen override ends after a confirmed exit", () => {
    const h = createAutoHideHarness();
    h.start();
    h.state.fsApp = true;
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);

    h.state.autoHidden = false;
    h.runtime.noteFullscreenAutoHideOverride();
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);

    // One false observation may be a transient native probe miss.
    h.state.fsApp = null;
    h.tick();
    h.state.fsApp = true;
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);

    // A confirmed exit clears the anonymous bind, so a later fullscreen
    // episode hides normally instead of inheriting the override forever.
    h.state.fsApp = null;
    for (let i = 0; i < createTopmostRuntime.FSAUTOHIDE_ANONYMOUS_EXIT_TICKS; i++) h.tick();
    h.state.fsApp = true;
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, true]);
  });

  it("upgrades an anonymous override when the probe recovers window identity", () => {
    const h = createAutoHideHarness();
    h.start();
    h.state.fsApp = true;
    h.tick();
    h.state.autoHidden = false;
    h.runtime.noteFullscreenAutoHideOverride();
    h.tick();

    h.state.fsApp = "app-1";
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true], "identity recovery must not re-hide the same episode");

    h.state.fsApp = null;
    h.tick();
    h.state.fsApp = "app-2";
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, true], "the recovered identity must distinguish the next app");
  });

  it("turning the pref off mid-fullscreen restores the pet on the next tick", () => {
    const h = createAutoHideHarness();
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);

    h.state.pref = false;
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, false]);
  });

  it("turning the pref off clears a manual-show override before it is enabled again", () => {
    const h = createAutoHideHarness();
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    h.state.autoHidden = false;
    h.runtime.noteFullscreenAutoHideOverride();
    h.tick();

    h.state.pref = false;
    // main.js clears synchronously from the settings mirror so even an off/on
    // round trip faster than the 1s poll cannot retain the old episode.
    h.runtime.clearFullscreenAutoHideOverride();
    h.state.pref = true;
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, true],
      "re-enabling the pref must not inherit an override from its prior lifetime");
  });

  it("main clears the override and visibility layer synchronously when the pref is disabled", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(mainSource, /fullscreenAutoHide: \(v\) => \{[\s\S]*?fullscreenAutoHideCached = v;[\s\S]*?if \(!v\) \{[\s\S]*?topmostRuntime\.clearFullscreenAutoHideOverride\(\);[\s\S]*?petWindowRuntime\.setFullscreenAutoHidden\(false\);/);
  });

  it("main forwards the poll observation through auto restore and cached topmost reassertion", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(mainSource, /setFullscreenAutoHidden: \(\.\.\.args\) => petWindowRuntime\.setFullscreenAutoHidden\(\.\.\.args\)/);
    assert.match(mainSource, /reassertWinTopmost: \(\.\.\.args\) => reassertWinTopmost\(\.\.\.args\)/);
  });

  it("cleanup clears remembered fullscreen episode and override state", () => {
    const h = createAutoHideHarness();
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    h.state.autoHidden = false;
    h.runtime.noteFullscreenAutoHideOverride();
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true]);

    h.runtime.cleanup();
    h.runtime.startFocusablePoll();
    assert.deepStrictEqual(h.setCalls, [true, true],
      "a restarted poll must not inherit an override from the cleaned-up runtime");
  });

  it("retries a deferred hide on the next tick instead of latching a false override", () => {
    let defers = 1;
    const h = createAutoHideHarness({
      applyResult: () => {
        if (defers > 0) {
          defers -= 1;
          return { applied: false, deferred: true, changed: false };
        }
        return { applied: true, deferred: false, changed: true };
      },
    });
    h.start();
    h.state.fsApp = "app-1";
    h.tick();
    // Deferred (mini transition in flight): flag not set...
    assert.deepStrictEqual(h.setCalls, [true]);
    assert.equal(h.state.autoHidden, false);
    // ...and the next tick must retry rather than mistake the unset flag for
    // a user override.
    h.tick();
    assert.deepStrictEqual(h.setCalls, [true, true]);
    assert.equal(h.state.autoHidden, true);
  });
});
