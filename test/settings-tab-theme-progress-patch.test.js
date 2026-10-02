"use strict";

// Regression for the theme-list hover flicker during an official theme
// download: progress events used to trigger a full content re-render, which
// tore down every theme card (dropping the CSS :hover highlight the cursor was
// sitting on) many times per second. The theme tab now patches its progress
// rows in place and ui-core skips the full render when it does.

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_DIR = path.join(__dirname, "..", "src");

// ── Minimal DOM ───────────────────────────────────────────────────────────
// Enough of the element API for the theme list render path and the in-place
// progress patch. Elements keep a parent/child tree so a test can assert
// whether a node survived (identity) or was replaced.
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this._text = "";
    this.style = {};
    this.attributes = {};
    this.dataset = {};
    this._classList = new Set();
    this.listeners = new Map();
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
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = String(value);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
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

  // Depth-first search honouring class selectors only (".foo").
  querySelector(selector) {
    const match = (el) => selector.startsWith(".")
      && el._classList.has(selector.slice(1));
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

function createDom() {
  const document = {
    createElement: (tag) => new FakeElement(tag),
    getElementById: () => null,
    body: new FakeElement("body"),
  };
  return { document, FakeElement };
}

// ── Tab harness ───────────────────────────────────────────────────────────
function createThemeTab({
  themeList = [],
  officialThemeList = [],
  activeTab = "theme",
  officialThemeOperation = null,
} = {}) {
  const code = fs.readFileSync(path.join(SRC_DIR, "settings-tab-theme.js"), "utf8");
  const dom = createDom();
  const renderCalls = [];
  const state = { activeTab };
  const runtime = {
    themeList,
    officialThemeList,
    officialThemeOperation,
    officialThemePendingThemeId: null,
    officialThemeListFetched: true,
    officialThemeCatalogStatus: "ok",
  };
  const core = {
    state,
    runtime,
    helpers: {
      t: (key) => key,
      escapeHtml: (value) => String(value),
      attachActivation: (el, invoke) => el.addEventListener("click", invoke),
      buildButton: (opts = {}) => {
        const el = new dom.FakeElement("button");
        if (opts.labelKey) el.textContent = opts.labelKey;
        return el;
      },
      // Minimal stand-in for the shared core helper; the real implementation
      // (including aria-busy) is covered by the follow-up suite.
      setButtonState: (btn, patch = {}) => {
        btn.disabled = patch.disabled === true || patch.pending === true;
        if (patch.pending === true) btn.classList.add("pending");
        else if (patch.pending === false) btn.classList.remove("pending");
        return btn;
      },
      buildSwitch: () => new dom.FakeElement("div"),
      buildSettingsSelect: () => new dom.FakeElement("div"),
      openExternalSafe: () => {},
    },
    ops: {
      requestRender: (opts) => renderCalls.push(opts),
      fetchThemes: () => Promise.resolve(runtime.themeList),
      showToast: () => {},
      focusSettingsTarget: () => {},
      // Snapshots are trusted in this fake harness; the real gating is covered
      // by the follow-up suite.
      officialProgressSnapshotsTrusted: () => true,
      refreshThemesAfterOfficialOperation: () => Promise.resolve(),
    },
    readers: { getLang: () => "en" },
    tabs: {},
  };
  const sandbox = { ...dom, console, window: { settingsAPI: {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  sandbox.ClawdSettingsTabTheme.init(core);

  return {
    tab: core.tabs.theme,
    state,
    runtime,
    renderCalls,
    window: sandbox.window,
    document: dom.document,
    render() {
      const parent = dom.document.createElement("div");
      this.tab.render(parent);
      return parent;
    },
  };
}

function officialTheme(overrides = {}) {
  return {
    id: "official:demo",
    name: "Demo Pet",
    active: false,
    builtin: false,
    officialTheme: true,
    officialThemeState: "available",
    officialThemeBytes: 2 * 1024 * 1024,
    officialThemeVersion: "1.0.0",
    ...overrides,
  };
}

describe("theme tab official-download progress patching", () => {
  test("exposes patchOfficialThemeProgress on the registered tab", () => {
    const h = createThemeTab();
    assert.strictEqual(typeof h.tab.patchOfficialThemeProgress, "function");
  });

  test("returns false when no official row is mounted (caller falls back)", () => {
    const h = createThemeTab();
    assert.strictEqual(h.tab.patchOfficialThemeProgress(), false);
  });

  test("progress ticks update the bar in place without rebuilding the card", () => {
    const h = createThemeTab({
      themeList: [{ id: "clawd", name: "Clawd", active: true, builtin: true }],
      officialThemeList: [officialTheme()],
      officialThemeOperation: {
        id: "official:demo",
        phase: "downloading",
        receivedBytes: 0,
        totalBytes: 1000,
      },
    });
    const root = h.render();

    const card = root.querySelector(".theme-card");
    assert.ok(card, "card must render");
    const progress = root.querySelector(".theme-official-progress");
    const inner = root.querySelector(".theme-official-progress-bar");
    assert.ok(progress && inner, "progress bar must render while busy");

    // A stream of progress ticks: the DOM must NOT be replaced.
    for (const received of [100, 250, 500, 900]) {
      h.runtime.officialThemeOperation = {
        id: "official:demo",
        phase: "downloading",
        receivedBytes: received,
        totalBytes: 1000,
      };
      assert.strictEqual(h.tab.patchOfficialThemeProgress(), true, `tick ${received} patches`);
    }

    assert.strictEqual(
      root.querySelector(".theme-official-progress-bar"),
      inner,
      "the progress bar element must survive progress ticks (hover highlight stays)",
    );
    assert.strictEqual(
      root.querySelector(".theme-card"),
      card,
      "the card element must survive progress ticks",
    );
    assert.strictEqual(inner.style.width, "90%");
    assert.strictEqual(progress.getAttribute("aria-valuenow"), "90");
    assert.deepStrictEqual(h.renderCalls, [], "no full re-render was requested");
  });

  test("a phase flip rebuilds only the official row, not the card", () => {
    const h = createThemeTab({
      themeList: [{ id: "clawd", name: "Clawd", active: true, builtin: true }],
      officialThemeList: [officialTheme()],
      officialThemeOperation: {
        id: "official:demo",
        phase: "downloading",
        receivedBytes: 500,
        totalBytes: 1000,
      },
    });
    const root = h.render();
    const card = root.querySelector(".theme-card");
    const container = root.querySelector(".theme-official-controls");
    const before = root.querySelector(".theme-official-progress");

    h.runtime.officialThemeOperation = {
      id: "official:demo",
      phase: "installing",
      receivedBytes: 1000,
      totalBytes: 1000,
    };
    assert.strictEqual(h.tab.patchOfficialThemeProgress(), true);

    assert.strictEqual(root.querySelector(".theme-card"), card, "card survives");
    assert.strictEqual(
      root.querySelector(".theme-official-controls"),
      container,
      "the row container survives a phase flip",
    );
    assert.notStrictEqual(
      root.querySelector(".theme-official-progress"),
      before,
      "the progress bar itself is rebuilt for the new phase",
    );
    assert.deepStrictEqual(h.renderCalls, []);
  });

  test("returns false when the themed row's theme left the list (fallback to full render)", () => {
    const h = createThemeTab({
      themeList: [{ id: "clawd", name: "Clawd", active: true, builtin: true }],
      officialThemeList: [officialTheme()],
      officialThemeOperation: { id: "official:demo", phase: "downloading", receivedBytes: 1, totalBytes: 10 },
    });
    h.render();

    h.runtime.officialThemeList = [];
    assert.strictEqual(
      h.tab.patchOfficialThemeProgress(),
      false,
      "a list that no longer contains the row must force a full render",
    );
  });

  test("non-official cards are not registered and never patched", () => {
    const h = createThemeTab({
      themeList: [
        { id: "clawd", name: "Clawd", active: true, builtin: true },
        { id: "user:custom", name: "Custom", active: false, builtin: false },
      ],
      officialThemeOperation: { id: "official:demo", phase: "downloading", receivedBytes: 1, totalBytes: 10 },
    });
    h.render();
    assert.strictEqual(
      h.tab.patchOfficialThemeProgress(),
      false,
      "no official rows mounted -> nothing to patch",
    );
  });

  test("progress patch keeps a hovered non-active card's element identity", () => {
    // The reported symptom: hovering any non-active card while a download runs.
    const h = createThemeTab({
      themeList: [{ id: "clawd", name: "Clawd", active: true, builtin: true }],
      officialThemeList: [officialTheme()],
      officialThemeOperation: { id: "official:demo", phase: "downloading", receivedBytes: 0, totalBytes: 1000 },
    });
    const root = h.render();

    const cards = root.children
      .filter((child) => child.className === "theme-section")
      .flatMap((section) => section.children)
      .filter((child) => child.className === "theme-grid")
      .flatMap((grid) => grid.children);
    const hovered = cards.find((card) => card.getAttribute("aria-checked") === "false");
    assert.ok(hovered, "there must be a non-active card to hover");

    for (const received of [10, 200, 640, 999]) {
      h.runtime.officialThemeOperation = {
        id: "official:demo",
        phase: "downloading",
        receivedBytes: received,
        totalBytes: 1000,
      };
      h.tab.patchOfficialThemeProgress();
    }

    const cardsAfter = root.children
      .filter((child) => child.className === "theme-section")
      .flatMap((section) => section.children)
      .filter((child) => child.className === "theme-grid")
      .flatMap((grid) => grid.children);
    assert.ok(
      cardsAfter.includes(hovered),
      "the hovered card element must still be the same node after progress ticks",
    );
  });
});

// ── settings-ui-core: the progress entry point prefers the tab hook ────────
function createUiCore() {
  const dom = createDom();
  const sandbox = {
    document: dom.document,
    console,
    window: {},
    navigator: { userAgent: "node-test", platform: "win32", language: "en" },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb) => cb(),
  };
  sandbox.globalThis = sandbox;
  for (const file of ["settings-i18n.js", "settings-size-slider.js", "settings-ui-core.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(SRC_DIR, file), "utf8"), sandbox);
  }
  return sandbox;
}

describe("settings-ui-core official progress dispatch", () => {
  test("uses the tab hook and skips the full content render when it applies", () => {
    const sandbox = createUiCore();
    const core = sandbox.ClawdSettingsCore;
    const renders = [];
    core.renderHooks.content = () => renders.push("content");
    core.state.activeTab = "theme";
    let hookCalls = 0;
    core.tabs.theme = {
      patchOfficialThemeProgress: () => {
        hookCalls += 1;
        return true;
      },
    };

    core.ops.applyOfficialThemeProgress({
      id: "official:demo",
      phase: "downloading",
      receivedBytes: 512,
      totalBytes: 1024,
    });

    assert.equal(hookCalls, 1, "the tab hook is consulted");
    assert.deepStrictEqual(renders, [], "no full content render when the tab patched in place");
    assert.equal(core.runtime.officialThemeOperation.id, "official:demo");
  });

  test("falls back to a full content render when the tab cannot patch", () => {
    const sandbox = createUiCore();
    const core = sandbox.ClawdSettingsCore;
    const renders = [];
    core.renderHooks.content = () => renders.push("content");
    core.state.activeTab = "theme";
    core.tabs.theme = { patchOfficialThemeProgress: () => false };

    core.ops.applyOfficialThemeProgress({
      id: "official:demo",
      phase: "downloading",
      receivedBytes: 512,
      totalBytes: 1024,
    });

    assert.deepStrictEqual(renders, ["content"], "unpatchable progress still renders");
  });

  test("falls back when the tab exposes no hook at all", () => {
    const sandbox = createUiCore();
    const core = sandbox.ClawdSettingsCore;
    const renders = [];
    core.renderHooks.content = () => renders.push("content");
    core.state.activeTab = "theme";
    core.tabs.theme = {};

    core.ops.applyOfficialThemeProgress({
      id: "official:demo",
      phase: "extracting",
      receivedBytes: 1024,
      totalBytes: 1024,
    });

    assert.deepStrictEqual(renders, ["content"]);
  });

  test("does nothing while another tab is active", () => {
    const sandbox = createUiCore();
    const core = sandbox.ClawdSettingsCore;
    const renders = [];
    core.renderHooks.content = () => renders.push("content");
    core.state.activeTab = "general";
    core.tabs.theme = { patchOfficialThemeProgress: () => { throw new Error("must not be called"); } };

    core.ops.applyOfficialThemeProgress({
      id: "official:demo",
      phase: "downloading",
      receivedBytes: 1,
      totalBytes: 10,
    });

    assert.deepStrictEqual(renders, []);
  });
});

// ── pending flags patch the action buttons in place ───────────────────────
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

function findButtonByLabel(root, label) {
  const visit = (el) => {
    if (el.tagName === "button" && el.textContent === label) return el;
    for (const child of el.children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(root);
}

describe("theme tab pending-state patching", () => {
  test("starting a pet-zip import patches the import button, not the list", async () => {
    const h = createThemeTab({
      themeList: [{ id: "clawd", name: "Clawd", active: true, builtin: true }],
    });
    const root = h.render();
    const card = root.querySelector(".theme-card");
    let settleImport;
    h.window.settingsAPI.importCodexPetZip = () => new Promise((resolve) => { settleImport = resolve; });

    const importBtn = findButtonByLabel(root, "themeImportPetZip");
    assert.ok(importBtn, "import button must render");
    importBtn.listeners.get("click")();

    assert.deepStrictEqual(h.renderCalls, [], "starting the import must not re-render the list");
    assert.strictEqual(importBtn.disabled, true, "the import button goes pending");
    assert.ok(importBtn.classList.contains("pending"), "pending class applied");
    assert.strictEqual(root.querySelector(".theme-card"), card, "the card survived");

    settleImport({ status: "cancel" });
    await flushMicrotasks();
    assert.deepStrictEqual(h.renderCalls, [], "a cancelled import must not re-render either");
    assert.strictEqual(importBtn.disabled, false, "the button returns to idle");
    assert.strictEqual(importBtn.classList.contains("pending"), false);
  });

  test("refresh-all patches its button in place on both edges", async () => {
    const h = createThemeTab({
      themeList: [{ id: "clawd", name: "Clawd", active: true, builtin: true }],
    });
    const root = h.render();
    h.runtime.petsRefreshSettled = false;
    let settleRefresh;
    h.window.settingsAPI.refreshCodexPets = () => new Promise((resolve) => { settleRefresh = resolve; });

    const refreshBtn = findButtonByLabel(root, "themeRefreshImportedPets");
    assert.ok(refreshBtn);
    refreshBtn.listeners.get("click")();

    assert.deepStrictEqual(h.renderCalls, [], "starting the refresh must not re-render");
    assert.ok(refreshBtn.classList.contains("pending"));

    settleRefresh({ status: "error", message: "boom" });
    await flushMicrotasks();
    assert.strictEqual(refreshBtn.classList.contains("pending"), false);
  });

  test("user-theme zip import patches its button in place", () => {
    const h = createThemeTab({
      themeList: [{ id: "clawd", name: "Clawd", active: true, builtin: true }],
    });
    const root = h.render();
    h.window.settingsAPI.importUserThemeZip = () => new Promise(() => {});

    const importThemeBtn = findButtonByLabel(root, "themeImportUserThemeZip");
    assert.ok(importThemeBtn);
    importThemeBtn.listeners.get("click")();

    assert.deepStrictEqual(h.renderCalls, []);
    assert.strictEqual(importThemeBtn.disabled, true);
    assert.ok(importThemeBtn.classList.contains("pending"));
  });

  test("with no mounted list the handlers fall back to a full render", () => {
    // simulate the tab not being mounted: no render() ran, so no handles
    const h = createThemeTab({
      themeList: [{ id: "clawd", name: "Clawd", active: true, builtin: true }],
    });
    h.window.settingsAPI.importCodexPetZip = () => new Promise(() => {});
    // reach the handler through a rendered button, then detach the handles the
    // way switching tabs does
    const root = h.render();
    const importBtn = findButtonByLabel(root, "themeImportPetZip");
    h.tab.onExit();
    importBtn.listeners.get("click")();

    // vm-realm objects: compare fields, not prototypes.
    assert.strictEqual(h.renderCalls.length, 1, "one fallback render");
    assert.strictEqual(h.renderCalls[0].content, true);
  });
});
