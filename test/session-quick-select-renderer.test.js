"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { i18n, SUPPORTED_LANGS } = require("../src/i18n");

const flush = () => new Promise((resolve) => setImmediate(resolve));
const entry = (id, extra = {}) => ({ id, title: `Title ${id}`, agentName: "Codex", badge: "idle", canFocus: true, ...extra });

async function renderer(options = {}) {
  const listeners = new Map();
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const timers = new Map();
  const activations = [];
  let dismissCount = 0;
  let clock = 0;
  let timerId = 0;
  let revision = 1;
  let currentEntries = options.entries || [entry("a")];
  let nextIntent = true;
  let consumeCount = 0;
  class Element {
    constructor() { this.children = []; this.listeners = new Map(); this.attributes = {}; this.hidden = false; this.textContent = ""; }
    setAttribute(name, value) { this.attributes[name] = value; }
    appendChild(value) { this.children.push(value); }
    replaceChildren(value) { this.children = value ? value.children : []; }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    focus() { document.activeElement = this; }
  }
  const document = {
    title: "", documentElement: {}, activeElement: null,
    createElement: () => new Element(), createDocumentFragment: () => new Element(),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    addEventListener: (name, fn) => documentListeners.set(name, fn),
  };
  const api = {
    consumeIntent: async () => {
      consumeCount += 1;
      if (options.consumeIntent) return options.consumeIntent(consumeCount);
      const response = { status: "ok", revision, enterQuickSelect: nextIntent, entries: currentEntries, i18n: { lang: "en", translations: i18n.en } };
      nextIntent = false;
      return response;
    },
    activateSession: async (payload) => {
      activations.push(payload);
      return options.activation ? options.activation(payload) : { status: "submitted" };
    },
    dismiss: async () => { dismissCount += 1; },
    ...Object.fromEntries(["Intent", "Snapshot", "LangChange", "Dismissed"].map((name) => [`on${name}`, (fn) => listeners.set(name, fn)])),
  };
  const sandbox = {
    document,
    window: { quickSelectAPI: api, addEventListener: (name, fn) => windowListeners.set(name, fn) },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { at: clock + delay, fn }); return id; },
    clearTimeout: (id) => timers.delete(id),
    console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/session-quick-select-renderer.js"), "utf8"), sandbox);
  await flush();
  return {
    elements, document, activations, listeners,
    dismissCount: () => dismissCount,
    consumeCount: () => consumeCount,
    async key(type, key, extras = {}) {
      const event = { key, code: /^[1-9]$/.test(key) ? `Digit${key}` : key, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extras };
      documentListeners.get(type)(event);
      await flush();
      return event;
    },
    async advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
      await flush();
    },
    async enter(entries = currentEntries) {
      currentEntries = entries;
      revision += 1;
      nextIntent = true;
      listeners.get("Intent")();
      await flush();
    },
    snapshot(entries, payloadRevision = revision) { listeners.get("Snapshot")({ revision: payloadRevision, entries }); },
    blur() { windowListeners.get("blur")(); },
  };
}

test("renders a minimal palette and waits for physical release plus quiet time before dispatch", async () => {
  const h = await renderer();
  assert.equal(h.document.activeElement, h.elements.get("palette"));
  assert.equal(h.elements.get("options").children.length, 1);
  assert.equal((await h.key("keydown", "1")).prevented, true);
  await h.advance(300);
  assert.equal(h.activations.length, 0);
  await h.key("keyup", "1");
  await h.advance(119);
  assert.equal(h.activations.length, 0);
  await h.advance(1);
  assert.equal(h.activations.length, 1);
  assert.equal(h.activations[0].sessionId, "a");
  assert.equal(h.dismissCount(), 0, "submitted never asks the owner to hide before target focus");
  assert.equal(h.elements.get("feedback").textContent, i18n.en.dashboardQuickSelectSubmitted);
});

test("rapid repeats extend quiet time and cannot send the second digit into the target", async () => {
  const h = await renderer();
  await h.key("keydown", "1");
  await h.key("keyup", "1");
  await h.advance(60);
  await h.key("keydown", "1");
  await h.key("keydown", "1", { repeat: true });
  await h.advance(300);
  assert.equal(h.activations.length, 0);
  await h.key("keyup", "1");
  await h.advance(119);
  assert.equal(h.activations.length, 0);
  await h.advance(1);
  assert.equal(h.activations.length, 1);
});

test("Shift can change keyup text and main-row / numpad releases remain separate", async () => {
  const h = await renderer();
  await h.key("keydown", "1", { code: "Digit1" });
  await h.key("keydown", "1", { code: "Numpad1" });
  await h.key("keyup", "!", { code: "Digit1", shiftKey: true });
  await h.advance(300);
  assert.equal(h.activations.length, 0);
  await h.key("keyup", "1", { code: "Numpad1" });
  await h.advance(120);
  assert.equal(h.activations.length, 1);
});

test("Esc, Tab and Shift+Tab cancel pending handoff without relying on blur", async () => {
  for (const [key, extras] of [["Escape", {}], ["Tab", {}], ["Tab", { shiftKey: true }]]) {
    const h = await renderer();
    await h.key("keydown", "1");
    await h.key("keyup", "1");
    await h.advance(40);
    assert.equal((await h.key("keydown", key, extras)).prevented, true);
    await h.advance(300);
    assert.equal(h.activations.length, 0);
    assert.equal(h.dismissCount(), 1);
  }
});

test("new entry and native blur invalidate a pending digit, and stale updates cannot replace the new mapping", async () => {
  const h = await renderer();
  await h.key("keydown", "1");
  await h.key("keyup", "1");
  await h.enter([entry("b")]);
  h.snapshot([entry("old")], 1);
  await h.advance(300);
  assert.equal(h.activations.length, 0);
  await h.key("keydown", "1");
  await h.key("keyup", "1");
  h.blur();
  await h.advance(300);
  assert.equal(h.activations.length, 0);
  await h.enter([entry("b")]);
  await h.key("keydown", "1");
  await h.key("keyup", "1");
  await h.advance(120);
  assert.equal(h.activations[0].sessionId, "b");
});

test("target becoming unavailable during quiet time prevents dispatch and preserves its digit", async () => {
  const h = await renderer({ entries: [entry("a"), entry("b")] });
  await h.key("keydown", "1");
  await h.key("keyup", "1");
  h.snapshot([entry("a", { canFocus: false }), entry("b")]);
  await h.advance(120);
  assert.equal(h.activations.length, 0);
  assert.equal(h.elements.get("feedback").textContent, i18n.en.dashboardQuickSelectUnavailable);
  assert.equal(h.elements.get("options").children[0].attributes["aria-disabled"], "true");
  await h.key("keydown", "2");
  await h.key("keyup", "2");
  await h.advance(120);
  assert.equal(h.activations[0].sessionId, "b");
});

test("empty state owns no numeric mode, supports cancellation, and a later explicit entry can select", async () => {
  const h = await renderer({ entries: [] });
  assert.equal(h.elements.get("empty").hidden, false);
  assert.equal(h.document.activeElement, h.elements.get("close"));
  assert.equal((await h.key("keydown", "1")).prevented, false);
  await h.advance(200);
  assert.equal(h.activations.length, 0);
  await h.key("keydown", "Tab", { shiftKey: true });
  assert.equal(h.dismissCount(), 1);
  await h.enter([entry("new")]);
  assert.equal(h.elements.get("empty").hidden, true);
  await h.key("keydown", "1");
  await h.key("keyup", "1");
  await h.advance(120);
  assert.equal(h.activations[0].sessionId, "new");
});

test("modified digits, IME composition, arrows and Enter do not activate", async () => {
  const h = await renderer();
  for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey", "isComposing"]) {
    assert.equal((await h.key("keydown", "1", { [modifier]: true })).prevented, false);
  }
  for (const key of ["ArrowDown", "ArrowUp", "Enter"]) await h.key("keydown", key);
  await h.advance(300);
  assert.equal(h.activations.length, 0);
  assert.equal((await h.key("keydown", "Escape", { isComposing: true })).prevented, false);
  assert.equal(h.dismissCount(), 0);
});

test("rejected and duplicate requests keep feedback visible and do not dismiss", async () => {
  for (const reason of ["focus-unavailable", "dropped-duplicate"]) {
    const h = await renderer({ activation: () => ({ status: "rejected", reason }) });
    await h.key("keydown", "1");
    await h.key("keyup", "1");
    await h.advance(120);
    assert.equal(h.dismissCount(), 0);
    assert.equal(h.elements.get("feedback").textContent, reason === "dropped-duplicate"
      ? i18n.en.dashboardQuickSelectAlreadyRequested : i18n.en.dashboardQuickSelectUnavailable);
  }
});

test("intent arriving during the first consume is drained and cannot lose the latest shortcut", async () => {
  let resolveFirst;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const h = await renderer({ consumeIntent: (call) => call === 1 ? first : {
    status: "ok", revision: 2, enterQuickSelect: true, entries: [entry("new")], i18n: { translations: i18n.en },
  } });
  h.listeners.get("Intent")();
  resolveFirst({ status: "ok", revision: 1, enterQuickSelect: false, entries: [], i18n: { translations: i18n.en } });
  await flush();
  assert.equal(h.consumeCount(), 2);
  await h.key("keydown", "1");
  await h.key("keyup", "1");
  await h.advance(120);
  assert.equal(h.activations[0].sessionId, "new");
});

test("all supported locales contain quick-select feedback and close instructions", () => {
  for (const lang of SUPPORTED_LANGS) {
    for (const key of ["Title", "Hint", "Empty", "Unavailable", "AlreadyRequested", "Submitted", "Close"]) {
      assert.ok(i18n[lang][`dashboardQuickSelect${key}`], `${lang} ${key}`);
    }
  }
});

test("preload exposes only the quick-select contract and never Dashboard management or completion acknowledgement", () => {
  const events = new Map();
  const invoked = [];
  let exposed;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/preload-session-quick-select.js"), "utf8"), {
    require: (name) => {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, "quickSelectAPI"); exposed = api; } },
        ipcRenderer: {
          invoke: (...args) => invoked.push(args),
          on: (name, fn) => events.set(name, fn),
          removeListener: (name) => events.delete(name),
        },
      };
    },
  });
  assert.deepEqual(Object.keys(exposed).sort(), ["activateSession", "consumeIntent", "dismiss", "onDismissed", "onIntent", "onLangChange", "onSnapshot"].sort());
  let calls = 0;
  const unsubscribe = exposed.onSnapshot(() => { calls += 1; });
  events.get("quick-select:snapshot")({}, { entries: [] });
  unsubscribe();
  assert.equal(calls, 1);
  assert.equal(events.size, 0);
  exposed.activateSession({ sessionId: "a" });
  assert.equal(invoked[0][0], "quick-select:activate-session");
});
