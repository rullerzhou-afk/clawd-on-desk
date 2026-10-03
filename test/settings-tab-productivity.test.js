"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { getProductivityStrings, STRINGS } = require("../src/productivity-strings");

const clone = (value) => JSON.parse(JSON.stringify(value));
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {}; this.style = {}; this.disabled = false; this._text = ""; }
  appendChild(el) { this.children.push(el); el.parentNode = this; return el; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  focus() { this.focused = true; }
  async fire(name, event = {}) { if (this.disabled) return; for (const handler of this.listeners[name] || []) await handler({ target: this, preventDefault() {}, ...event }); }
}
function find(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) { const result = find(child, id); if (result) return result; }
  return null;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(extra = {}) {
  const container = new Element("main");
  let saved = { lang: "en", quotaAlertsEnabled: false, quotaAlertThresholds: [20, 10], quotaRecoveryAlertsEnabled: true,
    quietHours: { enabled: false, days: [1, 2, 3, 4, 5], start: "22:00", end: "08:00", hidePet: false }, projectBookmarks: [], ...extra };
  const calls = { writes: [], choose: 0, launch: [], toasts: [] };
  const api = {
    async getSnapshot() { return clone(saved); },
    async update(key, value) { calls.writes.push({ [key]: clone(value) }); saved = { ...saved, [key]: clone(value) }; return { status: "ok" }; },
    async applyBulk(patch) { calls.writes.push(clone(patch)); saved = { ...saved, ...clone(patch) }; return { status: "ok" }; },
    productivity: {
      async chooseProjectDirectory() { calls.choose += 1; return { status: "ok", cwd: "C:\\work\\My Project" }; },
      async launchProject(id) { calls.launch.push(id); return { ok: true }; },
    },
  };
  const core = {
    state: { snapshot: clone(saved), activeTab: "productivity" }, tabs: {},
    helpers: {
      buildButton({ label }) { const el = new Element("button"); el.textContent = label; return el; },
      setButtonState(el, patch) { if (patch.label) el.textContent = patch.label; el.disabled = patch.pending === true; },
      buildSection(title, rows) { const el = new Element("section"); const heading = new Element("h2"); heading.textContent = title; el.appendChild(heading); rows.forEach((row) => el.appendChild(row)); return el; },
    },
    ops: {
      showToast(message, options) { calls.toasts.push({ message, ...options }); },
      applyChanges(payload) {
        const previousSnapshot = core.state.snapshot;
        core.state.snapshot = payload.snapshot || { ...previousSnapshot, ...payload.changes };
        const patched = core.tabs.productivity.patchInPlace(payload.changes, { previousSnapshot, snapshot: core.state.snapshot });
        if (!patched) { container.textContent = ""; core.tabs.productivity.render(container); }
      },
    },
  };
  const context = { document: { createElement: (tag) => new Element(tag) }, window: { settingsAPI: api }, console, crypto: { randomUUID: () => "new-project-id" } };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["productivity-strings.js", "settings-tab-productivity.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8"), context, { filename: file });
  }
  context.ClawdSettingsTabProductivity.init(core);
  core.tabs.productivity.render(container);
  return { core, api, calls, container,
    el(id) { const el = find(container, id); assert.ok(el, `missing ${id}`); return el; },
    async enter(id, value, name = "input") { const el = this.el(id); el.value = value; await el.fire(name); },
    async check(id, value) { const el = this.el(id); el.checked = value; await el.fire("change"); },
    external(patch) { saved = { ...saved, ...clone(patch) }; core.ops.applyChanges({ snapshot: clone(saved), changes: patch }); },
  };
}

test("productivity strings load through CJS and browser UMD with seven complete localizations", () => {
  assert.equal(Object.keys(STRINGS).length, 7);
  for (const lang of ["en", "zh", "zh-TW", "ko", "ja", "pt-BR", "es"]) {
    const strings = getProductivityStrings(lang);
    assert.deepEqual(Object.keys(strings), Object.keys(STRINGS.en));
    assert.equal(strings.dayNames.length, 7);
    for (const key of ["quotaLowBody", "quotaRecoveredBody"]) {
      for (const token of ["{provider}", "{window}", "{remaining}"]) assert.ok(strings[key].includes(token));
    }
    for (const key of ["quotaWindowHours", "quotaWindowDays", "quotaWindowMinutes"]) assert.ok(strings[key].includes("{n}"));
    assert.ok(harness({ lang }).container.textContent.includes(strings.title));
  }
  assert.equal(getProductivityStrings("unknown"), STRINGS.en);
});

test("the actual settings sidebar localizes productivity and offers keyboard navigation", async () => {
  const sidebar = new Element("nav");
  const selected = [];
  let hooks;
  const core = {
    state: { activeTab: "productivity", snapshot: { lang: "en" } },
    readers: { getLang() { return core.state.snapshot.lang; } },
    helpers: { t: (key) => key, escapeHtml: (value) => value },
    ops: {
      installRenderHooks(value) { hooks = value; },
      restoreNavigationState() {},
      selectTab(tab) { selected.push(tab); },
    },
  };
  const context = { console, window: { settingsAPI: {} }, ClawdSettingsCore: core,
    document: { createElement(tag) { const el = new Element(tag); el.classList = { add() {} }; return el; },
      getElementById(id) { return id === "sidebar" ? sidebar : null; } } };
  for (const name of ["General", "Agents", "Theme", "AnimMap", "AnimOverrides", "Shortcuts", "About"]) {
    context[`ClawdSettingsTab${name}`] = { init() {} };
  }
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["productivity-strings.js", "settings-renderer.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8"), context, { filename: file });
  }
  for (const lang of Object.keys(STRINGS)) {
    core.state.snapshot.lang = lang;
    sidebar.children = [];
    hooks.sidebar();
    const navigation = find(sidebar, "settings-productivity-navigation");
    assert.ok(navigation.innerHTML.includes(STRINGS[lang].sidebarProductivity));
    assert.equal(navigation.tabIndex, 0);
    assert.equal(navigation.attributes.role, "button");
    assert.equal(navigation.attributes["aria-current"], "page");
  }
  const navigation = find(sidebar, "settings-productivity-navigation");
  let prevented = 0;
  for (const key of ["Enter", " ", "ArrowDown"]) {
    await navigation.fire("keydown", { key, preventDefault() { prevented += 1; } });
  }
  assert.deepEqual(selected, ["productivity", "productivity"]);
  assert.equal(prevented, 2);
});

test("quota fields save atomically through the bridge and refresh from controller truth", async () => {
  const h = harness();
  await h.check("productivity-quota-enabled", true);
  await h.check("productivity-quota-recovery", false);
  await h.enter("productivity-quota-thresholds", "10, 25");
  await h.el("productivity-quota-save").fire("click");
  assert.deepEqual(h.calls.writes, [{ quotaAlertsEnabled: true, quotaAlertThresholds: [25, 10], quotaRecoveryAlertsEnabled: false }]);
  assert.equal(h.el("productivity-quota-thresholds").value, "25, 10");
  assert.equal(h.calls.toasts.at(-1).message, "Saved");
});

test("invalid or duplicate thresholds never reach the settings controller", async () => {
  const h = harness();
  for (const value of ["", "0, 20", "100", "20, 20", "3.5", "1, 2, 3, 4, 5, 6", "20,"]) {
    await h.enter("productivity-quota-thresholds", value);
    await h.el("productivity-quota-save").fire("click");
  }
  assert.equal(h.calls.writes.length, 0);
  assert.ok(h.calls.toasts.every((toast) => toast.error));
});

test("server-normalized snapshots replace a successful draft rather than echoing the submitted value", async () => {
  const h = harness();
  h.api.applyBulk = async () => ({ status: "ok", snapshot: {
    ...h.core.state.snapshot, quotaAlertsEnabled: true, quotaAlertThresholds: [18, 9],
  } });
  await h.enter("productivity-quota-thresholds", "20, 10");
  await h.el("productivity-quota-save").fire("click");
  assert.equal(h.el("productivity-quota-thresholds").value, "18, 9");
  assert.equal(h.el("productivity-quota-enabled").checked, true);
});

test("unrelated snapshots retain the actual focused input and unsaved draft", async () => {
  const h = harness();
  const field = h.el("productivity-quota-thresholds");
  field.focus();
  await h.enter(field.id, "30, 12");
  h.external({ size: 2 });
  assert.equal(h.el(field.id), field);
  assert.equal(field.value, "30, 12");
  assert.equal(field.focused, true);
  h.external({ lang: "zh" });
  assert.equal(h.el(field.id).value, "30, 12");
  assert.ok(h.container.textContent.includes("效率工具"));
});

test("failed saves preserve the draft and re-enable controls", async () => {
  const h = harness();
  h.api.applyBulk = async () => ({ status: "error", message: "fixture failure" });
  await h.enter("productivity-quota-thresholds", "33, 12");
  await h.el("productivity-quota-save").fire("click");
  assert.equal(h.el("productivity-quota-thresholds").value, "33, 12");
  assert.equal(h.el("productivity-quota-save").disabled, false);
  assert.equal(h.core.state.snapshot.quotaAlertsEnabled, false);
  assert.equal(h.calls.toasts.at(-1).error, true);
});

test("quiet hours save selected start days and an overnight local-time interval", async () => {
  const h = harness();
  await h.check("productivity-quiet-enabled", true);
  await h.check("productivity-day-0", true);
  await h.check("productivity-day-1", false);
  await h.enter("productivity-quiet-start", "23:30");
  await h.enter("productivity-quiet-end", "07:15");
  await h.check("productivity-quiet-hide", true);
  await h.el("productivity-quiet-save").fire("click");
  assert.deepEqual(h.calls.writes[0], { quietHours: { enabled: true, days: [0, 2, 3, 4, 5], start: "23:30", end: "07:15", hidePet: true } });
  assert.ok(h.container.textContent.includes("Approvals return to the agent’s native interface"));
  assert.ok(h.container.textContent.includes("pauses the current scheduled period"));
});

test("quiet hours reject equal times or no start days without a write", async () => {
  const h = harness();
  await h.enter("productivity-quiet-end", "22:00");
  await h.el("productivity-quiet-save").fire("click");
  await h.enter("productivity-quiet-end", "08:00");
  for (const day of [1, 2, 3, 4, 5]) await h.check(`productivity-day-${day}`, false);
  await h.el("productivity-quiet-save").fire("click");
  assert.equal(h.calls.writes.length, 0);
});

test("a project is added through native folder selection without launching on save", async () => {
  const h = harness();
  await h.el("productivity-add-project").fire("click");
  assert.equal(h.el("productivity-project-folder").readOnly, true);
  await h.el("productivity-choose-folder").fire("click");
  assert.equal(h.calls.choose, 1);
  assert.equal(h.el("productivity-project-name").value, "My Project");
  await h.enter("productivity-project-mode", "codex", "change");
  await h.el("productivity-project-save").fire("click");
  assert.deepEqual(h.calls.writes[0], { projectBookmarks: [{ id: "new-project-id", name: "My Project", cwd: "C:\\work\\My Project", launchMode: "codex" }] });
  assert.equal(h.calls.launch.length, 0);
  await h.el("productivity-open-new-project-id").fire("click");
  assert.deepEqual(h.calls.launch, ["new-project-id"]);
});

test("cancelled native selection leaves the editor intact and does not save", async () => {
  const h = harness();
  h.api.productivity.chooseProjectDirectory = async () => ({ status: "cancelled" });
  await h.el("productivity-add-project").fire("click");
  await h.enter("productivity-project-name", "Keep my draft");
  await h.el("productivity-choose-folder").fire("click");
  assert.equal(h.el("productivity-project-name").value, "Keep my draft");
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.toasts.length, 0);
});

test("pending native folder selection cannot be duplicated or discard an editor", async () => {
  const h = harness();
  const wait = deferred();
  h.api.productivity.chooseProjectDirectory = async () => { h.calls.choose += 1; return wait.promise; };
  await h.el("productivity-add-project").fire("click");
  const first = h.el("productivity-choose-folder").fire("click");
  const second = h.el("productivity-choose-folder").fire("click");
  assert.equal(h.calls.choose, 1);
  assert.equal(h.el("productivity-project-cancel").disabled, true);
  wait.resolve({ status: "ok", cwd: "C:\\chosen" });
  await Promise.all([first, second]);
  assert.equal(h.el("productivity-project-folder").value, "C:\\chosen");
  assert.equal(h.el("productivity-project-cancel").disabled, false);
});

test("pending settings writes cannot be double-submitted", async () => {
  const h = harness();
  const wait = deferred();
  h.api.applyBulk = async (patch) => { h.calls.writes.push(clone(patch)); return wait.promise; };
  await h.enter("productivity-quota-thresholds", "28, 14");
  const first = h.el("productivity-quota-save").fire("click");
  const second = h.el("productivity-quota-save").fire("click");
  assert.equal(h.calls.writes.length, 1);
  wait.resolve({ status: "error", message: "fixture rollback" });
  await Promise.all([first, second]);
  assert.equal(h.el("productivity-quota-thresholds").value, "28, 14");
  assert.equal(h.el("productivity-quota-save").disabled, false);
});

test("editing and removing bookmarks keep unrelated external additions", async () => {
  const original = { id: "one", name: "One", cwd: "C:\\one", launchMode: "folder" };
  const added = { id: "two", name: "Two", cwd: "C:\\two", launchMode: "terminal" };
  const h = harness({ projectBookmarks: [original] });
  await h.el("productivity-edit-one").fire("click");
  await h.enter("productivity-project-name", "Edited One");
  const field = h.el("productivity-project-name");
  h.external({ projectBookmarks: [original, added] });
  assert.equal(h.el(field.id), field);
  assert.equal(field.value, "Edited One");
  await h.el("productivity-project-save").fire("click");
  assert.deepEqual(h.core.state.snapshot.projectBookmarks.map((entry) => entry.name), ["Edited One", "Two"]);
  await h.el("productivity-delete-one").fire("click");
  assert.deepEqual(h.core.state.snapshot.projectBookmarks, [added]);
  assert.equal(h.calls.launch.length, 0);
});

test("an editor cannot silently overwrite another unsaved editor or recreate a deleted bookmark", async () => {
  const original = { id: "one", name: "One", cwd: "C:\\one", launchMode: "folder" };
  const h = harness({ projectBookmarks: [original] });
  await h.el("productivity-edit-one").fire("click");
  await h.enter("productivity-project-name", "Unsaved");
  assert.equal(h.el("productivity-add-project").disabled, true);
  h.external({ projectBookmarks: [] });
  await h.el("productivity-project-save").fire("click");
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.el("productivity-project-name").value, "Unsaved");
  assert.equal(h.calls.toasts.at(-1).error, true);
});

test("a double click launches a project only once and errors do not remove it", async () => {
  const h = harness({ projectBookmarks: [{ id: "one", name: "One", cwd: "C:\\one", launchMode: "claude" }] });
  const wait = deferred();
  h.api.productivity.launchProject = async (id) => { h.calls.launch.push(id); return wait.promise; };
  const first = h.el("productivity-open-one").fire("click");
  const second = h.el("productivity-open-one").fire("click");
  assert.deepEqual(h.calls.launch, ["one"]);
  wait.resolve({ ok: false, code: "agent-unavailable", message: "fixture unavailable" });
  await Promise.all([first, second]);
  assert.equal(h.el("productivity-open-one").disabled, false);
  assert.equal(h.core.state.snapshot.projectBookmarks.length, 1);
  assert.equal(h.calls.toasts.at(-1).error, true);
});

test("project limit disables adding and does not truncate stored bookmarks", () => {
  const list = Array.from({ length: 32 }, (_, i) => ({ id: `p-${i}`, name: `Project ${i}`, cwd: `C:\\p${i}`, launchMode: "folder" }));
  const h = harness({ projectBookmarks: list });
  assert.equal(h.el("productivity-add-project").disabled, true);
  assert.equal(h.core.state.snapshot.projectBookmarks.length, 32);
});

test("cancelled project launch quietly re-enables the button", async () => {
  const h = harness({ projectBookmarks: [{ id: "one", name: "One", cwd: "C:\\one", launchMode: "codex" }] });
  h.api.productivity.launchProject = async () => ({ ok: false, code: "CANCELLED" });
  await h.el("productivity-open-one").fire("click");
  assert.equal(h.el("productivity-open-one").disabled, false);
  assert.equal(h.calls.toasts.length, 0);
  assert.equal(h.core.state.snapshot.projectBookmarks.length, 1);
});
test("test notification is single-flight, leaves quota drafts/history alone, and recovers after failure", async () => {
  const h = harness(), pending = deferred(); let calls = 0;
  h.api.productivity.testNotification = () => { calls++; return pending.promise; };
  await h.enter("productivity-quota-thresholds", "25, 5");
  const first = h.el("productivity-notification-test").fire("click");
  await h.el("productivity-notification-test").fire("click");
  assert.equal(calls, 1); pending.resolve({ ok: false }); await first;
  assert.equal(h.el("productivity-notification-test").disabled, false);
  assert.equal(h.calls.toasts.at(-1).error, true);
  assert.equal(h.el("productivity-quota-thresholds").value, "25, 5");
  assert.deepEqual(h.calls.writes, []);
  h.api.productivity.testNotification = async () => ({ ok: true });
  await h.el("productivity-notification-test").fire("click");
  assert.equal(h.calls.toasts.at(-1).error, false);
});

test("settings document loads strings before the tab and uses isolated responsive styles", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "settings.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "settings-productivity.css"), "utf8");
  assert.ok(html.indexOf('src="productivity-strings.js"') < html.indexOf('src="settings-tab-productivity.js"'));
  assert.ok(html.indexOf('src="settings-tab-productivity.js"') < html.indexOf('src="settings-renderer.js"'));
  assert.ok(html.includes('href="settings-productivity.css"'));
  assert.ok(!html.includes("<style>"));
  assert.ok(css.includes(".productivity-tab .prod-time-grid"));
  assert.ok(css.includes("@media (max-width: 600px)"));
});
