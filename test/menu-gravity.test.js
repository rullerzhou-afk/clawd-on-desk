"use strict";

// Gravity quick toggle in the pet context menu and tray menu: a plain
// checkbox bound to ctx.gravityEnabled (backed by the settings controller in
// main.js). Unlike auto-pilot there is no confirm dialog — the click writes
// straight through and the committed value comes back via the menu rebuild.

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it } = require("node:test");

const MENU_MODULE_PATH = require.resolve("../src/menu");

function loadMenuWithElectron(fakeElectron) {
  delete require.cache[MENU_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/menu");
  } finally {
    Module._load = originalLoad;
  }
}

function makeFakeElectron() {
  return {
    app: { quit() {}, setActivationPolicy() {}, dock: { show() {}, hide() {} } },
    BrowserWindow: function BrowserWindow() {},
    Menu: { buildFromTemplate(template) { return { template }; } },
    Tray: function Tray() {},
    nativeImage: { createFromPath() { return { resize() { return this; }, setTemplateImage() {} }; } },
    screen: {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ id: 1 }),
    },
    dialog: { showMessageBox: () => Promise.resolve({ response: 1 }) },
  };
}

function makeCtx(overrides = {}) {
  return {
    win: { isDestroyed: () => false },
    sessions: new Map(),
    currentSize: "P:15",
    doNotDisturb: false,
    lang: "en",
    showTray: true,
    showDock: true,
    openAtLogin: false,
    bubbleFollowPet: false,
    hideBubbles: false,
    soundMuted: false,
    autoApproveAllPermissions: false,
    gravityEnabled: false,
    menuOpen: false,
    tray: null,
    contextMenuOwner: null,
    contextMenu: null,
    isQuitting: false,
    getMiniMode: () => false,
    getMiniTransitioning: () => false,
    getDisableMiniMode: () => false,
    getActiveThemeCapabilities: () => ({ miniMode: true }),
    openDashboard() {},
    openSettingsWindow() {},
    togglePetVisibility() {},
    bringPetToPrimaryDisplay() {},
    enableDoNotDisturb() {},
    disableDoNotDisturb() {},
    enterMiniViaMenu() {},
    exitMiniMode() {},
    miniHandleResize: () => false,
    getPetWindowBounds: () => ({ x: 10, y: 20, width: 120, height: 120 }),
    applyPetWindowBounds() {},
    getCurrentPixelSize: () => ({ width: 200, height: 200 }),
    isProportionalMode: () => true,
    repositionBubbles() {},
    syncHitWin() {},
    flushRuntimeStateToPrefs() {},
    reapplyMacVisibility() {},
    clampToScreenVisual: (x, y) => ({ x, y }),
    rebuildAllMenus() {},
    newSessionWithFolder() {},
    newSessionInCurrentDir() {},
    ...overrides,
  };
}

function findGravityItem(template, label = "Gravity") {
  return template.find((item) => item && item.label === label);
}

describe("gravity menu toggle", () => {
  it("appears as an unchecked checkbox in the context menu when off", () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const ctx = makeCtx({ gravityEnabled: false });
    const m = menu(ctx);
    m.buildContextMenu();
    const item = findGravityItem(ctx.contextMenu.template);
    assert.ok(item, "gravity item present in context menu");
    assert.strictEqual(item.type, "checkbox");
    assert.strictEqual(item.checked, false);
  });

  it("reflects checked state when enabled", () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const ctx = makeCtx({ gravityEnabled: true });
    const m = menu(ctx);
    m.buildContextMenu();
    const item = findGravityItem(ctx.contextMenu.template);
    assert.strictEqual(item.checked, true);
  });

  it("click writes the new value through ctx.gravityEnabled", () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const writes = [];
    const ctx = makeCtx();
    // Define the accessor on the final object: a spread in makeCtx would
    // flatten get/set into a plain value and the setter would never run.
    Object.defineProperty(ctx, "gravityEnabled", {
      configurable: true,
      get() { return false; },
      set(v) { writes.push(v); },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    const item = findGravityItem(ctx.contextMenu.template);
    item.click({ checked: true });
    assert.deepStrictEqual(writes, [true]);
    item.click({ checked: false });
    assert.deepStrictEqual(writes, [true, false]);
  });

  it("labels the item through i18n", () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const ctx = makeCtx({ lang: "zh" });
    const m = menu(ctx);
    m.buildContextMenu();
    const item = findGravityItem(ctx.contextMenu.template, "重力");
    assert.ok(item, "zh label resolves through the shared i18n table");
  });
});
