"use strict";

// Remote approval bodies for the Permissions & approval tab: the IM channels
// sub-page (Telegram / Feishu / Slack cards) and the LAN approval card, plus
// their status refreshes and the Feishu lookup/draft cleanup on leave. This
// module does not register a tab of its own; the shell resolves it at render
// time, so load order in settings.html does not matter.
(function initSettingsTabTelegramApproval(root) {
  const recipientApi = root.ClawdFeishuApprovalRecipient || {};
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
    secretEditing: false,
    configPersistencePending: false,
    configPersistenceKind: null,
    testPending: false,
    refreshTimer: null,
    formDraft: null,
    formDirty: false,
    secretDraft: null,
    networkLookupPending: false,
    lookupCancelPending: false,
    lookupErrorCode: "",
    lookupResultErrorCode: "",
    lookupEpoch: 0,
    expandApproverFallbackGuide: false,
  };

  // Feishu (China) and Lark (International) are one channel, one component —
  // only the SDK domain, the console URL and the brand word differ. The list is
  // closed on purpose: a user can never point this at an arbitrary host,
  // because the App Secret travels to whatever it names.
  const FEISHU_PLATFORMS = ["feishu", "lark"];
  const FEISHU_CONSOLE_URLS = Object.freeze({
    feishu: "https://open.feishu.cn/app",
    lark: "https://open.larksuite.com/app",
  });
  const FEISHU_API_EXPLORER_URLS = Object.freeze({
    feishu: "https://open.feishu.cn/api-explorer?project=contact&resource=user&apiName=batch_get_id&version=v3",
    lark: "https://open.larksuite.com/api-explorer?project=contact&resource=user&apiName=batch_get_id&version=v3",
  });

  const TELEGRAM_VERIFICATION_ERROR_KEYS = Object.freeze({
    "401": "telegramApprovalVerificationInvalidToken",
    "403": "telegramApprovalVerificationForbidden",
    "400": "telegramApprovalVerificationInvalidRecipient",
    no_chat: "telegramApprovalVerificationInvalidRecipient",
    "409_conflict": "telegramApprovalVerificationPollingConflict",
    "409_webhook": "telegramApprovalVerificationWebhookConflict",
    "429": "telegramApprovalVerificationRateLimited",
    network: "telegramApprovalVerificationNetwork",
    timeout: "telegramApprovalVerificationTimeout",
    token_missing: "telegramApprovalVerificationTokenMissing",
    "native-start-failed": "telegramApprovalVerificationApplyFailed",
    "apply-failed": "telegramApprovalVerificationApplyFailed",
  });

  // Stable failure codes -> localized, brand-aware copy. The readiness() reasons
  // (disabled / missing-secret / invalid-config / invalid-secret / not-running)
  // used to fall through to main's raw English message, which named Feishu and
  // so read as nonsense to a correctly configured Lark user.
  const FEISHU_CONFIGURATION_ERROR_KEYS = Object.freeze({
    "missing-credentials": "feishuApprovalLookupMissingCredentials",
    "invalid-app-id": "feishuApprovalLookupInvalidAppId",
    "credential-provenance-unknown": "feishuApprovalLookupCredentialProvenanceUnknown",
    "credential-platform-mismatch": "feishuApprovalLookupCredentialPlatformMismatch",
    "missing-approver": "feishuApprovalApproverNotConfigured",
    "approver-provenance-unknown": "feishuApprovalLookupApproverProvenanceUnknown",
    "approver-binding-incomplete": "feishuApprovalLookupApproverBindingIncomplete",
    "approver-platform-mismatch": "feishuApprovalLookupApproverPlatformMismatch",
    "approver-app-mismatch": "feishuApprovalLookupApproverAppMismatch",
    "lookup-requires-open-id": "feishuApprovalLookupRequiresOpenId",
  });

  const FEISHU_TEST_ERROR_KEYS = Object.freeze({
    ...FEISHU_CONFIGURATION_ERROR_KEYS,
    "no-button-response": "feishuApprovalTestNoResponse",
    "not-connected": "feishuApprovalTestNotConnected",
    "card-send-failed": "feishuApprovalTestSendFailed",
    "disabled": "feishuApprovalErrorDisabled",
    "missing-secret": "feishuApprovalErrorMissingSecret",
    "invalid-config": "feishuApprovalErrorInvalidConfig",
    "invalid-secret": "feishuApprovalErrorInvalidSecret",
    "not-running": "feishuApprovalErrorNotRunning",
  });

  const FEISHU_APPROVER_LOOKUP_ERROR_KEYS = Object.freeze({
    ...FEISHU_CONFIGURATION_ERROR_KEYS,
    "empty-approver": "feishuApprovalApproverEmpty",
    "invalid-approver-id": "feishuApprovalApproverInvalidId",
    "invalid-platform": "feishuApprovalLookupInvalidPlatform",
    "invalid-email": "feishuApprovalLookupInvalidEmail",
    "unsaved-credentials": "feishuApprovalLookupUnsavedCredentials",
    "incomplete-credentials": "feishuApprovalLookupIncompleteCredentials",
    "missing-contact-scope": "feishuApprovalLookupMissingContactScope",
    "approver-not-found": "feishuApprovalLookupApproverNotFound",
    "lookup-cancelled": "feishuApprovalLookupCancelled",
    "lookup-superseded": "feishuApprovalLookupSuperseded",
    "lookup-credentials-changed": "feishuApprovalLookupCredentialsChanged",
    "lookup-failed": "feishuApprovalLookupFailed",
  });

  // Connection failures Clawd raises itself. Anything not listed here came from
  // the SDK and has no key to translate to.
  const FEISHU_CONNECTION_ERROR_KEYS = Object.freeze({
    "connection-timeout": "feishuApprovalErrorConnectionTimeout",
    "reconnect-timeout": "feishuApprovalErrorReconnectTimeout",
    // The platform gateway rejected the app outright: the picker is on the
    // wrong deployment. Raw SDK text for this reads
    // "pullConnectConfig failed: code=1000040351, msg=Incorrect domain name",
    // which never tells the user what to actually do.
    "wrong-platform": "feishuApprovalErrorWrongPlatform",
  });

  const FEISHU_APPROVER_PREFLIGHT_STATUS_ID = "feishu-approval-approver-preflight-status";
  let mountedFeishuApproverControl = null;
  let mountedFeishuTimeoutControl = null;

  // readiness() rejects a saved-but-unusable config with a stable reason while
  // every field looks filled in. Without this the card cheerfully reports
  // "credentials saved, flip the switch" next to a disabled test button, and the
  // only clue is an untranslated tooltip. Returns "" when there is nothing to
  // report so callers keep their normal copy.
  //
  // "disabled" is deliberately excluded: fields can be saved and perfectly valid
  // while the switch is simply off, which is exactly what ReadyToEnable is for.
  function feishuBlockingReasonMessage() {
    const s = feishuView.status || {};
    if (s.configured === true) return "";
    if (s.reason === "disabled") return "";
    const key = FEISHU_TEST_ERROR_KEYS[s.reason];
    return key ? tBrand(key) : "";
  }

  function feishuRuntimeErrorMessage() {
    const s = feishuView.status || {};
    const key = FEISHU_CONNECTION_ERROR_KEYS[s.errorCode];
    if (key) {
      return interpolate(tBrand(key), "{seconds}", String(s.connectionTimeoutSeconds || 15));
    }
    // Untranslated on purpose: an SDK failure string is arbitrary upstream text,
    // and showing it beats hiding the user's only diagnostic.
    return s.message || tBrand("feishuApprovalCardFailed");
  }

  function t(key) {
    return helpers.t(key);
  }

  function telegramVerificationFailureMessage(source) {
    const failure = source && typeof source === "object" ? source : {};
    const outcome = typeof failure.failureOutcome === "string"
      ? failure.failureOutcome
      : "";
    const errorCode = typeof failure.errorCode === "string"
      ? failure.errorCode
      : "";
    if (outcome === "timeout") {
      return t("telegramApprovalVerificationTimeout");
    }
    const key = Object.prototype.hasOwnProperty.call(TELEGRAM_VERIFICATION_ERROR_KEYS, errorCode)
      ? TELEGRAM_VERIFICATION_ERROR_KEYS[errorCode]
      : "";
    if (key) return t(key);
    if (outcome === "native-start-failed") {
      return t("telegramApprovalVerificationApplyFailed");
    }
    return t("telegramApprovalCardFailed");
  }

  function feishuBrand(platform) {
    return t(platform === "lark" ? "feishuApprovalBrandLark" : "feishuApprovalBrandFeishu");
  }

  // Brand-aware copy for the Feishu/Lark card. Strings carry a {brand} token
  // rather than a hardcoded product name, so the same string renders correctly
  // on either platform. split/join (not replace) because the replacement-string
  // form of replace would reinterpret $-sequences, and it must swap EVERY
  // occurrence. A no-op for keys without the token, so it is safe to use for
  // the whole section.
  function tBrand(key, platform) {
    const brand = feishuBrand(platform === undefined ? currentFeishuConfig().platform : platform);
    return String(t(key)).split("{brand}").join(brand);
  }

  // Guide steps additionally carry {consoleUrl}. Interpolating before
  // escapeWithLink is safe and deliberate: the URL comes from the closed map
  // above, and escapeWithLink's host whitelist still gates whatever lands here.
  function feishuGuideText(key) {
    const platform = currentFeishuConfig().platform;
    const consoleUrl = FEISHU_CONSOLE_URLS[platform] || FEISHU_CONSOLE_URLS.feishu;
    return tBrand(key, platform).split("{consoleUrl}").join(consoleUrl);
  }

  function feishuApiExplorerGuideText(key) {
    const platform = currentFeishuConfig().platform;
    const apiExplorerUrl = FEISHU_API_EXPLORER_URLS[platform] || FEISHU_API_EXPLORER_URLS.feishu;
    return tBrand(key, platform).split("{apiExplorerUrl}").join(apiExplorerUrl);
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
      // Configs written before the platform field existed carry no value here.
      // They were implicitly Feishu, so that is what they must keep rendering.
      platform: cfg && cfg.platform === "lark" ? "lark" : "feishu",
      idType: cfg && typeof cfg.idType === "string" ? cfg.idType : "open_id",
      approverId: cfg && typeof cfg.approverId === "string" ? cfg.approverId : "",
      approverSource: cfg && (cfg.approverSource === "lookup" || cfg.approverSource === "manual")
        ? cfg.approverSource
        : cfg && cfg.approverId
          ? "unknown"
          : "none",
      approverBoundPlatform: cfg && typeof cfg.approverBoundPlatform === "string"
        ? cfg.approverBoundPlatform
        : "",
      approverBoundAppId: cfg && typeof cfg.approverBoundAppId === "string"
        ? cfg.approverBoundAppId
        : "",
      connectionTimeoutSeconds: [5, 10, 15, 30, 60].includes(timeout) ? timeout : 15,
    };
  }

  function feishuLookupPending() {
    return feishuView.networkLookupPending;
  }

  function allFeishuControlsBlocked() {
    return feishuLookupPending()
      || feishuView.configPersistencePending
      || feishuView.testPending;
  }

  function allowlistedFeishuLookupErrorCode(code, fallback = "missing-credentials") {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(FEISHU_APPROVER_LOOKUP_ERROR_KEYS, code)
      ? code
      : fallback;
  }

  function feishuLookupPreflightErrorCode() {
    const draft = getFeishuFormDraft();
    const idType = ["open_id", "user_id", "union_id"].includes(draft.idType) ? draft.idType : "open_id";
    const value = String(draft.approverId || "").trim();
    const recipient = recipientApi.classifyFeishuApprovalRecipient(value, idType);
    if (recipient.kind === "manual") return "";
    if (recipient.kind === "empty") {
      return feishuView.lookupErrorCode === "empty-approver" ? "empty-approver" : "";
    }
    if (allFeishuControlsBlocked()) return "";
    if (recipient.kind !== "email") {
      return recipient.code === "invalid-approver-id" ? "invalid-approver-id" : "invalid-email";
    }
    if (hasUnsavedFeishuCredentialDrafts()) return "unsaved-credentials";

    const status = feishuView.status || {};
    const info = feishuView.secretInfo || {};
    if (!info.configured) {
      return allowlistedFeishuLookupErrorCode(status.credentialReason || "missing-credentials");
    }
    if (info.credentialPlatform !== "feishu" && info.credentialPlatform !== "lark") {
      return "credential-provenance-unknown";
    }
    if (info.credentialPlatform !== currentFeishuConfig().platform) {
      return "credential-platform-mismatch";
    }
    if (status.credentialReady !== true) {
      return allowlistedFeishuLookupErrorCode(status.credentialReason || "missing-credentials");
    }
    return "";
  }

  function feishuLookupPreflightMessage(code) {
    const key = FEISHU_APPROVER_LOOKUP_ERROR_KEYS[code];
    return key ? tBrand(key) : "";
  }

  function feishuApproverValueInvalid(code) {
    return code === "invalid-email" || code === "invalid-approver-id" || code === "empty-approver";
  }

  function patchMountedFeishuApproverPreflight(code) {
    const mounted = mountedFeishuApproverControl;
    if (!mounted || !document.body.contains(mounted.row)) return false;
    if (mounted.renderedAsLookupCancel && feishuView.networkLookupPending) return false;
    const statusCode = code || feishuView.lookupResultErrorCode;
    const message = feishuLookupPreflightMessage(statusCode);
    helpers.setButtonState(mounted.saveButton, {
      disabled: mounted.renderedAsLookupCancel
        ? true
        : allFeishuControlsBlocked() || !!code,
    });
    mounted.status.textContent = message;
    if (message) {
      if (!mounted.renderedAsLookupCancel) {
        mounted.saveButton.setAttribute("aria-describedby", mounted.status.id);
      }
      helpers.setTextInputState(mounted.input, {
        describedBy: `${mounted.descriptionId} ${mounted.status.id}`,
        invalid: feishuApproverValueInvalid(statusCode),
      });
    } else {
      if (!mounted.renderedAsLookupCancel) {
        mounted.saveButton.removeAttribute("aria-describedby");
      }
      helpers.setTextInputState(mounted.input, {
        describedBy: mounted.descriptionId,
        invalid: false,
      });
    }
    return true;
  }

  function requestFeishuLookupResultRender(lookupEpoch) {
    let finished = false;
    let fallbackTimer = null;
    const renderOnce = () => {
      if (finished) return;
      finished = true;
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
      if (lookupEpoch !== feishuView.lookupEpoch) return;
      ops.requestRender({ content: true });
    };
    // Let the already-mounted role=status survive one paint with its new text
    // before the fallback guide and ID-type controls rebuild the row.
    fallbackTimer = setTimeout(renderOnce, 100);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(renderOnce));
    }
  }

  function recomputeFeishuLookupPreflight() {
    const next = allowlistedFeishuLookupErrorCode(feishuLookupPreflightErrorCode(), "");
    feishuView.lookupErrorCode = next;
    patchMountedFeishuApproverPreflight(next);
    return next;
  }

  function feishuSetupReasonMessage(setupReason) {
    const key = FEISHU_CONFIGURATION_ERROR_KEYS[setupReason];
    return key ? tBrand(key) : "";
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
    if (allFeishuControlsBlocked()) return;
    const draft = getFeishuFormDraft();
    draft[key] = value;
    feishuView.formDirty = true;
    feishuView.lookupResultErrorCode = "";
    recomputeFeishuLookupPreflight();
  }

  function resetFeishuFormDraft() {
    feishuView.lookupEpoch += 1;
    feishuView.networkLookupPending = false;
    feishuView.lookupCancelPending = false;
    feishuView.formDraft = null;
    feishuView.formDirty = false;
    feishuView.lookupErrorCode = "";
    feishuView.lookupResultErrorCode = "";
  }

  function getFeishuSecretDraft() {
    if (!feishuView.secretDraft) {
      feishuView.secretDraft = {
        appId: "",
        appSecret: "",
        verificationToken: "",
        encryptKey: "",
      };
    }
    return feishuView.secretDraft;
  }

  function resetFeishuSecretDraft() {
    feishuView.secretDraft = null;
  }

  function clearFeishuSecretEditingState() {
    resetFeishuSecretDraft();
    feishuView.secretEditing = false;
  }

  function hasUnsavedFeishuCredentialDrafts() {
    if (!feishuView.secretEditing && feishuView.secretInfo && feishuView.secretInfo.configured) return false;
    const draft = getFeishuSecretDraft();
    return [draft.appId, draft.appSecret, draft.verificationToken, draft.encryptKey]
      .some((value) => !!String(value || "").trim());
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

  // Status refreshes only repaint when their cards are on screen: the
  // Permissions tab is active and the user is on the IM channels or LAN sub-page.
  function isRemoteBodyVisible() {
    return state.activeTab === "permissions" && coreRef.runtime.permissionsSubtab !== "local";
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
      if ((shouldForceRender || (updated && (!hadStatus || changed))) && isRemoteBodyVisible()) {
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
      if ((shouldForceRender || (updated && changed)) && isRemoteBodyVisible()) {
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
      recomputeFeishuLookupPreflight();
      scheduleFeishuStatusRefresh(nextStatus);
      const initialVisibleChange = !hadStatus && feishuStatusNeedsRender(nextStatus);
      if ((shouldForceRender || (updated && (initialVisibleChange || (hadStatus && changed)))) && isRemoteBodyVisible()) {
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
    if (!isRemoteBodyVisible() || s.status !== "starting" || typeof setTimeout !== "function") return;
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
        credentialPlatform: result.credentialPlatform === "feishu" || result.credentialPlatform === "lark"
          ? result.credentialPlatform
          : "unknown",
        appId: result.appId || "",
        appSecret: result.appSecret || "",
        verificationToken: result.verificationToken || "",
        encryptKey: result.encryptKey || "",
      } : previous;
      const shouldForceRender = forceRender || feishuView.secretInfoForceRenderPending;
      feishuView.secretInfoForceRenderPending = false;
      const changed = updated && feishuSecretInfoRenderKey(previous) !== feishuSecretInfoRenderKey(next);
      if (updated) feishuView.secretInfo = next;
      recomputeFeishuLookupPreflight();
      const initialVisibleChange = !previous && feishuSecretInfoNeedsRender(next);
      if ((shouldForceRender || (updated && (initialVisibleChange || (previous && changed)))) && isRemoteBodyVisible()) {
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
      s.errorCode || "",
      s.failureOutcome || "",
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
      s.errorCode || "",
      s.secretsStored === true ? "1" : "0",
      // Without this, going from "App ID only" to "App ID + App Secret" would
      // not repaint: every other field in the key stays put.
      s.secretsConfigured === true ? "1" : "0",
      s.credentialReady === true ? "1" : "0",
      s.credentialReason || "",
      s.configurationReady === true ? "1" : "0",
      s.setupReason || "",
    ].join("");
  }

  function feishuSecretInfoRenderKey(info) {
    const i = info && typeof info === "object" ? info : {};
    return [
      i.configured === true ? "1" : "0",
      i.credentialPlatform || "unknown",
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

  function renderChannelsBody(parent) {
    refreshStatus();
    refreshTokenInfo();
    refreshFeishuStatus();
    refreshFeishuSecretInfo();
    refreshSlackStatus();
    refreshSlackSecretInfo();
    // The native-only snapshot controls both the upgrade gate and the Step-3
    // enable switch, so keep it live even while another status request is in
    // flight.
    refreshMigrationSnapshot();

    const subtitle = document.createElement("p");
    subtitle.className = "subtitle";
    subtitle.textContent = t("permissionsChannelsIntro");
    parent.appendChild(subtitle);

    // Each remote approval channel renders as its own collapsible card so the
    // page can stay tidy as external approval channels grow.
    parent.appendChild(buildTelegramChannelCard());
    parent.appendChild(buildFeishuChannelCard());
    parent.appendChild(buildSlackChannelCard());
  }

  function renderLanBody(parent) {
    parent.appendChild(buildMobileChannelCard());
  }

  function refreshRuntimeStatus(payload) {
    if (!payload) return false;
    if (payload.channel === "feishu") {
      refreshFeishuStatus({ forceRender: true });
      return true;
    }
    if (payload.channel === "slack") {
      refreshSlackStatus({ forceRender: true });
      refreshSlackSecretInfo({ forceRender: true });
      return true;
    }
    if (payload.channel === "telegram") {
      refreshMigrationSnapshot();
      refreshStatus({ forceRender: true });
      return true;
    }
    return false;
  }

  // ── Migration state plumbing (runtime, not UI) ────────────────────────────
  // v0.14 retires the legacy transport. Historical prefs route to an explicit
  // native-verification gate; there is no legacy runtime or fallback.
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
      || s === "TESTING_NATIVE";
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
    return s === "IDLE" || s === "NEEDS_SETUP" || s === "NATIVE_MIGRATION_REQUIRED";
  }

  function statusIndicatesNativeApprovalActive() {
    const s = view.status || {};
    return s.transport === "native"
      && (s.enabled === true || s.status === "running" || s.status === "starting");
  }

  function effectiveTelegramApprovalEnabled(cfg) {
    const s = migrationState();
    if (s === "NATIVE_MIGRATION_REQUIRED" || s === "NEEDS_SETUP") return false;
    return isNativeMigrationActive()
      || statusIndicatesNativeApprovalActive()
      || (!migrationSnapshot && !!(cfg && cfg.enabled));
  }

  function migrationSnapshotRenderKey(snapshot) {
    const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
    const owner = snap.ownerSnapshot && typeof snap.ownerSnapshot === "object"
      ? snap.ownerSnapshot
      : {};
    return [
      snap.state || "",
      snap.transport || "",
      snap.revision || 0,
      snap.testOrigin || "",
      owner.nativePolling === true ? "1" : "0",
      snap.nativeVerifiedAt || "",
      snap.lastTestResult ? JSON.stringify(snap.lastTestResult) : "",
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
          && isRemoteBodyVisible()) {
          ops.requestRender({ content: true });
        }
      }
    });
  }

  function migrationDispatch(eventType) {
    if (migrationPending) return;
    migrationPending = true;
    callCommand("telegramMigration.dispatch", { type: eventType }).then((res) => {
      migrationPending = false;
      if (res && res.snapshot) migrationSnapshot = res.snapshot;
      if (res && res.status !== "ok" && res.errorCode) {
        ops.showToast(interpolate(t("telegramMigrationErrorToast"), "{code}", res.errorCode), { error: true });
      }
      refreshStatus({ forceRender: true });
      ops.requestRender({ content: true });
    });
  }

  // Three layers per channel card: a header with one status sentence and (once
  // configured) the enable switch; a "start setup" block or the connection /
  // notification groups; and a footer test link.
  function buildTelegramChannelCard() {
    const kind = deriveCardKind();
    const cfg = currentConfig();
    const { ready } = telegramSetupProgress();
    const configured = ready || effectiveTelegramApprovalEnabled(cfg);
    // Default-collapse the card once native polling is running — the user no
    // longer needs to see the setup steps. localStorage persists any manual
    // expand/collapse from there.
    const migrationGate = buildTelegramMigrationGate();
    const defaultCollapsed = migrationGate ? false : kind === "running";
    const header = buildChannelHeader(
      t("telegramApprovalChannelName"),
      deriveTelegramStatus(),
      "settings-telegram-approval-enabled-label",
    );

    const children = [migrationGate];
    if (!configured) {
      children.push(buildChannelSetup({
        steps: [
          [buildTokenRow()],
          [buildRecipientRow()],
        ],
        footText: t("telegramSetupFoot"),
      }));
    } else {
      const tokenRow = buildTokenRow();
      const recipientRow = buildRecipientRow();
      const completionRow = buildCompletionOutputRow();
      const directSendRow = buildDirectSendRow({ ready });
      for (const row of [tokenRow, recipientRow, completionRow, directSendRow]) {
        helpers.attachDescriptionDisclosure(row);
      }
      children.push(helpers.buildDetailGroup(t("settingsGroupConnection"), [
        tokenRow,
        recipientRow,
      ]));
      children.push(helpers.buildDetailGroup(t("settingsGroupNotifications"), [
        completionRow,
        directSendRow,
      ]));
      children.push(buildChannelTestFooter({
        available: !(!ready || !telegramRuntimeReady() || !telegramNativeReady()),
        pending: view.testPending,
        hint: t("telegramApprovalTestAfterEnable"),
        labelKey: "telegramApprovalSendTest",
        pendingLabelKey: "telegramApprovalTesting",
        onClick: sendTelegramTest,
      }));
    }

    return helpers.buildCollapsibleGroup({
      id: "remote-approval.telegram",
      headerContent: header.element,
      headerAction: configured ? buildTelegramEnabledSwitch({ ready, statusTextId: header.statusTextId }) : null,
      defaultCollapsed,
      className: "remote-approval-channel-card tg-approval-channel-card",
      children: children.filter(Boolean),
    });
  }

  function buildTelegramMigrationGate() {
    const stateName = migrationState();
    const origin = migrationSnapshot && migrationSnapshot.testOrigin;
    const required = stateName === "NATIVE_MIGRATION_REQUIRED";
    const testingFromRequired = stateName === "TESTING_NATIVE" && origin !== "idle";
    if (!required && !testingFromRequired) return null;

    const wrap = document.createElement("div");
    wrap.className = "tg-native-migration-gate";
    const eyebrow = document.createElement("div");
    eyebrow.className = "tg-native-migration-gate-eyebrow";
    eyebrow.textContent = t("telegramNativeMigrationEyebrow");
    const title = document.createElement("div");
    title.className = "tg-native-migration-gate-title";
    const needsNativeReverification = origin === "native-unverified"
      || origin === "native-verified-repair";
    title.textContent = t(needsNativeReverification
      ? "telegramNativeReverifyTitle"
      : "telegramLegacyRetiredTitle");
    const body = document.createElement("div");
    body.className = "tg-native-migration-gate-body";
    body.textContent = t(needsNativeReverification
      ? "telegramNativeReverifyBody"
      : "telegramLegacyRetiredBody");
    wrap.appendChild(eyebrow);
    wrap.appendChild(title);
    wrap.appendChild(body);

    const lastResult = migrationSnapshot && migrationSnapshot.lastTestResult;
    if (lastResult) {
      const result = document.createElement("div");
      result.className = "tg-native-migration-gate-result";
      if (lastResult.outcome === "timeout") {
        result.textContent = t("telegramNativeMigrationTimeout");
      } else if (lastResult.outcome === "native-start-failed") {
        result.textContent = t("telegramNativeMigrationStartFailed");
      } else {
        result.textContent = t("telegramNativeMigrationFailed");
      }
      wrap.appendChild(result);
    }

    const actions = document.createElement("div");
    actions.className = "tg-native-migration-gate-actions";
    const verify = helpers.buildButton({
      labelKey: testingFromRequired
        ? "telegramNativeMigrationWaiting"
        : "telegramNativeMigrationVerify",
      tone: "accent",
      size: "compact",
      disabled: migrationPending || testingFromRequired,
      pending: testingFromRequired,
    });
    verify.addEventListener("click", () => {
      if (verify.disabled) return;
      migrationDispatch("USER_TEST_NATIVE");
    });
    const disable = helpers.buildButton({
      labelKey: "telegramNativeMigrationDisable",
      size: "compact",
      disabled: migrationPending,
    });
    disable.addEventListener("click", () => migrationDispatch("USER_DISABLE"));
    const guide = helpers.buildButton({
      labelKey: "telegramNativeMigrationGuide",
      size: "compact",
    });
    guide.addEventListener("click", () => {
      helpers.openExternalSafe(
        "https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/docs/guides/telegram-approval.md"
      );
    });
    actions.appendChild(verify);
    actions.appendChild(disable);
    actions.appendChild(guide);
    wrap.appendChild(actions);
    return wrap;
  }

  function buildFeishuChannelCard() {
    const kind = deriveFeishuCardKind();
    const cfg = currentFeishuConfig();
    const { ready } = feishuSetupProgress();
    const configured = ready || cfg.enabled;
    const defaultCollapsed = kind === "running";
    const header = buildChannelHeader(
      t("feishuApprovalChannelName"),
      deriveFeishuStatus(),
      "settings-feishu-approval-enabled-label",
    );

    const children = [];
    if (!configured) {
      children.push(buildChannelSetup({
        steps: [
          [buildFeishuPlatformRow(), buildFeishuSecretsRow()],
          [buildFeishuApproverRow(), buildFeishuApproverFallbackGuide()],
        ],
        footText: tBrand("feishuSetupFoot"),
      }));
      children.push(buildFeishuEventSubRow());
    } else {
      const platformRow = buildFeishuPlatformRow();
      const secretsRow = buildFeishuSecretsRow();
      const approverRow = buildFeishuApproverRow();
      const timeoutRow = buildFeishuTimeoutRow();
      for (const row of [platformRow, secretsRow, approverRow, timeoutRow]) {
        helpers.attachDescriptionDisclosure(row);
      }
      // Order matters: Feishu only saves the long-connection subscription
      // mode while a long connection is live, so the connection group (and its
      // enable switch) comes before the callback-subscription guide.
      children.push(helpers.buildDetailGroup(t("settingsGroupConnection"), [
        platformRow,
        secretsRow,
        approverRow,
        buildFeishuApproverFallbackGuide(),
      ]));
      children.push(helpers.buildDetailGroup(t("settingsGroupAdvanced"), [timeoutRow]));
      children.push(buildFeishuEventSubRow());
      children.push(buildFeishuTestFooter({ ready }));
    }

    return helpers.buildCollapsibleGroup({
      id: "remote-approval.feishu",
      headerContent: header.element,
      headerAction: configured ? buildFeishuEnabledSwitch({ ready, statusTextId: header.statusTextId }) : null,
      defaultCollapsed,
      className: "remote-approval-channel-card feishu-approval-channel-card",
      children: children.filter(Boolean),
    });
  }

  // Mobile Web channel: today a read-only LAN preview (no approval actions
  // yet — #208 tracks that), but it lives with the approval channels because
  // "I'm away from the desk" is the same user intent and that is where the
  // approval console will land.
  function buildMobileChannelCard() {
    const body = document.createElement("div");
    const mobile = root.ClawdSettingsTabMobile;
    if (mobile && typeof mobile.renderChannelBody === "function") {
      mobile.renderChannelBody(body);
    }
    return helpers.buildCollapsibleGroup({
      id: "remote-approval.mobile",
      headerContent: mobile && typeof mobile.buildChannelHeaderRow === "function"
        ? mobile.buildChannelHeaderRow()
        : buildChannelHeader(t("mobileChannelName"), deriveMobileStatus(), "settings-mobile-preview-enabled-label").element,
      // Never default-collapsed: while running the card shows the pair
      // URL/token the user needs on their phone.
      defaultCollapsed: false,
      className: "remote-approval-channel-card mobile-channel-card",
      children: [body],
    });
  }

  // Card header: the channel name, its one-line status, and (via
  // headerAction) the enable switch. Returns the status text id so the switch
  // can point aria-describedby at the sentence it sits next to.
  function buildChannelHeader(channelName, status, nameId = "") {
    const wrap = document.createElement("div");
    wrap.className = "channel-header";

    const nameEl = document.createElement("span");
    nameEl.className = "channel-name";
    if (nameId) nameEl.id = nameId;
    nameEl.textContent = channelName;
    wrap.appendChild(nameEl);

    const statusLine = helpers.buildStatusLine(status);
    const statusText = statusLine.element.querySelector(".settings-status-text");
    if (statusText && !statusText.id) {
      statusText.id = `settings-channel-status-${++channelStatusIdSeq}`;
    }
    wrap.appendChild(statusLine.element);
    return {
      element: wrap,
      statusTextId: statusText ? statusText.id : "",
    };
  }

  let channelStatusIdSeq = 0;

  // Shared three-layer building blocks for channel cards.
  function buildChannelSetup({ steps = [], footText = "" } = {}) {
    const setup = document.createElement("div");
    setup.className = "channel-setup";
    const title = document.createElement("div");
    title.className = "channel-setup-title";
    title.textContent = t("channelSetupTitle");
    setup.appendChild(title);
    for (const [index, stepRows] of steps.entries()) {
      const stepEl = document.createElement("div");
      stepEl.className = "channel-setup-step";
      const num = document.createElement("span");
      num.className = "channel-setup-num";
      num.textContent = String(index + 1);
      const body = document.createElement("div");
      body.className = "channel-setup-body";
      for (const row of stepRows) {
        if (row) body.appendChild(row);
      }
      stepEl.appendChild(num);
      stepEl.appendChild(body);
      setup.appendChild(stepEl);
    }
    if (footText) {
      const foot = document.createElement("div");
      foot.className = "channel-setup-foot";
      foot.textContent = footText;
      setup.appendChild(foot);
    }
    return setup;
  }

  // Card footer layer: a quiet test link, or the sentence explaining why it is
  // not available yet. `pending` keeps the link mounted but disabled.
  function buildChannelTestFooter({
    available,
    pending,
    hint,
    note = "",
    labelKey,
    pendingLabelKey,
    onClick,
  }) {
    const foot = document.createElement("div");
    foot.className = "channel-foot";
    if (!available) {
      const hintEl = document.createElement("span");
      hintEl.className = "channel-foot-hint";
      hintEl.textContent = hint || "";
      foot.appendChild(hintEl);
      return foot;
    }
    if (note) {
      const noteEl = document.createElement("span");
      noteEl.className = "channel-foot-note";
      noteEl.textContent = note;
      foot.appendChild(noteEl);
    }
    const link = helpers.buildButton({
      tone: "quiet",
      size: "compact",
      labelKey: pending ? pendingLabelKey : labelKey,
      className: "channel-foot-link",
      disabled: pending === true,
      pending: pending === true,
    });
    link.addEventListener("click", () => {
      if (pending || typeof onClick !== "function") return;
      onClick();
    });
    foot.appendChild(link);
    return foot;
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

  function telegramMissingSetupMessage() {
    const s = view.status || {};
    const tokenOk = !!(view.tokenInfo && view.tokenInfo.configured) || s.tokenStored === true;
    const cfg = currentConfig();
    const recipientOk = !!(cfg.allowedTgUserId && cfg.targetSessionKey);
    if (!tokenOk && !recipientOk) return t("telegramApprovalCardMissingBoth");
    if (!tokenOk) return t("telegramApprovalCardMissingToken");
    if (!recipientOk) return t("telegramApprovalCardMissingRecipient");
    return "";
  }

  function deriveCardMessage(kind) {
    const s = view.status || {};
    if (kind === "failed") {
      if (s.configured !== true) {
        const missingSetup = telegramMissingSetupMessage();
        if (missingSetup) return missingSetup;
      }
      return telegramVerificationFailureMessage(s);
    }
    if (kind === "running") return t("telegramApprovalCardRunning");
    if (kind === "starting") return t("telegramApprovalCardStarting");
    if (kind === "ready") return t("telegramApprovalCardReadyToEnable");
    // incomplete — pick the most actionable missing piece
    return telegramMissingSetupMessage() || t("telegramApprovalCardReadyToEnable");
  }

  function telegramSetupProgress() {
    const tokenConfigured = !!(view.tokenInfo && view.tokenInfo.configured)
      || !!(view.status && view.status.tokenStored === true);
    const recipientConfigured = !!currentConfig().allowedTgUserId;
    return {
      tokenConfigured,
      recipientConfigured,
      ready: tokenConfigured && recipientConfigured,
    };
  }

  function telegramRuntimeReady() {
    return !!(view.status && view.status.configured === true);
  }

  function telegramNativeReady() {
    const s = view.status || {};
    return migrationState() === "NATIVE_ACTIVE"
      && s.transport === "native"
      && s.status === "running";
  }

  function deriveTelegramStatus() {
    const kind = deriveCardKind();
    if (kind === "running") return { tone: "ok", text: t("telegramApprovalCardRunning") };
    if (kind === "starting") return { tone: "warn", text: t("telegramApprovalCardStarting") };
    if (kind === "failed") return { tone: "bad", text: deriveCardMessage("failed") };
    if (kind === "ready") return { tone: "warn", text: t("telegramApprovalCardReadyToEnable") };
    // Saving the token refreshes tokenInfo before status can catch up, so the
    // fields are complete while the kind is still incomplete; fall back to the
    // ready sentence instead of rendering an empty status.
    return {
      tone: "off",
      text: telegramMissingSetupMessage() || t("telegramApprovalCardReadyToEnable"),
    };
  }

  function deriveFeishuCardKind() {
    const s = feishuView.status || {};
    if (s.status === "running") return "running";
    if (s.status === "starting") return "starting";
    if (s.status === "failed") return "failed";
    if (s.configured === true || (s.status === "ready" && s.secretsConfigured === true)) return "ready";
    return "incomplete";
  }

  function deriveFeishuCardMessage(kind) {
    const s = feishuView.status || {};
    if (kind === "failed") return feishuRuntimeErrorMessage();
    if (kind === "running") return tBrand("feishuApprovalCardRunning");
    if (kind === "starting") return tBrand("feishuApprovalCardStarting");
    if (kind === "ready") return t("feishuApprovalCardReadyToEnable");
    const secretsOk = feishuSecretsConfigured();
    const cfg = currentFeishuConfig();
    const approverOk = !!cfg.approverId;
    if (!secretsOk && !approverOk) return t("feishuApprovalCardMissingBoth");
    if (!secretsOk) return tBrand("feishuApprovalCardMissingSecrets");
    if (!approverOk) return t("feishuApprovalCardMissingApprover");
    // Every field is filled in, but the runtime may still refuse the config —
    // e.g. an App ID that isn't a self-built id. Say that instead of claiming
    // it's ready to enable.
    return feishuBlockingReasonMessage() || t("feishuApprovalCardReadyToEnable");
  }

  function feishuSetupStatusMessage(setupReason) {
    if (setupReason === "missing-credentials" || setupReason === "missing-approver") {
      return deriveFeishuCardMessage("incomplete");
    }
    return feishuSetupReasonMessage(setupReason);
  }

  function deriveFeishuStatus() {
    const kind = deriveFeishuCardKind();
    if (kind === "running") return { tone: "ok", text: tBrand("feishuApprovalCardRunning") };
    if (kind === "starting") return { tone: "warn", text: tBrand("feishuApprovalCardStarting") };
    if (kind === "failed") return { tone: "bad", text: feishuRuntimeErrorMessage() };
    // setupReason explains disabled / credential-platform-mismatch cases that
    // feishuBlockingReasonMessage() deliberately leaves blank. Missing-field
    // reasons use the card's Missing chain so a fresh install reads like the
    // other channels instead of the approver-lookup sentence.
    const setupMessage = feishuSetupStatusMessage(feishuSetupProgress().setupReason);
    if (kind === "ready") {
      return { tone: "warn", text: setupMessage || t("feishuApprovalCardReadyToEnable") };
    }
    return { tone: "off", text: setupMessage || deriveFeishuCardMessage("incomplete") };
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
    const btn = helpers.buildButton({
      labelKey: "telegramApprovalReplaceToken",
      size: "compact",
    });
    btn.addEventListener("click", () => {
      view.tokenEditing = true;
      ops.requestRender({ content: true });
    });
    ctrl.appendChild(btn);
    row.appendChild(ctrl);
    return row;
  }

  function buildTokenEditRow({ configured, masked }) {
    const descriptionHtml = configured
      ? escapeWithLink(t("telegramApprovalTokenReplaceHintHtml"))
      : escapeWithLink(t("telegramApprovalBotTokenHintHtml"));
    const rowParts = helpers.buildSettingRow({
      labelKey: "telegramApprovalBotToken",
      description: t(configured ? "telegramApprovalTokenReplaceHintHtml" : "telegramApprovalBotTokenHintHtml"),
      className: "tg-approval-token-edit-row",
      controlClassName: "tg-approval-input-row",
    });
    const row = rowParts.element;
    const text = rowParts.textElement;
    const ctrl = rowParts.controlElement;
    rowParts.descriptionElement.textContent = "";
    rowParts.descriptionElement.innerHTML = descriptionHtml;
    bindExternalLinks(rowParts.descriptionElement);
    if (configured && masked) {
      const current = document.createElement("span");
      current.className = "tg-approval-token-current";
      current.textContent = interpolate(t("telegramApprovalTokenCurrent"), "{masked}", masked);
      text.insertBefore(current, rowParts.descriptionElement);
    }
    const input = helpers.buildTextInput({
      type: "password",
      autocomplete: "off",
      spellcheck: false,
      placeholder: t("telegramApprovalBotTokenPlaceholder"),
      className: "tg-approval-input",
      labelledBy: rowParts.labelElement.id,
      describedBy: rowParts.descriptionElement.id,
      pending: view.tokenPending,
      onEnter: () => saveBtn.click(),
      onInput: (event) => helpers.setTextInputState(event.currentTarget, { invalid: false }),
    });

    const saveBtn = helpers.buildButton({
      labelKey: view.tokenPending ? "telegramApprovalSaving" : "telegramApprovalSaveToken",
      tone: "accent",
      disabled: view.tokenPending,
      pending: view.tokenPending,
    });
    saveBtn.addEventListener("click", () => {
      const token = input.value.trim();
      if (!token) {
        helpers.setTextInputState(input, { invalid: true });
        input.focus();
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
      const cancelBtn = helpers.buildButton({
        labelKey: "telegramApprovalCancel",
        size: "compact",
        disabled: view.tokenPending,
      });
      cancelBtn.addEventListener("click", () => {
        view.tokenEditing = false;
        ops.requestRender({ content: true });
      });
      ctrl.appendChild(cancelBtn);
    }

    return row;
  }

  // ── Step 2: Recipient ──

  function buildRecipientRow() {
    const draft = getFormDraft();
    const rowParts = helpers.buildSettingRow({
      labelKey: "telegramApprovalRecipientLabel",
      description: t("telegramApprovalRecipientHintHtml"),
      className: "tg-approval-recipient-row",
      controlClassName: "tg-approval-input-row",
    });
    const row = rowParts.element;
    const ctrl = rowParts.controlElement;
    rowParts.descriptionElement.textContent = "";
    rowParts.descriptionElement.innerHTML = escapeWithLink(t("telegramApprovalRecipientHintHtml"));
    bindExternalLinks(rowParts.descriptionElement);
    const input = helpers.buildTextInput({
      type: "text",
      inputMode: "numeric",
      spellcheck: false,
      placeholder: t("telegramApprovalRecipientPlaceholder"),
      className: "tg-approval-input",
      value: draft.allowedTgUserId || "",
      labelledBy: rowParts.labelElement.id,
      describedBy: rowParts.descriptionElement.id,
      pending: view.configPending,
      onEnter: () => saveBtn.click(),
      onInput: () => {
        helpers.setTextInputState(input, { pending: view.configPending, invalid: false });
        setFormDraftValue("allowedTgUserId", input.value);
      },
    });

    const saveBtn = helpers.buildButton({
      labelKey: view.configPending ? "telegramApprovalSaving" : "telegramApprovalSaveRecipient",
      tone: "accent",
      disabled: view.configPending,
      pending: view.configPending,
    });
    saveBtn.addEventListener("click", () => {
      const raw = String(getFormDraft().allowedTgUserId || "").trim();
      if (!raw) {
        helpers.setTextInputState(input, { invalid: true });
        input.focus();
        ops.showToast(t("telegramApprovalRecipientEmpty"), { error: true });
        return;
      }
      if (!/^[1-9]\d{4,19}$/.test(raw)) {
        helpers.setTextInputState(input, { invalid: true });
        input.focus();
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
    return row;
  }

  // Header enable switch. Disable rules are unchanged from the old in-card
  // row: Telegram still requires ready, no migration debt, and either an
  // effective enable or a migration snapshot.
  function buildTelegramEnabledSwitch({ ready, statusTextId }) {
    const cfg = currentConfig();
    const effectiveEnabled = effectiveTelegramApprovalEnabled(cfg);
    const migrationRequired = migrationState() === "NATIVE_MIGRATION_REQUIRED";
    const canToggle = ready
      && !migrationRequired
      && (effectiveEnabled || migrationSnapshot);
    return helpers.buildSwitch({
      checked: effectiveEnabled,
      pending: view.configPending || migrationPending,
      disabled: !canToggle,
      ariaLabel: t("telegramApprovalToggle"),
      ariaDescribedBy: statusTextId,
      stopPropagation: true,
      onToggle: () => {
        const turningOff = effectiveEnabled === true;
        // Runtime ownership lives in the migration controller. OFF dispatches
        // USER_DISABLE; fresh/explicit-off users turn ON through the native
        // verification flow. Required legacy users use the blocking gate CTA.
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
      },
    }).element;
  }

  function sendTelegramTest() {
    if (view.testPending) return;
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
    label.id = "settings-telegram-direct-send-label";
    label.textContent = t("telegramApprovalDirectSend");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.id = "settings-telegram-direct-send-description";
    desc.textContent = t("telegramApprovalDirectSendDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const switchControl = helpers.buildSwitch({
      checked: cfg.r3DirectSendEnabled === true,
      pending: view.configPending,
      disabled: !ready,
      ariaLabelledBy: label.id,
      ariaDescribedBy: desc.id,
      onToggle: () => {
        saveConfig({ ...cfg, r3DirectSendEnabled: cfg.r3DirectSendEnabled !== true }, { resetDraft: false });
      },
    });
    ctrl.appendChild(switchControl.element);
    row.appendChild(ctrl);
    return row;
  }

  function buildCompletionOutputRow() {
    const cfg = currentConfig();
    const mode = ["off", "full"].includes(cfg.completionOutputMode)
      ? cfg.completionOutputMode
      : "off";
    const rowParts = helpers.buildSettingRow({
      labelKey: "telegramApprovalCompletionOutput",
      descriptionKey: "telegramApprovalCompletionOutputDesc",
      className: "tg-approval-completion-row",
    });
    const row = rowParts.element;
    const picker = helpers.buildSegmentedRadio({
      id: "approval-completion-output",
      value: mode,
      options: ["off", "full"].map((value) => ({
        value,
        label: t("telegramApprovalCompletionOutput_" + value),
      })),
      ariaLabel: t("telegramApprovalCompletionOutput"),
      className: "tg-approval-completion-output",
      disabled: view.configPending,
      onChange(value) {
        const nextMode = ["off", "full"].includes(value) ? value : "off";
        if (nextMode === mode) return true;
        if (nextMode === "full") {
          return helpers.showSettingsConfirmModal({
            title: t("telegramApprovalCompletionOutputFullConfirmTitle"),
            detail: t("telegramApprovalCompletionOutputFullConfirm"),
            actions: [
              {
                id: "cancel",
                label: t("telegramApprovalCancel"),
                tone: "neutral",
                defaultFocus: true,
              },
              {
                id: "confirm",
                label: t("telegramApprovalCompletionOutputFullConfirmAction"),
                tone: "danger",
              },
            ],
          }).then((actionId) => {
            if (actionId !== "confirm") return false;
            return saveConfig(
              { ...cfg, completionOutputMode: nextMode },
              { resetDraft: false }
            );
          });
        }
        return saveConfig({ ...cfg, completionOutputMode: nextMode }, { resetDraft: false });
      },
    });
    rowParts.controlElement.appendChild(picker.element);
    return row;
  }

  // ── Feishu / Lark: platform ──

  // Saves immediately (like the enable switch and the timeout select) rather
  // than joining the approver draft: the platform decides which host the
  // credentials below are even valid against, so the guide/links must follow it
  // right away. The write goes through settings-controller like every other
  // field here; the runtime notices the changed signature and reconnects both
  // the REST client and the WS long connection to the new domain.
  function buildFeishuPlatformRow() {
    const cfg = currentFeishuConfig();
    const row = document.createElement("div");
    row.className = "row feishu-approval-platform-row";

    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = t("feishuApprovalPlatformLabel");
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.textContent = t("feishuApprovalPlatformDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const picker = helpers.buildSegmentedRadio({
      id: "feishu-platform",
      ariaLabel: t("feishuApprovalPlatformLabel"),
      className: "feishu-approval-platform",
      value: cfg.platform,
      disabled: allFeishuControlsBlocked(),
      options: FEISHU_PLATFORMS.map((platform) => ({
        value: platform, label: feishuBrand(platform), dataset: { platform },
      })),
      onChange(platform) {
        if (allFeishuControlsBlocked()) return false;
        clearFeishuSecretEditingState();
        return saveFeishuConfig({ platform }, { resetDraft: false });
      },
    });
    ctrl.appendChild(picker.element);
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
    desc.textContent = tBrand("feishuApprovalSecretsConfiguredDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const btn = helpers.buildButton({
      labelKey: "feishuApprovalReplaceSecrets",
      size: "compact",
      disabled: allFeishuControlsBlocked(),
    });
    btn.addEventListener("click", () => {
      if (allFeishuControlsBlocked()) return;
      resetFeishuSecretDraft();
      feishuView.secretEditing = true;
      ops.requestRender({ content: true });
    });
    ctrl.appendChild(btn);
    row.appendChild(ctrl);
    return row;
  }

  function buildFeishuSecretsEditRow({ configured, info }) {
    const descriptionHtml = configured
      ? escapeWithLink(t("feishuApprovalSecretsReplaceHintHtml"))
      : escapeWithLink(tBrand("feishuApprovalSecretsHintHtml"));
    const rowParts = helpers.buildSettingRow({
      label: tBrand("feishuApprovalSecretsLabel"),
      description: configured
        ? t("feishuApprovalSecretsReplaceHintHtml")
        : tBrand("feishuApprovalSecretsHintHtml"),
      className: "tg-approval-token-edit-row feishu-approval-secrets-row",
      controlClassName: "tg-approval-input-row feishu-approval-secrets-grid",
    });
    const row = rowParts.element;
    const text = rowParts.textElement;
    const ctrl = rowParts.controlElement;
    rowParts.descriptionElement.textContent = "";
    rowParts.descriptionElement.innerHTML = descriptionHtml;
    bindExternalLinks(rowParts.descriptionElement);
    if (configured && info) {
      const current = document.createElement("span");
      current.className = "tg-approval-token-current";
      current.textContent = t("feishuApprovalSecretsCurrent").replace("{masked}", info.appId || "");
      text.insertBefore(current, rowParts.descriptionElement);
    }
    const submitSecretsOnEnter = () => saveBtn.click();
    const appIdInput = buildFeishuSecretInput("feishuApprovalAppIdPlaceholder", false, "appId", submitSecretsOnEnter);
    const appSecretInput = buildFeishuSecretInput("feishuApprovalAppSecretPlaceholder", true, "appSecret", submitSecretsOnEnter);
    const verificationInput = buildFeishuSecretInput(
      "feishuApprovalVerificationTokenPlaceholder",
      true,
      "verificationToken",
      submitSecretsOnEnter,
    );
    const encryptInput = buildFeishuSecretInput("feishuApprovalEncryptKeyPlaceholder", true, "encryptKey", submitSecretsOnEnter);

    const credentialPersistencePending = feishuView.configPersistencePending
      && feishuView.configPersistenceKind === "credentials";
    const saveBtn = helpers.buildButton({
      labelKey: credentialPersistencePending ? "feishuApprovalSaving" : "feishuApprovalSaveSecrets",
      tone: "accent",
      disabled: allFeishuControlsBlocked(),
      pending: credentialPersistencePending,
    });
    saveBtn.addEventListener("click", () => {
      if (allFeishuControlsBlocked()) return;
      const payload = {
        appId: appIdInput.value.trim(),
        appSecret: appSecretInput.value.trim(),
        verificationToken: verificationInput.value.trim(),
        encryptKey: encryptInput.value.trim(),
      };
      if (!configured && (!payload.appId || !payload.appSecret)) {
        helpers.setTextInputState(appIdInput, { invalid: !payload.appId });
        helpers.setTextInputState(appSecretInput, { invalid: !payload.appSecret });
        (!payload.appId ? appIdInput : appSecretInput).focus();
        ops.showToast(t("feishuApprovalSecretsRequired"), { error: true });
        return;
      }
      if (configured && !payload.appId && !payload.appSecret && !payload.verificationToken && !payload.encryptKey) {
        for (const input of [appIdInput, appSecretInput, verificationInput, encryptInput]) {
          helpers.setTextInputState(input, { invalid: true });
        }
        appIdInput.focus();
        ops.showToast(tBrand("feishuApprovalSecretsEmpty"), { error: true });
        return;
      }
      for (const input of [appIdInput, appSecretInput, verificationInput, encryptInput]) {
        helpers.setTextInputState(input, { pending: true });
      }
      helpers.setButtonState(saveBtn, { pending: true });
      saveFeishuCommand("feishuApproval.setSecrets", payload, {
        kind: "credentials",
        credentialPayload: payload,
        failureKey: "feishuApprovalSecretsSaveFailed",
        successKey: "feishuApprovalSecretsSaved",
        onSuccess() {
          clearFeishuSecretEditingState();
          feishuView.secretInfo = null;
          refreshFeishuSecretInfo({ forceRender: true });
        },
      });
    });

    ctrl.appendChild(appIdInput);
    ctrl.appendChild(appSecretInput);
    ctrl.appendChild(verificationInput);
    ctrl.appendChild(encryptInput);
    ctrl.appendChild(saveBtn);
    if (configured) {
      const cancelBtn = helpers.buildButton({
        labelKey: "telegramApprovalCancel",
        size: "compact",
        disabled: allFeishuControlsBlocked(),
      });
      cancelBtn.addEventListener("click", () => {
        if (allFeishuControlsBlocked()) return;
        clearFeishuSecretEditingState();
        ops.requestRender({ content: true });
      });
      ctrl.appendChild(cancelBtn);
    } else {
      const clearBtn = helpers.buildButton({
        labelKey: "feishuApprovalClearSecretsDraft",
        size: "compact",
        disabled: allFeishuControlsBlocked(),
      });
      clearBtn.addEventListener("click", () => {
        if (allFeishuControlsBlocked()) return;
        clearFeishuSecretEditingState();
        ops.requestRender({ content: true });
      });
      ctrl.appendChild(clearBtn);
    }
    return row;
  }

  function buildFeishuSecretInput(placeholderKey, secret, draftKey, onEnter) {
    const draft = getFeishuSecretDraft();
    const input = helpers.buildTextInput({
      type: secret ? "password" : "text",
      autocomplete: "off",
      spellcheck: false,
      placeholder: t(placeholderKey),
      className: "tg-approval-input",
      value: draft[draftKey] || "",
      ariaLabel: t(placeholderKey),
      disabled: allFeishuControlsBlocked(),
      onEnter,
      onInput: (event) => {
        helpers.setTextInputState(event.currentTarget, { invalid: false });
        if (allFeishuControlsBlocked()) return;
        getFeishuSecretDraft()[draftKey] = event.currentTarget.value;
        recomputeFeishuLookupPreflight();
      },
    });
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
      desc.innerHTML = escapeWithLink(feishuGuideText(key));
      bindExternalLinks(desc);
      text.appendChild(desc);
      row.appendChild(text);
      return row;
    });
    return helpers.buildCollapsibleGroup({
      id: "remote-approval.feishu.event-sub",
      title: t("feishuApprovalEventSubLabel"),
      desc: tBrand("feishuApprovalEventSubDesc"),
      defaultCollapsed: true,
      className: "feishu-approval-event-sub-row",
      children: steps,
    });
  }

  function buildFeishuApproverRow() {
    const cfg = currentFeishuConfig();
    const draft = getFeishuFormDraft();
    const lookupPreflightErrorCode = feishuLookupPreflightErrorCode();
    const lookupStatusCode = lookupPreflightErrorCode || feishuView.lookupResultErrorCode;
    feishuView.lookupErrorCode = lookupPreflightErrorCode;
    const rowParts = helpers.buildSettingRow({
      label: tBrand("feishuApprovalApproverLabel"),
      description: tBrand("feishuApprovalApproverHintHtml"),
      className: "tg-approval-recipient-row feishu-approval-approver-row",
      controlClassName: "tg-approval-input-row",
    });
    const row = rowParts.element;
    const text = rowParts.textElement;
    const ctrl = rowParts.controlElement;
    rowParts.descriptionElement.textContent = "";
    rowParts.descriptionElement.innerHTML = escapeWithLink(tBrand("feishuApprovalApproverHintHtml"));
    bindExternalLinks(rowParts.descriptionElement);
    // Only user_id costs an extra scope ("Get user user ID"). open_id (the
    // default) and union_id do not, so the note must not be shown for them —
    // over-warning pushes users to request permissions they don't need.
    if (draft.idType === "user_id") {
      const note = document.createElement("span");
      note.className = "row-desc feishu-approval-id-type-note";
      note.textContent = t("feishuApprovalIdTypeUserIdNote");
      text.appendChild(note);
    }
    if (cfg.approverId && cfg.approverSource === "unknown") {
      const warning = document.createElement("span");
      warning.className = "row-desc feishu-approval-reconfirmation-warning";
      warning.textContent = tBrand("feishuApprovalApproverReconfirmationWarning");
      text.appendChild(warning);
    }
    const preflightStatus = document.createElement("span");
    preflightStatus.id = FEISHU_APPROVER_PREFLIGHT_STATUS_ID;
    preflightStatus.className = "row-desc feishu-approval-lookup-preflight-status";
    preflightStatus.setAttribute("role", "status");
    preflightStatus.setAttribute("aria-live", "polite");
    preflightStatus.setAttribute("aria-atomic", "true");
    // Keep the live region mounted even while empty. display:none/hidden live
    // regions do not reliably announce text inserted at the same time they are
    // revealed; an empty mounted region stays inert until its text changes.
    preflightStatus.textContent = feishuLookupPreflightMessage(lookupStatusCode);
    text.appendChild(preflightStatus);
    const picker = helpers.buildSegmentedRadio({
      id: "feishu-id-type",
      ariaLabel: t("feishuApprovalIdTypeLabel"),
      className: "feishu-approval-id-type",
      value: draft.idType,
      disabled: allFeishuControlsBlocked(),
      options: ["open_id", "user_id", "union_id"].map((id) => ({ value: id, label: id, dataset: { idType: id } })),
      onChange(value) {
        if (allFeishuControlsBlocked()) return false;
        setFeishuFormDraftValue("idType", value);
        ops.requestRender({ content: true });
        return true;
      },
    });
    const segmented = picker.element;

    const input = helpers.buildTextInput({
      type: "text",
      autocomplete: "off",
      spellcheck: false,
      placeholder: t("feishuApprovalApproverPlaceholder"),
      className: "tg-approval-input",
      value: draft.approverId || "",
      labelledBy: rowParts.labelElement.id,
      disabled: allFeishuControlsBlocked(),
      invalid: feishuApproverValueInvalid(lookupStatusCode),
      describedBy: [
        rowParts.descriptionElement.id,
        lookupStatusCode ? preflightStatus.id : "",
      ].filter(Boolean).join(" "),
      onEnter: () => saveBtn.click(),
      onInput: () => setFeishuFormDraftValue("approverId", input.value),
    });

    const renderedAsLookupCancel = feishuView.networkLookupPending;
    const saveBtn = helpers.buildButton({
      labelKey: renderedAsLookupCancel
        ? feishuView.lookupCancelPending
          ? "feishuApprovalLookupCancelling"
          : "feishuApprovalLookupCancel"
        : "feishuApprovalSaveApprover",
      tone: "accent",
      disabled: renderedAsLookupCancel
        ? feishuView.lookupCancelPending
        : allFeishuControlsBlocked() || !!lookupPreflightErrorCode,
      pending: feishuView.lookupCancelPending,
    });
    if (preflightStatus.textContent && !renderedAsLookupCancel) {
      saveBtn.setAttribute("aria-describedby", preflightStatus.id);
    }
    saveBtn.addEventListener("click", () => {
      if (renderedAsLookupCancel) {
        if (!feishuView.lookupCancelPending) cancelFeishuApproverLookup();
        return;
      }
      if (allFeishuControlsBlocked()) return;
      const nextDraft = getFeishuFormDraft();
      const approverId = String(nextDraft.approverId || "").trim();
      const idType = ["open_id", "user_id", "union_id"].includes(nextDraft.idType) ? nextDraft.idType : "open_id";
      const recipient = recipientApi.classifyFeishuApprovalRecipient(approverId, idType);
      if (!approverId) {
        feishuView.lookupErrorCode = "empty-approver";
        patchMountedFeishuApproverPreflight("empty-approver");
        input.focus();
        ops.showToast(tBrand("feishuApprovalApproverEmpty"), { error: true });
        return;
      }
      const preflightErrorCode = feishuLookupPreflightErrorCode();
      if (preflightErrorCode) {
        feishuView.lookupErrorCode = preflightErrorCode;
        const key = FEISHU_APPROVER_LOOKUP_ERROR_KEYS[preflightErrorCode]
          || "feishuApprovalLookupFailed";
        ops.showToast(tBrand(key), { error: true });
        patchMountedFeishuApproverPreflight(preflightErrorCode);
        return;
      }
      if (recipient.kind === "email") {
        const lookupEpoch = ++feishuView.lookupEpoch;
        feishuView.lookupResultErrorCode = "";
        feishuView.networkLookupPending = true;
        feishuView.lookupCancelPending = false;
        ops.requestRender({ content: true });
        callCommand("feishuApproval.saveApproverByEmail", {
          email: recipient.email,
        }).then((result) => {
          if (lookupEpoch !== feishuView.lookupEpoch) return;
          const cancellationRequested = feishuView.lookupCancelPending;
          feishuView.networkLookupPending = false;
          feishuView.lookupCancelPending = false;
          if (result && result.status === "ok") {
            feishuView.lookupErrorCode = "";
            feishuView.lookupResultErrorCode = "";
            refreshAuthoritativeFeishuSnapshot().then((refreshed) => {
              if (lookupEpoch !== feishuView.lookupEpoch) return;
              if (!refreshed) {
                ops.showToast(tBrand("feishuApprovalPersistenceFailed"), { error: true });
                ops.requestRender({ content: true });
                return;
              }
              resetFeishuFormDraft();
              ops.showToast(tBrand("feishuApprovalConfigSaved"));
              feishuView.status = null;
              refreshFeishuStatus({ forceRender: true });
            });
            return;
          }
          const code = allowlistedFeishuLookupErrorCode(
            result && result.code,
            "lookup-failed",
          );
          feishuView.lookupResultErrorCode = code;
          if (["missing-contact-scope", "approver-not-found", "lookup-failed"].includes(code)) {
            // The API Explorer fallback always returns an app-scoped open_id.
            // Keep this draft-only: choosing the guide must not persist a
            // config change before the user pastes and explicitly saves it.
            const fallbackDraft = getFeishuFormDraft();
            fallbackDraft.idType = "open_id";
            feishuView.formDirty = true;
            feishuView.expandApproverFallbackGuide = true;
          }
          if (code !== "lookup-cancelled" || !cancellationRequested) {
            ops.showToast(tBrand(FEISHU_APPROVER_LOOKUP_ERROR_KEYS[code]), { error: true });
          }
          patchMountedFeishuApproverPreflight("");
          requestFeishuLookupResultRender(lookupEpoch);
        }).catch(() => {
          if (lookupEpoch !== feishuView.lookupEpoch) return;
          feishuView.networkLookupPending = false;
          feishuView.lookupCancelPending = false;
          feishuView.lookupResultErrorCode = "lookup-failed";
          const fallbackDraft = getFeishuFormDraft();
          fallbackDraft.idType = "open_id";
          feishuView.formDirty = true;
          feishuView.expandApproverFallbackGuide = true;
          ops.showToast(tBrand("feishuApprovalLookupFailed"), { error: true });
          patchMountedFeishuApproverPreflight("");
          requestFeishuLookupResultRender(lookupEpoch);
        });
        return;
      }
      if (recipient.kind !== "manual") {
        ops.showToast(tBrand("feishuApprovalLookupInvalidEmail"), { error: true });
        return;
      }
      saveFeishuCommand("feishuApproval.saveManualApprover", {
        idType: recipient.idType,
        approverId: recipient.approverId,
      }, {
        kind: "manual-approver",
        resetDraft: true,
      });
    });

    ctrl.appendChild(segmented);
    ctrl.appendChild(input);
    ctrl.appendChild(saveBtn);
    mountedFeishuApproverControl = {
      row,
      input,
      saveButton: saveBtn,
      status: preflightStatus,
      descriptionId: rowParts.descriptionElement.id,
      renderedAsLookupCancel,
    };
    return row;
  }

  function buildFeishuApproverFallbackGuide() {
    const rows = [
      ["feishuApprovalApiExplorerGuideDesc", false],
      ["feishuApprovalApiExplorerGuideLinkHtml", true],
      ["feishuApprovalApiExplorerGuideManual", false],
    ].map(([key, hasLink]) => {
      const row = document.createElement("div");
      row.className = "row feishu-approval-api-explorer-step";
      const text = document.createElement("div");
      text.className = "row-text";
      const desc = document.createElement("span");
      desc.className = "row-desc";
      if (hasLink) {
        desc.innerHTML = escapeWithLink(feishuApiExplorerGuideText(key));
        bindExternalLinks(desc);
      } else {
        desc.textContent = tBrand(key);
      }
      text.appendChild(desc);
      row.appendChild(text);
      return row;
    });
    const group = helpers.buildCollapsibleGroup({
      id: "remote-approval.feishu.api-explorer",
      title: t("feishuApprovalApiExplorerGuideTitle"),
      defaultCollapsed: true,
      className: "feishu-approval-api-explorer-guide",
      children: rows,
    });
    if (feishuView.expandApproverFallbackGuide) {
      feishuView.expandApproverFallbackGuide = false;
      group.expand({ persist: false, animate: false });
    }
    return group;
  }

  // ── Feishu: Enable + Test ──

  // "Configured" means App ID AND App Secret are both present — never
  // status.secretsStored, which is true for ANY stored secret and would let a
  // half-written env file (App ID only, or just a Verification Token) pass as a
  // finished setup. Both sources below agree on the both-present meaning.
  function feishuSecretsConfigured() {
    const s = feishuView.status || {};
    return !!(feishuView.secretInfo && feishuView.secretInfo.configured) || s.secretsConfigured === true;
  }

  function feishuSetupProgress() {
    const secretsConfigured = feishuSecretsConfigured();
    const cfg = currentFeishuConfig();
    const approverConfigured = !!cfg.approverId;
    const status = feishuView.status || {};
    return {
      secretsConfigured,
      approverConfigured,
      ready: status.configurationReady === true,
      configurationReady: status.configurationReady === true,
      setupReason: typeof status.setupReason === "string" ? status.setupReason : "",
    };
  }

  function buildFeishuEnabledSwitch({ ready, statusTextId }) {
    const cfg = currentFeishuConfig();
    const blocked = feishuLookupPending() || feishuView.testPending || (!cfg.enabled && !ready);
    return helpers.buildSwitch({
      checked: cfg.enabled,
      pending: feishuView.configPersistencePending,
      disabled: blocked,
      ariaLabel: tBrand("feishuApprovalToggle"),
      ariaDescribedBy: statusTextId,
      stopPropagation: true,
      onToggle: () => {
        if (allFeishuControlsBlocked()) return;
        saveFeishuConfig({ enabled: !cfg.enabled }, { resetDraft: false });
      },
    }).element;
  }

  function feishuTestHint() {
    const s = feishuView.status || {};
    return feishuSetupStatusMessage(feishuSetupProgress().setupReason)
      || feishuBlockingReasonMessage()
      || (s.status === "failed" ? feishuRuntimeErrorMessage() : "")
      || t("feishuApprovalTestAfterEnable");
  }

  function buildFeishuTestFooter({ ready }) {
    const s = feishuView.status || {};
    const runtimeReady = s.configured === true;
    return buildChannelTestFooter({
      available: ready && runtimeReady,
      pending: feishuView.testPending
        || feishuLookupPending()
        || feishuView.configPersistencePending,
      hint: feishuTestHint(),
      labelKey: "feishuApprovalSendTest",
      pendingLabelKey: "feishuApprovalTesting",
      onClick: sendFeishuTest,
    });
  }

  function sendFeishuTest() {
    if (feishuView.testPending) return;
    feishuView.testPending = true;
    ops.requestRender({ content: true });
    callCommand("feishuApproval.test").then((result) => {
      feishuView.testPending = false;
      if (result && result.status === "ok") {
        ops.showToast(tBrand("feishuApprovalTestSent"));
      } else {
        const code = result && result.code;
        const codeKey = FEISHU_TEST_ERROR_KEYS[code] || "";
        let text = codeKey ? tBrand(codeKey) : ((result && result.message) || tBrand("feishuApprovalTestFailed"));
        // Surface the SDK error for send failures — it usually names the
        // culprit directly (e.g. invalid receive_id for a bad approver id).
        if (code === "card-send-failed" && result.message) text += ` (${result.message})`;
        ops.showToast(text, { error: true });
      }
      feishuView.status = null;
      refreshFeishuStatus({ forceRender: true });
    });
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
    desc.textContent = tBrand("feishuApprovalConnectionTimeoutDesc");
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const picker = helpers.buildSettingsSelect({
      value: String(cfg.connectionTimeoutSeconds),
      options: [5, 10, 15, 30, 60].map((value) => ({
        value: String(value),
        label: t("feishuApprovalConnectionTimeoutOption").replace("{seconds}", String(value)),
      })),
      ariaLabel: t("feishuApprovalConnectionTimeout"),
      className: "feishu-approval-timeout-select",
      focusKey: "feishu-approval-connection-timeout",
      disabled: allFeishuControlsBlocked(),
      onChange(value) {
        if (allFeishuControlsBlocked()) return false;
        const nextTimeout = Number(value);
        if (![5, 10, 15, 30, 60].includes(nextTimeout)) return false;
        if (nextTimeout === cfg.connectionTimeoutSeconds) return true;
        return saveFeishuConfig(
          { connectionTimeoutSeconds: nextTimeout },
          { resetDraft: false, preserveMountedControl: true }
        );
      },
    });
    mountedFeishuTimeoutControl = { row, picker };
    ctrl.appendChild(picker.element);
    row.appendChild(ctrl);
    return row;
  }

  // ── Save / shared ──

  function cancelFeishuApproverLookup({ bestEffort = false } = {}) {
    if (!feishuView.networkLookupPending) return Promise.resolve(false);
    if (bestEffort) {
      feishuView.lookupCancelPending = true;
      callCommand("feishuApproval.cancelApproverLookup");
      return Promise.resolve(true);
    }
    const lookupEpoch = feishuView.lookupEpoch;
    feishuView.lookupCancelPending = true;
    ops.requestRender({ content: true });
    return callCommand("feishuApproval.cancelApproverLookup").then((result) => {
      const ok = !!(result && result.status === "ok");
      if (lookupEpoch !== feishuView.lookupEpoch) return ok;
      if (!ok) {
        feishuView.lookupCancelPending = false;
        ops.showToast(t("feishuApprovalLookupCancelFailed"), { error: true });
        ops.requestRender({ content: true });
      }
      return ok;
    }).catch(() => {
      if (lookupEpoch !== feishuView.lookupEpoch) return false;
      feishuView.lookupCancelPending = false;
      ops.showToast(t("feishuApprovalLookupCancelFailed"), { error: true });
      ops.requestRender({ content: true });
      return false;
    });
  }

  function leaveFeishuLookupUi() {
    if (feishuView.networkLookupPending) {
      cancelFeishuApproverLookup({ bestEffort: true });
    }
    resetFeishuFormDraft();
    clearFeishuSecretEditingState();
  }

  function refreshAuthoritativeFeishuSnapshot() {
    if (!window.settingsAPI || typeof window.settingsAPI.getSnapshot !== "function") {
      return Promise.resolve(false);
    }
    let pending;
    try {
      pending = window.settingsAPI.getSnapshot();
    } catch {
      return Promise.resolve(false);
    }
    return Promise.resolve(pending).then((snapshot) => {
      if (
        !snapshot
        || typeof snapshot !== "object"
        || !snapshot.feishuApproval
        || typeof snapshot.feishuApproval !== "object"
      ) return false;
      state.snapshot = snapshot;
      return true;
    }).catch(() => false);
  }

  function saveConfig(next, options = {}) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return Promise.resolve(false);
    }
    view.configPending = true;
    ops.requestRender({ content: true });
    return window.settingsAPI.update("tgApproval", next).then((result) => {
      view.configPending = false;
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("toastSaveFailed"), { error: true });
        ops.requestRender({ content: true });
        return false;
      }
      ops.showToast(t("telegramApprovalConfigSaved"));
      if (options.resetDraft !== false) resetFormDraft();
      view.status = null;
      refreshStatus({ forceRender: true });
      return true;
    }).catch((err) => {
      view.configPending = false;
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      ops.requestRender({ content: true });
      return false;
    });
  }

  function confirmFeishuCredentialReplacement(payload, options) {
    return helpers.showSettingsConfirmModal({
      title: t("feishuApprovalCredentialsReplaceConfirmTitle"),
      detail: t("feishuApprovalCredentialsReplaceConfirmDetail"),
      actions: [
        {
          id: "cancel",
          label: t("telegramApprovalCancel"),
          tone: "neutral",
          defaultFocus: true,
        },
        {
          id: "confirm",
          label: t("feishuApprovalCredentialsReplaceConfirmAction"),
          tone: "danger",
        },
      ],
    }).then((actionId) => {
      if (actionId !== "confirm") {
        feishuView.configPersistencePending = false;
        feishuView.configPersistenceKind = null;
        ops.requestRender({ content: true });
        return false;
      }
      feishuView.configPersistencePending = false;
      feishuView.configPersistenceKind = null;
      const confirmedPayload = { ...payload, confirmReplace: true };
      return saveFeishuCommand(
        "feishuApproval.setSecrets",
        confirmedPayload,
        { ...options, credentialPayload: confirmedPayload },
      );
    }).catch(() => {
      feishuView.configPersistencePending = false;
      feishuView.configPersistenceKind = null;
      ops.requestRender({ content: true });
      return false;
    });
  }

  function persistFeishuChange(request, options = {}) {
    if (feishuView.configPersistencePending || feishuView.testPending) {
      return Promise.resolve(false);
    }
    const preserveMountedControl = options.preserveMountedControl === true;
    feishuView.configPersistencePending = true;
    feishuView.configPersistenceKind = options.kind || "ordinary";
    if (!preserveMountedControl) ops.requestRender({ content: true });
    let pending;
    try {
      pending = request();
    } catch {
      pending = Promise.resolve({ status: "error" });
    }
    return Promise.resolve(pending).then((result) => {
      if (!result || result.status !== "ok") {
        if (
          options.kind === "credentials"
          && options.credentialPayload
          && options.credentialPayload.confirmReplace !== true
          && result
          && result.code === "credentials-replace-confirmation-required"
        ) {
          return confirmFeishuCredentialReplacement(options.credentialPayload, options);
        }
        feishuView.configPersistencePending = false;
        feishuView.configPersistenceKind = null;
        ops.showToast(tBrand(options.failureKey || "feishuApprovalPersistenceFailed"), { error: true });
        if (!preserveMountedControl) ops.requestRender({ content: true });
        return false;
      }
      return refreshAuthoritativeFeishuSnapshot().then((refreshed) => {
        feishuView.configPersistencePending = false;
        feishuView.configPersistenceKind = null;
        if (!refreshed) {
          ops.showToast(tBrand(options.failureKey || "feishuApprovalPersistenceFailed"), { error: true });
          if (!preserveMountedControl) ops.requestRender({ content: true });
          return false;
        }
        if (options.successKey !== false) {
          ops.showToast(tBrand(options.successKey || "feishuApprovalConfigSaved"));
        }
        if (options.resetDraft === true || (options.resetDraft !== false && options.kind === "ordinary")) {
          resetFeishuFormDraft();
        }
        if (typeof options.onSuccess === "function") options.onSuccess(result);
        if (!preserveMountedControl) feishuView.status = null;
        refreshFeishuStatus({ forceRender: !preserveMountedControl });
        return true;
      });
    }).catch(() => {
      feishuView.configPersistencePending = false;
      feishuView.configPersistenceKind = null;
      ops.showToast(tBrand(options.failureKey || "feishuApprovalPersistenceFailed"), { error: true });
      if (!preserveMountedControl) ops.requestRender({ content: true });
      return false;
    });
  }

  function saveFeishuConfig(next, options = {}) {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("feishuApprovalPersistenceFailed"), { error: true });
      return Promise.resolve(false);
    }
    return persistFeishuChange(
      () => callCommand("feishuApproval.updateConfig", next),
      { ...options, kind: options.kind || "ordinary" },
    );
  }

  function saveFeishuCommand(name, payload, options = {}) {
    if (!window.settingsAPI || typeof window.settingsAPI.command !== "function") {
      ops.showToast(t("feishuApprovalPersistenceFailed"), { error: true });
      return Promise.resolve(false);
    }
    return persistFeishuChange(
      () => callCommand(name, payload),
      options,
    );
  }

  function configsMatchExceptTimeout(previous, next) {
    const left = previous && typeof previous === "object" ? previous : {};
    const right = next && typeof next === "object" ? next : {};
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    keys.delete("connectionTimeoutSeconds");
    for (const key of keys) {
      if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) return false;
    }
    return true;
  }

  function patchInPlace(changes, context = {}) {
    if (!changes || Object.keys(changes).length !== 1
      || !Object.prototype.hasOwnProperty.call(changes, "feishuApproval")) return false;
    const previous = context.previousSnapshot && context.previousSnapshot.feishuApproval;
    const next = context.snapshot && context.snapshot.feishuApproval;
    if (!configsMatchExceptTimeout(previous, next)) return false;
    if (!mountedFeishuTimeoutControl
      || !document.body.contains(mountedFeishuTimeoutControl.row)) return false;
    mountedFeishuTimeoutControl.picker.setValue(
      String(currentFeishuConfig().connectionTimeoutSeconds)
    );
    return true;
  }

  // ── Slack (one-way notifications) ──────────────────────────────────────────
  // Webhook / chat.postMessage are stateless, so this card is simpler than the
  // Feishu one: no platform switch, no connection timeout, and no "starting"
  // poll — a config is either usable ("configured") or not. Slack cannot resolve
  // approvals here (webhook is one-way); it only sends done/error/permission
  // pings.
  const slackView = {
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
    formDraft: null,
    formDirty: { webhookUrl: false, botToken: false, channelId: false },
  };

  function currentSlackConfig() {
    const cfg = state.snapshot && state.snapshot.slackNotify;
    return {
      enabled: !!(cfg && cfg.enabled),
      channelId: cfg && typeof cfg.channelId === "string" ? cfg.channelId : "",
      notifyOnDone: !cfg || cfg.notifyOnDone !== false,
      notifyOnError: !cfg || cfg.notifyOnError !== false,
      notifyOnPermission: !cfg || cfg.notifyOnPermission !== false,
      outputMode: cfg && cfg.outputMode === "full" ? "full" : "off",
    };
  }

  function getSlackFormDraft() {
    if (!slackView.formDraft) {
      slackView.formDraft = {
        webhookUrl: "",
        botToken: "",
        channelId: currentSlackConfig().channelId,
      };
    }
    const savedChannelId = currentSlackConfig().channelId;
    if (slackView.formDirty.channelId && slackView.formDraft.channelId.trim() === savedChannelId) {
      // The settings broadcast has caught up with a successful write (or the
      // user typed the already-saved value). The draft is pristine again.
      slackView.formDraft.channelId = savedChannelId;
      slackView.formDirty.channelId = false;
    } else if (!slackView.formDirty.channelId) {
      // Keep an untouched field in sync with store updates. Secret inputs are
      // replacement-only and intentionally stay blank until the user types.
      slackView.formDraft.channelId = savedChannelId;
    }
    return slackView.formDraft;
  }

  function setSlackFormDraftValue(field, value) {
    getSlackFormDraft()[field] = String(value == null ? "" : value);
    slackView.formDirty[field] = true;
  }

  function clearSubmittedSlackSecretDraft(payload) {
    const draft = getSlackFormDraft();
    for (const field of ["webhookUrl", "botToken"]) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
      if (draft[field].trim() === payload[field]) {
        draft[field] = "";
        slackView.formDirty[field] = false;
      }
    }
  }

  function slackStatusRenderKey(status) {
    const s = status && typeof status === "object" ? status : {};
    return [
      s.enabled === true ? "1" : "0",
      s.ready === true ? "1" : "0",
      s.transportConfigured === true ? "1" : "0",
      s.configured === true ? "1" : "0",
      s.credentialsPresent === true ? "1" : "0",
      s.reason || "",
      s.transport || "",
      s.secretsStored === true ? "1" : "0",
      s.webhookConfigured === true ? "1" : "0",
      s.botTokenConfigured === true ? "1" : "0",
    ].join("");
  }

  function slackSecretInfoRenderKey(info) {
    const i = info && typeof info === "object" ? info : {};
    return [i.configured === true ? "1" : "0", i.webhookUrl || "", i.botToken || ""].join("");
  }

  // Gate the first paint on a meaningful status, exactly like Feishu: an empty
  // {status:"ok"} with no state must NOT trigger a repaint, or every render
  // churns one extra frame before anything is configured.
  function slackStatusNeedsRender(status) {
    const s = status && typeof status === "object" ? status : {};
    return !!(
      s.ready === true
      || s.transportConfigured === true
      || s.configured === true
      || s.credentialsPresent === true
      || s.secretsStored === true
      || s.enabled === true
    );
  }

  function slackSecretInfoNeedsRender(info) {
    return !!(info && info.configured);
  }

  function refreshSlackStatus({ forceRender = false } = {}) {
    if (slackView.statusLoading) {
      if (forceRender) slackView.statusForceRenderPending = true;
      return;
    }
    slackView.statusLoading = true;
    const seq = ++slackView.statusSeq;
    callCommand("slackNotify.status").then((result) => {
      if (seq !== slackView.statusSeq) return;
      slackView.statusLoading = false;
      const previousStatus = slackView.status;
      const hadStatus = !!previousStatus;
      const updated = result && result.status === "ok";
      const nextStatus = updated ? result.state || null : previousStatus;
      const shouldForceRender = forceRender || slackView.statusForceRenderPending;
      slackView.statusForceRenderPending = false;
      const changed = updated && slackStatusRenderKey(previousStatus) !== slackStatusRenderKey(nextStatus);
      if (updated) slackView.status = result.state || null;
      const initialVisibleChange = !hadStatus && slackStatusNeedsRender(nextStatus);
      if ((shouldForceRender || (updated && (initialVisibleChange || (hadStatus && changed)))) && isRemoteBodyVisible()) {
        ops.requestRender({ content: true });
      }
    });
  }

  function refreshSlackSecretInfo({ forceRender = false } = {}) {
    if (slackView.secretInfoLoading) {
      if (forceRender) slackView.secretInfoForceRenderPending = true;
      return;
    }
    slackView.secretInfoLoading = true;
    const seq = ++slackView.secretInfoSeq;
    callCommand("slackNotify.secretInfo").then((result) => {
      if (seq !== slackView.secretInfoSeq) return;
      slackView.secretInfoLoading = false;
      const previous = slackView.secretInfo;
      const updated = result && result.status === "ok";
      const next = updated ? {
        configured: result.configured === true,
        webhookUrl: result.webhookUrl || "",
        botToken: result.botToken || "",
      } : previous;
      const shouldForceRender = forceRender || slackView.secretInfoForceRenderPending;
      slackView.secretInfoForceRenderPending = false;
      const changed = updated && slackSecretInfoRenderKey(previous) !== slackSecretInfoRenderKey(next);
      if (updated) slackView.secretInfo = next;
      const initialVisibleChange = !previous && slackSecretInfoNeedsRender(next);
      if ((shouldForceRender || (updated && (initialVisibleChange || (previous && changed)))) && isRemoteBodyVisible()) {
        ops.requestRender({ content: true });
      }
    });
  }

  // A configured transport and an active notifier are different states. Keep
  // the transport/configured fallbacks for older main-process payloads while
  // preferring the explicit transportConfigured + ready axes.
  function slackTransportConfigured() {
    const s = slackView.status || {};
    if (typeof s.transportConfigured === "boolean") return s.transportConfigured;
    if (s.transport === "webhook" || s.transport === "bot") return true;
    return s.configured === true;
  }

  function slackReady() {
    const s = slackView.status || {};
    if (typeof s.ready === "boolean") return s.ready;
    return slackTransportConfigured() && s.enabled === true;
  }

  function deriveSlackCardKind() {
    if (slackReady()) return "running";
    if (slackTransportConfigured()) return "ready";
    return "incomplete";
  }

  function deriveSlackStatus() {
    const kind = deriveSlackCardKind();
    if (kind === "running") {
      return { tone: "ok", text: `${t("slackNotifyCardRunning")} · ${slackTransportLine()}` };
    }
    if (kind === "ready") return { tone: "warn", text: t("slackNotifyCardReadyToEnable") };
    return { tone: "off", text: t("slackNotifyCardMissingSecret") };
  }

  function deriveMobileStatus() {
    const enabled = !!(state.snapshot && state.snapshot.mobilePreviewEnabled === true);
    return enabled
      ? { tone: "ok", text: t("mobileStatusRunning") }
      : { tone: "off", text: t("mobileStatusOff") };
  }

  function slackSecretsConfigured() {
    const s = slackView.status || {};
    return !!(slackView.secretInfo && slackView.secretInfo.configured)
      || s.secretsStored === true || s.credentialsPresent === true;
  }

  // Which credential is actually carrying messages right now — a saved webhook
  // silently outranks a saved bot token, which is confusing without a label.
  function slackTransportLine() {
    const s = slackView.status || {};
    if (s.transport === "webhook") return t("slackNotifyTransportWebhook");
    if (s.transport === "bot") return t("slackNotifyTransportBot");
    return t("slackNotifyTransportNone");
  }

  function buildSlackChannelCard() {
    const kind = deriveSlackCardKind();
    const cfg = currentSlackConfig();
    const configured = slackTransportConfigured() || cfg.enabled;
    const defaultCollapsed = kind === "running";
    const header = buildChannelHeader(
      t("slackNotifyChannelName"),
      deriveSlackStatus(),
      "settings-slack-notify-enabled-label",
    );

    const children = [];
    if (!configured) {
      children.push(buildChannelSetup({
        steps: [[buildSlackSecretsRow(), buildSlackChannelIdRow()]],
        footText: t("slackSetupFoot"),
      }));
    } else {
      const secretsRow = buildSlackSecretsRow();
      const channelIdRow = buildSlackChannelIdRow();
      const eventRows = [
        buildSlackSwitchRow("slackNotifyEventDone", "slackNotifyEventDoneDesc", cfg.notifyOnDone, (value) =>
          saveSlackConfig({ ...currentSlackConfig(), notifyOnDone: value })),
        buildSlackSwitchRow("slackNotifyEventError", "slackNotifyEventErrorDesc", cfg.notifyOnError, (value) =>
          saveSlackConfig({ ...currentSlackConfig(), notifyOnError: value })),
        buildSlackSwitchRow("slackNotifyEventPermission", "slackNotifyEventPermissionDesc", cfg.notifyOnPermission, (value) =>
          saveSlackConfig({ ...currentSlackConfig(), notifyOnPermission: value })),
        buildSlackSwitchRow("slackNotifyOutputMode", "slackNotifyOutputModeDesc", cfg.outputMode === "full", (value) =>
          saveSlackConfig({ ...currentSlackConfig(), outputMode: value ? "full" : "off" })),
      ];
      // Slack shows the privacy warning on the stored-credential note, so the
      // credentials row folds both description segments into one (i) toggle.
      helpers.attachDescriptionDisclosure(secretsRow, { includeExtra: true });
      for (const row of [channelIdRow, ...eventRows]) {
        helpers.attachDescriptionDisclosure(row);
      }
      children.push(helpers.buildDetailGroup(t("settingsGroupConnection"), [
        secretsRow,
        channelIdRow,
      ]));
      children.push(helpers.buildDetailGroup(t("settingsGroupNotifications"), eventRows));
      children.push(buildChannelTestFooter({
        available: slackTransportConfigured(),
        pending: slackView.testPending,
        hint: t("slackNotifyCardMissingSecret"),
        note: slackTransportLine(),
        labelKey: "slackNotifySendTest",
        pendingLabelKey: "slackNotifyTesting",
        onClick: sendSlackTest,
      }));
    }

    return helpers.buildCollapsibleGroup({
      id: "remote-approval.slack",
      headerContent: header.element,
      headerAction: configured ? buildSlackEnabledSwitch({ statusTextId: header.statusTextId }) : null,
      defaultCollapsed,
      className: "remote-approval-channel-card slack-notify-channel-card",
      children: children.filter(Boolean),
    });
  }

  function buildSlackSecretInput(placeholderKey, secret, onEnter) {
    return helpers.buildTextInput({
      type: secret ? "password" : "text",
      autocomplete: "off",
      spellcheck: false,
      placeholder: t(placeholderKey),
      className: "tg-approval-input",
      ariaLabel: t(placeholderKey),
      pending: slackView.secretPending,
      lockWhilePending: false,
      onEnter,
    });
  }

  function buildSlackSecretsRow() {
    const configured = slackSecretsConfigured();
    const info = slackView.secretInfo;
    const rowParts = helpers.buildSettingRow({
      labelKey: "slackNotifySecretsLabel",
      descriptionKey: configured ? "slackNotifySecretsReplaceHint" : "slackNotifySecretsHint",
      className: "tg-approval-token-edit-row slack-notify-secrets-row",
      controlClassName: "tg-approval-input-row slack-notify-secrets-grid",
    });
    const row = rowParts.element;
    const text = rowParts.textElement;
    const ctrl = rowParts.controlElement;
    // One line per stored credential. Previously only the webhook mask showed,
    // so a bot-token-only setup looked unconfigured, and there was no way to
    // tell which of two saved credentials was actually in use.
    for (const [field, mask, clearedKey] of [
      ["webhookUrl", info && info.webhookUrl, "slackNotifyClearedWebhook"],
      ["botToken", info && info.botToken, "slackNotifyClearedToken"],
    ]) {
      if (!mask) continue;
      const line = document.createElement("span");
      line.className = "tg-approval-token-current";
      line.textContent = t("slackNotifySecretsCurrent").replace("{masked}", mask);
      const clear = helpers.buildButton({
        labelKey: "slackNotifyClear",
        size: "compact",
        disabled: slackView.secretPending,
        pending: slackView.secretPending,
      });
      clear.addEventListener("click", () => clearSlackSecret(field, clearedKey));
      line.appendChild(document.createTextNode(" "));
      line.appendChild(clear);
      text.insertBefore(line, rowParts.descriptionElement);
    }
    // Local removal is not revocation — say so where the button is.
    if (info && (info.webhookUrl || info.botToken)) {
      const note = document.createElement("span");
      note.className = "row-desc row-desc-extra";
      note.textContent = t("slackNotifyRevokeNote");
      text.insertBefore(note, rowParts.descriptionElement);
    }
    const submitSecretsOnEnter = () => saveBtn.click();
    const webhookInput = buildSlackSecretInput("slackNotifyWebhookPlaceholder", true, submitSecretsOnEnter);
    const botTokenInput = buildSlackSecretInput("slackNotifyBotTokenPlaceholder", true, submitSecretsOnEnter);
    const draft = getSlackFormDraft();
    webhookInput.value = draft.webhookUrl;
    botTokenInput.value = draft.botToken;
    webhookInput.addEventListener("input", () => {
      helpers.setTextInputState(webhookInput, { invalid: false });
      setSlackFormDraftValue("webhookUrl", webhookInput.value);
    });
    botTokenInput.addEventListener("input", () => {
      helpers.setTextInputState(botTokenInput, { invalid: false });
      setSlackFormDraftValue("botToken", botTokenInput.value);
    });

    const saveBtn = helpers.buildButton({
      labelKey: slackView.secretPending ? "slackNotifySaving" : "slackNotifySaveSecrets",
      tone: "accent",
      disabled: slackView.secretPending,
      pending: slackView.secretPending,
    });
    saveBtn.addEventListener("click", () => {
      // Only send fields the user typed; blank means "keep the stored value"
      // (the writer preserves untouched keys), so saving a new webhook does not
      // wipe a stored bot token. The per-credential Remove buttons clear the
      // local copy; only deleting/revoking it in Slack makes it unusable to
      // anyone else — see docs/guides/slack-notifications.md.
      const payload = {};
      const webhook = webhookInput.value.trim();
      const botToken = botTokenInput.value.trim();
      if (webhook) payload.webhookUrl = webhook;
      if (botToken) payload.botToken = botToken;
      if (!configured && !webhook && !botToken) {
        helpers.setTextInputState(webhookInput, { invalid: true });
        helpers.setTextInputState(botTokenInput, { invalid: true });
        webhookInput.focus();
        ops.showToast(t("slackNotifySecretsRequired"), { error: true });
        return;
      }
      if (!webhook && !botToken) {
        helpers.setTextInputState(webhookInput, { invalid: true });
        helpers.setTextInputState(botTokenInput, { invalid: true });
        webhookInput.focus();
        ops.showToast(t("slackNotifySecretsEmpty"), { error: true });
        return;
      }
      slackView.secretPending = true;
      ops.requestRender({ content: true });
      callCommand("slackNotify.setSecrets", payload).then((result) => {
        slackView.secretPending = false;
        if (!result || result.status !== "ok") {
          ops.showToast(localizeSlackError(result), { error: true });
          ops.requestRender({ content: true });
          return;
        }
        ops.showToast(t("slackNotifySecretsSaved"));
        clearSubmittedSlackSecretDraft(payload);
        slackView.secretInfo = null;
        slackView.status = null;
        refreshSlackSecretInfo({ forceRender: true });
        refreshSlackStatus({ forceRender: true });
      });
    });

    ctrl.appendChild(webhookInput);
    ctrl.appendChild(botTokenInput);
    ctrl.appendChild(saveBtn);
    return row;
  }

  // An explicit empty string is the backend's "clear this field" signal. The
  // save path only sends fields you typed into, which is why a stored webhook
  // could not be removed — or switched away from — without editing the file.
  function clearSlackSecret(field, toastKey) {
    slackView.secretPending = true;
    ops.requestRender({ content: true });
    callCommand("slackNotify.setSecrets", { [field]: "" }).then((result) => {
      slackView.secretPending = false;
      if (!result || result.status !== "ok") {
        ops.showToast(localizeSlackError(result), { error: true });
        ops.requestRender({ content: true });
        return;
      }
      ops.showToast(t(toastKey));
      // This removes the stored credential shown by the masked status line; it
      // does not submit the replacement input beside it. Keep that unsaved
      // draft intact across the status refresh.
      slackView.secretInfo = null;
      slackView.status = null;
      refreshSlackSecretInfo({ forceRender: true });
      refreshSlackStatus({ forceRender: true });
    });
  }

  // Stable codes from the main process become sentences here. Reporting every
  // failure as "Slack rejected the message" told the user nothing actionable.
  function localizeSlackError(result) {
    const code = result && (result.code || result.errorClass);
    const byCode = {
      "not-found": "slackNotifyErrNotFound",
      unauthorized: "slackNotifyErrUnauthorized",
      "rate-limited": "slackNotifyErrRateLimited",
      network: "slackNotifyErrNetwork",
      timeout: "slackNotifyErrNetwork",
      "invalid-webhook": "slackNotifyErrInvalidWebhook",
      "invalid-bot-token": "slackNotifyErrInvalidToken",
      "slack-missing_scope": "slackNotifyErrMissingScope",
      "slack-channel_not_found": "slackNotifyErrChannelNotFound",
      "slack-not_in_channel": "slackNotifyErrNotInChannel",
      "write-failed": "slackNotifySecretsSaveFailed",
    };
    if (byCode[code]) return t(byCode[code]);
    const detail = result && result.message ? ` (${result.message})` : "";
    return t("slackNotifyTestFailed") + detail;
  }

  function buildSlackChannelIdRow() {
    const cfg = currentSlackConfig();
    const rowParts = helpers.buildSettingRow({
      labelKey: "slackNotifyChannelIdLabel",
      descriptionKey: "slackNotifyChannelIdHint",
      className: "tg-approval-recipient-row slack-notify-channel-row",
      controlClassName: "tg-approval-input-row",
    });
    const row = rowParts.element;
    const ctrl = rowParts.controlElement;
    const input = helpers.buildTextInput({
      type: "text",
      autocomplete: "off",
      spellcheck: false,
      placeholder: t("slackNotifyChannelIdPlaceholder"),
      className: "tg-approval-input",
      value: getSlackFormDraft().channelId,
      labelledBy: rowParts.labelElement.id,
      describedBy: rowParts.descriptionElement.id,
      pending: slackView.configPending,
      lockWhilePending: false,
      onEnter: () => saveBtn.click(),
      onInput: () => setSlackFormDraftValue("channelId", input.value),
    });

    const saveBtn = helpers.buildButton({
      labelKey: slackView.configPending ? "slackNotifySaving" : "slackNotifySaveChannel",
      tone: "accent",
      disabled: slackView.configPending,
      pending: slackView.configPending,
    });
    saveBtn.addEventListener("click", () => {
      const channelId = input.value.trim();
      saveSlackConfig({ ...currentSlackConfig(), channelId }).then((saved) => {
        // The field remains editable while the async write is pending. Do not
        // replace a newer draft when the earlier request eventually succeeds.
        if (saved && getSlackFormDraft().channelId.trim() === channelId) {
          slackView.formDraft.channelId = channelId;
          slackView.formDirty.channelId = currentSlackConfig().channelId !== channelId;
        }
      });
    });

    ctrl.appendChild(input);
    ctrl.appendChild(saveBtn);
    return row;
  }

  function buildSlackEnabledSwitch({ statusTextId }) {
    const cfg = currentSlackConfig();
    const canToggle = slackTransportConfigured() || cfg.enabled;
    return helpers.buildSwitch({
      checked: cfg.enabled,
      pending: slackView.configPending,
      disabled: !canToggle,
      ariaLabel: t("slackNotifyToggle"),
      ariaDescribedBy: statusTextId,
      stopPropagation: true,
      onToggle: () => saveSlackConfig({ ...cfg, enabled: !cfg.enabled }),
    }).element;
  }

  function buildSlackSwitchRow(labelKey, descKey, value, onToggle) {
    const row = document.createElement("div");
    row.className = "row";
    const text = document.createElement("div");
    text.className = "row-text";
    const label = document.createElement("span");
    label.className = "row-label";
    label.id = `settings-slack-${labelKey}-label`;
    label.textContent = t(labelKey);
    const desc = document.createElement("span");
    desc.className = "row-desc";
    desc.id = `settings-slack-${labelKey}-description`;
    desc.textContent = t(descKey);
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);

    const ctrl = document.createElement("div");
    ctrl.className = "row-control";
    const switchControl = helpers.buildSwitch({
      checked: value,
      pending: slackView.configPending,
      ariaLabelledBy: label.id,
      ariaDescribedBy: desc.id,
      onToggle: () => onToggle(!value),
    });
    ctrl.appendChild(switchControl.element);
    row.appendChild(ctrl);
    return row;
  }

  function sendSlackTest() {
    if (slackView.testPending) return;
    slackView.testPending = true;
    ops.requestRender({ content: true });
    callCommand("slackNotify.test").then((result) => {
      slackView.testPending = false;
      if (result && result.status === "ok") {
        ops.showToast(t("slackNotifyTestSent"));
      } else {
        ops.showToast(localizeSlackError(result), { error: true });
      }
      slackView.status = null;
      refreshSlackStatus({ forceRender: true });
    });
  }

  function saveSlackConfig(next, options = {}) {
    if (!window.settingsAPI || typeof window.settingsAPI.update !== "function") {
      ops.showToast(t("toastSaveFailed") + "settings API unavailable", { error: true });
      return Promise.resolve(false);
    }
    slackView.configPending = true;
    ops.requestRender({ content: true });
    return window.settingsAPI.update("slackNotify", next).then((result) => {
      slackView.configPending = false;
      if (!result || result.status !== "ok") {
        ops.showToast((result && result.message) || t("toastSaveFailed"), { error: true });
        ops.requestRender({ content: true });
        return false;
      }
      ops.showToast(t("slackNotifyConfigSaved"));
      slackView.status = null;
      refreshSlackStatus({ forceRender: true });
      return true;
    }).catch((err) => {
      slackView.configPending = false;
      ops.showToast(t("toastSaveFailed") + (err && err.message), { error: true });
      ops.requestRender({ content: true });
      return false;
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
  // [text](https://...) link tokens. We escape the literal text and only expand
  // whitelisted https://t.me/*, https://open.feishu.cn/* and
  // https://open.larksuite.com/* links so a malicious translation can't inject
  // arbitrary HTML.
  //
  // This is a whitelist, NOT a URL parser: every dot is escaped so the host is
  // matched literally, and the alternation must be followed immediately by "/".
  // That combination is what rejects the near-miss hosts — `open-larksuite.com`
  // (unescaped `.` would match the hyphen), `open.larksuite.com.evil.com` (no
  // "/" after the host) and `evil.com@open.larksuite.com` (userinfo before the
  // host). Do not loosen it.
  function escapeWithLink(text) {
    const raw = String(text == null ? "" : text);
    const parts = [];
    let lastIdx = 0;
    const re = /\[([^\]]+)\]\((https:\/\/(?:t\.me|open\.feishu\.cn|open\.larksuite\.com)\/[A-Za-z0-9_./?#=&-]+)\)/g;
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
  }

  root.ClawdSettingsTabTelegramApproval = {
    init,
    renderChannelsBody,
    renderLanBody,
    refreshRuntimeStatus,
    patchInPlace,
    leave: leaveFeishuLookupUi,
  };
})(globalThis);
