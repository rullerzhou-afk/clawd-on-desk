"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { describe, it } = require("node:test");
const createRuntime = require("../src/permission-automation-confirmation");
const {
  computeCenteredBounds,
  RESULT_CHANNEL,
  STATE_CHANNEL,
  READY_CHANNEL,
  STATE_APPLIED_CHANNEL,
} = require("../src/permission-automation-confirmation");

function createHarness(overrides = {}) {
  const listeners = new Map();
  const windows = [];
  const timers = [];
  const ipcMain = {
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
  };

  class FakeBrowserWindow {
    constructor(options) {
      if (overrides.constructorThrows) throw new Error("window unavailable");
      this.options = options;
      this.destroyed = false;
      this.shown = false;
      this.focusCount = 0;
      this.events = new Map();
      this.webEvents = new Map();
      this.sent = [];
      this.webContents = {
        once: (name, listener) => this.webEvents.set(name, listener),
        send: (channel, payload) => this.sent.push({ channel, payload }),
        isDestroyed: () => this.destroyed,
      };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    setMenuBarVisibility() {}
    loadFile(file) {
      this.loadedFile = file;
      return overrides.loadReject ? Promise.reject(new Error("load failed")) : Promise.resolve();
    }
    once(name, listener) { this.events.set(name, listener); }
    on(name, listener) { this.events.set(name, listener); }
    show() {
      if (overrides.showThrows) throw new Error("show unavailable");
      this.shown = true;
    }
    focus() { this.focusCount += 1; }
    close() {
      this.destroyed = true;
      const listener = this.events.get("closed");
      if (listener) listener();
    }
    emit(name, ...args) {
      const listener = this.events.get(name) || this.webEvents.get(name);
      if (listener) listener(...args);
    }
  }

  const nearestDisplay = overrides.nearestDisplay || {
    workArea: { x: 1920, y: 20, width: 1600, height: 900 },
  };
  const primaryDisplay = overrides.primaryDisplay || {
    workArea: { x: 0, y: 0, width: 1280, height: 760 },
  };
  const screen = {
    getCursorScreenPoint: () => ({ x: 2300, y: 300 }),
    getDisplayNearestPoint: () => nearestDisplay,
    getPrimaryDisplay: () => primaryDisplay,
  };
  if (overrides.screenThrows) screen.getCursorScreenPoint = () => { throw new Error("unavailable"); };

  const runtime = createRuntime({
    BrowserWindow: FakeBrowserWindow,
    ipcMain,
    nativeTheme: { shouldUseDarkColors: overrides.dark === true },
    screen,
    iconPath: "D:\\app\\icon.ico",
    htmlPath: "D:\\app\\confirmation.html",
    preloadPath: "D:\\app\\preload.js",
    setTimeout(callback) {
      const timer = { callback, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
  });

  return { runtime, listeners, windows, timers };
}

function readyRenderer(harness, win) {
  harness.listeners.get(READY_CHANNEL)({ sender: win.webContents });
  win.emit("did-finish-load");
}

function showReadyWindow(harness, win) {
  readyRenderer(harness, win);
  harness.listeners.get(STATE_APPLIED_CHANNEL)({ sender: win.webContents });
  win.emit("ready-to-show");
}

function confirmPayload() {
  return {
    mode: "auto-tools",
    title: "Approve tool requests?",
    detail: "Supported tool requests will be approved.",
    checkboxLabel: "Do not show this again",
    confirmLabel: "Approve tools",
    cancelLabel: "Cancel",
  };
}

describe("permission automation confirmation runtime", () => {
  it("centers on the cursor display and falls back to primary display", () => {
    const nearest = computeCenteredBounds({
      getCursorScreenPoint: () => ({ x: 2000, y: 10 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 1920, y: 40, width: 1600, height: 900 } }),
      getPrimaryDisplay: () => null,
    }, 350);
    assert.deepStrictEqual(nearest, { x: 2460, y: 315, width: 520, height: 350 });

    const primary = computeCenteredBounds({
      getCursorScreenPoint: () => { throw new Error("no cursor"); },
      getPrimaryDisplay: () => ({ workArea: { x: -1280, y: 0, width: 1280, height: 720 } }),
    }, 350);
    assert.deepStrictEqual(primary, { x: -900, y: 185, width: 520, height: 350 });
  });

  it("creates a secure fixed window and sends only normalized state", async () => {
    const harness = createHarness({ dark: true });
    const promise = harness.runtime.confirmPermissionAutomation(confirmPayload());
    const win = harness.windows[0];
    assert.strictEqual(win.options.x, 2460);
    assert.strictEqual(win.options.y, 282);
    assert.strictEqual(win.options.width, 520);
    assert.strictEqual(win.options.height, 376);
    assert.strictEqual(win.options.resizable, false);
    assert.strictEqual(win.options.webPreferences.nodeIntegration, false);
    assert.strictEqual(win.options.webPreferences.contextIsolation, true);
    assert.strictEqual(win.options.webPreferences.sandbox, true);
    assert.strictEqual(win.options.backgroundColor, "#202124");
    showReadyWindow(harness, win);
    assert.strictEqual(win.shown, true);
    assert.strictEqual(harness.timers[0].cleared, true);
    assert.strictEqual(win.sent.length, 1);
    assert.strictEqual(win.sent[0].channel, STATE_CHANNEL);
    assert.deepStrictEqual(win.sent[0].payload, {
      kind: "confirm",
      lang: "en",
      title: "Approve tool requests?",
      message: "",
      detail: "Supported tool requests will be approved.",
      checkboxLabel: "Do not show this again",
      confirmLabel: "Approve tools",
      cancelLabel: "Cancel",
      dismissLabel: "",
    });
    harness.listeners.get(RESULT_CHANNEL)({ sender: win.webContents }, {
      action: "confirm",
      suppressFutureConfirmation: true,
    });
    assert.deepStrictEqual(await promise, { confirmed: true, suppressFutureConfirmation: true });
  });

  it("creates a modal child for session automation without exposing its parent to the renderer", async () => {
    const harness = createHarness();
    const parent = { isDestroyed: () => false };
    const promise = harness.runtime.confirmPermissionAutomation({
      ...confirmPayload(),
      parent,
      message: "Stop asking for this session?",
    });
    const win = harness.windows[0];
    assert.strictEqual(win.options.parent, parent);
    assert.strictEqual(win.options.modal, true);
    assert.strictEqual(win.options.skipTaskbar, true);
    assert.strictEqual(win.options.alwaysOnTop, false);
    showReadyWindow(harness, win);
    assert.strictEqual(win.sent[0].payload.message, "Stop asking for this session?");
    assert.strictEqual(Object.hasOwn(win.sent[0].payload, "parent"), false);
    harness.listeners.get(RESULT_CHANNEL)({ sender: win.webContents }, { action: "cancel" });
    assert.strictEqual((await promise).confirmed, false);
  });

  it("ignores results from any sender except the active window", async () => {
    const harness = createHarness();
    const promise = harness.runtime.confirmPermissionAutomation(confirmPayload());
    const win = harness.windows[0];
    let settled = false;
    promise.then(() => { settled = true; });
    harness.listeners.get(RESULT_CHANNEL)({ sender: {} }, { action: "confirm" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(settled, false);
    harness.listeners.get(RESULT_CHANNEL)({ sender: win.webContents }, { action: "cancel" });
    assert.deepStrictEqual(await promise, { confirmed: false, suppressFutureConfirmation: false });
  });

  it("treats the OS close action as cancellation", async () => {
    const harness = createHarness();
    const promise = harness.runtime.confirmPermissionAutomation(confirmPayload());
    harness.windows[0].close();
    assert.deepStrictEqual(await promise, { confirmed: false, suppressFutureConfirmation: false });
  });

  it("fails closed for duplicates without exposing an unfinished window, then focuses it once shown", async () => {
    const harness = createHarness();
    const first = harness.runtime.confirmPermissionAutomation(confirmPayload());
    const duplicateDuringStartup = harness.runtime.confirmPermissionAutomation({
      ...confirmPayload(),
      mode: "unattended",
    });
    assert.strictEqual(harness.windows.length, 1);
    assert.strictEqual(harness.windows[0].shown, false);
    assert.strictEqual(harness.windows[0].focusCount, 0);
    assert.deepStrictEqual(
      await duplicateDuringStartup,
      { confirmed: false, suppressFutureConfirmation: false }
    );
    showReadyWindow(harness, harness.windows[0]);
    assert.strictEqual(harness.windows[0].shown, true);
    assert.strictEqual(harness.windows[0].focusCount, 1);
    const duplicateAfterShow = harness.runtime.confirmPermissionAutomation(confirmPayload());
    assert.strictEqual(harness.windows[0].focusCount, 2);
    assert.deepStrictEqual(
      await duplicateAfterShow,
      { confirmed: false, suppressFutureConfirmation: false }
    );
    harness.listeners.get(RESULT_CHANNEL)({ sender: harness.windows[0].webContents }, { action: "cancel" });
    await first;
  });

  it("fails closed when the renderer cannot load", async () => {
    const harness = createHarness({ loadReject: true });
    const result = await harness.runtime.confirmPermissionAutomation(confirmPayload());
    assert.deepStrictEqual(result, { confirmed: false, suppressFutureConfirmation: false });
    assert.strictEqual(harness.runtime.getWindow(), null);
  });

  it("fails closed when the renderer bridge never becomes ready", async () => {
    const harness = createHarness();
    const promise = harness.runtime.confirmPermissionAutomation(confirmPayload());
    harness.windows[0].emit("did-finish-load");
    harness.timers[0].callback();
    assert.deepStrictEqual(await promise, { confirmed: false, suppressFutureConfirmation: false });
  });

  it("keeps the startup timeout armed until the initialized window is actually shown", async () => {
    const harness = createHarness();
    const promise = harness.runtime.confirmPermissionAutomation(confirmPayload());
    readyRenderer(harness, harness.windows[0]);
    harness.listeners.get(STATE_APPLIED_CHANNEL)({ sender: harness.windows[0].webContents });
    assert.strictEqual(harness.windows[0].sent.length, 1);
    assert.strictEqual(harness.windows[0].shown, false);
    assert.strictEqual(harness.timers[0].cleared, false);
    harness.timers[0].callback();
    assert.deepStrictEqual(await promise, { confirmed: false, suppressFutureConfirmation: false });
    assert.strictEqual(harness.runtime.getWindow(), null);
  });

  it("fails closed when the renderer never acknowledges that it applied the state", async () => {
    const harness = createHarness();
    const promise = harness.runtime.confirmPermissionAutomation(confirmPayload());
    readyRenderer(harness, harness.windows[0]);
    harness.windows[0].emit("ready-to-show");
    assert.strictEqual(harness.windows[0].shown, false);
    harness.timers[0].callback();
    assert.deepStrictEqual(await promise, { confirmed: false, suppressFutureConfirmation: false });
  });

  it("fails closed when the window cannot be created", async () => {
    const harness = createHarness({ constructorThrows: true });
    const result = await harness.runtime.confirmPermissionAutomation(confirmPayload());
    assert.deepStrictEqual(result, { confirmed: false, suppressFutureConfirmation: false });
    assert.strictEqual(harness.windows.length, 0);
  });

  it("fails closed when the initialized window cannot be shown", async () => {
    const harness = createHarness({ showThrows: true });
    const promise = harness.runtime.confirmPermissionAutomation(confirmPayload());
    showReadyWindow(harness, harness.windows[0]);
    assert.deepStrictEqual(await promise, { confirmed: false, suppressFutureConfirmation: false });
    assert.strictEqual(harness.runtime.getWindow(), null);
  });

  it("uses the same window for styled persistence errors", async () => {
    const harness = createHarness();
    const promise = harness.runtime.showPermissionAutomationError({
      title: "Permission handling",
      detail: "disk full",
      dismissLabel: "Dismiss",
    });
    const win = harness.windows[0];
    assert.strictEqual(win.options.width, 520);
    assert.strictEqual(win.options.height, 280);
    readyRenderer(harness, win);
    assert.strictEqual(win.sent[0].payload.kind, "error");
    assert.strictEqual(win.sent[0].payload.detail, "disk full");
    harness.listeners.get(RESULT_CHANNEL)({ sender: win.webContents }, { action: "dismiss" });
    assert.strictEqual(await promise, undefined);
  });

  it("cancels an active confirmation before showing a persistence error", async () => {
    const harness = createHarness();
    const confirmation = harness.runtime.confirmPermissionAutomation(confirmPayload());
    const error = harness.runtime.showPermissionAutomationError({
      title: "Permission handling",
      detail: "read only",
      dismissLabel: "Dismiss",
    });
    assert.deepStrictEqual(
      await confirmation,
      { confirmed: false, suppressFutureConfirmation: false }
    );
    assert.strictEqual(harness.windows.length, 2);
    const errorWindow = harness.windows[1];
    showReadyWindow(harness, errorWindow);
    harness.listeners.get(RESULT_CHANNEL)({ sender: errorWindow.webContents }, { action: "dismiss" });
    assert.strictEqual(await error, undefined);
  });

  it("removes its IPC listener when disposed", () => {
    const harness = createHarness();
    assert.ok(harness.listeners.has(RESULT_CHANNEL));
    harness.runtime.dispose();
    assert.strictEqual(harness.listeners.has(RESULT_CHANNEL), false);
    assert.strictEqual(harness.listeners.has(STATE_APPLIED_CHANNEL), false);
  });
});

describe("permission automation confirmation document", () => {
  it("declares accessible dialog semantics", () => {
    const html = fs.readFileSync(
      path.join(__dirname, "../src/permission-automation-confirmation.html"),
      "utf8"
    );
    assert.match(
      html,
      /<main id="dialog" class="dialog" data-kind="confirm" role="dialog" aria-modal="true" aria-labelledby="title" aria-describedby="detail">/
    );
    assert.match(html, /<svg class="warning-glyph"/);
    assert.match(html, /img-src 'self'/);
    assert.match(html, /<img class="brand-icon" src="\.\.\/assets\/icons\/64x64\.png" alt="" aria-hidden="true">/);
    assert.strictEqual(
      fs.existsSync(path.join(__dirname, "../assets/icons/64x64.png")),
      true,
      "the relative dialog icon must be included in the repository"
    );
    assert.match(html, /<div class="risk-detail"><p id="detail"><\/p><\/div>/);
    assert.doesNotMatch(html, /class="warning-icon"[^>]*>\s*!/);
    assert.doesNotMatch(html, /[A-Z]:\\/);
  });

  it("uses shared visual tokens and visible keyboard focus treatments", () => {
    const css = fs.readFileSync(
      path.join(__dirname, "../src/permission-automation-confirmation.css"),
      "utf8"
    );
    assert.match(css, /--accent:\s*#d97757/);
    assert.doesNotMatch(css, /\.dialog-card\s*\{/);
    assert.match(css, /grid-template-rows:\s*40px minmax\(0, 1fr\) auto/);
    assert.match(css, /\.brand-icon\s*\{[\s\S]*width:\s*20px;[\s\S]*height:\s*20px;/);
    assert.match(css, /\.icon-button\s*\{[\s\S]*width:\s*40px;[\s\S]*height:\s*39px;/);
    assert.match(css, /\.risk-detail\s*\{/);
    assert.match(css, /\.actions button:focus-visible/);
    assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  });
});

describe("permission automation confirmation renderer", () => {
  function createRendererHarness() {
    const elements = new Map();
    const makeElement = () => ({
      textContent: "",
      title: "",
      hidden: false,
      checked: false,
      dataset: {},
      listeners: new Map(),
      classList: { toggle() {} },
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      setAttribute(name, value) { this[name] = value; },
      focus() { this.focused = true; },
    });
    for (const id of ["dialog", "title", "message", "detail", "checkbox-row", "suppress", "checkbox-label", "confirm", "cancel", "close"]) {
      elements.set(id, makeElement());
    }
    const documentListeners = new Map();
    const submissions = [];
    let readyCount = 0;
    let stateAppliedCount = 0;
    let stateListener = null;
    const documentElement = { lang: "en" };
    const sandbox = {
      window: {
        permissionAutomationConfirmation: {
          onState(listener) { stateListener = listener; },
          ready() { readyCount += 1; },
          stateApplied() { stateAppliedCount += 1; },
          submit(payload) { submissions.push(payload); },
        },
      },
      document: {
        documentElement,
        title: "",
        getElementById: (id) => elements.get(id),
        addEventListener: (name, listener) => documentListeners.set(name, listener),
      },
    };
    const source = fs.readFileSync(
      path.join(__dirname, "../src/permission-automation-confirmation-renderer.js"),
      "utf8"
    );
    vm.runInNewContext(source, sandbox);
    return {
      elements,
      documentListeners,
      submissions,
      stateListener,
      readyCount,
      documentElement,
      get documentTitle() { return sandbox.document.title; },
      get stateAppliedCount() { return stateAppliedCount; },
    };
  }

  it("submits explicit confirmation with the checkbox state", () => {
    const harness = createRendererHarness();
    assert.strictEqual(harness.readyCount, 1);
    harness.stateListener({
      kind: "confirm",
      title: "Approve tools?",
      detail: "Details",
      checkboxLabel: "Do not show again",
      confirmLabel: "Approve",
      cancelLabel: "Cancel",
    });
    harness.elements.get("suppress").checked = true;
    harness.elements.get("confirm").listeners.get("click")();
    assert.strictEqual(harness.submissions.length, 1);
    assert.strictEqual(harness.submissions[0].action, "confirm");
    assert.strictEqual(harness.submissions[0].suppressFutureConfirmation, true);
    assert.strictEqual(harness.elements.get("close").title, "Cancel");
    assert.strictEqual(harness.elements.get("cancel").focused, true);
    assert.strictEqual(harness.elements.get("confirm").focused, undefined);
    assert.strictEqual(harness.stateAppliedCount, 1);
    assert.strictEqual(harness.elements.get("dialog").dataset.kind, "confirm");
  });

  it("shows the optional message and focuses only the safe default action", () => {
    const harness = createRendererHarness();
    harness.stateListener({
      kind: "confirm",
      lang: "ko",
      title: "Trust this session?",
      message: "Stop asking for tool permissions in this session?",
      detail: "This ends with the session.",
      confirmLabel: "Trust this session",
      cancelLabel: "Cancel",
    });
    assert.strictEqual(
      harness.elements.get("message").textContent,
      "Stop asking for tool permissions in this session?"
    );
    assert.strictEqual(harness.elements.get("message").hidden, false);
    assert.strictEqual(harness.elements.get("cancel").focused, true);
    assert.strictEqual(harness.elements.get("confirm").focused, undefined);
    assert.strictEqual(harness.documentElement.lang, "ko");
    assert.strictEqual(harness.documentTitle, "Trust this session?");
  });

  it("focuses Dismiss for an error because it is the only action", () => {
    const harness = createRendererHarness();
    harness.stateListener({
      kind: "error",
      title: "Permission handling",
      detail: "disk full",
      dismissLabel: "Dismiss",
    });
    assert.strictEqual(harness.elements.get("message").hidden, true);
    assert.strictEqual(harness.elements.get("confirm").focused, true);
    assert.strictEqual(harness.elements.get("cancel").hidden, true);
  });

  it("maps Cancel, close, and Escape to fail-closed cancellation", () => {
    const harness = createRendererHarness();
    harness.elements.get("cancel").listeners.get("click")();
    harness.elements.get("close").listeners.get("click")();
    let prevented = false;
    harness.documentListeners.get("keydown")({
      key: "Escape",
      preventDefault() { prevented = true; },
    });
    assert.strictEqual(prevented, true);
    assert.deepStrictEqual(harness.submissions.map((entry) => entry.action), [
      "cancel",
      "cancel",
      "cancel",
    ]);
  });
});
