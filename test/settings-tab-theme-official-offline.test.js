"use strict";

// Offline-catalog behavior for the Theme tab: the official section and its
// retry banner survive a failed fetch, manual retry reuses the list request
// path, and the bounded automatic retry runs on the 10s/30s schedule without
// overlapping an in-flight read.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this._text = "";
    this.style = {};
    this.attributes = {};
    this.dataset = {};
    this._classList = new Set();
    this.listeners = new Map();
    this.disabled = false;
    this.scrollTop = 0;
    const self = this;
    this.classList = {
      add: (...names) => names.forEach((n) => self._classList.add(n)),
      remove: (...names) => names.forEach((n) => self._classList.delete(n)),
      toggle: (name, force) => {
        const on = force === undefined ? !self._classList.has(name) : !!force;
        if (on) self._classList.add(name);
        else self._classList.delete(name);
        return on;
      },
      contains: (name) => self._classList.has(name),
    };
  }

  get className() { return [...this._classList].join(" "); }
  set className(value) {
    this._classList = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    if (this.children.some((child) => child.contains(this.ownerDocument.activeElement))) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = String(value);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, cb) { this.listeners.set(type, cb); }
  removeEventListener(type) { this.listeners.delete(type); }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get firstChild() { return this.children[0] || null; }
  set innerHTML(value) { this.textContent = String(value).replace(/<[^>]*>/g, ""); this._html = value; }
  get innerHTML() { return this._html || ""; }

  contains(node) {
    if (!node) return false;
    if (this === node) return true;
    return this.children.some((child) => child.contains(node));
  }

  get isConnected() {
    const body = this.ownerDocument && this.ownerDocument.body;
    if (!body) return false;
    return this === body || body.contains(this);
  }

  focus() {
    if (this.isConnected && !this.disabled) this.ownerDocument.activeElement = this;
  }

  querySelector(selector) {
    const match = (el) => selector.startsWith(".") && el._classList.has(selector.slice(1));
    const visit = (el) => {
      for (const child of el.children) {
        if (match(child)) return child;
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(this);
  }
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function builtin() {
  return { id: "clawd", name: "Clawd", active: true, builtin: true };
}

function official(id) {
  return {
    id,
    name: id,
    active: false,
    builtin: false,
    officialTheme: true,
    officialThemeState: "available",
    officialThemeBytes: 2 * 1024 * 1024,
    officialThemeVersion: "1.0.0",
    officialThemeCanUninstall: false,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 6; i += 1) await flush();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createHarness(options = {}) {
  const document = {};
  document.createElement = (tag) => new FakeElement(tag, document);
  document.body = new FakeElement("body", document);
  document.activeElement = document.body;
  document.getElementById = (id) => findById(document.body, id);

  const content = document.createElement("div");
  content.id = "content";
  document.body.appendChild(content);

  const timers = new Map();
  let nextTimerId = 1;
  const fakeSetTimeout = (fn, ms) => {
    const id = nextTimerId += 1;
    timers.set(id, { fn, ms });
    return id;
  };
  const fakeClearTimeout = (id) => { timers.delete(id); };

  const sandbox = {
    document,
    console,
    window: { settingsAPI: {} },
    navigator: { userAgent: "node-test", platform: "win32", language: "en" },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    requestAnimationFrame: (cb) => cb(),
  };
  sandbox.globalThis = sandbox;

  for (const file of ["settings-i18n.js", "settings-size-slider.js", "settings-ui-core.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(SRC_DIR, file), "utf8"), sandbox, { filename: file });
  }

  const core = sandbox.ClawdSettingsCore;
  core.helpers.buildSettingsSelect = () => {
    const element = document.createElement("div");
    element.className = "settings-select";
    return { element, setValue() {}, setPending() {}, setDisabled() {} };
  };

  core.state.activeTab = "theme";
  core.state.snapshot = { lang: "en" };
  Object.assign(core.runtime, {
    themeList: options.localThemes || [builtin()],
    officialThemeList: options.officialThemes || [],
    officialThemeListFetched: true,
    officialThemeCatalogStatus: options.status || "offline",
  });

  let listOfficialThemesCalls = 0;
  let listOfficialThemesFn = () => ({
    status: "ok",
    catalogStatus: options.status || "offline",
    themes: core.runtime.officialThemeList || [],
  });
  sandbox.window.settingsAPI.listThemes = () => Promise.resolve(core.runtime.themeList || []);
  sandbox.window.settingsAPI.listOfficialThemes = () => {
    listOfficialThemesCalls += 1;
    return Promise.resolve(listOfficialThemesFn());
  };

  const renderLog = [];
  core.renderHooks.content = () => {
    renderLog.push("content");
    content.textContent = "";
    core.tabs.theme.render(content);
  };

  vm.runInNewContext(fs.readFileSync(path.join(SRC_DIR, "settings-tab-theme.js"), "utf8"), sandbox, { filename: "settings-tab-theme.js" });
  sandbox.ClawdSettingsTabTheme.init(core);

  return {
    core,
    document,
    content,
    renderLog,
    t: (key) => core.helpers.t(key),
    get listOfficialThemesCalls() { return listOfficialThemesCalls; },
    setListOfficialThemes(fn) { listOfficialThemesFn = fn; },
    mount() {
      content.textContent = "";
      core.tabs.theme.render(content);
    },
    click(el) {
      const handler = el && el.listeners.get("click");
      if (handler) handler({ stopPropagation() {}, preventDefault() {} });
    },
    timerDelays() {
      return [...timers.values()].map((timer) => timer.ms);
    },
    fireTimer(ms) {
      for (const [id, timer] of timers) {
        if (timer.ms === ms) {
          timers.delete(id);
          timer.fn();
          return true;
        }
      }
      return false;
    },
  };
}

describe("official catalog offline banner", () => {
  test("keeps the official section and shows the with-list copy when cards are known", () => {
    const h = createHarness({ status: "offline", officialThemes: [official("hash-sage")] });
    h.mount();

    const banner = h.content.querySelector(".theme-official-offline-banner");
    assert.ok(banner);
    assert.strictEqual(
      h.content.querySelector(".theme-official-offline-message").textContent,
      h.t("themeOfficialOfflineWithList"),
    );
    assert.ok(h.content.querySelector(".theme-card"));
  });

  test("shows the no-list copy and keeps an empty official section reachable", () => {
    const h = createHarness({ status: "invalid", officialThemes: [] });
    h.mount();

    assert.ok(h.content.querySelector(".theme-official-offline-banner"));
    assert.strictEqual(
      h.content.querySelector(".theme-official-offline-message").textContent,
      h.t("themeOfficialOfflineNoList"),
    );
  });

  test("has no offline banner while the catalog is healthy", () => {
    const h = createHarness({ status: "ok", officialThemes: [official("hash-sage")] });
    h.mount();
    assert.strictEqual(h.content.querySelector(".theme-official-offline-banner"), null);
  });

  test("retry disables the button, shows reconnecting, and clears the banner on success", async () => {
    const h = createHarness({ status: "offline", officialThemes: [official("hash-sage")] });
    h.mount();
    const button = h.content.querySelector(".theme-official-offline-retry");
    assert.ok(button);

    let resolveOfficial;
    h.setListOfficialThemes(() => new Promise((resolve) => { resolveOfficial = resolve; }));
    h.click(button);

    assert.strictEqual(button.disabled, true);
    assert.strictEqual(button.textContent, h.t("themeOfficialRetrying"));

    resolveOfficial({ status: "ok", catalogStatus: "ok", themes: [official("hash-sage")] });
    await settle();

    assert.strictEqual(h.content.querySelector(".theme-official-offline-banner"), null);
  });

  test("auto retries about 10s after the failure then about 30s later, at most twice", async () => {
    const h = createHarness({ status: "offline", officialThemes: [] });
    h.setListOfficialThemes(() => ({ status: "ok", catalogStatus: "offline", themes: [] }));
    h.mount();

    assert.deepStrictEqual(h.timerDelays(), [10000]);

    assert.strictEqual(h.fireTimer(10000), true);
    await settle();
    assert.strictEqual(h.listOfficialThemesCalls, 1);
    assert.deepStrictEqual(h.timerDelays(), [30000], "the second attempt is scheduled 30s out");

    assert.strictEqual(h.fireTimer(30000), true);
    await settle();
    assert.strictEqual(h.listOfficialThemesCalls, 2);
    assert.deepStrictEqual(h.timerDelays(), [], "no third automatic attempt is scheduled");
  });

  test("the automatic retry budget resets after the catalog recovers", async () => {
    const h = createHarness({ status: "offline", officialThemes: [] });
    let mode = "offline";
    h.setListOfficialThemes(() => ({ status: "ok", catalogStatus: mode, themes: [] }));
    h.mount();
    assert.deepStrictEqual(h.timerDelays(), [10000]);

    h.fireTimer(10000);
    await settle();
    h.fireTimer(30000);
    await settle();
    assert.strictEqual(h.listOfficialThemesCalls, 2);
    assert.deepStrictEqual(h.timerDelays(), [], "the failure episode is limited to two retries");

    // Recovery clears the budget and schedules nothing while it stays healthy.
    mode = "ok";
    await h.core.ops.fetchThemes();
    await settle();
    assert.strictEqual(h.content.querySelector(".theme-official-offline-banner"), null);
    assert.deepStrictEqual(h.timerDelays(), [], "no retry while the catalog is healthy");

    // A new failure episode gets its own two automatic attempts.
    mode = "offline";
    await h.core.ops.fetchThemes();
    await settle();
    assert.deepStrictEqual(h.timerDelays(), [10000], "a new failure re-arms the first retry");
    const before = h.listOfficialThemesCalls;
    h.fireTimer(10000);
    await settle();
    assert.strictEqual(h.listOfficialThemesCalls - before, 1);
    assert.deepStrictEqual(h.timerDelays(), [30000]);
    h.fireTimer(30000);
    await settle();
    assert.strictEqual(h.listOfficialThemesCalls - before, 2);
    assert.deepStrictEqual(h.timerDelays(), [], "the second episode is also limited to two retries");
  });

  test("a manual retry cancels the pending automatic retry", async () => {
    const h = createHarness({ status: "offline", officialThemes: [] });
    const pending = deferred();
    h.setListOfficialThemes(() => pending.promise);
    h.mount();
    assert.deepStrictEqual(h.timerDelays(), [10000]);

    h.click(h.content.querySelector(".theme-official-offline-retry"));
    assert.deepStrictEqual(h.timerDelays(), [], "the scheduled automatic retry was cancelled");
    assert.strictEqual(h.listOfficialThemesCalls, 1);

    pending.resolve({ status: "ok", catalogStatus: "offline", themes: [] });
    await settle();
  });

  test("leaving the theme tab cancels the pending automatic retry", () => {
    const h = createHarness({ status: "offline", officialThemes: [] });
    h.mount();
    assert.deepStrictEqual(h.timerDelays(), [10000]);

    h.core.tabs.theme.onExit();
    assert.deepStrictEqual(h.timerDelays(), []);
    assert.strictEqual(h.fireTimer(10000), false);
    assert.strictEqual(h.listOfficialThemesCalls, 0);
  });

  test("a scheduled automatic retry does not stack on an in-flight official request", async () => {
    const h = createHarness({ status: "offline", officialThemes: [] });
    const pending = deferred();
    h.setListOfficialThemes(() => pending.promise);
    h.mount();

    h.core.ops.fetchOfficialThemes();
    await flush();
    assert.strictEqual(h.listOfficialThemesCalls, 1, "the manual read is in flight");

    h.fireTimer(10000);
    await flush();
    assert.strictEqual(h.listOfficialThemesCalls, 1, "the automatic retry reuses the in-flight read");

    pending.resolve({ status: "ok", catalogStatus: "offline", themes: [] });
    await settle();
  });
});
