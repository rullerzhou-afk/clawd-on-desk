"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createSessionResultCards } = require("../src/session-result-cards");
const { createSessionResultWindow } = require("../src/session-result-window");
const { computeSessionResultBounds } = require("../src/session-result-layout");
const { dictionaries } = require("../src/session-result-i18n");
function fixture(t) {
  const handlers = new Map();
  const ipc = new EventEmitter();
  ipc.handle = (key, fn) => handlers.set(key, fn);
  ipc.removeHandler = key => handlers.delete(key);
  class Window extends EventEmitter {
    constructor() {
      super(); this.visible = false; this.bounds = { x: 0, y: 0, width: 340, height: 520 };
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: {}, send: () => {}, setWindowOpenHandler: () => {},
        isDestroyed: () => false, insertCSS: async () => "key", removeInsertedCSS: async () => {},
      });
    }
    loadFile() { setImmediate(() => this.webContents.emit("did-finish-load")); return Promise.resolve(); }
    isDestroyed() { return !!this.destroyed; }
    getBounds() { return this.bounds; }
    setBounds(bounds) { this.bounds = bounds; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    setSkipTaskbar() {}
    setAlwaysOnTop() {}
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  let runtime;
  let suppressed = false;
  let area = { x: 0, y: 0, width: 1200, height: 900 };
  let open = async () => "opened";
  const store = createSessionResultCards({ enabled: true, onChange: () => runtime?.schedule() });
  runtime = createSessionResultWindow({
    BrowserWindow: Window, ipcMain: ipc, store,
    focus: { canOpen: () => true, open: card => open(card) }, getLang: () => "zh",
    isSuppressed: override => override === undefined ? suppressed : override,
    getLayout: () => ({ workArea: area, fixedCorner: "bottom-right" }),
  });
  const complete = () => {
    store.observe({ agentId: "kimi-cli", sessionId: "s", event: "UserPromptSubmit" }, { state: "thinking" });
    store.observe({
      agentId: "kimi-cli", sessionId: "s", event: "Stop", state: "attention",
      snapshotEventAt: 100, occurredAt: 100,
    }, { id: "s", agentId: "kimi-cli", badge: "done", lastEvent: { rawEvent: "Stop", at: 100 } });
    return store.list()[0];
  };
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
  const event = () => ({ sender: runtime.getWindow().webContents, senderFrame: runtime.getWindow().webContents.mainFrame });
  const request = (action, card, sender = event()) => handlers.get("session-result:" + action)(sender, card);
  t.after(() => runtime.dispose());
  return {
    store, runtime, handlers, ipc, complete, flush, event, request,
    suppress: value => { suppressed = value; runtime.sync(); },
    area: value => { area = value; runtime.sync(); },
    setOpen: fn => { open = fn; },
  };
}
test("sender/main-frame/generation validation and pending old opens cannot remove new cards", async t => {
  const f = fixture(t);
  const old = f.complete(); await f.flush();
  assert.equal(f.runtime.getWindow().isVisible(), true);
  assert.equal(await f.request("dismiss", old, { sender: {} }), false);
  assert.equal(await f.request("dismiss", old, { ...f.event(), senderFrame: {} }), false);
  assert.equal(await f.request("dismiss", { ...old, generation: old.generation + 1 }), false);
  let finish;
  f.setOpen(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.request("open", old);
  assert.equal(f.store.list()[0].opening, true);
  const next = f.complete();
  finish("opened"); await pending;
  assert.equal(f.store.list()[0].id, next.id);
  f.setOpen(async () => "unconfirmed");
  await f.request("open", next);
  assert.equal(f.store.list()[0].notice, "unconfirmed");
  assert.equal(f.store.list()[0].opening, false);
  f.setOpen(async () => "opened");
  await f.request("open", next); await f.flush();
  assert.equal(f.store.list().length, 0);
  assert.equal(f.runtime.getWindow().isVisible(), false);
});
test("suppression and no-space preserve cards; show restores; invalid measurement ignored; cleanup removes IPC", async t => {
  const f = fixture(t);
  f.complete(); await f.flush();
  const win = f.runtime.getWindow();
  f.suppress(true); assert.equal(win.isVisible(), false);
  assert.equal(f.store.list().length, 1);
  f.suppress(false); assert.equal(win.isVisible(), true);
  f.runtime.setFullscreenSuppressed(true); assert.equal(win.isVisible(), false);
  f.runtime.setFullscreenSuppressed(false); assert.equal(win.isVisible(), true);
  f.area({ x: 0, y: 0, width: 200, height: 100 }); assert.equal(win.isVisible(), false);
  f.area({ x: -1400, y: -900, width: 1400, height: 900 }); assert.equal(win.isVisible(), true);
  const before = win.getBounds();
  f.ipc.emit("session-result:height", f.event(), Infinity);
  f.ipc.emit("session-result:height", { ...f.event(), senderFrame: {} }, 120);
  await f.flush(); assert.deepEqual(win.getBounds(), before);
  f.runtime.dispose();
  assert.equal(f.handlers.size, 0);
  assert.equal(f.ipc.listenerCount("session-result:height"), 0);
  assert.equal(win.isDestroyed(), true);
});
test("destroying the presenting window invalidates its open operation", async t => {
  const f = fixture(t);
  const card = f.complete(); await f.flush();
  let finish;
  f.setOpen(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.request("open", card);
  f.runtime.getWindow().destroy();
  finish("opened"); await pending;
  assert.equal(f.store.list().length, 1);
});
test("layout stays inside negative-coordinate monitors and never overlaps blockers", () => {
  const workArea = { x: -1400, y: -900, width: 1400, height: 900 };
  for (const scale of [.8, 1, 1.25, 1.6]) {
    for (const fixedCorner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
      const a = computeSessionResultBounds({ workArea, scale, fixedCorner, desiredHeight: 480 });
      assert.ok(a && a.x >= workArea.x && a.y >= workArea.y);
      const b = computeSessionResultBounds({ workArea, scale, fixedCorner, avoidRects: [a] });
      if (b) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x
        || a.y + a.height <= b.y || b.y + b.height <= a.y);
    }
  }
  assert.equal(computeSessionResultBounds({ workArea, avoidRects: [workArea] }), null);
  const compact = computeSessionResultBounds({ workArea: { x: 0, y: 0, width: 500, height: 300 } });
  assert.equal(compact.height, 200);
});
test("all seven languages contain every card string", () => {
  assert.equal(Object.keys(dictionaries).length, 7);
  for (const dictionary of Object.values(dictionaries)) {
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(dictionaries.en).sort());
    assert.ok(Object.values(dictionary).every(value => typeof value === "string" && value.length));
  }
});
