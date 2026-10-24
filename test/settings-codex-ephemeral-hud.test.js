"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const prefs = require("../src/prefs");
const { createSettingsController } = require("../src/settings-controller");

const KEY = "sessionHudHideCompletedCodexEphemeral";
const LABEL = "rowSessionHudHideCompletedCodexEphemeral";
const DESC = `${LABEL}Desc`;

test("completed temporary Codex HUD preference defaults off and persists only boolean controller updates", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-ephemeral-hud-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prefsPath = path.join(dir, "prefs.json");
  const controller = createSettingsController({ prefsPath });
  assert.equal(controller.get(KEY), false);
  for (const value of [true, false]) {
    assert.equal((await controller.applyUpdate(KEY, value)).status, "ok");
    assert.equal(createSettingsController({ prefsPath }).get(KEY), value);
  }
  for (const value of ["true", 1, null, {}, []]) {
    assert.equal((await controller.applyUpdate(KEY, value)).status, "error");
    assert.equal(controller.get(KEY), false);
    assert.equal(prefs.load(prefsPath).snapshot[KEY], false);
  }
});

test("older preferences and malformed opt-in values keep completed temporary Codex rows visible", () => {
  const defaults = prefs.getDefaults();
  for (const value of [undefined, "true", 1, null]) {
    const input = { ...defaults };
    if (value === undefined) delete input[KEY];
    else input[KEY] = value;
    assert.equal(prefs.validate(input)[KEY], false);
  }
});

// A DOM surface for the real tab module; helper controls model only their public
// mount/setState contract so linkage tests do not depend on Electron or a window.
class Element {
  constructor() {
    this.children = [];
    this.style = {};
    this.classList = { add() {} };
  }
  append(...children) {
    for (const child of children) this.appendChild(child);
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  contains(child) { return child === this || this.children.some((node) => node.contains(child)); }
  addEventListener() {}
  setAttribute() {}
}

function createSessionsHarness(hudEnabled) {
  const body = new Element();
  const sections = [];
  const configs = new Map();
  const state = {
    snapshot: { ...prefs.getDefaults(), sessionHudEnabled: hudEnabled },
    mountedControls: {
      generalSwitches: new Map(),
      settingsSelects: new Set(),
      sessionCleanupControls: new Map(),
    },
    transientUiState: { generalSwitches: new Map() },
  };
  const makeControl = () => ({ element: new Element(), setValue() {}, setDisabled() {}, dispose() {} });
  const helpers = {
    t: (key) => key,
    buildSwitchRow(config) {
      const element = new Element();
      const visual = { disabled: !!config.disabled, checked: !!state.snapshot[config.key] };
      configs.set(config.key, config);
      state.mountedControls.generalSwitches.set(config.key, {
        element, visual, control: { setState: (next) => Object.assign(visual, next) },
      });
      return element;
    },
    buildButton: () => new Element(),
    buildSegmentedRadio: makeControl,
    buildSettingsSelect: makeControl,
    buildNumberInputRow: () => ({ row: new Element() }),
    buildCollapsibleGroup: () => new Element(),
    buildSection(title, rows) {
      const element = new Element();
      element.append(...rows);
      sections.push({ title, element });
      return element;
    },
  };
  const core = {
    state, helpers, ops: {}, tabs: {}, i18n: {},
    readers: { readGeneralSwitchVisual: (key) => state.snapshot[key] === true },
  };
  const context = vm.createContext({ document: { body, createElement: () => new Element() }, window: {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/settings-tab-sessions.js"), "utf8"), context);
  context.ClawdSettingsTabSessions.init(core);
  core.tabs.sessions.render(body);
  return { core, body, sections, configs };
}

test("temporary Codex completion switch is a HUD child and patches both directions without touching quota", () => {
  const { core, sections, configs } = createSessionsHarness(false);
  const meta = core.state.mountedControls.generalSwitches.get(KEY);
  const hud = sections.find((section) => section.title === "sectionSessionHud");
  assert.equal(hud.element.contains(meta.element), true);
  assert.equal(configs.get(KEY).labelKey, LABEL);
  assert.equal(configs.get(KEY).descKey, DESC);
  assert.equal(meta.visual.disabled, true);
  const quota = core.state.mountedControls.generalSwitches.get("sessionHudShowQuota");
  for (const enabled of [true, false]) {
    core.state.snapshot.sessionHudEnabled = enabled;
    assert.equal(core.tabs.sessions.patchInPlace({ sessionHudEnabled: enabled }), true);
    assert.equal(meta.visual.disabled, !enabled);
    assert.equal(quota.visual.disabled, false);
  }
  for (const enabled of [true, false]) {
    core.state.snapshot[KEY] = enabled;
    core.state.transientUiState.generalSwitches.set(KEY, { pending: true });
    assert.equal(core.tabs.sessions.patchInPlace({ [KEY]: enabled }), true);
    assert.equal(meta.visual.checked, enabled);
    assert.equal(meta.visual.pending, false);
    assert.equal(core.state.transientUiState.generalSwitches.has(KEY), false);
    assert.equal(core.state.mountedControls.generalSwitches.get(KEY), meta);
  }
  assert.equal(core.tabs.sessions.patchInPlace({ soundMuted: true }), false);
});

test("unmounted temporary Codex switch requests a full rerender rather than a partial master patch", () => {
  const { core } = createSessionsHarness(true);
  core.state.mountedControls.generalSwitches.delete(KEY);
  assert.equal(core.tabs.sessions.patchInPlace({ sessionHudEnabled: false }), false);
  assert.equal(core.tabs.sessions.patchInPlace({ [KEY]: true }), false);
});

test("all seven settings locales disclose the completed side-chat tradeoff and Dashboard access", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/settings-i18n.js"), "utf8"), context);
  const strings = context.ClawdSettingsI18n.STRINGS;
  const phrases = {
    en: ["ordinary side chats", "Dashboard"],
    zh: ["普通侧边聊天", "会话面板"],
    "zh-TW": ["一般側邊聊天", "工作階段面板"],
    ko: ["일반 사이드 채팅", "대시보드"],
    ja: ["通常のサイドチャット", "ダッシュボード"],
    "pt-BR": ["chats laterais comuns", "Dashboard"],
    es: ["chats laterales normales", "Dashboard"],
  };
  assert.equal(Object.keys(phrases).length, 7);
  for (const [lang, required] of Object.entries(phrases)) {
    assert.equal(typeof strings[lang][LABEL], "string", lang);
    assert.ok(strings[lang][LABEL].length > 0, lang);
    for (const phrase of required) assert.ok(strings[lang][DESC].includes(phrase), `${lang}: ${phrase}`);
  }
});
