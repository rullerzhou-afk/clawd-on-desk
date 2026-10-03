"use strict";

(function initSettingsTabProductivity(root) {
  let core;
  let mounted;
  const view = {
    quota: null, quotaDirty: false, quiet: null, quietDirty: false,
    editor: null, pending: new Set(), launching: new Set(), refs: {},
  };
  const MODES = ["folder", "terminal", "claude", "codex"];

  function t(key) {
    return root.ClawdProductivityI18n.getProductivityStrings((core.state.snapshot || {}).lang)[key] || key;
  }
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function notify(key, error, detail) {
    core.ops.showToast(t(key) + (detail ? ` ${detail}` : ""), { error: !!error });
  }
  function bookmarks() {
    const list = (core.state.snapshot || {}).projectBookmarks;
    return Array.isArray(list) ? list : [];
  }
  function syncDrafts() {
    const snapshot = core.state.snapshot || {};
    if (!view.quota || !view.quotaDirty) view.quota = {
      enabled: snapshot.quotaAlertsEnabled === true,
      thresholds: (Array.isArray(snapshot.quotaAlertThresholds) ? snapshot.quotaAlertThresholds : [20, 10]).join(", "),
      recovery: snapshot.quotaRecoveryAlertsEnabled !== false,
    };
    if (!view.quiet || !view.quietDirty) {
      const saved = snapshot.quietHours || {};
      view.quiet = { enabled: saved.enabled === true, days: [...(saved.days || [1, 2, 3, 4, 5])],
        start: saved.start || "22:00", end: saved.end || "08:00", hidePet: saved.hidePet === true };
    }
  }
  function button(key, action, id) {
    const el = core.helpers.buildButton({ label: t(key) });
    el.type = "button";
    if (id) el.id = id;
    el.addEventListener("click", action);
    return el;
  }
  function field(labelKey, input, id) {
    const label = node("label", "prod-field");
    label.appendChild(node("span", "row-label", t(labelKey)));
    input.id = id;
    label.htmlFor = id;
    label.appendChild(input);
    return label;
  }
  function checkbox(labelKey, checked, onChange, id) {
    const label = node("label", "prod-check");
    const input = node("input");
    input.type = "checkbox";
    input.checked = checked;
    input.id = id;
    label.htmlFor = id;
    input.addEventListener("change", () => onChange(input.checked));
    label.appendChild(input);
    label.appendChild(node("span", "row-label", t(labelKey)));
    return { label, input };
  }
  function input(type, value) {
    const el = node("input", "prod-input");
    el.type = type;
    el.value = value;
    return el;
  }
  function markQuota() { view.quotaDirty = true; }
  function markQuiet() { view.quietDirty = true; }
  function syncControls() {
    syncDrafts();
    const r = view.refs;
    if (r.testNotification) r.testNotification.disabled = view.pending.has("notification");
    if (r.quotaEnabled) {
      r.quotaEnabled.checked = view.quota.enabled;
      if (!view.quotaDirty) r.thresholds.value = view.quota.thresholds;
      r.recovery.checked = view.quota.recovery;
      for (const el of r.quotaControls) el.disabled = view.pending.has("quota");
      core.helpers.setButtonState(r.quotaSave, { label: t(view.pending.has("quota") ? "saving" : "save"), pending: view.pending.has("quota") });
    }
    if (r.quietEnabled) {
      r.quietEnabled.checked = view.quiet.enabled;
      if (!view.quietDirty) { r.start.value = view.quiet.start; r.end.value = view.quiet.end; }
      r.hidePet.checked = view.quiet.hidePet;
      for (const [day, el] of r.days) el.checked = view.quiet.days.includes(day);
      for (const el of r.quietControls) el.disabled = view.pending.has("quiet");
      core.helpers.setButtonState(r.quietSave, { label: t(view.pending.has("quiet") ? "saving" : "save"), pending: view.pending.has("quiet") });
    }
    if (r.addProject) r.addProject.disabled = !!view.editor || view.pending.has("projects") || bookmarks().length >= 32;
    if (r.projectSave) {
      const busy = view.pending.has("projects") || view.pending.has("choose");
      for (const el of r.projectControls) el.disabled = busy;
      core.helpers.setButtonState(r.projectSave, { label: t(view.pending.has("projects") ? "saving" : "save"), pending: busy });
    }
  }
  async function persist(section, patch, onSuccess) {
    if (view.pending.has(section)) return false;
    view.pending.add(section);
    syncControls();
    if (section === "projects") renderProjectList();
    try {
      const api = window.settingsAPI;
      const keys = Object.keys(patch);
      if (!api || (keys.length > 1 ? typeof api.applyBulk !== "function" : typeof api.update !== "function")) {
        throw new Error(t("unavailable"));
      }
      const result = keys.length > 1 ? await api.applyBulk(patch) : await api.update(keys[0], patch[keys[0]]);
      if (!result || result.status !== "ok") throw new Error((result && result.message) || t("saveFailed"));
      const snapshot = result.snapshot || (typeof api.getSnapshot === "function" ? await api.getSnapshot() : null);
      if (!snapshot) throw new Error(t("saveFailed"));
      core.ops.applyChanges({ snapshot, changes: patch });
      onSuccess();
      notify("saved");
      return true;
    } catch (err) {
      notify("saveFailed", true, err && err.message);
      return false;
    } finally {
      view.pending.delete(section);
      syncControls();
      if (section === "projects") renderProjectList();
    }
  }
  function saveQuota() {
    const pieces = view.quota.thresholds.trim().split(/[,，\s]+/u);
    const values = pieces.map((piece) => /^\d{1,2}$/u.test(piece) ? Number(piece) : NaN);
    if (values.length < 1 || values.length > 5 || values.some((n) => !Number.isInteger(n) || n < 1 || n > 99)
      || new Set(values).size !== values.length) { notify("invalidThresholds", true); return; }
    return persist("quota", { quotaAlertsEnabled: view.quota.enabled,
      quotaAlertThresholds: values.sort((a, b) => b - a), quotaRecoveryAlertsEnabled: view.quota.recovery }, () => {
      view.quotaDirty = false;
      view.quota = null;
    });
  }
  async function testNotification() {
    if (view.pending.has("notification")) return;
    view.pending.add("notification");
    const control = view.refs.testNotification;
    control.disabled = true;
    try {
      const result = await window.settingsAPI?.productivity?.testNotification?.();
      notify(result?.ok === true ? "notificationTestSent" : "notificationTestFailed", result?.ok !== true);
    } catch { notify("notificationTestFailed", true); }
    finally { view.pending.delete("notification"); syncControls(); }
  }
  function saveQuiet() {
    const q = view.quiet;
    if (!q.days.length || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(q.start)
      || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(q.end) || q.start === q.end) { notify("invalidQuiet", true); return; }
    return persist("quiet", { quietHours: { ...q, days: [...q.days].sort((a, b) => a - b) } }, () => {
      view.quietDirty = false;
      view.quiet = null;
    });
  }
  function renderQuota(parent) {
    const panel = node("div", "row prod-panel");
    panel.appendChild(node("p", "row-desc", t("quotaDescription")));
    const enabled = checkbox("quotaEnabled", view.quota.enabled, (value) => { view.quota.enabled = value; markQuota(); }, "productivity-quota-enabled");
    const thresholds = input("text", view.quota.thresholds);
    thresholds.inputMode = "numeric";
    thresholds.maxLength = 24;
    thresholds.setAttribute("aria-describedby", "productivity-threshold-help");
    thresholds.addEventListener("input", () => { view.quota.thresholds = thresholds.value; markQuota(); });
    const recovery = checkbox("quotaRecovery", view.quota.recovery, (value) => { view.quota.recovery = value; markQuota(); }, "productivity-quota-recovery");
    panel.appendChild(enabled.label);
    panel.appendChild(field("quotaThresholds", thresholds, "productivity-quota-thresholds"));
    const help = node("p", "row-desc", t("quotaThresholdHelp"));
    help.id = "productivity-threshold-help";
    panel.appendChild(help);
    panel.appendChild(recovery.label);
    panel.appendChild(node("p", "row-desc", t("quotaCollectionHelp")));
    const save = button("save", saveQuota, "productivity-quota-save");
    panel.appendChild(save);
    const test = button("notificationTest", testNotification, "productivity-notification-test");
    test.disabled = view.pending.has("notification");
    panel.appendChild(test);
    Object.assign(view.refs, { quotaEnabled: enabled.input, thresholds, recovery: recovery.input, quotaSave: save,
      testNotification: test,
      quotaControls: [enabled.input, thresholds, recovery.input] });
    parent.appendChild(core.helpers.buildSection(t("quotaTitle"), [panel]));
  }
  function renderQuiet(parent) {
    const panel = node("div", "row prod-panel");
    const enabled = checkbox("quietEnabled", view.quiet.enabled, (value) => { view.quiet.enabled = value; markQuiet(); }, "productivity-quiet-enabled");
    panel.appendChild(enabled.label);
    panel.appendChild(node("p", "row-desc", t("quietHelp")));
    const daysField = node("fieldset", "prod-days");
    daysField.appendChild(node("legend", "row-label", t("quietDays")));
    const days = new Map();
    for (const day of [1, 2, 3, 4, 5, 6, 0]) {
      const label = node("label", "prod-day");
      const check = input("checkbox", "");
      check.checked = view.quiet.days.includes(day);
      check.id = `productivity-day-${day}`;
      check.addEventListener("change", () => {
        view.quiet.days = check.checked ? [...new Set([...view.quiet.days, day])] : view.quiet.days.filter((d) => d !== day);
        markQuiet();
      });
      label.appendChild(check);
      label.appendChild(node("span", null, t("dayNames")[day]));
      daysField.appendChild(label);
      days.set(day, check);
    }
    panel.appendChild(daysField);
    const times = node("div", "prod-time-grid");
    const start = input("time", view.quiet.start);
    const end = input("time", view.quiet.end);
    start.addEventListener("input", () => { view.quiet.start = start.value; markQuiet(); });
    end.addEventListener("input", () => { view.quiet.end = end.value; markQuiet(); });
    times.appendChild(field("quietStart", start, "productivity-quiet-start"));
    times.appendChild(field("quietEnd", end, "productivity-quiet-end"));
    panel.appendChild(times);
    const hide = checkbox("quietHide", view.quiet.hidePet, (value) => { view.quiet.hidePet = value; markQuiet(); }, "productivity-quiet-hide");
    panel.appendChild(hide.label);
    const save = button("save", saveQuiet, "productivity-quiet-save");
    panel.appendChild(save);
    Object.assign(view.refs, { quietEnabled: enabled.input, days, start, end, hidePet: hide.input, quietSave: save,
      quietControls: [enabled.input, ...days.values(), start, end, hide.input] });
    parent.appendChild(core.helpers.buildSection(t("quietTitle"), [panel]));
  }
  function makeEditor(project) {
    if (view.editor || view.pending.has("projects")) return;
    if (!project && bookmarks().length >= 32) { notify("limitProjects", true); return; }
    view.editor = project ? { ...project, editing: true } : {
      id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      name: "", cwd: "", launchMode: "folder", editing: false,
    };
    renderEditor();
    renderProjectList();
    syncControls();
    if (view.refs.projectName) view.refs.projectName.focus();
  }
  async function chooseDirectory() {
    if (view.pending.has("choose") || !view.editor) return;
    const editor = view.editor;
    view.pending.add("choose");
    syncControls();
    try {
      const api = window.settingsAPI && window.settingsAPI.productivity;
      if (!api || typeof api.chooseProjectDirectory !== "function") throw new Error(t("unavailable"));
      const result = await api.chooseProjectDirectory();
      if (editor !== view.editor || (result && result.status === "cancelled")) return;
      if (!result || result.status !== "ok" || typeof result.cwd !== "string" || !result.cwd) throw new Error((result && result.message) || t("chooseFailed"));
      editor.cwd = result.cwd;
      if (!editor.name) editor.name = result.cwd.split(/[\\/]/u).filter(Boolean).at(-1) || "";
      view.refs.projectFolder.value = editor.cwd;
      view.refs.projectName.value = editor.name;
    } catch (err) { notify("chooseFailed", true, err && err.message); }
    finally { view.pending.delete("choose"); syncControls(); }
  }
  function saveProject() {
    const editor = view.editor;
    if (!editor || view.pending.has("choose")) return;
    const item = { id: editor.id, name: editor.name.trim(), cwd: editor.cwd, launchMode: editor.launchMode };
    if (!item.name || item.name.length > 80 || !item.cwd || !MODES.includes(item.launchMode)) { notify("invalidProject", true); return; }
    const list = bookmarks().map((entry) => ({ ...entry }));
    const index = list.findIndex((entry) => entry.id === item.id);
    if (editor.editing && index < 0) { notify("missingProject", true); return; }
    if (index < 0) {
      if (list.length >= 32) { notify("limitProjects", true); return; }
      list.push(item);
    } else list[index] = item;
    return persist("projects", { projectBookmarks: list }, () => {
      view.editor = null;
      renderEditor();
      renderProjectList();
    });
  }
  function removeProject(id) {
    if (view.editor || view.pending.has("projects")) return;
    return persist("projects", { projectBookmarks: bookmarks().filter((entry) => entry.id !== id) }, renderProjectList);
  }
  async function launchProject(id) {
    if (view.launching.has(id)) return;
    view.launching.add(id);
    renderProjectList();
    try {
      const api = window.settingsAPI && window.settingsAPI.productivity;
      if (!api || typeof api.launchProject !== "function") throw new Error(t("unavailable"));
      const result = await api.launchProject(id);
      if (result && result.ok === false && result.code === "CANCELLED") return;
      if (!result || result.ok !== true) throw new Error((result && result.message) || t("launchFailed"));
    } catch (err) { notify("launchFailed", true, err && err.message); }
    finally { view.launching.delete(id); renderProjectList(); }
  }
  function renderProjectList() {
    const parent = view.refs.projectList;
    if (!parent) return;
    parent.textContent = "";
    if (!bookmarks().length) parent.appendChild(node("p", "row-desc prod-empty", t("emptyProjects")));
    for (const project of bookmarks()) {
      const row = node("div", "prod-project");
      const details = node("div", "prod-project-info");
      details.appendChild(node("strong", "row-label", project.name));
      details.appendChild(node("div", "row-desc prod-path", project.cwd));
      details.appendChild(node("div", "row-desc", t(`mode${project.launchMode[0].toUpperCase()}${project.launchMode.slice(1)}`)));
      row.appendChild(details);
      const actions = node("div", "prod-actions");
      const open = button(view.launching.has(project.id) ? "opening" : "open", () => launchProject(project.id), `productivity-open-${project.id}`);
      open.disabled = view.launching.has(project.id);
      open.setAttribute("aria-busy", view.launching.has(project.id) ? "true" : "false");
      const edit = button("edit", () => makeEditor(project), `productivity-edit-${project.id}`);
      const remove = button("delete", () => removeProject(project.id), `productivity-delete-${project.id}`);
      edit.disabled = remove.disabled = !!view.editor || view.pending.has("projects");
      for (const el of [open, edit, remove]) actions.appendChild(el);
      row.appendChild(actions);
      parent.appendChild(row);
    }
  }
  function renderEditor() {
    const parent = view.refs.editorHost;
    if (!parent) return;
    parent.textContent = "";
    for (const key of ["projectSave", "projectName", "projectFolder", "projectControls"]) delete view.refs[key];
    if (!view.editor) return;
    const editor = view.editor;
    const form = node("div", "prod-editor");
    const name = input("text", editor.name);
    name.maxLength = 80;
    name.addEventListener("input", () => { editor.name = name.value; });
    form.appendChild(field("projectName", name, "productivity-project-name"));
    const folder = input("text", editor.cwd);
    folder.readOnly = true;
    const folderField = field("projectFolder", folder, "productivity-project-folder");
    const choose = button("chooseFolder", chooseDirectory, "productivity-choose-folder");
    folderField.appendChild(choose);
    form.appendChild(folderField);
    const mode = node("select", "prod-input");
    for (const value of MODES) {
      const option = node("option", null, t(`mode${value[0].toUpperCase()}${value.slice(1)}`));
      option.value = value;
      mode.appendChild(option);
    }
    mode.value = editor.launchMode;
    mode.addEventListener("change", () => { editor.launchMode = mode.value; });
    form.appendChild(field("launchMode", mode, "productivity-project-mode"));
    const actions = node("div", "prod-actions");
    const save = button("save", saveProject, "productivity-project-save");
    const cancel = button("cancel", () => {
      if (view.pending.has("projects") || view.pending.has("choose")) return;
      view.editor = null;
      renderEditor(); renderProjectList(); syncControls();
    }, "productivity-project-cancel");
    actions.appendChild(save); actions.appendChild(cancel); form.appendChild(actions);
    parent.appendChild(form);
    Object.assign(view.refs, { projectName: name, projectFolder: folder, projectSave: save,
      projectControls: [name, folder, choose, mode, cancel] });
  }
  function renderProjects(parent) {
    const panel = node("div", "row prod-panel");
    panel.appendChild(node("p", "row-desc", t("projectDescription")));
    const add = button("addProject", () => makeEditor(), "productivity-add-project");
    panel.appendChild(add);
    const editorHost = node("div", "prod-editor-host");
    const list = node("div", "prod-project-list");
    panel.appendChild(editorHost); panel.appendChild(list);
    Object.assign(view.refs, { addProject: add, editorHost, projectList: list });
    parent.appendChild(core.helpers.buildSection(t("projectTitle"), [panel]));
    renderEditor(); renderProjectList();
  }
  function render(parent) {
    syncDrafts();
    view.refs = {};
    mounted = node("div", "productivity-tab");
    mounted.appendChild(node("h1", null, t("title")));
    mounted.appendChild(node("p", "subtitle", t("subtitle")));
    renderQuota(mounted); renderQuiet(mounted); renderProjects(mounted);
    parent.appendChild(mounted);
    syncControls();
  }
  function patchInPlace(changes, snapshots = {}) {
    if (!mounted || mounted.isConnected === false || (changes && "lang" in changes)
      || (snapshots.previousSnapshot && snapshots.snapshot && snapshots.previousSnapshot.lang !== snapshots.snapshot.lang)) return false;
    syncControls();
    if (!changes || "projectBookmarks" in changes) renderProjectList();
    return true;
  }
  function init(nextCore) {
    core = nextCore;
    core.tabs.productivity = { render, patchInPlace };
  }
  root.ClawdSettingsTabProductivity = { init };
})(globalThis);
