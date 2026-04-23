"use strict";

(function initSettingsTabShortcuts(root) {
  let state = null;
  let runtime = null;
  let readers = null;
  let helpers = null;
  let ops = null;
  let i18n = null;
  let listenersAttached = false;

  function t(key) {
    return helpers.t(key);
  }

  function getShortcutActionLabel(actionId) {
    const meta = i18n.SHORTCUT_ACTIONS[actionId];
    return meta ? t(meta.labelKey) : actionId;
  }

  function runShortcutAction(action, payload) {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    window.settingsAPI.command(action, payload).then((result) => {
      if (!result || result.status !== "ok") {
        const message = ops.translateShortcutError(result && result.message)
          || (t("toastSaveFailed") + "unknown error");
        ops.showToast(message, { error: true });
      }
    }).catch((err) => {
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
    });
  }

  function buildShortcutRow(actionId) {
    const row = document.createElement("div");
    row.className = "row shortcut-row";
    row.dataset.shortcutActionId = actionId;

    const textWrap = document.createElement("div");
    textWrap.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = getShortcutActionLabel(actionId);
    textWrap.appendChild(label);

    const status = document.createElement("span");
    status.className = "row-desc";
    const isRecording = state.shortcutRecordingActionId === actionId;
    const failure = runtime.shortcutFailures && runtime.shortcutFailures[actionId];
    if (isRecording) {
      if (state.shortcutRecordingError) {
        status.classList.add("shortcut-status-recording");
        status.textContent = state.shortcutRecordingError;
      } else {
        status.textContent = "";
      }
    } else if (failure) {
      status.classList.add("shortcut-status-warning");
      status.textContent = t("shortcutErrorRegistrationFailed");
    } else {
      status.textContent = "";
    }
    textWrap.appendChild(status);
    row.appendChild(textWrap);

    const control = document.createElement("div");
    control.className = "row-control shortcut-row-control";
    const value = document.createElement("div");
    value.className = "shortcut-value";
    if (!readers.getShortcutValue(actionId)) value.classList.add("unassigned");
    if (isRecording) value.classList.add("recording");
    if (isRecording) {
      const partial = state.shortcutRecordingPartial.length > 0
        ? i18n.formatAcceleratorPartial(state.shortcutRecordingPartial, { isMac: i18n.IS_MAC })
        : "";
      value.textContent = partial || t("shortcutRecordingHint");
    } else {
      value.textContent = i18n.formatAcceleratorLabel(readers.getShortcutValue(actionId), {
        isMac: i18n.IS_MAC,
        unassignedLabel: t("shortcutUnassigned"),
      });
    }
    control.appendChild(value);

    if (failure && !isRecording) {
      const warning = document.createElement("span");
      warning.className = "shortcut-warning";
      warning.textContent = "⚠";
      warning.title = t("shortcutErrorRegistrationFailed");
      control.appendChild(warning);
    }

    const anyRecording = !!state.shortcutRecordingActionId;
    control.appendChild(helpers.buildShortcutButton(
      t("shortcutRecordButton"),
      () => ops.enterShortcutRecording(actionId),
      { disabled: anyRecording }
    ));
    control.appendChild(helpers.buildShortcutButton(
      t("shortcutClearButton"),
      () => runShortcutAction("registerShortcut", { actionId, accelerator: null }),
      { disabled: anyRecording || readers.getShortcutValue(actionId) === null }
    ));
    control.appendChild(helpers.buildShortcutButton(
      t("shortcutResetButton"),
      () => runShortcutAction("resetShortcut", { actionId }),
      { disabled: anyRecording }
    ));

    row.appendChild(control);
    return row;
  }

  function render(parent) {
    const h1 = document.createElement("h1");
    h1.textContent = t("shortcutsTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("shortcutsSubtitle");
    parent.appendChild(subtitle);

    const head = document.createElement("div");
    head.className = "shortcuts-head";
    head.appendChild(document.createElement("div"));
    head.appendChild(helpers.buildShortcutButton(
      t("shortcutResetAllButton"),
      () => runShortcutAction("resetAllShortcuts", null),
      { disabled: !!state.shortcutRecordingActionId, accent: true }
    ));
    parent.appendChild(head);

    const rows = i18n.SHORTCUT_ACTION_IDS.map((actionId) => buildShortcutRow(actionId));
    rows.push(buildFixedKeyRow());
    parent.appendChild(helpers.buildSection("", rows));
  }

  // Grayed row for keys that aren't customizable, so users don't wonder
  // why "Enter" isn't in the list.
  function buildFixedKeyRow() {
    const row = document.createElement("div");
    row.className = "row shortcut-row";

    const textWrap = document.createElement("div");
    textWrap.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("shortcutLabelBubbleSubmit");
    textWrap.appendChild(label);
    row.appendChild(textWrap);

    const control = document.createElement("div");
    control.className = "row-control shortcut-row-control";
    const value = document.createElement("div");
    value.className = "shortcut-value";
    value.textContent = "Enter";
    control.appendChild(value);

    const tooltip = t("shortcutBuiltinKeyTooltip");
    const noop = () => {};
    const changeBtn = helpers.buildShortcutButton(t("shortcutRecordButton"), noop, { disabled: true });
    const clearBtn = helpers.buildShortcutButton(t("shortcutClearButton"), noop, { disabled: true });
    const resetBtn = helpers.buildShortcutButton(t("shortcutResetButton"), noop, { disabled: true });
    changeBtn.title = tooltip;
    clearBtn.title = tooltip;
    resetBtn.title = tooltip;
    control.appendChild(changeBtn);
    control.appendChild(clearBtn);
    control.appendChild(resetBtn);

    row.appendChild(control);
    row.title = tooltip;
    return row;
  }

  function attachGlobalListeners() {
    if (listenersAttached) return;
    window.addEventListener("blur", () => {
      if (state.shortcutRecordingActionId) ops.finishShortcutRecording();
    });

    document.addEventListener("mousedown", (event) => {
      if (!state.shortcutRecordingActionId) return;
      const target = event.target;
      const row = target && typeof target.closest === "function"
        ? target.closest("[data-shortcut-action-id]")
        : null;
      if (row && row.dataset.shortcutActionId === state.shortcutRecordingActionId) return;
      ops.finishShortcutRecording();
    });
    listenersAttached = true;
  }

  function init(core) {
    state = core.state;
    runtime = core.runtime;
    readers = core.readers;
    helpers = core.helpers;
    ops = core.ops;
    i18n = core.i18n;
    attachGlobalListeners();
    core.tabs.shortcuts = {
      render,
    };
  }

  root.ClawdSettingsTabShortcuts = { init };
})(globalThis);
