"use strict";

// Issue #690 plan §6.7: the one test file that assembles
// pet-window-runtime + mini + drag-position + pet-interaction-ipc TOGETHER.
// Each of those modules is already unit-tested in isolation (see
// test/pet-window-runtime.test.js, test/mini.test.js, test/drag-position.test.js,
// test/pet-interaction-ipc.test.js) — this file exists only for the seams
// between them: does a real drag -> drag-end IPC sequence, driving the REAL
// mini.js checkMiniModeSnap()/enterMiniViaMenu() against a REAL
// pet-window-runtime instance under a Mutter-style physical clamp, produce
// the same #690 fix the isolated unit tests already prove piecemeal?

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const createPetWindowRuntime = require("../src/pet-window-runtime");
const { registerPetInteractionIpc } = require("../src/pet-interaction-ipc");

// ── makeWindow/FakeIpcMain — copied from test/pet-window-runtime.test.js and
// test/pet-interaction-ipc.test.js. Test files in this codebase are
// self-contained (no cross-file requires of test helpers), so this is a
// deliberate small duplication, not drift.
function makeWindow(bounds = { x: 10, y: 20, width: 100, height: 100 }) {
  const calls = [];
  const listeners = new Map();
  const win = {
    calls,
    bounds: { ...bounds },
    destroyed: false,
    visible: true,
    webContents: {
      destroyed: false,
      on: (event, cb) => listeners.set(event, cb),
      reload: () => calls.push(["reload"]),
      isDestroyed() { return this.destroyed; },
    },
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    getBounds: () => ({ ...win.bounds }),
    setBounds: (next) => {
      calls.push(["setBounds", next]);
      win.bounds = { ...next };
    },
    setShape: (shape) => calls.push(["setShape", shape]),
    setIgnoreMouseEvents: (value) => calls.push(["setIgnoreMouseEvents", value]),
    setAlwaysOnTop: (...args) => calls.push(["setAlwaysOnTop", ...args]),
    setFocusable: (value) => calls.push(["setFocusable", value]),
    showInactive: () => calls.push(["showInactive"]),
    hide: () => calls.push(["hide"]),
    loadFile: (file) => calls.push(["loadFile", file]),
    on: (event, cb) => listeners.set(event, cb),
    emit: (event, ...args) => listeners.get(event)?.(...args),
  };
  return win;
}

class FakeIpcMain {
  constructor() {
    this.listeners = new Map();
  }

  on(channel, listener) {
    this.listeners.set(channel, listener);
  }

  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }

  send(channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }
}

// mini.js does `require("electron")` directly (unlike pet-window-runtime.js,
// which takes `screen` as a constructor dependency), so loading it in a
// plain Node test process needs the same require.cache substitution
// test/mini.test.js's loadMiniWithElectron() uses — plain `require("electron")`
// outside the real Electron binary resolves to a path string, not an API
// object, and `const { screen } = require("electron")` would silently become
// undefined.
function loadMiniWithElectron(screenExports) {
  const electronPath = require.resolve("electron");
  const miniPath = require.resolve("../src/mini");
  const previousElectron = Object.prototype.hasOwnProperty.call(require.cache, electronPath)
    ? require.cache[electronPath]
    : null;
  const previousMini = Object.prototype.hasOwnProperty.call(require.cache, miniPath)
    ? require.cache[miniPath]
    : null;

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      screen: screenExports,
    },
  };
  delete require.cache[miniPath];

  return {
    initMini: require("../src/mini"),
    restore() {
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      if (previousMini) require.cache[miniPath] = previousMini;
      else delete require.cache[miniPath];
    },
  };
}

// ── #690 Phase 0 fixture — same exact geometry as
// test/pet-window-runtime.test.js's ISSUE_690_* fixture (Fedora 44 / GNOME
// Shell 50.3 / Mutter reproduction, docs/plans/plan-issue-690-gnome-mini-edge-
// snap.md §1.2 and §5 Phase 0): 1920x1080 single display, 203x209 pet
// window, Mutter's require_fully_onscreen constraint clamps any
// application-driven setBounds() asking for X > 1717 straight back to 1717.
const ISSUE_690_WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };
const ISSUE_690_WINDOW_SIZE = { width: 203, height: 209 };
const ISSUE_690_MUTTER_MAX_X = 1717; // workArea.width - window.width
const ISSUE_690_DISPLAYS = [{ id: 1, bounds: ISSUE_690_WORK_AREA, workArea: ISSUE_690_WORK_AREA }];

// PR #751 third-review D-2 (Codex non-blocking): `getWorkArea` (defaults to
// the fixed ISSUE_690_WORK_AREA — a no-op change for every existing caller
// that never mutates topology) is read FRESH on every setBounds() call,
// instead of clamping against the module-level ISSUE_690_MUTTER_MAX_X
// constant unconditionally. That constant was hardcoded against the FIXED
// 1920-wide default workArea, completely detached from
// createEdgeVirtualizationHarness()'s own mutable workArea (setTopology()) —
// a test that widens the workArea mid-run (e.g. C-5/C-5b) could assert on
// the software's own logical bounds (getPetWindowBounds(), which never
// touches this mock at all) and pass without the mock's own PHYSICAL clamp
// ever being exercised against the NEW boundary. Codex's own real-machine
// verification already confirmed the production path (a real Mutter
// re-enforcing against the actual, now-changed screen) is correct — this
// mock just couldn't prove it either way. maxX is derived the same way
// ISSUE_690_MUTTER_MAX_X itself is (workArea width minus the window's OWN
// requested width), generalizing it instead of assuming a fixed 203px window.
function makeMutterClampedWindow(bounds, options = {}) {
  const win = makeWindow(bounds);
  const getWorkArea = options.getWorkArea || (() => ISSUE_690_WORK_AREA);
  win.setBounds = (next) => {
    win.calls.push(["setBounds", next]);
    // require_fully_onscreen clamps BOTH edges symmetrically, not just the
    // right one — a window can't be pushed off the left edge either. The
    // original P0-1 fixture only ever requested X > MAX, so the left half
    // of this was previously untested; the coordinator-directed 1px-shrunk
    // fly-off jump target fix is the first scenario here that actually
    // requests a negative X, so the left clamp is filled in now to match.
    const wa = getWorkArea();
    const maxX = wa.x + wa.width - next.width;
    let clampedX = next.x;
    if (clampedX > maxX) clampedX = maxX;
    if (clampedX < wa.x) clampedX = wa.x;
    win.bounds = { ...next, x: clampedX };
    // PR #751 rework batch A-5: a real WM clamping a setBounds() request to a
    // DIFFERENT position than what was literally asked for is itself a native
    // geometry change — it would fire a real ConfigureNotify/move event, not
    // land silently. Without this, tests using this mock only ever drove the
    // reconcile chain when they remembered to call emit("move") manually;
    // this makes the mock's own clamp automatically wake it up, matching how
    // a real BrowserWindow would behave. Harmless when a caller ALSO emits
    // "move" itself afterward — onNativeGeometryEvent()'s scheduleReconcile()
    // just reschedules the same debounced timer, never double-fires.
    win.emit("move");
  };
  return win;
}

// Minimal mini.miniMode theme: offsetRatio is set explicitly (not borrowed
// from theme-schema.js's independently-evolving default) so the
// entered-mini resting X used by these fixtures is a constant this file
// controls.
function makeMiniTheme(offsetRatio) {
  return {
    miniMode: {
      supported: true,
      offsetRatio,
      states: {},
    },
  };
}

// PR #751 third-review D-2: a minimal but REAL theme (no injected
// hitGeometry/getThemeMarginBox/computeThemeAnchorRect fakes —
// pet-window-runtime.js's own petGeometryMain construction doesn't accept
// those as pass-through options, so this has to go through the actual
// src/hit-geometry.js + src/visible-margins.js code) for verifying
// getSessionHudAnchorRect() converges to the same X the render/hit windows
// do. Deliberately omits theme.layout.contentBox, so
// hit-geometry.js's usesNormalizedLayout()/usesObjectChannel() both take
// their "false" branch — getAssetRectScreen()'s simplest, non-normalized,
// non-object-channel path — which resolves to exactly `x: bounds.x`
// (default imgOffsetX/offsetPxX are both 0). marginBox is set IDENTICAL to
// viewBox (0,0,100,100), so getContentRectScreen()'s own box-vs-viewBox
// scale/offset math collapses to `left: artRect.x` too — i.e. this theme's
// anchor rect .left is guaranteed, by construction, to equal the render
// window's own logical bounds.x, without needing to reverse-engineer a
// real production theme's actual layout numbers.
const HUD_ANCHOR_TEST_THEME = {
  states: { idle: ["idle.svg"] },
  viewBox: { x: 0, y: 0, width: 100, height: 100 },
  layout: { marginBox: { x: 0, y: 0, width: 100, height: 100 } },
};

// Assembles a real pet-window-runtime + real mini.js + real
// pet-interaction-ipc against the #690 Phase 0 fixture.
// flushRuntimeStateToPrefs is a spy writing into an in-memory object (plan
// §6.7's own wording), never touching the filesystem. Must be called AFTER
// mock.timers.enable() (see the describe block below) — pet-window-runtime.js
// captures the global setTimeout/clearTimeout once at construction time
// (`options.setTimeout || setTimeout`), so enabling the mock only after
// construction would leave its internal reconcile timers on the real clock.
function createEdgeVirtualizationHarness(overrides = {}) {
  const prefs = {};
  const edgeLogs = [];
  let checkMiniModeSnapCalls = 0;
  let cursor = { x: 100, y: 100 };
  // Mutable topology (batch 3 follow-up: handleDisplayAdded/Removed's
  // pendingTopologyMaterialize regressions need to change the effective
  // displays/workArea mid-test to prove the eventual re-materialize actually
  // uses NEW topology, not the one captured at entry). Every other test in
  // this file only ever reads these through the closures below, so leaving
  // them at the fixed single-display default is a no-op for them.
  let displays = overrides.displays || ISSUE_690_DISPLAYS;
  let workArea = overrides.workArea || ISSUE_690_WORK_AREA;
  // PR #751 Codex review #10 (rework batch B-5): mini.js and
  // pet-window-runtime.js each hold their OWN separate reference to
  // `screen`, so they need separate counters, not one shared one. mini.js's
  // own resolveMiniTopology() call (src/mini.js ~line 75) was already capped
  // at exactly 1/transition by Phase 3 (threaded through animCtx as
  // edgeContext) — that is NOT what B-5 changes. What B-5 fixes is the
  // RUNTIME's own internal enumeration
  // (materializeVirtualBounds -> resolveHorizontalClampBounds ->
  // findDisplayIdForPoint(), unconditional regardless of a provided
  // edgeContext, plus syncHitWin()'s own clamp-bounds resolution), which
  // used to run again on every single per-frame applyPetWindowBounds()/
  // syncHitWin() call — invisible to the OLD mock-based mini.test.js
  // assertion, since that mock's ctx.applyPetWindowBounds never touched the
  // real runtime at all (Codex non-blocking finding). Tracking the two
  // sources separately lets the test attribute each budget to the actual
  // mechanism that owns it, instead of one combined number that can't tell
  // an old-and-fine source from a newly-fixed one.
  let runtimeGetAllDisplaysCallCount = 0;
  let miniGetAllDisplaysCallCount = 0;
  function countedRuntimeGetAllDisplays() {
    runtimeGetAllDisplaysCallCount++;
    return displays;
  }
  function countedMiniGetAllDisplays() {
    miniGetAllDisplaysCallCount++;
    return displays;
  }

  // PR #751 Codex review #12 (rework batch B-8, non-blocking): src/main.js
  // wires the SAME underlying repositionSessionHud() function to both
  // mini.js's ctx (src/main.js's _miniCtx) and the runtime's own option
  // (src/main.js's petWindowRuntime options) — a single shared counter here
  // mirrors that real identity, the same way countedRuntimeGetAllDisplays/
  // countedMiniGetAllDisplays above mirror getAllDisplays' actually-separate
  // identity. Before batch B-8, mini's own per-frame step called this AND
  // the runtime's applyPetWindowBounds() tail end called it again for the
  // same frame — a genuine duplicate now removed.
  let repositionSessionHudCallCount = 0;
  function countedRepositionSessionHud() {
    repositionSessionHudCallCount++;
  }
  // Every write during a mini animation goes through mini's own
  // applyPetWindowBounds (no other concurrent write source runs at the same
  // time), so this is the exact expected repositionSessionHud count post-fix
  // (1 per write, from the runtime's own tail-end call only) — a robust
  // ratio assertion instead of guessing an animation's exact frame count.
  let miniApplyPetWindowBoundsCallCount = 0;

  // PR #751 third-review D-2: getWorkArea reads the SAME mutable `workArea`
  // binding setTopology() below reassigns — so a test that widens the
  // workArea mid-run now also moves this mock's own physical clamp
  // boundary, instead of leaving it hardcoded to the original topology.
  const renderWin = overrides.renderWin || makeMutterClampedWindow({
    x: 0, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
  }, { getWorkArea: () => workArea });
  const hitWin = overrides.hitWin || makeWindow({
    x: 0, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
  });

  const loader = loadMiniWithElectron({ getAllDisplays: () => countedMiniGetAllDisplays() });

  // Forward-referenced (assigned below) — function declarations are hoisted
  // and closures capture the binding, not a snapshot, so referencing
  // `runtime`/`mini` here is safe as long as flushPrefs() is only ever
  // CALLED after both are assigned (true here: earliest call is from a
  // drag-end IPC dispatch or an explicit test call, both well after this
  // whole function returns).
  function flushPrefs() {
    // Mirrors main.js's real flushRuntimeStateToPrefs(): reads the runtime's
    // own logical bounds (never physical) plus mini's state, into the spy.
    const bounds = runtime.getPetWindowBounds();
    Object.assign(prefs, {
      x: bounds.x,
      y: bounds.y,
      miniMode: mini.getMiniMode(),
      miniEdge: mini.getMiniEdge(),
      preMiniX: mini.getPreMiniX(),
      preMiniY: mini.getPreMiniY(),
    });
  }

  const runtime = createPetWindowRuntime({
    screen: {
      getAllDisplays: () => countedRuntimeGetAllDisplays(),
      getCursorScreenPoint: () => cursor,
      getDisplayNearestPoint: () => displays[0],
      getPrimaryDisplay: () => displays[0],
    },
    isWin: false,
    isMac: false,
    isLinux: true,
    linuxWindowType: "toolbar",
    topmostLevel: "pop-up-menu",
    getRenderWindow: () => renderWin,
    getHitWindow: () => hitWin,
    getSettingsWindow: () => null,
    // PR #751 third-review D-2: overridable so a test can verify
    // getSessionHudAnchorRect() (which needs a real theme with a resolvable
    // viewBox/marginBox to return anything at all) — every other existing
    // test in this file never sets this and keeps getting null, unaffected.
    getActiveTheme: () => overrides.activeTheme || null,
    getCurrentState: () => "idle",
    getCurrentSvg: () => "idle.svg",
    getCurrentHitBox: () => null,
    getMiniMode: () => mini.getMiniMode(),
    getMiniTransitioning: () => mini.getMiniTransitioning(),
    getMiniContainedSeam: () => mini.getContainedSeam(),
    getMiniPeekOffset: () => 0,
    isMiniAnimating: () => mini.getIsAnimating(),
    getCurrentPixelSize: () => ISSUE_690_WINDOW_SIZE,
    getEffectiveCurrentPixelSize: () => ISSUE_690_WINDOW_SIZE,
    getAllowEdgePinning: () => false,
    getPrimaryWorkAreaSafe: () => workArea,
    getNearestWorkArea: () => workArea,
    sendToRenderer: () => {},
    keepOutOfTaskbar: () => {},
    repositionSessionHud: () => countedRepositionSessionHud(),
    repositionAnchoredSurfaces: () => {},
    repositionFloatingBubbles: () => {},
    showFloatingSurfacesForPet: () => {},
    hideFloatingSurfacesForPet: () => {},
    syncSessionHudVisibilityAndBubbles: () => {},
    syncPermissionShortcuts: () => {},
    buildTrayMenu: () => {},
    buildContextMenu: () => {},
    reapplyMacVisibility: () => {},
    reassertWinTopmost: () => {},
    scheduleHwndRecovery: () => {},
    isNearWorkAreaEdge: () => false,
    edgeLog: (message) => edgeLogs.push(message),
    flushRuntimeStateToPrefs: flushPrefs,
    handleMiniDisplayChange: () => mini.handleDisplayChange(),
    notifyMiniTopologyChangedDuringTransition: () => mini.notifyTopologyChangedDuringTransition(),
    exitMiniMode: () => mini.exitMiniMode(),
  });

  const miniCtx = {
    theme: overrides.miniTheme || makeMiniTheme(0.486),
    get win() { return renderWin; },
    currentSize: "m",
    doNotDisturb: false,
    bubbleFollowPet: false,
    pendingPermissions: [],
    SIZES: { m: ISSUE_690_WINDOW_SIZE },
    getCurrentPixelSize: () => ISSUE_690_WINDOW_SIZE,
    getEffectiveCurrentPixelSize: () => ISSUE_690_WINDOW_SIZE,
    getPetWindowBounds: () => runtime.getPetWindowBounds(),
    applyPetWindowBounds: (bounds, opts) => {
      miniApplyPetWindowBoundsCallCount++;
      return runtime.applyPetWindowBounds(bounds, opts);
    },
    setViewportOffsetY: (y) => runtime.setViewportOffsetY(y),
    getAnimationAssetCycleMs: () => null,
    stopWakePoll: () => {},
    sendToRenderer: () => {},
    sendToHitWin: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    syncHitWin: () => runtime.syncHitWin(),
    repositionBubbles: () => {},
    repositionSessionHud: () => countedRepositionSessionHud(),
    getNearestWorkArea: () => workArea,
    clampToScreenVisual: (x, y, w, h, opts) => runtime.clampToScreenVisual(x, y, w, h, opts),
    resolveDisplayState: () => "idle",
    getSvgOverride: () => null,
    applyState: () => {},
    releaseReconcileProtection: () => runtime.releaseReconcileProtection(),
  };
  const mini = loader.initMini(miniCtx);

  const ipcMain = new FakeIpcMain();
  const runtimeApi = registerPetInteractionIpc({
    ipcMain,
    showContextMenu: () => {},
    moveWindowForDrag: () => runtime.moveWindowForDrag(),
    setIdlePaused: () => {},
    isMiniTransitioning: () => mini.getMiniTransitioning(),
    getCurrentState: () => "idle",
    getCurrentSvg: () => "idle.svg",
    sendToRenderer: () => {},
    recoverVisiblePetAfterRendererLoad: () => {},
    setDragLocked: (v) => runtime.setDragLocked(v),
    setMouseOverPet: () => {},
    cancelRoam: () => {},
    beginDragSnapshot: () => runtime.beginDragSnapshot(),
    clearDragSnapshot: () => runtime.clearDragSnapshot(),
    syncHitWin: () => runtime.syncHitWin(),
    isMiniMode: () => mini.getMiniMode(),
    checkMiniModeSnap: () => {
      checkMiniModeSnapCalls++;
      return mini.checkMiniModeSnap();
    },
    hasPetWindow: () => true,
    getPetWindowBounds: () => runtime.getPetWindowBounds(),
    getKeepSizeAcrossDisplays: () => false,
    getCurrentPixelSize: () => ISSUE_690_WINDOW_SIZE,
    getEffectiveCurrentPixelSize: () => ISSUE_690_WINDOW_SIZE,
    computeDragEndBounds: (bounds, size) => runtime.computeFinalDragBounds(bounds, size, runtime.clampToScreenVisual),
    applyPetWindowBounds: (bounds) => runtime.applyPetWindowBounds(bounds),
    flushRuntimeStateToPrefs: flushPrefs,
    reassertWinTopmost: () => {},
    scheduleHwndRecovery: () => {},
    repositionFloatingBubbles: () => {},
    exitMiniMode: () => mini.exitMiniMode(),
    getDisableMiniMode: overrides.getDisableMiniMode || (() => false),
    getFocusableLocalHudSessionIds: () => [],
    focusLog: () => {},
    showDashboard: () => {},
    focusSession: () => {},
    revealSessionHud: () => {},
    setLowPowerIdlePaused: () => {},
    statPath: async () => { throw new Error("not used"); },
    openTerminalAt: async () => ({ ok: false }),
    dropLog: () => {},
    isMacPlatform: false,
  });

  return {
    runtime,
    mini,
    ipcMain,
    renderWin,
    hitWin,
    prefs,
    edgeLogs,
    dispose: () => { runtimeApi.dispose(); loader.restore(); },
    setCursor: (point) => { cursor = point; },
    getCheckMiniModeSnapCalls: () => checkMiniModeSnapCalls,
    getRuntimeGetAllDisplaysCallCount: () => runtimeGetAllDisplaysCallCount,
    getMiniGetAllDisplaysCallCount: () => miniGetAllDisplaysCallCount,
    getRepositionSessionHudCallCount: () => repositionSessionHudCallCount,
    getMiniApplyPetWindowBoundsCallCount: () => miniApplyPetWindowBoundsCallCount,
    // Batch 3 follow-up: lets a test change the effective topology mid-run,
    // to prove pendingTopologyMaterialize's eventual re-materialize actually
    // reflects the NEW displays/workArea rather than the one captured when
    // mini's transition started.
    setTopology: (next) => {
      if (next.displays) displays = next.displays;
      if (next.workArea) workArea = next.workArea;
    },
  };
}

// Drives a full drag: drag-lock(true) -> beginDragSnapshot anchor at
// `startBounds`/`startCursor` -> a drag-move ending at `endCursor` ->
// drag-end. Mirrors the real renderer's IPC sequence (src/preload.js's drag
// handlers), not a direct function call into pet-window-runtime — this is
// what proves the seam between pet-interaction-ipc and the runtime, not
// just the runtime alone.
function runDrag(h, { startBounds, startCursor, endCursor }) {
  h.runtime.applyPetWindowBounds(startBounds, { force: true });
  h.setCursor(startCursor);
  h.ipcMain.send("drag-lock", true);
  h.setCursor(endCursor);
  h.ipcMain.send("drag-move");
  h.ipcMain.send("drag-end");
}

describe("edge virtualization cross-module integration (#690 §6.7)", () => {
  // mini.js's animation frames use the bare global setTimeout/Date.now (no
  // injected clock, unlike pet-window-runtime.js) — mock.timers reproduces
  // test/mini.test.js's own approach. It must be enabled BEFORE
  // createEdgeVirtualizationHarness() runs: pet-window-runtime.js resolves
  // `options.setTimeout || setTimeout` once at construction time, so
  // enabling the mock afterward would leave its internal reconcile timers on
  // the real clock while mini.js's (looked up fresh on every call) would be
  // mocked — an inconsistent split. Enabling first keeps both on one clock.
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("P0-1 regression: a drag past the Linux-virtualized edge settles prefs at the safe logical rest position (mini disabled)", () => {
    // mini is disabled for this specific scenario because of a genuine
    // arithmetic fact about this exact fixture, not a limitation of the
    // harness: clampToScreenVisual's rest ceiling for a 203px-wide window is
    // 1920 - 203 + round(203*0.25) = 1768 (src/pet-window-runtime.js's
    // clampToScreenVisual, its own independent 0.25 margin), while
    // checkMiniModeSnap()'s own snap threshold is
    // 1768 - SNAP_TOLERANCE(30) = 1738. Since 1768 >= 1738 unconditionally,
    // ANY drag whose normal-path clamp lands exactly on 1768 has, by
    // construction, already crossed 1738 — with mini enabled that always
    // triggers enterMiniMode() first (drag-end's own
    // `if (!isMiniMode() && !isMiniTransitioning())` guard), so "prefs
    // receives the clamp-safe 1768 via the normal fallthrough" and "mini
    // enabled" are mutually exclusive for this fixture. Disabling mini here
    // isolates exactly the #690 fix this regression is about: the drag-end
    // fallthrough clamp reads the RUNTIME's logical bounds, not physical.
    // Task item 7's "checkMiniModeSnap() itself decides from logical, not
    // physical, bounds" is covered by the dedicated tests further below.
    const h = createEdgeVirtualizationHarness({ getDisableMiniMode: () => true });

    runDrag(h, {
      startBounds: { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      startCursor: { x: 100, y: 100 },
      endCursor: { x: 1000, y: 100 }, // +900 logical -> raw target 1900, past every boundary
    });

    assert.equal(h.prefs.x, 1768, "prefs must land on the logical rest position, not the Mutter-clamped physical 1717");
    assert.equal(h.renderWin.bounds.x, ISSUE_690_MUTTER_MAX_X, "the physical window itself must still stay Mutter-safe");
    h.dispose();
  });

  it("late clamp doesn't ratchet: three consecutive drag -> drag-end cycles all settle prefs at 1768, never drifting inward", () => {
    const h = createEdgeVirtualizationHarness({ getDisableMiniMode: () => true });

    for (let i = 0; i < 3; i++) {
      runDrag(h, {
        startBounds: { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
        startCursor: { x: 100, y: 100 },
        endCursor: { x: 1000, y: 100 },
      });
      assert.equal(h.prefs.x, 1768, `cycle ${i + 1}: prefs.x must stay 1768, not ratchet inward`);
    }
    h.dispose();
  });

  it("checkMiniModeSnap() runs as part of the real drag-end IPC and decides from logical bounds, not the Mutter-clamped physical bounds", () => {
    // Logical 1720 sits between Mutter's physical clamp (1717) and mini's own
    // snap threshold (1738): physical WOULD be clamped to 1717 (1720 > 1717),
    // but 1720 < 1738 so checkMiniModeSnap() must correctly decide NOT to
    // snap using the logical value. This proves checkMiniModeSnap() is wired
    // into the real assembled drag-end chain and sees logical 1720 (not that
    // this particular value flips the outcome — task item 7a below does
    // that with a value that crosses the threshold).
    const h = createEdgeVirtualizationHarness();

    runDrag(h, {
      startBounds: { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      startCursor: { x: 100, y: 100 },
      endCursor: { x: 820, y: 100 }, // +720 logical -> target 1720
    });

    assert.equal(h.getCheckMiniModeSnapCalls(), 1, "checkMiniModeSnap() must be reached exactly once by drag-end");
    assert.equal(h.mini.getMiniMode(), false, "1720 is below mini's own 1738 snap threshold");
    assert.equal(h.runtime.getPetWindowBounds().x, 1720, "logical bounds must report the true drag target, not physical 1717");
    assert.equal(h.renderWin.bounds.x, ISSUE_690_MUTTER_MAX_X, "physical window itself stays Mutter-clamped");
    h.dispose();
  });

  it("task item 7a: checkMiniModeSnap() reaches X=1738, enters mini mode, and settles at the correct logical X (not a stale/physical value)", () => {
    // checkMiniModeSnap()'s OWN threshold check already read
    // ctx.getPetWindowBounds() before this batch (an earlier batch's fix,
    // not Phase 3's) -- verified empirically via git show dbe3045:src/mini.js
    // (the commit immediately preceding Phase 3's mini.js rewrite): the
    // getMiniMode()===true assertion alone is GREEN even against that older
    // mini.js, so it does not by itself discriminate this batch's changes.
    // What Phase 3 actually fixes is what happens AFTER checkMiniModeSnap()
    // triggers: pre-Phase 3, enterMiniMode()'s drag-path per-frame writes
    // (animateWindowX) called ctx.win.setBounds() directly, bypassing
    // applyPetWindowBounds() entirely -- so lastLogicalBounds was never
    // updated by that animation, leaving getPetWindowBounds() stale after
    // mini settles instead of reporting the correct calcMiniX() rest
    // position. That's the assertion below that is genuinely red pre-Phase-3
    // (confirmed via the same git-show extraction: stale logical X, not a
    // thrown TypeError).
    const h = createEdgeVirtualizationHarness();

    runDrag(h, {
      startBounds: { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      startCursor: { x: 100, y: 100 },
      endCursor: { x: 840, y: 100 }, // +740 logical -> target 1740, past the 1738 snap threshold
    });

    assert.equal(h.getCheckMiniModeSnapCalls(), 1, "checkMiniModeSnap() must be reached exactly once by drag-end");
    assert.equal(h.mini.getMiniMode(), true, "logical X=1740 (>=1738) must trigger mini mode post-fix");

    // Let the drag-triggered mini-enter animation (100ms slide + mini-enter
    // SVG + MINI_ENTER_FALLBACK_MS settle, since this fixture registers no
    // mini-enter state file) fully complete.
    for (let i = 0; i < 40; i++) mock.timers.tick(100);

    assert.equal(
      h.runtime.getPetWindowBounds().x, 1816,
      "logical X must settle at calcMiniX()'s resting position, not a stale pre-entry value"
    );
    assert.equal(h.renderWin.bounds.x, ISSUE_690_MUTTER_MAX_X, "physical window stays Mutter-safe at 1717");
    h.dispose();
  });

  it("task item 7b: enterMiniViaMenu() settles logical X=1816 while physical stays Mutter-clamped at 1717", () => {
    // §4.6 / §5 Phase 0 point 5's exact number: calcMiniX() for a 203px-wide
    // window against this 1920-wide workArea with offsetRatio=0.486 is
    // 1920 - round(203*(1-0.486)) = 1920 - 104 = 1816.
    const h = createEdgeVirtualizationHarness({ miniTheme: makeMiniTheme(0.486) });
    h.runtime.applyPetWindowBounds(
      { x: 1600, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );

    h.mini.enterMiniViaMenu();
    // Crabwalk (walkDist/CRABWALK_SPEED) -> scheduled enterMiniMode() handoff
    // (+50ms) -> parabola jump (JUMP_DURATION=350) -> preload delay
    // (MINI_ENTER_PRELOAD_MS=300) -> finishMiniEntry's settle (falls back to
    // MINI_ENTER_FALLBACK_MS=3200 since this fixture's theme registers no
    // mini-enter state file). ~1400+50+350+300+3200 =~5300ms total.
    //
    // Ticked in small increments rather than one large mock.timers.tick(6000):
    // a single big jump advances the mocked Date.now() before any of the
    // newly-due callbacks run, so animateWindowParabola's very first frame
    // sees t=1 immediately (skips straight to the end of the 350ms parabola
    // on its first callback) instead of interpolating — the settle chain
    // that follows doesn't unwind the same way. test/mini.test.js's own
    // tests independently discovered the same thing (they always tick in
    // several phase-sized steps, never one large jump); this reproduces that
    // pattern with plain fixed-size increments instead of phase-exact ones.
    for (let i = 0; i < 60; i++) mock.timers.tick(100);

    assert.equal(h.runtime.getPetWindowBounds().x, 1816, "logical X must settle at calcMiniX()'s resting position");
    assert.equal(h.renderWin.bounds.x, ISSUE_690_MUTTER_MAX_X, "physical window must stay Mutter-safe at 1717");
    assert.equal(h.mini.getMiniMode(), true);
    assert.equal(h.mini.getMiniTransitioning(), false, "the settle timer must have fully completed");
    h.dispose();
  });

  // Coordinator-directed follow-up fix: a literal fully-off-screen jump
  // target (window's near edge exactly flush with the outer screen
  // boundary) materializes to |offsetX| === width on Linux, which used to
  // trip pet-window-runtime.js's I2 legal-domain backstop
  // (guardOffsetXLegalDomain: the legal domain is the OPEN interval
  // (-width, +width), so exactly ±width is illegal) mid-jump — not a
  // harmless log, but a visible one-frame flash of the character snapping
  // onto the physical screen edge (offset slammed to 0, logical bounds
  // reset to the clamped physical position) before the later preload/settle
  // frame corrected it. mini.js now shrinks the non-adjacent jump target by
  // 1px so the materialized |offsetX| is width-1, inside the open interval.
  it("via-menu non-adjacent entry never trips the I2 offset-out-of-range backstop across the full sequence", () => {
    const h = createEdgeVirtualizationHarness({ miniTheme: makeMiniTheme(0.486) });
    h.runtime.applyPetWindowBounds(
      { x: 1600, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );

    h.mini.enterMiniViaMenu();
    for (let i = 0; i < 60; i++) mock.timers.tick(100); // full crabwalk -> jump -> preload -> settle, see task item 7b above

    assert.ok(
      !h.edgeLogs.some((line) => line.includes("edge-offset-out-of-range")),
      `expected no edge-offset-out-of-range log across the whole entry; got: ${JSON.stringify(h.edgeLogs)}`
    );
    assert.equal(h.mini.getMiniMode(), true);
    assert.equal(h.mini.getMiniTransitioning(), false, "the settle timer must have fully completed");
    h.dispose();
  });

  // Ticks in small steps and returns true as soon as `mini`'s own
  // isAnimating flag transitions true -> false — i.e. exactly when the jump
  // parabola's last frame has landed and its onDone has run synchronously,
  // but strictly BEFORE the later MINI_ENTER_PRELOAD_MS-delayed settle write
  // moves things on to the resting mini position. This is deliberately NOT
  // "poll until getPetWindowBounds().x equals the expected jump target":
  // with the pre-fix (unshrunk) target, the interpolation's rounding passes
  // through width-1 (1919/-202) as a transient mid-flight value on its way
  // to the real (buggy) target, which would make an x-value-based poll
  // false-pass even without the fix — confirmed empirically while writing
  // this test.
  function tickUntilJumpAnimationEnds(mini, maxSteps = 60, stepMs = 10) {
    let prevAnimating = mini.getIsAnimating();
    for (let i = 0; i < maxSteps; i++) {
      mock.timers.tick(stepMs);
      const nowAnimating = mini.getIsAnimating();
      if (prevAnimating && !nowAnimating) return true;
      prevAnimating = nowAnimating;
    }
    return false;
  }

  it("the fly-off jump frame materializes within I2's open legal domain instead of resetting logical bounds (right edge, non-adjacent)", () => {
    const h = createEdgeVirtualizationHarness();
    h.runtime.applyPetWindowBounds(
      { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );

    h.mini.enterMiniMode(ISSUE_690_WORK_AREA, true, "right");
    assert.ok(
      tickUntilJumpAnimationEnds(h.mini),
      "the jump animation must complete (isAnimating true -> false) within the polling budget"
    );

    // maxRight - 1 = 1920 - 1 = 1919 for this fixture's 1920-wide single
    // display; offsetX = logical(1919) - physical(1717, Mutter-clamped) = 202.
    assert.equal(h.runtime.getPetWindowBounds().x, 1919, "logical bounds must land on the shrunk jump target, not be reset by the I2 backstop");
    assert.equal(h.runtime.getViewportOffsetX(), 202, "offsetX must be width-1 (203-1=202), inside I2's open (-203,+203) interval");
    assert.ok(
      !h.edgeLogs.some((line) => line.includes("edge-offset-out-of-range")),
      `the legal-domain backstop must not fire during the fly-off jump; got: ${JSON.stringify(h.edgeLogs)}`
    );
    h.dispose();
  });

  it("the fly-off jump frame materializes within I2's open legal domain instead of resetting logical bounds (left edge, non-adjacent)", () => {
    const h = createEdgeVirtualizationHarness();
    h.runtime.applyPetWindowBounds(
      { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );

    h.mini.enterMiniMode(ISSUE_690_WORK_AREA, true, "left");
    assert.ok(
      tickUntilJumpAnimationEnds(h.mini),
      "the jump animation must complete (isAnimating true -> false) within the polling budget"
    );

    // Shrunk left jump target: minLeft - size.width + 1 = 0 - 203 + 1 = -202.
    // Mutter's require_fully_onscreen clamps negative X to 0 symmetrically
    // (see makeMutterClampedWindow above); offsetX = logical(-202) - physical(0) = -202.
    assert.equal(h.runtime.getPetWindowBounds().x, -202, "logical bounds must land on the shrunk jump target, not be reset by the I2 backstop");
    assert.equal(h.runtime.getViewportOffsetX(), -202, "offsetX must be -(width-1) = -202, inside I2's open (-203,+203) interval");
    assert.ok(
      !h.edgeLogs.some((line) => line.includes("edge-offset-out-of-range")),
      `the legal-domain backstop must not fire during the fly-off jump; got: ${JSON.stringify(h.edgeLogs)}`
    );
    h.dispose();
  });

  // Coordinator-directed scope expansion (batch 3 follow-up): handleDisplayAdded()/
  // handleDisplayRemoved() had the exact same shape of gap
  // handleDisplayMetricsChanged() had before this batch — silently dropping a
  // topology change that lands mid-mini-transition instead of deferring it.
  // Wired the same way: notifyMiniTopologyChangedDuringTransition() ->
  // pendingTopologyMaterialize -> consumed exactly once at whichever of
  // mini's own three transition-end points comes next.
  it("handleDisplayAdded() during mini transitioning defers via pendingTopologyMaterialize and re-materializes against the NEW (wider) topology once settled", () => {
    const h = createEdgeVirtualizationHarness();
    h.runtime.applyPetWindowBounds(
      { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );

    h.mini.enterMiniMode(ISSUE_690_WORK_AREA, false, "right"); // drag path
    assert.equal(h.mini.getMiniTransitioning(), true);

    // Past the 100ms slide, still well inside the long settle (no mini-enter
    // state file registered in this fixture, so it falls back to
    // MINI_ENTER_FALLBACK_MS=3200).
    mock.timers.tick(150);
    assert.equal(h.mini.getMiniTransitioning(), true, "still mid-transition");
    const beforeSettle = h.runtime.getPetWindowBounds().x;

    // A display gets added mid-transition, widening the effective workArea.
    const widerWorkArea = { x: 0, y: 0, width: 2400, height: 1080 };
    h.setTopology({
      displays: [{ id: 1, bounds: widerWorkArea, workArea: widerWorkArea }],
      workArea: widerWorkArea,
    });
    h.runtime.handleDisplayAdded();

    // Deferred, not dropped and not applied yet — still transitioning.
    assert.equal(h.mini.getMiniTransitioning(), true, "must still be deferred, not consumed synchronously");

    for (let i = 0; i < 40 && h.mini.getMiniTransitioning(); i++) mock.timers.tick(100);
    assert.equal(h.mini.getMiniTransitioning(), false, "the settle timer must have fully completed");

    // calcMiniX() against the NEW (wider) workArea: 2400 - round(203*(1-0.486)) = 2296.
    assert.equal(
      h.runtime.getPetWindowBounds().x, 2296,
      "the deferred topology change must be consumed exactly once at settle, re-materializing against the NEW workArea"
    );
    assert.notEqual(beforeSettle, 2296, "sanity: the position actually changed once the deferred topology was consumed");
    h.dispose();
  });

  it("handleDisplayRemoved() during mini transitioning defers via pendingTopologyMaterialize and re-materializes against the NEW (narrower) topology once settled, without exiting mini early", () => {
    const widerWorkArea = { x: 0, y: 0, width: 2400, height: 1080 };
    const h = createEdgeVirtualizationHarness({
      displays: [{ id: 1, bounds: widerWorkArea, workArea: widerWorkArea }],
      workArea: widerWorkArea,
    });
    h.runtime.applyPetWindowBounds(
      { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );

    h.mini.enterMiniMode(widerWorkArea, false, "right"); // drag path
    assert.equal(h.mini.getMiniTransitioning(), true);
    mock.timers.tick(150);
    assert.equal(h.mini.getMiniTransitioning(), true, "still mid-transition");

    // A display goes away mid-transition, narrowing the effective workArea
    // back down to the standard single-display fixture.
    h.setTopology({ displays: ISSUE_690_DISPLAYS, workArea: ISSUE_690_WORK_AREA });
    h.runtime.handleDisplayRemoved();

    assert.equal(h.mini.getMiniTransitioning(), true, "must still be deferred, not consumed synchronously");
    assert.equal(h.mini.getMiniMode(), true, "handleDisplayRemoved()'s normal exitMiniMode() must not fire while transitioning");

    for (let i = 0; i < 40 && h.mini.getMiniTransitioning(); i++) mock.timers.tick(100);
    assert.equal(h.mini.getMiniTransitioning(), false, "the settle timer must have fully completed");

    // calcMiniX() against the NEW (narrower) workArea: 1920 - round(203*(1-0.486)) = 1816.
    assert.equal(
      h.runtime.getPetWindowBounds().x, 1816,
      "the deferred topology change must be consumed exactly once at settle, re-materializing against the NEW (narrower) workArea"
    );
    h.dispose();
  });

  // PR #751 rework batch A-5: a late-arriving clamp reaching all the way
  // through the assembled runtime+mini+pet-interaction-ipc chain, not just
  // pet-window-runtime.test.js's own unit-level "classifies a clamp that
  // lands after SETTLE_MS as adopt-clamp" coverage.
  it("a late-arriving clamp (landing after SETTLE_MS, no native event until then) still classifies as adopt-clamp through the full assembled chain, not a rebase ratchet", () => {
    // Unlike makeMutterClampedWindow (which clamps synchronously inside
    // setBounds() and now auto-emits "move"), this plain window mock accepts
    // whatever the runtime asks for immediately with no native event at
    // all — the WM's TRUE (unlearned, 40px) inset-based clamp only reveals
    // itself much later, well past this write's own SETTLE_MS, simulating an
    // async repositioning (e.g. after a compositor round-trip).
    const renderWin = makeWindow({ x: 0, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height });
    const h = createEdgeVirtualizationHarness({ renderWin, getDisableMiniMode: () => true });

    h.runtime.applyPetWindowBounds({
      x: 1768, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height,
    });
    assert.equal(
      renderWin.bounds.x, ISSUE_690_MUTTER_MAX_X,
      "sanity: the runtime's own (inset-less) prediction lands here immediately, no mock-side clamp involved"
    );

    // Past SETTLE_MS(400) with no native event at all yet -- the write's own
    // settle-sweep fires and finds nothing to reconcile (actual still
    // matches the prediction exactly).
    mock.timers.tick(500);

    // The WM's TRUE clamp (a 40px inset the runtime never predicted) finally
    // lands late: 1920-40-203=1677.
    renderWin.bounds = { x: 1677, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height };
    renderWin.emit("move");
    mock.timers.tick(150);

    assert.equal(
      h.runtime.getPetWindowBounds().x, 1768,
      "a late clamp must stay adopt-clamp (logical unchanged at 1768), not ratchet inward via a misclassified rebase"
    );
    h.dispose();
  });

  // PR #751 Codex review #8 (rework batch B-1, P0, highest priority): a
  // reload landing mid-mini-transition (theme-runtime.js's cleanup() call)
  // used to leave miniTransitioning stuck true forever, permanently wedging
  // runReconcile()'s protection-period check — every future reconcile would
  // mark dirty and never actually classify anything again.
  it("B-1 (P0): mini's cleanup() mid-entry (simulating a theme reload) releases the reconcile protection instead of wedging it forever", () => {
    const h = createEdgeVirtualizationHarness({ getDisableMiniMode: () => true });
    h.runtime.applyPetWindowBounds(
      { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );

    h.mini.enterMiniMode(ISSUE_690_WORK_AREA, false, "right"); // drag path
    assert.equal(h.mini.getMiniTransitioning(), true);

    mock.timers.tick(150); // past the 100ms slide; still mid-entry (long settle, no mini-enter state file registered)
    assert.equal(h.mini.getMiniTransitioning(), true, "still mid-transition");

    // Simulate a theme reload tearing mini.js down mid-entry.
    h.mini.cleanup();

    assert.equal(h.mini.getMiniTransitioning(), false, "cleanup() must release the stuck transitioning flag");

    // Prove reconcile genuinely recovers, not just that the flag reads
    // false: an external move must actually get classified (rebased, since
    // it's unexplainable) rather than sitting dirty-but-never-checked
    // forever.
    const beforeX = h.runtime.getPetWindowBounds().x;
    h.renderWin.bounds = { x: 500, y: 600, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height };
    h.renderWin.emit("move");
    mock.timers.tick(500); // past RECONCILE_QUIET_MS and SETTLE_MS

    assert.equal(
      h.runtime.getPetWindowBounds().x, 500,
      "reconcile must have actually classified the external move (rebase), not left it permanently deferred"
    );
    assert.notEqual(beforeX, 500, "sanity: this is a genuine change from wherever entry had left it");
    h.dispose();
  });

  // PR #751 Codex review #10 (rework batch B-5, non-blocking): replaces
  // test/mini.test.js's mock-based "screen.getAllDisplays() <= 1/2" budget
  // assertions with a real-assembly version. Those mock-based tests only
  // ever counted mini.js's OWN resolveMiniTopology() call (src/mini.js
  // ~line 75, already capped at 1/transition since Phase 3) because their
  // ctx.applyPetWindowBounds is a plain mock that never reaches the real
  // pet-window-runtime.js machinery — so they could never have caught the
  // actual bug Codex found: materializeVirtualBounds() ->
  // resolveHorizontalClampBounds() -> findDisplayIdForPoint() is
  // unconditional (runs regardless of whether a providedEdgeContext was
  // threaded through), and syncHitWin() resolves its own clamp bounds too —
  // both used to call the real screen.getAllDisplays() again on every
  // single per-frame applyPetWindowBounds()/syncHitWin() call, all the way
  // through an entire drag + mini-entry animation. This harness tracks
  // mini.js's own screen and the runtime's own screen as two SEPARATE
  // counters (see createEdgeVirtualizationHarness above) since they are two
  // separate closures in production too — B-5's generation cache only
  // touches the runtime's side.
  it("B-5 (Codex #10): a full drag + mini-entry animation causes at most 1 real screen.getAllDisplays() call from the runtime's own internal enumeration, not one per frame", () => {
    const h = createEdgeVirtualizationHarness();

    runDrag(h, {
      startBounds: { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      startCursor: { x: 100, y: 100 },
      endCursor: { x: 840, y: 100 }, // +740 logical -> target 1740, past the 1738 snap threshold (same as task item 7a)
    });
    assert.equal(h.mini.getMiniMode(), true, "sanity: this drag must actually trigger mini mode");

    // Full entry animation settle, same budget as task item 7a.
    for (let i = 0; i < 40; i++) mock.timers.tick(100);

    assert.ok(
      h.getRuntimeGetAllDisplaysCallCount() <= 1,
      `expected the runtime's OWN internal enumeration (findDisplayIdForPoint/resolveHorizontalClampBounds via every per-frame applyPetWindowBounds, plus syncHitWin() during the drag) to collapse to <=1 real screen.getAllDisplays() call across the whole drag + entry animation, got ${h.getRuntimeGetAllDisplaysCallCount()}`
    );
    // Not a B-5 claim (Phase 3 already achieved this) — included so this
    // real-assembly test fully subsumes what the old mock-based mini.test.js
    // assertion covered, instead of only replacing part of it. Bound is 2,
    // not 1, here: unlike the old mock test (which called enterMiniMode()
    // directly, in isolation), this test drives the real drag-end IPC, so
    // it also exercises checkMiniModeSnap()'s OWN direct screen.getAllDisplays()
    // call (src/mini.js:400, deciding WHICH display/edge to snap to) BEFORE
    // it hands off to enterMiniMode() -> resolveMiniTopology()'s separate
    // call (src/mini.js:75, resolving the transition's own topology) — two
    // independent, legitimate, pre-existing call sites for two different
    // concerns, same reasoning as the "via-menu" test's own <=2 bound above
    // (crabwalk + mini handoff), not a regression.
    assert.ok(
      h.getMiniGetAllDisplaysCallCount() <= 2,
      `expected mini.js's own call sites (checkMiniModeSnap's snap-decision + enterMiniMode's resolveMiniTopology, unrelated to B-5) to stay at <=2 calls for the whole transition, got ${h.getMiniGetAllDisplaysCallCount()}`
    );
    h.dispose();
  });

  // PR #751 Codex review #12 (rework batch B-8, non-blocking): src/main.js
  // wires the exact same underlying repositionSessionHud() function to both
  // mini.js's ctx and pet-window-runtime.js's own options (see this
  // harness's countedRepositionSessionHud, wired the same way). Per frame,
  // TWO calls are legitimate and NOT duplicates of each other: the runtime's
  // applyPetWindowBounds() (the render window moved) and its syncHitWin()
  // (the hit window's geometry was resynced) each have their own tail-end
  // repositionSessionHud() call — two different windows, two independent
  // reasons. mini's per-frame step called ctx.syncHitWin() (getting that
  // legitimate second call) AND THEN called repositionSessionHud() a THIRD
  // time directly, itself — a genuine duplicate of the first call, not a
  // third legitimate reason. This test proves the count is back down to the
  // 2 legitimate calls, not 3. Neither test/mini.test.js's mock ctx (whose
  // applyPetWindowBounds/syncHitWin never reach the real runtime, so it can
  // only ever see mini's OWN direct call) nor the pre-B-8 version of this
  // harness (which never wired repositionSessionHud into miniCtx at all)
  // could see this — this is the first assembly wiring both sides to the
  // SAME counted function, matching src/main.js's real identity.
  it("B-8 (non-blocking): one mini animation frame triggers repositionSessionHud() exactly twice (render write + hit resync), not three times", () => {
    const h = createEdgeVirtualizationHarness({ getDisableMiniMode: () => true });
    h.runtime.applyPetWindowBounds(
      { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );

    // Snapshot AFTER the initial forced placement (its own legitimate,
    // separate reposition call) but BEFORE entering mini mode. Deliberately
    // NOT advancing any mock timers around this call: animateWindowX() (the
    // drag-path entry's slide) runs its first step() SYNCHRONOUSLY inside
    // enterMiniMode() itself (see src/mini.js's animateWindowX, which calls
    // step() directly, not just schedules it) — so this single call already
    // produces exactly one applyMiniFrameBounds() write (and one syncHitWin()
    // call), with zero elapsed time. That keeps this test clear of
    // reconcile's OWN independent settle-sweep/rebase timers (100ms+ delays),
    // which can also legitimately call runtime.applyPetWindowBounds() (and
    // therefore repositionSessionHud()) on a longer real-clock run — a
    // genuinely separate concern from this per-frame duplicate, not
    // something this test needs to account for.
    const reposBefore = h.getRepositionSessionHudCallCount();
    const writesBefore = h.getMiniApplyPetWindowBoundsCallCount();

    h.mini.enterMiniMode(ISSUE_690_WORK_AREA, false, "right"); // drag path
    assert.equal(h.mini.getMiniTransitioning(), true, "sanity: this must actually start a mini transition");

    const writesDuring = h.getMiniApplyPetWindowBoundsCallCount() - writesBefore;
    const reposDuring = h.getRepositionSessionHudCallCount() - reposBefore;
    assert.equal(writesDuring, 1, "sanity: enterMiniMode's first animation frame runs synchronously, exactly once, before any tick");
    assert.equal(
      reposDuring, 2,
      `expected exactly 2 repositionSessionHud() calls for this one animation frame (applyPetWindowBounds's own tail end + syncHitWin's own tail end — two legitimate, different-window reasons), not a 3rd duplicate from mini.js itself; got ${reposDuring}`
    );
    h.dispose();
  });

  // C-5 (Codex B5): reproduces the coordinator's own scenario shape (a
  // display-added event landing mid-peek must defer, and the peek's own
  // exit must consume the deferred topology change) — using this harness's
  // own numbers rather than assuming the coordinator's exact figures came
  // from an identical fixture (the coordinator's own "1791/2371" pair
  // didn't reproduce with this fixture's calcMiniX inputs
  // (MINI_OFFSET_RATIO=0.486, width=203) on the first attempt, landing on
  // 1816/2396 instead — verified empirically before finalizing these
  // assertions, same discipline as every other test this batch).
  //
  // PR #751 second-review C-5b (coordinator refinement after C-5): the
  // FIRST version of this test asserted 2396 (the resting position) here —
  // the coordinator's own follow-up ruling identified that as the actual
  // bug, not a paraphrase error: 2371 IS the correct peeked-position target
  // (2396 - PEEK_OFFSET(25)), and landing at the bare resting position
  // instead silently un-peeks for a full cycle. This assertion is now 2371,
  // matching the coordinator's ORIGINAL cited number exactly once
  // miniPeekIn()'s own consumeTopologyForMiniPeekIn() (C-5b) is in effect —
  // confirming the coordinator's diagnosis was precise.
  it("C-5/C-5b: a display-added event landing mid-peekIn defers instead of reflowing against the stale topology, and the peek's own exit consumes it while preserving the peeked (not resting) position", () => {
    const h = createEdgeVirtualizationHarness({ getDisableMiniMode: () => true, activeTheme: HUD_ANCHOR_TEST_THEME });
    h.runtime.applyPetWindowBounds(
      { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );
    h.mini.enterMiniMode(ISSUE_690_WORK_AREA, false, "right"); // drag path
    for (let i = 0; i < 40; i++) mock.timers.tick(100); // full entry settle
    assert.equal(h.runtime.getPetWindowBounds().x, 1816, "sanity: settled in mini mode against the original 1920-wide workArea");

    h.mini.miniPeekIn(); // a genuine ~200ms slide away from the resting position
    assert.equal(h.mini.getIsAnimating(), true, "sanity: peek is a real, in-flight animation");
    mock.timers.tick(50); // mid-peek, still animating

    // A display is added, widening the workArea from 1920 to 2500 — landing
    // WHILE the peek's own write is still in flight.
    h.setTopology({ workArea: { x: 0, y: 0, width: 2500, height: 1080 } });
    h.runtime.handleDisplayAdded();

    mock.timers.tick(300); // past the peek's own 200ms — it settles and exits

    assert.equal(
      h.runtime.getPetWindowBounds().x, 2371,
      "miniPeekIn()'s own exit must consume the deferred topology change AND preserve peek semantics: the new resting position (2396) plus the SAME peek offset (-25, right edge) miniPeekIn() itself used to get there — not the bare resting position, which would silently un-peek for a full cycle"
    );

    // D-2 (Codex non-blocking, this batch): with the Mutter mock's own
    // clamp boundary now tied to the SAME mutable workArea setTopology()
    // just changed (previously hardcoded to the ORIGINAL 1920-wide
    // topology, so it could never have proven any of this), verify the
    // physical render window, the hit window, and the session HUD anchor
    // all actually settle consistently against the NEW topology too — not
    // just the software's own logical bookkeeping.
    //
    // Physical render is 2297, NOT 2371 (verified empirically, not assumed
    // from the coordinator's own framing) — and this is CORRECT, not a
    // bug: 2371 + width(203) = 2574 exceeds the new 2500-wide screen by
    // 74px, so a REAL physical window genuinely cannot sit there fully
    // onscreen. 2297 is exactly the new Mutter-safe boundary
    // (2500 - 203), with the 74px gap to the peeked logical position
    // (2371) bridged by viewportOffsetX — the composite-only virtualization
    // #690 exists to provide. Hit window and the HUD anchor both track the
    // LOGICAL/peeked position (2371) instead, which is what the
    // coordinator's own "collapses to 2371" framing describes correctly.
    assert.equal(h.renderWin.getBounds().x, 2297, "physical render window must be Mutter-safe against the NEW (2500-wide) topology: 2500-203, not the stale 1920-wide boundary's 1717-equivalent");
    assert.equal(h.runtime.getViewportOffsetX(), 74, "the logical(2371)/physical(2297) gap must be bridged by viewportOffsetX, not left inconsistent");
    assert.equal(h.hitWin.getBounds().x, 2371, "hit window must track the peeked LOGICAL position against the NEW topology");
    assert.equal(
      h.runtime.getSessionHudAnchorRect(h.runtime.getPetWindowBounds()).left, 2371,
      "the session HUD anchor, recomputed from the current logical bounds, must also converge on the peeked position against the NEW topology"
    );
    h.dispose();
  });

  // C-5b's other half: miniPeekOut()'s own exit is headed BACK to rest in
  // the first place, so consuming a deferred topology change there through
  // the plain consumeTopologyForMiniRest() (landing at the resting
  // position) is already correct — no C-5b-style peek-offset adjustment
  // needed. This is the coordinator-required "confirm the existing behavior
  // is right" companion assertion, not a new fix.
  it("C-5b companion: a display-added event landing mid-peekOut still lands at the new resting position (already correct, no C-5b adjustment needed)", () => {
    const h = createEdgeVirtualizationHarness({ getDisableMiniMode: () => true });
    h.runtime.applyPetWindowBounds(
      { x: 1000, y: 721, width: ISSUE_690_WINDOW_SIZE.width, height: ISSUE_690_WINDOW_SIZE.height },
      { force: true }
    );
    h.mini.enterMiniMode(ISSUE_690_WORK_AREA, false, "right"); // drag path
    for (let i = 0; i < 40; i++) mock.timers.tick(100); // full entry settle
    assert.equal(h.runtime.getPetWindowBounds().x, 1816, "sanity: settled in mini mode against the original 1920-wide workArea");

    // Peek in first (instant settle, well clear of the topology event
    // below), then peek OUT -- a genuine slide back toward the resting
    // position, which is what this test needs to interrupt mid-flight.
    h.mini.miniPeekIn();
    mock.timers.tick(300);
    assert.equal(h.mini.getIsAnimating(), false, "sanity: peek-in settled first");

    h.mini.miniPeekOut();
    assert.equal(h.mini.getIsAnimating(), true, "sanity: peek-out is a real, in-flight animation");
    mock.timers.tick(50); // mid-peek-out, still animating

    h.setTopology({ workArea: { x: 0, y: 0, width: 2500, height: 1080 } });
    h.runtime.handleDisplayAdded();

    mock.timers.tick(300); // past the peek-out's own 200ms -- it settles and exits

    assert.equal(
      h.runtime.getPetWindowBounds().x, 2396,
      "miniPeekOut()'s own exit must consume the deferred topology change and land at the NEW resting position — correct as-is, no peek-offset adjustment needed since peek-out is already headed to rest"
    );
    h.dispose();
  });
});
