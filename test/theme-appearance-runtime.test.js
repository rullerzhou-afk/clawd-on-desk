"use strict";

const { describe, it, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createThemeRuntime = require("../src/theme-runtime");
const themeLoader = require("../src/theme-loader");

const REQUIRED_STATES = [
  "idle",
  "yawning",
  "dozing",
  "collapsing",
  "thinking",
  "working",
  "sleeping",
  "waking",
];

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';

const tempDirs = [];

afterEach(() => {
  mock.restoreAll();
  themeLoader.bindActiveThemeRuntime(null);
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function validThemeJson(overrides = {}) {
  return {
    schemaVersion: 1,
    name: "Theme",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states: Object.fromEntries(REQUIRED_STATES.map((state) => [state, [`${state}.svg`]])),
    ...overrides,
  };
}

function writeThemeFiles(themeDir, json, { dark = false } = {}) {
  fs.mkdirSync(themeDir, { recursive: true });
  fs.writeFileSync(path.join(themeDir, "theme.json"), JSON.stringify(json), "utf8");
  for (const dirName of dark ? ["assets", "assets-dark"] : ["assets"]) {
    const assetsDir = path.join(themeDir, dirName);
    fs.mkdirSync(assetsDir, { recursive: true });
    for (const state of REQUIRED_STATES) {
      fs.writeFileSync(path.join(assetsDir, `${state}.svg`), SVG, "utf8");
    }
  }
}

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-theme-appearance-runtime-"));
  tempDirs.push(tmp);
  const appDir = path.join(tmp, "src");
  const userData = path.join(tmp, "userData");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "svg"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "sounds"), { recursive: true });

  writeThemeFiles(path.join(tmp, "themes", "clawd"), validThemeJson({ name: "Clawd" }));
  writeThemeFiles(
    path.join(userData, "themes", "night"),
    validThemeJson({
      name: "Night",
      appearance: { dark: { assetsDir: "assets-dark" } },
    }),
    { dark: true }
  );

  themeLoader.init(appDir, userData);
  themeLoader.bindActiveThemeRuntime(null);
  return { tmp, appDir, userData };
}

function createSettingsController(initial = {}) {
  const values = {
    themeVariant: {},
    themeOverrides: {},
    themeAppearance: {},
    ...initial,
  };
  return {
    values,
    get(key) {
      return values[key];
    },
  };
}

function createRuntime(options = {}) {
  const calls = [];
  const settings = options.settings || createSettingsController();
  const stateRuntime = {
    cleanup: () => calls.push("state.cleanup"),
    refreshTheme: () => calls.push("state.refreshTheme"),
    ...(options.stateRuntime || {}),
  };
  const tickRuntime = {
    cleanup: () => calls.push("tick.cleanup"),
    refreshTheme: () => calls.push("tick.refreshTheme"),
    ...(options.tickRuntime || {}),
  };
  const miniRuntime = {
    cleanup: () => calls.push("mini.cleanup"),
    refreshTheme: () => calls.push("mini.refreshTheme"),
    getMiniMode: () => false,
    getMiniTransitioning: () => false,
    handleDisplayChange: () => calls.push("mini.handleDisplayChange"),
    exitMiniMode: () => calls.push("mini.exitMiniMode"),
    ...(options.miniRuntime || {}),
  };
  let finishReload = null;
  const sequencer = {
    run(callbacks) {
      calls.push("sequencer.run");
      if (options.deferSequencerFinish) {
        finishReload = callbacks.onReloadFinished;
        return;
      }
      callbacks.onReloadFinished();
    },
    cleanup: () => calls.push("sequencer.cleanup"),
    ...(options.sequencer || {}),
  };
  const runtime = createThemeRuntime({
    themeLoader,
    settingsController: settings,
    getRenderWindow: () => options.renderWindow === null
      ? null
      : { isDestroyed: () => false },
    getHitWindow: () => ({ isDestroyed: () => false }),
    getStateRuntime: () => stateRuntime,
    getTickRuntime: () => tickRuntime,
    getMiniRuntime: () => miniRuntime,
    getFadeSequencer: () => sequencer,
    getSystemPrefersDark: options.getSystemPrefersDark || (() => false),
    getPetWindowBounds: () => ({ x: 10, y: 20, width: 100, height: 100 }),
    applyPetWindowBounds: (bounds) => calls.push(["applyBounds", bounds]),
    computeFinalDragBounds: () => null,
    clampToScreenVisual: (x, y) => ({ x, y }),
    flushRuntimeStateToPrefs: () => calls.push("flushPrefs"),
    syncHitStateAfterLoad: () => calls.push("syncHitState"),
    syncRendererStateAfterLoad: () => calls.push("syncRendererState"),
    syncHitWin: () => calls.push("syncHitWin"),
    syncSessionHudVisibility: () => calls.push("syncSessionHud"),
    startMainTick: () => calls.push("startMainTick"),
    invalidateDisplayedVisual: (detail) => calls.push(["invalidateDisplayedVisual", detail]),
    refreshDisplayedVisualHitBoxes: () => calls.push("refreshDisplayedVisualHitBoxes"),
    getAnimationOverridesRuntime: () => options.animationOverrides || null,
    bumpAnimationOverridePreviewPosterGeneration: () => calls.push("bumpPoster"),
    rebuildAllMenus: () => calls.push("rebuildMenus"),
  });
  return {
    runtime,
    calls,
    settings,
    finishPendingReload() {
      assert.strictEqual(typeof finishReload, "function", "no reload is waiting");
      finishReload();
    },
  };
}

describe("issue #1323: theme runtime appearance", () => {
  it("issue #1323: same theme and request returns early, light to dark reloads", () => {
    makeFixture();
    let systemDark = false;
    const { runtime, calls, settings } = createRuntime({ getSystemPrefersDark: () => systemDark });
    runtime.loadInitialTheme("night");
    assert.strictEqual(runtime.getActiveTheme()._appearance, "light");

    assert.deepStrictEqual(runtime.activateTheme("night"), { themeId: "night", variantId: "default" });
    assert.deepStrictEqual(calls, []);

    systemDark = true;
    settings.values.themeAppearance = {};
    runtime.syncActiveThemeAppearance();

    assert.strictEqual(runtime.getActiveTheme()._appearance, "dark");
    assert.ok(calls.includes("state.cleanup"));
    assert.ok(calls.includes("bumpPoster"));
  });

  it("issue #1323: a theme without dark support never reloads for a system flip", () => {
    makeFixture();
    let systemDark = false;
    const { runtime, calls } = createRuntime({ getSystemPrefersDark: () => systemDark });
    runtime.loadInitialTheme("clawd");

    systemDark = true;
    runtime.syncActiveThemeAppearance();
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(runtime.activateTheme("clawd"), { themeId: "clawd", variantId: "default" });
    assert.deepStrictEqual(calls, []);
  });

  it("issue #1323: hitbox refreshes keep the dark appearance", () => {
    makeFixture();
    const { runtime } = createRuntime({ getSystemPrefersDark: () => true });
    runtime.loadInitialTheme("night");
    assert.strictEqual(runtime.getActiveTheme()._appearance, "dark");

    runtime.refreshActiveThemeHitboxOverrides("night", {
      hitbox: { wide: { "thinking.svg": true } },
    });

    const theme = runtime.getActiveTheme();
    assert.strictEqual(theme._appearance, "dark");
    assert.strictEqual(theme._assetsSourceDir, path.join(runtime.getActiveTheme()._themeDir, "assets-dark"));
    assert.strictEqual(theme._appearanceRequest, "dark");
  });

  it("issue #1323: follow-system flips reload once while a fixed light choice does not", () => {
    makeFixture();
    let systemDark = false;
    const follow = createRuntime({ getSystemPrefersDark: () => systemDark });
    follow.runtime.loadInitialTheme("night");
    systemDark = true;
    follow.runtime.syncActiveThemeAppearance();
    assert.strictEqual(follow.runtime.getActiveTheme()._appearance, "dark");

    makeFixture();
    systemDark = false;
    const settings = createSettingsController({ themeAppearance: { night: "light" } });
    const fixed = createRuntime({ settings, getSystemPrefersDark: () => systemDark });
    fixed.runtime.loadInitialTheme("night");
    systemDark = true;
    fixed.runtime.syncActiveThemeAppearance();
    assert.strictEqual(fixed.runtime.getActiveTheme()._appearance, "light");
  });

  it("issue #1323: a not-ready window makes the sync a no-op", () => {
    makeFixture();
    let systemDark = true;
    const warn = mock.method(console, "warn", () => {});
    const { runtime, calls } = createRuntime({
      getSystemPrefersDark: () => systemDark,
      renderWindow: null,
    });
    runtime.loadInitialTheme("night");
    systemDark = false;
    assert.doesNotThrow(() => runtime.syncActiveThemeAppearance());
    assert.strictEqual(runtime.getActiveTheme()._appearance, "dark");
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(warn.mock.callCount(), 0, "the sync must return before attempting a reload");
  });

  it("issue #1323: a throwing reload is reported without escaping the sync", () => {
    makeFixture();
    let systemDark = true;
    const warn = mock.method(console, "warn", () => {});
    const { runtime } = createRuntime({ getSystemPrefersDark: () => systemDark });
    runtime.loadInitialTheme("night");
    const load = mock.method(themeLoader, "loadTheme", () => {
      throw new Error("load exploded");
    });
    systemDark = false;

    assert.doesNotThrow(() => runtime.syncActiveThemeAppearance());
    assert.strictEqual(load.mock.callCount(), 1);
    assert.ok(warn.mock.calls.some((call) => call.arguments.join(" ").includes("appearance")));
  });

  it("issue #1323: a flip during a reload queues exactly one follow-up reload", () => {
    makeFixture();
    let systemDark = true;
    const { runtime, calls, finishPendingReload } = createRuntime({
      getSystemPrefersDark: () => systemDark,
      deferSequencerFinish: true,
    });
    const load = mock.method(themeLoader, "loadTheme");
    runtime.loadInitialTheme("night");
    runtime.reloadActiveTheme();
    assert.strictEqual(runtime.isReloadInProgress(), true);

    systemDark = false;
    runtime.syncActiveThemeAppearance();
    assert.strictEqual(runtime.getActiveTheme()._appearance, "dark");

    finishPendingReload();
    assert.strictEqual(runtime.getActiveTheme()._appearance, "light");
    assert.strictEqual(load.mock.callCount(), 3);
    assert.ok(calls.includes("sequencer.run"));
  });

  it("issue #1323: a queued flip that resolves to the current appearance does not reload", () => {
    makeFixture();
    let systemDark = false;
    const settings = createSettingsController({ themeAppearance: {} });
    const { runtime, finishPendingReload } = createRuntime({
      settings,
      getSystemPrefersDark: () => systemDark,
      deferSequencerFinish: true,
    });
    const load = mock.method(themeLoader, "loadTheme");
    runtime.loadInitialTheme("night");
    runtime.reloadActiveTheme();

    systemDark = true;
    runtime.syncActiveThemeAppearance();
    settings.values.themeAppearance = { night: "light" };

    finishPendingReload();
    assert.strictEqual(runtime.getActiveTheme()._appearance, "light");
    assert.strictEqual(load.mock.callCount(), 2);
  });

  it("issue #1323: repairing dark resources lets a forced reload pick them up", () => {
    const fixture = makeFixture();
    const nightDir = path.join(fixture.userData, "themes", "night");
    fs.rmSync(path.join(nightDir, "assets-dark"), { recursive: true, force: true });
    const settings = createSettingsController({ themeAppearance: { night: "dark" } });
    const { runtime } = createRuntime({ settings });
    runtime.loadInitialTheme("night");
    assert.strictEqual(runtime.getActiveTheme()._appearance, "light");
    assert.strictEqual(runtime.getActiveTheme()._appearanceRequest, "light");
    assert.strictEqual(runtime.getActiveTheme()._capabilities.darkAppearance, false);

    fs.mkdirSync(path.join(nightDir, "assets-dark"), { recursive: true });
    for (const state of REQUIRED_STATES) {
      fs.writeFileSync(path.join(nightDir, "assets-dark", `${state}.svg`), SVG, "utf8");
    }
    runtime.reloadActiveTheme();

    assert.strictEqual(runtime.getActiveTheme()._appearance, "dark");
    assert.strictEqual(runtime.getActiveTheme()._appearanceRequest, "dark");
  });

  it("issue #1323: activating the same theme directly picks up a new appearance preference", () => {
    makeFixture();
    const settings = createSettingsController({ themeAppearance: { night: "light" } });
    const { runtime } = createRuntime({ settings });
    runtime.loadInitialTheme("night");
    assert.strictEqual(runtime.getActiveTheme()._appearance, "light");

    settings.values.themeAppearance = { night: "dark" };
    runtime.activateTheme("night");

    assert.strictEqual(runtime.getActiveTheme()._appearance, "dark");
    assert.strictEqual(runtime.getActiveTheme()._appearanceRequest, "dark");
  });

  it("issue #1323: removing a user theme also clears its theme cache", () => {
    const fixture = makeFixture();
    const { runtime } = createRuntime();
    runtime.loadInitialTheme("night");
    const cacheDir = path.join(fixture.userData, "theme-cache", "night");
    assert.ok(fs.existsSync(cacheDir));

    runtime.removeThemeDir("night");

    assert.ok(!fs.existsSync(path.join(fixture.userData, "themes", "night")));
    assert.ok(!fs.existsSync(cacheDir));
  });
});
