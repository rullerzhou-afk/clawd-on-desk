"use strict";

(function initSettingsTabTelegramApproval(root) {
  let state = null;
  let coreRef = null;
  let helpers = null;
  let ops = null;

  const view = {
    status: null,
    statusSeq: 0,
    statusLoading: false,
    statusForceRenderPending: false,
    tokenInfo: null,
    tokenInfoSeq: 0,
    tokenInfoLoading: false,
    tokenInfoForceRenderPending: false,
    tokenPending: false,
    tokenEditing: false,
    configPending: false,
    testPending: false,
    formDraft: null,
    formDirty: false,
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

  function getFormDraft() {
    if (!view.formDraft || !view.formDirty) {
      const cfg = currentConfig();
      view.formDraft = { allowedTgUserId: cfg.allowedTgUserId };
    }
    return view.formDraft;
  }

  function setFormDraftValue(key, value) {
    const draft = getFormDraft();
    draft[key] = value;
    view.formDirty = true;
  }

  function resetFormDraft() {
    view.formDraft = null;
    view.formDirty = false;
  }

  function callCommand(action, payload) {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return Promise.resolve({ status: "error" });
    }
    return window.settingsAPI.command(action, payload).catch((err) => ({
      status: "error",
      message: err && err.message,
    }));
  }

  function refreshStatus({ forceRender = false } = {}) {
    if (view.statusLoading) {
      if (forceRender) view.statusForceRenderPending = true;
      return;
    }
    view.statusLoading = true;
    const seq = ++view.statusSeq;
    callCommand("telegramApproval.status").then((result) => {
      if (seq !== view.statusSeq) return;
      view.statusLoading = false;
      const previousStatus = view.status;
      const hadStatus = !!previousStatus;
      const updated = result && result.status === "ok";
      const nextStatus = updated ? result.state || null : previousStatus;
      const shouldForceRender = forceRender || view.statusForceRenderPending;
      view.statusForceRenderPending = false;
      const changed = updated && statusRenderKey(previousStatus) !== statusRenderKey(nextStatus);
      if (updated) view.status = result.state || null;
      if ((shouldForceRender || (updated && (!hadStatus || changed))) && state.activeTab === "telegram-approval") {
        ops.requestRender({ content: true });
      }
    });
  }

  function refreshTokenInfo({ forceRender = false } = {}) {
    if (view.tokenInfoLoading) {
      if (forceRender) view.tokenInfoForceRenderPending = true;
      return;
    }
    view.tokenInfoLoading = true;
    const seq = ++view.tokenInfoSeq;
    callCommand("telegramApproval.tokenInfo").then((result) => {
      if (seq !== view.tokenInfoSeq) return;
      view.tokenInfoLoading = false;
      const previous = view.tokenInfo;
      const updated = result && result.status === "ok";
      const next = updated ? { configured: !!result.configured, masked: result.masked || "" } : previous;
      const shouldForceRender = forceRender || view.tokenInfoForceRenderPending;
      view.tokenInfoForceRenderPending = false;
      const changed = updated && tokenInfoRenderKey(previous) !== tokenInfoRenderKey(next);
      if (updated) view.tokenInfo = next;
      if ((shouldForceRender || (updated && changed)) && state.activeTab === "telegram-approval") {
        ops.requestRender({ content: true });
      }
    });
  }

  function statusRenderKey(status) {
    const s = status && typeof status === "object" ? status : {};
    return [
      s.status || "",
      s.enabled === true ? "1" : "0",
      s.configured === true ? "1" : "0",
      s.reason || "",
      s.message || "",
      s.tokenStored === true ? "1" : "0",
    ].join("");
  }

  function tokenInfoRenderKey(info) {
    const i = info && typeof info === "object" ? info : {};
    return [i.configured === true ? "1" : "0", i.masked || ""].join("");
  }

  function render(parent) {
    refreshStatus();
    refreshTokenInfo();

    const h1 = document.createElement("h1");
    h1.textContent = t("remoteApprovalTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("remoteApprovalSubtitle");
    parent.appendChild(subtitle);

    // Each remote approval channel renders as its own collapsible card so the
    // page can stay tidy as external approval channels grow.
    parent.appendChild(buildTelegramChannelCard());
    parent.appendChild(buildHardwareBuddyChannelCard());
  }

  function buildTelegramChannelCard() {
    const kind = deriveCardKind();
    // Default-collapse the card once the sidecar is actually running — the
    // user no longer needs to see the setup steps. localStorage persists any
    // manual expand/collapse from there.
    const defaultCollapsed = kind === "running";

    return helpers.buildCollapsibleGroup({
      id: "remote-approval.telegram",
      headerContent: buildChannelHeader(t("telegramApprovalChannelName"), kind),
      defaultCollapsed,
      className: "remote-approval-channel-card tg-approval-channel-card",
      children: [
        buildChannelStatusRow(kind),
        helpers.buildSection(t("telegramApprovalStep1Title"), [buildTokenRow()]),
        helpers.buildSection(t("telegramApprovalStep2Title"), [buildRecipientRow()]),
        buildStep3Section(),
      ],
    });
  }

  function buildHardwareBuddyChannelCard() {
    return root.ClawdSettingsHardwareBuddyPanel.build(coreRef, {
      id: "remote-approval.hardware-buddy",
      activeTabId: "telegram-approval",
      className: "remote-approval-channel-card",
    });
  }

  function buildChannelHeader(channelName, kind) {
    const wrap = document.createElement("div");
    wrap.className = "tg-approval-channel-header";

    const nameEl = document.createElement("span");
    nameEl.className = "tg-approval-channel-name";
    nameEl.textContent = channelName;
    wrap.appendChild(nameEl);

    const badge = document.createElement("span");
    badge.className = "tg-approval-channel-badge " + statusBadgeClass(kind);
    const dot = document.createElement("span");
    dot.className = "tg-approval-channel-badge-dot";
    badge.appendChild(dot);
    const badgeText = document.createElement("span");
    badgeText.textContent = t("telegramApprovalCardKind_" + kind);
    badge.appendChild(badgeText);
    wrap.appendChild(badge);

    return wrap;
  }

  function buildChannelStatusRow(kind) {
    const row = document.createElement("div");
    row.className = "tg-approval-channel-status-row " + statusBadgeClass(kind);
    const text = document.createElement("span");
    text.className = "tg-approval-channel-status-text";
    text.textContent = deriveCardMessage(kind);
    row.appendChild(text);
    return row;
  }

  function statusBadgeClass(kind) {
    switch (kind) {
      case "running": return "tg-approval-badge-running";
      case "starting": return "tg-approval-badge-starting";
      case "failed": return "tg-approval-badge-failed";
      case "ready": return "tg-approval-badge-ready";
      case "incomplete":
      default: return "tg-approval-badge-incomplete";
    }
  }

  // ── Status helpers ──

  function deriveCardKind() {
    const s = view.status || {};
    if (s.status === "running") return "running";
    if (s.status === "starting") return "starting";
    if (s.status === "failed") return "failed";
    if (s.configured === true) return "ready";
    return "incomplete";
  }

  function deriveCardMessage(kind) {
    const s = view.status || {};
    if (kind === "failed") {
      return s.message || t("telegramApprovalCardFailed");
    }
    if (kind === "running") return t("telegramApprovalCardRunning");
    if (kind === "starting") return t("telegramApprovalCardStarting");
    if (kind === "ready") return t("telegramApprovalCardReadyToEnable");
    // incomplete — pick the most actionable missing piece
    const tokenOk = !!(view.tokenInfo && view.tokenInfo.configured) || s.tokenStored === true;
    const cfg = currentConfig();
    const recipientOk = !!cfg.allowedTgUserId;
    if (!tokenOk && !recipientOk) return t("telegramApprovalCardMissingBoth");
    if (!tokenOk) return t("telegramApprovalCardMissingToken");
    if (!recipientOk) return t("telegramApprovalCardMissingRecipient");
    return t("telegramApprovalCardReadyToEnable");
  }

  // ── Step 1: Bot Token ──

  function buildTokenRow() {
    const info = view.tokenInfo;
    const configured = !!(info && info.configured);
    if (configured && !view.tokenEditing) {
      return buildTokenStoredRow(info);
    }
    return buildTokenEditRow({ configured, masked: info ? info.masked : "" });
  }

  function buildTokenStoredRow(info) {
    const row = document.createElement("div");
    row.className = "row tg-approval-token-stored-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label tg-approval-token-stored-label";
    label.textContent = t("telegramApprovalTokenConfiguredLabel");
    const masked = document.createElement("span");
    masked.className = "tg-approval-token-masked";
    masked.textContent = info && info.masked ? info.masked : t("telegramApprovalTokenConfiguredNoMask");
    label.appendChild(masked);
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("telegramApprovalTokenConfiguredDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn";
    btn.textContent = t("telegramApprovalReplaceToken");
    btn.addEventListener("click", () => {
      view.tokenEditing = true;
      ops.requestRender({ content: true });
    });
    ctrl.appendChild(btn);
    row.appendChild(ctrl);
    return row;
  }

  function buildTokenEditRow({ configured, masked }) {
    const row = document.createElement("div");
    row.className = "row tg-approval-token-edit-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalBotToken");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.innerHTML = configured
      ? escapeWithLink(t("telegramApprovalTokenReplaceHintHtml"))
      : escapeWithLink(t("telegramApprovalBotTokenHintHtml"));
    text.appendChild(label);
    if (configured && masked) {
      const current = document.createElement("span");
      current.className = "tg-approval-token-current";
      current.textContent = t("telegramApprovalTokenCurrent").replace("{masked}", masked);
      text.appendChild(current);
    }
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control tg-approval-input-row";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("telegramApprovalBotTokenPlaceholder");
    input.className = "tg-approval-input";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = view.tokenPending ? t("telegramApprovalSaving") : t("telegramApprovalSaveToken");
    saveBtn.disabled = view.tokenPending;
    saveBtn.addEventListener("click", () => {
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
        input.value = "";
        view.tokenEditing = false;
        view.tokenInfo = null;
        view.status = null;
        refreshTokenInfo({ forceRender: true });
        refreshStatus({ forceRender: true });
      });
    });

    ctrl.appendChild(input);
    ctrl.appendChild(saveBtn);

    if (configured) {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "soft-btn";
      cancelBtn.textContent = t("telegramApprovalCancel");
      cancelBtn.disabled = view.tokenPending;
      cancelBtn.addEventListener("click", () => {
        view.tokenEditing = false;
        ops.requestRender({ content: true });
      });
      ctrl.appendChild(cancelBtn);
    }

    row.appendChild(ctrl);
    return row;
  }

  // ── Step 2: Recipient ──

  function buildRecipientRow() {
    const draft = getFormDraft();
    const row = document.createElement("div");
    row.className = "row tg-approval-recipient-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalRecipientLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.innerHTML = escapeWithLink(t("telegramApprovalRecipientHintHtml"));
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control tg-approval-input-row";
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.spellcheck = false;
    input.placeholder = t("telegramApprovalRecipientPlaceholder");
    input.className = "tg-approval-input";
    input.value = draft.allowedTgUserId || "";
    input.addEventListener("input", () => setFormDraftValue("allowedTgUserId", input.value));

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = view.configPending ? t("telegramApprovalSaving") : t("telegramApprovalSaveRecipient");
    saveBtn.disabled = view.configPending;
    saveBtn.addEventListener("click", () => {
      const raw = String(getFormDraft().allowedTgUserId || "").trim();
      if (!raw) {
        ops.showToast(t("telegramApprovalRecipientEmpty"), { error: true });
        return;
      }
      if (!/^[1-9]\d{4,19}$/.test(raw)) {
        ops.showToast(t("telegramApprovalRecipientInvalid"), { error: true });
        return;
      }
      saveConfig({
        enabled: currentConfig().enabled,
        allowedTgUserId: raw,
        // UI never asks for chat id separately. We mirror user id into the
        // session key — main-side normalizeTelegramSessionKey adds the
        // `telegram:` prefix. Private-chat scenarios always have chat_id ===
        // user_id in Telegram, so this is correct for the supported path.
        targetSessionKey: raw,
      });
    });

    ctrl.appendChild(input);
    ctrl.appendChild(saveBtn);
    row.appendChild(ctrl);
    return row;
  }

  // ── Step 3: Enable + Test ──

  function buildStep3Section() {
    const tokenConfigured = !!(view.tokenInfo && view.tokenInfo.configured)
      || (view.status && view.status.tokenStored === true);
    const cfg = currentConfig();
    const recipientConfigured = !!cfg.allowedTgUserId;
    const ready = tokenConfigured && recipientConfigured;

    const rows = [];
    if (!ready) {
      rows.push(buildPrerequisitesRow({ tokenConfigured, recipientConfigured }));
    }
    rows.push(buildEnabledRow({ ready }));
    rows.push(buildTestRow({ ready }));
    return helpers.buildSection(t("telegramApprovalStep3Title"), rows);
  }

  function buildPrerequisitesRow({ tokenConfigured, recipientConfigured }) {
    const row = document.createElement("div");
    row.className = "row tg-approval-prereq-row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalPrereqLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    const missing = [];
    if (!tokenConfigured) missing.push(t("telegramApprovalPrereqMissingToken"));
    if (!recipientConfigured) missing.push(t("telegramApprovalPrereqMissingRecipient"));
    desc.textContent = t("telegramApprovalPrereqDesc") + " " + missing.join("、");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);
    return row;
  }

  function buildEnabledRow({ ready }) {
    const cfg = currentConfig();
    const row = document.createElement("div");
    row.className = "row";
    if (!ready) row.classList.add("tg-approval-row-disabled");

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
    if (!ready) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
      sw.removeAttribute("tabindex");
    } else {
      const toggle = () => saveConfig({ ...cfg, enabled: !cfg.enabled }, { resetDraft: false });
      sw.addEventListener("click", toggle);
      sw.addEventListener("keydown", (ev) => {
        if (ev.key === " " || ev.key === "Enter") {
          ev.preventDefault();
          toggle();
        }
      });
    }
    ctrl.appendChild(sw);
    row.appendChild(ctrl);
    return row;
  }

  function buildTestRow({ ready }) {
    const s = view.status || {};
    const runtimeReady = s.configured === true;
    const testDisabled = view.testPending || !ready || !runtimeReady;
    const row = document.createElement("div");
    row.className = "row";
    if (!ready) row.classList.add("tg-approval-row-disabled");

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
    btn.disabled = testDisabled;
    if (testDisabled && !view.testPending) {
      btn.title = (s.message && String(s.message)) || t("telegramApprovalCardMissingBoth");
    }
    btn.addEventListener("click", () => {
      if (testDisabled) return;
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
      });
    });
    ctrl.appendChild(btn);
    row.appendChild(ctrl);
    return row;
  }

  // ── Save / shared ──

  function saveConfig(next, options = {}) {
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
      if (options.resetDraft !== false) resetFormDraft();
      view.status = null;
      refreshStatus({ forceRender: true });
    }).catch((err) => {
      view.configPending = false;
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      ops.requestRender({ content: true });
    });
  }

  // ── Helpers ──

  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // i18n hint strings use a constrained mini-syntax: literal text plus
  // [text](https://...) link tokens. We escape the literal text and only
  // expand whitelisted https://t.me/* links so a malicious translation can't
  // inject arbitrary HTML.
  function escapeWithLink(text) {
    const raw = String(text == null ? "" : text);
    const parts = [];
    let lastIdx = 0;
    const re = /\[([^\]]+)\]\((https:\/\/t\.me\/[A-Za-z0-9_./?#=&-]+)\)/g;
    let match;
    while ((match = re.exec(raw)) !== null) {
      parts.push(escapeHtml(raw.slice(lastIdx, match.index)));
      parts.push(`<a href="${escapeHtml(match[2])}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[1])}</a>`);
      lastIdx = match.index + match[0].length;
    }
    parts.push(escapeHtml(raw.slice(lastIdx)));
    return parts.join("");
  }

  function init(core) {
    coreRef = core;
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs["telegram-approval"] = { render };
  }

  root.ClawdSettingsTabTelegramApproval = { init };
})(globalThis);
