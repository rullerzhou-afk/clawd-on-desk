const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

const MENU_MODULE_PATH = require.resolve("../src/menu");

function loadMenuWithElectron(fakeElectron) {
  delete require.cache[MENU_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/menu");
  } finally {
    Module._load = originalLoad;
  }
}

describe("menu resizeWindow preview mode", () => {
  function buildCtx() {
    const fakeElectron = {
      app: { quit: () => {}, setActivationPolicy: () => {}, dock: { show: () => {}, hide: () => {} } },
      BrowserWindow: function BrowserWindow() {},
      Menu: {
        buildFromTemplate(template) {
          return { template };
        },
      },
      Tray: function Tray() {},
      nativeImage: {
        createFromPath() {
          return {
            resize() { return this; },
            setTemplateImage() {},
          };
        },
      },
      screen: {
        getAllDisplays: () => [],
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      },
    };
    const initMenu = loadMenuWithElectron(fakeElectron);

    let currentSizeValue = "P:15";
    let currentSizeWrites = 0;
    let sizeArg = null;
    let appliedBounds = null;
    let flushCalls = 0;
    let bubbleCalls = 0;
    let hitSyncCalls = 0;
    const ctx = {
      win: { isDestroyed: () => false },
      sessions: new Map(),
      get currentSize() { return currentSizeValue; },
      set currentSize(value) { currentSizeWrites += 1; currentSizeValue = value; },
      doNotDisturb: false,
      lang: "en",
      showTray: true,
      showDock: true,
      openAtLogin: false,
      bubbleFollowPet: false,
      hideBubbles: false,
      soundMuted: false,
      menuOpen: false,
      tray: null,
      contextMenuOwner: null,
      contextMenu: null,
      isQuitting: false,
      getMiniMode: () => false,
      getMiniTransitioning: () => false,
      getActiveThemeCapabilities: () => ({ miniMode: true }),
      openSettingsWindow: () => {},
      togglePetVisibility: () => {},
      enableDoNotDisturb: () => {},
      disableDoNotDisturb: () => {},
      enterMiniViaMenu: () => {},
      exitMiniMode: () => {},
      miniHandleResize: () => false,
      getPetWindowBounds: () => ({ x: 10, y: 20, width: 120, height: 120 }),
      applyPetWindowBounds: (bounds) => { appliedBounds = bounds; },
      getCurrentPixelSize: () => ({ width: 200, height: 200 }),
      getPixelSizeFor: (sizeKey) => {
        sizeArg = sizeKey;
        return { width: 320, height: 320 };
      },
      isProportionalMode: () => true,
      repositionBubbles: () => { bubbleCalls += 1; },
      syncHitWin: () => { hitSyncCalls += 1; },
      flushRuntimeStateToPrefs: () => { flushCalls += 1; },
      reapplyMacVisibility: () => {},
      clampToScreenVisual: (x, y) => ({ x, y }),
    };

    return {
      menu: initMenu(ctx),
      get currentSizeWrites() { return currentSizeWrites; },
      get currentSizeValue() { return currentSizeValue; },
      get sizeArg() { return sizeArg; },
      get appliedBounds() { return appliedBounds; },
      get flushCalls() { return flushCalls; },
      get bubbleCalls() { return bubbleCalls; },
      get hitSyncCalls() { return hitSyncCalls; },
    };
  }

  it("preview mode resizes only the visible pet window without syncing attached windows", () => {
    const harness = buildCtx();

    harness.menu.resizeWindow("P:12", { mode: "preview" });

    assert.strictEqual(harness.currentSizeWrites, 0);
    assert.strictEqual(harness.currentSizeValue, "P:15");
    assert.strictEqual(harness.sizeArg, "P:12");
    assert.deepStrictEqual(harness.appliedBounds, {
      x: 10,
      y: 20,
      width: 320,
      height: 320,
    });
    assert.strictEqual(harness.hitSyncCalls, 0);
    assert.strictEqual(harness.bubbleCalls, 0);
    assert.strictEqual(harness.flushCalls, 0);
  });

  it("commit mode still performs the full sync path", () => {
    const harness = buildCtx();

    harness.menu.resizeWindow("P:12");

    assert.strictEqual(harness.currentSizeWrites, 1);
    assert.strictEqual(harness.currentSizeValue, "P:12");
    assert.strictEqual(harness.hitSyncCalls, 1);
    assert.strictEqual(harness.bubbleCalls, 1);
    assert.strictEqual(harness.flushCalls, 1);
  });
});
