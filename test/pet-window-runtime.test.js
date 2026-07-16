"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const createPetWindowRuntime = require("../src/pet-window-runtime");

const SRC_DIR = path.join(__dirname, "..", "src");

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

function makeBrowserWindow(instances) {
  return function FakeBrowserWindow(options) {
    const win = makeWindow({
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height,
    });
    win.options = options;
    instances.push(win);
    return win;
  };
}

function createRuntime(overrides = {}) {
  const calls = [];
  let renderWin = overrides.renderWin || makeWindow();
  let hitWin = overrides.hitWin || makeWindow();
  const displays = overrides.displays || [{
    id: 1,
    bounds: { x: 0, y: 0, width: 1000, height: 800 },
    workArea: { x: 0, y: 0, width: 1000, height: 760 },
  }];
  const runtime = createPetWindowRuntime({
    screen: {
      getAllDisplays: () => displays,
      getCursorScreenPoint: () => (
        typeof overrides.cursor === "function"
          ? overrides.cursor()
          : (overrides.cursor || { x: 100, y: 100 })
      ),
      getDisplayNearestPoint: () => displays[0],
      getPrimaryDisplay: () => displays[0],
    },
    isWin: overrides.isWin ?? true,
    isMac: overrides.isMac ?? false,
    isLinux: overrides.isLinux ?? false,
    linuxWindowType: "toolbar",
    topmostLevel: "pop-up-menu",
    getRenderWindow: () => renderWin,
    getHitWindow: () => hitWin,
    getSettingsWindow: () => overrides.settingsWindow || null,
    getActiveTheme: () => overrides.theme || null,
    getCurrentState: () => "idle",
    getCurrentSvg: () => "idle.svg",
    getCurrentHitBox: () => overrides.hitBox || null,
    getMiniMode: () => overrides.miniMode || false,
    getMiniTransitioning: () => overrides.miniTransitioning || false,
    getMiniContainedSeam: () => overrides.miniContainedSeam || null,
    getMiniPeekOffset: () => 0,
    getCurrentPixelSize: () => overrides.currentPixelSize || { width: 100, height: 100 },
    getEffectiveCurrentPixelSize: () => overrides.effectivePixelSize || { width: 100, height: 100 },
    getKeepSizeAcrossDisplays: () => overrides.keepSizeAcrossDisplays || false,
    getAllowEdgePinning: () => overrides.allowEdgePinning || false,
    isProportionalMode: () => overrides.proportional || false,
    getPrimaryWorkAreaSafe: () => displays[0].workArea,
    getNearestWorkArea: () => displays[0].workArea,
    sendToRenderer: (...args) => calls.push(["sendToRenderer", ...args]),
    keepOutOfTaskbar: (win) => calls.push(["keepOutOfTaskbar", win]),
    repositionSessionHud: () => calls.push(["repositionSessionHud"]),
    repositionAnchoredSurfaces: () => calls.push(["repositionAnchoredSurfaces"]),
    repositionFloatingBubbles: () => calls.push(["repositionFloatingBubbles"]),
    showFloatingSurfacesForPet: () => calls.push(["showFloatingSurfacesForPet"]),
    hideFloatingSurfacesForPet: () => calls.push(["hideFloatingSurfacesForPet"]),
    syncSessionHudVisibilityAndBubbles: () => calls.push(["syncSessionHudVisibilityAndBubbles"]),
    syncPermissionShortcuts: () => calls.push(["syncPermissionShortcuts"]),
    buildTrayMenu: () => calls.push(["buildTrayMenu"]),
    buildContextMenu: () => calls.push(["buildContextMenu"]),
    reapplyMacVisibility: () => calls.push(["reapplyMacVisibility"]),
    ...(overrides.syncImeEditingPetDodge
      ? { syncImeEditingPetDodge: overrides.syncImeEditingPetDodge }
      : {}),
    reassertWinTopmost: () => calls.push(["reassertWinTopmost"]),
    scheduleHwndRecovery: () => calls.push(["scheduleHwndRecovery"]),
    ...(overrides.cloakInspector ? { cloakInspector: overrides.cloakInspector } : {}),
    ...(overrides.isMiniAnimating ? { isMiniAnimating: overrides.isMiniAnimating } : {}),
    ...(overrides.now ? { now: overrides.now } : {}),
    isNearWorkAreaEdge: () => overrides.nearEdge || false,
    flushRuntimeStateToPrefs: () => calls.push(["flushRuntimeStateToPrefs"]),
    handleMiniDisplayChange: () => calls.push(["handleMiniDisplayChange"]),
    exitMiniMode: () => calls.push(["exitMiniMode"]),
    crashReloadLimit: overrides.crashReloadLimit,
    crashReloadWindowMs: overrides.crashReloadWindowMs,
    crashReloadLog: overrides.crashReloadLog,
    now: overrides.now,
  });
  return {
    runtime,
    calls,
    get renderWin() { return renderWin; },
    get hitWin() { return hitWin; },
    setRenderWin: (win) => { renderWin = win; },
    setHitWin: (win) => { hitWin = win; },
  };
}

describe("pet-window-runtime", () => {
  it("keeps context menu owner creation outside the pet runtime and preserves parent ownership", () => {
    const runtimeSource = fs.readFileSync(path.join(SRC_DIR, "pet-window-runtime.js"), "utf8");
    const menuSource = fs.readFileSync(path.join(SRC_DIR, "menu.js"), "utf8");

    assert.ok(!runtimeSource.includes("contextMenuOwner"));
    assert.match(menuSource, /parent:\s*ctx\.win/);
  });

  it("lazy-binds topmost edge helpers so main can initialize the pet runtime first", () => {
    const mainSource = fs.readFileSync(path.join(SRC_DIR, "main.js"), "utf8");
    const start = mainSource.indexOf("const petWindowRuntime = createPetWindowRuntime({");
    const end = mainSource.indexOf("\n});", start);
    const petRuntimeOptions = mainSource.slice(start, end);

    assert.ok(start >= 0 && end > start);
    assert.match(petRuntimeOptions, /isNearWorkAreaEdge:\s*\(bounds\)\s*=>\s*isNearWorkAreaEdge\(bounds\)/);
    assert.doesNotMatch(petRuntimeOptions, /[,{]\s*isNearWorkAreaEdge\s*,/);
  });

  it("creates the hit window with the Windows drag focusability contract", () => {
    const instances = [];
    const harness = createRuntime();
    harness.runtime.createHitWindow({
      BrowserWindow: makeBrowserWindow(instances),
      preloadPath: "preload-hit.js",
      loadFilePath: "hit.html",
      hitThemeConfig: { ok: true },
      guardAlwaysOnTop: (win) => harness.calls.push(["guard", win]),
    });

    assert.equal(instances[0].options.focusable, true);
    assert.deepStrictEqual(instances[0].calls.filter((call) => call[0] === "setIgnoreMouseEvents"), [
      ["setIgnoreMouseEvents", false],
    ]);
    assert.deepStrictEqual(instances[0].calls.find((call) => call[0] === "setAlwaysOnTop"), [
      "setAlwaysOnTop",
      true,
      "pop-up-menu",
    ]);
  });

  it("reloadWindowWebContents ignores destroyed windows and webContents", () => {
    const harness = createRuntime();
    const live = makeWindow();
    const destroyedWindow = makeWindow();
    const destroyedContents = makeWindow();

    destroyedWindow.destroyed = true;
    destroyedContents.webContents.destroyed = true;

    assert.equal(harness.runtime.reloadWindowWebContents(live), true);
    assert.equal(harness.runtime.reloadWindowWebContents(destroyedWindow), false);
    assert.equal(harness.runtime.reloadWindowWebContents(destroyedContents), false);
    assert.deepStrictEqual(live.calls, [["reload"]]);
    assert.deepStrictEqual(destroyedWindow.calls, []);
    assert.deepStrictEqual(destroyedContents.calls, []);
  });

  it("does not reload renderer windows for terminal render-process-gone reasons", () => {
    const logs = [];
    const harness = createRuntime({ crashReloadLog: (message) => logs.push(message) });
    const live = makeWindow();

    assert.equal(harness.runtime.reloadWindowWebContents(live, {
      crashKey: "renderWin",
      details: { reason: "integrity-failure" },
    }), false);
    assert.deepStrictEqual(live.calls, []);
    assert.match(logs[0], /not reloading renderWin/);
  });

  it("stops reloading renderer windows after repeated crashes in the guard window", () => {
    let now = 1000;
    const logs = [];
    const harness = createRuntime({
      crashReloadLimit: 2,
      crashReloadWindowMs: 1000,
      crashReloadLog: (message) => logs.push(message),
      now: () => now,
    });
    const live = makeWindow();
    const options = { crashKey: "hitWin", details: { reason: "crashed" } };

    assert.equal(harness.runtime.reloadWindowWebContents(live, options), true);
    now += 100;
    assert.equal(harness.runtime.reloadWindowWebContents(live, options), true);
    now += 100;
    assert.equal(harness.runtime.reloadWindowWebContents(live, options), false);
    assert.deepStrictEqual(live.calls, [["reload"], ["reload"]]);
    assert.match(logs[0], /stopped reloading hitWin/);

    now += 1001;
    assert.equal(harness.runtime.reloadWindowWebContents(live, options), true);
    assert.deepStrictEqual(live.calls, [["reload"], ["reload"], ["reload"]]);
  });

  it("uses safe reload helpers for pet render-process-gone handlers", () => {
    const runtimeSource = fs.readFileSync(path.join(SRC_DIR, "pet-window-runtime.js"), "utf8");
    const mainSource = fs.readFileSync(path.join(SRC_DIR, "main.js"), "utf8");

    assert.ok(runtimeSource.includes('reloadRuntimeWindowWebContents(hitWin, { crashKey: "hitWin", details });'));
    assert.ok(mainSource.includes('petWindowRuntime.reloadWindowWebContents(ownedHitWin, { crashKey: "hitWin", details });'));
    assert.ok(mainSource.includes('petWindowRuntime.reloadWindowWebContents(win, { crashKey: "renderWin", details });'));
    assert.doesNotMatch(mainSource, /ownedHitWin\.webContents\.reload\(\)/);
  });

  it("creates the render window as non-focusable and materializes the initial virtual bounds", () => {
    const instances = [];
    const harness = createRuntime();

    harness.runtime.createRenderWindow({
      BrowserWindow: makeBrowserWindow(instances),
      size: { width: 120, height: 120 },
      initialWindowBounds: { x: 40, y: 0, width: 120, height: 120 },
      initialVirtualBounds: { x: 40, y: -25, width: 120, height: 120 },
      preloadPath: "preload.js",
      loadFilePath: "index.html",
      themeConfig: { ok: true },
      setRenderWindow: harness.setRenderWin,
      isQuitting: () => false,
    });

    assert.deepStrictEqual(instances[0].calls.filter((call) => call[0] === "setFocusable"), [
      ["setFocusable", false],
    ]);
    assert.deepStrictEqual(instances[0].calls.find((call) => call[0] === "setAlwaysOnTop"), [
      "setAlwaysOnTop",
      true,
      "pop-up-menu",
    ]);
    assert.deepStrictEqual(instances[0].calls.find((call) => call[0] === "setBounds"), [
      "setBounds",
      { x: 40, y: 0, width: 120, height: 120 },
    ]);
    assert.equal(harness.runtime.getViewportOffsetY(), 25);
  });

  it("flushes runtime prefs once during Windows session end", () => {
    const instances = [];
    const harness = createRuntime();

    harness.runtime.createRenderWindow({
      BrowserWindow: makeBrowserWindow(instances),
      size: { width: 120, height: 120 },
      initialWindowBounds: { x: 40, y: 0, width: 120, height: 120 },
      initialVirtualBounds: { x: 40, y: 0, width: 120, height: 120 },
      preloadPath: "preload.js",
      loadFilePath: "index.html",
      themeConfig: { ok: true },
      setRenderWindow: harness.setRenderWin,
      isQuitting: () => false,
    });

    instances[0].emit("query-session-end");
    instances[0].emit("session-end");

    assert.deepStrictEqual(harness.calls.filter((call) => call[0] === "flushRuntimeStateToPrefs"), [
      ["flushRuntimeStateToPrefs"],
    ]);
  });

  it("does not flush runtime prefs for session-end events on non-Windows platforms", () => {
    const instances = [];
    const harness = createRuntime({ isWin: false });

    harness.runtime.createRenderWindow({
      BrowserWindow: makeBrowserWindow(instances),
      size: { width: 120, height: 120 },
      initialWindowBounds: { x: 40, y: 0, width: 120, height: 120 },
      initialVirtualBounds: { x: 40, y: 0, width: 120, height: 120 },
      preloadPath: "preload.js",
      loadFilePath: "index.html",
      themeConfig: { ok: true },
      setRenderWindow: harness.setRenderWin,
      isQuitting: () => false,
    });

    instances[0].emit("query-session-end");
    instances[0].emit("session-end");

    assert.deepStrictEqual(harness.calls.filter((call) => call[0] === "flushRuntimeStateToPrefs"), []);
  });

  it("keeps Linux hit windows non-focusable", () => {
    const instances = [];
    const harness = createRuntime({ isWin: false, isLinux: true });

    harness.runtime.createHitWindow({
      BrowserWindow: makeBrowserWindow(instances),
      preloadPath: "preload-hit.js",
      loadFilePath: "hit.html",
      hitThemeConfig: {},
    });

    assert.equal(instances[0].options.focusable, false);
    assert.equal(instances[0].options.type, "toolbar");
  });

  it("materializes virtual bounds into viewport offset and syncs the hit shape once per size", () => {
    const harness = createRuntime();

    assert.deepStrictEqual(
      harness.runtime.applyPetWindowBounds({ x: 40, y: -25, width: 120, height: 120 }),
      { x: 40, y: 0, width: 120, height: 120 }
    );
    assert.equal(harness.runtime.getViewportOffsetY(), 25);
    harness.runtime.syncHitWin();
    harness.runtime.syncHitWin();

    assert.deepStrictEqual(harness.calls, [
      ["sendToRenderer", "viewport-offset", 25],
      ["repositionSessionHud"],
      ["repositionSessionHud"],
      ["repositionSessionHud"],
    ]);
    assert.deepStrictEqual(harness.hitWin.calls.filter((call) => call[0] === "setShape"), [
      ["setShape", [{ x: 0, y: 0, width: 120, height: 120 }]],
    ]);
  });

  it("does not move the hit window while drag owns pointer capture", () => {
    const harness = createRuntime();

    harness.runtime.setDragLocked(true);
    harness.runtime.syncHitWin();

    assert.deepStrictEqual(harness.hitWin.calls, []);
  });

  it("re-answers the editing overlap after each hit geometry sync (#640)", () => {
    const dodgeSyncs = [];
    const harness = createRuntime({ syncImeEditingPetDodge: () => dodgeSyncs.push(true) });

    harness.runtime.syncHitWin();
    assert.strictEqual(dodgeSyncs.length, 1,
      "hitbox changes without a window move (state switch, theme reload) must re-run the dodge");

    harness.runtime.setDragLocked(true);
    harness.runtime.syncHitWin();
    assert.strictEqual(dodgeSyncs.length, 1,
      "the drag-locked early-return precedes the hook; drag unlock re-runs it via pet-interaction-ipc");
  });

  it("clips the hit window to a right-side internal monitor seam", () => {
    const renderWin = makeWindow({ x: 40, y: 0, width: 120, height: 120 });
    const harness = createRuntime({
      renderWin,
      miniMode: true,
      miniContainedSeam: { boundary: 100, edge: "right" },
    });

    harness.runtime.syncHitWin();

    // Full hit rect [40,160) clipped at the seam → keep the local half [40,100).
    assert.deepStrictEqual(
      harness.hitWin.calls.find((call) => call[0] === "setBounds"),
      ["setBounds", { x: 40, y: 0, width: 60, height: 120 }]
    );
  });

  it("clips the hit window from the left at a left-side internal seam", () => {
    const renderWin = makeWindow({ x: 40, y: 0, width: 120, height: 120 });
    const harness = createRuntime({
      renderWin,
      miniMode: true,
      miniContainedSeam: { boundary: 100, edge: "left" },
    });

    harness.runtime.syncHitWin();

    // Full hit rect [40,160) clipped at the seam → keep the local half [100,160).
    assert.deepStrictEqual(
      harness.hitWin.calls.find((call) => call[0] === "setBounds"),
      ["setBounds", { x: 100, y: 0, width: 60, height: 120 }]
    );
  });

  it("leaves the hit window unclipped when no internal seam is active", () => {
    const renderWin = makeWindow({ x: 40, y: 0, width: 120, height: 120 });
    const harness = createRuntime({ renderWin, miniMode: true });

    harness.runtime.syncHitWin();

    assert.deepStrictEqual(
      harness.hitWin.calls.find((call) => call[0] === "setBounds"),
      ["setBounds", { x: 40, y: 0, width: 120, height: 120 }]
    );
  });

  it("returns the seam-clipped hit rect to hover and bubble callers", () => {
    const harness = createRuntime({
      miniMode: true,
      miniContainedSeam: { boundary: 100, edge: "right" },
    });

    assert.deepStrictEqual(
      harness.runtime.getHitRectScreen({ x: 40, y: 0, width: 120, height: 120 }),
      { left: 40, top: 0, right: 100, bottom: 120 }
    );
  });

  it("reasserts Windows topmost when drag movement lands near a work-area edge", () => {
    let cursor = { x: 100, y: 100 };
    const harness = createRuntime({
      cursor: () => cursor,
      nearEdge: true,
    });

    harness.runtime.setDragLocked(true);
    harness.runtime.beginDragSnapshot();
    cursor = { x: 120, y: 100 };
    harness.runtime.moveWindowForDrag();

    assert.deepStrictEqual(harness.renderWin.calls.filter((call) => call[0] === "setBounds"), [
      ["setBounds", { x: 30, y: 20, width: 100, height: 100 }],
    ]);
    assert.ok(harness.calls.some((call) => call[0] === "reassertWinTopmost"));
    assert.ok(harness.calls.some((call) => call[0] === "repositionAnchoredSurfaces"));
  });

  it("preserves mini transition guards for drag and display changes", () => {
    const harness = createRuntime({ miniTransitioning: true });

    harness.runtime.setDragLocked(true);
    harness.runtime.beginDragSnapshot();
    harness.runtime.moveWindowForDrag();
    harness.runtime.handleDisplayMetricsChanged();
    harness.runtime.handleDisplayRemoved();

    assert.deepStrictEqual(harness.renderWin.calls, []);
    assert.deepStrictEqual(harness.hitWin.calls, []);
    assert.deepStrictEqual(harness.calls, [
      ["reapplyMacVisibility"],
      ["reapplyMacVisibility"],
    ]);
  });

  it("routes mini-mode display changes to mini handlers without writing pet bounds", () => {
    const harness = createRuntime({ miniMode: true });

    harness.runtime.handleDisplayMetricsChanged();
    harness.runtime.handleDisplayRemoved();

    assert.deepStrictEqual(harness.renderWin.calls, []);
    assert.deepStrictEqual(harness.calls, [
      ["reapplyMacVisibility"],
      ["handleMiniDisplayChange"],
      ["reapplyMacVisibility"],
      ["exitMiniMode"],
    ]);
  });

  it("refreshes mini seam state when a display is added", () => {
    const harness = createRuntime({ miniMode: true });

    harness.runtime.handleDisplayAdded();

    assert.deepStrictEqual(harness.renderWin.calls, []);
    assert.deepStrictEqual(harness.calls, [
      ["reapplyMacVisibility"],
      ["handleMiniDisplayChange"],
      ["repositionAnchoredSurfaces"],
    ]);
  });

  it("snaps the pet back to the frozen size when live bounds drift on display-metrics-changed (#408)", () => {
    // Windows sleep/wake can resize the pet without moving it (DPI flux).
    // Even when the clamped position is unchanged, the runtime must re-apply
    // the frozen size — otherwise keepSize silently absorbs the drift.
    const renderWin = makeWindow({ x: 200, y: 100, width: 140, height: 140 });
    const harness = createRuntime({
      renderWin,
      effectivePixelSize: { width: 100, height: 100 },
      currentPixelSize: { width: 100, height: 100 },
      keepSizeAcrossDisplays: true,
      proportional: true,
    });

    harness.runtime.handleDisplayMetricsChanged();

    const setBoundsCalls = renderWin.calls.filter((call) => call[0] === "setBounds");
    assert.equal(setBoundsCalls.length, 1);
    assert.deepEqual(setBoundsCalls[0][1], { x: 200, y: 100, width: 100, height: 100 });
  });

  it("leaves the pet alone when live bounds already match the frozen size and no clamp is needed (#408)", () => {
    // Regression guard for the sizeDrifted branch: in steady state we must
    // not write bounds unnecessarily.
    const renderWin = makeWindow({ x: 200, y: 100, width: 100, height: 100 });
    const harness = createRuntime({
      renderWin,
      effectivePixelSize: { width: 100, height: 100 },
      currentPixelSize: { width: 100, height: 100 },
      keepSizeAcrossDisplays: true,
      proportional: true,
    });

    harness.runtime.handleDisplayMetricsChanged();

    const setBoundsCalls = renderWin.calls.filter((call) => call[0] === "setBounds");
    assert.equal(setBoundsCalls.length, 0);
  });

  it("brings the pet to primary display and flushes runtime prefs", () => {
    const harness = createRuntime({
      effectivePixelSize: { width: 200, height: 160 },
    });

    harness.runtime.bringPetToPrimaryDisplay();

    assert.deepStrictEqual(harness.renderWin.calls[0], [
      "setBounds",
      { x: 400, y: 300, width: 200, height: 160 },
    ]);
    assert.ok(harness.calls.some((call) => call[0] === "repositionFloatingBubbles"));
    assert.ok(harness.calls.some((call) => call[0] === "reassertWinTopmost"));
    assert.ok(harness.calls.some((call) => call[0] === "scheduleHwndRecovery"));
    assert.ok(harness.calls.some((call) => call[0] === "flushRuntimeStateToPrefs"));
  });
});

describe("pet-window-runtime setPetHidden contract (#416)", () => {
  it("hides the pet and reports a real change", () => {
    const h = createRuntime();
    const r = h.runtime.setPetHidden(true);
    assert.deepEqual(r, { applied: true, deferred: false, changed: true });
    assert.equal(h.runtime.isPetHidden(), true);
    assert.ok(h.renderWin.calls.some((c) => c[0] === "hide"));
  });

  it("is idempotent when already in the target state", () => {
    const h = createRuntime();
    h.runtime.setPetHidden(true);
    const before = h.renderWin.calls.length;
    const r = h.runtime.setPetHidden(true);
    assert.deepEqual(r, { applied: true, deferred: false, changed: false });
    assert.equal(h.renderWin.calls.length, before);
  });

  it("shows the pet again", () => {
    const h = createRuntime();
    h.runtime.setPetHidden(true);
    const r = h.runtime.setPetHidden(false);
    assert.deepEqual(r, { applied: true, deferred: false, changed: true });
    assert.equal(h.runtime.isPetHidden(), false);
    assert.ok(h.renderWin.calls.some((c) => c[0] === "showInactive"));
  });

  it("defers without changing state during a mini transition", () => {
    const h = createRuntime({ miniTransitioning: true });
    const r = h.runtime.setPetHidden(true);
    assert.deepEqual(r, { applied: false, deferred: true, changed: false });
    assert.equal(h.runtime.isPetHidden(), false);
  });

  it("reports not-applied when the render window is gone", () => {
    const h = createRuntime();
    h.renderWin.destroyed = true;
    const r = h.runtime.setPetHidden(true);
    assert.deepEqual(r, { applied: false, deferred: false, changed: false });
  });

  it("togglePetVisibility flips state through setPetHidden", () => {
    const h = createRuntime();
    assert.equal(h.runtime.isPetHidden(), false);
    h.runtime.togglePetVisibility();
    assert.equal(h.runtime.isPetHidden(), true);
    h.runtime.togglePetVisibility();
    assert.equal(h.runtime.isPetHidden(), false);
  });
});

// ── #525: DWM cloak self-heal ──
//
// The review of the external cef717d patch (2026-07-16, three independent
// reviewers) blocked a cloak-aware toggle polarity: on a machine whose cloak
// flag reads permanently non-zero (the #496 reporter's machine did, SHELL=2
// while visibly fine), "toggle by actual visibility" degenerates into
// setPetHidden(false) forever — tray/context-menu/shortcut all lose the
// ability to hide. These tests pin the survivors: hide always means hide;
// recovery lives on its own path with guards and backoff.
function makeCloakInspector(overrides = {}) {
  const inspector = {
    calls: [],
    available: overrides.available ?? true,
    // number, or (win) => number for per-window flags (mixed-verdict tests).
    flag: overrides.flag ?? 0,
    // "onCurrent: null" must survive as null (= COM probe down), so ?? is wrong here.
    onCurrent: "onCurrent" in overrides ? overrides.onCurrent : true,
    uncloakClears: overrides.uncloakClears ?? true,
    uncloakResult: overrides.uncloakResult ?? true,
    flagFor(win) {
      return typeof inspector.flag === "function" ? inspector.flag(win) : inspector.flag;
    },
    readCloakState(win) { inspector.calls.push("read"); return inspector.flagFor(win); },
    isOnCurrentVirtualDesktop() { inspector.calls.push("vdesk"); return inspector.onCurrent; },
    uncloak(win) {
      inspector.calls.push("uncloak");
      if (overrides.onUncloak) return overrides.onUncloak(win);
      if (inspector.uncloakClears && typeof inspector.flag !== "function") inspector.flag = 0;
      return inspector.uncloakResult;
    },
    dispose() {},
  };
  return inspector;
}

describe("pet-window-runtime cloak self-heal (#525)", () => {
  it("toggle hides on the FIRST press even when the cloak flag reads permanently non-zero", () => {
    const inspector = makeCloakInspector({ flag: 2, uncloakClears: false });
    const h = createRuntime({ cloakInspector: inspector });
    assert.equal(h.runtime.isPetHidden(), false);
    h.runtime.togglePetVisibility();
    // The blocked external patch returned false here (show-forever). Hide must win.
    assert.equal(h.runtime.isPetHidden(), true);
    h.runtime.togglePetVisibility();
    assert.equal(h.runtime.isPetHidden(), false);
  });

  it("recoverIfCloaked un-cloaks a cloaked window on the current desktop and reports recovered", () => {
    const inspector = makeCloakInspector({ flag: 1, onCurrent: true });
    const h = createRuntime({ cloakInspector: inspector });
    const res = h.runtime.recoverIfCloaked();
    assert.equal(res, "recovered");
    assert.ok(inspector.calls.includes("uncloak"));
    assert.ok(h.calls.some(([name]) => name === "reassertWinTopmost"));
    assert.ok(h.calls.some(([name]) => name === "scheduleHwndRecovery"));
  });

  it("recoverIfCloaked leaves a window parked on another virtual desktop alone", () => {
    const inspector = makeCloakInspector({ flag: 2, onCurrent: false });
    const h = createRuntime({ cloakInspector: inspector });
    const res = h.runtime.recoverIfCloaked();
    assert.equal(res, "clean");
    assert.ok(!inspector.calls.includes("uncloak"));
  });

  it("recoverIfCloaked degrades to APP-only when the virtual-desktop probe is down", () => {
    const shell = makeCloakInspector({ flag: 2, onCurrent: null });
    const hShell = createRuntime({ cloakInspector: shell });
    assert.equal(hShell.runtime.recoverIfCloaked(), "clean");
    assert.ok(!shell.calls.includes("uncloak"));

    const app = makeCloakInspector({ flag: 1, onCurrent: null });
    const hApp = createRuntime({ cloakInspector: app });
    assert.equal(hApp.runtime.recoverIfCloaked(), "recovered");
    assert.ok(app.calls.includes("uncloak"));
  });

  it("recoverIfCloaked guard matrix: hidden/mini/drag/preview each stand down before probing", () => {
    const mkH = (overrides) => {
      const inspector = makeCloakInspector({ flag: 1 });
      return { inspector, h: createRuntime({ cloakInspector: inspector, ...overrides }) };
    };

    const hidden = mkH({});
    hidden.h.runtime.setPetHidden(true);
    hidden.inspector.calls.length = 0;
    assert.equal(hidden.h.runtime.recoverIfCloaked(), "hidden");
    assert.equal(hidden.inspector.calls.length, 0);

    const mini = mkH({ miniTransitioning: true });
    assert.equal(mini.h.runtime.recoverIfCloaked(), "busy");
    assert.equal(mini.inspector.calls.length, 0);

    const anim = mkH({ isMiniAnimating: () => true });
    assert.equal(anim.h.runtime.recoverIfCloaked(), "busy");
    assert.equal(anim.inspector.calls.length, 0);

    const drag = mkH({});
    drag.h.runtime.setDragLocked(true);
    assert.equal(drag.h.runtime.recoverIfCloaked(), "busy");
    assert.equal(drag.inspector.calls.length, 0);

    const preview = mkH({});
    preview.h.runtime.beginSettingsSizePreviewProtection();
    assert.equal(preview.h.runtime.recoverIfCloaked(), "frozen");
    assert.equal(preview.inspector.calls.length, 0);
  });

  it("recoverIfCloaked backs off exponentially after a failed recovery and resets on success", () => {
    let clock = 1_000_000;
    const inspector = makeCloakInspector({ flag: 1, uncloakClears: false });
    const h = createRuntime({ cloakInspector: inspector, now: () => clock });

    assert.equal(h.runtime.recoverIfCloaked(), "failed");
    // Cooldown = 5000 * 2^1 = 10s: immediate retry must be suppressed.
    assert.equal(h.runtime.recoverIfCloaked(), "backoff");
    clock += 9_999;
    assert.equal(h.runtime.recoverIfCloaked(), "backoff");
    clock += 2;
    assert.equal(h.runtime.recoverIfCloaked(), "failed");
    // Second failure doubles the cooldown window (20s).
    clock += 10_001;
    assert.equal(h.runtime.recoverIfCloaked(), "backoff");
    clock += 10_000;
    // Un-cloak starts working: recovery succeeds and the streak resets.
    inspector.uncloakClears = true;
    assert.equal(h.runtime.recoverIfCloaked(), "recovered");
    inspector.flag = 1;
    inspector.uncloakClears = false;
    assert.equal(h.runtime.recoverIfCloaked(), "failed");
    assert.equal(h.runtime.recoverIfCloaked(), "backoff");
  });

  it("recoverIfCloaked reports unavailable without an inspector (non-Windows / FFI down)", () => {
    const none = createRuntime();
    assert.equal(none.runtime.recoverIfCloaked(), "unavailable");
    const down = createRuntime({ cloakInspector: makeCloakInspector({ available: false }) });
    assert.equal(down.runtime.recoverIfCloaked(), "unavailable");
  });

  it("showPetWindows un-cloaks an abnormally cloaked window BEFORE showInactive (order-sensitive)", () => {
    // Shared timeline so the uncloak/showInactive relative order is provable —
    // a swapped implementation must fail this test.
    const timeline = [];
    const renderWin = makeWindow();
    const origShowInactive = renderWin.showInactive;
    renderWin.showInactive = () => { timeline.push("showInactive"); origShowInactive(); };
    const inspector = makeCloakInspector({ flag: 1, onCurrent: true, onUncloak: () => { timeline.push("uncloak"); return true; } });
    const h = createRuntime({ cloakInspector: inspector, renderWin });
    h.runtime.setPetHidden(true);
    timeline.length = 0;
    h.runtime.setPetHidden(false);
    const uncloakIdx = timeline.indexOf("uncloak");
    const showIdx = timeline.indexOf("showInactive");
    assert.ok(uncloakIdx >= 0 && showIdx >= 0);
    assert.ok(uncloakIdx < showIdx, `expected uncloak before showInactive, got ${JSON.stringify(timeline)}`);
  });

  it("recoverIfCloaked fails the round when one window recovers and the other stays cloaked", () => {
    const flags = new Map();
    const renderWin = makeWindow();
    const hitWin = makeWindow();
    flags.set(renderWin, 1); // recovers on uncloak
    flags.set(hitWin, 1);    // stays cloaked forever
    const inspector = makeCloakInspector({
      flag: (win) => flags.get(win) ?? 0,
      onUncloak: (win) => { if (win === renderWin) flags.set(renderWin, 0); return true; },
    });
    const h = createRuntime({ cloakInspector: inspector, renderWin, hitWin });
    assert.equal(h.runtime.recoverIfCloaked(), "failed");
    // Shared cooldown: the healthy window's success must not clear the streak.
    assert.equal(h.runtime.recoverIfCloaked(), "backoff");
  });

  it("recoverIfCloaked does not touch the window when the un-cloak call itself fails (fail-open)", () => {
    const inspector = makeCloakInspector({ flag: 1, uncloakResult: false, uncloakClears: false });
    const renderWin = makeWindow();
    const h = createRuntime({ cloakInspector: inspector, renderWin });
    const before = renderWin.calls.length;
    assert.equal(h.runtime.recoverIfCloaked(), "failed");
    assert.ok(inspector.calls.includes("uncloak"));
    // No showInactive/keepOutOfTaskbar on the window after a failed native call...
    assert.deepStrictEqual(renderWin.calls.slice(before), []);
    assert.ok(!h.calls.some(([name]) => name === "keepOutOfTaskbar"));
    // ...and no global topmost re-assert either — an all-failed round must be
    // a complete no-op on the windows (codex round-3 finding).
    assert.ok(!h.calls.some(([name]) => name === "reassertWinTopmost"));
  });

  it("recoverIfCloaked still re-asserts topmost in a mixed round where one window did recover", () => {
    const flags = new Map();
    const renderWin = makeWindow();
    const hitWin = makeWindow();
    flags.set(renderWin, 1);
    flags.set(hitWin, 1);
    const inspector = makeCloakInspector({
      flag: (win) => flags.get(win) ?? 0,
      onUncloak: (win) => {
        if (win === renderWin) { flags.set(renderWin, 0); return true; }
        return false; // hit window's native un-cloak fails
      },
    });
    const h = createRuntime({ cloakInspector: inspector, renderWin, hitWin });
    assert.equal(h.runtime.recoverIfCloaked(), "failed");
    // The recovered window was shown, so the topmost re-assert must run.
    assert.ok(renderWin.calls.some(([n]) => n === "showInactive"));
    assert.ok(h.calls.some(([name]) => name === "reassertWinTopmost"));
  });

  it("a clean round resets the backoff so the next independent fault starts fresh", () => {
    let clock = 1_000_000;
    const inspector = makeCloakInspector({ flag: 1, uncloakClears: false });
    const h = createRuntime({ cloakInspector: inspector, now: () => clock });

    assert.equal(h.runtime.recoverIfCloaked(), "failed");   // streak=1, cooldown 10s
    clock += 10_001;
    inspector.flag = 0;                                      // fault resolves on its own
    assert.equal(h.runtime.recoverIfCloaked(), "clean");     // must reset the streak
    inspector.flag = 1;                                      // NEW independent fault
    assert.equal(h.runtime.recoverIfCloaked(), "failed");    // streak must restart at 1
    clock += 10_001;                                         // fresh 10s window, not 20s
    assert.equal(h.runtime.recoverIfCloaked(), "failed");
  });
});
