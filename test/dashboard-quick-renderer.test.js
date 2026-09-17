"use strict";

// Renderer-side contract for the Dashboard keyboard mode. The page is the real
// Dashboard, so these tests pin the parts that must not regress: the busy gate
// refuses a round without touching the draft, digits own IDs for the round,
// badges survive the one-second rebuild, and no numeric path acks a completion.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { i18n } = require("../src/i18n");
const { createDashboardQuickMode } = require("../src/dashboard-quick-mode");
const createOriginFocus = require("../src/quick-select-origin-focus");

const RENDERER_SOURCE = fs.readFileSync(
  path.join(__dirname, "../src/dashboard-renderer.js"),
  "utf8"
);

const flush = () => new Promise((resolve) => setImmediate(resolve));
// Let a few microtask/macrotask turns run without resolving a gated promise.
const flushTicks = async () => { for (let i = 0; i < 4; i += 1) await flush(); };

// Payloads cross the vm realm boundary, so their prototypes differ from this
// realm's Object. Re-hydrate before any deepStrictEqual.
const plain = (value) => JSON.parse(JSON.stringify(value ?? null));

function session(id, extra = {}) {
  return {
    id,
    displayTitle: `Title ${id}`,
    agentId: "codex",
    agentName: "Codex",
    badge: "idle",
    canFocus: true,
    updatedAt: Date.now(),
    cwd: `/tmp/${id}`,
    ...extra,
  };
}

class ClassList {
  constructor(el) { this.el = el; this.items = new Set(); }
  add(...names) { for (const n of names) this.items.add(n); this.sync(); }
  remove(...names) { for (const n of names) this.items.delete(n); this.sync(); }
  toggle(name, force) {
    const on = force === undefined ? !this.items.has(name) : !!force;
    if (on) this.items.add(name); else this.items.delete(name);
    this.sync();
  }
  contains(name) { return this.items.has(name); }
  sync() { this.el._className = [...this.items].join(" "); }
}

class Element {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.hidden = false;
    this.textContent = "";
    this.isContentEditable = false;
    this.style = {};
    this._className = "";
    this.classList = new ClassList(this);
  }
  get className() { return this._className; }
  set className(value) {
    this._className = value;
    this.classList.items = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(child) { this.children = child ? [...child.children] : []; }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name) { this.listeners.delete(name); }
  contains() { return true; }
  focus() {}
  select() {}
  // Depth-first walk used by the assertions below.
  descendants() {
    const out = [];
    for (const child of this.children) {
      out.push(child);
      if (child && typeof child.descendants === "function") out.push(...child.descendants());
    }
    return out;
  }
}

function collectBadges(contentEl) {
  return contentEl
    .descendants()
    .filter((el) => el && el.classList && el.classList.contains("quick-digit-badge"))
    .map((el) => el.textContent);
}

// Card titles in document order across the whole content tree.
function cardTitles(contentEl) {
  return contentEl
    .descendants()
    .filter((el) => el && el.classList && el.classList.contains("session-title"))
    .map((el) => el.textContent);
}

// Group headings in document order.
function groupTitles(contentEl) {
  return contentEl
    .descendants()
    .filter((el) => el && el.tagName === "H2")
    .map((el) => el.textContent);
}

async function renderer(options = {}) {
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const timers = new Map();
  const quickListeners = new Map();
  const calls = { activate: [], enter: [], ready: [], dismiss: [], ack: [], alias: [] };
  let timerId = 0;
  let intervalFn = null;

  const document = {
    title: "",
    documentElement: {},
    activeElement: null,
    createElement: (tag) => {
      const element = new Element(tag);
      if (options.modelFocus) {
        element.focus = () => { document.activeElement = element; };
        element.select = () => { element.selectionStart = 0; element.selectionEnd = element.value?.length || 0; };
      }
      return element;
    },
    createDocumentFragment: () => new Element("fragment"),
    createTextNode: (text) => ({ textContent: text }),
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    addEventListener: (name, fn) => documentListeners.set(name, fn),
    contains: () => true,
  };

  const api = {
    getSnapshot: async () => options.snapshot || { sessions: [], groups: [] },
    getI18n: async () => ({ lang: "en", translations: i18n.en }),
    getKimiQuotaStatus: async () => null,
    refreshKimiQuota: async () => ({ status: "ok" }),
    focusSession: () => { throw new Error("focusSession must not be used by the numeric path"); },
    hideSession: async () => ({ status: "ok" }),
    openSessionFolder: async () => ({ status: "ok" }),
    setSessionAlias: async (payload) => { calls.alias.push(plain(payload)); return { status: "ok" }; },
    setSessionAutomationOverride: async () => ({ status: "applied" }),
    clearSessionAutomationGrant: async () => ({ status: "applied" }),
    ackCompletion: async (id) => { calls.ack.push(plain(id)); return { status: "ok" }; },
    onSessionSnapshot: (fn) => quickListeners.set("snapshot", fn),
    onLangChange: (fn) => quickListeners.set("lang", fn),
    quickPending: async () => options.pending || { status: "ok", revision: 0 },
    quickEnter: async (payload) => {
      calls.enter.push(plain(payload));
      if (options.enter) return options.enter(payload);
      if (payload.busy) return { status: "busy", revision: payload.revision };
      const entries = (options.entries || []).map((entry) => ({ ...entry }));
      if (!entries.length) return { status: "empty", revision: payload.revision };
      return { status: "ok", revision: payload.revision, entries };
    },
    quickReady: async (payload) => {
      calls.ready.push(plain(payload));
      return options.ready ? options.ready(payload) : { status: "ok" };
    },
    quickActivate: async (payload) => {
      calls.activate.push(plain(payload));
      return options.activate ? options.activate(payload) : { status: "submitted" };
    },
    quickDismiss: async (payload) => {
      calls.dismiss.push(plain(payload));
      return options.dismiss ? options.dismiss(payload) : { status: "ok" };
    },
    onQuickIntent: (fn) => quickListeners.set("intent", fn),
    onQuickEntries: (fn) => quickListeners.set("entries", fn),
    onQuickDismissed: (fn) => quickListeners.set("dismissed", fn),
  };

  const sandbox = {
    document,
    window: {
      dashboardAPI: api,
      addEventListener: (name, fn) => windowListeners.set(name, fn),
    },
    globalThis: {
      ClawdSessionFocusUnavailable: {
        canOfferLocalFolder: () => false,
        focusUnavailableReasonKey: () => "sessionFocusUnavailableRemote",
      },
    },
    setTimeout: (fn, delay) => {
      const id = ++timerId;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn) => { intervalFn = fn; return 1; },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    Intl,
    Date,
    console,
  };
  sandbox.window.dashboardAPI = api;
  sandbox.globalThis.window = sandbox.window;
  sandbox.globalThis.document = document;

  const context = vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "language-picker.js"), "utf8"),
    context
  );
  vm.runInContext(RENDERER_SOURCE, context);
  await flush();
  await flush();

  return {
    document,
    elements,
    calls,
    timers,
    inspect: () => plain(vm.runInContext("({ activeEdit, composing, quick: { active: quick.active, capture: quick.capture, canDismissBorrow: quick.canDismissBorrow, revision: quick.revision } })", context)),
    receive: (channel, payload) => {
      const names = { "dashboard:quick-intent": "intent", "dashboard:quick-dismissed": "dismissed", "dashboard:quick-entries": "entries" };
      quickListeners.get(names[channel])?.(payload);
    },
    // A view transfer blurs the real renderer-created input in this model.
    // This invokes its production blur/alias handler, not a fake alias write.
    blurEditable: () => {
      const active = document.activeElement;
      windowListeners.get("blur")?.();
      document.activeElement = null;
      active?.listeners.get("blur")?.();
    },
    content: () => document.getElementById("content"),
    banner: () => document.getElementById("quickBanner"),
    tick: () => { if (intervalFn) intervalFn(); },
    snapshot: async (value) => {
      quickListeners.get("snapshot")(value);
      await flush();
    },
    intent: async (revision) => {
      await quickListeners.get("intent")({ revision });
      await flush();
      await flush();
    },
    entries: async (payload) => {
      quickListeners.get("entries")(payload);
      await flush();
    },
    dismissed: async (payload) => {
      quickListeners.get("dismissed")(payload);
      await flush();
    },
    blur: async () => {
      const fn = windowListeners.get("blur");
      if (fn) fn();
      await flush();
    },
    // Dispatch a non-key document event (focusin / input / composition*).
    fire: async (type, event = {}) => {
      const fn = documentListeners.get(type);
      if (fn) fn(event);
      await flush();
    },
    key: async (type, key, extra = {}) => {
      const event = {
        key,
        code: /^[1-9]$/.test(key) ? `Digit${key}` : key,
        target: document.activeElement,
        prevented: false,
        propagationStopped: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...extra,
      };
      const fn = documentListeners.get(type);
      if (fn) fn(event);
      await flush();
      return event;
    },
    runTimers: async () => {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, timer] of pending) timer.fn();
      await flush();
      await flush();
    },
  };
}

const twoSessions = {
  sessions: [session("s1"), session("s2")],
  groups: [{ host: "local", ids: ["s1", "s2"] }],
};
const twoEntries = [
  { id: "s1", title: "Title s1", agentName: "Codex", badge: "idle", canFocus: true },
  { id: "s2", title: "Title s2", agentName: "Codex", badge: "idle", canFocus: true },
];

// F3 is a boundary between the real main-mode owner and the real renderer's
// title editor. A standalone busy:true reply cannot exercise it. The only
// simulated browser behaviour here is that moving the view blurs its input;
// the alias commit itself runs the production renderer handler. Not GUI proof.
async function borrowedEditor(options = {}) {
  let page = null;
  let foreground = "source-A";
  let hosted = null;
  let heldEnter = null;
  let heldBusyReady = null;
  const windows = [];
  const moves = [];
  const jumps = [];
  class Window {
    constructor(name) {
      this.name = typeof name === "string" ? name : "quick";
      this.visible = this.name === "normal";
      this.focused = false;
      this.destroyed = false;
      this.opacity = 1;
      this.events = new Map();
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    isMinimized() { return false; }
    getOpacity() { return this.opacity; }
    setOpacity(value) { this.opacity = value; moves.push("opacity:" + value); }
    setIgnoreMouseEvents(value) { moves.push("ignore:" + value); }
    setBounds() { moves.push("bounds"); }
    setMenuBarVisibility() {}
    on(event, fn) { this.events.set(event, fn); }
    emit(event) { this.events.get(event)?.(); }
    show() { this.visible = true; moves.push("show:" + this.name); }
    hide() { this.visible = false; moves.push("hide:" + this.name); }
    focus() {
      for (const win of windows) win.focused = win === this;
      foreground = this.name;
      moves.push("focus:" + this.name);
    }
    destroy() { this.destroyed = true; this.visible = false; }
  }
  const normal = new Window("normal");
  hosted = normal;
  const originFocus = createOriginFocus({ platform: "win32", bindings: {
    foreground: () => foreground, hwndOf: win => win.name,
    same: (a, b) => a === b, pid: () => 17, visible: () => true, minimized: () => false,
    setForeground: name => { foreground = name; return true; },
  } });
  const mode = createDashboardQuickMode({
    platform: options.platform || "win32", electron: { BaseWindow: Window }, originFocus,
    getNormalWindow: () => normal, ensurePage: () => ({}),
    getWebContents: () => ({ isDestroyed: () => false, send: (channel, payload) => {
      queueMicrotask(() => page.receive(channel, plain(payload)));
    } }),
    getSessionSnapshot: () => twoSessions,
    getQuickHostBounds: () => ({ x: 0, y: 0, width: 480, height: 600 }),
    attachViewTo: win => {
      moves.push("attach:" + win.name);
      if (hosted !== win) page?.blurEditable();
      hosted = win;
      return true;
    },
    focusSession: id => { jumps.push(id); return { reason: "submitted" }; },
  });
  page = await renderer({
    modelFocus: true, snapshot: twoSessions,
    enter: payload => {
      const result = mode.enter(payload);
      if (!heldEnter) return result;
      const gate = heldEnter;
      heldEnter = null;
      return gate.then(() => result);
    },
    ready: payload => {
      const result = mode.ready(payload);
      if (!payload.busy || !heldBusyReady) return result;
      const gate = heldBusyReady;
      heldBusyReady = null;
      return gate.then(() => result);
    },
    activate: payload => mode.activate(payload),
    dismiss: payload => mode.dismissFromRenderer(payload),
  });
  return {
    page, mode, moves, jumps, normal,
    foreground: () => foreground,
    hosted: () => hosted,
    start: () => mode.show(),
    async shortcut() { const result = mode.show(); await flushTicks(); return result; },
    holdNextEnter() {
      let release;
      heldEnter = new Promise(resolve => { release = resolve; });
      return release;
    },
    holdNextBusyReady() {
      let release;
      heldBusyReady = new Promise(resolve => { release = resolve; });
      return release;
    },
    async edit(ime = false) {
      const title = page.content().descendants().find(el => el.classList?.contains("session-title"));
      title.listeners.get("dblclick")({ stopPropagation() {} });
      const input = page.document.activeElement;
      assert.equal(input.tagName, "INPUT");
      input.value = ime ? "ni" : "uncommitted draft";
      input.selectionStart = input.selectionEnd = 2;
      input.listeners.get("input")();
      if (ime) await page.fire("compositionstart");
      return input;
    },
    async cancelEdit(input) {
      await page.fire("compositionend");
      input.listeners.get("keydown")({ key: "Escape", preventDefault() {} });
      page.document.activeElement = null;
      await flushTicks();
    },
    async externalBlur() {
      foreground = "source-B";
      mode.getQuickWindow().focused = false;
      mode.getQuickWindow().emit("blur");
      await flushTicks();
    },
  };
}

for (const platform of ["win32", "darwin"]) {
  for (const ime of [false, true]) {
    test(`F3 ${platform}: a borrowed ${ime ? "IME composition" : "alias draft"} survives a busy re-entry`, async () => {
      const h = await borrowedEditor({ platform });
      const first = await h.shortcut();
      const input = await h.edit(ime);
      const beforeMoves = h.moves.length;
      const before = h.page.inspect();
      await h.shortcut();

      assert.deepEqual(h.page.calls.alias, [], "busy must not submit a draft before refusing");
      assert.equal(h.moves.length, beforeMoves, "no detach, hide, focus, scale or parking while busy");
      assert.equal(h.page.document.activeElement, input, "the same input keeps keyboard focus");
      assert.equal(h.page.inspect().activeEdit.draft, before.activeEdit.draft);
      assert.equal(h.page.inspect().composing, ime);
      assert.equal(input.selectionStart, 2);
      assert.equal(input.selectionEnd, 2);
      assert.equal(h.mode.isShown(), true, "the borrowed editor stays where it was");
      assert.equal(h.mode.isReady(), false);
      assert.equal(h.mode.capturesDigits(), false);
      assert.equal(h.page.inspect().quick.capture, false);
      assert.equal(h.page.content().classList.contains("is-quick-capture"), false, "old badge paint is disabled without rebuilding input");
      assert.equal(h.mode.activate({ sessionId: "s1", revision: first.revision }).reason, "stale-revision");
    });
  }
}

test("F3: editing that begins during a borrowed enter reply survives busy-at-ready", async () => {
  const h = await borrowedEditor();
  await h.shortcut();
  const release = h.holdNextEnter();
  const beforeMoves = h.moves.length;
  h.start();
  await flushTicks();
  const input = await h.edit(true);
  release();
  await flushTicks();
  assert.deepEqual(h.page.calls.alias, []);
  assert.equal(h.moves.length, beforeMoves);
  assert.equal(h.page.document.activeElement, input);
  assert.equal(h.page.inspect().composing, true);
  assert.equal(h.mode.isShown(), true);
  assert.equal(h.mode.isReady(), false);
  assert.equal(h.mode.capturesDigits(), false);
  assert.equal(h.page.calls.ready.at(-1).busy, true);
});

test("F3: a refused borrowed round never auto-arms but Esc works after editing", async () => {
  const h = await borrowedEditor();
  await h.shortcut();
  const input = await h.edit();
  const refused = await h.shortcut();
  await h.cancelEdit(input);
  const digit = await h.page.key("keydown", "1");
  await h.page.key("keyup", "1");
  await h.page.runTimers();
  assert.equal(digit.prevented, false);
  assert.deepEqual(h.jumps, []);
  assert.equal(h.mode.ready({ revision: refused.revision, busy: false }).status, "stale");
  await h.page.key("keydown", "Escape");
  assert.equal(h.mode.isShown(), false);
  assert.equal(h.foreground(), "source-A");
  assert.deepEqual(h.page.calls.alias, []);
});

test("F3: repeated busy offers keep the input and require a fresh shortcut after editing", async () => {
  const h = await borrowedEditor();
  await h.shortcut();
  const input = await h.edit(true);
  const beforeMoves = h.moves.length;
  const refused = await h.shortcut();
  const latest = await h.shortcut();
  assert.deepEqual(h.page.calls.alias, []);
  assert.equal(h.moves.length, beforeMoves);
  assert.equal(h.mode.dismissFromRenderer({ revision: refused.revision }).status, "stale");
  await h.cancelEdit(input);
  await h.shortcut();
  assert.equal(h.mode.isReady(), true);
  assert.equal(h.mode.capturesDigits(), true);
  assert.equal(h.page.content().classList.contains("is-quick-capture"), true);
  assert.equal(h.mode.dismissFromRenderer({ revision: latest.revision }).status, "stale");
  await h.page.key("keydown", "Escape");
  assert.equal(h.foreground(), "source-A");
});

test("F3: the main fence rejects the old digit before the renderer sees a new intent", async () => {
  const h = await borrowedEditor();
  const first = await h.shortcut();
  await h.page.key("keydown", "1");
  await h.page.key("keyup", "1");
  h.start(); // deliberately do not deliver the queued intent yet
  assert.equal(h.mode.activate({ sessionId: "s1", revision: first.revision }).reason, "stale-revision");
  await flushTicks();
  await h.page.runTimers();
  assert.deepEqual(h.jumps, []);
});

test("F3: an external blur after busy ends the retained page and stale Esc cannot reclaim it", async () => {
  const h = await borrowedEditor();
  await h.shortcut();
  await h.edit();
  const refused = await h.shortcut();
  assert.deepEqual(h.page.calls.alias, []);
  await h.externalBlur();
  assert.equal(h.mode.isShown(), false);
  assert.equal(h.foreground(), "source-B");
  assert.equal(h.mode.dismissFromRenderer({ revision: refused.revision }).status, "stale");
  assert.equal(h.page.inspect().quick.canDismissBorrow, false);
});

test("F3: a delayed busy reply cannot revive a borrow ended by an external blur", async () => {
  const h = await borrowedEditor();
  await h.shortcut();
  await h.edit();
  const release = h.holdNextEnter();
  h.start();
  await flushTicks();
  assert.deepEqual(h.page.calls.alias, []);
  await h.externalBlur();
  release();
  await flushTicks();
  assert.equal(h.page.inspect().quick.canDismissBorrow, false);
  assert.equal(h.page.inspect().quick.active, false);
  assert.equal(h.mode.isShown(), false);
  assert.equal(h.foreground(), "source-B");
});

test("F3: a late busy-at-ready response cannot cancel a newer accepted round", async () => {
  const h = await borrowedEditor();
  await h.shortcut();
  const releaseEnter = h.holdNextEnter();
  const releaseBusyReady = h.holdNextBusyReady();
  h.start();
  await flushTicks();
  const input = await h.edit();
  releaseEnter();
  await flushTicks();
  assert.equal(h.page.calls.ready.at(-1).busy, true);
  assert.equal(h.mode.isReady(), false);
  await h.cancelEdit(input);
  await h.shortcut();
  releaseBusyReady();
  await flushTicks();
  assert.equal(h.mode.isReady(), true);
  assert.equal(h.page.inspect().quick.capture, true);
  assert.equal(h.page.inspect().quick.canDismissBorrow, false);
  assert.deepEqual(h.page.calls.alias, []);
});

test("entering the mode paints digit badges into the existing card tree", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  assert.deepEqual(collectBadges(r.content()), []);

  await r.intent(1);

  assert.deepEqual(collectBadges(r.content()), ["1", "2"]);
  assert.deepEqual(r.calls.ready, [{ revision: 1, busy: false }]);
});

test("digit badges survive the one-second full rebuild", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);
  assert.deepEqual(collectBadges(r.content()), ["1", "2"]);

  // The renderer replaces the whole card tree every second; badges are built
  // by createCard from round state, so they must come back identical.
  r.tick();
  assert.deepEqual(collectBadges(r.content()), ["1", "2"]);
});

test("busy renderer refuses the round without arming or committing", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  const input = new Element("input");
  r.document.activeElement = input;

  await r.intent(1);

  assert.deepEqual(r.calls.enter, [{ revision: 1, busy: true }]);
  assert.deepEqual(r.calls.ready, []);
  assert.deepEqual(collectBadges(r.content()), [], "no digits while busy");

  // A digit typed into the focused input must reach the input untouched.
  const event = await r.key("keydown", "1");
  assert.equal(event.prevented, false);
  assert.deepEqual(r.calls.activate, []);
});

test("keys are never swallowed when the mode is not active", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  const event = await r.key("keydown", "1");
  assert.equal(event.prevented, false);
  assert.deepEqual(r.calls.activate, []);
});

test("activation waits for every digit key to be released, then submits once", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);

  await r.key("keydown", "2");
  await r.runTimers();
  assert.deepEqual(r.calls.activate, [], "no handoff while the key is held");

  await r.key("keyup", "2");
  await r.runTimers();
  assert.deepEqual(r.calls.activate, [{ sessionId: "s2", revision: 1 }]);
  assert.deepEqual(r.calls.ack, [], "the numeric path never acks a completion");
});

test("auto-repeat and extra digits cannot re-target the pending jump", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);

  await r.key("keydown", "1");
  await r.key("keydown", "1", { repeat: true });
  await r.key("keydown", "2");
  await r.key("keyup", "1");
  await r.key("keyup", "2");
  await r.runTimers();

  assert.deepEqual(r.calls.activate, [{ sessionId: "s1", revision: 1 }]);
});

test("numpad digits are tracked as their own physical keys", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);

  await r.key("keydown", "1", { code: "Numpad1" });
  await r.key("keyup", "1", { code: "Digit1" });
  await r.runTimers();
  assert.deepEqual(r.calls.activate, [], "releasing a different physical key is not a release");

  await r.key("keyup", "1", { code: "Numpad1" });
  await r.runTimers();
  assert.deepEqual(r.calls.activate, [{ sessionId: "s1", revision: 1 }]);
});

test("modified digits are ignored and left to the page", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);
  const event = await r.key("keydown", "1", { metaKey: true });
  assert.equal(event.prevented, false);
  await r.runTimers();
  assert.deepEqual(r.calls.activate, []);
});

test("composition keys never reach the numeric path", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);
  const event = await r.key("keydown", "1", { isComposing: true });
  assert.equal(event.prevented, false);
  await r.runTimers();
  assert.deepEqual(r.calls.activate, []);
});

test("Escape cancels the round and a late timer cannot still fire", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);

  await r.key("keydown", "1");
  await r.key("keyup", "1");
  const escape = await r.key("keydown", "Escape");
  assert.equal(escape.prevented, true);
  assert.deepEqual(r.calls.dismiss, [{ revision: 1 }]);

  await r.runTimers();
  assert.deepEqual(r.calls.activate, [], "the queued handoff was cancelled");
  assert.deepEqual(collectBadges(r.content()), []);
});

test("window blur cancels an unsubmitted jump", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);
  await r.key("keydown", "1");
  await r.key("keyup", "1");
  await r.blur();
  await r.runTimers();
  assert.deepEqual(r.calls.activate, []);
});

test("a vanished numbered session holds its slot and never renumbers", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);
  assert.deepEqual(collectBadges(r.content()), ["1", "2"]);

  // s1 disappears and a brand new session shows up. Digit 1 must stay spent
  // AND stay in slot 1 — the rows below must not shift up.
  await r.entries({
    revision: 1,
    entries: [
      { ...twoEntries[0], canFocus: false },
      twoEntries[1],
    ],
  });
  await r.snapshot({
    sessions: [session("s2"), session("s9")],
    groups: [{ host: "local", ids: ["s2", "s9"] }],
  });

  assert.deepEqual(
    collectBadges(r.content()),
    ["1", "2"],
    "frozen slot order survives the session disappearing"
  );

  await r.key("keydown", "1");
  await r.key("keyup", "1");
  await r.runTimers();
  assert.deepEqual(r.calls.activate, [], "a tombstoned digit cannot be activated");
});

test("a snapshot that reorders sessions does not move any digit", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);
  assert.deepEqual(collectBadges(r.content()), ["1", "2"]);

  // The shared snapshot now lists s2 first. Slots are frozen, so the digits
  // must stay exactly where the round put them.
  await r.snapshot({
    sessions: [session("s2"), session("s1")],
    groups: [{ host: "local", ids: ["s2", "s1"] }],
  });

  assert.deepEqual(collectBadges(r.content()), ["1", "2"]);
  assert.deepEqual(cardTitles(r.content()), ["Title s1", "Title s2"], "slot 1 is still s1");
});

test("every numbered session disappearing still leaves this round's slots", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);

  await r.snapshot({ sessions: [], groups: [] });

  assert.deepEqual(
    collectBadges(r.content()),
    ["1", "2"],
    "tombstones survive an entirely empty snapshot"
  );
});

test("numbered sessions are not duplicated in the ordinary groups", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);

  const titles = r.content()
    .descendants()
    .filter((el) => el && el.classList && el.classList.contains("session-title"))
    .map((el) => el.textContent);
  assert.deepEqual(titles, ["Title s1", "Title s2"]);
});

// local + remote, with a non-focusable session sitting between two numbered
// ones so the frozen positions have to survive a gap.
const mixedSessions = {
  sessions: [
    session("l1"),
    session("l2", { canFocus: false }),
    session("l3"),
    session("r1"),
    session("r2"),
  ],
  groups: [
    { host: "local", ids: ["l1", "l2", "l3"] },
    { host: "build-box", displayHost: "build-box", ids: ["r1", "r2"] },
  ],
};
const mixedEntries = ["l1", "l3", "r1", "r2"].map((id) => ({
  id,
  title: `Title ${id}`,
  agentName: "Codex",
  badge: "idle",
  canFocus: true,
}));

test("entering the mode keeps the existing groups, order and unnumbered cards", async () => {
  const r = await renderer({ snapshot: mixedSessions, entries: mixedEntries });
  const groupsBefore = groupTitles(r.content());
  const titlesBefore = cardTitles(r.content());

  await r.intent(1);

  assert.deepEqual(groupTitles(r.content()), groupsBefore, "no new or reordered groups");
  assert.deepEqual(titlesBefore, cardTitles(r.content()), "no card moved");
  // The non-focusable l2 stays between l1 and l3 and gets no digit.
  assert.deepEqual(collectBadges(r.content()), ["1", "2", "3", "4"]);
  assert.deepEqual(cardTitles(r.content()), [
    "Title l1", "Title l2", "Title l3", "Title r1", "Title r2",
  ]);
});

test("a numbered session vanishing leaves a tombstone in its own group slot", async () => {
  const r = await renderer({ snapshot: mixedSessions, entries: mixedEntries });
  await r.intent(1);

  // l3 (digit 2) disappears from the local group.
  await r.snapshot({
    sessions: [session("l1"), session("l2", { canFocus: false }), session("r1"), session("r2")],
    groups: [
      { host: "local", ids: ["l1", "l2"] },
      { host: "build-box", displayHost: "build-box", ids: ["r1", "r2"] },
    ],
  });

  assert.deepEqual(groupTitles(r.content()), ["local", "build-box"]);
  assert.deepEqual(
    cardTitles(r.content()),
    ["Title l1", "Title l2", "Title l3", "Title r1", "Title r2"],
    "the tombstone holds l3's original position inside local"
  );
  assert.deepEqual(collectBadges(r.content()), ["1", "2", "3", "4"]);
});

test("a session joining mid-round is appended without moving frozen cards", async () => {
  const r = await renderer({ snapshot: mixedSessions, entries: mixedEntries });
  await r.intent(1);

  await r.snapshot({
    sessions: [...mixedSessions.sessions, session("l9")],
    groups: [
      // The shared snapshot puts the newcomer first; the round must not.
      { host: "local", ids: ["l9", "l1", "l2", "l3"] },
      { host: "build-box", displayHost: "build-box", ids: ["r1", "r2"] },
    ],
  });

  assert.deepEqual(
    cardTitles(r.content()),
    ["Title l1", "Title l2", "Title l3", "Title l9", "Title r1", "Title r2"],
    "l9 is appended after the frozen local cards"
  );
  assert.deepEqual(collectBadges(r.content()), ["1", "2", "3", "4"], "l9 gets no digit");
});

test("a whole new group is appended after the frozen ones", async () => {
  const r = await renderer({ snapshot: mixedSessions, entries: mixedEntries });
  await r.intent(1);

  await r.snapshot({
    sessions: [...mixedSessions.sessions, session("n1")],
    groups: [
      { host: "new-host", displayHost: "new-host", ids: ["n1"] },
      ...mixedSessions.groups,
    ],
  });

  assert.deepEqual(groupTitles(r.content()), ["local", "build-box", "new-host"]);
});

test("leaving the mode restores the snapshot's own ordering", async () => {
  const r = await renderer({ snapshot: mixedSessions, entries: mixedEntries });
  await r.intent(1);

  const reordered = {
    sessions: mixedSessions.sessions,
    groups: [
      { host: "build-box", displayHost: "build-box", ids: ["r2", "r1"] },
      { host: "local", ids: ["l3", "l2", "l1"] },
    ],
  };
  await r.snapshot(reordered);
  assert.deepEqual(groupTitles(r.content()), ["local", "build-box"], "frozen while active");

  await r.dismissed({ revision: 1 });

  assert.deepEqual(groupTitles(r.content()), ["build-box", "local"]);
  assert.deepEqual(cardTitles(r.content()), [
    "Title r2", "Title r1", "Title l3", "Title l2", "Title l1",
  ]);
  assert.deepEqual(collectBadges(r.content()), []);
});

test("numbered slot cards keep the full Dashboard controls", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);

  const buttons = r.content()
    .descendants()
    .filter((el) => el && el.tagName === "BUTTON");
  // Jump + hide per live card at minimum: the mode must not strip management.
  assert.ok(buttons.length >= 4, `expected management buttons, saw ${buttons.length}`);
});

test("a stale round cannot reopen and a stale dismissal cannot cancel a live one", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(2);
  assert.deepEqual(r.calls.enter, [{ revision: 2, busy: false }]);

  await r.intent(1);
  assert.deepEqual(r.calls.enter, [{ revision: 2, busy: false }], "older revision ignored");

  await r.dismissed({ revision: 1 });
  assert.deepEqual(collectBadges(r.content()), ["1", "2"], "round 2 is still live");

  await r.dismissed({ revision: 2 });
  assert.deepEqual(collectBadges(r.content()), []);
});

test("an empty candidate set opens the Dashboard, hints, and captures no digits", async () => {
  const r = await renderer({ snapshot: { sessions: [], groups: [] }, entries: [] });
  await r.intent(1);

  // The round is still opened (so the shortcut is never a silent no-op) and
  // main is told the page is ready, which is what shows the Dashboard.
  assert.deepEqual(r.calls.ready, [{ revision: 1, busy: false }]);
  assert.equal(r.banner().textContent, i18n.en.dashboardQuickSelectEmpty);
  assert.deepEqual(collectBadges(r.content()), []);

  const digit = await r.key("keydown", "1");
  assert.equal(digit.prevented, false, "digits belong to the page");
  await r.runTimers();
  assert.deepEqual(r.calls.activate, []);
});

test("an empty round is still bounded by Escape", async () => {
  const r = await renderer({ snapshot: { sessions: [], groups: [] }, entries: [] });
  await r.intent(1);

  const escape = await r.key("keydown", "Escape");
  assert.equal(escape.prevented, true);
  assert.deepEqual(r.calls.dismiss, [{ revision: 1 }]);
});

test("a rejected activation reports unavailable without acking", async () => {
  const r = await renderer({
    snapshot: twoSessions,
    entries: twoEntries,
    activate: () => ({ status: "rejected", reason: "focus-unavailable" }),
  });
  await r.intent(1);
  await r.key("keydown", "1");
  await r.key("keyup", "1");
  await r.runTimers();

  assert.equal(r.banner().textContent, i18n.en.dashboardQuickSelectUnavailable);
  assert.deepEqual(r.calls.ack, []);
});

test("a dismissal during the enter round-trip cannot be revived by the reply", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = await renderer({
    snapshot: twoSessions,
    entries: twoEntries,
    enter: async (payload) => {
      await gate;
      return { status: "ok", revision: payload.revision, entries: twoEntries };
    },
  });

  const started = r.intent(1);
  await flushTicks();
  // Main ended the round while `enter` was still in flight.
  await r.dismissed({ revision: 1 });
  release();
  await started;

  assert.deepEqual(collectBadges(r.content()), [], "the stale reply did not re-arm");
  assert.deepEqual(r.calls.ready, [], "and never asked main to show a quick host");
  const event = await r.key("keydown", "1");
  assert.equal(event.prevented, false);
});

test("editing that starts during the enter round-trip aborts before any transfer", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = await renderer({
    snapshot: twoSessions,
    entries: twoEntries,
    enter: async (payload) => {
      await gate;
      return { status: "ok", revision: payload.revision, entries: twoEntries };
    },
  });

  const started = r.intent(1);
  await flushTicks();
  // The user clicked into an alias input while we waited.
  r.document.activeElement = new Element("input");
  release();
  await started;
  await flushTicks();

  assert.deepEqual(
    r.calls.ready,
    [{ revision: 1, busy: true }],
    "main is told to abandon the round instead of transferring"
  );
  assert.deepEqual(collectBadges(r.content()), [], "no digits were painted");
});

test("main refusing at ready drops the local mode", async () => {
  const r = await renderer({
    snapshot: twoSessions,
    entries: twoEntries,
    ready: () => ({ status: "error" }),
  });
  await r.intent(1);

  assert.deepEqual(collectBadges(r.content()), [], "no digits linger after a failed arm");
  const event = await r.key("keydown", "1");
  assert.equal(event.prevented, false);
});

test("focus moving into an input during the quiet period cancels the jump", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);
  await r.key("keydown", "1");
  await r.key("keyup", "1");

  const input = new Element("input");
  r.document.activeElement = input;
  await r.fire("focusin", { target: input });

  await r.runTimers();
  assert.deepEqual(r.calls.activate, []);
});

test("typing during the quiet period cancels the jump", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);
  await r.key("keydown", "1");
  await r.key("keyup", "1");

  await r.fire("input", {});

  await r.runTimers();
  assert.deepEqual(r.calls.activate, []);
});

test("an IME composition during the quiet period cancels the jump", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);
  await r.key("keydown", "1");
  await r.key("keyup", "1");

  await r.fire("compositionstart", {});

  await r.runTimers();
  assert.deepEqual(r.calls.activate, []);
});

test("a control that grabs focus after the keyup blocks the queued submit", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);
  await r.key("keydown", "2");
  await r.key("keyup", "2");

  // No focusin event fired, but the safe state is re-checked at submit time.
  r.document.activeElement = new Element("select");

  await r.runTimers();
  assert.deepEqual(r.calls.activate, [], "re-validated immediately before sending");
});

test("a submitted jump reports submitted, never confirmed", async () => {
  const r = await renderer({ snapshot: twoSessions, entries: twoEntries });
  await r.intent(1);
  await r.key("keydown", "1");
  await r.key("keyup", "1");
  await r.runTimers();

  assert.equal(r.banner().textContent, i18n.en.dashboardQuickSelectSubmitted);
  assert.deepEqual(r.calls.ack, []);
});
