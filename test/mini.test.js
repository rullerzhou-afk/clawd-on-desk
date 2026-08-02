"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");

function cloneTheme(theme) {
  return JSON.parse(JSON.stringify(theme));
}

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

function makeCtx(theme, stateLog, initialX = 160) {
  const bounds = { x: initialX, y: 180, width: 120, height: 120 };
  const applyBoundsCallLog = [];
  return {
    theme,
    currentState: "idle",
    win: {
      getBounds() { return { ...bounds }; },
      setBounds(next) {
        bounds.x = next.x;
        bounds.y = next.y;
        bounds.width = next.width;
        bounds.height = next.height;
      },
      setPosition(x, y) {
        bounds.x = x;
        bounds.y = y;
      },
      isDestroyed() { return false; },
    },
    doNotDisturb: false,
    bubbleFollowPet: false,
    pendingPermissions: [],
    currentSize: "m",
    mouseOverPet: false,
    SIZES: { m: { width: 120, height: 120 } },
    getCurrentPixelSize() { return { width: 120, height: 120 }; },
    getPetWindowBounds() { return { ...bounds }; },
    // Issue #690 Phase 3: mini.js's per-frame/placement writes now go through
    // this instead of raw ctx.win.setBounds()/setPosition(). This harness has
    // no Linux/Mutter clamp model (none of these tests set isLinux or mock a
    // WM clamp — that cross-module scenario lives in
    // test/edge-virtualization.test.js), so physical always equals logical
    // here: write straight into the same `bounds` closure win.getBounds()/
    // getBoundsSnapshot() read, exactly reproducing the old setBounds()
    // behaviour byte-for-byte for every existing assertion.
    applyPetWindowBounds(next, opts) {
      applyBoundsCallLog.push({ next: { ...next }, opts: opts ? { ...opts } : undefined });
      bounds.x = next.x;
      bounds.y = next.y;
      bounds.width = next.width;
      bounds.height = next.height;
      return { ...bounds };
    },
    // Test-only introspection (not part of the real ctx contract) for the
    // §4.5 point 3 / §12.8 automated thresholds: every mini animation frame
    // must go through applyMiniFrameBounds() with assertNoYOffset:true.
    getApplyBoundsCallLog() { return applyBoundsCallLog.map((c) => ({ ...c })); },
    getAnimationAssetCycleMs(file) {
      if (file && file.includes("mini-enter")) return 1000;
      return null;
    },
    getBoundsSnapshot() { return { ...bounds }; },
    setViewportOffsetY() {},
    stopWakePoll() {},
    sendToRenderer() {},
    sendToHitWin() {},
    buildContextMenu() {},
    buildTrayMenu() {},
    syncHitWin() {},
    repositionBubbles() {},
    getNearestWorkArea() { return { x: 0, y: 0, width: 800, height: 600 }; },
    clampToScreenVisual(x, y, width, height) { return { x, y, width, height }; },
    resolveDisplayState() { return "idle"; },
    getSvgOverride() { return null; },
    applyState(state) {
      this.currentState = state;
      stateLog.push(state);
    },
  };
}

describe("mini mode entry timing", () => {
  let loader;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    if (loader) loader.restore();
    mock.timers.reset();
    loader = null;
  });

  it("drag-snap entry slides to mini position first, then plays mini-enter", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    // Start away from the mini position so the 100ms slide is observable.
    const ctx = makeCtx(theme, stateLog, 600);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");

    // After the 100ms window slide: window is at mini position,
    // mini-enter has just been applied, enter animation is playing.
    mock.timers.tick(120);
    assert.deepStrictEqual(stateLog, ["mini-enter"]);
    assert.equal(ctx.getBoundsSnapshot().x, mini.getCurrentMiniX());
    assert.equal(mini.getMiniTransitioning(), true);

    // After the mini-enter animation settles (mocked to 1000ms).
    mock.timers.tick(1020);
    assert.deepStrictEqual(stateLog, ["mini-enter", "mini-idle"]);
    assert.equal(mini.getMiniTransitioning(), false);
    assert.equal(mini.getMiniMode(), true);
  });

  it("via-menu mini handoff preloads mini-enter offscreen before revealing the pet", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    const ctx = makeCtx(theme, stateLog, 710);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, true, "right");
    mock.timers.tick(360);

    assert.deepStrictEqual(stateLog, ["mini-enter"]);
    assert.notEqual(ctx.getBoundsSnapshot().x, mini.getCurrentMiniX());
    assert.equal(mini.getMiniTransitioning(), true);

    mock.timers.tick(300);
    assert.equal(ctx.getBoundsSnapshot().x, mini.getCurrentMiniX());

    mock.timers.tick(1020);

    assert.deepStrictEqual(stateLog, ["mini-enter", "mini-idle"]);
    assert.equal(mini.getMiniTransitioning(), false);
    assert.equal(mini.getMiniMode(), true);
  });

  it("via-menu crabwalk tells renderer to flip edge without entering mini layout early", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const rendererEvents = [];
    const theme = cloneTheme(_defaultTheme);
    const ctx = makeCtx(theme, stateLog, 710);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    mini.enterMiniViaMenu();

    assert.deepStrictEqual(stateLog, ["mini-crabwalk"]);
    assert.deepStrictEqual(rendererEvents[0], [
      "mini-mode-change",
      true,
      "right",
      { preEntry: true },
    ]);
    assert.equal(mini.getMiniMode(), false);
    assert.equal(mini.getMiniTransitioning(), true);
  });

  it("drag-snap still plays full mini-enter even when the cursor is over the pet", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const theme = cloneTheme(_defaultTheme);
    const rightMiniX = 800 - Math.round(120 * (1 - theme.miniMode.offsetRatio));
    const ctx = makeCtx(theme, stateLog, rightMiniX);
    ctx.mouseOverPet = true;
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);
    assert.deepStrictEqual(stateLog, ["mini-enter"]);

    mock.timers.tick(1020);
    assert.deepStrictEqual(stateLog, ["mini-enter", "mini-idle"]);
    assert.equal(mini.getMiniTransitioning(), false);
    assert.equal(mini.getMiniMode(), true);
  });
});

// PR #751 Codex review #10 (rework batch B-5, non-blocking): every
// getAllDisplaysCalls assertion in this describe block only ever counts
// mini.js's OWN direct screen.getAllDisplays() call sites (resolveMiniTopology
// / checkMiniModeSnap) — makeCtx()'s mock ctx.applyPetWindowBounds never
// reaches the real pet-window-runtime.js, so it cannot see that runtime's OWN
// internal enumeration (materializeVirtualBounds -> resolveHorizontalClampBounds
// -> findDisplayIdForPoint(), plus syncHitWin()), which used to re-run on
// every single per-frame write/drag-move regardless of these budgets. See
// test/edge-virtualization.test.js's "B-5 (Codex #10): a full drag +
// mini-entry animation..." test for the real-runtime-assembled version that
// actually exercises (and, post-fix, bounds) that call count.
describe("mini entry animation composite-only guardrails (#690 Phase 3 item 6)", () => {
  let loader;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    if (loader) loader.restore();
    mock.timers.reset();
    loader = null;
  });

  it("drag-snap entry never sends a Y viewport-offset IPC, resolves topology at most once, and every frame asserts no Y offset", () => {
    let getAllDisplaysCalls = 0;
    loader = loadMiniWithElectron({
      getAllDisplays() {
        getAllDisplaysCalls++;
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const rendererEvents = [];
    const theme = cloneTheme(_defaultTheme);
    const ctx = makeCtx(theme, stateLog, 600);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);

    const yOffsetSends = rendererEvents.filter((e) => e[0] === "viewport-offset");
    assert.deepStrictEqual(yOffsetSends, [], "mini's per-frame writes must never trigger a Y viewport-offset IPC");

    const boundsCalls = ctx.getApplyBoundsCallLog();
    assert.ok(boundsCalls.length > 0, "expected at least one applyPetWindowBounds call from the entry animation");
    assert.ok(
      boundsCalls.every((c) => c.opts && c.opts.assertNoYOffset === true),
      "every mini animation frame must go through applyMiniFrameBounds() with assertNoYOffset:true"
    );

    // §12.8: "动画是否只缓存单次 workArea/topology" — enterMiniMode() resolves
    // the whole transition's topology exactly once (reused for the seam clip
    // and every animation frame via animCtx), so this must be exactly 1, not
    // just under some looser bound.
    assert.equal(
      getAllDisplaysCalls, 1,
      `expected screen.getAllDisplays() to be called exactly once for the whole entry animation, got ${getAllDisplaysCalls}`
    );
  });

  it("via-menu crabwalk + settle each resolve topology at most once and never send a Y viewport-offset IPC", () => {
    let getAllDisplaysCalls = 0;
    loader = loadMiniWithElectron({
      getAllDisplays() {
        getAllDisplaysCalls++;
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const stateLog = [];
    const rendererEvents = [];
    const theme = cloneTheme(_defaultTheme);
    const ctx = makeCtx(theme, stateLog, 710);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    mini.enterMiniViaMenu();
    // Crabwalk phase resolves its own topology once.
    assert.ok(getAllDisplaysCalls <= 1, `crabwalk phase: expected <=1 getAllDisplays() call, got ${getAllDisplaysCalls}`);

    mock.timers.tick(2500); // walk + jump + preload + mini-enter settle, generously

    const yOffsetSends = rendererEvents.filter((e) => e[0] === "viewport-offset");
    assert.deepStrictEqual(yOffsetSends, [], "menu-triggered mini entry must never trigger a Y viewport-offset IPC");
    const boundsCalls = ctx.getApplyBoundsCallLog();
    assert.ok(
      boundsCalls.every((c) => c.opts && c.opts.assertNoYOffset === true),
      "every mini animation frame (crabwalk + settle) must assert no Y offset"
    );
    // Crabwalk (enterMiniViaMenu) and the mini handoff (enterMiniMode) each
    // resolve topology once independently — two separate, non-per-frame
    // transitions, not one shared animation.
    assert.ok(
      getAllDisplaysCalls <= 2,
      `expected at most 2 total getAllDisplays() calls (crabwalk + mini handoff), got ${getAllDisplaysCalls}`
    );
  });
});

// Two displays tiled side by side: D1 [0,800) and D2 [800,1600), same height.
const SIDE_BY_SIDE = [
  { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } },
  { bounds: { x: 800, y: 0, width: 800, height: 600 }, workArea: { x: 800, y: 0, width: 800, height: 600 } },
];

const THREE_SIDE_BY_SIDE = [
  { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } },
  { bounds: { x: 800, y: 0, width: 800, height: 600 }, workArea: { x: 800, y: 0, width: 800, height: 600 } },
  { bounds: { x: 1600, y: 0, width: 800, height: 600 }, workArea: { x: 1600, y: 0, width: 800, height: 600 } },
];

function findNearestWorkArea(displays, cx, cy) {
  let nearest = displays[0].workArea;
  let minDist = Infinity;
  for (const d of displays) {
    const wa = d.workArea;
    const dx = Math.max(wa.x - cx, 0, cx - (wa.x + wa.width));
    const dy = Math.max(wa.y - cy, 0, cy - (wa.y + wa.height));
    const dist = dx * dx + dy * dy;
    if (dist < minDist) {
      minDist = dist;
      nearest = wa;
    }
  }
  return nearest;
}

function installDisplayAwareClamp(ctx, displays) {
  ctx.getNearestWorkArea = (cx, cy) => findNearestWorkArea(displays, cx, cy);
  ctx.clampToScreenVisual = (x, y, width, height, options = {}) => {
    const wa = options.workArea || findNearestWorkArea(displays, x + width / 2, y + height / 2);
    const marginX = Math.round(width * 0.25);
    return {
      x: Math.max(wa.x - marginX, Math.min(x, wa.x + wa.width - width + marginX)),
      y: Math.max(wa.y, Math.min(y, wa.y + wa.height - height)),
    };
  };
}

function miniClips(rendererEvents) {
  return rendererEvents.filter((e) => e[0] === "mini-clip").map((e) => e[1]);
}

describe("mini mode multi-monitor seam clip", () => {
  let loader;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    if (loader) loader.restore();
    mock.timers.reset();
    loader = null;
  });

  it("does not clip on a single display", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [{ bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }];
      },
    });
    const rendererEvents = [];
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 600);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);

    const clips = miniClips(rendererEvents);
    assert.ok(clips.length > 0, "expected mini-clip events");
    assert.ok(clips.every((c) => c === null), "single display must never clip");
  });

  it("clips the seam-crossing half at an internal monitor seam (right edge)", () => {
    loader = loadMiniWithElectron({ getAllDisplays() { return SIDE_BY_SIDE; } });
    const rendererEvents = [];
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 600);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    // Pet lives on D1, snaps to D1's right edge — an internal seam with D2.
    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);

    const last = miniClips(rendererEvents).at(-1);
    assert.ok(last, "expected a non-null clip at the seam");
    assert.equal(last.edge, "right");
    // The window straddles the seam (original peek X) and the clip cuts at
    // D1's bounds edge (x=800): fraction is the visible part on D1.
    const expected = (800 - mini.getCurrentMiniX()) / 120;
    assert.ok(Math.abs(last.fraction - expected) < 1e-9, `fraction ${last.fraction} ≈ ${expected}`);
    assert.ok(last.fraction > 0 && last.fraction < 1, "clip keeps a partial window");
  });

  it("does not clip at the outer edge of the virtual desktop", () => {
    loader = loadMiniWithElectron({ getAllDisplays() { return SIDE_BY_SIDE; } });
    const rendererEvents = [];
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 1400);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    // Pet on D2, snaps to D2's right edge — the outer edge, no neighbour.
    mini.enterMiniMode({ x: 800, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);

    const clips = miniClips(rendererEvents);
    assert.ok(clips.every((c) => c === null), "outer edge must not clip");
  });

  it("clips the left half at a left-side seam", () => {
    loader = loadMiniWithElectron({ getAllDisplays() { return SIDE_BY_SIDE; } });
    const rendererEvents = [];
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 1000);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    // Pet on D2, snaps to D2's left edge — an internal seam with D1.
    mini.enterMiniMode({ x: 800, y: 0, width: 800, height: 600 }, false, "left");
    mock.timers.tick(120);

    const last = miniClips(rendererEvents).at(-1);
    assert.ok(last, "expected a non-null clip at the left seam");
    assert.equal(last.edge, "left");
    assert.ok(last.fraction > 0 && last.fraction < 1, "clip keeps a partial window");
  });

  it("does not clip when the neighbour does not overlap the pet's vertical band", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [
          { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } },
          // Neighbour starts below the pet (pet's yMid ≈ 240, this display starts at y=400).
          { bounds: { x: 800, y: 400, width: 800, height: 600 }, workArea: { x: 800, y: 400, width: 800, height: 600 } },
        ];
      },
    });
    const rendererEvents = [];
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 600);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);

    const clips = miniClips(rendererEvents);
    assert.ok(clips.every((c) => c === null), "no vertical overlap → no clip");
  });

  it("clears the clip when leaving mini mode", () => {
    loader = loadMiniWithElectron({ getAllDisplays() { return SIDE_BY_SIDE; } });
    const rendererEvents = [];
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 600);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(1140);
    assert.ok(miniClips(rendererEvents).at(-1), "clip active while in contained mini");

    mini.exitMiniMode();
    mock.timers.tick(400);
    assert.equal(miniClips(rendererEvents).at(-1), null, "clip cleared on exit");
    assert.equal(mini.getMiniMode(), false);
  });

  it("clips at a seam on a secondary display with negative coordinates", () => {
    // D1 sits to the left of the origin: [-800,0). D2 is the primary [0,800).
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [
          { bounds: { x: -800, y: 0, width: 800, height: 600 }, workArea: { x: -800, y: 0, width: 800, height: 600 } },
          { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } },
        ];
      },
    });
    const rendererEvents = [];
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 60);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    // Pet on D2, snapping to D2's left edge — an internal seam with D1 at x=0.
    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "left");
    mock.timers.tick(120);

    const last = miniClips(rendererEvents).at(-1);
    assert.ok(last, "expected a non-null clip at the negative-coord seam");
    assert.equal(last.edge, "left");
    const expected = (0 - mini.getCurrentMiniX()) / 120;
    assert.ok(Math.abs(last.fraction - expected) < 1e-9, `fraction ${last.fraction} ≈ ${expected}`);
    assert.ok(last.fraction > 0 && last.fraction < 1, "clip keeps a partial window");
  });

  it("cuts the clip at the physical bounds edge, not the inset workArea", () => {
    // D1's workArea is narrower/shorter than its bounds (docks/panels). The
    // seam is the *physical* monitor boundary, so the clip must use bounds.
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [
          { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 770, height: 560 } },
          { bounds: { x: 800, y: 0, width: 800, height: 600 }, workArea: { x: 830, y: 0, width: 770, height: 560 } },
        ];
      },
    });
    const rendererEvents = [];
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 200);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    // Pet on D1, snapping to D1's right edge — seam with D2.
    mini.enterMiniMode({ x: 0, y: 0, width: 770, height: 560 }, false, "right");
    mock.timers.tick(120);

    const last = miniClips(rendererEvents).at(-1);
    assert.ok(last, "expected a non-null clip at the seam");
    assert.equal(last.edge, "right");
    // Seam is D1's bounds edge (x=800), not its workArea edge (x=770).
    const atBounds = (800 - mini.getCurrentMiniX()) / 120;
    const atWorkArea = (770 - mini.getCurrentMiniX()) / 120;
    assert.ok(Math.abs(last.fraction - atBounds) < 1e-9, `fraction ${last.fraction} ≈ ${atBounds}`);
    assert.ok(Math.abs(last.fraction - atWorkArea) > 1e-3, "must not cut at the workArea edge");
  });

  it("clips when a vertically offset neighbour still overlaps the pet's band", () => {
    loader = loadMiniWithElectron({
      getAllDisplays() {
        return [
          { bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } },
          // D2 shifted down 150px — still overlaps D1's vertical band at yMid≈240.
          { bounds: { x: 800, y: 150, width: 800, height: 600 }, workArea: { x: 800, y: 150, width: 800, height: 600 } },
        ];
      },
    });
    const rendererEvents = [];
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 600);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);

    const last = miniClips(rendererEvents).at(-1);
    assert.ok(last, "vertically overlapping neighbour → clip");
    assert.equal(last.edge, "right");
    assert.ok(last.fraction > 0 && last.fraction < 1, "clip keeps a partial window");
  });

  it("restoreFromPrefs computes the seam without sending renderer IPC", () => {
    loader = loadMiniWithElectron({ getAllDisplays() { return SIDE_BY_SIDE; } });
    const rendererEvents = [];
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 600);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    // Startup recovery of a contained mini on D1's right edge.
    const restored = mini.restoreFromPrefs(
      { x: 700, y: 180, preMiniX: 200, preMiniY: 180, miniEdge: "right" },
      { width: 120, height: 120 },
    );
    assert.equal(mini.getMiniMode(), true);
    // restore must not touch the renderer — the render window may not exist yet.
    assert.equal(miniClips(rendererEvents).length, 0, "restore sent no mini-clip IPC");
    const seam = mini.getContainedSeam();
    assert.ok(seam && seam.edge === "right", "seam state computed during restore");

    // Once the renderer is up, syncContainedClip re-sends the current clip.
    ctx.win.setBounds(restored);
    mini.syncContainedClip();
    const last = miniClips(rendererEvents).at(-1);
    assert.ok(last && last.edge === "right", "syncContainedClip re-sends the clip");
    assert.ok(last.fraction > 0 && last.fraction < 1, "re-sent clip keeps a partial window");
  });

  it("syncContainedClip is a no-op when the render window is absent", () => {
    loader = loadMiniWithElectron({ getAllDisplays() { return SIDE_BY_SIDE; } });
    const rendererEvents = [];
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 600);
    ctx.sendToRenderer = (...args) => rendererEvents.push(args);
    const mini = loader.initMini(ctx);

    mini.enterMiniMode({ x: 0, y: 0, width: 800, height: 600 }, false, "right");
    mock.timers.tick(120);
    rendererEvents.length = 0;

    ctx.win = null;
    assert.doesNotThrow(() => mini.syncContainedClip());
    assert.equal(rendererEvents.length, 0, "no IPC sent without a render window");
  });
});

describe("mini mode restore screen ownership", () => {
  let loader;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    if (loader) loader.restore();
    mock.timers.reset();
    loader = null;
  });

  it("restores onto the middle screen when snapped to the middle screen's left seam", () => {
    loader = loadMiniWithElectron({ getAllDisplays() { return THREE_SIDE_BY_SIDE; } });
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 725);
    installDisplayAwareClamp(ctx, THREE_SIDE_BY_SIDE);
    const mini = loader.initMini(ctx);
    const middle = THREE_SIDE_BY_SIDE[1].workArea;

    // The saved pre-mini center is slightly over the halfway mark into the
    // left screen, but the snap itself belongs to the middle screen's seam.
    mini.enterMiniMode(middle, false, "left");
    mock.timers.tick(1140);
    mini.exitMiniMode();
    mock.timers.tick(400);

    const bounds = ctx.getBoundsSnapshot();
    const centerX = bounds.x + bounds.width / 2;
    assert.ok(
      centerX >= middle.x && centerX < middle.x + middle.width,
      `expected restored center ${centerX} to stay on middle screen`
    );
  });

  it("restores onto the right screen when snapped to the right screen's left seam", () => {
    loader = loadMiniWithElectron({ getAllDisplays() { return THREE_SIDE_BY_SIDE; } });
    const ctx = makeCtx(cloneTheme(_defaultTheme), [], 1525);
    installDisplayAwareClamp(ctx, THREE_SIDE_BY_SIDE);
    const mini = loader.initMini(ctx);
    const right = THREE_SIDE_BY_SIDE[2].workArea;

    // The saved pre-mini center is slightly over the halfway mark into the
    // middle screen, but the snap itself belongs to the right screen's seam.
    mini.enterMiniMode(right, false, "left");
    mock.timers.tick(1140);
    mini.exitMiniMode();
    mock.timers.tick(400);

    const bounds = ctx.getBoundsSnapshot();
    const centerX = bounds.x + bounds.width / 2;
    assert.ok(
      centerX >= right.x && centerX < right.x + right.width,
      `expected restored center ${centerX} to stay on right screen`
    );
  });
});
