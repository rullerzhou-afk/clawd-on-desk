"use strict";

// WIN-R2: the shared page keeps the user's scroll position across a host
// transfer.
//
// The keyboard mode borrows this very page: main moves the one
// `WebContentsView` from the ordinary window into the quick host and back. What
// the Windows run measured is that the scroller came back at exactly 0
// (500.6667 → 0 → 0) with the same WebContents, the same document token, the
// same group/card order and the same `scrollHeight`. What it does NOT show is
// which step drops the offset: the card tree is rebuilt on every render
// (`replaceChildren`), the view is re-parented between two native hosts, the
// host size changes and focus moves — the evidence does not single any of them
// out, and none of it was reproduced here.
//
// These tests therefore model the *protocol* — a transfer happened and the
// scroller came back at 0 — and pin what the page does about it. They are not a
// browser proof that the drop happens, nor that it only happens where it is
// simulated here; the real transfer still has to be checked on a real machine.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { i18n } = require("../src/i18n");

const RENDERER_SOURCE = fs.readFileSync(
  path.join(__dirname, "../src/dashboard-renderer.js"),
  "utf8"
);

const flush = () => new Promise((resolve) => setImmediate(resolve));

function session(id) {
  return {
    id,
    displayTitle: `Title ${id}`,
    agentId: "codex",
    agentName: "Codex",
    badge: "idle",
    canFocus: true,
    updatedAt: Date.now(),
    cwd: `/tmp/${id}`,
  };
}

class ClassList {
  constructor(el) { this.el = el; this.items = new Set(); }
  add(...names) { for (const n of names) this.items.add(n); }
  remove(...names) { for (const n of names) this.items.delete(n); }
  toggle(name, force) {
    const on = force === undefined ? !this.items.has(name) : !!force;
    if (on) this.items.add(name); else this.items.delete(name);
  }
  contains(name) { return this.items.has(name); }
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
    this.className = "";
    this.classList = new ClassList(this);
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(child) { this.children = child ? [...child.children] : []; }
  addEventListener(name, fn) {
    const list = this.listeners.get(name) || [];
    list.push(fn);
    this.listeners.set(name, list);
  }
  removeEventListener(name) { this.listeners.delete(name); }
  contains() { return true; }
  focus() {}
  select() {}
  dispatch(name, event = {}) {
    for (const fn of this.listeners.get(name) || []) fn(event);
  }
}

// The scrolling container (`main#content`). Writes are recorded so a test can
// assert that a path never touches the user's position at all.
class ScrollerElement extends Element {
  constructor() {
    super("main");
    this._scrollTop = 0;
    this.scrollHeight = 1794;
    this.clientHeight = 501;
    this.writes = [];
  }
  get scrollTop() { return this._scrollTop; }
  set scrollTop(value) {
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    this._scrollTop = Math.max(0, Math.min(value, max));
    this.writes.push(this._scrollTop);
  }
}

async function renderer(options = {}) {
  const elements = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const quickListeners = new Map();
  const observers = [];
  const calls = { enter: [], ready: [], dismiss: [] };
  const content = new ScrollerElement();
  elements.set("content", content);

  const document = {
    title: "",
    documentElement: {},
    activeElement: null,
    createElement: (tag) => new Element(tag),
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
    getSnapshot: async () => options.snapshot,
    getI18n: async () => ({ lang: "en", translations: i18n.en }),
    getKimiQuotaStatus: async () => null,
    refreshKimiQuota: async () => ({ status: "ok" }),
    focusSession: () => { throw new Error("focusSession must not be used by the numeric path"); },
    hideSession: async () => ({ status: "ok" }),
    openSessionFolder: async () => ({ status: "ok" }),
    setSessionAlias: async () => ({ status: "ok" }),
    setSessionAutomationOverride: async () => ({ status: "applied" }),
    clearSessionAutomationGrant: async () => ({ status: "applied" }),
    ackCompletion: async () => ({ status: "ok" }),
    onSessionSnapshot: (fn) => quickListeners.set("snapshot", fn),
    onLangChange: (fn) => quickListeners.set("lang", fn),
    quickPending: async () => ({ status: "ok", revision: 0 }),
    quickEnter: async (payload) => {
      calls.enter.push({ ...payload });
      if (payload.busy) return { status: "busy", revision: payload.revision };
      return { status: "ok", revision: payload.revision, entries: options.entries || [] };
    },
    quickReady: async (payload) => {
      calls.ready.push({ ...payload });
      // The native transfer happens inside this call; a test can make it land
      // before the reply instead of after it.
      if (options.onReady) options.onReady();
      return { status: "ok" };
    },
    quickActivate: async () => ({ status: "submitted" }),
    quickDismiss: async (payload) => {
      calls.dismiss.push({ ...payload });
      if (options.onDismiss) options.onDismiss();
      return { status: "ok" };
    },
    onQuickIntent: (fn) => quickListeners.set("intent", fn),
    onQuickEntries: (fn) => quickListeners.set("entries", fn),
    onQuickDismissed: (fn) => quickListeners.set("dismissed", fn),
  };

  const sandbox = {
    document,
    navigator: { platform: options.platform || "Win32" },
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
    ResizeObserver: options.noResizeObserver ? undefined : class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() {}
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    Intl,
    Date,
    console,
  };
  sandbox.globalThis.window = sandbox.window;
  sandbox.globalThis.document = document;

  vm.runInNewContext(RENDERER_SOURCE, sandbox);
  await flush();
  await flush();

  const scrollEvent = () => content.dispatch("scroll", {});
  return {
    content,
    calls,
    document,
    // The user parks the page somewhere: a real gesture, then the offset moves.
    userScroll(top) {
      content.dispatch("wheel", {});
      content._scrollTop = Math.max(0, Math.min(top, content.scrollHeight - content.clientHeight));
      content.writes.length = 0;
      scrollEvent();
    },
    // What the Windows evidence shows after the page changed hosts: the
    // scroller is back at 0 with the same content. The drop itself is not a
    // write by this page, so it bypasses the recording setter.
    transferDropsOffset({ scroll = true, resize = true } = {}) {
      content._scrollTop = 0;
      if (scroll) scrollEvent();
      if (resize) for (const observer of observers) observer.callback([{ target: content }]);
    },
    // A layout signal that is NOT a lost offset (the mode banner appearing).
    layoutChanged(clientHeight) {
      content.clientHeight = clientHeight;
      for (const observer of observers) observer.callback([{ target: content }]);
    },
    // One frame of a scroll that is already under way: the offset moves and a
    // scroll event follows, with no input event of its own. This is what
    // Chromium emits per frame while it animates a single wheel notch.
    scrollTo(top) {
      content._scrollTop = Math.max(0, Math.min(top, content.scrollHeight - content.clientHeight));
      content.writes.length = 0;
      scrollEvent();
    },
    // Chromium fires `scrollend` once a scroll (gesture plus any animation)
    // has finished. Shipped in Chrome 114; Electron 41.10.4 is far newer.
    scrollEnd() {
      content.dispatch("scrollend", {});
    },
    scrollEvent,
    // A document-level event (the pointer release that ends a drag).
    documentEvent: (type, event = {}) => {
      const fn = documentListeners.get(type);
      if (fn) fn(event);
    },
    intent: async (revision) => {
      await quickListeners.get("intent")({ revision });
      await flush();
      await flush();
    },
    dismissed: async (revision) => {
      quickListeners.get("dismissed")({ revision });
      await flush();
    },
    key: async (type, key, extra = {}) => {
      const event = {
        key,
        code: /^[1-9]$/.test(key) ? `Digit${key}` : key,
        target: document.activeElement,
        preventDefault() {},
        stopPropagation() {},
        ...extra,
      };
      const fn = documentListeners.get(type);
      if (fn) fn(event);
      await flush();
      return event;
    },
  };
}

const snapshot = {
  sessions: [session("s1"), session("s2")],
  groups: [{ host: "local", ids: ["s1", "s2"] }],
};
const entries = [
  { id: "s1", title: "Title s1", agentName: "Codex", badge: "idle", canFocus: true },
  { id: "s2", title: "Title s2", agentName: "Codex", badge: "idle", canFocus: true },
];

test("a transfer that drops the offset gets the user's position back", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);

  await r.intent(1);
  // Entering the mode makes the scroller shorter (the banner) and the page
  // changes hosts; the offset comes back as 0.
  r.content.clientHeight = 463;
  r.transferDropsOffset();

  assert.equal(r.content.scrollTop, 500, "the page is where the user left it");
});

test("an offset dropped inside the transfer call is restored on the reply", async () => {
  // Same loss, but it lands while main is still transferring rather than after
  // it replied — so no scroll or resize signal follows to trigger the repair.
  let drop = () => {};
  const r = await renderer({ snapshot, entries, onReady: () => drop() });
  r.userScroll(500);
  drop = () => {
    r.content.clientHeight = 463;
    r.transferDropsOffset({ scroll: false, resize: false });
  };

  await r.intent(1);

  assert.equal(r.content.scrollTop, 500, "restored as soon as the transfer replied");
});

test("a resize is enough: the restore does not depend on a scroll event", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);

  await r.intent(1);
  r.content.clientHeight = 463;
  r.transferDropsOffset({ scroll: false, resize: true });

  assert.equal(r.content.scrollTop, 500);
});

test("a position the user chose during the transfer is never overwritten", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);

  await r.intent(1);
  // The user rolled the wheel while the mode was opening; the transfer then
  // lands and re-lays the page out without losing anything.
  r.userScroll(250);
  r.layoutChanged(463);
  r.scrollEvent();

  assert.equal(r.content.scrollTop, 250, "the newer position wins");
  assert.deepEqual(r.content.writes, [], "the page never wrote over it");
});

test("a snapshot that got shorter clamps instead of restoring", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);

  await r.intent(1);
  // Sessions ended while the round was starting: less to scroll through.
  r.content.scrollHeight = 583;
  r.content.clientHeight = 463;
  r.transferDropsOffset();

  assert.equal(r.content.scrollTop, 120, "clamped to the new maximum");
});

test("a page that is no longer scrollable stays at the top", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);

  await r.intent(1);
  r.content.scrollHeight = 400;
  r.content.clientHeight = 463;
  r.transferDropsOffset();

  assert.equal(r.content.scrollTop, 0);
  assert.deepEqual(r.content.writes, [], "nothing was written back");
});

test("a user who is already at the top is not pushed back down", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);
  r.userScroll(0);

  await r.intent(1);
  r.layoutChanged(463);
  r.scrollEvent();

  assert.equal(r.content.scrollTop, 0, "the top is where they asked to be");
  assert.deepEqual(r.content.writes, []);
});

test("the return transfer at the end of a round is restored as well", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);

  await r.intent(1);
  r.content.clientHeight = 463;
  r.transferDropsOffset();
  assert.equal(r.content.scrollTop, 500);

  // Main ended the round (blur / external click / reload) and the page moved
  // back to the ordinary host. Here the drop lands after the dismissal reached
  // this page; the opposite order is covered below.
  await r.dismissed(1);
  r.content.clientHeight = 501;
  r.transferDropsOffset();

  assert.equal(r.content.scrollTop, 500, "still where the user left it");
});

test("the return transfer is repaired even though main returns the view before it tells us", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);

  await r.intent(1);
  r.content.clientHeight = 463;
  r.transferDropsOffset();
  assert.equal(r.content.scrollTop, 500);

  // The user moves somewhere else while the mode is up.
  r.userScroll(650);

  // Production order (dashboard-quick-mode.js `dismiss`): the view is attached
  // back to the ordinary host first and `dashboard:quick-dismissed` is only
  // sent afterwards, so the return transfer can land before this page hears
  // that the round is over.
  r.content.clientHeight = 501;
  r.transferDropsOffset();
  await r.dismissed(1);
  r.layoutChanged(501);

  assert.equal(r.content.scrollTop, 650, "the position chosen inside the round survives");
});

test("a scrolling key that never reaches the scroller still counts as the user's", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);

  // A round is up and nothing was dropped, so the guard is still armed.
  await r.intent(1);

  // `.content` has no tabindex, so a scrolling key is normally delivered to
  // body: only the document-capture handler sees it.
  r.document.activeElement = new Element("body");
  await r.key("keydown", "Home");
  r.content._scrollTop = 0;
  r.scrollEvent();

  assert.equal(r.content.scrollTop, 0, "the user's own scroll to the top stands");
  assert.deepEqual(r.content.writes, [], "and nothing was written back over it");
});

test("one wheel notch animating to the top is the user's, not a lost offset", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);
  await r.intent(1);

  // A single wheel notch with smooth scrolling: Chromium animates it and emits
  // a scroll event per frame, so only the first frame has an input event next
  // to it. The last frame landing on exactly 0 is still the user's scroll.
  r.content.dispatch("wheel", {});
  r.scrollTo(320);
  r.scrollTo(140);
  r.scrollTo(0);

  assert.equal(r.content.scrollTop, 0, "the whole animation belongs to the user");
  assert.deepEqual(r.content.writes, [], "nothing was written back over it");
});

test("a gesture that already finished does not shield a later transfer", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);
  await r.intent(1);

  // The user scrolls down and the scroll finishes (Chromium's `scrollend`).
  r.content.dispatch("wheel", {});
  r.scrollTo(650);
  r.scrollEnd();

  // Only afterwards does the page change hosts and come back at 0.
  r.transferDropsOffset();

  assert.equal(r.content.scrollTop, 650, "the finished gesture does not excuse the drop");
});

test("a scrollbar drag to the top is not undone mid-gesture", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);
  await r.intent(1);

  // One pointerdown, then the drag produces several scroll events without any
  // further input event of its own.
  r.content.dispatch("pointerdown", {});
  r.content._scrollTop = 200;
  r.scrollEvent();
  r.content._scrollTop = 0;
  r.scrollEvent();
  r.documentEvent("pointerup");

  assert.equal(r.content.scrollTop, 0, "the whole drag belongs to the user");
  assert.deepEqual(r.content.writes, []);
});

test("a completed click cannot turn a later transfer loss into user scrolling", async () => {
  for (const release of ["pointerup", "pointercancel"]) {
    const r = await renderer({ snapshot, entries });
    r.userScroll(500);
    r.scrollEnd();
    await r.intent(1);

    // A click is not a scroll: no content scrollend will follow it.
    r.content.dispatch("pointerdown", {});
    r.documentEvent(release);
    r.transferDropsOffset();

    assert.equal(r.content.scrollTop, 500, release);
  }
});

test("keys inside editing controls cannot authorize a content offset reset", async () => {
  for (const tag of ["input", "textarea", "select", "div"]) {
    const r = await renderer({ snapshot, entries });
    r.userScroll(500);
    r.scrollEnd();
    await r.intent(1);
    const input = new Element(tag);
    input.isContentEditable = tag === "div";
    r.document.activeElement = input;

    // Home belongs to the caret/native control, not the page scroller.
    await r.key("keydown", "Home");
    r.document.activeElement = new Element("body");
    r.transferDropsOffset();

    assert.equal(r.content.scrollTop, 500, tag);
  }
});

test("Mac Home in an input keeps its native page-to-top behavior", async () => {
  const r = await renderer({ snapshot, entries, platform: "MacIntel" });
  r.userScroll(500);
  r.scrollEnd();
  await r.intent(1);
  r.document.activeElement = new Element("input");
  // Native Mac control: unlike Windows caret Home, this scrolls the page.
  await r.key("keydown", "Home");
  r.scrollTo(200);
  r.scrollTo(0);
  assert.equal(r.content.scrollTop, 0);
  assert.deepEqual(r.content.writes, []);
});

test("Mac caret arrows do not inherit the Home page-scroll exception", async () => {
  const r = await renderer({ snapshot, entries, platform: "MacIntel" });
  r.userScroll(500);
  r.scrollEnd();
  await r.intent(1);
  r.document.activeElement = new Element("input");
  await r.key("keydown", "ArrowUp");
  r.document.activeElement = new Element("body");
  r.transferDropsOffset();
  assert.equal(r.content.scrollTop, 500);
});

test("a composition key is not a content scrolling gesture", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);
  r.scrollEnd();
  await r.intent(1);
  r.document.activeElement = new Element("body");
  await r.key("keydown", "Home", { isComposing: true });
  r.transferDropsOffset();
  assert.equal(r.content.scrollTop, 500);
});

test("Space activating a button is not a content scrolling gesture", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);
  r.scrollEnd();
  await r.intent(1);
  r.document.activeElement = new Element("button");
  await r.key("keydown", " ");
  r.document.activeElement = new Element("body");
  r.transferDropsOffset();
  assert.equal(r.content.scrollTop, 500);
});

test("pointer release records the final drag position before a queued scroll event", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);
  r.scrollEnd();
  await r.intent(1);
  r.content.dispatch("pointerdown", {});
  r.scrollTo(200);
  // Layout already moved to the top, but its scroll event arrives after up.
  r.content._scrollTop = 0;
  r.documentEvent("pointerup");
  r.scrollEvent();
  assert.equal(r.content.scrollTop, 0);
  assert.deepEqual(r.content.writes, []);
});

test("a click does not consume an independent wheel animation", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);
  r.scrollEnd();
  await r.intent(1);
  r.content.dispatch("wheel", {});
  r.scrollTo(320);
  r.content.dispatch("pointerdown", {});
  r.documentEvent("pointerup");
  r.scrollTo(140);
  r.scrollTo(0);
  assert.equal(r.content.scrollTop, 0);
  assert.deepEqual(r.content.writes, []);
});

test("an unrelated pointer release does not record an unreported transfer loss", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);
  r.scrollEnd();
  await r.intent(1);
  r.transferDropsOffset({ scroll: false, resize: false });
  // The pointer never started in our content; its release proves nothing.
  r.documentEvent("pointerup");
  r.scrollEvent();
  assert.equal(r.content.scrollTop, 500);
});

test("cancelling with Escape keeps the position across the way back", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);

  await r.intent(1);
  r.content.clientHeight = 463;
  r.transferDropsOffset();

  await r.key("keydown", "Escape");
  r.content.clientHeight = 501;
  r.transferDropsOffset();

  assert.equal(r.content.scrollTop, 500);
});

test("a scroll the user performs after the round is final", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);

  await r.intent(1);
  r.transferDropsOffset();
  assert.equal(r.content.scrollTop, 500);

  // Long after the transfer, the user scrolls to the top themselves.
  r.userScroll(0);
  r.scrollEvent();

  assert.equal(r.content.scrollTop, 0, "their own scroll is not undone");
});

test("a refused (busy) round never touches the scroll position", async () => {
  const r = await renderer({ snapshot, entries });
  r.userScroll(500);
  const input = new Element("input");
  r.document.activeElement = input;

  await r.intent(1);

  assert.deepEqual(r.calls.ready, [], "the round was refused before any transfer");
  assert.deepEqual(r.content.writes, [], "and nothing wrote to the scroller");
  assert.equal(r.content.scrollTop, 500);
});

test("a page without ResizeObserver still restores on the scroll signal", async () => {
  const r = await renderer({ snapshot, entries, noResizeObserver: true });
  r.userScroll(500);

  await r.intent(1);
  r.transferDropsOffset({ scroll: true, resize: false });

  assert.equal(r.content.scrollTop, 500);
});
