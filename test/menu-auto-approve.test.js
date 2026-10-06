"use strict";

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
  };
}

function makeCtx(overrides = {}) {
  const confirmationCalls = [];
  const errorCalls = [];
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
    permissionAutomationMode: "off",
    permissionAutomationAutoToolsWarningDismissed: false,
    permissionAutomationUnattendedWarningDismissed: false,
    menuOpen: false,
    tray: null,
    contextMenuOwner: null,
    contextMenu: null,
    isQuitting: false,
    confirmationCalls,
    errorCalls,
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
    isPermissionAutomationWarningDismissed(mode) {
      if (mode === "auto-tools") return this.permissionAutomationAutoToolsWarningDismissed;
      if (mode === "unattended") return this.permissionAutomationUnattendedWarningDismissed;
      return false;
    },
    async confirmPermissionAutomation(payload) {
      confirmationCalls.push(payload);
      return { confirmed: true, suppressFutureConfirmation: false };
    },
    async showPermissionAutomationError(payload) {
      errorCalls.push(payload);
    },
    async setPermissionAutomationMode(mode, options = {}) {
      this.permissionAutomationMode = mode;
      if (options.suppressFutureConfirmation === true && mode === "auto-tools") {
        this.permissionAutomationAutoToolsWarningDismissed = true;
      }
      if (options.suppressFutureConfirmation === true && mode === "unattended") {
        this.permissionAutomationUnattendedWarningDismissed = true;
      }
      return { status: "ok" };
    },
    newSessionWithFolder() {},
    newSessionInCurrentDir() {},
    ...overrides,
  };
}

function findPermissionAutomationItem(template) {
  return template.find((item) => item && typeof item.label === "string"
    && item.label.startsWith("Permission handling:"));
}

function findModeItem(item, label) {
  return item.submenu.find((entry) => entry.label === label);
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("permission automation menu", () => {
  it("shows three radio choices and reflects the committed mode", () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const ctx = makeCtx({ permissionAutomationMode: "unattended" });
    const m = menu(ctx);
    m.buildContextMenu();
    const item = findPermissionAutomationItem(ctx.contextMenu.template);
    assert.ok(item);
    assert.strictEqual(item.submenu.length, 3);
    assert.ok(item.submenu.every((entry) => entry.type === "radio"));
    assert.strictEqual(findModeItem(item, "Auto-approve").checked, true);
  });

  it("turns automation off immediately without confirmation", async () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const calls = [];
    const ctx = makeCtx({
      permissionAutomationMode: "unattended",
      async setPermissionAutomationMode(mode, options) {
        calls.push({ mode, options });
        return { status: "ok" };
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Ask every time").click();
    await flushPromises();
    assert.deepStrictEqual(ctx.confirmationCalls, []);
    assert.deepStrictEqual(calls, [{ mode: "off", options: { confirmed: false } }]);
  });

  it("passes localized auto-tools copy to the shared confirmation window", async () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const calls = [];
    const ctx = makeCtx({
      async setPermissionAutomationMode(mode, options) {
        calls.push({ mode, options });
        return { status: "ok" };
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Question prompts only").click();
    await flushPromises();
    assert.strictEqual(ctx.confirmationCalls.length, 1);
    assert.strictEqual(ctx.confirmationCalls[0].mode, "auto-tools");
    assert.match(ctx.confirmationCalls[0].title, /tool requests/i);
    assert.match(ctx.confirmationCalls[0].checkboxLabel, /understand the risks/i);
    assert.deepStrictEqual(calls, [{
      mode: "auto-tools",
      options: { confirmed: true, suppressFutureConfirmation: false },
    }]);
  });

  it("uses the stronger unattended warning", async () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const ctx = makeCtx({ permissionAutomationMode: "auto-tools" });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Auto-approve").click();
    await flushPromises();
    assert.strictEqual(ctx.confirmationCalls[0].mode, "unattended");
    assert.match(ctx.confirmationCalls[0].title, /tools and decisions/i);
  });

  it("fails closed when confirmation is cancelled", async () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const calls = [];
    const ctx = makeCtx({
      async confirmPermissionAutomation(payload) {
        this.confirmationCalls.push(payload);
        return { confirmed: false, suppressFutureConfirmation: true };
      },
      async setPermissionAutomationMode(mode) {
        calls.push(mode);
        return { status: "ok" };
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Auto-approve").click();
    await flushPromises();
    assert.deepStrictEqual(calls, []);
  });

  it("persists do-not-show-again only after explicit confirmation", async () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const calls = [];
    const ctx = makeCtx({
      async confirmPermissionAutomation(payload) {
        this.confirmationCalls.push(payload);
        return { confirmed: true, suppressFutureConfirmation: true };
      },
      async setPermissionAutomationMode(mode, options) {
        calls.push({ mode, options });
        return { status: "ok" };
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Question prompts only").click();
    await flushPromises();
    assert.deepStrictEqual(calls, [{
      mode: "auto-tools",
      options: { confirmed: true, suppressFutureConfirmation: true },
    }]);
  });

  it("skips only the warning dismissed for the matching mode", async () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const calls = [];
    const ctx = makeCtx({
      permissionAutomationAutoToolsWarningDismissed: true,
      async setPermissionAutomationMode(mode, options) {
        calls.push({ mode, options });
        this.permissionAutomationMode = mode;
        return { status: "ok" };
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Question prompts only").click();
    await flushPromises();
    assert.deepStrictEqual(ctx.confirmationCalls, []);
    assert.deepStrictEqual(calls, [{ mode: "auto-tools", options: { confirmed: false } }]);

    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Auto-approve").click();
    await flushPromises();
    assert.strictEqual(ctx.confirmationCalls.length, 1);
    assert.strictEqual(ctx.confirmationCalls[0].mode, "unattended");
  });

  it("uses the styled error window when persistence fails", async () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const ctx = makeCtx({
      async setPermissionAutomationMode() {
        return { status: "error", message: "disk full" };
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Question prompts only").click();
    await flushPromises();
    await flushPromises();
    assert.strictEqual(ctx.errorCalls.length, 1);
    assert.strictEqual(ctx.errorCalls[0].detail, "disk full");
  });

  it("uses the styled error window when turning automation off rejects", async () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    const ctx = makeCtx({
      permissionAutomationMode: "auto-tools",
      async setPermissionAutomationMode() {
        throw new Error("read only");
      },
    });
    const m = menu(ctx);
    m.buildContextMenu();
    findModeItem(findPermissionAutomationItem(ctx.contextMenu.template), "Ask every time").click();
    await flushPromises();
    await flushPromises();
    assert.strictEqual(ctx.errorCalls.length, 1);
    assert.strictEqual(ctx.errorCalls[0].detail, "read only");
  });

  it("uses the same confirmation flow in the tray menu", async () => {
    const menu = loadMenuWithElectron(makeFakeElectron());
    let trayTemplate = null;
    const ctx = makeCtx({
      tray: { setContextMenu(menuObject) { trayTemplate = menuObject.template; } },
    });
    const m = menu(ctx);
    m.buildTrayMenu();
    findModeItem(findPermissionAutomationItem(trayTemplate), "Question prompts only").click();
    await flushPromises();
    assert.strictEqual(ctx.confirmationCalls.length, 1);
  });
});
