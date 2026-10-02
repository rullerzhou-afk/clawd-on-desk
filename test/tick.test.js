"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const { resolveIdleVisualChoice } = require("../src/idle-visual");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");

function cloneTheme(theme) {
  return JSON.parse(JSON.stringify(theme));
}

function loadTickWithScreen(getCursorScreenPoint) {
  const electronPath = require.resolve("electron");
  const tickPath = require.resolve("../src/tick");
  const previousElectron = Object.prototype.hasOwnProperty.call(require.cache, electronPath)
    ? require.cache[electronPath]
    : null;
  const previousTick = Object.prototype.hasOwnProperty.call(require.cache, tickPath)
    ? require.cache[tickPath]
    : null;

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      screen: { getCursorScreenPoint },
    },
  };
  delete require.cache[tickPath];

  return {
    initTick: require("../src/tick"),
    restore() {
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      if (previousTick) require.cache[tickPath] = previousTick;
      else delete require.cache[tickPath];
    },
  };
}

function makeCtx(theme, statesSeen) {
  return {
    theme,
    win: {
      setIgnoreMouseEvents() {},
      isDestroyed() { return false; },
      isVisible() { return true; },
      getBounds() { return { x: 0, y: 0, width: 120, height: 120 }; },
    },
    currentState: "idle",
    currentSvg: theme.states.idle[0],
    idlePaused: false,
    miniMode: false,
    miniTransitioning: false,
    dragLocked: false,
    menuOpen: false,
    isAnimating: false,
    mouseOverPet: false,
    miniPeeked: false,
    forceEyeResend: false,
    forceEyeResendBoostUntil: 0,
    startupRecoveryActive: false,
    sendToRenderer() {},
    sendToHitWin() {},
    getHitRectScreen() { return { left: 0, top: 0, right: 120, bottom: 120 }; },
    getObjRect() { return { x: 20, y: 20, w: 60, h: 60 }; },
    setState(state) {
      statesSeen.push(state);
      this.currentState = state;
    },
    applyState(state) {
      statesSeen.push(state);
      this.currentState = state;
    },
    miniPeekIn() {},
    miniPeekOut() {},
  };
}

describe("optional mini hover visuals", () => {
  let loader;
  let tickApi;
  let cursor;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    loader.restore();
    mock.timers.reset();
  });

  function start(theme, state, peeked = false) {
    const states = [];
    const slides = [];
    const ctx = makeCtx(theme, states);
    ctx.miniMode = true;
    ctx.currentState = state;
    ctx.miniPeeked = peeked;
    ctx.miniSleepPeeked = peeked && state.startsWith("mini-sleep");
    ctx.miniPeekIn = (mode) => slides.push(["in", mode]);
    ctx.miniPeekOut = () => slides.push(["out"]);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(1);
    return { ctx, states, slides };
  }

  it("keeps sleep art unchanged for a theme without mini-sleep-peek", () => {
    const { ctx, states, slides } = start(cloneTheme(_defaultTheme), "mini-sleep");
    assert.deepStrictEqual(slides, [["in", "sleep"]]);
    assert.deepStrictEqual(states, []);
    cursor.x = 200;
    mock.timers.tick(60);
    assert.deepStrictEqual(slides, [["in", "sleep"], ["out"]]);
    assert.equal(ctx.currentState, "mini-sleep");
  });

  it("shows mini-sleep-peek only when declared, then restores mini-sleep", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.miniMode.states["mini-sleep-peek"] = ["sleep-peek.svg"];
    const { ctx, states, slides } = start(theme, "mini-sleep");
    assert.deepStrictEqual(slides, [["in", "sleep"]]);
    assert.deepStrictEqual(states, ["mini-sleep-peek"]);
    cursor.x = 200;
    mock.timers.tick(60);
    assert.equal(ctx.currentState, "mini-sleep");
    assert.deepStrictEqual(states, ["mini-sleep-peek", "mini-sleep"]);
  });

  it("does not replay mini-peek while held, and leaves to mini-idle", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.miniMode.states["mini-peek-hold"] = ["peek-hold.svg"];
    const { ctx, states, slides } = start(theme, "mini-peek-hold", true);
    assert.deepStrictEqual(slides, []);
    cursor.x = 200;
    mock.timers.tick(60);
    assert.deepStrictEqual(slides, [["out"]]);
    assert.deepStrictEqual(states, ["mini-idle"]);
    assert.equal(ctx.miniPeeked, false);
  });

  it("cancels a pending slide when menu, drag, or mini transition blocks hover", () => {
    for (const blocker of ["menuOpen", "dragLocked", "miniTransitioning"]) {
      const theme = cloneTheme(_defaultTheme);
      const { ctx, slides } = start(theme, "mini-idle");
      let cancelled = 0;
      ctx.cancelPendingMiniPeek = () => { cancelled++; };
      ctx[blocker] = true;
      mock.timers.tick(60);
      assert.equal(cancelled, 1, blocker);
      assert.deepStrictEqual(slides, [["in", "peek"]]);
      tickApi.cleanup();
      tickApi = null;
    }
  });
});

describe("tick sleepSequence mode", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  it("direct mode goes straight to sleeping after mouseSleepTimeout", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "direct" };
    theme.timings.mouseIdleTimeout = 1000;
    theme.timings.mouseSleepTimeout = 60;

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (const step of [50, 50, 50, 50]) mock.timers.tick(step);
    assert.deepStrictEqual(statesSeen, ["sleeping"]);
  });

  it("full mode keeps the yawning entry path", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "full" };
    theme.timings.mouseIdleTimeout = 1000;
    theme.timings.mouseSleepTimeout = 60;

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (const step of [50, 50, 50, 50, 50, 50, 50, 50, 50]) mock.timers.tick(step);
    assert.deepStrictEqual(statesSeen, ["yawning"]);
  });
});

describe("tick mini hover", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  it("enters mini-peek from mini-idle when the cursor moves over the pet", () => {
    const theme = cloneTheme(_defaultTheme);
    let peekInCalls = 0;

    ctx = makeCtx(theme, statesSeen);
    ctx.miniMode = true;
    ctx.currentState = "mini-idle";
    ctx.miniPeekIn = () => { peekInCalls++; };

    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(60);

    assert.equal(peekInCalls, 1);
    assert.deepStrictEqual(statesSeen, ["mini-peek"]);
  });

  it("does not enter mini-peek when the cursor is outside the seam-clipped hit rect", () => {
    const theme = cloneTheme(_defaultTheme);
    let peekInCalls = 0;

    cursor = { x: 130, y: 40 };
    ctx = makeCtx(theme, statesSeen);
    ctx.miniMode = true;
    ctx.currentState = "mini-idle";
    ctx.getHitRectScreen = () => ({ left: 0, top: 0, right: 100, bottom: 120 });
    ctx.miniPeekIn = () => { peekInCalls++; };

    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(60);

    assert.equal(peekInCalls, 0);
    assert.equal(ctx.mouseOverPet, false);
    assert.deepStrictEqual(statesSeen, []);
  });

  it("returns to mini-idle when the cursor leaves mini-peek", () => {
    const theme = cloneTheme(_defaultTheme);
    let peekOutCalls = 0;

    cursor = { x: 400, y: 400 };
    ctx = makeCtx(theme, statesSeen);
    ctx.miniMode = true;
    ctx.currentState = "mini-peek";
    ctx.mouseOverPet = true;
    ctx.miniPeekOut = () => { peekOutCalls++; };

    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(60);

    assert.equal(peekOutCalls, 1);
    assert.equal(ctx.miniPeeked, false);
    assert.deepStrictEqual(statesSeen, ["mini-idle"]);
  });
});

describe("tick Cloudling pointer bridge", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 50 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  it("sends viewBox pointer payloads for idle", () => {
    const theme = cloneTheme(_defaultTheme);
    const pointers = [];

    ctx = makeCtx(theme, statesSeen);
    ctx.getAssetPointerPayload = (_bounds, point) => ({
      x: point.x / 10,
      y: point.y / 10,
      inside: true,
    });
    ctx.sendToRenderer = (channel, payload) => {
      if (channel === "cloudling-pointer") pointers.push(payload);
    };

    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(1);

    assert.deepStrictEqual(pointers, [{ x: 4, y: 5, inside: true }]);
  });

  it("keeps pointer bridge active outside the asset rect", () => {
    const theme = cloneTheme(_defaultTheme);
    const pointers = [];

    ctx = makeCtx(theme, statesSeen);
    ctx.miniMode = true;
    ctx.currentState = "mini-peek";
    ctx.currentSvg = "cloudling-mini-idle.svg";
    ctx.isAnimating = true;
    ctx.getAssetPointerPayload = (_bounds, point) => ({
      x: point.x,
      y: point.y,
      inside: false,
    });
    ctx.sendToRenderer = (channel, payload) => {
      if (channel === "cloudling-pointer") pointers.push(payload);
    };

    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    mock.timers.tick(60);

    assert.deepStrictEqual(pointers, [{ x: 40, y: 50, inside: true }]);
  });
});

describe("tick adaptive polling", () => {
  let cursor;
  let cursorCalls;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    cursorCalls = 0;
    loader = loadTickWithScreen(() => {
      cursorCalls++;
      return { ...cursor };
    });
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  it("backs off idle cursor polling below the old fixed 20Hz rate", () => {
    const theme = cloneTheme(_defaultTheme);

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(3000);

    assert.ok(cursorCalls > 0);
    assert.ok(cursorCalls < 45, `expected fewer than 45 polls, got ${cursorCalls}`);
  });

  it("uses a bounded one-second cursor probe while normal idle is low-power paused", () => {
    const theme = cloneTheme(_defaultTheme);

    ctx = makeCtx(theme, statesSeen);
    ctx.lowPowerIdleMode = true;
    ctx.lowPowerIdlePaused = true;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let elapsed = 0; elapsed < 10000; elapsed += 100) mock.timers.tick(100);

    assert.ok(cursorCalls >= 9, `expected at least 9 polls in 10s while paused, got ${cursorCalls}`);
    assert.ok(cursorCalls <= 11, `expected at most 11 polls in 10s while paused, got ${cursorCalls}`);
  });

  it("keeps non-paused idle polling materially above the low-power paused rate", () => {
    const theme = cloneTheme(_defaultTheme);

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let elapsed = 0; elapsed < 10000; elapsed += 100) mock.timers.tick(100);

    assert.ok(cursorCalls > 30, `expected more than 30 polls in 10s while not paused, got ${cursorCalls}`);
  });

  it("uses a bounded low-power polling rate for mini-idle", () => {
    const theme = cloneTheme(_defaultTheme);

    ctx = makeCtx(theme, statesSeen);
    ctx.currentState = "mini-idle";
    ctx.currentSvg = "clawd-mini-idle.svg";
    ctx.miniMode = true;
    ctx.lowPowerIdlePaused = true;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(10000);

    assert.ok(cursorCalls > 0);
    assert.ok(cursorCalls <= 6, `expected at most 6 polls in 10s while mini-idle paused, got ${cursorCalls}`);
  });

  it("does not throttle mini-peek with the low-power paused idle delay", () => {
    const theme = cloneTheme(_defaultTheme);

    ctx = makeCtx(theme, statesSeen);
    ctx.currentState = "mini-peek";
    ctx.currentSvg = "clawd-mini-idle.svg";
    ctx.miniMode = true;
    ctx.lowPowerIdlePaused = true;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let elapsed = 0; elapsed < 500; elapsed += 50) mock.timers.tick(50);

    assert.ok(cursorCalls >= 8, `expected fast mini-peek polling, got ${cursorCalls}`);
  });

  it("does not throttle drag, menu-open, or mini-transition paths while low-power paused", () => {
    const theme = cloneTheme(_defaultTheme);
    const cases = [
      ["drag", { dragLocked: true }],
      ["menu", { menuOpen: true }],
      ["transition", { miniTransitioning: true }],
    ];

    for (const [name, patch] of cases) {
      if (tickApi) tickApi.cleanup();
      cursorCalls = 0;
      ctx = makeCtx(theme, statesSeen);
      Object.assign(ctx, patch);
      ctx.lowPowerIdlePaused = true;
      tickApi = loader.initTick(ctx);
      tickApi.startMainTick();

      for (let elapsed = 0; elapsed < 500; elapsed += 50) mock.timers.tick(50);

      assert.ok(cursorCalls >= 8, `expected fast polling for ${name}, got ${cursorCalls}`);
    }
  });

  it("forwards new mouse movement within one second while low-power paused", () => {
    const theme = cloneTheme(_defaultTheme);
    const eyeMoves = [];

    ctx = makeCtx(theme, statesSeen);
    ctx.lowPowerIdleMode = true;
    ctx.lowPowerIdlePaused = true;
    ctx.sendToRenderer = (channel, ...args) => {
      if (channel === "eye-move") eyeMoves.push(args);
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(1);
    cursor = { x: 95, y: 70 };
    mock.timers.tick(1000);

    assert.equal(eyeMoves.length, 1);
  });

  it("keeps eye-position dedup active before low-power pause engages", () => {
    const theme = cloneTheme(_defaultTheme);
    const eyeMoves = [];

    ctx = makeCtx(theme, statesSeen);
    ctx.lowPowerIdleMode = true;
    ctx.lowPowerIdlePaused = false;
    ctx.sendToRenderer = (channel, ...args) => {
      if (channel === "eye-move") eyeMoves.push(args);
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(1);
    cursor = { x: 1000, y: 1000 };
    mock.timers.tick(100);
    cursor = { x: 1001, y: 1001 };
    mock.timers.tick(100);

    assert.equal(eyeMoves.length, 1);
  });

  it("keeps eye-move IPC suppressed while the mouse remains still in low-power pause", () => {
    const theme = cloneTheme(_defaultTheme);
    const eyeMoves = [];

    ctx = makeCtx(theme, statesSeen);
    ctx.lowPowerIdleMode = true;
    ctx.lowPowerIdlePaused = true;
    ctx.sendToRenderer = (channel, ...args) => {
      if (channel === "eye-move") eyeMoves.push(args);
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let elapsed = 0; elapsed < 5000; elapsed += 100) mock.timers.tick(100);

    assert.deepStrictEqual(eyeMoves, []);
  });

  it("suppresses passive Cloudling pointer IPC while low-power paused", () => {
    const theme = cloneTheme(_defaultTheme);
    const pointers = [];

    ctx = makeCtx(theme, statesSeen);
    ctx.lowPowerIdlePaused = true;
    ctx.getAssetPointerPayload = (_bounds, point) => ({
      x: point.x,
      y: point.y,
      inside: true,
    });
    ctx.sendToRenderer = (channel, payload) => {
      if (channel === "cloudling-pointer") pointers.push(payload);
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(1);
    cursor = { x: 95, y: 70 };
    mock.timers.tick(5000);

    assert.deepStrictEqual(pointers, []);
  });

  it("cleanup clears the pending adaptive tick", () => {
    const theme = cloneTheme(_defaultTheme);

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
    tickApi.cleanup();

    mock.timers.tick(1000);

    assert.equal(cursorCalls, 0);
  });

  it("still enters direct sleep near mouseSleepTimeout under adaptive scheduling", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.sleepSequence = { mode: "direct" };
    theme.timings.mouseIdleTimeout = 5000;
    theme.timings.mouseSleepTimeout = 500;

    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (const step of [100, 100, 100, 100, 100, 100, 100]) mock.timers.tick(step);
    assert.deepStrictEqual(statesSeen, ["sleeping"]);
  });

  it("uses the ctx setter path to pull a pending tick forward for force eye resend boost", () => {
    const theme = cloneTheme(_defaultTheme);
    const eyeMoves = [];
    let forceEyeResend = false;
    let forceEyeResendBoostUntil = 0;

    ctx = makeCtx(theme, statesSeen);
    Object.defineProperty(ctx, "forceEyeResend", {
      get() { return forceEyeResend; },
      set(value) {
        forceEyeResend = !!value;
        if (forceEyeResend) {
          forceEyeResendBoostUntil = Math.max(forceEyeResendBoostUntil, Date.now() + 2000);
          if (tickApi) tickApi.scheduleSoon(100);
        }
      },
      configurable: true,
    });
    Object.defineProperty(ctx, "forceEyeResendBoostUntil", {
      get() { return forceEyeResendBoostUntil; },
      configurable: true,
    });
    ctx.sendToRenderer = (channel, ...args) => {
      if (channel === "eye-move") eyeMoves.push(args);
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(2200);
    eyeMoves.length = 0;

    ctx.forceEyeResend = true;

    mock.timers.tick(99);
    assert.equal(eyeMoves.length, 0);

    mock.timers.tick(1);
    assert.equal(eyeMoves.length, 1);
    assert.equal(ctx.forceEyeResend, false);
  });

  it("preserves ticks scheduled while the current tick is running", () => {
    const theme = cloneTheme(_defaultTheme);
    theme.timings.mouseIdleTimeout = 60000;
    theme.timings.mouseSleepTimeout = 120000;
    theme.idleAnimations = [];
    let eyeMoveCount = 0;

    ctx = makeCtx(theme, statesSeen);
    ctx.sendToRenderer = (channel) => {
      if (channel === "eye-move") {
        eyeMoveCount++;
        tickApi.scheduleSoon(100);
      }
    };
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(2200);
    ctx.forceEyeResend = true;

    for (let elapsed = 0; eyeMoveCount === 0 && elapsed < 1000; elapsed++) {
      mock.timers.tick(1);
    }
    assert.equal(eyeMoveCount, 1);
    const callsAfterEyeMove = cursorCalls;

    mock.timers.tick(99);
    assert.equal(cursorCalls, callsAfterEyeMove);

    mock.timers.tick(1);
    assert.equal(cursorCalls, callsAfterEyeMove + 1);
  });
});

describe("tick spin detection (dizzy gesture)", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  // A theme that supports dizzy, with idle-anim / sleep pushed far out of the way
  // so they never fire during a multi-second gesture.
  function dizzyTheme() {
    const theme = cloneTheme(_defaultTheme);
    theme.states.dizzy = ["clawd-dizzy.svg"];
    theme.timings.autoReturn = theme.timings.autoReturn || {};
    theme.timings.autoReturn.dizzy = 6000;
    theme.timings.mouseIdleTimeout = 100000;
    theme.timings.mouseSleepTimeout = 100000;
    return theme;
  }

  // Eye-tracking origin for the fixed getObjRect() { x:20, y:20, w:60, h:60 }.
  function eyeCenter(theme) {
    const obj = { x: 20, y: 20, w: 60, h: 60 };
    return {
      cx: obj.x + obj.w * theme.eyeTracking.eyeRatioX,
      cy: obj.y + obj.h * theme.eyeTracking.eyeRatioY,
    };
  }

  // Drive `steps` circling samples at radius R, dTheta per step — one 100ms tick each.
  function circle(cx, cy, R, startAngle, dTheta, steps) {
    for (let i = 0; i < steps; i++) {
      const a = startAngle + i * dTheta;
      cursor.x = cx + R * Math.cos(a);
      cursor.y = cy + R * Math.sin(a);
      mock.timers.tick(100);
    }
  }

  it("triggers dizzy after 2+ full circles around the pet", () => {
    const theme = dizzyTheme();
    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    const { cx, cy } = eyeCenter(theme);
    circle(cx, cy, 40, 0, Math.PI / 6, 36); // 3 turns worth of samples

    assert.ok(statesSeen.includes("dizzy"), `expected dizzy, saw ${JSON.stringify(statesSeen)}`);
  });

  it("does NOT trigger on back-and-forth wiggling (signed cancellation)", () => {
    const theme = dizzyTheme();
    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    const { cx, cy } = eyeCenter(theme);
    const R = 40;
    const a = 0.3;
    const b = 2.3; // ~2 rad swing, well under PI so nothing wraps
    for (let i = 0; i < 40; i++) {
      const angle = (i % 2 === 0) ? a : b;
      cursor.x = cx + R * Math.cos(angle);
      cursor.y = cy + R * Math.sin(angle);
      mock.timers.tick(100);
    }

    assert.ok(!statesSeen.includes("dizzy"), `expected no dizzy, saw ${JSON.stringify(statesSeen)}`);
  });

  it("does NOT trigger from sub-pixel jitter near the center", () => {
    const theme = dizzyTheme();
    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    const { cx, cy } = eyeCenter(theme);
    const jitter = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1]];
    for (let i = 0; i < 40; i++) {
      const [dx, dy] = jitter[i % jitter.length];
      cursor.x = cx + dx;
      cursor.y = cy + dy;
      mock.timers.tick(100);
    }

    assert.ok(!statesSeen.includes("dizzy"), `expected no dizzy from jitter, saw ${JSON.stringify(statesSeen)}`);
  });

  it("does NOT trigger on themes without a dizzy state (Calico / Cloudling)", () => {
    const theme = dizzyTheme();
    delete theme.states.dizzy;
    delete theme.timings.autoReturn.dizzy;
    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    const { cx, cy } = eyeCenter(theme);
    circle(cx, cy, 40, 0, Math.PI / 6, 36);

    assert.ok(!statesSeen.includes("dizzy"), `unsupported theme should stay idle, saw ${JSON.stringify(statesSeen)}`);
  });

  it("resets the meter after a pause so a broken-up gesture doesn't accumulate", () => {
    const theme = dizzyTheme();
    ctx = makeCtx(theme, statesSeen);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    const { cx, cy } = eyeCenter(theme);
    circle(cx, cy, 40, 0, Math.PI / 6, 18); // ~1.5 turns
    assert.ok(!statesSeen.includes("dizzy"), "1.5 turns alone should not trigger");

    for (let i = 0; i < 8; i++) mock.timers.tick(100); // 800ms pause, cursor held still

    circle(cx, cy, 40, 0, Math.PI / 6, 18); // another ~1.5 turns after the reset
    assert.ok(!statesSeen.includes("dizzy"), `pause should reset the meter, saw ${JSON.stringify(statesSeen)}`);
  });
});

describe("tick free roam cancellation (#569)", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  function makeRoamCtx() {
    const theme = cloneTheme(_defaultTheme);
    const c = makeCtx(theme, statesSeen);
    // Pet is mid-walk: roam.js switched the visual state to "roam".
    c.currentState = "roam";
    c.roamCancels = 0;
    c.roam = {
      enabled: true,
      cancelRoam() { c.roamCancels += 1; },
      tick() {},
    };
    return c;
  }

  it("cancels an active walk when the mouse moves during state 'roam'", () => {
    ctx = makeRoamCtx();
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    // Baseline ticks with a still cursor — records lastCursor, must not cancel.
    mock.timers.tick(800);
    assert.equal(ctx.roamCancels, 0, "no cancel while the mouse is still");

    // Mouse moves mid-walk — the next tick must cancel the walk. Before the
    // #569 follow-up, state "roam" was excluded from the cursor poll gate and
    // this cancel block was unreachable during a walk.
    cursor = { x: 300, y: 260 };
    mock.timers.tick(800);
    assert.ok(ctx.roamCancels >= 1, "mouse move during an active walk must cancel roam");
  });

  it("does not cancel while the mouse stays still for the whole walk", () => {
    ctx = makeRoamCtx();
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 6; i++) mock.timers.tick(800);
    assert.equal(ctx.roamCancels, 0, "a still mouse must never cancel the walk");
  });

  it("does not cancel a walk while idlePaused (e.g. menu open)", () => {
    ctx = makeRoamCtx();
    ctx.idlePaused = true;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(800);
    cursor = { x: 300, y: 260 };
    mock.timers.tick(800);
    assert.equal(ctx.roamCancels, 0, "idlePaused suppresses roam cursor cancellation");
  });
});

// #509: user-selected default idle visual as the tick resting sprite.
describe("tick default idle visual", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let statesSeen;
  let rendererCalls;

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    statesSeen = [];
    rendererCalls = [];
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  function makeIdleVisualCtx(theme, choice) {
    const c = makeCtx(theme, statesSeen);
    let visualGeneration = 0;
    c.sendToRenderer = (channel, ...args) => {
      rendererCalls.push([channel, ...args]);
      if (channel === "state-change") {
        const request = { visualGeneration: ++visualGeneration };
        const options = args[2];
        if (options && typeof options.onLogicalSettlement === "function") {
          options.onLogicalSettlement({
            status: "committed",
            visualGeneration: request.visualGeneration,
          });
        }
        return request;
      }
    };
    if (choice !== undefined) c.getIdleVisualChoice = () => choice;
    return c;
  }

  function idleStateChanges() {
    return rendererCalls.filter(([ch, state]) => ch === "state-change" && state === "idle");
  }

  function makeIdleTheme(idleAnimations) {
    const theme = cloneTheme(_defaultTheme);
    theme.timings.mouseIdleTimeout = 60;
    theme.timings.mouseSleepTimeout = 100000;
    theme.idleAnimations = idleAnimations;
    return theme;
  }

  for (const roll of [0, 0.49, 0.99]) {
    it(`never randomly plays a selectable-only visual at roll ${roll}`, () => {
      const theme = makeIdleTheme([
        { file: "clawd-idle-look.svg", duration: 500 },
        { file: "clawd-idle-bubble.svg", duration: 500 },
      ]);
      theme.idleVisualOptions = [{ file: "pool.apng" }];
      ctx = makeIdleVisualCtx(theme, resolveIdleVisualChoice(theme, { clawd: "pool.apng" }));
      ctx.random = () => roll;
      tickApi = loader.initTick(ctx);
      tickApi.startMainTick();

      for (let i = 0; i < 20 && idleStateChanges().length === 0; i++) mock.timers.tick(50);
      assert.ok(idleStateChanges().length > 0);
      assert.ok(["clawd-idle-look.svg", "clawd-idle-bubble.svg"].includes(idleStateChanges()[0][2]));
      mock.timers.tick(500);
      assert.strictEqual(idleStateChanges().at(-1)[2], "pool.apng");
    });
  }

  it("excludes a selected option even when its file also occurs in idleAnimations", () => {
    const theme = makeIdleTheme([
      { file: "pool.apng", duration: 500 },
      { file: "clawd-idle-look.svg", duration: 500 },
    ]);
    theme.idleVisualOptions = [{ file: "pool.apng" }];
    ctx = makeIdleVisualCtx(theme, resolveIdleVisualChoice(theme, { clawd: "pool.apng" }));
    ctx.random = () => 0;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 20 && idleStateChanges().length === 0; i++) mock.timers.tick(50);
    assert.strictEqual(idleStateChanges()[0][2], "clawd-idle-look.svg");
    mock.timers.tick(500);
    assert.strictEqual(idleStateChanges().at(-1)[2], "pool.apng");
  });

  it("pool play returns to the user-selected idle visual", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme, "clawd-idle-reading.svg");
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 20 && idleStateChanges().length === 0; i++) mock.timers.tick(50);
    mock.timers.tick(500);                              // duration starts at committed display

    const changes = idleStateChanges();
    assert.deepStrictEqual(
      changes.map(([, , svg]) => svg),
      ["clawd-idle-look.svg", "clawd-idle-reading.svg"]
    );
  });

  it("unset choice keeps returning to the theme follow sprite", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 20 && idleStateChanges().length === 0; i++) mock.timers.tick(50);
    mock.timers.tick(500);

    const changes = idleStateChanges();
    assert.deepStrictEqual(
      changes.map(([, , svg]) => svg),
      ["clawd-idle-look.svg", "clawd-idle-follow.svg"]
    );
  });

  it("unset choice leaves the pool untouched (follow sprite stays a valid pool entry)", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-follow.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 20 && idleStateChanges().length === 0; i++) mock.timers.tick(50);
    mock.timers.tick(500);

    const changes = idleStateChanges();
    assert.deepStrictEqual(
      changes.map(([, , svg]) => svg),
      ["clawd-idle-follow.svg", "clawd-idle-follow.svg"],
      "with no choice set a theme may play its follow sprite from the pool"
    );
  });

  it("consumes forceEyeResend while resting on a non-follow visual", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 500 }]);
    theme.timings.mouseIdleTimeout = 100000; // keep the pool out of this test
    ctx = makeIdleVisualCtx(theme, "clawd-idle-reading.svg");
    ctx.currentSvg = "clawd-idle-reading.svg";
    // Production always exposes this; without it the pointer-bridge key is
    // never recorded and bounds get polled every tick for that reason instead.
    ctx.getAssetPointerPayload = () => ({ x: 0.5, y: 0.5, inside: true });
    let boundsReads = 0;
    ctx.getPetWindowBounds = () => { boundsReads++; return { x: 0, y: 0, width: 120, height: 120 }; };
    ctx.forceEyeResend = true;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    mock.timers.tick(50);
    assert.strictEqual(ctx.forceEyeResend, false, "flag must be consumed on the first idle tick");
    const readsAfterFirstTick = boundsReads;
    for (let i = 0; i < 5; i++) mock.timers.tick(50);
    assert.strictEqual(boundsReads, readsAfterFirstTick, "no per-tick bounds polling while resting still");
  });

  it("never picks the chosen file from the pool; skips when it is the only entry", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-reading.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme, "clawd-idle-reading.svg");
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 10; i++) mock.timers.tick(100);
    assert.deepStrictEqual(idleStateChanges(), [], "resting sprite must not be re-played as a pool pick");
  });

  it("mouse movement during a pool play reverts to the chosen visual", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 5000 }]);
    ctx = makeIdleVisualCtx(theme, "clawd-idle-reading.svg");
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 8; i++) mock.timers.tick(50);   // trigger + play (long duration, no revert yet)
    cursor = { x: 300, y: 260 };                        // wake mid-play
    for (let i = 0; i < 4; i++) mock.timers.tick(50);

    const changes = idleStateChanges();
    assert.ok(changes.length >= 2, "expected play + mouse-move revert");
    assert.strictEqual(changes[changes.length - 1][2], "clawd-idle-reading.svg");
  });

  it("does not let a stale idle return timer replace a superseding visual generation", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme, "clawd-idle-reading.svg");
    ctx.isVisualGenerationCurrent = () => false;
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 20 && idleStateChanges().length === 0; i++) mock.timers.tick(50);
    mock.timers.tick(500);

    assert.deepStrictEqual(
      idleStateChanges().map(([, , svg]) => svg),
      ["clawd-idle-look.svg"],
      "a superseded idle beat must not fire its old return request"
    );
  });

  it("does not eye-track while resting on a non-follow visual", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme, "clawd-idle-reading.svg");
    ctx.currentSvg = "clawd-idle-reading.svg";
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 5; i++) {
      cursor = { x: cursor.x + 15, y: cursor.y + 10 };
      mock.timers.tick(50);
    }
    const eyeMoves = rendererCalls.filter(([ch]) => ch === "eye-move");
    assert.deepStrictEqual(eyeMoves, [], "eye tracking must stay off on a non-follow resting sprite");
  });

  it("still eye-tracks when the choice is unset (follow sprite)", () => {
    const theme = makeIdleTheme([{ file: "clawd-idle-look.svg", duration: 500 }]);
    ctx = makeIdleVisualCtx(theme);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();

    for (let i = 0; i < 5; i++) {
      cursor = { x: cursor.x + 15, y: cursor.y + 10 };
      mock.timers.tick(50);
    }
    const eyeMoves = rendererCalls.filter(([ch]) => ch === "eye-move");
    assert.ok(eyeMoves.length > 0, "follow sprite must keep eye tracking");
  });
});

describe("tick conditional idle easter eggs", () => {
  let cursor;
  let loader;
  let tickApi;
  let ctx;
  let rendererCalls;
  let randomValues;
  let randomCalls;
  let accessoryIds;

  const BENDER = {
    file: "clawd-outlaw-bender.svg",
    duration: 15000,
    chance: 0.5,
    cooldownMs: 1800000,
    requiresAccessories: { head: "western-cowboy-hat", mouth: "cigarette" },
  };

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    cursor = { x: 40, y: 40 };
    loader = loadTickWithScreen(() => ({ ...cursor }));
    rendererCalls = [];
    randomValues = [];
    randomCalls = 0;
    accessoryIds = { head: "western-cowboy-hat", mouth: "cigarette" };
  });

  afterEach(() => {
    if (tickApi) tickApi.cleanup();
    if (loader) loader.restore();
    mock.timers.reset();
    tickApi = null;
    ctx = null;
  });

  function makeEggTheme({ eggs = [BENDER], idleAnimations = [] } = {}) {
    const theme = cloneTheme(_defaultTheme);
    theme.timings.mouseIdleTimeout = 60;
    theme.timings.mouseSleepTimeout = 100000000;
    theme.idleAnimations = idleAnimations;
    theme.idleEasterEggs = eggs;
    return theme;
  }

  function start(theme = makeEggTheme(), configure = () => {}) {
    ctx = makeCtx(theme, []);
    let visualGeneration = 0;
    ctx.autoSettleVisualRequests = true;
    ctx.pendingVisualSettlements = [];
    ctx.getEffectiveAccessoryIds = () => ({ ...accessoryIds });
    ctx.random = () => {
      randomCalls++;
      return randomValues.length > 0 ? randomValues.shift() : 0;
    };
    ctx.now = () => Date.now();
    ctx.sendToRenderer = (channel, ...args) => {
      rendererCalls.push([channel, ...args]);
      if (channel === "state-change") {
        const request = { visualGeneration: ++visualGeneration };
        const options = args[2];
        if (options && typeof options.onLogicalSettlement === "function") {
          ctx.pendingVisualSettlements.push(options.onLogicalSettlement);
          if (ctx.autoSettleVisualRequests) {
            options.onLogicalSettlement({
              status: "committed",
              visualGeneration: request.visualGeneration,
            });
          }
        }
        return request;
      }
      return undefined;
    };
    configure(ctx);
    tickApi = loader.initTick(ctx);
    tickApi.startMainTick();
  }

  function idleFiles() {
    return rendererCalls
      .filter(([channel, state]) => channel === "state-change" && state === "idle")
      .map(([, , file]) => file);
  }

  function advanceUntil(predicate, { step = 25, limit = 2000 } = {}) {
    for (let elapsed = 0; elapsed < limit && !predicate(); elapsed += step) {
      mock.timers.tick(step);
    }
    assert.ok(predicate(), `condition was not reached within ${limit} ms`);
  }

  it("uses the reviewed 50% interval before the ordinary idle pool and returns naturally", () => {
    randomValues.push(0.499);
    start(makeEggTheme({
      idleAnimations: [{ file: "clawd-idle-look.svg", duration: 500 }],
    }));

    advanceUntil(() => idleFiles().length === 1);
    assert.deepStrictEqual(idleFiles(), ["clawd-outlaw-bender.svg"]);
    assert.strictEqual(randomCalls, 1, "an egg hit must not also draw from the ordinary pool");

    mock.timers.tick(15000);
    assert.deepStrictEqual(idleFiles(), [
      "clawd-outlaw-bender.svg",
      "clawd-idle-follow.svg",
    ]);
  });

  it("falls through to the ordinary pool on an egg miss", () => {
    randomValues.push(0.5, 0);
    start(makeEggTheme({
      idleAnimations: [{ file: "clawd-idle-look.svg", duration: 500 }],
    }));

    advanceUntil(() => idleFiles().length === 1);
    assert.deepStrictEqual(idleFiles(), ["clawd-idle-look.svg"]);
    assert.strictEqual(randomCalls, 2, "miss and ordinary pool selection use separate draws");
  });

  it("uses declaration-order cumulative probability intervals", () => {
    randomValues.push(0.5);
    start(makeEggTheme({ eggs: [
      { ...BENDER, chance: 0.5 },
      { ...BENDER, file: "second-egg.svg", chance: 0.1 },
    ] }));

    advanceUntil(() => idleFiles().length === 1);
    assert.deepStrictEqual(idleFiles(), ["second-egg.svg"]);
  });

  it("rechecks canonical accessories during the 250 ms swap delay", () => {
    randomValues.push(0);
    start();
    advanceUntil(() => randomCalls === 1);
    accessoryIds = { head: "none", mouth: "cigarette" };
    mock.timers.tick(350);

    assert.deepStrictEqual(idleFiles(), []);
    assert.strictEqual(randomCalls, 1);
  });

  it("starts cooldown only after playback begins and permits another play after expiry", () => {
    const egg = { ...BENDER, duration: 5000, cooldownMs: 10000 };
    randomValues.push(0, 0);
    start(makeEggTheme({ eggs: [egg] }));
    advanceUntil(() => idleFiles().length === 1);
    assert.deepStrictEqual(idleFiles(), ["clawd-outlaw-bender.svg"]);

    cursor = { x: 80, y: 80 };
    mock.timers.tick(2000);
    assert.strictEqual(randomCalls, 1, "cooldown eligibility must be checked before drawing probability");

    mock.timers.tick(9000);
    cursor = { x: 90, y: 90 };
    advanceUntil(
      () => idleFiles().filter((file) => file === "clawd-outlaw-bender.svg").length === 2,
      { limit: 2000 }
    );
    assert.strictEqual(
      idleFiles().filter((file) => file === "clawd-outlaw-bender.svg").length,
      2
    );
    assert.strictEqual(randomCalls, 2);
  });

  it("starts duration and cooldown from the recovery generation that actually commits", () => {
    const egg = { ...BENDER, duration: 1000, cooldownMs: 10000 };
    randomValues.push(0);
    start(makeEggTheme({ eggs: [egg] }), (c) => {
      c.autoSettleVisualRequests = false;
      c.isVisualGenerationCurrent = (generation) => generation === 2;
    });

    advanceUntil(() => idleFiles().length === 1);
    mock.timers.tick(4000);
    assert.deepStrictEqual(idleFiles(), ["clawd-outlaw-bender.svg"]);

    ctx.pendingVisualSettlements[0]({ status: "committed", visualGeneration: 2 });
    mock.timers.tick(999);
    assert.deepStrictEqual(idleFiles(), ["clawd-outlaw-bender.svg"]);
    mock.timers.tick(1);
    assert.deepStrictEqual(idleFiles(), [
      "clawd-outlaw-bender.svg",
      "clawd-idle-follow.svg",
    ]);
  });

  it("does not consume cooldown when the requested easter egg fails before display", () => {
    randomValues.push(0, 0);
    start(makeEggTheme(), (c) => {
      c.autoSettleVisualRequests = false;
    });

    advanceUntil(() => idleFiles().length === 1);
    ctx.pendingVisualSettlements[0]({ status: "failed", visualGeneration: 1 });

    cursor = { x: 80, y: 80 };
    mock.timers.tick(100);
    ctx.autoSettleVisualRequests = true;
    advanceUntil(
      () => idleFiles().filter((file) => file === "clawd-outlaw-bender.svg").length === 2,
      { limit: 2000 }
    );
    assert.strictEqual(randomCalls, 2);
  });

  for (const [label, configure] of [
    ["renderer hidden", (c) => { c.win.isVisible = () => false; }],
    ["low-power idle pause", (c) => { c.lowPowerIdlePaused = true; }],
    ["drag lock", (c) => { c.dragLocked = true; }],
    ["menu transition", (c) => { c.menuOpen = true; }],
    ["mini mode", (c) => { c.miniMode = true; c.currentState = "mini-idle"; }],
    ["roam", (c) => { c.currentState = "roam"; }],
  ]) {
    it(`does not consume probability while ${label}`, () => {
      randomValues.push(0);
      start(makeEggTheme(), configure);
      mock.timers.tick(1000);
      assert.deepStrictEqual(idleFiles(), []);
      assert.strictEqual(randomCalls, 0);
    });
  }

  it("does not trigger for a holiday replacement or any other accessory mismatch", () => {
    accessoryIds = { head: "santa-hat", mouth: "cigarette" };
    randomValues.push(0);
    start();
    mock.timers.tick(1000);
    assert.deepStrictEqual(idleFiles(), []);
    assert.strictEqual(randomCalls, 0);
  });

  it("does not let the return timer overwrite a higher-priority state", () => {
    randomValues.push(0);
    start();
    advanceUntil(() => idleFiles().length === 1);
    assert.deepStrictEqual(idleFiles(), ["clawd-outlaw-bender.svg"]);

    ctx.currentState = "working";
    mock.timers.tick(16000);
    assert.deepStrictEqual(idleFiles(), ["clawd-outlaw-bender.svg"]);
  });
});
