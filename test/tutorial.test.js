"use strict";

const assert = require("node:assert");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { describe, it } = require("node:test");

const TUTORIAL_MODULE_PATH = require.resolve("../src/tutorial");
const TUTORIAL_RENDERER_PATH = path.join(__dirname, "..", "src", "tutorial-renderer.js");
const TUTORIAL_HTML_PATH = path.join(__dirname, "..", "src", "tutorial.html");

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
    setTitle(title) { this.title = title; }
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
    getAgentOnboardingState: () => ({ install: [{ agentId: "gemini-cli", label: "Gemini CLI", iconUrl: "file:///icons/gemini-cli.png" }], cleanup: [], active: [] }),
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
  it("uses the shared custom language picker in the welcome step", () => {
    const renderer = fs.readFileSync(TUTORIAL_RENDERER_PATH, "utf8");
    const html = fs.readFileSync(TUTORIAL_HTML_PATH, "utf8");

    assert.ok(renderer.includes("createLanguagePicker"));
    assert.ok(renderer.includes("LANG_LABELS"));
    assert.ok(renderer.includes("api.setLang(next)"));
    assert.ok(renderer.includes("languagePickerControl.dispose()"));
    assert.ok(renderer.includes("mountedLanguagePicker.ensureVisible()"));
    assert.ok(!renderer.includes("<select"));
    assert.ok(!renderer.includes("lang-select"));
    assert.ok(html.includes(`href="language-picker.css"`));
    assert.ok(html.includes(`src="language-picker.js"`));
    assert.match(html, /\.body\.step-welcome \{[^}]*padding:\s*18px 26px 234px;[^}]*scrollbar-width:\s*none;/s);
    assert.match(html, /\.body\.step-welcome::-webkit-scrollbar \{[^}]*width:\s*0;[^}]*height:\s*0;/);
    assert.doesNotMatch(html, /\.step-welcome \.welcome \{[^}]*transform:/);
    assert.match(html, /id="body" data-language-picker-boundary/);
    assert.match(html, /\.body\.step-welcome \{[^}]*overflow-y: auto;[^}]*align-items: safe center;/s);
    assert.match(html, /\.step-welcome \.language-picker \{[^}]*width:\s*160px;/s);
    assert.match(html, /\.step-welcome \.language-picker-option \{[^}]*white-space:\s*nowrap;/s);
    assert.match(html, /style-src 'self' 'unsafe-inline'/);
  });

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
    assert.deepStrictEqual(stateSend.payload.agents.install, [{
      agentId: "gemini-cli",
      label: "Gemini CLI",
      iconUrl: "file:///icons/gemini-cli.png",
    }]);
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

  it("refreshes the native title when the selected language changes", () => {
    let lang = "en";
    const titles = { en: "Welcome to Clawd on Desk", zh: "欢迎使用 Clawd on Desk" };
    const h = createHarness({
      t: (key) => key === "tutorialWindowTitle" ? titles[lang] : key,
      setLang: (value) => { lang = value; h.calls.setLang.push(value); },
    });

    h.tutorial.open();
    assert.strictEqual(h.getCreatedWindow().opts.title, titles.en);
    h.listeners.get("tutorial:set-lang")({}, "zh");
    assert.strictEqual(h.getCreatedWindow().title, titles.zh);
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

  it("syncLocalization pushes fresh state, dictionary, and native title for external language changes", () => {
    // Reproduces the review-reported gap: when the language changes through
    // Settings (not the tutorial's own picker), the centralized language
    // effect must push fresh renderer state — not just the native title — so
    // the tutorial body, buttons, and document.title follow the new language.
    let lang = "en";
    const titles = { en: "Welcome to Clawd on Desk", zh: "欢迎使用 Clawd on Desk" };
    const i18nByLang = {
      en: { tutorialWelcomeTitle: "Welcome to Clawd on Desk" },
      zh: { tutorialWelcomeTitle: "欢迎使用 Clawd on Desk" },
    };
    const h = createHarness({
      t: (key) => (key === "tutorialWindowTitle" ? titles[lang] : key),
      getLang: () => lang,
      getI18n: () => i18nByLang[lang],
    });

    h.tutorial.open();
    h.getCreatedWindow().emitWebContents("did-finish-load");
    const before = h.sends.filter((s) => s.channel === "tutorial:state").length;

    // Simulate the external path: Settings/tray → effect → syncLocalization.
    lang = "zh";
    h.tutorial.syncLocalization();

    const stateSends = h.sends.filter((s) => s.channel === "tutorial:state");
    assert.strictEqual(stateSends.length, before + 1, "state pushed once for external change");
    const last = stateSends[stateSends.length - 1];
    assert.strictEqual(last.payload.lang, "zh", "state carries the new lang");
    assert.strictEqual(
      last.payload.i18n.tutorialWelcomeTitle,
      "欢迎使用 Clawd on Desk",
      "state carries the new dictionary",
    );
    assert.strictEqual(h.getCreatedWindow().title, titles.zh, "native title updated to new language");
  });

  it("tutorial:set-lang does not double-push state when the language effect fires synchronously", () => {
    // The tutorial's own language picker calls ctx.setLang, which in production
    // synchronously triggers the centralized effect (syncWindowTitles →
    // syncLocalization). The re-entrancy guard must suppress that effect-driven
    // push so the picker handler's own syncLocalization is the only one.
    let lang = "en";
    const titles = { en: "Welcome to Clawd on Desk", zh: "欢迎使用 Clawd on Desk" };
    const h = createHarness({
      t: (key) => (key === "tutorialWindowTitle" ? titles[lang] : key),
      getLang: () => lang,
      setLang: (value) => {
        lang = value;
        h.calls.setLang.push(value);
        // Simulate the settings-controller firing the centralized effect.
        h.tutorial.syncLocalization();
      },
    });

    h.tutorial.open();
    h.getCreatedWindow().emitWebContents("did-finish-load");
    const before = h.sends.filter((s) => s.channel === "tutorial:state").length;

    h.listeners.get("tutorial:set-lang")({}, "zh");

    assert.deepStrictEqual(h.calls.setLang, ["zh"]);
    const after = h.sends.filter((s) => s.channel === "tutorial:state").length;
    assert.strictEqual(after, before + 1, "state pushed exactly once despite synchronous effect");
    assert.strictEqual(h.getCreatedWindow().title, titles.zh, "native title updated");
  });
});
