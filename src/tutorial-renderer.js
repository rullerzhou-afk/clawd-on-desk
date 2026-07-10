"use strict";

// Renderer for the first-run onboarding tutorial window (tutorial.html). Receives
// a state payload from main (i18n, language list, product icon, detected
// agents, shortcuts), draws a 5-step wizard, and routes selected
// actions back through window.tutorialAPI. No inline scripts (CSP).

(function () {
  const api = window.tutorialAPI || {};

  const STEPS = ["welcome", "agents", "shortcuts", "features", "done"];
  let STATE = {
    i18n: {}, lang: "en", langs: [], heroSrc: "", doneHeroSvg: "", platform: "",
    agents: { install: [], cleanup: [], active: [] }, shortcuts: [],
  };
  let step = 0;
  // agentIds with an in-flight connect/disconnect action, so we can show a
  // scoped busy state and block double-clicks.
  const busy = new Set();
  const selected = { install: new Set(), cleanup: new Set() };
  const knownSelectableIds = { install: new Set(), cleanup: new Set() };
  let agentNotice = null;
  let shortcutRecordingActionId = null;
  let shortcutRecordingPartial = [];
  let shortcutRecordingError = "";
  let shortcutSavingActionId = null;
  let shortcutFeedback = null;

  const shortcutActions = window.ClawdShortcutActions || {};

  // Native language names — never translated, so a user who can't read the
  // current UI language can still find their own.
  const LANG_LABELS = { en: "English", zh: "简体中文", "zh-TW": "繁體中文", ko: "한국어", ja: "日本語" };

  // Fallback mark only used if main couldn't read the icon file.
  const FALLBACK_ICON =
    '<span class="hero-fallback" aria-hidden="true">&lt;&gt;</span>';

  function i18n(key, fallback) {
    const v = STATE.i18n && STATE.i18n[key];
    return (typeof v === "string" && v.length) ? v : fallback;
  }

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    const p = props || {};
    for (const k of Object.keys(p)) {
      const v = p[k];
      if (v == null) continue;
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    return n;
  }

  function agentLabel(a) { return (a && (a.label || a.agentId)) || ""; }

  function normalizeState(s) {
    const out = s && typeof s === "object" ? s : {};
    out.i18n = out.i18n || {};
    out.langs = out.langs || [];
    out.heroSrc = typeof out.heroSrc === "string" ? out.heroSrc : "";
    out.doneHeroSvg = typeof out.doneHeroSvg === "string" ? out.doneHeroSvg : "";
    out.agents = out.agents || { install: [], cleanup: [], active: [] };
    out.agents.install = out.agents.install || [];
    out.agents.cleanup = out.agents.cleanup || [];
    out.agents.active = out.agents.active || [];
    out.shortcuts = out.shortcuts || [];
    return out;
  }

  function setStep(n) {
    step = Math.max(0, Math.min(STEPS.length - 1, n));
    render();
    const body = document.getElementById("body");
    if (body) body.scrollTop = 0;
  }

  function finish() { try { if (api.finish) api.finish(); } catch (_) {} }

  // ── Agent batch actions (selected, immediate, visible) ──
  function reconcileSelection(kind, list) {
    const live = new Set();
    for (const a of list || []) {
      if (!a || !a.agentId) continue;
      live.add(a.agentId);
      // New install recommendations are selected by default. Cleanup is safer
      // as explicit opt-in because detector misses can happen.
      if (!knownSelectableIds[kind].has(a.agentId)) {
        knownSelectableIds[kind].add(a.agentId);
        // Enabling a detected tool is low risk, so preselect it. Cleanup can
        // break an existing integration if detection missed a nonstandard
        // install path, so make the user explicitly opt in.
        if (kind === "install") selected[kind].add(a.agentId);
      }
    }
    for (const id of Array.from(knownSelectableIds[kind])) {
      if (!live.has(id)) knownSelectableIds[kind].delete(id);
    }
    for (const id of Array.from(selected[kind])) {
      if (!live.has(id)) selected[kind].delete(id);
    }
  }

  function selectedIds(kind) {
    const list = kind === "cleanup" ? STATE.agents.cleanup : STATE.agents.install;
    return (list || [])
      .map((a) => a && a.agentId)
      .filter((id) => id && selected[kind].has(id));
  }

  function setAgentNotice(kind, tone, key, fallback, values) {
    let text = i18n(key, fallback);
    const repl = values || {};
    for (const k of Object.keys(repl)) {
      text = text.replace(new RegExp("\\{" + k + "\\}", "g"), String(repl[k]));
    }
    agentNotice = { kind, tone, text };
  }

  async function runAgentBatch(kind) {
    const ids = selectedIds(kind);
    if (!ids.length) {
      setAgentNotice(kind, "warn", "tutorialAgentsSelectNone", "Select at least one item first.");
      render();
      return;
    }
    if (ids.some((id) => busy.has(id))) return;

    agentNotice = null;
    for (const id of ids) busy.add(id);
    render();

    let ok = 0;
    let failed = 0;
    let firstError = "";
    try {
      for (const id of ids) {
        let result = null;
        try {
          result = kind === "cleanup"
            ? (api.uninstallAgent ? await api.uninstallAgent(id) : { status: "error", message: "uninstall not wired" })
            : (api.installAgent ? await api.installAgent(id) : { status: "error", message: "install not wired" });
        } catch (err) {
          result = { status: "error", message: err && err.message };
        }
        if (result && result.status === "ok") {
          ok++;
        } else {
          failed++;
          if (!firstError) firstError = (result && result.message) || "unknown error";
        }
      }
      if (failed > 0) {
        setAgentNotice(kind, "error", "tutorialAgentsActionFailed",
          "Could not update every selected item: {message}", { message: firstError || "unknown error" });
      } else if (kind === "cleanup") {
        setAgentNotice(kind, "ok", "tutorialAgentsCleanupDone",
          "Done. The selected Clawd connections were disconnected.", { count: ok });
      } else {
        setAgentNotice(kind, "ok", "tutorialAgentsInstallDone",
          "Done. Clawd is listening to the selected tools.", { count: ok });
      }
    } finally {
      for (const id of ids) busy.delete(id);
      render();
    }
  }

  // ── Hero art ──
  function heroNode(cls, kind) {
    const wrap = el("div", { class: cls || "hero-art" });
    if (kind === "done" && STATE.doneHeroSvg && STATE.doneHeroSvg.length) {
      wrap.innerHTML = STATE.doneHeroSvg;
    } else if (STATE.heroSrc && STATE.heroSrc.length) {
      wrap.appendChild(el("img", { class: "hero-icon", src: STATE.heroSrc, alt: "" }));
    } else {
      wrap.innerHTML = FALLBACK_ICON;
    }
    return wrap;
  }

  // ── Step renderers ──

  function renderLangPicker() {
    const langs = (STATE.langs && STATE.langs.length) ? STATE.langs : ["en"];
    const row = el("div", { class: "lang-picker" });
    row.appendChild(el("span", { class: "lang-label" }, i18n("tutorialWelcomeLangLabel", "Language")));
    const sel = el("select", {
      class: "lang-select",
      onchange: (e) => { if (api.setLang) api.setLang(e.target.value); },
    });
    for (const code of langs) sel.appendChild(el("option", { value: code }, LANG_LABELS[code] || code));
    sel.value = STATE.lang;
    row.appendChild(sel);
    return row;
  }

  function renderWelcome() {
    const wrap = el("div", { class: "welcome" });
    wrap.appendChild(heroNode("hero-art hero-lg"));
    wrap.appendChild(el("h2", { class: "step-title" }, i18n("tutorialWelcomeTitle", "Welcome to Clawd on Desk")));
    wrap.appendChild(el("p", { class: "step-sub" }, i18n("tutorialWelcomeBody",
      "Clawd follows the AI tools you choose, then reacts on your desktop when they work, wait for approval, or finish.")));
    wrap.appendChild(renderLangPicker());
    return wrap;
  }

  function inlineLink(label, onClick) {
    return el("button", {
      type: "button",
      class: "inline-link",
      onclick: onClick,
    }, label);
  }

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function statusBadge(kind) {
    if (kind === "active") return el("span", { class: "ag-tag ok" }, i18n("tutorialAgentsActiveTag", "On"));
    if (kind === "install") return el("span", { class: "ag-tag info" }, i18n("tutorialAgentsInstallTag", "Found"));
    return el("span", { class: "ag-tag warn" }, i18n("tutorialAgentsCleanupTag", "Tool not found"));
  }

  function rowDesc(kind) {
    if (kind === "active") return i18n("tutorialAgentsActiveRowDesc", "Clawd can listen when this tool sends activity.");
    if (kind === "install") return i18n("tutorialAgentsInstallRowDesc", "Found on this computer. Let Clawd follow its activity.");
    return i18n("tutorialAgentsCleanupRowDesc", "A Clawd connection exists, but the tool was not found.");
  }

  function agentAvatar(a, kind) {
    return el("span", { class: "ag-avatar " + kind }, initials(agentLabel(a)));
  }

  function selectableAgentRow(a, kind) {
    const id = a.agentId;
    const isBusy = busy.has(id);
    const checkbox = el("input", {
      type: "checkbox",
      class: "ag-check",
      checked: selected[kind].has(id) ? "" : null,
      disabled: isBusy ? "" : null,
      onchange: (e) => {
        if (e.target.checked) selected[kind].add(id);
        else selected[kind].delete(id);
        agentNotice = null;
        render();
      },
    });
    const row = el("label", { class: "ag-row selectable " + kind },
      checkbox,
      agentAvatar(a, kind),
      el("span", { class: "ag-main" },
        el("span", { class: "ag-titleline" },
          el("span", { class: "ag-name" }, agentLabel(a)),
          statusBadge(kind)),
        el("span", { class: "ag-desc" }, rowDesc(kind))));
    if (isBusy) row.appendChild(el("span", { class: "ag-row-busy" }, i18n("tutorialWorking", "Working…")));
    return row;
  }

  function activeAgentRow(a) {
    return el("div", { class: "ag-row active" },
      el("span", { class: "ag-ok", html: "&#10003;" }),
      agentAvatar(a, "active"),
      el("span", { class: "ag-main" },
        el("span", { class: "ag-titleline" },
          el("span", { class: "ag-name" }, agentLabel(a)),
          statusBadge("active")),
        el("span", { class: "ag-desc" }, rowDesc("active"))));
  }

  function activeAgentNoticeNode() {
    if (!agentNotice || !agentNotice.text) return null;
    return el("div", { class: "ag-notice " + agentNotice.tone }, agentNotice.text);
  }

  function actionPanel(kind, entries, labelKey, labelFb, descKey, descFb, actionKey, actionFb, busyFb) {
    const count = selectedIds(kind).length;
    const isBusy = entries.some((a) => a && busy.has(a.agentId));
    const panel = el("section", { class: "ag-panel " + kind },
      el("div", { class: "ag-panel-head" },
        el("div", { class: "ag-panel-copy" },
          el("h3", { class: "ag-panel-title" }, i18n(labelKey, labelFb)),
          el("p", { class: "ag-panel-desc" }, i18n(descKey, descFb))),
        el("button", {
          class: "ag-panel-action " + kind,
          disabled: (isBusy || count === 0) ? "" : null,
          onclick: () => runAgentBatch(kind),
        }, isBusy ? busyFb : i18n(actionKey, actionFb))));
    for (const a of entries) panel.appendChild(selectableAgentRow(a, kind));
    return panel;
  }

  function renderAgents() {
    const ag = STATE.agents;
    const wrap = el("div", {});
    wrap.appendChild(el("h2", { class: "step-title" }, i18n("tutorialAgentsTitle", "Let Clawd follow your AI tools")));
    wrap.appendChild(el("p", { class: "step-sub" }, i18n("tutorialAgentsSub",
      "This only changes Clawd's connection. It won't install or remove the tools themselves.")));
    const notice = activeAgentNoticeNode();
    if (notice) wrap.appendChild(notice);

    const hasAny = ag.active.length || ag.install.length || ag.cleanup.length;
    if (!hasAny) {
      wrap.appendChild(el("div", { class: "empty-note" },
        i18n("tutorialAgentsEmpty", "No agents detected yet. You can connect them anytime in Settings → Agents.")));
      wrap.appendChild(el("div", { style: "margin-top:12px" },
        inlineLink(i18n("tutorialAgentsOpenSettings", "Open Settings → Agents"),
          () => api.openSettingsTab && api.openSettingsTab("agents"))));
      return wrap;
    }

    // Actionable recommendations first (enable, then cleanup), confirmation last.
    if (ag.install.length) {
      wrap.appendChild(actionPanel("install", ag.install,
        "tutorialAgentsInstallLabel", "Recommended to enable",
        "tutorialAgentsInstallDesc", "Clawd found these tools on this computer. Select the ones it should follow.",
        "tutorialAgentsInstallAction", "Enable selected",
        i18n("tutorialAgentsInstallingSelected", "Enabling…")));
    }
    if (ag.cleanup.length) {
      wrap.appendChild(actionPanel("cleanup", ag.cleanup,
        "tutorialAgentsCleanupLabel", "Recommended cleanup",
        "tutorialAgentsCleanupDesc", "These Clawd connections still exist, but the tools were not found. Disconnect the ones you no longer use.",
        "tutorialAgentsCleanupAction", "Disconnect selected",
        i18n("tutorialAgentsDisconnectingSelected", "Disconnecting…")));
    }
    if (ag.active.length) {
      const panel = el("section", { class: "ag-panel active" },
        el("div", { class: "ag-panel-head" },
          el("div", { class: "ag-panel-copy" },
            el("h3", { class: "ag-panel-title" }, i18n("tutorialAgentsActiveLabel", "Already on")),
            el("p", { class: "ag-panel-desc" }, i18n("tutorialAgentsActiveDesc", "Clawd is set up to listen to these tools.")))));
      for (const a of ag.active) panel.appendChild(activeAgentRow(a));
      wrap.appendChild(panel);
    }
    return wrap;
  }

  function formatAccel(accel) {
    if (typeof accel !== "string" || !accel) return [];
    return accel.split("+").map((tokenRaw) => {
      const token = tokenRaw.trim();
      if (token === "CommandOrControl" || token === "CmdOrCtrl") return "Ctrl/⌘";
      if (token === "Command" || token === "Cmd" || token === "Meta") return "⌘";
      if (token === "Control" || token === "Ctrl") return "Ctrl";
      if (token === "Alt" || token === "Option") return "Alt";
      return token;
    });
  }

  function isMac() {
    return STATE.platform === "darwin";
  }

  function shortcutMeta(actionId) {
    const actions = shortcutActions.SHORTCUT_ACTIONS || {};
    return actions[actionId] || {};
  }

  function shortcutLabel(actionId, fallback) {
    const meta = shortcutMeta(actionId);
    return i18n(meta.labelKey, fallback || actionId);
  }

  function defaultEditableShortcuts() {
    const ids = ["togglePet", "permissionAllow", "permissionDeny"];
    return ids.map((id) => {
      const meta = shortcutMeta(id);
      return {
        id,
        label: shortcutLabel(id),
        accelerator: meta.defaultAccelerator,
        defaultAccelerator: meta.defaultAccelerator,
        persistent: !!meta.persistent,
      };
    });
  }

  function editableShortcuts() {
    return (STATE.shortcuts && STATE.shortcuts.length)
      ? STATE.shortcuts
      : defaultEditableShortcuts();
  }

  function formatShortcutValue(accelerator) {
    const unassigned = i18n("shortcutUnassigned", "— unassigned —");
    if (shortcutActions.formatAcceleratorLabel) {
      return shortcutActions.formatAcceleratorLabel(accelerator, {
        isMac: isMac(),
        unassignedLabel: unassigned,
      });
    }
    if (!accelerator) return unassigned;
    return formatAccel(accelerator).join("+");
  }

  function translateShortcutError(message) {
    if (!message) return "";
    const conflictMatch = /^conflict: already bound to (.+)$/.exec(message);
    if (conflictMatch) {
      const otherId = conflictMatch[1];
      return i18n("shortcutErrorConflict", "Conflict with {other}. Try another key.")
        .replace("{other}", shortcutLabel(otherId, otherId));
    }
    if (message === "reserved accelerator") {
      return i18n("shortcutErrorReserved", "That shortcut is reserved. Try another key.");
    }
    if (message === "invalid accelerator format") {
      return i18n("shortcutErrorInvalid", "That shortcut is not valid.");
    }
    if (message === "must include modifier") {
      return i18n("shortcutErrorNeedsModifier", "Use at least one modifier key.");
    }
    if (message.includes("unregister of old accelerator failed") || message.includes("system conflict")) {
      return i18n("shortcutErrorSystemConflict", "Already in use by system or another app.");
    }
    return message;
  }

  function finishShortcutRecording() {
    shortcutRecordingActionId = null;
    shortcutRecordingPartial = [];
    shortcutRecordingError = "";
    render();
  }

  function beginShortcutRecording(actionId) {
    if (shortcutSavingActionId) return;
    shortcutRecordingActionId = actionId;
    shortcutRecordingPartial = [];
    shortcutRecordingError = "";
    shortcutFeedback = null;
    render();
  }

  async function handleShortcutCommit(actionId, accelerator) {
    if (!api.registerShortcut) {
      shortcutRecordingError = "tutorial shortcut API unavailable";
      render();
      return;
    }
    shortcutSavingActionId = actionId;
    shortcutRecordingError = "";
    render();
    try {
      const result = await api.registerShortcut({ actionId, accelerator });
      if (result && result.status === "ok") {
        shortcutFeedback = {
          actionId,
          tone: "ok",
          text: i18n("shortcutToastSaved", "Saved."),
        };
        shortcutRecordingActionId = null;
        shortcutRecordingPartial = [];
        shortcutRecordingError = "";
        return;
      }
      shortcutRecordingError = translateShortcutError(result && result.message);
    } catch (err) {
      shortcutRecordingError = (err && err.message) || "unknown error";
    } finally {
      shortcutSavingActionId = null;
      render();
    }
  }

  function handleShortcutRecordKey(event) {
    if (!shortcutRecordingActionId) return;
    event.preventDefault();
    event.stopPropagation();
    if (shortcutSavingActionId) return;
    if (!shortcutActions.buildAcceleratorFromEvent) {
      shortcutRecordingError = "shortcut recorder unavailable";
      render();
      return;
    }
    const built = shortcutActions.buildAcceleratorFromEvent(event, { isMac: isMac() });
    if (!built) return;
    if (built.action === "pending") {
      shortcutRecordingPartial = Array.isArray(built.modifiers) ? built.modifiers : [];
      shortcutRecordingError = "";
      render();
      return;
    }
    if (built.action === "cancel") {
      finishShortcutRecording();
      return;
    }
    if (built.action === "reject") {
      shortcutRecordingPartial = [];
      shortcutRecordingError = translateShortcutError(built.reason);
      render();
      return;
    }
    if (built.action === "commit") {
      handleShortcutCommit(shortcutRecordingActionId, built.accelerator);
    }
  }

  async function resetShortcut(actionId) {
    if (!api.resetShortcut || shortcutRecordingActionId || shortcutSavingActionId) return;
    shortcutFeedback = null;
    shortcutSavingActionId = actionId;
    render();
    try {
      const result = await api.resetShortcut({ actionId });
      if (result && result.status === "ok") {
        shortcutFeedback = {
          actionId,
          tone: "ok",
          text: i18n("shortcutToastSaved", "Saved."),
        };
      } else {
        shortcutFeedback = {
          actionId,
          tone: "error",
          text: translateShortcutError(result && result.message),
        };
      }
    } catch (err) {
      shortcutFeedback = {
        actionId,
        tone: "error",
        text: (err && err.message) || "unknown error",
      };
    } finally {
      shortcutSavingActionId = null;
      render();
    }
  }

  function shortcutValueNode(text) {
    return el("span", { class: "shortcut-value-pill" }, text);
  }

  function fixedKeyNode(keysText) {
    const keys = el("span", { class: "keys fixed-keys" });
    for (const part of String(keysText || "").split(/\s*\/\s*/).filter(Boolean)) {
      keys.appendChild(el("span", { class: "kbd" }, part));
    }
    return keys;
  }

  function renderEditableShortcutRow(item) {
    const actionId = item.id;
    const isRecording = shortcutRecordingActionId === actionId;
    const isSaving = shortcutSavingActionId === actionId;
    const anyRecording = !!shortcutRecordingActionId;
    let valueText = formatShortcutValue(item.accelerator);
    let statusText = "";
    let tone = "";

    if (isRecording) {
      valueText = shortcutRecordingPartial.length && shortcutActions.formatAcceleratorPartial
        ? shortcutActions.formatAcceleratorPartial(shortcutRecordingPartial, { isMac: isMac() })
        : i18n("shortcutRecordingHint", "Press keys (Esc)");
      statusText = isSaving
        ? i18n("tutorialShortcutChecking", "Checking…")
        : (shortcutRecordingError || i18n("tutorialShortcutRecordingHelp", "Press a new shortcut. Esc cancels."));
      tone = shortcutRecordingError ? "error" : "recording";
    } else if (shortcutFeedback && shortcutFeedback.actionId === actionId) {
      statusText = shortcutFeedback.text;
      tone = shortcutFeedback.tone;
    }

    const isDefault = item.accelerator === item.defaultAccelerator;
    return el("div", {
      class: "sc-row editable" + (isRecording ? " recording" : ""),
      "data-shortcut-action-id": actionId,
    },
      el("span", { class: "sc-copy" },
        el("span", { class: "sc-name" }, item.label || shortcutLabel(actionId, actionId)),
        statusText ? el("span", { class: "sc-status " + tone }, statusText) : null),
      shortcutValueNode(valueText),
      el("span", { class: "sc-actions" },
        el("button", {
          class: "sc-btn",
          disabled: anyRecording || shortcutSavingActionId ? "" : null,
          onclick: () => beginShortcutRecording(actionId),
        }, i18n("shortcutRecordButton", "Change")),
        el("button", {
          class: "sc-btn",
          disabled: anyRecording || shortcutSavingActionId || isDefault ? "" : null,
          onclick: () => resetShortcut(actionId),
        }, i18n("shortcutResetButton", "Reset"))));
  }

  function fixedShortcuts() {
    return [
      { key: "shortcutLabelBubbleNextOption", fallback: "Next approval option", keys: "Tab / ↓" },
      { key: "shortcutLabelBubblePrevOption", fallback: "Previous approval option", keys: "Shift+Tab / ↑" },
      { key: "shortcutLabelBubbleToggleOption", fallback: "Toggle selected option", keys: "Space" },
      { key: "shortcutLabelBubbleSubmit", fallback: "Submit approval choice", keys: "Enter" },
      { key: "shortcutLabelPetReveal", fallback: "Bring Clawd forward", keys: i18n("tutorialShortcutClickPet", "Click pet") },
      {
        key: "shortcutLabelOpenDashboard",
        fallback: "Open session dashboard",
        keys: isMac() ? "⌘ + Click pet" : "Ctrl + Click pet",
      },
    ];
  }

  function renderFixedShortcutRow(item) {
    return el("div", { class: "sc-row fixed" },
      el("span", { class: "sc-copy" },
        el("span", { class: "sc-name" }, i18n(item.key, item.fallback))),
      fixedKeyNode(item.keys));
  }

  function renderShortcutSection(titleKey, titleFb, descKey, descFb, children) {
    return el("section", { class: "shortcut-section" },
      el("div", { class: "shortcut-section-head" },
        el("h3", { class: "shortcut-section-title" }, i18n(titleKey, titleFb)),
        el("p", { class: "shortcut-section-desc" }, i18n(descKey, descFb))),
      children);
  }

  function renderShortcuts() {
    const wrap = el("div", {});
    wrap.appendChild(el("h2", { class: "step-title" }, i18n("tutorialShortcutsTitle", "Set your shortcuts")));
    wrap.appendChild(el("p", { class: "step-sub" }, i18n("tutorialShortcutsSub",
      "Change the shortcuts you will actually use. Built-in keys are listed below for reference.")));

    wrap.appendChild(renderShortcutSection(
      "tutorialShortcutsEditableTitle", "Can change now",
      "tutorialShortcutsEditableDesc", "Pick the shortcuts you want. Clawd checks conflicts when you save.",
      editableShortcuts().map(renderEditableShortcutRow)));
    wrap.appendChild(renderShortcutSection(
      "tutorialShortcutsFixedTitle", "Built in",
      "tutorialShortcutsFixedDesc", "These keys and gestures work as-is, so there is nothing to configure.",
      fixedShortcuts().map(renderFixedShortcutRow)));
    wrap.appendChild(el("div", { class: "hint" }, i18n("tutorialShortcutsHint",
      "You can always click the bubble with the mouse too. Shortcuts are just there when you want to stay in the keyboard.")));
    return wrap;
  }

  function featureCard(titleKey, titleFb, descKey, descFb, plat, extraClass) {
    const card = el("div", { class: "fcard" + (extraClass ? " " + extraClass : "") },
      el("h3", {}, i18n(titleKey, titleFb)),
      el("p", {}, i18n(descKey, descFb)));
    if (plat) card.appendChild(el("span", { class: "plat" }, plat));
    return card;
  }

  function renderFeatures() {
    const wrap = el("div", {});
    wrap.appendChild(el("h2", { class: "step-title" }, i18n("tutorialFeaturesTitle", "Useful things to try later")));
    wrap.appendChild(el("p", { class: "step-sub" }, i18n("tutorialFeaturesSub",
      "Nothing here is required for setup. These are handy once Clawd is running.")));
    const platformStarter = isMac()
      ? featureCard("tutorialFeatureDashboard", "Session dashboard",
        "tutorialFeatureDashboardDesc", "See live sessions, aliases, and recent activity in one place.")
      : featureCard("tutorialFeatureDrag", "Drop a project folder",
        "tutorialFeatureDragDesc", "Drop a folder on Clawd to open a terminal in that directory.",
        i18n("tutorialFeatureDragPlatform", "Windows / Linux"));
    const grid = el("div", { class: "features" },
      platformStarter,
      featureCard("tutorialFeatureThemes", "Themes and mini mode",
        "tutorialFeatureThemesDesc", "Switch character themes, or tuck Clawd against a screen edge."),
      featureCard("tutorialFeatureMobile", "Phone / Telegram approval",
        "tutorialFeatureMobileDesc", "Handle permission requests from your phone when you are away."),
      featureCard("tutorialFeatureAuto", "Auto-approve requests",
        "tutorialFeatureAutoDesc", "Enable only when you fully trust the agent; every request is allowed automatically.", null, "advanced"),
    );
    wrap.appendChild(grid);
    return wrap;
  }

  function renderDone() {
    const wrap = el("div", { class: "done" });
    wrap.appendChild(heroNode("hero-art hero-sm hero-svg", "done"));
    wrap.appendChild(el("h2", { class: "step-title" }, i18n("tutorialDoneTitle", "You're all set")));
    wrap.appendChild(el("p", { class: "step-sub" }, i18n("tutorialDoneBody",
      "Start a connected AI tool and Clawd will react on your desktop. You can reopen this guide from Settings → General.")));
    wrap.appendChild(el("div", { style: "margin-top:14px" },
      inlineLink(i18n("tutorialDoneOpenSettings", "Open Settings"),
        () => api.openSettingsTab && api.openSettingsTab("general"))));
    return wrap;
  }

  const BODY_RENDERERS = {
    welcome: renderWelcome,
    agents: renderAgents,
    shortcuts: renderShortcuts,
    features: renderFeatures,
    done: renderDone,
  };

  // ── Chrome ──

  function renderSteps() {
    const host = document.getElementById("steps");
    host.textContent = "";
    host.appendChild(el("span", { class: "step-count" }, (step + 1) + " / " + STEPS.length));
    const track = el("div", {
      class: "step-track",
      role: "progressbar",
      "aria-valuemin": "1",
      "aria-valuemax": String(STEPS.length),
      "aria-valuenow": String(step + 1),
    });
    const fill = el("span", { class: "step-fill" });
    fill.style.width = Math.round(((step + 1) / STEPS.length) * 100) + "%";
    track.appendChild(fill);
    host.appendChild(track);
  }

  function primaryLabel() {
    const name = STEPS[step];
    if (name === "welcome") return i18n("tutorialGetStarted", "Get started");
    if (name === "done") return i18n("tutorialFinish", "Finish");
    return i18n("tutorialContinue", "Continue");
  }

  function onPrimary() {
    if (STEPS[step] === "done") { finish(); return; }
    setStep(step + 1);
  }

  function renderFooter() {
    const host = document.getElementById("footer");
    host.textContent = "";
    if (step > 0) {
      host.appendChild(el("button", { class: "btn", onclick: () => setStep(step - 1) },
        i18n("tutorialBack", "Back")));
    }
    host.appendChild(el("span", { class: "spacer" }));
    if (STEPS[step] !== "done") {
      host.appendChild(el("button", { class: "btn btn-ghost", onclick: finish },
        i18n("tutorialSkip", "Skip tutorial")));
    }
    host.appendChild(el("button", { class: "btn btn-primary", onclick: onPrimary }, primaryLabel()));
  }

  function render() {
    renderSteps();
    const body = document.getElementById("body");
    body.className = "body step-" + STEPS[step];
    body.textContent = "";
    body.appendChild((BODY_RENDERERS[STEPS[step]] || renderWelcome)());
    renderFooter();
  }

  function adopt(s) {
    STATE = normalizeState(s);
    reconcileSelection("install", STATE.agents.install);
    reconcileSelection("cleanup", STATE.agents.cleanup);
    render();
  }

  document.addEventListener("keydown", handleShortcutRecordKey, true);
  window.addEventListener("blur", () => {
    if (shortcutRecordingActionId) finishShortcutRecording();
  });
  document.addEventListener("mousedown", (event) => {
    if (!shortcutRecordingActionId) return;
    const target = event.target;
    const row = target && typeof target.closest === "function"
      ? target.closest("[data-shortcut-action-id]")
      : null;
    if (row && row.getAttribute("data-shortcut-action-id") === shortcutRecordingActionId) return;
    finishShortcutRecording();
  });

  if (api.onState) api.onState((s) => adopt(s));
  if (api.getState) {
    api.getState().then((s) => adopt(s)).catch(() => render());
  } else {
    render();
  }
})();
