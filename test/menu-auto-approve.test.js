"use strict";

// Auto-pilot (autoApproveAllPermissions) quick toggle in the pet context menu
// and tray menu. Enabling must go through a native confirm dialog and only
// commit on confirm; disabling is immediate. The checkbox reflects the
// committed ctx value.

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

function makeFakeElectron(messageBoxResponse) {
  const dialogCalls = [];
  return {
    _dialogCalls: dialogCalls,
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
    dialog: {
      // Electron's showMessageBox is overloaded: (options) or (parent, options).
      // The auto-pilot confirm must be parentless (standalone, screen-centered)
      // so it doesn't render as a sheet on the tiny pet window — so normalize
      // both shapes and record whether a parent window was passed.
      showMessageBox(arg1, arg2) {
        const hasParent = arg2 !== undefined;
        const parent = hasParent ? arg1 : undefined;
        const opts = hasParent ? arg2 : arg1;
        dialogCalls.push({ parent, opts });
        return Promise.resolve({ response: messageBoxResponse });
      },
    },
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

function findAutoApproveItem(template) {
  return template.find((item) => item && item.label === "Auto-approve all requests");
}

describe("auto-pilot menu toggle", () => {
  it("appears as an unchecked checkbox in the context menu when off", () => {
    const menu = loadMenuWithElectron(makeFakeElectron(0));
    const ctx = makeCtx({ autoApproveAllPermissions: false });
    const m = menu(ctx);
    m.buildContextMenu();
    const item = findAutoApproveItem(ctx.contextMenu.template);
    assert.ok(item, "auto-pilot item present in context menu");
    assert.strictEqual(item.type, "checkbox");
    assert.strictEqual(item.checked, false);
  });

  it("reflects checked state when already enabled", () => {
    const menu = loadMenuWithElectron(makeFakeElectron(0));
    const ctx = makeCtx({ autoApproveAllPermissions: true });
    const m = menu(ctx);
    m.buildContextMenu();
    const item = findAutoApproveItem(ctx.contextMenu.template);
    assert.strictEqual(item.checked, true);
  });

  it("disables immediately without a confirm dialog", () => {
    const fake = makeFakeElectron(0);
    const menu = loadMenuWithElectron(fake);
    let setValue = "untouched";
    const ctx = makeCtx();
    // Define the accessor on the final object: a spread in makeCtx would
    // flatten get/set into a plain value and the setter would never run.
    Object.defineProperty(ctx, "autoApproveAllPermissions", {
      configurable: true,
      get() { return true; },
      set(v) { setValue = v; },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    const item = findAutoApproveItem(ctx.contextMenu.template);
    // Electron flips the visual to unchecked before click fires.
    item.checked = false;
    item.click(item);
    assert.strictEqual(setValue, false, "disable commits immediately");
    assert.strictEqual(fake._dialogCalls.length, 0, "no confirm dialog on disable");
  });

  it("enabling shows a confirm dialog and commits only when confirmed", async () => {
    const fake = makeFakeElectron(0); // 0 = Enable button
    const menu = loadMenuWithElectron(fake);
    let committed = false;
    const ctx = makeCtx();
    // Reflect the commit back through the getter so the internal
    // rebuildAllMenus() re-renders the checkbox as checked.
    Object.defineProperty(ctx, "autoApproveAllPermissions", {
      configurable: true,
      get() { return committed; },
      set(v) { committed = v; },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    const item = findAutoApproveItem(ctx.contextMenu.template);
    item.checked = true; // Electron's optimistic flip
    item.click(item);
    // Reverted pending confirmation.
    assert.strictEqual(item.checked, false, "check reverted until confirmed");
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(fake._dialogCalls.length, 1, "confirm dialog shown");
    assert.strictEqual(fake._dialogCalls[0].opts.type, "warning");
    assert.strictEqual(fake._dialogCalls[0].parent, undefined, "dialog is parentless (screen-centered, not a sheet on the pet)");
    assert.strictEqual(committed, true, "committed true after confirm");
    // menu.js's internal rebuildAllMenus() re-renders the context menu, so the
    // freshly built item reflects the committed value.
    const rebuiltItem = findAutoApproveItem(ctx.contextMenu.template);
    assert.strictEqual(rebuiltItem.checked, true, "checkbox reflects enabled state after rebuild");
  });

  it("enabling does NOT commit when the user cancels", async () => {
    const fake = makeFakeElectron(1); // 1 = Cancel button
    const menu = loadMenuWithElectron(fake);
    let committed = "untouched";
    const ctx = makeCtx();
    Object.defineProperty(ctx, "autoApproveAllPermissions", {
      configurable: true,
      get() { return false; },
      set(v) { committed = v; },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    const item = findAutoApproveItem(ctx.contextMenu.template);
    item.checked = true;
    item.click(item);
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(fake._dialogCalls.length, 1, "confirm dialog shown");
    assert.strictEqual(committed, "untouched", "nothing committed on cancel");
  });

  it("is present in the tray menu too", () => {
    const menu = loadMenuWithElectron(makeFakeElectron(0));
    let trayTemplate = null;
    const ctx = makeCtx({
      tray: { setContextMenu(menuObj) { trayTemplate = menuObj.template; } },
    });
    const m = menu(ctx);
    m.buildTrayMenu();
    assert.ok(findAutoApproveItem(trayTemplate), "auto-pilot item present in tray menu");
  });
});
