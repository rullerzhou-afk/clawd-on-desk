"use strict";

// Follow-up coverage for the official-theme download row in the Theme tab:
// cross-card busy gating, real button ARIA state, focus restoration across
// structural row rebuilds, the customization-detail view, list re-fetch after a
// re-opened Settings page, and the list-data fingerprint gate. Unlike the
// original progress-patch suite this one loads the real settings-i18n /
// settings-size-slider / settings-ui-core helpers (buildButton, setButtonState,
// focusSettingsTarget, requestRender) so disabled/aria-busy/focus and the real
// localized copy are exercised end to end.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");

// ── DOM model ─────────────────────────────────────────────────────────────
// Adds document connectivity, keyboard focus and focus hand-off on removal to
// the class/tree model used by the original suite. It is still not a browser:
// no layout, CSS, event bubbling or accessibility tree.
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
    if (child.contains && child.contains(this.ownerDocument.activeElement)) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
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

  // Depth-first class-only selector (".foo"), like the original suite.
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

function collect(root, predicate) {
  const out = [];
  const visit = (el) => {
    for (const child of el.children) {
      if (predicate(child)) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

function byLabel(root, label) {
  return collect(root, (el) => el.tagName === "button" && el.textContent === label)[0] || null;
}

// ── Fixtures ──────────────────────────────────────────────────────────────
function builtin() {
  return { id: "clawd", name: "Clawd", active: true, builtin: true };
}

function official(id, state = "available", extra = {}) {
  return {
    id,
    name: id,
    active: false,
    builtin: false,
    officialTheme: true,
    officialThemeState: state,
    officialThemeBytes: 2 * 1024 * 1024,
    officialThemeVersion: "1.0.0",
    officialThemeShowcaseUrl: "https://example.invalid/" + id,
    officialThemeCanUninstall: state === "installed" || state === "update-available",
    ...extra,
  };
}

function customTheme() {
  return {
    id: "local-custom",
    name: "Local Custom",
    active: true,
    builtin: false,
    capabilities: { petTint: true },
  };
}

// ── Harness ───────────────────────────────────────────────────────────────
function createHarness(options = {}) {
  const document = {};
  document.createElement = (tag) => new FakeElement(tag, document);
  document.body = new FakeElement("body", document);
  document.activeElement = document.body;
  document.getElementById = (id) => findById(document.body, id);

  const content = document.createElement("div");
  content.id = "content";
  document.body.appendChild(content);

  // The theme tab schedules bounded catalog auto-retries with setTimeout. This
  // suite is not about that schedule, so timers are captured but never fire:
  // no real timer is left alive after a test to issue late IPC requests.
  const timers = new Map();
  let nextTimerId = 1;
  const sandbox = {
    document,
    console,
    window: { settingsAPI: {} },
    navigator: { userAgent: "node-test", platform: "win32", language: "en" },
    setTimeout: (fn, ms) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    requestAnimationFrame: (cb) => cb(),
  };
  sandbox.globalThis = sandbox;

  for (const file of ["settings-i18n.js", "settings-size-slider.js", "settings-ui-core.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(SRC_DIR, file), "utf8"), sandbox, { filename: file });
  }

  const core = sandbox.ClawdSettingsCore;
  // The customization detail view renders pickers via buildSettingsSelect, which
  // needs language-picker.js. This suite is not about pickers, so swap in a
  // no-op control to keep the detail render from throwing.
  core.helpers.buildSettingsSelect = () => {
    const element = document.createElement("div");
    element.className = "settings-select";
    return { element, setValue() {}, setPending() {}, setDisabled() {} };
  };

  core.state.activeTab = options.activeTab || "theme";
  core.state.snapshot = { lang: "en" };

  const themeList = options.localThemes || [builtin()];
  const officialThemeList = options.officialThemes || [official("hash-sage"), official("whale-chan")];
  Object.assign(core.runtime, {
    themeList,
    officialThemeList,
    officialThemeListFetched: true,
    officialThemeCatalogStatus: "ok",
    officialThemePendingThemeId: options.pendingThemeId || null,
    officialThemeOperation: options.operation || null,
  });

  let listThemesCalls = 0;
  let listOfficialThemesCalls = 0;
  let listThemesFn = () => core.runtime.themeList || [];
  let listOfficialThemesFn = () => ({
    status: "ok",
    catalogStatus: "ok",
    themes: core.runtime.officialThemeList || [],
  });
  sandbox.window.settingsAPI.listThemes = () => {
    listThemesCalls += 1;
    return Promise.resolve(listThemesFn());
  };
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
    window: sandbox.window,
    t: (key) => core.helpers.t(key),
    get listThemesCalls() { return listThemesCalls; },
    get listOfficialThemesCalls() { return listOfficialThemesCalls; },
    setListThemes(fn) { listThemesFn = fn; },
    setListOfficialThemes(fn) { listOfficialThemesFn = fn; },
    mount() {
      content.textContent = "";
      core.tabs.theme.render(content);
    },
    progress(p) { core.ops.applyOfficialThemeProgress(p); },
    patch() { return core.tabs.theme.patchOfficialThemeProgress(); },
    cards() { return collect(content, (el) => el.classList.contains("theme-card")); },
    card(name) {
      return this.cards().find((card) => {
        const label = card.querySelector(".theme-card-name-text");
        return label && label.textContent === name;
      }) || null;
    },
    click(el) {
      const handler = el && el.listeners.get("click");
      if (handler) handler({ stopPropagation() {}, preventDefault() {} });
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  for (let i = 0; i < 6; i += 1) await flush();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function cardButton(harness, themeName, selector) {
  const card = harness.card(themeName);
  assert.ok(card, `card ${themeName} must render`);
  const btn = card.querySelector(selector);
  assert.ok(btn, `${selector} must render inside ${themeName}`);
  return btn;
}

// ── 1. Cross-card busy gating ─────────────────────────────────────────────
describe("official row busy gating", () => {
  async function runBusyScenario(secondState, selector) {
    const h = createHarness({
      localThemes: [builtin()],
      officialThemes: [
        official("hash-sage"),
        official("whale-chan", secondState, secondState === "error" ? { officialThemeError: { message: "failed" } } : {}),
      ],
    });
    h.mount();
    h.renderLog.length = 0;

    let resolveInstall;
    h.window.settingsAPI.installOfficialTheme = () => new Promise((resolve) => { resolveInstall = resolve; });

    h.click(cardButton(h, "hash-sage", ".theme-official-download-btn"));

    assert.deepStrictEqual(h.renderLog, [], "starting the install must not fully re-render the list");
    assert.strictEqual(
      cardButton(h, "whale-chan", selector).disabled,
      true,
      "the other card's action button must be disabled immediately",
    );

    for (const [phase, receivedBytes] of [["downloading", 25], ["extracting", 100], ["installing", 100]]) {
      h.progress({ id: "hash-sage", phase, receivedBytes, totalBytes: 100 });
      assert.deepStrictEqual(h.renderLog, [], `progress ${phase} must patch in place`);
    }

    h.progress({ id: null, phase: "idle", receivedBytes: 0, totalBytes: 0 });
    h.progress({ id: null, phase: "idle", receivedBytes: 0, totalBytes: 0 });
    assert.strictEqual(
      cardButton(h, "whale-chan", selector).disabled,
      true,
      "the other card stays disabled while the install promise is still pending",
    );

    resolveInstall({ status: "ok" });
    await settle();
    assert.strictEqual(
      cardButton(h, "whale-chan", selector).disabled,
      false,
      "the other card recovers once the install finishes and the list refreshes",
    );
  }

  test("PR #1088 follow-up: a download disables another available card's download button", async () => {
    await runBusyScenario("available", ".theme-official-download-btn");
  });

  test("PR #1088 follow-up: a download disables another error card's retry button", async () => {
    await runBusyScenario("error", ".theme-official-retry-btn");
  });

  test("PR #1088 follow-up: a progress event alone grays out the other cards after a reopen", () => {
    const h = createHarness({
      localThemes: [builtin()],
      officialThemes: [
        official("hash-sage"),
        official("whale-chan"),
        official("third", "error", { officialThemeError: { message: "failed" } }),
      ],
    });
    h.mount();
    h.renderLog.length = 0;

    // No pending id: this renderer never started the install, it only mirrors
    // the operation reported by main.
    h.progress({ id: "hash-sage", phase: "downloading", receivedBytes: 30, totalBytes: 100 });

    assert.deepStrictEqual(h.renderLog, [], "the operation mirror still patches in place");
    assert.strictEqual(cardButton(h, "whale-chan", ".theme-official-download-btn").disabled, true);
    assert.strictEqual(cardButton(h, "third", ".theme-official-retry-btn").disabled, true);
  });
});

// ── 2. Real action-button state via the shared helper ─────────────────────
describe("theme action button state", () => {
  const ACTIONS = [
    { api: "importCodexPetZip", labelKey: "themeImportPetZip" },
    { api: "refreshCodexPets", labelKey: "themeRefreshImportedPets" },
    { api: "importUserThemeZip", labelKey: "themeImportUserThemeZip" },
  ];
  const OUTCOMES = ["ok", "cancel", "error", "reject"];

  function startHarness(api) {
    const h = createHarness({ localThemes: [builtin()] });
    // Give every action an API so all buttons start enabled; only the target is
    // controllable.
    h.window.settingsAPI.importCodexPetZip = () => new Promise(() => {});
    h.window.settingsAPI.refreshCodexPets = () => new Promise(() => {});
    h.window.settingsAPI.importUserThemeZip = () => new Promise(() => {});
    const controller = {};
    h.window.settingsAPI[api] = () => new Promise((resolve, reject) => {
      controller.resolve = resolve;
      controller.reject = reject;
    });
    h.mount();
    return { h, controller };
  }

  for (const action of ACTIONS) {
    for (const outcome of OUTCOMES) {
      test(`PR #1088 follow-up: ${action.api} ${outcome} keeps aria-busy in sync`, async () => {
        const { h, controller } = startHarness(action.api);
        const label = h.t(action.labelKey);
        const btn = byLabel(h.content, label);
        assert.ok(btn, "action button must render");

        h.click(btn);
        assert.strictEqual(btn.getAttribute("aria-busy"), "true", "pending sets aria-busy");
        assert.strictEqual(btn.disabled, true, "pending disables the button");
        assert.ok(btn.classList.contains("pending"), "pending class applied");

        if (outcome === "reject") controller.reject(new Error("boom"));
        else if (outcome === "error") controller.resolve({ status: "error", message: "boom" });
        else controller.resolve({ status: outcome === "ok" ? "ok" : "cancel" });
        await settle();

        const after = byLabel(h.content, label);
        assert.strictEqual(after.getAttribute("aria-busy"), "false", "the round trip clears aria-busy");
        assert.strictEqual(after.disabled, false, "the button returns to idle");
        assert.strictEqual(after.classList.contains("pending"), false, "pending class removed");
        if (outcome === "ok") {
          assert.ok(h.renderLog.length >= 1, "the success path re-renders the list before clearing pending");
        }
      });
    }
  }

  test("PR #1088 follow-up: a pending action keeps a button whose API is unavailable disabled", () => {
    const h = createHarness({ localThemes: [builtin()] });
    h.window.settingsAPI.importCodexPetZip = () => new Promise(() => {});
    h.window.settingsAPI.refreshCodexPets = () => new Promise(() => {});
    h.mount();

    const refreshBtn = byLabel(h.content, h.t("themeRefreshImportedPets"));
    assert.strictEqual(refreshBtn.disabled, false, "the button starts available");

    // The availability axis must be re-evaluated on every patch, not frozen at
    // build time, so a button that loses its API goes disabled.
    delete h.window.settingsAPI.refreshCodexPets;
    h.click(byLabel(h.content, h.t("themeImportPetZip")));
    assert.strictEqual(refreshBtn.disabled, true, "patching re-checks the other button's availability");
  });
});

// ── 3. Focus restoration across structural row rebuilds ───────────────────
describe("official row focus restoration", () => {
  function focusHarness() {
    return createHarness({
      localThemes: [builtin()],
      officialThemes: [official("hash-sage"), official("whale-chan")],
      operation: { id: "hash-sage", phase: "downloading", receivedBytes: 10, totalBytes: 100 },
    });
  }

  test("PR #1088 follow-up: a phase flip restores focus to the equivalent button", () => {
    const h = focusHarness();
    h.mount();
    const before = cardButton(h, "hash-sage", ".theme-official-showcase-btn");
    before.focus();
    assert.ok(h.document.activeElement === before);

    h.progress({ id: "hash-sage", phase: "extracting", receivedBytes: 100, totalBytes: 100 });

    const after = cardButton(h, "hash-sage", ".theme-official-showcase-btn");
    assert.ok(after !== before, "the row was rebuilt");
    assert.ok(h.document.activeElement === after, "focus moved to the new equivalent button");
  });

  test("PR #1088 follow-up: focus outside the rebuilt row is left untouched", () => {
    const h = focusHarness();
    h.mount();
    const other = cardButton(h, "whale-chan", ".theme-official-showcase-btn");
    other.focus();

    h.progress({ id: "hash-sage", phase: "extracting", receivedBytes: 100, totalBytes: 100 });

    assert.ok(h.document.activeElement === other, "focus outside the row must not be stolen");
  });

  test("PR #1088 follow-up: focus whose button disappears falls back to body", () => {
    const h = focusHarness();
    h.mount();
    const cancel = cardButton(h, "hash-sage", ".theme-official-cancel-btn");
    cancel.focus();
    assert.ok(h.document.activeElement === cancel);

    h.progress({ id: "hash-sage", phase: "installing", receivedBytes: 100, totalBytes: 100 });

    assert.ok(h.document.activeElement === h.document.body, "the vanished Cancel button leaves focus on body");
    assert.ok(
      h.card("hash-sage").querySelector(".theme-official-cancel-btn") === null,
      "install phase no longer renders Cancel",
    );
  });
});

// ── 4. Customization detail view ──────────────────────────────────────────
describe("theme customization detail view", () => {
  test("PR #1088 follow-up: progress events do not rebuild the detail view", () => {
    const h = createHarness({
      localThemes: [builtin(), customTheme()],
      officialThemes: [official("hash-sage")],
      operation: { id: "hash-sage", phase: "downloading", receivedBytes: 10, totalBytes: 100 },
    });
    h.mount();

    h.click(byLabel(h.content, `${h.t("themeCustomize")} \u203a`));
    const hero = h.content.querySelector(".theme-detail-hero");
    assert.ok(hero, "the customization detail view is mounted");
    h.renderLog.length = 0;

    h.progress({ id: "hash-sage", phase: "extracting", receivedBytes: 100, totalBytes: 100 });

    assert.deepStrictEqual(h.renderLog, [], "progress must not request a full content render");
    assert.ok(h.content.querySelector(".theme-detail-hero") === hero, "detail DOM nodes are left in place");
  });
});

// ── 5. Re-fetch after a re-opened Settings page ───────────────────────────
describe("official progress end-of-operation refresh", () => {
  test("PR #1088 follow-up: a stale per-card snapshot is refreshed once after the operation ends", async () => {
    const snapshot = { phase: "downloading", receivedBytes: 25, totalBytes: 100 };
    const h = createHarness({
      localThemes: [builtin()],
      officialThemes: [
        official("hash-sage", "available", { officialThemeProgress: snapshot }),
        official("whale-chan"),
      ],
    });
    h.mount();
    const installedOfficial = official("hash-sage", "installed");
    h.setListOfficialThemes(() => ({
      status: "ok",
      catalogStatus: "ok",
      themes: [installedOfficial, official("whale-chan")],
    }));
    h.setListThemes(() => [builtin(), { id: "hash-sage", name: "hash-sage", active: false, builtin: false }]);
    const before = h.listThemesCalls;

    for (const phase of ["downloading", "extracting", "installing"]) {
      h.progress({ id: "hash-sage", phase, receivedBytes: 100, totalBytes: 100 });
    }
    h.progress({ id: null, phase: "idle", receivedBytes: 0, totalBytes: 0 });
    await settle();

    assert.strictEqual(h.listThemesCalls - before, 1, "the ended operation refreshes the list exactly once");
    const restored = h.card("hash-sage");
    assert.ok(restored, "the card is still mounted");
    assert.ok(restored.querySelector(".theme-official-progress") === null, "the stale progress bar is gone");
    assert.ok(restored.querySelector(".theme-uninstall-btn"), "the card now shows the installed state");

    h.progress({ id: null, phase: "idle", receivedBytes: 0, totalBytes: 0 });
    await settle();
    assert.strictEqual(h.listThemesCalls - before, 1, "the duplicate idle must not trigger a second refresh");
  });

  test("PR #1088 follow-up: an in-page install does not get an extra ui-core refresh on idle", async () => {
    const h = createHarness({
      localThemes: [builtin()],
      officialThemes: [official("hash-sage")],
      pendingThemeId: "hash-sage",
      operation: { id: "hash-sage", phase: "installing", receivedBytes: 100, totalBytes: 100 },
    });
    h.mount();
    const before = h.listThemesCalls;

    h.progress({ id: null, phase: "idle", receivedBytes: 0, totalBytes: 0 });
    // Let any (wrongly) scheduled refresh actually issue its IPC before checking.
    await settle();

    assert.strictEqual(h.listThemesCalls - before, 0, "the install handler owns the refresh for in-page installs");
  });

  test("PR #1088 follow-up: an idle off the Theme tab still refreshes the data without redrawing", async () => {
    const h = createHarness({
      activeTab: "general",
      localThemes: [builtin()],
      officialThemes: [official("hash-sage", "available", {
        officialThemeProgress: { phase: "downloading", receivedBytes: 25, totalBytes: 100 },
      })],
      operation: { id: "hash-sage", phase: "installing", receivedBytes: 100, totalBytes: 100 },
    });
    const before = h.listThemesCalls;

    h.progress({ id: null, phase: "idle", receivedBytes: 0, totalBytes: 0 });
    await settle();

    assert.strictEqual(h.listThemesCalls - before, 1, "the data is refreshed even off the Theme tab");
    assert.deepStrictEqual(h.renderLog, [], "but the Theme tab is not redrawn while inactive");
  });
});

// ── 6. List-data fingerprint gate ─────────────────────────────────────────
describe("official list data key", () => {
  const changes = [
    ["officialThemeBytes", (h) => { h.core.runtime.officialThemeList[0].officialThemeBytes = 9 * 1024 * 1024; }],
    ["a new official card", (h) => { h.core.runtime.officialThemeList.push(official("third")); }],
    ["selection", (h) => { h.core.runtime.themeList.push({ id: "hash-sage", name: "hash-sage", active: true, builtin: false }); }],
    ["offline catalog", (h) => { h.core.runtime.officialThemeCatalogStatus = "offline"; }],
    ["available -> installed", (h) => { h.core.runtime.officialThemeList[0].officialThemeState = "installed"; }],
  ];

  for (const [name, change] of changes) {
    test(`PR #1088 follow-up: patch bails when list data changes (${name})`, () => {
      const h = createHarness({ localThemes: [builtin()] });
      h.mount();
      change(h);
      assert.strictEqual(h.patch(), false, "a data change must force a full render");
    });
  }

  test("PR #1088 follow-up: patch still applies when only the progress changes", () => {
    const h = createHarness({ localThemes: [builtin()] });
    h.mount();
    h.core.runtime.officialThemeOperation = {
      id: "hash-sage",
      phase: "downloading",
      receivedBytes: 10,
      totalBytes: 100,
    };
    assert.strictEqual(h.patch(), true, "progress-only changes stay patchable");
  });

  test("PR #1088 follow-up: the localized downloading label tracks the real percentage", () => {
    const h = createHarness({
      localThemes: [builtin()],
      operation: { id: "hash-sage", phase: "downloading", receivedBytes: 10, totalBytes: 100 },
    });
    h.mount();
    const card = h.card("hash-sage");
    assert.strictEqual(card.querySelector(".theme-official-note").textContent, "Downloading\u2026 10%");

    h.core.runtime.officialThemeOperation = {
      id: "hash-sage",
      phase: "downloading",
      receivedBytes: 50,
      totalBytes: 100,
    };
    assert.strictEqual(h.patch(), true);
    assert.strictEqual(card.querySelector(".theme-official-note").textContent, "Downloading\u2026 50%");
  });

  test("PR #1088 follow-up: patch bails when a local theme is added", () => {
    const h = createHarness({ localThemes: [builtin()] });
    h.mount();
    h.core.runtime.themeList = [builtin(), { id: "user", name: "user", builtin: false, active: false }];
    assert.strictEqual(h.patch(), false, "a new local card needs a full render");
  });

  test("PR #1088 follow-up: patch bails when a local theme's selection changes", () => {
    const h = createHarness({
      localThemes: [builtin(), { id: "user", name: "user", builtin: false, active: false }],
    });
    h.mount();
    h.core.runtime.themeList[1].active = true;
    assert.strictEqual(h.patch(), false, "a local selection change needs a full render");
  });
});

// ── 7. Terminal refresh freshness and snapshot trust ──────────────────────
describe("official terminal refresh freshness", () => {
  const idle = { id: null, phase: "idle", receivedBytes: 0, totalBytes: 0 };

  test("PR #1088 follow-up: terminal refresh gets a read newer than a hanging pre-idle request", async () => {
    const stale = official("a", "available", {
      officialThemeProgress: { id: "a", phase: "downloading", receivedBytes: 25, totalBytes: 100 },
    });
    const h = createHarness({
      localThemes: [builtin()],
      officialThemes: [stale, official("b")],
      operation: { id: "a", phase: "installing", receivedBytes: 100, totalBytes: 100 },
    });
    const hanging = deferred();
    let requests = 0;
    h.setListOfficialThemes(() => {
      requests += 1;
      return requests === 1
        ? hanging.promise
        : { status: "ok", catalogStatus: "ok", themes: [official("a", "installed"), official("b")] };
    });
    h.mount();

    h.core.ops.fetchThemes();
    await settle();
    assert.strictEqual(h.listOfficialThemesCalls, 1, "the first read is still hanging");

    h.progress(idle);
    h.progress(idle);
    hanging.resolve({ status: "ok", catalogStatus: "ok", themes: [stale, official("b")] });
    await settle();

    assert.strictEqual(h.listOfficialThemesCalls, 2, "a fresh read is issued after the stale one settles");
    const card = h.card("a");
    assert.ok(card.querySelector(".theme-official-progress") === null, "the stale progress bar is gone");
    assert.ok(card.querySelector(".theme-uninstall-btn"), "card a shows the installed state");
  });

  test("PR #1088 follow-up: an in-page install's refresh waits out a hanging read", async () => {
    const h = createHarness({
      localThemes: [builtin()],
      officialThemes: [official("a"), official("b")],
    });
    const hanging = deferred();
    let requests = 0;
    h.setListOfficialThemes(() => {
      requests += 1;
      return requests === 1
        ? hanging.promise
        : { status: "ok", catalogStatus: "ok", themes: [official("a", "installed"), official("b")] };
    });
    let resolveInstall;
    h.window.settingsAPI.installOfficialTheme = () => new Promise((resolve) => { resolveInstall = resolve; });
    h.mount();
    h.click(cardButton(h, "a", ".theme-official-download-btn"));
    h.core.ops.fetchThemes();
    await settle();
    assert.strictEqual(h.listOfficialThemesCalls, 1, "the pre-install read is hanging");

    resolveInstall({ status: "ok" });
    await settle();
    assert.strictEqual(h.listOfficialThemesCalls, 1, "the .finally refresh waits for the hanging read");

    hanging.resolve({
      status: "ok",
      catalogStatus: "ok",
      themes: [
        official("a", "available", {
          officialThemeProgress: { id: "a", phase: "downloading", receivedBytes: 25, totalBytes: 100 },
        }),
        official("b"),
      ],
    });
    await settle();

    assert.strictEqual(h.listOfficialThemesCalls, 2, "a fresh terminal read follows the hanging one");
    const card = h.card("a");
    assert.ok(card.querySelector(".theme-official-progress") === null, "no stale progress bar");
    assert.ok(card.querySelector(".theme-uninstall-btn"), "card a shows the installed state");
  });

  test("PR #1088 follow-up: back-to-back idles share one refresh and one completion render", async () => {
    function build(idleCount) {
      const h = createHarness({
        localThemes: [builtin()],
        officialThemes: [
          official("a", "available", {
            officialThemeProgress: { id: "a", phase: "downloading", receivedBytes: 25, totalBytes: 100 },
          }),
          official("b"),
        ],
        operation: { id: "a", phase: "installing", receivedBytes: 100, totalBytes: 100 },
      });
      const local = deferred();
      const remote = deferred();
      h.setListThemes(() => local.promise);
      h.setListOfficialThemes(() => remote.promise);
      h.mount();
      for (let i = 0; i < idleCount; i += 1) h.progress(idle);
      return { h, local, remote };
    }
    const one = build(1);
    const two = build(2);
    await flush();
    assert.deepStrictEqual(
      { local: one.h.listThemesCalls, official: one.h.listOfficialThemesCalls, renders: one.h.renderLog.length },
      { local: two.h.listThemesCalls, official: two.h.listOfficialThemesCalls, renders: two.h.renderLog.length },
      "the duplicate idle adds no IPC or render",
    );

    one.local.resolve([builtin()]);
    two.local.resolve([builtin()]);
    await flush();
    one.remote.resolve({ status: "ok", catalogStatus: "ok", themes: [official("a", "installed"), official("b")] });
    two.remote.resolve({ status: "ok", catalogStatus: "ok", themes: [official("a", "installed"), official("b")] });
    await settle();

    assert.deepStrictEqual(
      { local: one.h.listThemesCalls, official: one.h.listOfficialThemesCalls, renders: one.h.renderLog.length },
      { local: two.h.listThemesCalls, official: two.h.listOfficialThemesCalls, renders: two.h.renderLog.length },
      "one and two idles settle identically",
    );
  });

  for (const phase of ["downloading", "extracting", "installing"]) {
    test(`PR #1088 follow-up: a ${phase} snapshot alone grays out neighboring buttons`, () => {
      const h = createHarness({
        localThemes: [builtin()],
        officialThemes: [
          official("a", "available", {
            officialThemeProgress: { id: "a", phase, receivedBytes: 25, totalBytes: 100 },
          }),
          official("b"),
          official("c", "error", { officialThemeError: { message: "failed" } }),
        ],
      });
      h.mount();
      assert.ok(cardButton(h, "b", ".theme-official-download-btn").disabled, "b download is disabled");
      assert.ok(cardButton(h, "c", ".theme-official-retry-btn").disabled, "c retry is disabled");
    });
  }

  test("PR #1088 follow-up: an ended operation hides the stale snapshot before the new list lands", async () => {
    const stale = official("a", "available", {
      officialThemeProgress: { id: "a", phase: "installing", receivedBytes: 100, totalBytes: 100 },
    });
    const h = createHarness({ localThemes: [builtin()], officialThemes: [stale, official("b")] });
    const remote = deferred();
    h.setListOfficialThemes(() => remote.promise);
    h.mount();

    h.progress(idle);
    assert.ok(h.card("a").querySelector(".theme-official-progress") === null, "the old progress is hidden immediately");
    assert.ok(
      cardButton(h, "b", ".theme-official-download-btn").disabled,
      "the neighbor stays disabled while the refresh is in flight",
    );

    remote.resolve({ status: "ok", catalogStatus: "ok", themes: [official("a", "installed"), official("b")] });
    await settle();
    assert.ok(
      cardButton(h, "b", ".theme-official-download-btn").disabled === false,
      "the neighbor recovers once the fresh list lands",
    );
  });

  test("PR #1088 follow-up: the terminal refresh is shared while it is in flight", async () => {
    const h = createHarness({ localThemes: [builtin()], officialThemes: [official("a"), official("b")] });
    const remote = deferred();
    h.setListOfficialThemes(() => remote.promise);
    h.mount();

    const first = h.core.ops.refreshThemesAfterOfficialOperation();
    const second = h.core.ops.refreshThemesAfterOfficialOperation();
    await flush();

    assert.ok(first === second, "the second caller reuses the in-flight refresh");
    assert.strictEqual(h.listOfficialThemesCalls, 1, "only one official read is issued");

    remote.resolve({ status: "ok", catalogStatus: "ok", themes: [official("a"), official("b")] });
    await settle();
  });

  test("PR #1088 follow-up: a successful terminal read restores snapshot trust", async () => {
    const snapshot = { id: "a", phase: "installing", receivedBytes: 100, totalBytes: 100 };
    const h = createHarness({
      localThemes: [builtin()],
      officialThemes: [official("a", "available", { officialThemeProgress: snapshot }), official("b")],
      operation: { id: "a", phase: "installing", receivedBytes: 100, totalBytes: 100 },
    });
    h.mount();

    h.progress(idle);
    await settle();

    // The replacement read still reports a live snapshot, so it is trusted again
    // and keeps the neighbor disabled.
    assert.ok(
      cardButton(h, "b", ".theme-official-download-btn").disabled,
      "a snapshot from a post-operation read is trusted again",
    );
  });

  test("PR #1088 follow-up: an idle before the bootstrap list invalidates its live snapshot", async () => {
    const h = createHarness({ localThemes: [builtin()], officialThemes: [] });
    // The page opened after the last progress event: no mirror, no snapshot, and
    // the first official read has not returned yet.
    h.core.runtime.officialThemeList = null;
    h.core.runtime.officialThemeListFetched = false;
    const bootstrap = deferred();
    const terminal = deferred();
    let requests = 0;
    h.setListOfficialThemes(() => (++requests === 1 ? bootstrap.promise : terminal.promise));
    h.mount();
    h.core.ops.fetchThemes();
    await settle();
    assert.strictEqual(h.listOfficialThemesCalls, 1, "the bootstrap read is still hanging");

    h.progress(idle);
    h.progress(idle);

    // The stale bootstrap reply lands with a live installing snapshot.
    bootstrap.resolve({
      status: "ok",
      catalogStatus: "ok",
      themes: [
        official("a", "available", {
          officialThemeProgress: { id: "a", phase: "installing", receivedBytes: 100, totalBytes: 100 },
        }),
        official("b"),
        official("c", "error", { officialThemeError: { message: "failed" } }),
      ],
    });
    await flush();
    await flush();

    assert.strictEqual(h.listOfficialThemesCalls, 2, "a fresh read is issued after the stale bootstrap reply");
    assert.ok(
      h.card("a").querySelector(".theme-official-progress") === null,
      "the stale snapshot is hidden before the fresh read lands",
    );
    assert.ok(
      cardButton(h, "b", ".theme-official-download-btn").disabled,
      "neighbors stay disabled until the fresh read lands",
    );

    terminal.resolve({
      status: "ok",
      catalogStatus: "ok",
      themes: [official("a", "installed"), official("b"), official("c", "error", { officialThemeError: { message: "failed" } })],
    });
    await settle();

    assert.ok(h.card("a").querySelector(".theme-uninstall-btn"), "a shows the installed state");
    assert.ok(h.card("a").querySelector(".theme-official-progress") === null, "a has no progress bar");
    assert.ok(
      cardButton(h, "b", ".theme-official-download-btn").disabled === false,
      "b recovers after the fresh read lands",
    );
    assert.ok(
      cardButton(h, "c", ".theme-official-retry-btn").disabled === false,
      "c recovers after the fresh read lands",
    );
  });

  test("PR #1088 follow-up: a late duplicate idle does not untrust the fresh terminal read", async () => {
    const h = createHarness({
      localThemes: [builtin()],
      officialThemes: [
        official("a", "available", {
          officialThemeProgress: { id: "a", phase: "installing", receivedBytes: 100, totalBytes: 100 },
        }),
        official("b"),
      ],
    });
    const terminal = deferred();
    h.setListOfficialThemes(() => terminal.promise);
    h.mount();

    h.progress(idle);
    await flush();
    await flush();
    assert.strictEqual(h.listOfficialThemesCalls, 1, "the terminal read has been issued");

    // The second idle arrives only after the terminal read is already in flight.
    h.progress(idle);
    terminal.resolve({ status: "ok", catalogStatus: "ok", themes: [official("a", "installed"), official("b")] });
    await settle();

    assert.ok(h.core.ops.officialProgressSnapshotsTrusted(), "the fresh read is trusted");
    assert.strictEqual(h.core.runtime.officialThemeEndCount, 1, "the late idle is not another observed end");
    assert.strictEqual(h.core.runtime.officialThemeListEndCount, 1, "the terminal read records the end");
  });

  test("PR #1088 follow-up: a kept old list after a terminal refresh does not re-trust its snapshot", async () => {
    const stale = official("a", "available", {
      officialThemeProgress: { id: "a", phase: "downloading", receivedBytes: 25, totalBytes: 100 },
    });
    const h = createHarness({
      localThemes: [builtin()],
      officialThemes: [stale, official("b")],
      operation: { id: "a", phase: "installing", receivedBytes: 100, totalBytes: 100 },
    });
    // An error result with no themes keeps the previous list instead of
    // replacing it, so the cached snapshot must stay untrusted.
    h.setListOfficialThemes(() => ({ status: "error", themes: [] }));
    h.mount();

    h.progress(idle);
    await settle();

    assert.ok(h.card("a").querySelector(".theme-official-progress") === null, "the kept stale snapshot is not shown");
    assert.ok(
      cardButton(h, "b", ".theme-official-download-btn").disabled === false,
      "keeping the old list must not leave neighbors disabled",
    );
  });

  test("PR #1088 follow-up: the terminal refresh waits for the official read, not just the local one", async () => {
    const stale = official("a", "available", {
      officialThemeProgress: { id: "a", phase: "downloading", receivedBytes: 25, totalBytes: 100 },
    });
    const h = createHarness({
      localThemes: [builtin()],
      officialThemes: [stale, official("b")],
      operation: { id: "a", phase: "installing", receivedBytes: 100, totalBytes: 100 },
    });
    const remote = deferred();
    h.setListOfficialThemes(() => remote.promise);
    h.mount();

    h.progress(idle);
    await flush();
    await flush();
    const renders = h.renderLog.length;

    assert.ok(h.core.runtime.officialThemeEndRefresh, "the refresh is still in flight");
    assert.ok(
      cardButton(h, "b", ".theme-official-download-btn").disabled,
      "neighbors stay disabled while the official read is pending",
    );
    assert.strictEqual(h.renderLog.length, renders, "no completion render before the official read lands");

    remote.resolve({ status: "ok", catalogStatus: "ok", themes: [official("a", "installed"), official("b")] });
    await settle();

    assert.ok(h.card("a").querySelector(".theme-uninstall-btn"), "a shows the installed state");
    assert.ok(
      cardButton(h, "b", ".theme-official-download-btn").disabled === false,
      "neighbors recover after the official read lands",
    );
  });

  test("PR #1088 follow-up: a failed terminal refresh drops the stale snapshot without leaving buttons grey", async () => {
    const stale = official("a", "available", {
      officialThemeProgress: { id: "a", phase: "downloading", receivedBytes: 25, totalBytes: 100 },
    });
    const h = createHarness({
      localThemes: [builtin()],
      officialThemes: [stale, official("b")],
      operation: { id: "a", phase: "installing", receivedBytes: 100, totalBytes: 100 },
    });
    h.setListOfficialThemes(() => Promise.reject(new Error("offline")));
    h.mount();

    h.progress(idle);
    await settle();

    assert.ok(h.card("a").querySelector(".theme-official-progress") === null, "no stale progress bar");
    assert.ok(
      cardButton(h, "b", ".theme-official-download-btn").disabled === false,
      "neighbor buttons recover after a failed refresh",
    );
  });

  test("PR #1088 follow-up: a late-arriving local card forces a rebuild on the next progress event", async () => {
    const h = createHarness({
      activeTab: "animOverrides",
      localThemes: [builtin()],
      officialThemes: [official("hash-sage"), official("whale-chan")],
    });
    const local = deferred();
    h.setListThemes(() => local.promise);
    h.core.ops.fetchThemes();
    await settle();

    h.core.ops.selectTab("theme");
    assert.strictEqual(h.cards().length, 3, "the tab mounts the old local list");

    local.resolve([builtin(), { id: "user", name: "user", builtin: false, active: false }]);
    await settle();
    h.renderLog.length = 0;

    h.progress({ id: "hash-sage", phase: "downloading", receivedBytes: 25, totalBytes: 100 });

    assert.strictEqual(h.renderLog.length, 1, "the local change forces a full rebuild");
    assert.strictEqual(h.cards().length, 4, "the new local card appears");
  });
});
