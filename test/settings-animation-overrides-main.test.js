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
    animationCycle: {
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
    getStateRuntime: () => ({
      applyState: (...args) => stateCalls.push(["applyState", ...args]),
      resolveDisplayState: () => "idle",
      getSvgOverride: (state) => `${state}.svg`,
    }),
    sendToRenderer: (...args) => stateCalls.push(["sendToRenderer", ...args]),
  });

  return {
    activeTheme,
    assetsDir,
    runtime,
    root,
    stateCalls,
    setThemeReloadInProgress(value) {
      themeReloadInProgress = !!value;
    },
    cleanup() {
      runtime.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

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
      { status: "ok" }
    );
    assert.deepStrictEqual(delays, [animationOverrideTest.PREVIEW_HOLD_MAX_MS]);
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

    assert.deepStrictEqual(harness.stateCalls[0], ["applyState", "thinking", "scripted.svg"]);
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
