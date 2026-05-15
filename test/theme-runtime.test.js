"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createThemeRuntime = require("../src/theme-runtime");
const themeLoader = require("../src/theme-loader");

const SRC_DIR = path.join(__dirname, "..", "src");
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

const tempDirs = [];

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

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-theme-runtime-"));
  tempDirs.push(tmp);
  const appDir = path.join(tmp, "src");
  const userData = path.join(tmp, "userData");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "svg"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "sounds"), { recursive: true });
  for (const id of ["clawd", "calico"]) {
    const themeDir = path.join(tmp, "themes", id);
    fs.mkdirSync(themeDir, { recursive: true });
    fs.writeFileSync(
      path.join(themeDir, "theme.json"),
      JSON.stringify(validThemeJson({
        name: id,
        variants: id === "clawd"
          ? {
              default: { name: "Default" },
              cozy: {
                name: "Cozy",
                timings: { idleMouseMoveThreshold: 42 },
              },
            }
          : undefined,
      })),
      "utf8"
    );
  }
  themeLoader.init(appDir, userData);
  themeLoader.bindActiveThemeRuntime(null);
  return { tmp, appDir, userData };
}

function createSettingsController(overrides = {}) {
  const values = {
    themeVariant: {},
    themeOverrides: {},
    ...overrides,
  };
  return {
    get(key) {
      return values[key];
    },
  };
}

function createRuntime(options = {}) {
  const calls = [];
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
  const sequencer = {
    run(callbacks) {
      calls.push("sequencer.run");
      if (options.deferSequencerFinish) {
        return;
      }
      callbacks.onReloadFinished();
    },
    cleanup: () => calls.push("sequencer.cleanup"),
    ...(options.sequencer || {}),
  };
  const runtime = createThemeRuntime({
    themeLoader,
    settingsController: createSettingsController(options.settings || {}),
    getRenderWindow: () => ({ isDestroyed: () => false }),
    getHitWindow: () => ({ isDestroyed: () => false }),
    getStateRuntime: () => stateRuntime,
    getTickRuntime: () => tickRuntime,
    getMiniRuntime: () => miniRuntime,
    getFadeSequencer: () => sequencer,
    getPetWindowBounds: () => options.petWindowBounds || { x: 10, y: 20, width: 100, height: 100 },
    applyPetWindowBounds: (bounds) => calls.push(["applyBounds", bounds]),
    computeFinalDragBounds: (...args) => (
      typeof options.computeFinalDragBounds === "function"
        ? options.computeFinalDragBounds(...args)
        : null
    ),
    clampToScreenVisual: (x, y) => ({ x, y }),
    flushRuntimeStateToPrefs: () => calls.push("flushPrefs"),
    syncHitStateAfterLoad: () => calls.push("syncHitState"),
    syncRendererStateAfterLoad: () => calls.push("syncRendererState"),
    syncHitWin: () => calls.push("syncHitWin"),
    syncSessionHudVisibility: () => calls.push("syncSessionHud"),
    startMainTick: () => calls.push("startMainTick"),
    bumpAnimationOverridePreviewPosterGeneration: () => calls.push("bumpPoster"),
    rebuildAllMenus: () => calls.push("rebuildMenus"),
  });
  return { runtime, calls };
}

afterEach(() => {
  themeLoader.bindActiveThemeRuntime(null);
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("theme-runtime active ownership", () => {
  it("keeps active theme caches out of theme-loader and deferred wrappers out of main", () => {
    const loaderSource = fs.readFileSync(path.join(SRC_DIR, "theme-loader.js"), "utf8");
    const mainSource = fs.readFileSync(path.join(SRC_DIR, "main.js"), "utf8");

    assert.doesNotMatch(loaderSource, /\blet\s+activeTheme\b/);
    assert.doesNotMatch(loaderSource, /\blet\s+activeThemeContext\b/);
    assert.doesNotMatch(mainSource, /\blet\s+activeTheme\b/);
    assert.ok(!mainSource.includes("_deferredActivateTheme"));
    assert.ok(!mainSource.includes("_deferredGetThemeInfo"));
    assert.ok(!mainSource.includes("_deferredRemoveThemeDir"));
    assert.ok(!mainSource.includes("function activateTheme("));
  });

  it("keeps theme-loader stateless while legacy active facades delegate to the runtime", () => {
    makeFixture();
    const { runtime } = createRuntime();
    themeLoader.bindActiveThemeRuntime(runtime);

    const clawd = runtime.loadInitialTheme("clawd");
    const loadedCalico = themeLoader.loadTheme("calico", { strict: true });

    assert.strictEqual(clawd._id, "clawd");
    assert.strictEqual(loadedCalico._id, "calico");
    assert.strictEqual(runtime.getActiveTheme()._id, "clawd");
    assert.strictEqual(themeLoader.getActiveTheme()._id, "clawd");
    assert.deepStrictEqual(themeLoader.getRendererConfig(), runtime.getRendererConfig());

    runtime.loadInitialTheme("calico");
    assert.strictEqual(themeLoader.getActiveTheme()._id, "calico");
  });

  it("fails fast when legacy active config facades bind an owner without a theme context", () => {
    makeFixture();
    themeLoader.bindActiveThemeRuntime({
      getActiveTheme: () => ({ _id: "clawd" }),
    });

    assert.throws(
      () => themeLoader.getRendererConfig(),
      /requires runtimeOwner\.getActiveThemeContext/
    );
  });

  it("loads the startup theme with requested variant and override signature", () => {
    makeFixture();
    const { runtime } = createRuntime();

    const theme = runtime.loadInitialTheme("clawd", {
      variant: "cozy",
      overrides: { states: { idle: { file: "idle-custom.svg" } } },
    });

    assert.strictEqual(theme._id, "clawd");
    assert.strictEqual(theme._variantId, "cozy");
    assert.strictEqual(theme.timings.idleMouseMoveThreshold, 42);
    assert.deepStrictEqual(theme.states.idle, ["idle-custom.svg"]);
    assert.strictEqual(theme._overrideSignature, JSON.stringify({ states: { idle: { file: "idle-custom.svg" } } }));
    assert.strictEqual(runtime.getActiveTheme(), theme);
  });

  it("dedups an already-active theme without running the reload protocol", () => {
    makeFixture();
    const { runtime, calls } = createRuntime();
    runtime.loadInitialTheme("clawd");

    const result = runtime.activateTheme("clawd");

    assert.deepStrictEqual(result, { themeId: "clawd", variantId: "default" });
    assert.deepStrictEqual(calls, []);
  });

  it("returns the resolved variant id when activation falls back from an unknown variant", () => {
    makeFixture();
    const { runtime } = createRuntime();
    runtime.loadInitialTheme("calico");

    const result = runtime.activateTheme("clawd", "missing");

    assert.deepStrictEqual(result, { themeId: "clawd", variantId: "default" });
    assert.strictEqual(runtime.getActiveTheme()._variantId, "default");
  });

  it("switches themes through the cleanup, refresh, and sequencer protocol", () => {
    makeFixture();
    const { runtime, calls } = createRuntime();
    runtime.loadInitialTheme("clawd");

    const result = runtime.activateTheme("calico");

    assert.deepStrictEqual(result, { themeId: "calico", variantId: "default" });
    assert.strictEqual(runtime.getActiveTheme()._id, "calico");
    assert.deepStrictEqual(calls, [
      "bumpPoster",
      "state.cleanup",
      "tick.cleanup",
      "mini.cleanup",
      "mini.refreshTheme",
      "state.refreshTheme",
      "tick.refreshTheme",
      "sequencer.run",
      ["applyBounds", { x: 10, y: 20, width: 100, height: 100 }],
      "syncHitState",
      "syncRendererState",
      "syncHitWin",
      "syncSessionHud",
      "startMainTick",
      "flushPrefs",
    ]);
  });

  it("refreshes active theme hitbox overrides without running the full reload protocol", () => {
    makeFixture();
    const { runtime, calls } = createRuntime();
    runtime.loadInitialTheme("clawd");

    const result = runtime.refreshActiveThemeHitboxOverrides("clawd", {
      hitbox: {
        wide: {
          "thinking.svg": true,
        },
      },
    });

    assert.deepStrictEqual(result, { themeId: "clawd", variantId: "default" });
    assert.deepStrictEqual(runtime.getActiveTheme().wideHitboxFiles, ["thinking.svg"]);
    assert.deepStrictEqual(calls, [
      "state.refreshTheme",
      "syncHitState",
      "syncHitWin",
      "flushPrefs",
    ]);
  });

  it("applies clamped preserved bounds after theme reload when the clamp path adjusts them", () => {
    makeFixture();
    const { runtime, calls } = createRuntime({
      computeFinalDragBounds: () => ({ x: 15, y: 25, width: 100, height: 100 }),
    });
    runtime.loadInitialTheme("clawd");

    runtime.activateTheme("calico");

    assert.deepStrictEqual(
      calls.filter((call) => Array.isArray(call) && call[0] === "applyBounds"),
      [
        ["applyBounds", { x: 10, y: 20, width: 100, height: 100 }],
        ["applyBounds", { x: 15, y: 25, width: 100, height: 100 }],
      ]
    );
  });

  it("exits mini mode and skips preserved bounds when the new theme lacks mini support", () => {
    makeFixture();
    const { runtime, calls } = createRuntime({
      miniRuntime: {
        getMiniMode: () => true,
      },
    });
    runtime.loadInitialTheme("clawd");

    runtime.activateTheme("calico");

    assert.ok(calls.includes("mini.exitMiniMode"));
    assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === "applyBounds"));
  });

  it("skips preserved bounds while a mini transition owns movement", () => {
    makeFixture();
    const { runtime, calls } = createRuntime({
      miniRuntime: {
        getMiniTransitioning: () => true,
      },
    });
    runtime.loadInitialTheme("clawd");

    runtime.activateTheme("calico");

    assert.ok(!calls.some((call) => Array.isArray(call) && call[0] === "applyBounds"));
    assert.ok(calls.includes("syncRendererState"));
  });

  it("cleanup tears down the sequencer and resets reload state", () => {
    makeFixture();
    const { runtime, calls } = createRuntime({ deferSequencerFinish: true });
    runtime.loadInitialTheme("clawd");
    runtime.activateTheme("calico");

    assert.strictEqual(runtime.isReloadInProgress(), true);
    runtime.cleanup();

    assert.strictEqual(runtime.isReloadInProgress(), false);
    assert.ok(calls.includes("sequencer.cleanup"));
  });
});
