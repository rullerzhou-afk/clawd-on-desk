"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const createRoamFencePicker = require("../src/roam-fence-picker");
const {
  READY_CHANNEL,
  APPLIED_CHANNEL,
  RESULT_CHANNEL,
  STATE_CHANNEL,
  selectionToFence,
} = require("../src/roam-fence-picker");

class FakeIpcMain extends EventEmitter {}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.mainFrame = { url: "" };
    this.windowOpenHandler = null;
  }
  send(channel, payload) { this.sent.push([channel, payload]); }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  isDestroyed() { return false; }
}

class FakeBrowserWindow extends EventEmitter {
  static instances = [];
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.shown = false;
    this.focused = false;
    this.closed = false;
    this.loadPath = null;
    FakeBrowserWindow.instances.push(this);
  }
  isDestroyed() { return this.destroyed; }
  loadFile(filePath) {
    this.loadPath = filePath;
    this.webContents.mainFrame.url = pathToFileURL(filePath).href;
    return Promise.resolve();
  }
  setMenuBarVisibility() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  show() { this.shown = true; }
  focus() { this.focused = true; }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.destroyed = true;
    this.emit("closed");
  }
  destroy() { this.close(); }
}

function makeRuntime(overrides = {}) {
  FakeBrowserWindow.instances = [];
  const ipcMain = new FakeIpcMain();
  const settingsWindow = {
    hidden: false,
    shown: false,
    focused: false,
    isDestroyed: () => false,
    hide() { this.hidden = true; },
    show() { this.shown = true; },
    moveTop() {},
    focus() { this.focused = true; },
  };
  const screen = new EventEmitter();
  Object.assign(screen, {
    getDisplayMatching: () => ({
      id: 7,
      scaleFactor: 2,
      workArea: { x: -1600, y: 25, width: 1600, height: 900 },
    }),
    getPrimaryDisplay: () => ({
      id: 1,
      scaleFactor: 1,
      workArea: { x: 0, y: 0, width: 1280, height: 800 },
    }),
  });
  const runtime = createRoamFencePicker({
    BrowserWindow: FakeBrowserWindow,
    ipcMain,
    screen,
    path: require("node:path"),
    getSettingsWindow: () => settingsWindow,
    getPetWindowBounds: () => ({ x: -1400, y: 100, width: 120, height: 100 }),
    getEffectivePetSize: () => ({ width: 120, height: 100 }),
    ...overrides,
  });
  return { runtime, ipcMain, settingsWindow, screen };
}

function pickerEvent(win, overrides = {}) {
  return {
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
    ...overrides,
  };
}

function finishStartup(harness, applyState = true) {
  const win = FakeBrowserWindow.instances[0];
  win.webContents.emit("did-finish-load");
  harness.ipcMain.emit(READY_CHANNEL, pickerEvent(win));
  win.emit("ready-to-show");
  if (applyState) harness.ipcMain.emit(APPLIED_CHANNEL, pickerEvent(win));
  return win;
}

test("pixel selection converts to normalized work-area fractions", () => {
  const workArea = { x: -1200, y: 20, width: 1000, height: 800 };
  assert.deepStrictEqual(selectionToFence(
    { x: 250, y: 200, width: 500, height: 400 },
    workArea,
    { width: 120, height: 100 },
  ), { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 });
});

test("selection uses the overlay's realized integer size for fractional work areas", () => {
  assert.deepStrictEqual(selectionToFence(
    { x: 0, y: 0, width: 1001, height: 801 },
    { x: 0, y: 0, width: 1000.6, height: 800.6 },
  ), { left: 0, top: 0, right: 1, bottom: 1 });
});

test("picker page limits local content with a restrictive CSP", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "roam-fence-picker.html"), "utf8");
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'; style-src 'unsafe-inline'; script-src 'self'/);
  assert.match(html, /touch-action:\s*none/);
});

test("selection rejects rectangles outside the overlay or smaller than the pet", () => {
  const wa = { x: 0, y: 0, width: 1000, height: 800 };
  assert.strictEqual(selectionToFence({ x: -1, y: 0, width: 200, height: 200 }, wa, {}), null);
  assert.strictEqual(selectionToFence({ x: 900, y: 0, width: 200, height: 200 }, wa, {}), null);
  assert.strictEqual(selectionToFence(
    { x: 0, y: 0, width: 119, height: 100 }, wa, { width: 120, height: 100 },
  ), null);
});

test("picker starts blank, covers the pet display, waits for renderer readiness, and restores Settings", async () => {
  const harness = makeRuntime();
  const resultPromise = harness.runtime.selectArea({
    lang: "zh",
    fence: { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 },
  });
  const win = FakeBrowserWindow.instances[0];
  assert.deepStrictEqual(
    { x: win.options.x, y: win.options.y, width: win.options.width, height: win.options.height },
    { x: -1600, y: 25, width: 1600, height: 900 },
  );
  assert.strictEqual(win.options.webPreferences.sandbox, true);
  assert.strictEqual(win.shown, false);
  assert.strictEqual(harness.settingsWindow.hidden, false);

  finishStartup(harness, false);
  assert.strictEqual(win.shown, false, "the overlay stays hidden until the renderer applies state");
  assert.strictEqual(harness.settingsWindow.hidden, false);
  assert.strictEqual(win.webContents.sent.length, 1);
  assert.strictEqual(win.webContents.sent[0][0], STATE_CHANNEL);
  assert.deepStrictEqual(win.webContents.sent[0][1], {
    lang: "zh",
    workArea: { width: 1600, height: 900 },
    displayId: 7,
    scaleFactor: 2,
    minimumSize: { width: 120, height: 100 },
  });
  assert.deepStrictEqual(win.webContents.windowOpenHandler(), { action: "deny" });

  harness.ipcMain.emit(APPLIED_CHANNEL, pickerEvent(win));
  assert.strictEqual(win.shown, true);
  assert.strictEqual(harness.settingsWindow.hidden, true);

  harness.ipcMain.emit(RESULT_CHANNEL, pickerEvent(win), {
    action: "confirm",
    selection: { x: 320, y: 180, width: 960, height: 540 },
  });
  assert.deepStrictEqual(await resultPromise, {
    status: "ok",
    fence: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 },
  });
  assert.strictEqual(harness.settingsWindow.shown, true);
  assert.strictEqual(harness.settingsWindow.focused, true);
  assert.strictEqual(harness.runtime.getWindow(), null);
  harness.runtime.dispose();
});

test("picker refuses to claim success when the effective pet cannot fit on the display", async () => {
  const harness = makeRuntime({
    getEffectivePetSize: () => ({ width: 1700, height: 1000 }),
  });
  assert.deepStrictEqual(await harness.runtime.selectArea({ lang: "en" }), {
    status: "error",
    code: "pet-too-large",
    message: "the pet is larger than this display's work area",
  });
  assert.strictEqual(FakeBrowserWindow.instances.length, 0);
  assert.strictEqual(harness.settingsWindow.hidden, false);
  harness.runtime.dispose();
});

test("picker preserves Brazilian Portuguese instead of falling back to English", async () => {
  const harness = makeRuntime();
  const resultPromise = harness.runtime.selectArea({ lang: "pt-BR" });
  const win = finishStartup(harness, false);
  assert.strictEqual(win.webContents.sent[0][1].lang, "pt-BR");
  harness.ipcMain.emit(APPLIED_CHANNEL, pickerEvent(win));
  harness.ipcMain.emit(RESULT_CHANNEL, pickerEvent(win), { action: "cancel" });
  assert.deepStrictEqual(await resultPromise, { status: "cancel" });
  harness.runtime.dispose();
});

test("picker ignores spoofed IPC senders and coalesces duplicate requests", async () => {
  const harness = makeRuntime();
  const first = harness.runtime.selectArea({ lang: "en" });
  const second = harness.runtime.selectArea({ lang: "ja" });
  assert.strictEqual(first, second);
  assert.strictEqual(FakeBrowserWindow.instances.length, 1);
  assert.strictEqual(FakeBrowserWindow.instances[0].shown, false, "duplicate startup must not expose a blank overlay");
  const win = finishStartup(harness);
  harness.ipcMain.emit(RESULT_CHANNEL, { sender: {}, senderFrame: null }, {
    action: "confirm",
    selection: { x: 0, y: 0, width: 1600, height: 900 },
  });
  assert.strictEqual(harness.runtime.getWindow(), win);
  harness.ipcMain.emit(RESULT_CHANNEL, {
    sender: win.webContents,
    senderFrame: { url: win.webContents.mainFrame.url },
  }, { action: "cancel" });
  assert.strictEqual(harness.runtime.getWindow(), win, "a same-WebContents subframe is not trusted");
  const pickerUrl = win.webContents.mainFrame.url;
  win.webContents.mainFrame.url = "https://example.invalid/";
  harness.ipcMain.emit(RESULT_CHANNEL, pickerEvent(win), { action: "cancel" });
  assert.strictEqual(harness.runtime.getWindow(), win, "the main frame must still be the exact local picker URL");
  win.webContents.mainFrame.url = pickerUrl;
  harness.ipcMain.emit(RESULT_CHANNEL, pickerEvent(win), { action: "cancel" });
  assert.deepStrictEqual(await first, { status: "cancel" });
  harness.runtime.dispose();
});

test("picker blocks navigation away from its local page", async () => {
  const harness = makeRuntime();
  const resultPromise = harness.runtime.selectArea();
  const win = finishStartup(harness);
  const event = {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  win.webContents.emit("will-navigate", event, "https://example.invalid/");
  assert.strictEqual(event.defaultPrevented, true);
  assert.deepStrictEqual(await resultPromise, {
    status: "error",
    message: "area picker navigation was blocked",
  });
  assert.strictEqual(harness.settingsWindow.shown, true);
  harness.runtime.dispose();
});

test("picker blocks reload-style navigation to the same local page", async () => {
  const harness = makeRuntime();
  const resultPromise = harness.runtime.selectArea();
  const win = finishStartup(harness);
  const event = {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
  win.webContents.emit("will-navigate", event, win.webContents.mainFrame.url);
  assert.strictEqual(event.defaultPrevented, true);
  assert.deepStrictEqual(await resultPromise, {
    status: "error",
    message: "area picker navigation was blocked",
  });
  harness.runtime.dispose();
});

test("picker closes instead of losing state on a programmatic main-frame reload", async () => {
  const harness = makeRuntime();
  const resultPromise = harness.runtime.selectArea();
  const win = finishStartup(harness);
  win.webContents.emit(
    "did-start-navigation",
    {},
    win.webContents.mainFrame.url,
    false,
    true,
  );
  assert.deepStrictEqual(await resultPromise, {
    status: "error",
    message: "area picker navigation was blocked",
  });
  harness.runtime.dispose();
});

test("picker cancels safely if its display changes while selection is open", async () => {
  const harness = makeRuntime();
  const resultPromise = harness.runtime.selectArea();
  const win = finishStartup(harness);
  harness.screen.emit("display-metrics-changed", {}, { id: 8 });
  assert.strictEqual(harness.runtime.getWindow(), win, "an unrelated display change is ignored");
  harness.screen.emit("display-metrics-changed", {}, { id: 7 });
  assert.deepStrictEqual(await resultPromise, {
    status: "error",
    code: "display-changed",
    message: "the display changed while choosing an area; try again",
  });
  assert.strictEqual(harness.settingsWindow.shown, true);
  assert.strictEqual(harness.screen.listenerCount("display-removed"), 0);
  assert.strictEqual(harness.screen.listenerCount("display-metrics-changed"), 0);
  harness.runtime.dispose();
});

test("closing the picker cancels and restores Settings", async () => {
  const harness = makeRuntime();
  const resultPromise = harness.runtime.selectArea();
  const win = finishStartup(harness);
  win.close();
  assert.deepStrictEqual(await resultPromise, { status: "cancel" });
  assert.strictEqual(harness.settingsWindow.shown, true);
  harness.runtime.dispose();
});

test("disposing during app shutdown closes the picker without flashing Settings", async () => {
  const harness = makeRuntime();
  const resultPromise = harness.runtime.selectArea();
  finishStartup(harness);
  assert.strictEqual(harness.settingsWindow.hidden, true);
  harness.runtime.dispose();
  assert.deepStrictEqual(await resultPromise, { status: "cancel" });
  assert.strictEqual(harness.settingsWindow.shown, false);
});

test("main shares one fence loader between roam and the Settings picker", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(main, /const roamFenceLoader = createRoamFenceLoader\(\);/);
  assert.match(main, /const roamFenceSettings = createRoamFenceSettings\(\{ loader: roamFenceLoader \}\);/);
  assert.match(main, /roamFencePickerRuntime = createRoamFencePicker\(\{/);
  assert.match(main, /registerSettingsIpc\(\{[\s\S]*?roamFenceSettings,[\s\S]*?roamFencePicker: roamFencePickerRuntime,[\s\S]*?\}\);/);
  assert.match(main, /const _roamCtx = \{[\s\S]*?roamFence: roamFenceLoader,[\s\S]*?\};/);
  assert.match(main, /app\.on\("before-quit"[\s\S]*?roamFencePickerRuntime\.dispose\(\);/);
});
