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
