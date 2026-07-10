"use strict";

const assert = require("node:assert");
const EventEmitter = require("node:events");
const Module = require("node:module");
const { describe, it } = require("node:test");

const TUTORIAL_MODULE_PATH = require.resolve("../src/tutorial");

function loadTutorialWithElectron(fakeElectron) {
  delete require.cache[TUTORIAL_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/tutorial");
  } finally {
    Module._load = originalLoad;
  }
}

function createHarness(ctxOverrides = {}) {
  let createdWindow = null;
  const sends = [];

  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = false;

  // Records every ipcMain registration so tests can drive the handlers/listeners.
  const handlers = new Map(); // invoke channels (handle)
  const listeners = new Map(); // send channels (on)
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    removeHandler: (channel) => handlers.delete(channel),
    on: (channel, fn) => listeners.set(channel, fn),
    removeAllListeners: (channel) => listeners.delete(channel),
  };

  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.shown = false;
      this.minimized = false;
      this.backgroundColors = [opts.backgroundColor];
      this.onceCallbacks = new Map();
      this.onCallbacks = new Map();
      this.loadedFile = null;
      this.webContents = {
        isDestroyed: () => false,
        once: (event, cb) => this.webContents.onceCallbacks.set(event, cb),
        onceCallbacks: new Map(),
        send: (channel, payload) => sends.push({ channel, payload }),
        setZoomFactor: () => {},
      };
      createdWindow = this;
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.shown = true; }
    focus() {}
    setMenuBarVisibility() {}
    loadFile(file) { this.loadedFile = file; }
    setBackgroundColor(color) { this.backgroundColors.push(color); }
    once(event, cb) { this.onceCallbacks.set(event, cb); }
    on(event, cb) { this.onCallbacks.set(event, cb); }
    close() {
      const onClose = this.onCallbacks.get("close");
      if (onClose) onClose();
      this.destroyed = true;
      const onClosed = this.onCallbacks.get("closed");
      if (onClosed) onClosed();
    }
    emit(event) {
      const cb = this.onceCallbacks.get(event);
      if (cb) cb();
    }
    emitWebContents(event) {
      const cb = this.webContents.onceCallbacks.get(event);
      if (cb) cb();
    }
  }

  const screen = {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
  };

  const calls = {
    installAgent: [],
    uninstallAgent: [],
    registerShortcut: [],
    resetShortcut: [],
    markSeen: 0,
    openSettingsTab: [],
    setLang: [],
  };
  const ctx = {
    t: (key) => key,
    getI18n: () => ({ tutorialWelcomeTitle: "Welcome to Clawd on Desk" }),
    getLang: () => "en",
    getLangs: () => ["en", "zh", "ja"],
    getHeroSrc: () => "data:image/png;base64,hero",
    getDoneHeroSvg: () => "<svg id=\"done-hero\"></svg>",
    setLang: (lang) => { calls.setLang.push(lang); },
    getShortcutsSummary: () => [{ id: "permissionAllow", label: "Allow", accelerator: "CommandOrControl+Shift+Y" }],
    getAgentOnboardingState: () => ({ install: [{ agentId: "gemini-cli", label: "Gemini CLI" }], cleanup: [], active: [] }),
    installAgent: (agentId) => { calls.installAgent.push(agentId); return Promise.resolve({ status: "ok" }); },
    uninstallAgent: (agentId) => { calls.uninstallAgent.push(agentId); return Promise.resolve({ status: "ok" }); },
    registerShortcut: (payload) => { calls.registerShortcut.push(payload); return Promise.resolve({ status: "ok" }); },
    resetShortcut: (payload) => { calls.resetShortcut.push(payload); return Promise.resolve({ status: "ok" }); },
    openSettingsTab: (tab) => { calls.openSettingsTab.push(tab); },
    markTutorialSeen: () => { calls.markSeen += 1; },
    iconPath: "/icon.png",
    ...ctxOverrides,
  };

  const initTutorial = loadTutorialWithElectron({
    BrowserWindow: FakeBrowserWindow,
    nativeTheme,
    ipcMain,
    screen,
  });
  const tutorial = initTutorial(ctx);

  return {
    tutorial,
    ctx,
    calls,
    nativeTheme,
    handlers,
    listeners,
    sends,
    getCreatedWindow: () => createdWindow,
  };
}

describe("tutorial window shell", () => {
  it("opens a centered, framed window and loads tutorial.html", () => {
    const h = createHarness();
    h.tutorial.open();
    const win = h.getCreatedWindow();
    assert.ok(win, "a window is created");
    assert.match(win.loadedFile, /tutorial\.html$/);
    assert.strictEqual(win.opts.modal, undefined);
    assert.strictEqual(win.opts.icon, "/icon.png");
    // centered on a 1280x800 work area for the 720x700 default
    assert.strictEqual(win.opts.width, 720);
    assert.strictEqual(win.opts.height, 700);
    assert.strictEqual(win.opts.x, Math.round((1280 - 720) / 2));
  });

  it("registers all tutorial IPC channels on open", () => {
    const h = createHarness();
    h.tutorial.open();
    assert.ok(h.handlers.has("tutorial:get-state"));
    assert.ok(h.handlers.has("tutorial:install-agent"));
    assert.ok(h.handlers.has("tutorial:uninstall-agent"));
    assert.ok(h.handlers.has("tutorial:register-shortcut"));
    assert.ok(h.handlers.has("tutorial:reset-shortcut"));
    assert.ok(h.listeners.has("tutorial:open-settings-tab"));
    assert.ok(h.listeners.has("tutorial:open-shortcuts"));
    assert.ok(h.listeners.has("tutorial:finish"));
    assert.ok(h.listeners.has("tutorial:mark-seen"));
  });

  it("pushes the full state payload after the page loads", () => {
    const h = createHarness();
    h.tutorial.open();
    h.getCreatedWindow().emitWebContents("did-finish-load");
    const stateSend = h.sends.find((s) => s.channel === "tutorial:state");
    assert.ok(stateSend, "state is pushed on load");
    assert.strictEqual(stateSend.payload.lang, "en");
    assert.deepStrictEqual(stateSend.payload.langs, ["en", "zh", "ja"]);
    assert.strictEqual(stateSend.payload.heroSrc, "data:image/png;base64,hero");
    assert.strictEqual(stateSend.payload.doneHeroSvg, "<svg id=\"done-hero\"></svg>");
    assert.deepStrictEqual(stateSend.payload.agents.install, [{ agentId: "gemini-cli", label: "Gemini CLI" }]);
    assert.strictEqual(stateSend.payload.shortcuts[0].accelerator, "CommandOrControl+Shift+Y");
  });

  it("set-lang routes to ctx.setLang and re-pushes state", () => {
    const h = createHarness();
    h.tutorial.open();
    h.getCreatedWindow().emitWebContents("did-finish-load");
    const before = h.sends.filter((s) => s.channel === "tutorial:state").length;
    h.listeners.get("tutorial:set-lang")({}, "zh");
    assert.deepStrictEqual(h.calls.setLang, ["zh"]);
    const after = h.sends.filter((s) => s.channel === "tutorial:state").length;
    assert.strictEqual(after, before + 1, "state re-pushed after language change");
  });

  it("get-state handler returns the live state", () => {
    const h = createHarness();
    h.tutorial.open();
    const state = h.handlers.get("tutorial:get-state")();
    assert.strictEqual(state.i18n.tutorialWelcomeTitle, "Welcome to Clawd on Desk");
  });

  it("install-agent routes to ctx.installAgent and re-pushes state", async () => {
    const h = createHarness();
    h.tutorial.open();
    h.getCreatedWindow().emitWebContents("did-finish-load");
    const before = h.sends.filter((s) => s.channel === "tutorial:state").length;
    const result = await h.handlers.get("tutorial:install-agent")({}, "gemini-cli");
    assert.deepStrictEqual(h.calls.installAgent, ["gemini-cli"]);
    assert.strictEqual(result.status, "ok");
    const after = h.sends.filter((s) => s.channel === "tutorial:state").length;
    assert.strictEqual(after, before + 1, "state re-pushed after install");
  });

  it("open-shortcuts routes to ctx.openSettingsTab('shortcuts')", () => {
    const h = createHarness();
    h.tutorial.open();
    h.listeners.get("tutorial:open-shortcuts")({});
    assert.deepStrictEqual(h.calls.openSettingsTab, ["shortcuts"]);
  });

  it("shortcut edits route to ctx commands and re-push state", async () => {
    const h = createHarness();
    h.tutorial.open();
    h.getCreatedWindow().emitWebContents("did-finish-load");
    const before = h.sends.filter((s) => s.channel === "tutorial:state").length;
    const registerPayload = { actionId: "permissionAllow", accelerator: "CommandOrControl+Shift+U" };
    const registerResult = await h.handlers.get("tutorial:register-shortcut")({}, registerPayload);
    assert.deepStrictEqual(h.calls.registerShortcut, [registerPayload]);
    assert.strictEqual(registerResult.status, "ok");
    const resetPayload = { actionId: "permissionAllow" };
    const resetResult = await h.handlers.get("tutorial:reset-shortcut")({}, resetPayload);
    assert.deepStrictEqual(h.calls.resetShortcut, [resetPayload]);
    assert.strictEqual(resetResult.status, "ok");
    const after = h.sends.filter((s) => s.channel === "tutorial:state").length;
    assert.strictEqual(after, before + 2, "state re-pushed after each shortcut command");
  });

  it("finish marks seen and closes the window", () => {
    const h = createHarness();
    h.tutorial.open();
    const win = h.getCreatedWindow();
    h.listeners.get("tutorial:finish")({});
    assert.ok(h.calls.markSeen >= 1, "tutorial marked seen on finish");
    assert.strictEqual(win.isDestroyed(), true, "window closed on finish");
  });

  it("marks seen when the window is closed via the OS chrome", () => {
    const h = createHarness();
    h.tutorial.open();
    h.calls.markSeen = 0;
    h.getCreatedWindow().close();
    assert.strictEqual(h.calls.markSeen, 1, "OS close counts as seen");
  });

  it("reuses the existing window and re-sends state on a second open", () => {
    const h = createHarness();
    h.tutorial.open();
    const first = h.getCreatedWindow();
    first.minimized = true;
    const before = h.sends.filter((s) => s.channel === "tutorial:state").length;
    h.tutorial.open();
    assert.strictEqual(h.getCreatedWindow(), first, "same window instance reused");
    assert.strictEqual(first.minimized, false, "minimized window restored");
    const after = h.sends.filter((s) => s.channel === "tutorial:state").length;
    assert.strictEqual(after, before + 1, "state re-sent on reopen");
  });

  it("close() before open is a no-op", () => {
    const h = createHarness();
    assert.doesNotThrow(() => h.tutorial.close());
  });

  it("syncs background color on native theme change", () => {
    const h = createHarness();
    h.tutorial.open();
    const win = h.getCreatedWindow();
    assert.strictEqual(win.opts.backgroundColor, "#f5f5f7");
    h.nativeTheme.shouldUseDarkColors = true;
    h.nativeTheme.emit("updated");
    assert.ok(win.backgroundColors.includes("#1c1c1f"), "dark background applied on theme change");
  });
});
