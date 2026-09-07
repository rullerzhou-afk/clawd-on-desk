"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const EventEmitter = require("node:events");
const Module = require("node:module");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function harness(options = {}) {
  const windows = [];
  const handlers = new Map();
  const theme = new EventEmitter();
  theme.shouldUseDarkColors = false;
  let snapshot = options.snapshot || {
    sessions: [{ id: "a", canFocus: true, displayTitle: "Alpha", agentName: "Codex", badge: "running" }],
    orderedIds: ["a"],
  };
  const calls = [];
  class Window extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.bounds = opts;
      this.visible = false;
      this.focused = false;
      this.destroyed = false;
      this.showCount = 0;
      this.hideCount = 0;
      this.sent = [];
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: pathToFileURL(path.join(__dirname, "../src/session-quick-select.html")).toString() },
        isDestroyed: () => this.destroyed,
        send: (...args) => this.sent.push(args),
        setWindowOpenHandler: (fn) => { this.openHandler = fn; },
        insertCSS: () => Promise.resolve("css"),
        removeInsertedCSS: () => Promise.resolve(),
        setZoomFactor: () => {},
      });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    setMenuBarVisibility() {}
    setBackgroundColor(value) { this.backgroundColor = value; }
    setTitle(value) { this.title = value; }
    loadFile() { this.webContents.emit("did-start-navigation", {}, "file:///test", false, true); }
    show() { this.visible = true; this.showCount += 1; }
    focus() { this.focused = true; }
    hide() { this.visible = false; this.hideCount += 1; this.focused = false; this.emit("blur"); }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const originalLoad = Module._load;
  delete require.cache[require.resolve("../src/session-quick-select")];
  Module._load = function (request) {
    if (request === "electron") return {
      BrowserWindow: Window, nativeTheme: theme,
      screen: {
        getCursorScreenPoint: () => ({ x: 100, y: 100 }),
        getDisplayNearestPoint: () => ({ workArea: options.workArea || { x: 0, y: 0, width: 1920, height: 1080 } }),
      },
    };
    return originalLoad.apply(this, arguments);
  };
  let init;
  try { init = require("../src/session-quick-select"); }
  finally { Module._load = originalLoad; }
  const owner = init({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) },
    platform: options.platform || "win32",
    originFocus: options.originFocus || { capture: () => null, restore: () => false },
    getTextScale: () => options.textScale || 1,
    getSessionSnapshot: () => snapshot,
    getI18n: () => ({ lang: "en", translations: {} }),
    t: (key) => key,
    focusSession: (...args) => {
      calls.push(args);
      return options.focusSession ? options.focusSession(...args) : true;
    },
  });
  const event = () => ({ sender: owner.getWindow().webContents, senderFrame: owner.getWindow().webContents.mainFrame });
  const invoke = (channel, payload, sender = event()) => handlers.get(`quick-select:${channel}`)(sender, payload);
  const open = () => {
    owner.show();
    owner.getWindow().webContents.emit("did-finish-load");
    return invoke("consume-intent");
  };
  return { owner, windows, handlers, theme, calls, invoke, open, event, setSnapshot: (value) => { snapshot = value; } };
}

test("cold shortcut intent is consumable once, after listeners and painting are ready", () => {
  const h = harness();
  const win = h.owner.show();
  h.owner.show();
  win.webContents.emit("did-finish-load");
  assert.equal(win.visible, false);
  assert.equal(h.windows.length, 1);
  const result = h.invoke("consume-intent");
  assert.equal(result.enterQuickSelect, true);
  assert.deepEqual(result.entries.map((entry) => entry.id), ["a"]);
  assert.equal(win.visible, true);
  assert.equal(win.focused, true);
  assert.equal(h.invoke("consume-intent").enterQuickSelect, false);
  assert.equal(win.showCount, 1);
  assert.equal(h.handlers.size, 3);
  h.owner.dispose();
});

test("reloaded renderer resets readiness and consumes a new intent; closed windows cannot receive old IPC", () => {
  const h = harness();
  const first = h.open();
  const win = h.owner.getWindow();
  const staleEvent = h.event();
  win.webContents.emit("did-start-navigation", {}, "file:///reload", false, true);
  win.webContents.emit("did-finish-load");
  assert.equal(win.showCount, 1);
  const reloaded = h.invoke("consume-intent");
  assert.equal(reloaded.enterQuickSelect, true);
  assert.ok(reloaded.revision > first.revision);
  assert.equal(win.showCount, 2);
  win.destroy();
  assert.equal(h.owner.getWindow(), null);
  h.open();
  assert.equal(h.invoke("consume-intent", undefined, staleEvent).reason, "untrusted-quick-select-sender");
  assert.equal(h.windows.length, 2);
  h.owner.dispose();
});

test("every capability rejects foreign contents, child frames and navigated documents", () => {
  const h = harness();
  h.open();
  for (const [channel, payload] of [["consume-intent"], ["dismiss"], ["activate-session", { sessionId: "a" }]]) {
    const trusted = h.event();
    for (const event of [
      { ...trusted, sender: {} },
      { ...trusted, senderFrame: { ...trusted.senderFrame } },
      { sender: trusted.sender },
    ]) {
      assert.equal(h.invoke(channel, payload, event).reason, "untrusted-quick-select-sender");
    }
    const originalUrl = trusted.senderFrame.url;
    trusted.senderFrame.url = "https://example.com/";
    assert.equal(h.invoke(channel, payload).reason, "untrusted-quick-select-sender");
    trusted.senderFrame.url = originalUrl;
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.owner.getWindow().visible, true);
  h.owner.dispose();
});

test("selection freezes first nine group-ordered IDs and only publishes narrow presentation fields", () => {
  const sessions = Array.from({ length: 13 }, (_, i) => ({ id: `s${i}`, canFocus: i > 0, sourcePid: 123, cwd: "/private", displayTitle: `Title ${i}` }));
  const h = harness({ snapshot: { sessions, groups: [{ ids: ["s3", "s1", "s3", "s0"] }], orderedIds: sessions.map((s) => s.id) } });
  const first = h.open();
  assert.deepEqual(first.entries.map((entry) => entry.id), ["s3", "s1", "s2", "s4", "s5", "s6", "s7", "s8", "s9"]);
  assert.equal(Object.hasOwn(first.entries[0], "sourcePid"), false);
  assert.equal(Object.hasOwn(first.entries[0], "cwd"), false);
  const next = { sessions: sessions.filter((s) => s.id !== "s3").map((s) => ({ ...s, displayTitle: "Updated" })).reverse() };
  h.setSnapshot(next);
  h.owner.broadcastSessionSnapshot(next);
  const [, payload] = h.owner.getWindow().sent.at(-1);
  assert.deepEqual(payload.entries.map((entry) => entry.id), first.entries.map((entry) => entry.id));
  assert.equal(payload.entries[0].canFocus, false);
  assert.equal(payload.entries[0].title, "Title 3");
  assert.equal(payload.entries[1].title, "Updated");
  assert.equal(h.invoke("activate-session", { sessionId: "s3" }).status, "rejected");
  assert.equal(h.invoke("activate-session", { sessionId: "s10" }).status, "rejected");
  assert.equal(h.calls.length, 0);
  h.owner.dispose();
});

test("activation validates fresh eligibility and exact payload, dispatches once, and never hides on submitted", () => {
  const h = harness();
  h.open();
  for (const payload of [null, "a", {}, { sessionId: 1 }, { sessionId: "" }, { sessionId: "a", ack: true }, ["a"]]) {
    assert.equal(h.invoke("activate-session", payload).reason, "invalid-payload");
  }
  h.setSnapshot({ sessions: [{ id: "a", canFocus: false }] });
  assert.equal(h.invoke("activate-session", { sessionId: "a" }).reason, "focus-unavailable");
  h.setSnapshot({ sessions: [{ id: "a", canFocus: true }] });
  assert.deepEqual(h.invoke("activate-session", { sessionId: "a" }), { status: "submitted" });
  assert.deepEqual(h.calls, [["a", { requestSource: "quick-select" }]]);
  assert.equal(h.owner.getWindow().visible, true);
  assert.equal(h.owner.getWindow().hideCount, 0);
  assert.equal(h.invoke("activate-session", { sessionId: "a" }).reason, "dropped-duplicate");
  h.owner.getWindow().focused = false;
  h.owner.getWindow().emit("blur");
  assert.equal(h.owner.getWindow().visible, false);
  assert.equal(h.invoke("activate-session", { sessionId: "a" }).reason, "quick-select-inactive");
  h.owner.dispose();
});

test("focus exceptions, duplicate rejection and asynchronous diagnostics do not hide the window", async () => {
  for (const focusSession of [() => { throw Error("gone"); }, () => ({ reason: "dropped-duplicate" }), () => Promise.resolve({ confirmed: false })]) {
    const h = harness({ focusSession });
    h.open();
    const result = h.invoke("activate-session", { sessionId: "a" });
    assert.ok(["submitted", "rejected"].includes(result.status));
    await Promise.resolve();
    assert.equal(h.owner.getWindow().hideCount, 0);
    h.owner.dispose();
  }
});

test("empty entry never admits newly appearing sessions until another explicit shortcut", () => {
  const h = harness({ snapshot: { sessions: [] } });
  assert.deepEqual(h.open().entries, []);
  h.setSnapshot({ sessions: [{ id: "new", canFocus: true }] });
  assert.equal(h.invoke("activate-session", { sessionId: "new" }).reason, "focus-unavailable");
  assert.deepEqual(h.open().entries.map((entry) => entry.id), ["new"]);
  assert.equal(h.invoke("activate-session", { sessionId: "new" }).status, "submitted");
  h.owner.dispose();
});

test("only explicit cancellation restores the captured source, never target-driven blur", () => {
  const restores = [];
  const source = { hwnd: 42, pid: 3 };
  const h = harness({ originFocus: { capture: () => source, restore: (...args) => restores.push(args) } });
  h.open();
  h.invoke("dismiss");
  assert.equal(restores.length, 1);
  assert.equal(restores[0][0], source);
  h.open();
  h.owner.getWindow().focused = false;
  h.owner.getWindow().emit("blur");
  assert.equal(restores.length, 1);
  h.owner.dispose();
});

test("Windows keeps its tool window, Mac uses a non-activating panel, and geometry fits the display", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const h = harness({ platform, textScale: 1.6, workArea: { x: -400, y: 20, width: 400, height: 300 } });
    h.open();
    const win = h.owner.getWindow();
    assert.equal(win.opts.skipTaskbar, platform !== "darwin");
    assert.equal(win.opts.type, { win32: "toolbar", darwin: "panel" }[platform]);
    assert.equal(win.opts.alwaysOnTop, false);
    assert.equal(win.opts.parent, undefined);
    assert.equal(win.opts.webPreferences.sandbox, true);
    assert.ok(win.bounds.width <= 400 && win.bounds.height <= 300);
    assert.deepEqual(win.openHandler(), { action: "deny" });
    let prevented = false;
    win.webContents.emit("will-navigate", { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    h.owner.dispose();
    assert.equal(h.handlers.size, 0);
    assert.equal(h.theme.listenerCount("updated"), 0);
  }
});

test("Mac panel retains focused trusted IPC through reload and reuse, hiding only after target blur", () => {
  const h = harness({ platform: "darwin" });
  h.open();
  const win = h.owner.getWindow();
  assert.equal(win.opts.type, "panel");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    win.webContents.emit("did-start-navigation", {}, "file:///reload", false, true);
    win.webContents.emit("did-finish-load");
    assert.equal(h.invoke("consume-intent").enterQuickSelect, true);
    assert.equal(win.focused, true);
    assert.equal(h.invoke("activate-session", { sessionId: "a" }).status, "submitted");
    assert.equal(h.invoke("activate-session", { sessionId: "a" }).reason, "dropped-duplicate");
    assert.equal(win.visible, true);
    win.focused = false;
    win.emit("blur");
    assert.equal(win.visible, false);
    assert.equal(h.invoke("activate-session", { sessionId: "a" }).reason, "quick-select-inactive");
    h.open();
    assert.equal(h.owner.getWindow(), win);
  }
  assert.equal(h.calls.length, 2);
  h.invoke("dismiss");
  assert.equal(win.visible, false);
  assert.equal(h.windows.length, 1);
  h.owner.dispose();
});
