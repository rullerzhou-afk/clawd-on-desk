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

  const feishuView = {
    status: null,
    statusSeq: 0,
    statusLoading: false,
    statusForceRenderPending: false,
    secretInfo: null,
    secretInfoSeq: 0,
    secretInfoLoading: false,
    secretInfoForceRenderPending: false,
    secretPending: false,
    secretEditing: false,
    configPending: false,
    testPending: false,
    refreshTimer: null,
    formDraft: null,
    formDirty: false,
  };

  function t(key) {
    return helpers.t(key);
  }

  // String.prototype.replace's replacement-string argument treats $$/$&/$`/$'
  // as special sequences; error codes/reasons come from external processes and
  // must never be interpolated that way. The function form of the replacement
  // argument is never parsed for $-sequences.
  function interpolate(template, token, value) {
    return template.replace(token, () => value);
  }

  function currentConfig() {
    const cfg = state.snapshot && state.snapshot.tgApproval;
    return {
      enabled: !!(cfg && cfg.enabled),
      allowedTgUserId: cfg && typeof cfg.allowedTgUserId === "string" ? cfg.allowedTgUserId : "",
      targetSessionKey: cfg && typeof cfg.targetSessionKey === "string" ? cfg.targetSessionKey : "",
      // Preserve notifyOnComplete across saves: recipient/toggle payloads are
      // built from this object, so omitting it would let normalize() reset a
      // user's explicit bare-ping choice on the next save.
      notifyOnComplete: !!(cfg && cfg.notifyOnComplete === true),
      completionOutputMode: cfg && (cfg.completionOutputMode === "full" || cfg.completionOutputMode === "tail")
        ? "full"
        : "off",
      r3DirectSendEnabled: !!(cfg && cfg.r3DirectSendEnabled === true),
    };
  }

  function currentFeishuConfig() {
    const cfg = state.snapshot && state.snapshot.feishuApproval;
    const timeout = Number(cfg && cfg.connectionTimeoutSeconds);
    return {
      enabled: !!(cfg && cfg.enabled),
      idType: cfg && typeof cfg.idType === "string" ? cfg.idType : "open_id",
      approverId: cfg && typeof cfg.approverId === "string" ? cfg.approverId : "",
      connectionTimeoutSeconds: [5, 10, 15, 30, 60].includes(timeout) ? timeout : 15,
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

  function getFeishuFormDraft() {
    if (!feishuView.formDraft || !feishuView.formDirty) {
      const cfg = currentFeishuConfig();
      feishuView.formDraft = { idType: cfg.idType, approverId: cfg.approverId };
    }
    return feishuView.formDraft;
  }

  function setFeishuFormDraftValue(key, value) {
    const draft = getFeishuFormDraft();
    draft[key] = value;
    feishuView.formDirty = true;
  }

  function resetFeishuFormDraft() {
    feishuView.formDraft = null;
    feishuView.formDirty = false;
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

  function refreshFeishuStatus({ forceRender = false } = {}) {
    if (feishuView.statusLoading) {
      if (forceRender) feishuView.statusForceRenderPending = true;
      return;
    }
    feishuView.statusLoading = true;
    const seq = ++feishuView.statusSeq;
    callCommand("feishuApproval.status").then((result) => {
      if (seq !== feishuView.statusSeq) return;
      feishuView.statusLoading = false;
      const previousStatus = feishuView.status;
      const hadStatus = !!previousStatus;
      const updated = result && result.status === "ok";
      const nextStatus = updated ? result.state || null : previousStatus;
      const shouldForceRender = forceRender || feishuView.statusForceRenderPending;
      feishuView.statusForceRenderPending = false;
      const changed = updated && feishuStatusRenderKey(previousStatus) !== feishuStatusRenderKey(nextStatus);
      if (updated) feishuView.status = result.state || null;
      scheduleFeishuStatusRefresh(nextStatus);
      const initialVisibleChange = !hadStatus && feishuStatusNeedsRender(nextStatus);
      if ((shouldForceRender || (updated && (initialVisibleChange || (hadStatus && changed)))) && state.activeTab === "telegram-approval") {
        ops.requestRender({ content: true });
      }
    });
  }

  function clearFeishuStatusRefreshTimer() {
    if (feishuView.refreshTimer && typeof clearTimeout === "function") {
      clearTimeout(feishuView.refreshTimer);
    }
    feishuView.refreshTimer = null;
  }

  function scheduleFeishuStatusRefresh(status) {
    clearFeishuStatusRefreshTimer();
    const s = status && typeof status === "object" ? status : {};
    if (state.activeTab !== "telegram-approval" || s.status !== "starting" || typeof setTimeout !== "function") return;
    feishuView.refreshTimer = setTimeout(() => {
      feishuView.refreshTimer = null;
      refreshFeishuStatus({ forceRender: true });
    }, 1000);
  }

  function refreshFeishuSecretInfo({ forceRender = false } = {}) {
    if (feishuView.secretInfoLoading) {
      if (forceRender) feishuView.secretInfoForceRenderPending = true;
      return;
    }
    feishuView.secretInfoLoading = true;
    const seq = ++feishuView.secretInfoSeq;
    callCommand("feishuApproval.secretInfo").then((result) => {
      if (seq !== feishuView.secretInfoSeq) return;
      feishuView.secretInfoLoading = false;
      const previous = feishuView.secretInfo;
      const updated = result && result.status === "ok";
      const next = updated ? {
        configured: result.configured === true,
        appId: result.appId || "",
        appSecret: result.appSecret || "",
        verificationToken: result.verificationToken || "",
        encryptKey: result.encryptKey || "",
      } : previous;
      const shouldForceRender = forceRender || feishuView.secretInfoForceRenderPending;
      feishuView.secretInfoForceRenderPending = false;
      const changed = updated && feishuSecretInfoRenderKey(previous) !== feishuSecretInfoRenderKey(next);
      if (updated) feishuView.secretInfo = next;
      const initialVisibleChange = !previous && feishuSecretInfoNeedsRender(next);
      if ((shouldForceRender || (updated && (initialVisibleChange || (previous && changed)))) && state.activeTab === "telegram-approval") {
        ops.requestRender({ content: true });
      }
    });
  }

  function statusRenderKey(status) {
    const s = status && typeof status === "object" ? status : {};
    return [
      s.status || "",
      s.transport || "",
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

  function feishuStatusRenderKey(status) {
    const s = status && typeof status === "object" ? status : {};
    return [
      s.status || "",
      s.enabled === true ? "1" : "0",
      s.configured === true ? "1" : "0",
      s.reason || "",
      s.message || "",
      s.secretsStored === true ? "1" : "0",
    ].join("");
  }

  function feishuSecretInfoRenderKey(info) {
    const i = info && typeof info === "object" ? info : {};
    return [
      i.configured === true ? "1" : "0",
      i.appId || "",
      i.appSecret || "",
      i.verificationToken || "",
      i.encryptKey || "",
    ].join("");
  }

  function feishuStatusNeedsRender(status) {
    const s = status && typeof status === "object" ? status : {};
    return !!(
      s.status === "running"
      || s.status === "starting"
      || s.status === "failed"
      || s.configured === true
      || s.secretsStored === true
    );
  }

  function feishuSecretInfoNeedsRender(info) {
    return !!(info && info.configured);
  }

  function render(parent) {
    refreshStatus();
    refreshTokenInfo();
    refreshFeishuStatus();
    refreshFeishuSecretInfo();
    // The migration card UI is gone, but the Step-3 enable switch still routes
    // turn-on through the native migration test flow based on this snapshot —
    // keep it loading even though no card renders.
    refreshMigrationSnapshot();

    const h1 = document.createElement("h1");
    h1.textContent = t("remoteApprovalTitle");
    parent.appendChild(h1);

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("remoteApprovalSubtitle");
    parent.appendChild(subtitle);

    // Two subtabs (same pattern as the anim-overrides page): IM channels vs
    // the LAN approval bridge.
    parent.appendChild(buildSubtabSwitcher());
    if (coreRef.runtime.remoteApprovalSubtab === "lan") {
      parent.appendChild(buildMobileChannelCard());
      return;
    }
    // Each remote approval channel renders as its own collapsible card so the
    // page can stay tidy as external approval channels grow.
    parent.appendChild(buildTelegramChannelCard());
    parent.appendChild(buildFeishuChannelCard());
  }

  function buildSubtabSwitcher() {
    const wrap = document.createElement("div");
    wrap.className = "anim-override-subtabs";
    const group = document.createElement("div");
    group.className = "segmented";
    group.setAttribute("role", "tablist");
    const current = coreRef.runtime.remoteApprovalSubtab === "lan" ? "lan" : "channels";
    const entries = [
      { key: "channels", label: t("remoteApprovalSubtabChannels") },
      { key: "lan", label: t("remoteApprovalSubtabLan") },
    ];
    for (const entry of entries) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = entry.label;
      if (entry.key === current) btn.classList.add("active");
      btn.addEventListener("click", () => {
        if (coreRef.runtime.remoteApprovalSubtab === entry.key) return;
        coreRef.runtime.remoteApprovalSubtab = entry.key;
        coreRef.ops.requestRender({ content: true });
      });
      group.appendChild(btn);
    }
    wrap.appendChild(group);
    return wrap;
  }

  function refreshRuntimeStatus(payload) {
    if (!payload || payload.channel !== "feishu") return false;
    refreshFeishuStatus({ forceRender: true });
    return true;
  }

  // ── Migration state plumbing (runtime, not UI) ────────────────────────────
  // The v0.9.0 migration CARD is gone (window over, rollback no longer
  // offered), but this block is alive: the Step-3 enable switch routes
  // turn-on/off through migrationDispatch (USER_TEST_NATIVE / USER_DISABLE)
  // and derives its visual state from the migration snapshot. The reducer +
  // owner-manager in main own the actual sidecar/native runtime.
  let migrationSnapshot = null;
  let migrationPending = false;
  let migrationSnapshotSeq = 0;

  function migrationState() {
    return migrationSnapshot && typeof migrationSnapshot.state === "string"
      ? migrationSnapshot.state
      : "";
  }

  function isNativeMigrationSelected() {
    const s = migrationState();
    return s === "NATIVE_ACTIVE"
      || s === "TESTING_NATIVE"
      || !!(migrationSnapshot && migrationSnapshot.transport === "native");
  }

  function isNativeMigrationActive() {
    const s = migrationState();
    const owner = migrationSnapshot && migrationSnapshot.ownerSnapshot
      ? migrationSnapshot.ownerSnapshot
      : {};
    return s === "NATIVE_ACTIVE" || s === "TESTING_NATIVE" || owner.nativePolling === true;
  }

  function canStartNativeFromSwitch() {
    const s = migrationState();
    return s === "IDLE" || s === "NEEDS_SETUP" || s === "LEGACY_ACTIVE";
  }

  function statusIndicatesNativeApprovalActive() {
    const s = view.status || {};
    return s.transport === "native"
      && (s.enabled === true || s.status === "running" || s.status === "starting");
  }

  function effectiveTelegramApprovalEnabled(cfg) {
    return !!(cfg && cfg.enabled) || isNativeMigrationActive() || statusIndicatesNativeApprovalActive();
  }

  function migrationSnapshotRenderKey(snapshot) {
    const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    const owner = snap.ownerSnapshot && typeof snap.ownerSnapshot === "object"
      ? snap.ownerSnapshot
      : {};
    return [
      snap.state || "",
      snap.transport || "",
      owner.nativePolling === true ? "1" : "0",
      owner.sidecarRunning === true ? "1" : "0",
      snap.nativeVerifiedAt || "",
    ].join("\x1f");
  }

  function refreshMigrationSnapshot() {
    if (migrationPending) return;
    const seq = ++migrationSnapshotSeq;
    callCommand("telegramMigration.snapshot").then((res) => {
      if (seq !== migrationSnapshotSeq || migrationPending) return;
      if (res && res.status === "ok") {
        const previousKey = migrationSnapshotRenderKey(migrationSnapshot);
        migrationSnapshot = res.snapshot;
        if (migrationSnapshotRenderKey(migrationSnapshot) !== previousKey
          && state.activeTab === "telegram-approval") {
          ops.requestRender({ content: true });
        }
      }
    });
  }

  function migrationDispatch(eventType, extra = {}) {
    if (migrationPending) return;
    migrationPending = true;
    callCommand("telegramMigration.dispatch", { type: eventType, ...extra }).then((res) => {
      migrationPending = false;
      if (res && res.snapshot) migrationSnapshot = res.snapshot;
      if (res && res.status !== "ok" && res.errorCode) {
        ops.showToast(interpolate(t("telegramMigrationErrorToast"), "{code}", res.errorCode), { error: true });
      }
      // Status of the legacy sidecar may change as a side-effect (start/stop).
      refreshStatus({ forceRender: true });
    });
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

  function buildFeishuChannelCard() {
    const kind = deriveFeishuCardKind();
    const defaultCollapsed = kind === "running";

    return helpers.buildCollapsibleGroup({
      id: "remote-approval.feishu",
      headerContent: buildChannelHeader(t("feishuApprovalChannelName"), kind),
      defaultCollapsed,
      className: "remote-approval-channel-card feishu-approval-channel-card",
      children: [
        buildChannelStatusRow(kind, deriveFeishuCardMessage(kind)),
        // Order matters: Feishu only saves the long-connection subscription
        // mode while a long connection is live, so the enable switch (step 3)
        // must come before the callback-subscription guide (step 4).
        helpers.buildSection(t("feishuApprovalStep1Title"), [buildFeishuSecretsRow()]),
        helpers.buildSection(t("feishuApprovalStep2Title"), [buildFeishuApproverRow()]),
        buildFeishuStep3Section(),
        buildFeishuStep4Section(),
      ],
    });
  }

  // Mobile Web channel: today a read-only LAN preview (no approval actions
  // yet — #208 tracks that), but it lives with the approval channels because
  // "I'm away from the desk" is the same user intent and that is where the
  // approval console will land.
  function buildMobileChannelCard() {
    const enabled = !!(state.snapshot && state.snapshot.mobilePreviewEnabled === true);
    const kind = enabled ? "running" : "ready";
    const body = document.createElement("div");
    const mobile = root.ClawdSettingsTabMobile;
    if (mobile && typeof mobile.renderChannelBody === "function") {
      mobile.renderChannelBody(body);
    }
    // Named for its trajectory (#208 approval console); the Beta badge + note
    // make the current read-only-preview limitation explicit.
    const header = buildChannelHeader(t("mobileChannelName"), kind);
    const beta = document.createElement("span");
    beta.className = "channel-beta-badge";
    beta.textContent = "Beta";
    header.insertBefore(beta, header.children[1] || null);
    const note = document.createElement("div");
    note.className = "channel-beta-note";
    note.textContent = t("mobileBetaNote");
    return helpers.buildCollapsibleGroup({
      id: "remote-approval.mobile",
      headerContent: header,
      // Never default-collapsed: while running the card shows the pair
      // URL/token the user needs on their phone.
      defaultCollapsed: false,
      className: "remote-approval-channel-card mobile-channel-card",
      children: [
        note,
        buildChannelStatusRow(kind, t(enabled ? "mobileCardRunning" : "mobileCardReady")),
        body,
      ],
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

  function buildChannelStatusRow(kind, message) {
    const row = document.createElement("div");
    row.className = "tg-approval-channel-status-row " + statusBadgeClass(kind);
    const text = document.createElement("span");
    text.className = "tg-approval-channel-status-text";
    text.textContent = message || deriveCardMessage(kind);
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

  function deriveFeishuCardKind() {
    const s = feishuView.status || {};
    if (s.status === "running") return "running";
    if (s.status === "starting") return "starting";
    if (s.status === "failed") return "failed";
    if (s.configured === true || (s.status === "ready" && s.secretsStored === true)) return "ready";
    return "incomplete";
  }

  function deriveFeishuCardMessage(kind) {
    const s = feishuView.status || {};
    if (kind === "failed") return s.message || t("feishuApprovalCardFailed");
    if (kind === "running") return t("feishuApprovalCardRunning");
    if (kind === "starting") return t("feishuApprovalCardStarting");
    if (kind === "ready") return t("feishuApprovalCardReadyToEnable");
    const secretsOk = !!(feishuView.secretInfo && feishuView.secretInfo.configured) || s.secretsStored === true;
    const cfg = currentFeishuConfig();
    const approverOk = !!cfg.approverId;
    if (!secretsOk && !approverOk) return t("feishuApprovalCardMissingBoth");
    if (!secretsOk) return t("feishuApprovalCardMissingSecrets");
    if (!approverOk) return t("feishuApprovalCardMissingApprover");
    return t("feishuApprovalCardReadyToEnable");
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
    bindExternalLinks(desc);
    text.appendChild(label);
    if (configured && masked) {
      const current = document.createElement("span");
      current.className = "tg-approval-token-current";
      current.textContent = interpolate(t("telegramApprovalTokenCurrent"), "{masked}", masked);
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
    bindExternalLinks(desc);
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
        notifyOnComplete: currentConfig().notifyOnComplete,
        completionOutputMode: currentConfig().completionOutputMode,
        r3DirectSendEnabled: currentConfig().r3DirectSendEnabled,
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
    rows.push(buildCompletionOutputRow());
    rows.push(buildDirectSendRow({ ready }));
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
    const effectiveEnabled = effectiveTelegramApprovalEnabled(cfg);
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
    helpers.setSwitchVisual(sw, effectiveEnabled, { pending: view.configPending || migrationPending });
    const canToggle = ready && !migrationPending && (effectiveEnabled || migrationSnapshot);
    if (!canToggle) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
      sw.removeAttribute("tabindex");
    } else {
      const toggle = () => {
        const turningOff = effectiveEnabled === true;
        // Stop-the-bleed (zombie switch — see docs audit-r1a-notification-switch-2026-05-30):
        // this toggle only writes tgApproval.enabled, but v0.9.0 native runtime
        // (completion notifications + approval transport) is owned by the migration
        // state machine and never reads that field. Turning the switch OFF must also
        // dispatch USER_DISABLE, otherwise the native poller + completion pings keep
        // running and the user thinks they switched it off when they didn't. The
        // ON path now goes through the same native Test flow as the migration
        // card instead of reviving the legacy sidecar flag.
        if (turningOff) {
          if (cfg.enabled === true) {
            saveConfig({ ...cfg, enabled: false }, { resetDraft: false });
          }
          migrationDispatch("USER_DISABLE");
          return;
        }
        if (migrationSnapshot && canStartNativeFromSwitch()) {
          ops.requestRender({ content: true });
          migrationDispatch("USER_TEST_NATIVE");
          return;
        }
      };
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

  function buildDirectSendRow({ ready }) {
    const cfg = currentConfig();
    const row = document.createElement("div");
    row.className = "row tg-approval-direct-send-row";
    if (!ready) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalDirectSend");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("telegramApprovalDirectSendDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("tabindex", "0");
    helpers.setSwitchVisual(sw, cfg.r3DirectSendEnabled === true, { pending: view.configPending });
    if (!ready || view.configPending) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
      sw.removeAttribute("tabindex");
    } else {
      const toggle = () => {
        saveConfig({ ...cfg, r3DirectSendEnabled: cfg.r3DirectSendEnabled !== true }, { resetDraft: false });
      };
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

  function buildCompletionOutputRow() {
    const cfg = currentConfig();
    const mode = ["off", "full"].includes(cfg.completionOutputMode)
      ? cfg.completionOutputMode
      : "off";
    const row = document.createElement("div");
    row.className = "row tg-approval-completion-output-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("telegramApprovalCompletionOutput");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("telegramApprovalCompletionOutputDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const select = document.createElement("select");
    select.className = "tg-approval-input tg-approval-output-select";
    select.disabled = view.configPending;
    for (const value of ["off", "full"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = t("telegramApprovalCompletionOutput_" + value);
      select.appendChild(option);
    }
    select.value = mode;
    select.addEventListener("change", () => {
      const nextMode = ["off", "full"].includes(select.value) ? select.value : "off";
      if (nextMode === mode) return;
      if (nextMode === "full") {
        const ok = window.confirm(t("telegramApprovalCompletionOutputFullConfirm"));
        if (!ok) {
          select.value = mode;
          return;
        }
      }
      saveConfig({ ...cfg, completionOutputMode: nextMode }, { resetDraft: false });
    });
    ctrl.appendChild(select);
    row.appendChild(ctrl);
    return row;
  }

  function buildTestRow({ ready }) {
    const s = view.status || {};
    const runtimeReady = s.configured === true;
    const nativeStatus = s.transport === "native" || isNativeMigrationSelected();
    const nativeReady = !nativeStatus || (migrationState() === "NATIVE_ACTIVE" && s.status === "running");
    const testDisabled = view.testPending || !ready || !runtimeReady || !nativeReady;
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

  // ── Feishu: App credentials ──

  function buildFeishuSecretsRow() {
    const info = feishuView.secretInfo;
    const configured = !!(info && info.configured);
    if (configured && !feishuView.secretEditing) {
      return buildFeishuSecretsStoredRow(info);
    }
    return buildFeishuSecretsEditRow({ configured, info });
  }

  function buildFeishuSecretsStoredRow(info) {
    const row = document.createElement("div");
    row.className = "row tg-approval-token-stored-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label tg-approval-token-stored-label";
    label.textContent = t("feishuApprovalSecretsConfiguredLabel");
    const masked = document.createElement("span");
    masked.className = "tg-approval-token-masked";
    masked.textContent = info && info.appId ? info.appId : t("feishuApprovalSecretsConfiguredNoMask");
    label.appendChild(masked);
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("feishuApprovalSecretsConfiguredDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn";
    btn.textContent = t("feishuApprovalReplaceSecrets");
    btn.addEventListener("click", () => {
      feishuView.secretEditing = true;
      ops.requestRender({ content: true });
    });
    ctrl.appendChild(btn);
    row.appendChild(ctrl);
    return row;
  }

  function buildFeishuSecretsEditRow({ configured, info }) {
    const row = document.createElement("div");
    row.className = "row tg-approval-token-edit-row feishu-approval-secrets-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("feishuApprovalSecretsLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.innerHTML = configured
      ? escapeWithLink(t("feishuApprovalSecretsReplaceHintHtml"))
      : escapeWithLink(t("feishuApprovalSecretsHintHtml"));
    bindExternalLinks(desc);
    text.appendChild(label);
    if (configured && info) {
      const current = document.createElement("span");
      current.className = "tg-approval-token-current";
      current.textContent = t("feishuApprovalSecretsCurrent").replace("{masked}", info.appId || "");
      text.appendChild(current);
    }
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control tg-approval-input-row feishu-approval-secrets-grid";
    const appIdInput = buildFeishuSecretInput("feishuApprovalAppIdPlaceholder", false);
    const appSecretInput = buildFeishuSecretInput("feishuApprovalAppSecretPlaceholder", true);
    const verificationInput = buildFeishuSecretInput("feishuApprovalVerificationTokenPlaceholder", true);
    const encryptInput = buildFeishuSecretInput("feishuApprovalEncryptKeyPlaceholder", true);

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = feishuView.secretPending ? t("feishuApprovalSaving") : t("feishuApprovalSaveSecrets");
    saveBtn.disabled = feishuView.secretPending;
    saveBtn.addEventListener("click", () => {
      const payload = {
        appId: appIdInput.value.trim(),
        appSecret: appSecretInput.value.trim(),
        verificationToken: verificationInput.value.trim(),
        encryptKey: encryptInput.value.trim(),
      };
      if (!configured && (!payload.appId || !payload.appSecret)) {
        ops.showToast(t("feishuApprovalSecretsRequired"), { error: true });
        return;
      }
      if (configured && !payload.appId && !payload.appSecret && !payload.verificationToken && !payload.encryptKey) {
        ops.showToast(t("feishuApprovalSecretsEmpty"), { error: true });
        return;
      }
      feishuView.secretPending = true;
      ops.requestRender({ content: true });
      callCommand("feishuApproval.setSecrets", payload).then((result) => {
        feishuView.secretPending = false;
        if (!result || result.status !== "ok") {
          ops.showToast((result && result.message) || t("feishuApprovalSecretsSaveFailed"), { error: true });
          ops.requestRender({ content: true });
          return;
        }
        ops.showToast(t("feishuApprovalSecretsSaved"));
        feishuView.secretEditing = false;
        feishuView.secretInfo = null;
        feishuView.status = null;
        refreshFeishuSecretInfo({ forceRender: true });
        refreshFeishuStatus({ forceRender: true });
      });
    });

    ctrl.appendChild(appIdInput);
    ctrl.appendChild(appSecretInput);
    ctrl.appendChild(verificationInput);
    ctrl.appendChild(encryptInput);
    ctrl.appendChild(saveBtn);
    if (configured) {
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "soft-btn";
      cancelBtn.textContent = t("telegramApprovalCancel");
      cancelBtn.disabled = feishuView.secretPending;
      cancelBtn.addEventListener("click", () => {
        feishuView.secretEditing = false;
        ops.requestRender({ content: true });
      });
      ctrl.appendChild(cancelBtn);
    }
    row.appendChild(ctrl);
    return row;
  }

  function buildFeishuSecretInput(placeholderKey, secret) {
    const input = document.createElement("input");
    input.type = secret ? "password" : "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t(placeholderKey);
    input.className = "tg-approval-input";
    return input;
  }

  // ── Feishu: approver + event subscription ──

  // The Feishu app must subscribe to card.action.trigger over a long
  // connection, or button presses never reach Clawd (#493). The header states
  // the requirement; the step-by-step guide stays collapsed by default.
  function buildFeishuEventSubRow() {
    const steps = [
      "feishuApprovalEventSubStep1Html",
      "feishuApprovalEventSubStep2",
      "feishuApprovalEventSubStep3",
      "feishuApprovalEventSubStep4",
    ].map((key) => {
      const row = document.createElement("div");
      row.className = "row feishu-approval-event-sub-step";
      const text = document.createElement("div");
      text.className = "row-text";
      const desc = document.createElement("span");
      desc.className = "row-desc";
      desc.innerHTML = escapeWithLink(t(key));
      bindExternalLinks(desc);
      text.appendChild(desc);
      row.appendChild(text);
      return row;
    });
    return helpers.buildCollapsibleGroup({
      id: "remote-approval.feishu.event-sub",
      title: t("feishuApprovalEventSubLabel"),
      desc: t("feishuApprovalEventSubDesc"),
      defaultCollapsed: true,
      className: "feishu-approval-event-sub-row",
      children: steps,
    });
  }

  function buildFeishuApproverRow() {
    const draft = getFeishuFormDraft();
    const row = document.createElement("div");
    row.className = "row tg-approval-recipient-row feishu-approval-approver-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("feishuApprovalApproverLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.innerHTML = escapeWithLink(t("feishuApprovalApproverHintHtml"));
    bindExternalLinks(desc);
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control tg-approval-input-row";
    const segmented = document.createElement("div");
    segmented.className = "segmented feishu-approval-id-type";
    segmented.setAttribute("role", "tablist");
    const idTypes = [
      { id: "open_id", label: "open_id" },
      { id: "user_id", label: "user_id" },
      { id: "union_id", label: "union_id" },
    ];
    for (const item of idTypes) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.idType = item.id;
      btn.textContent = item.label;
      btn.classList.toggle("active", draft.idType === item.id);
      btn.addEventListener("click", () => {
        setFeishuFormDraftValue("idType", item.id);
        ops.requestRender({ content: true });
      });
      segmented.appendChild(btn);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("feishuApprovalApproverPlaceholder");
    input.className = "tg-approval-input";
    input.value = draft.approverId || "";
    input.addEventListener("input", () => setFeishuFormDraftValue("approverId", input.value));

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "soft-btn accent";
    saveBtn.textContent = feishuView.configPending ? t("feishuApprovalSaving") : t("feishuApprovalSaveApprover");
    saveBtn.disabled = feishuView.configPending;
    saveBtn.addEventListener("click", () => {
      const nextDraft = getFeishuFormDraft();
      const approverId = String(nextDraft.approverId || "").trim();
      const idType = ["open_id", "user_id", "union_id"].includes(nextDraft.idType) ? nextDraft.idType : "open_id";
      if (!approverId) {
        ops.showToast(t("feishuApprovalApproverEmpty"), { error: true });
        return;
      }
      saveFeishuConfig({
        ...currentFeishuConfig(),
        idType,
        approverId,
      });
    });

    ctrl.appendChild(segmented);
    ctrl.appendChild(input);
    ctrl.appendChild(saveBtn);
    row.appendChild(ctrl);
    return row;
  }

  // ── Feishu: Enable + Test ──

  function feishuSetupProgress() {
    const secretsConfigured = !!(feishuView.secretInfo && feishuView.secretInfo.configured)
      || (feishuView.status && feishuView.status.secretsStored === true);
    const cfg = currentFeishuConfig();
    const approverConfigured = !!cfg.approverId;
    return { secretsConfigured, approverConfigured, ready: secretsConfigured && approverConfigured };
  }

  function buildFeishuStep3Section() {
    const { secretsConfigured, approverConfigured, ready } = feishuSetupProgress();
    const rows = [];
    if (!ready) {
      rows.push(buildFeishuPrerequisitesRow({ secretsConfigured, approverConfigured }));
    }
    rows.push(buildFeishuEnabledRow({ ready }));
    rows.push(buildFeishuTimeoutRow());
    return helpers.buildSection(t("feishuApprovalStep3Title"), rows);
  }

  function buildFeishuStep4Section() {
    const { ready } = feishuSetupProgress();
    return helpers.buildSection(t("feishuApprovalStep4Title"), [
      buildFeishuEventSubRow(),
      buildFeishuTestRow({ ready }),
    ]);
  }

  function buildFeishuPrerequisitesRow({ secretsConfigured, approverConfigured }) {
    const row = document.createElement("div");
    row.className = "row tg-approval-prereq-row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("feishuApprovalPrereqLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    const missing = [];
    if (!secretsConfigured) missing.push(t("feishuApprovalPrereqMissingSecrets"));
    if (!approverConfigured) missing.push(t("feishuApprovalPrereqMissingApprover"));
    desc.textContent = t("feishuApprovalPrereqDesc") + " " + missing.join(", ");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);
    return row;
  }

  function buildFeishuEnabledRow({ ready }) {
    const cfg = currentFeishuConfig();
    const row = document.createElement("div");
    row.className = "row";
    if (!ready) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("feishuApprovalToggle");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("feishuApprovalToggleDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const sw = document.createElement("div");
    sw.className = "switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("tabindex", "0");
    helpers.setSwitchVisual(sw, cfg.enabled, { pending: feishuView.configPending });
    if (!ready) {
      sw.classList.add("disabled");
      sw.setAttribute("aria-disabled", "true");
      sw.removeAttribute("tabindex");
    } else {
      const toggle = () => saveFeishuConfig({ ...cfg, enabled: !cfg.enabled }, { resetDraft: false });
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

  function buildFeishuTimeoutRow() {
    const cfg = currentFeishuConfig();
    const row = document.createElement("div");
    row.className = "row feishu-approval-timeout-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("feishuApprovalConnectionTimeout");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("feishuApprovalConnectionTimeoutDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const select = document.createElement("select");
    select.className = "tg-approval-input tg-approval-output-select feishu-approval-timeout-select";
    select.disabled = feishuView.configPending;
    for (const value of [5, 10, 15, 30, 60]) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = t("feishuApprovalConnectionTimeoutOption").replace("{seconds}", String(value));
      select.appendChild(option);
    }
    select.value = String(cfg.connectionTimeoutSeconds);
    select.addEventListener("change", () => {
      const nextTimeout = Number(select.value);
      if (![5, 10, 15, 30, 60].includes(nextTimeout) || nextTimeout === cfg.connectionTimeoutSeconds) return;
      saveFeishuConfig({ ...cfg, connectionTimeoutSeconds: nextTimeout }, { resetDraft: false });
    });
    ctrl.appendChild(select);
    row.appendChild(ctrl);
    return row;
  }

  function buildFeishuTestRow({ ready }) {
    const s = feishuView.status || {};
    const runtimeReady = s.configured === true;
    const testDisabled = feishuView.testPending || !ready || !runtimeReady;
    const row = document.createElement("div");
    row.className = "row";
    if (!ready) row.classList.add("tg-approval-row-disabled");

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("feishuApprovalTest");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("feishuApprovalTestDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "soft-btn accent";
    btn.textContent = feishuView.testPending ? t("feishuApprovalTesting") : t("feishuApprovalSendTest");
    btn.disabled = testDisabled;
    if (testDisabled && !feishuView.testPending) {
      btn.title = (s.message && String(s.message)) || t("feishuApprovalCardMissingBoth");
    }
    btn.addEventListener("click", () => {
      if (testDisabled) return;
      feishuView.testPending = true;
      ops.requestRender({ content: true });
      callCommand("feishuApproval.test").then((result) => {
        feishuView.testPending = false;
        if (result && result.status === "ok") {
          ops.showToast(t("feishuApprovalTestSent"));
        } else {
          const code = result && result.code;
          const codeKey = code === "no-button-response" ? "feishuApprovalTestNoResponse"
            : code === "not-connected" ? "feishuApprovalTestNotConnected"
            : code === "card-send-failed" ? "feishuApprovalTestSendFailed"
            : "";
          let text = codeKey ? t(codeKey) : ((result && result.message) || t("feishuApprovalTestFailed"));
          // Surface the SDK error for send failures — it usually names the
          // culprit directly (e.g. invalid receive_id for a bad approver id).
          if (code === "card-send-failed" && result.message) text += ` (${result.message})`;
          ops.showToast(text, { error: true });
        }
        feishuView.status = null;
        refreshFeishuStatus({ forceRender: true });
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

  function saveFeishuConfig(next, options = {}) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return;
    }
    feishuView.configPending = true;
    ops.requestRender({ content: true });
    window.settingsAPI.update("feishuApproval", next).then((result) => {
      feishuView.configPending = false;
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("toastSaveFailed"), { error: true });
        ops.requestRender({ content: true });
        return;
      }
      ops.showToast(t("feishuApprovalConfigSaved"));
      if (options.resetDraft !== false) resetFeishuFormDraft();
      feishuView.status = null;
      refreshFeishuStatus({ forceRender: true });
    }).catch((err) => {
      feishuView.configPending = false;
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
  // expand whitelisted https://t.me/* and https://open.feishu.cn/* links so a
  // malicious translation can't inject arbitrary HTML.
  function escapeWithLink(text) {
    const raw = String(text == null ? "" : text);
    const parts = [];
    let lastIdx = 0;
    const re = /\[([^\]]+)\]\((https:\/\/(?:t\.me|open\.feishu\.cn)\/[A-Za-z0-9_./?#=&-]+)\)/g;
    let match;
    while ((match = re.exec(raw)) !== null) {
      parts.push(escapeHtml(raw.slice(lastIdx, match.index)));
      parts.push(`<a href="${escapeHtml(match[2])}">${escapeHtml(match[1])}</a>`);
      lastIdx = match.index + match[0].length;
    }
    parts.push(escapeHtml(raw.slice(lastIdx)));
    return parts.join("");
  }

  // Route clicks through the main-process shell.openExternal; a plain
  // target="_blank" would make Electron pop a bare BrowserWindow instead of
  // the user's browser.
  function bindExternalLinks(el) {
    for (const a of el.querySelectorAll("a[href]")) {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        helpers.openExternalSafe(a.href);
      });
    }
  }

  function init(core) {
    coreRef = core;
    state = core.state;
    helpers = core.helpers;
    ops = core.ops;
    core.tabs["telegram-approval"] = { render, refreshRuntimeStatus };
  }

  root.ClawdSettingsTabTelegramApproval = { init };
})(globalThis);
