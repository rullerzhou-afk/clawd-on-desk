"use strict";

(function initSettingsTabTelegramApproval(root) {
  let state = null;
  let helpers = null;
  let ops = null;

  const view = {
    status: null,
    statusSeq: 0,
    statusLoading: false,
    tokenPending: false,
    configPending: false,
    testPending: false,
  };

  function t(key) {
    return helpers.t(key);
  }

  function currentConfig() {
    const cfg = state.snapshot && state.snapshot.tgApproval;
    return {
      enabled: !!(cfg && cfg.enabled),
      allowedTgUserId: cfg && typeof cfg.allowedTgUserId === "string" ? cfg.allowedTgUserId : "",
      targetSessionKey: cfg && typeof cfg.targetSessionKey === "string" ? cfg.targetSessionKey : "",
    };
  }

  function callCommand(action, payload) {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return Promise.resolve({ status: "error" });
    }
    try {
      return window.settingsAPI.command(action, payload).catch((err) => ({
        status: "error",
        message: err && err.message,
      }));
    } catch (err) {
      return Promise.resolve({ status: "error", message: err && err.message });
    }
  }

  function refreshStatus({ forceRender = false } = {}) {
    if (view.statusLoading) return;
    view.statusLoading = true;
    const seq = ++view.statusSeq;
    callCommand("telegramApproval.status").then((result) => {
      if (seq !== view.statusSeq) return;
      view.statusLoading = false;
      if (result && result.status === "ok") view.status = result.state || null;
      if (forceRender && state.activeTab === "telegram-approval") ops.requestRender({ content: true });
    });
  }

  function render(parent) {
    refreshStatus();

    const h1 = document.createElement("h1");
    h1.textContent = t("telegramApprovalTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("telegramApprovalSubtitle");
    parent.appendChild(subtitle);

    parent.appendChild(helpers.buildSection(t("telegramApprovalSectionRuntime"), [
      buildStatusRow(),
      buildEnabledRow(),
      buildTestRow(),
    ]));

    parent.appendChild(helpers.buildSection(t("telegramApprovalSectionConfig"), [
      buildTokenRow(),
      buildConfigFormRow(),
    ]));
  }

  function statusClass(status) {
    switch (status) {
      case "running": return "remote-ssh-status-connected";
      case "starting": return "remote-ssh-status-connecting";
      case "failed": return "remote-ssh-status-failed";
      default: return "remote-ssh-status-idle";
    }
  }

  function statusLabel(status) {
    return t("telegramApprovalStatus_" + (status || "stopped"));
  }

  function buildStatusRow() {
    const s = view.status || {};
    const row = document.createElement("div");
    row.className = "remote-ssh-status-row telegram-approval-status-row";
    const badge = document.createElement("span");
    badge.className = "remote-ssh-status-badge " + statusClass(s.status);
    badge.textContent = statusLabel(s.status);
    row.appendChild(badge);

    const message = document.createElement("span");
    message.className = "remote-ssh-status-message";
    const bits = [];
    bits.push(s.tokenStored ? t("telegramApprovalTokenStored") : t("telegramApprovalTokenMissing"));
    if (s.message) bits.push(s.message);
    else if (s.reason && s.reason !== "disabled") bits.push(t("telegramApprovalReason_" + s.reason));
    message.textContent = bits.filter(Boolean).join(" · ");
    row.appendChild(message);
    return row;
  }

  function buildEnabledRow() {
    const cfg = currentConfig();
    const row = document.createElement("div");
    row.className = "row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalToggle");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("telegramApprovalToggleDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("tabindex", "0");
    helpers.setSwitchVisual(sw, cfg.enabled, { pending: view.configPending });
    const toggle = () => saveConfig({ ...cfg, enabled: !cfg.enabled });
    sw.addEventListener("click", toggle);
    sw.addEventListener("keydown", (ev) => {
      if (ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        toggle();
      }
    });
    ctrl.appendChild(sw);
    row.appendChild(ctrl);
    return row;
  }

  function buildTokenRow() {
    const row = document.createElement("div");
    row.className = "row telegram-approval-token-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalBotToken");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("telegramApprovalBotTokenDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control telegram-approval-inline-form";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("telegramApprovalBotTokenPlaceholder");
    input.className = "telegram-approval-input";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn accent";
    btn.textContent = view.tokenPending ? t("telegramApprovalSaving") : t("telegramApprovalSaveToken");
    btn.disabled = view.tokenPending;
    btn.addEventListener("click", () => {
      const token = input.value.trim();
      if (!token) {
        ops.showToast(t("telegramApprovalTokenEmpty"), { error: true });
        return;
      }
      view.tokenPending = true;
      ops.requestRender({ content: true });
      callCommand("telegramApproval.setToken", { token }).then((result) => {
        view.tokenPending = false;
        if (!result || result.status !== "ok") {
          ops.showToast((result && result.message) || t("telegramApprovalTokenSaveFailed"), { error: true });
          ops.requestRender({ content: true });
          return;
        }
        ops.showToast(t("telegramApprovalTokenSaved"));
        view.status = null;
        refreshStatus({ forceRender: true });
      }).catch(() => {
        view.tokenPending = false;
        ops.showToast(t("telegramApprovalTokenSaveFailed"), { error: true });
        ops.requestRender({ content: true });
      });
    });
    ctrl.appendChild(input);
    ctrl.appendChild(btn);
    row.appendChild(ctrl);
    return row;
  }

  function buildConfigFormRow() {
    const cfg = currentConfig();
    const row = document.createElement("div");
    row.className = "row telegram-approval-config-row";

    const form = document.createElement("div");
    form.className = "telegram-approval-form";
    form.appendChild(buildField({
      id: "telegramAllowedUserId",
      label: t("telegramApprovalAllowedUser"),
      value: cfg.allowedTgUserId,
      hint: t("telegramApprovalAllowedUserHint"),
    }));
    form.appendChild(buildField({
      id: "telegramTargetSessionKey",
      label: t("telegramApprovalTargetSession"),
      value: cfg.targetSessionKey,
      hint: t("telegramApprovalTargetSessionHint"),
    }));

    const actions = document.createElement("div");
    actions.className = "telegram-approval-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = view.configPending ? t("telegramApprovalSaving") : t("telegramApprovalSaveConfig");
    saveBtn.disabled = view.configPending;
    saveBtn.addEventListener("click", () => {
      saveConfig({
        enabled: cfg.enabled,
        allowedTgUserId: form.querySelector("#telegramAllowedUserId").value.trim(),
        targetSessionKey: form.querySelector("#telegramTargetSessionKey").value.trim(),
      });
    });
    actions.appendChild(saveBtn);
    form.appendChild(actions);
    row.appendChild(form);
    return row;
  }

  function buildField({ id, label, value, hint }) {
    const field = document.createElement("label");
    field.className = "remote-ssh-field telegram-approval-field";
    field.setAttribute("for", id);
    const labelEl = document.createElement("span");
    labelEl.className = "remote-ssh-field-label";
    labelEl.textContent = label;
    const input = document.createElement("input");
    input.type = "text";
    input.id = id;
    input.value = value || "";
    input.spellcheck = false;
    const hintEl = document.createElement("span");
    hintEl.className = "remote-ssh-field-hint";
    hintEl.textContent = hint;
    field.appendChild(labelEl);
    field.appendChild(input);
    field.appendChild(hintEl);
    return field;
  }

  function saveConfig(next) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    view.configPending = true;
    ops.requestRender({ content: true });
    window.settingsAPI.update("tgApproval", next).then((result) => {
      view.configPending = false;
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("toastSaveFailed"), { error: true });
        ops.requestRender({ content: true });
        return;
      }
      ops.showToast(t("telegramApprovalConfigSaved"));
      view.status = null;
      refreshStatus({ forceRender: true });
    }).catch((err) => {
      view.configPending = false;
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      ops.requestRender({ content: true });
    });
  }

  function buildTestRow() {
    const row = document.createElement("div");
    row.className = "row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalTest");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("telegramApprovalTestDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn accent";
    btn.textContent = view.testPending ? t("telegramApprovalTesting") : t("telegramApprovalSendTest");
    btn.disabled = view.testPending;
    btn.addEventListener("click", () => {
      view.testPending = true;
      ops.requestRender({ content: true });
      callCommand("telegramApproval.test").then((result) => {
        view.testPending = false;
        if (result && result.status === "ok") {
          ops.showToast(t("telegramApprovalTestSent"));
        } else {
          ops.showToast((result && result.message) || t("telegramApprovalTestFailed"), { error: true });
        }
        view.status = null;
        refreshStatus({ forceRender: true });
      }).catch(() => {
        view.testPending = false;
        ops.showToast(t("telegramApprovalTestFailed"), { error: true });
        ops.requestRender({ content: true });
      });
    });
    ctrl.appendChild(btn);
    row.appendChild(ctrl);
    return row;
  }

  function init(core) {
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs["telegram-approval"] = { render };
  }

  root.ClawdSettingsTabTelegramApproval = { init };
})(globalThis);
