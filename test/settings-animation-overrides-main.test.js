"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createSettingsAnimationOverridesMain = require("../src/settings-animation-overrides-main");
const {
  registerSettingsAnimationOverridesIpc,
} = createSettingsAnimationOverridesMain;
const animationOverrideTest = createSettingsAnimationOverridesMain.__test;
const themeLoader = require("../src/theme-loader");
const { createTranslator } = require("../src/i18n");

themeLoader.init(path.join(__dirname, "..", "src"));

// A real src/state.js instance for tests that need the true preview-ownership
// contract (mini remaps, display revision) rather than the harness fake.
function createRealStateRuntime({ theme, miniMode = false } = {}) {
  const sounds = [];
  const flashes = [];
  const ctx = {
    lang: "en",
    theme,
    doNotDisturb: false,
    miniTransitioning: false,
    miniMode,
    mouseOverPet: false,
    idlePaused: false,
    forceEyeResend: false,
    eyePauseUntil: 0,
    mouseStillSince: Date.now(),
    miniSleepPeeked: false,
    playSound: (name) => sounds.push(name),
    flashTaskbar: () => flashes.push("flash"),
    sendToRenderer: () => {},
    syncHitWin: () => {},
    sendToHitWin: () => {},
    miniPeekIn: () => {},
    miniPeekOut: () => {},
    buildContextMenu: () => {},
    buildTrayMenu: () => {},
    pendingPermissions: [],
    resolvePermissionEntry: () => {},
    focusTerminalWindow: () => {},
    processKill: () => true,
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
  };
  ctx.t = createTranslator(() => ctx.lang);
  const api = require("../src/state")(ctx);
  return { api, sounds, flashes };
}

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
  }

  handle(channel, listener) {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  invoke(channel, ...args) {
    const listener = this.handlers.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC handler ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }
}

class FakeBrowserWindow {
  static fromWebContents(sender) {
    return { id: "parent", sender };
  }
}

function makeTheme(root, overrides = {}) {
  return {
    _id: "cloudling",
    _variantId: "default",
    _builtin: true,
    _themeDir: root,
    _capabilities: { idleMode: "static", sleepMode: "direct" },
    _bindingBase: {
      states: { idle: "idle.svg", thinking: "scripted.svg", sleeping: "sleep.svg" },
      workingTiers: [],
      jugglingTiers: [],
      displayHintMap: {},
    },
    _baseTransitions: {},
    _stateBindings: {
      idle: { files: ["idle.svg"] },
      thinking: { files: ["scripted.svg"] },
      sleeping: { files: ["sleep.svg"] },
    },
    states: {
      idle: ["idle.svg"],
      thinking: ["scripted.svg"],
      sleeping: ["sleep.svg"],
    },
    transitions: {},
    timings: { autoReturn: {} },
    sounds: {},
    trustedRuntime: {
      scriptedSvgFiles: ["scripted.svg"],
      scriptedSvgCycleMs: { "scripted.svg": 5400 },
    },
    ...overrides,
  };
}

function createRuntimeHarness(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-anim-main-"));
  const assetsDir = path.join(root, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "idle.svg"), "<svg viewBox=\"0 0 100 100\"></svg>", "utf8");
  fs.writeFileSync(path.join(assetsDir, "scripted.svg"), "<svg viewBox=\"0 0 100 100\"></svg>", "utf8");
  fs.writeFileSync(path.join(assetsDir, "sleep.svg"), "<svg viewBox=\"0 0 100 100\"></svg>", "utf8");

  const stateCalls = [];
  let themeReloadInProgress = !!overrides.themeReloadInProgress;
  let displayState = overrides.displayState || "idle";
  let currentState = overrides.currentState || "idle";
  let currentVisualSource = null;
  let displayRevision = 0;
  let applyStateEarlyReturns = overrides.applyStateEarlyReturns === true;
  let applyStateThrows = overrides.applyStateThrows === true;
  let applyStateThrowsAfterLanding = overrides.applyStateThrowsAfterLanding === true;
  const injectedStateRuntime = typeof overrides.stateRuntimeFactory === "function"
    ? overrides.stateRuntimeFactory()
    : (overrides.stateRuntime || null);
  const activeTheme = typeof overrides.activeThemeFactory === "function"
    ? overrides.activeThemeFactory(root)
    : (overrides.activeTheme || makeTheme(root, overrides.themeOverrides));
  const runtime = createSettingsAnimationOverridesMain({
    app: { isPackaged: false, getVersion: () => "1.2.3" },
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true }),
    },
    shell: { openPath: async () => "" },
    fs,
    path,
    themeLoader: {
      _resolveAssetPath: (_theme, filename) => path.join(assetsDir, path.basename(filename)),
      getAssetPath: (filename) => path.join(assetsDir, path.basename(filename)),
      getThemeMetadata: (themeId) => ({ name: `Theme ${themeId}` }),
    },
    animationCycle: overrides.animationCycle || {
      probeAssetCycle: () => ({ ms: null, status: "unavailable", source: null }),
    },
    settingsController: {
      getSnapshot: () => (overrides.snapshot || { themeOverrides: {} }),
      applyCommand: async () => ({ status: "ok", importedThemeCount: 0 }),
    },
    getActiveTheme: () => activeTheme,
    getSettingsWindow: () => null,
    getLang: () => "en",
    getThemeReloadInProgress: () => themeReloadInProgress,
    getStateRuntime: () => injectedStateRuntime || {
      applyState: (...args) => {
        stateCalls.push(["applyState", ...args]);
        // Simulates applyState's early returns (mini transition, disabled
        // one-shot): the call is recorded but the visual never changes.
        if (applyStateThrows) throw new Error("applyState failed");
        if (applyStateEarlyReturns) return;
        currentState = args[0];
        displayRevision += 1;
        // Mirrors src/state.js: the settingsPreview marker is the only thing
        // that makes the current visual settings-owned.
        currentVisualSource = args[2] && args[2].settingsPreview === true
          ? "settings-preview"
          : null;
        // One-shot: the visual is taken, then the apply fails. The follow-up
        // hand-back must still be able to apply for real.
        if (applyStateThrowsAfterLanding) {
          applyStateThrowsAfterLanding = false;
          throw new Error("applyState failed after landing");
        }
      },
      getCurrentState: () => currentState,
      getDisplayRevision: () => displayRevision,
      isSettingsPreviewVisual: () => currentVisualSource === "settings-preview",
      resolveDisplayState: () => displayState,
      getSvgOverride: (state) => `${state}.svg`,
    },
    sendToRenderer: (...args) => stateCalls.push(["sendToRenderer", ...args]),
  });

  return {
    activeTheme,
    assetsDir,
    runtime,
    root,
    stateCalls,
    setDisplayState(value) {
      displayState = value;
    },
    setApplyStateEarlyReturns(value) {
      applyStateEarlyReturns = !!value;
    },
    setApplyStateThrows(value) {
      applyStateThrows = !!value;
    },
    setApplyStateThrowsAfterLanding(value) {
      applyStateThrowsAfterLanding = !!value;
    },
    // A real event applying a state, the way state.js does: the revision moves
    // even when the state name is unchanged, and preview ownership is dropped.
    simulateRealStateChange(value) {
      currentState = value;
      displayRevision += 1;
      currentVisualSource = null;
    },
    setThemeReloadInProgress(value) {
      themeReloadInProgress = !!value;
    },
    cleanup() {
      runtime.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("mini animation cards include optional peek states only when the theme declares them", () => {
  const base = createRuntimeHarness({ activeTheme: makeTheme("/tmp", {
    miniMode: { supported: true, states: { "mini-idle": ["idle.svg"], "mini-peek": ["idle.svg"], "mini-sleep": ["sleep.svg"] } },
  }) });
  try {
    const cards = base.runtime.buildAnimationOverrideSections().find((section) => section.id === "mini").cards;
    assert.deepStrictEqual(cards.map((card) => card.stateKey), ["mini-idle", "mini-peek", "mini-sleep"]);
  } finally {
    base.cleanup();
  }

  const withOptional = createRuntimeHarness({ activeTheme: makeTheme("/tmp", {
    miniMode: { supported: true, states: {
      "mini-idle": ["idle.svg"], "mini-peek": ["idle.svg"],
      "mini-peek-hold": ["idle.svg"], "mini-sleep": ["sleep.svg"],
      "mini-sleep-peek": ["sleep.svg"],
    } },
  }) });
  try {
    const cards = withOptional.runtime.buildAnimationOverrideSections().find((section) => section.id === "mini").cards;
    assert.deepStrictEqual(cards.map((card) => card.stateKey),
      ["mini-idle", "mini-peek", "mini-peek-hold", "mini-sleep", "mini-sleep-peek"]);
  } finally {
    withOptional.cleanup();
  }
});

test("animation override IPC registers owned channels, delegates, and disposes", async () => {
  const ipcMain = new FakeIpcMain();
  const calls = [];
  const runtime = registerSettingsAnimationOverridesIpc({
    ipcMain,
    animationOverridesMain: {
      buildAnimationOverrideData: () => ({ status: "data" }),
      openThemeAssetsDir: () => ({ status: "opened" }),
      previewAnimationOverride: (payload) => {
        calls.push(["previewAnimationOverride", payload]);
        return { status: "previewed" };
      },
      previewReaction: (payload) => {
        calls.push(["previewReaction", payload]);
        return { status: "reaction" };
      },
      exportAnimationOverrides: (event) => {
        calls.push(["export", event.sender]);
        return { status: "exported" };
      },
      importAnimationOverrides: (event) => {
        calls.push(["import", event.sender]);
        return { status: "imported" };
      },
    },
  });

  assert.deepStrictEqual([...ipcMain.handlers.keys()].sort(), [
    "settings:export-animation-overrides",
    "settings:get-animation-overrides-data",
    "settings:import-animation-overrides",
    "settings:open-theme-assets-dir",
    "settings:preview-animation-override",
    "settings:preview-reaction",
  ]);
  assert.deepStrictEqual(await ipcMain.invoke("settings:get-animation-overrides-data"), { status: "data" });
  assert.deepStrictEqual(await ipcMain.invoke("settings:open-theme-assets-dir"), { status: "opened" });
  assert.deepStrictEqual(await ipcMain.invoke("settings:preview-animation-override", { file: "a.svg" }), { status: "previewed" });
  assert.deepStrictEqual(await ipcMain.invoke("settings:preview-reaction", { file: "b.svg" }), { status: "reaction" });
  assert.deepStrictEqual(await ipcMain.invoke("settings:export-animation-overrides"), { status: "exported" });
  assert.deepStrictEqual(await ipcMain.invoke("settings:import-animation-overrides"), { status: "imported" });
  assert.deepStrictEqual(calls, [
    ["previewAnimationOverride", { file: "a.svg" }],
    ["previewReaction", { file: "b.svg" }],
    ["export", "sender-web-contents"],
    ["import", "sender-web-contents"],
  ]);

  runtime.dispose();
  assert.strictEqual(ipcMain.handlers.size, 0);
});

test("external themes cannot forge trusted scripted preview permission", () => {
  const forgedTheme = {
    _id: "forged",
    _builtin: false,
    trustedRuntime: {
      scriptedSvgFiles: ["forged.svg"],
      scriptedSvgCycleMs: { "forged.svg": 3200 },
    },
  };

  assert.strictEqual(
    animationOverrideTest.isTrustedScriptedAnimationFile("forged.svg", forgedTheme),
    false
  );
  assert.strictEqual(
    animationOverrideTest.needsScriptedAnimationPreviewPoster("forged.svg", forgedTheme),
    false
  );
  assert.strictEqual(
    animationOverrideTest.getTrustedScriptedAnimationCycleMs("forged.svg", forgedTheme),
    null
  );
});

test("scripted SVG previews do not fall back to direct file URLs as poster images", () => {
  const harness = createRuntimeHarness();
  try {
    const preview = harness.runtime.buildAnimationAssetPreview("scripted.svg", harness.activeTheme);

    assert.strictEqual(preview.needsScriptedPreviewPoster, true);
    assert.strictEqual(preview.previewImageUrl, null);
    assert.strictEqual(preview.previewPosterPending, true);
    assert.ok(preview.fileUrl.startsWith("file:"));
    assert.ok(preview.previewPosterCacheKey.includes("|cloudling|scripted.svg|"));
  } finally {
    harness.cleanup();
  }
});

test("runtime exposes animation asset probes for mini-mode entry timing", () => {
  const harness = createRuntimeHarness();
  try {
    const probe = harness.runtime.buildAnimationAssetProbe("scripted.svg", harness.activeTheme);

    assert.deepStrictEqual(probe, {
      assetCycleMs: 5400,
      assetCycleStatus: "exact",
      assetCycleSource: "trusted-runtime",
    });
  } finally {
    harness.cleanup();
  }
});

test("external object-channel SVG previews require posters without getting trusted long holds", () => {
  const harness = createRuntimeHarness({
    themeOverrides: {
      _id: "external-object",
      _builtin: false,
      rendering: { svgChannel: "object" },
      trustedRuntime: {
        scriptedSvgFiles: ["scripted.svg"],
        scriptedSvgCycleMs: { "scripted.svg": 12000 },
      },
    },
  });
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const delays = [];
  try {
    global.setTimeout = (_fn, ms) => {
      delays.push(ms);
      return { fakeTimer: true };
    };
    global.clearTimeout = () => {};

    assert.strictEqual(
      animationOverrideTest.isTrustedScriptedAnimationFile("scripted.svg", harness.activeTheme),
      false
    );
    assert.strictEqual(
      animationOverrideTest.needsScriptedAnimationPreviewPoster("scripted.svg", harness.activeTheme),
      true
    );
    assert.deepStrictEqual(
      harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 12000 }),
      { status: "ok", applied: true }
    );
    assert.deepStrictEqual(delays, [animationOverrideTest.PREVIEW_HOLD_MAX_MS]);
  } finally {
    harness.cleanup();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("previews hold APNG and GIF files for their whole playthrough, bounded", () => {
  const cycles = {
    "long.apng": { ms: 15355, status: "exact", source: "apng" },
    "corrupt.apng": { ms: 900000, status: "exact", source: "apng" },
    "react.gif": { ms: 5628, status: "exact", source: "gif" },
    "zero-delay.apng": { ms: 4000, status: "estimated", source: "apng" },
    "smil.svg": { ms: 12000, status: "exact", source: "svg" },
  };
  const harness = createRuntimeHarness({
    animationCycle: {
      probeAssetCycle: (absPath) => cycles[path.basename(absPath)]
        || { ms: null, status: "unavailable", source: null },
    },
  });
  for (const name of Object.keys(cycles)) fs.writeFileSync(path.join(harness.assetsDir, name), "x");
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const delays = [];
  try {
    global.setTimeout = (_fn, ms) => {
      delays.push(ms);
      return { fakeTimer: true };
    };
    global.clearTimeout = () => {};

    const preview = (file, durationMs) => harness.runtime.previewAnimationOverride({ stateKey: "thinking", file, durationMs });
    preview("long.apng", 15355);
    preview("long.apng");
    preview("corrupt.apng", 900000);
    preview("react.gif", 5628);
    preview("zero-delay.apng", 4000);
    preview("smil.svg", 12000);
    preview("scripted.svg", 12000);
    preview("scripted.svg");
    assert.deepStrictEqual(delays, [
      15355,
      15355,
      animationOverrideTest.FRAME_TIMED_PREVIEW_HOLD_MAX_MS,
      5628,
      animationOverrideTest.PREVIEW_HOLD_MAX_MS,
      animationOverrideTest.PREVIEW_HOLD_MAX_MS,
      12000,
      5400,
    ]);

    harness.runtime.previewReaction({ file: "react.gif", durationMs: 5628 });
    harness.runtime.previewReaction({ file: "smil.svg", durationMs: 12000 });
    assert.deepStrictEqual(harness.stateCalls.filter((call) => call[0] === "sendToRenderer"), [
      ["sendToRenderer", "play-click-reaction", "react.gif", 5628, { settingsPreview: true }],
      ["sendToRenderer", "play-click-reaction", "smil.svg", animationOverrideTest.PREVIEW_HOLD_MAX_MS, { settingsPreview: true }],
    ]);
  } finally {
    harness.cleanup();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("poster descriptors snapshot theme id, basename, file URL, size, and mtime into the cache key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-anim-descriptor-"));
  try {
    const absPath = path.join(root, "scripted.svg");
    fs.writeFileSync(absPath, "<svg viewBox=\"0 0 10 10\"></svg>", "utf8");
    const descriptor = animationOverrideTest.buildAnimationPreviewPosterDescriptor(
      "../scripted.svg",
      { _id: "theme-a" },
      absPath
    );

    assert.strictEqual(descriptor.themeId, "theme-a");
    assert.strictEqual(descriptor.filename, "scripted.svg");
    assert.strictEqual(descriptor.absPath, absPath);
    assert.ok(descriptor.fileUrl.startsWith("file:"));
    assert.strictEqual(descriptor.posterVersion, animationOverrideTest.ANIMATION_OVERRIDE_PREVIEW_POSTER_VERSION);
    assert.ok(descriptor.size > 0);
    assert.ok(Number.isFinite(descriptor.mtime));
    assert.ok(descriptor.cacheKey.includes(`|theme-a|scripted.svg|${descriptor.size}|${descriptor.mtime}`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("animation preview requests defer while theme reload is in progress", () => {
  const harness = createRuntimeHarness({ themeReloadInProgress: true });
  try {
    assert.deepStrictEqual(
      harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 900 }),
      { status: "ok", deferred: true }
    );
    assert.deepStrictEqual(harness.stateCalls, []);

    harness.setThemeReloadInProgress(false);
    harness.runtime.runPendingPostReloadTasks();

    assert.deepStrictEqual(harness.stateCalls[0], ["applyState", "thinking", "scripted.svg", { settingsPreview: true }]);
  } finally {
    harness.cleanup();
  }
});

test("animation override cards expose theme-default wide hitbox state separately from the effective override state", () => {
  const harness = createRuntimeHarness({
    snapshot: {
      themeOverrides: {
        cloudling: {
          hitbox: {
            wide: {
              "scripted.svg": false,
            },
          },
        },
      },
    },
    activeThemeFactory: (root) => makeTheme(root, {
      wideHitboxFiles: [],
      _baseWideHitboxFiles: ["scripted.svg"],
    }),
  });
  try {
    const data = harness.runtime.buildAnimationOverrideData();
    const thinkingCard = data.cards.find((card) => card.stateKey === "thinking");

    assert.ok(thinkingCard);
    assert.strictEqual(thinkingCard.wideHitboxEnabled, false);
    assert.strictEqual(thinkingCard.wideHitboxThemeDefault, true);
    assert.strictEqual(thinkingCard.wideHitboxOverridden, true);
  } finally {
    harness.cleanup();
  }
});

test("animation override cards expose theme-default transition state separately from effective timing", () => {
  const harness = createRuntimeHarness({
    snapshot: {
      themeOverrides: {
        cloudling: {
          states: {
            thinking: {
              transition: { in: 160, out: 150 },
            },
          },
        },
      },
    },
    activeThemeFactory: (root) => makeTheme(root, {
      transitions: {
        "scripted.svg": { in: 160, out: 150 },
      },
      _baseTransitions: {
        "scripted.svg": { in: 150, out: 150 },
      },
    }),
  });
  try {
    const data = harness.runtime.buildAnimationOverrideData();
    const thinkingCard = data.cards.find((card) => card.stateKey === "thinking");

    assert.ok(thinkingCard);
    assert.deepStrictEqual(thinkingCard.transition, { in: 160, out: 150 });
    assert.deepStrictEqual(thinkingCard.transitionThemeDefault, { in: 150, out: 150 });
    assert.strictEqual(thinkingCard.hasTransitionOverride, true);
  } finally {
    harness.cleanup();
  }
});

test("animation override data builds tier cards with transition override metadata", () => {
  const harness = createRuntimeHarness({
    snapshot: {
      themeOverrides: {
        cloudling: {
          tiers: {
            workingTiers: {
              "scripted.svg": {
                transition: { in: 180, out: 150 },
              },
            },
          },
        },
      },
    },
    activeThemeFactory: (root) => makeTheme(root, {
      _bindingBase: {
        states: { idle: "idle.svg", thinking: "scripted.svg", sleeping: "sleep.svg" },
        workingTiers: [{ originalFile: "scripted.svg" }],
        jugglingTiers: [],
        displayHintMap: {},
      },
      workingTiers: [
        { file: "scripted.svg", minSessions: 2 },
      ],
      transitions: {
        "scripted.svg": { in: 180, out: 150 },
      },
      _baseTransitions: {
        "scripted.svg": { in: 150, out: 150 },
      },
    }),
  });
  try {
    const data = harness.runtime.buildAnimationOverrideData();
    const tierCard = data.cards.find((card) => card.id === "workingTiers:scripted.svg");

    assert.ok(tierCard);
    assert.strictEqual(tierCard.hasTransitionOverride, true);
    assert.deepStrictEqual(tierCard.transition, { in: 180, out: 150 });
    assert.deepStrictEqual(tierCard.transitionThemeDefault, { in: 150, out: 150 });
  } finally {
    harness.cleanup();
  }
});

test("multi-file tier cards show and override the first file of the pool", () => {
  const harness = createRuntimeHarness({
    activeThemeFactory: (root) => makeTheme(root, {
      _bindingBase: {
        states: { idle: "idle.svg", thinking: "scripted.svg", sleeping: "sleep.svg" },
        workingTiers: [{ minSessions: 2, originalFile: "idle.svg" }, { minSessions: 1, originalFile: "scripted.svg" }],
        jugglingTiers: [],
        displayHintMap: {},
      },
      workingTiers: [
        { minSessions: 2, files: ["idle.svg", "sleep.svg"] },
        { minSessions: 1, file: "scripted.svg" },
      ],
    }),
  });
  try {
    const data = harness.runtime.buildAnimationOverrideData();
    const poolCard = data.cards.find((card) => card.id === "workingTiers:idle.svg");
    const singleCard = data.cards.find((card) => card.id === "workingTiers:scripted.svg");

    assert.ok(poolCard);
    assert.strictEqual(poolCard.originalFile, "idle.svg");
    assert.strictEqual(poolCard.currentFile, "idle.svg");
    assert.strictEqual(poolCard.bindingLabel, "workingTiers[idle.svg].files[0]");
    assert.ok(singleCard);
    assert.strictEqual(singleCard.currentFile, "scripted.svg");
    assert.strictEqual(singleCard.bindingLabel, "workingTiers[scripted.svg]");
  } finally {
    harness.cleanup();
  }
});

// #509: default idle visual picker payload
test("animation override data exposes idle visual options and the current selection", () => {
  const harness = createRuntimeHarness({
    snapshot: {
      themeOverrides: {},
      idleVisual: { cloudling: "idle-drift.svg" },
    },
    activeThemeFactory: (root) => makeTheme(root, {
      idleAnimations: [
        { file: "idle-drift.svg", duration: 4000 },
        { file: "idle-nap.svg", duration: 6000 },
      ],
    }),
  });
  try {
    const data = harness.runtime.buildAnimationOverrideData();
    const info = data.idleDefaultVisual;

    assert.ok(info);
    assert.strictEqual(info.themeId, "cloudling");
    assert.strictEqual(info.selectedFile, "idle-drift.svg");
    assert.deepStrictEqual(info.options, [
      { file: "idle.svg", isThemeDefault: true, label: "Idle" },
      { file: "idle-drift.svg", isThemeDefault: false, label: "Idle Drift" },
      { file: "idle-nap.svg", isThemeDefault: false, label: "Idle Nap" },
    ]);
  } finally {
    harness.cleanup();
  }
});

test("selectable-only idle art appears in the picker without an animation card", () => {
  const harness = createRuntimeHarness({
    snapshot: { themeOverrides: {}, idleVisual: { cloudling: "pool.apng" } },
    activeThemeFactory: (root) => makeTheme(root, {
      idleAnimations: [],
      idleVisualOptions: [{ file: "pool.apng" }],
    }),
  });
  try {
    const data = harness.runtime.buildAnimationOverrideData();
    assert.deepStrictEqual(data.idleDefaultVisual.options.map((option) => option.file), ["idle.svg", "pool.apng"]);
    assert.strictEqual(data.idleDefaultVisual.selectedFile, "pool.apng");
    assert.ok(!data.cards.some((card) => card.id === "idleAnimations:pool.apng"));
  } finally {
    harness.cleanup();
  }
});

test("idle visual payload is null when the theme has no idle variants", () => {
  const harness = createRuntimeHarness();
  try {
    const data = harness.runtime.buildAnimationOverrideData();
    assert.strictEqual(data.idleDefaultVisual, null);
  } finally {
    harness.cleanup();
  }
});

function withFakeTimers(run) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return { fakeTimer: timers.length };
  };
  global.clearTimeout = () => {};
  try {
    return run(timers);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

test("a finished preview hands the pet back to the live state instead of forcing idle", () => {
  const harness = createRuntimeHarness();
  try {
    withFakeTimers((timers) => {
      harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 5000 });
      // A real session starts working while the preview is still up: previews
      // now run for a whole playthrough, so this is an ordinary case.
      harness.setDisplayState("working");
      timers[timers.length - 1].fn();
    });

    assert.deepStrictEqual(harness.stateCalls, [
      ["applyState", "thinking", "scripted.svg", { settingsPreview: true }],
      ["applyState", "working", "working.svg", { muteStateSounds: true }],
    ]);
  } finally {
    harness.cleanup();
  }
});

test("a replaced or cancelled preview cannot restore state afterwards", () => {
  const harness = createRuntimeHarness();
  try {
    withFakeTimers((timers) => {
      harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 5000 });
      harness.runtime.previewAnimationOverride({ stateKey: "sleeping", file: "sleep.svg", durationMs: 5000 });
      timers[0].fn();

      assert.deepStrictEqual(harness.stateCalls, [
        ["applyState", "thinking", "scripted.svg", { settingsPreview: true }],
        ["applyState", "sleeping", "sleep.svg", { settingsPreview: true }],
      ]);

      harness.runtime.cancelAnimationPreview();
      timers[1].fn();
    });

    assert.deepStrictEqual(harness.stateCalls.slice(2), [
      ["sendToRenderer", "cancel-click-reaction"],
      ["applyState", "idle", "idle.svg", { muteStateSounds: true }],
    ]);
  } finally {
    harness.cleanup();
  }
});

test("cancelling a reaction-only preview never re-applies state", () => {
  const harness = createRuntimeHarness();
  try {
    // Nothing is running: the renderer cancel is idempotent and still goes out,
    // but the pet's state must not be touched.
    assert.deepStrictEqual(harness.runtime.cancelAnimationPreview(), { status: "ok", restoredState: false });
    assert.deepStrictEqual(harness.stateCalls, [["sendToRenderer", "cancel-click-reaction"]]);

    // A reaction preview lives in the renderer and never overwrote the state,
    // so cancelling it must not run applyState — that would restart autoReturn
    // timing, clear idlePaused and replay one-shot cues.
    harness.runtime.previewReaction({ file: "idle.svg", durationMs: 3000 });
    assert.deepStrictEqual(harness.runtime.cancelAnimationPreview(), { status: "ok", restoredState: false });

    assert.deepStrictEqual(harness.stateCalls, [
      ["sendToRenderer", "cancel-click-reaction"],
      ["sendToRenderer", "play-click-reaction", "idle.svg", 3000, { settingsPreview: true }],
      ["sendToRenderer", "cancel-click-reaction"],
    ]);
  } finally {
    harness.cleanup();
  }
});

test("cancelling a state preview hands the pet back once", () => {
  const harness = createRuntimeHarness();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  try {
    global.setTimeout = () => ({ fakeTimer: true });
    global.clearTimeout = () => {};
    harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 5000 });

    assert.deepStrictEqual(harness.runtime.cancelAnimationPreview(), { status: "ok", restoredState: true });
    // A second cancel has nothing left to hand back.
    assert.deepStrictEqual(harness.runtime.cancelAnimationPreview(), { status: "ok", restoredState: false });

    assert.deepStrictEqual(harness.stateCalls, [
      ["applyState", "thinking", "scripted.svg", { settingsPreview: true }],
      ["sendToRenderer", "cancel-click-reaction"],
      ["applyState", "idle", "idle.svg", { muteStateSounds: true }],
      ["sendToRenderer", "cancel-click-reaction"],
    ]);
  } finally {
    harness.cleanup();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("an early-returning applyState leaves no preview owner to release", () => {
  const harness = createRuntimeHarness({ applyStateEarlyReturns: true });
  try {
    assert.deepStrictEqual(
      harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 5000 }),
      { status: "ok", applied: false }
    );
    // The preview never took the visual, so a cancel must only cancel the
    // renderer reaction and must not re-apply state.
    assert.deepStrictEqual(harness.runtime.cancelAnimationPreview(), { status: "ok", restoredState: false });
    assert.deepStrictEqual(harness.stateCalls, [
      ["applyState", "thinking", "scripted.svg", { settingsPreview: true }],
      ["sendToRenderer", "cancel-click-reaction"],
    ]);
  } finally {
    harness.cleanup();
  }
});

test("a preview that fails to land hands the previous preview back", () => {
  const harness = createRuntimeHarness();
  try {
    withFakeTimers(() => {
      assert.deepStrictEqual(
        harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 5000 }),
        { status: "ok", applied: true }
      );
      // B clears A's timer, then early-returns: A is still on screen but would
      // have no recovery path unless the failure hands it back.
      harness.setApplyStateEarlyReturns(true);
      assert.deepStrictEqual(
        harness.runtime.previewAnimationOverride({ stateKey: "sleeping", file: "sleep.svg", durationMs: 5000 }),
        { status: "ok", applied: false }
      );
      harness.setApplyStateEarlyReturns(false);
    });
    assert.deepStrictEqual(harness.stateCalls, [
      ["applyState", "thinking", "scripted.svg", { settingsPreview: true }],
      ["applyState", "sleeping", "sleep.svg", { settingsPreview: true }],
      ["applyState", "idle", "idle.svg", { muteStateSounds: true }],
    ]);
    // Ownership is gone, so a later cancel must not apply state again.
    assert.deepStrictEqual(harness.runtime.cancelAnimationPreview(), { status: "ok", restoredState: false });
    assert.deepStrictEqual(harness.stateCalls.slice(3), [["sendToRenderer", "cancel-click-reaction"]]);
  } finally {
    harness.cleanup();
  }
});

test("a preview that throws hands the previous preview back", () => {
  const harness = createRuntimeHarness();
  try {
    withFakeTimers(() => {
      harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 5000 });
      harness.setApplyStateThrows(true);
      const result = harness.runtime.previewAnimationOverride({ stateKey: "sleeping", file: "sleep.svg", durationMs: 5000 });
      assert.strictEqual(result.status, "error");
      harness.setApplyStateThrows(false);
    });
    assert.deepStrictEqual(harness.stateCalls, [
      ["applyState", "thinking", "scripted.svg", { settingsPreview: true }],
      ["applyState", "sleeping", "sleep.svg", { settingsPreview: true }],
      ["applyState", "idle", "idle.svg", { muteStateSounds: true }],
    ]);
    assert.deepStrictEqual(harness.runtime.cancelAnimationPreview(), { status: "ok", restoredState: false });
  } finally {
    harness.cleanup();
  }
});

test("a preview that throws after taking the visual is handed back immediately", () => {
  const harness = createRuntimeHarness();
  try {
    withFakeTimers(() => {
      // The apply lands (revision advances + preview owner) and only then
      // throws — the pet would otherwise be stuck on the preview with no timer.
      harness.setApplyStateThrowsAfterLanding(true);
      const result = harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 5000 });
      assert.strictEqual(result.status, "error");
    });
    assert.deepStrictEqual(harness.stateCalls, [
      ["applyState", "thinking", "scripted.svg", { settingsPreview: true }],
      ["applyState", "idle", "idle.svg", { muteStateSounds: true }],
    ]);
    // Ownership is gone, so a later cancel must not apply state again.
    assert.deepStrictEqual(harness.runtime.cancelAnimationPreview(), { status: "ok", restoredState: false });
    assert.deepStrictEqual(harness.stateCalls.slice(2), [["sendToRenderer", "cancel-click-reaction"]]);
  } finally {
    harness.cleanup();
  }
});

test("a partial landing after a previous preview hands back by its own revision", () => {
  const harness = createRuntimeHarness();
  try {
    withFakeTimers(() => {
      harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 5000 });
      // B replaces A and then fails. The hand-back must be judged from B's
      // revision; A's recorded revision no longer matches the shown visual.
      harness.setApplyStateThrowsAfterLanding(true);
      const result = harness.runtime.previewAnimationOverride({ stateKey: "sleeping", file: "sleep.svg", durationMs: 5000 });
      assert.strictEqual(result.status, "error");
    });
    assert.deepStrictEqual(harness.stateCalls, [
      ["applyState", "thinking", "scripted.svg", { settingsPreview: true }],
      ["applyState", "sleeping", "sleep.svg", { settingsPreview: true }],
      ["applyState", "idle", "idle.svg", { muteStateSounds: true }],
    ]);
    assert.deepStrictEqual(harness.runtime.cancelAnimationPreview(), { status: "ok", restoredState: false });
    assert.deepStrictEqual(harness.stateCalls.slice(3), [["sendToRenderer", "cancel-click-reaction"]]);
  } finally {
    harness.cleanup();
  }
});

test("a mini-working preview keeps ownership and is handed back by the settings timer", () => {
  const cloudling = themeLoader.loadTheme("cloudling");
  const { api } = createRealStateRuntime({ theme: cloudling, miniMode: true });
  const harness = createRuntimeHarness({ stateRuntime: api, activeTheme: cloudling });
  try {
    withFakeTimers((timers) => {
      assert.deepStrictEqual(
        harness.runtime.previewAnimationOverride({ stateKey: "working", file: "working.svg", durationMs: 900 }),
        { status: "ok", applied: true }
      );
      // Cloudling maps working → mini-working; the ownership marker must
      // survive that remap or the preview stays on screen forever.
      assert.strictEqual(api.getCurrentState(), "mini-working");
      assert.strictEqual(api.isSettingsPreviewVisual(), true);
      assert.strictEqual(timers.length, 1, "only the hand-back timer should be scheduled");
      assert.strictEqual(timers[0].ms, 900);
      timers[0].fn();
    });
    assert.strictEqual(api.isSettingsPreviewVisual(), false, "hand-back must release the preview owner");
    assert.strictEqual(api.getCurrentState(), "mini-idle");
  } finally {
    harness.cleanup();
    api.cleanup();
  }
});

test("preview holds keep their documented floor and ceilings", () => {
  assert.strictEqual(animationOverrideTest.PREVIEW_HOLD_MIN_MS, 800);
  assert.strictEqual(animationOverrideTest.PREVIEW_HOLD_MAX_MS, 3500);
  assert.strictEqual(animationOverrideTest.TRUSTED_SCRIPTED_PREVIEW_HOLD_MAX_MS, 15000);
  assert.strictEqual(animationOverrideTest.FRAME_TIMED_PREVIEW_HOLD_MAX_MS, 60000);

  const harness = createRuntimeHarness();
  try {
    const delays = withFakeTimers((timers) => {
      harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "sleep.svg", durationMs: 1 });
      harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 20000 });
      return timers.map((timer) => timer.ms);
    });

    assert.deepStrictEqual(delays, [
      animationOverrideTest.PREVIEW_HOLD_MIN_MS,
      animationOverrideTest.TRUSTED_SCRIPTED_PREVIEW_HOLD_MAX_MS,
    ]);
  } finally {
    harness.cleanup();
  }
});

test("only the newest deferred preview survives a theme reload, and a cancel voids it", () => {
  const harness = createRuntimeHarness({ themeReloadInProgress: true });
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  try {
    global.setTimeout = () => ({ fakeTimer: true });
    global.clearTimeout = () => {};

    harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 5000 });
    harness.runtime.previewAnimationOverride({ stateKey: "sleeping", file: "sleep.svg", durationMs: 5000 });
    harness.setThemeReloadInProgress(false);
    harness.runtime.runPendingPostReloadTasks();

    // Replaying the superseded request would restart autoReturn timing and,
    // for a one-shot, replay its cue.
    assert.deepStrictEqual(harness.stateCalls, [["applyState", "sleeping", "sleep.svg", { settingsPreview: true }]]);

    // Settle the preview that just ran, so the next cancel has only the
    // deferred request left to void. The queued task stays in the queue; its
    // generation is what stops it.
    harness.runtime.cancelAnimationPreview();
    harness.stateCalls.length = 0;
    harness.setThemeReloadInProgress(true);
    harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 5000 });
    harness.runtime.cancelAnimationPreview();
    harness.setThemeReloadInProgress(false);
    harness.runtime.runPendingPostReloadTasks();

    assert.deepStrictEqual(harness.stateCalls, [["sendToRenderer", "cancel-click-reaction"]]);
  } finally {
    harness.cleanup();
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("a preview the live state has taken over is not handed back", () => {
  const harness = createRuntimeHarness();
  try {
    withFakeTimers((timers) => {
      harness.runtime.previewAnimationOverride({ stateKey: "thinking", file: "scripted.svg", durationMs: 5000 });
      // A finishing task takes the pet over mid-preview: attention is playing,
      // and the session that produced it is already stored as idle.
      harness.simulateRealStateChange("attention");
      harness.setDisplayState("idle");
      timers[timers.length - 1].fn();
    });

    // Handing back here would apply idle and cut the attention clip short.
    assert.deepStrictEqual(harness.stateCalls, [["applyState", "thinking", "scripted.svg", { settingsPreview: true }]]);

    // Closing Settings afterwards must not do it either.
    assert.deepStrictEqual(harness.runtime.cancelAnimationPreview(), { status: "ok", restoredState: false });
    assert.deepStrictEqual(harness.stateCalls, [
      ["applyState", "thinking", "scripted.svg", { settingsPreview: true }],
      ["sendToRenderer", "cancel-click-reaction"],
    ]);
  } finally {
    harness.cleanup();
  }
});

test("a preview is not handed back when a real event re-applies the same state", () => {
  const harness = createRuntimeHarness();
  try {
    withFakeTimers((timers) => {
      harness.runtime.previewAnimationOverride({ stateKey: "attention", file: "scripted.svg", durationMs: 5000 });
      // A task finishes into attention as well: the state name never changes,
      // so only the display revision can tell the two apart.
      harness.simulateRealStateChange("attention");
      harness.setDisplayState("idle");
      timers[timers.length - 1].fn();
    });

    // Handing back would apply idle over the completion animation that just
    // started playing for real.
    assert.deepStrictEqual(harness.stateCalls, [["applyState", "attention", "scripted.svg", { settingsPreview: true }]]);
    assert.deepStrictEqual(harness.runtime.cancelAnimationPreview(), { status: "ok", restoredState: false });
  } finally {
    harness.cleanup();
  }
});
