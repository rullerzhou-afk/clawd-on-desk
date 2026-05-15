"use strict";

(function initSettingsDoctorModal(root) {
  const state = {
    lastResult: null,
    initialRunStarted: false,
    runningPromise: null,
    indicator: null,
    dot: null,
    label: null,
    status: null,
    modalOpen: false,
    connectionTest: null,
    connectionTesting: false,
    connectionRemainingSeconds: 0,
    connectionTimer: null,
    repairingKey: null,
    repairFeedback: {},
    lastRepairFeedback: null,
    pendingConfirmAction: null,
    fixActionByKey: new Map(),
    actionNotice: null,
    actionNoticeTimer: null,
    checkExpansionOverrides: new Map(),
    checksLoading: false,
    connectionRunId: 0,
    repairRunId: 0,
    modalEntering: false,
    modalEnteringTimer: null,
  };

  const AGENT_WARNING_STATUSES = new Set([
    "not-connected",
    "broken-path",
    "config-corrupt",
    "needs-review",
  ]);
  const AGENT_INFO_STATUSES = new Set([
    "disabled",
    "manual-managed",
    "manual-only",
    "not-installed",
  ]);
  const AGENT_ATTENTION_NAME_LIMIT = 3;

  function t(core, key) {
    return core.helpers.t(key);
  }

  function escape(core, value) {
    return core.helpers.escapeHtml(value == null ? "" : value);
  }

  function showToast(core, message, options) {
    if (state.modalOpen) {
      showActionNotice(core, message, options);
      return;
    }
    if (core && core.ops && typeof core.ops.showToast === "function") {
      core.ops.showToast(message, options);
    }
  }

  function clearActionNoticeTimer() {
    if (state.actionNoticeTimer && typeof clearTimeout === "function") {
      clearTimeout(state.actionNoticeTimer);
    }
    state.actionNoticeTimer = null;
  }

  function clearModalEnteringTimer() {
    if (state.modalEnteringTimer && typeof clearTimeout === "function") {
      clearTimeout(state.modalEnteringTimer);
    }
    state.modalEnteringTimer = null;
  }

  function startModalEntering() {
    state.modalEntering = true;
    clearModalEnteringTimer();
    if (typeof setTimeout === "function") {
      state.modalEnteringTimer = setTimeout(() => {
        state.modalEntering = false;
        state.modalEnteringTimer = null;
      }, 220);
    }
  }

  function showActionNotice(core, message, options) {
    state.actionNotice = {
      message: String(message || ""),
      error: !!(options && options.error),
    };
    clearActionNoticeTimer();
    if (state.modalOpen) refreshModal(core);
    if (typeof setTimeout === "function") {
      state.actionNoticeTimer = setTimeout(() => {
        state.actionNotice = null;
        state.actionNoticeTimer = null;
        if (state.modalOpen) refreshModal(core);
      }, 3200);
    }
  }

  function overallClass(result) {
    const status = result && result.overall && result.overall.status;
    if (!result) return "unknown";
    if (status === "critical") return "critical";
    if (status === "warning") return "warning";
    return "pass";
  }

  function overallText(core, result) {
    const status = result && result.overall && result.overall.status;
    if (!result) return t(core, "doctorStatusUnknown");
    if (status === "critical") return t(core, "doctorStatusCritical");
    if (status === "warning") return t(core, "doctorStatusWarning");
    return t(core, "doctorStatusPass");
  }

  function updateIndicator(core, result) {
    if (!state.indicator) return;
    const cls = overallClass(result);
    state.indicator.classList.remove("unknown", "pass", "warning", "critical");
    state.indicator.classList.add(cls);
    if (state.status) state.status.textContent = overallText(core, result);
  }

  function checkLabel(core, check) {
    const map = {
      "local-server": "doctorCheckLocalServer",
      "agent-integrations": "doctorCheckAgentIntegrations",
      "permission-bubble-policy": "doctorCheckPermissionBubbles",
      "theme-health": "doctorCheckTheme",
    };
    return t(core, map[check.id] || "doctorCheckUnknown");
  }

  function checkStatusLabel(core, check) {
    if (!check) return t(core, "doctorStatusUnknown");
    if (check.level === "critical" || check.status === "critical") return t(core, "doctorStatusCritical");
    if (check.level === "warning" || check.status === "warning" || check.status === "fail") return t(core, "doctorStatusWarning");
    if (check.level === "info") return t(core, "doctorStatusInfo");
    return t(core, "doctorStatusPass");
  }

  function connectionStatusClass(test) {
    if (state.connectionTesting) return "warning";
    if (!test) return "unknown";
    if (test.level === "warning" || test.status === "http-dropped" || test.status === "http-blocked" || test.status === "no-activity" || test.status === "error") {
      return "warning";
    }
    return "pass";
  }

  function connectionStatusLabel(core, test) {
    if (state.connectionTesting) {
      return t(core, "doctorConnectionTesting").replace("{seconds}", String(state.connectionRemainingSeconds));
    }
    if (!test) return t(core, "doctorConnectionIdle");
    const map = {
      "http-verified": "doctorConnectionHttpVerified",
      "http-dropped": "doctorConnectionHttpDropped",
      "http-blocked": "doctorConnectionHttpBlocked",
      "no-activity": "doctorConnectionNoActivity",
      error: "doctorConnectionError",
    };
    return t(core, map[test.status] || "doctorConnectionError");
  }

  function pushIfValue(lines, label, value) {
    if (value === null || value === undefined || value === "") return;
    lines.push(`${label}: ${value}`);
  }

  function formatKiroScan(scan) {
    if (!scan || typeof scan !== "object") return null;
    const parts = [];
    if (Array.isArray(scan.fullyValidFiles) && scan.fullyValidFiles.length) {
      parts.push(`valid=${scan.fullyValidFiles.join(", ")}`);
    }
    if (Array.isArray(scan.brokenFiles) && scan.brokenFiles.length) {
      parts.push(`broken=${scan.brokenFiles.join(", ")}`);
    }
    if (Array.isArray(scan.corruptFiles) && scan.corruptFiles.length) {
      parts.push(`corrupt=${scan.corruptFiles.join(", ")}`);
    }
    if (Array.isArray(scan.noMarkerFiles) && scan.noMarkerFiles.length) {
      parts.push(`no-marker=${scan.noMarkerFiles.length}`);
    }
    return parts.length ? parts.join("; ") : null;
  }

  function agentDetailText(detail) {
    if (!detail || typeof detail !== "object") return "";
    const lines = [];
    if (detail.detail) lines.push(detail.detail);
    pushIfValue(lines, "permission", detail.permissionBubbleDetail);
    if (detail.supplementary && typeof detail.supplementary === "object") {
      const key = detail.supplementary.key || "supplementary";
      const value = detail.supplementary.value || "unknown";
      const suffix = detail.supplementary.detail ? ` (${detail.supplementary.detail})` : "";
      lines.push(`${key}=${value}${suffix}`);
    }
    if (detail.codexHookTrust && typeof detail.codexHookTrust === "object") {
      const key = detail.codexHookTrust.key || "codex_hook_trust";
      const value = detail.codexHookTrust.value || "unknown";
      const suffix = detail.codexHookTrust.detail ? ` (${detail.codexHookTrust.detail})` : "";
      lines.push(`${key}=${value}${suffix}`);
    }
    pushIfValue(lines, "kiro", formatKiroScan(detail.kiroScan));
    pushIfValue(lines, "hook issue", detail.hookCommandIssue);
    pushIfValue(lines, "opencode issue", detail.opencodeEntryIssue);
    pushIfValue(lines, "opencode entry", detail.opencodeEntry);
    return lines.filter(Boolean).join("; ");
  }

  function fixActionKey(action) {
    if (!action || typeof action !== "object") return "";
    const forceCodex = action.forceCodexHooksFeature ? "force-codex-hooks" : "";
    return `${action.type || "unknown"}:${action.agentId || ""}:${forceCodex}`;
  }

  function rememberFixAction(action) {
    const key = fixActionKey(action);
    if (key) state.fixActionByKey.set(key, action);
    return key;
  }

  function renderFixButton(core, action) {
    if (!action || typeof action !== "object" || !action.type) return "";
    const key = rememberFixAction(action);
    const busy = state.repairingKey === key;
    const disabled = state.repairingKey ? " disabled" : "";
    const restart = action.type === "restart-clawd";
    const label = busy
      ? (restart ? t(core, "doctorRestarting") : t(core, "doctorFixing"))
      : (restart ? t(core, "doctorRestartButton") : t(core, "doctorFix"));
    const cls = restart ? "doctor-fix-button doctor-restart-button" : "doctor-fix-button";
    return `<button type="button" class="${cls}" data-action="fix" data-fix-key="${escape(core, key)}"${disabled}>${escape(core, label)}</button>`;
  }

  function requiresFixConfirmation(action) {
    if (!action || typeof action !== "object") return false;
    if (action.type === "restart-clawd") return true;
    return !!(
      action.type === "agent-integration"
      && action.agentId === "codex"
      && action.forceCodexHooksFeature === true
    );
  }

  function renderRepairFeedback(core, action) {
    const key = fixActionKey(action);
    const feedback = key && state.repairFeedback ? state.repairFeedback[key] : null;
    if (!feedback || !feedback.message) return "";
    const cls = feedback.status === "ok" ? "ok" : "error";
    return `<div class="doctor-repair-feedback ${cls}">${escape(core, feedback.message)}</div>`;
  }

  function renderFixConfirm(core) {
    const action = state.pendingConfirmAction;
    if (!requiresFixConfirmation(action)) return "";
    const restart = action.type === "restart-clawd";
    const titleKey = restart ? "doctorRestartConfirmTitle" : "doctorFixConfirmCodexTitle";
    const detailKey = restart ? "doctorRestartConfirmDetail" : "doctorFixConfirmCodexDetail";
    const actionKey = restart ? "doctorRestartConfirmAction" : "doctorFixConfirmCodexAction";
    return (
      `<div class="doctor-fix-confirm">` +
        `<div>` +
          `<div class="doctor-fix-confirm-title">${escape(core, t(core, titleKey))}</div>` +
          `<div class="doctor-fix-confirm-detail">${escape(core, t(core, detailKey))}</div>` +
        `</div>` +
        `<div class="doctor-fix-confirm-actions">` +
          `<button type="button" class="soft-btn" data-action="cancel-fix-confirm">${escape(core, t(core, "doctorFixConfirmCancel"))}</button>` +
          `<button type="button" class="soft-btn accent" data-action="confirm-fix">${escape(core, t(core, actionKey))}</button>` +
        `</div>` +
      `</div>`
    );
  }

  function renderRepairSummary(core) {
    const feedback = state.lastRepairFeedback;
    if (!feedback || !feedback.message) return "";
    const cls = feedback.status === "ok" ? "ok" : "error";
    return `<div class="doctor-repair-summary ${cls}">${escape(core, feedback.message)}</div>`;
  }

  function checkNeedsAttention(check) {
    if (!check || typeof check !== "object") return false;
    if (check.level === "critical" || check.level === "warning") return true;
    if (check.status === "critical" || check.status === "warning" || check.status === "fail") return true;
    const directKey = fixActionKey(check.fixAction);
    if (directKey && (state.repairingKey === directKey || state.repairFeedback[directKey])) return true;
    if (check.fixAction) return true;
    if (!Array.isArray(check.details)) return false;
    return check.details.some((detail) => {
      if (!detail || typeof detail !== "object") return false;
      const key = fixActionKey(detail.fixAction);
      if (key && (state.repairingKey === key || state.repairFeedback[key])) return true;
      return !!detail.fixAction;
    });
  }

  function agentDetailNeedsAttention(detail) {
    if (!detail || typeof detail !== "object") return false;
    if (detail.level === "critical" || detail.level === "warning") return true;
    if (detail.fixAction) return true;
    return AGENT_WARNING_STATUSES.has(detail.status);
  }

  function formatCount(core, key, count) {
    const formatter = t(core, key);
    if (typeof formatter === "function") return formatter(count);
    return String(formatter).replace("{count}", String(count));
  }

  function formatCheckedDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    try {
      return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
    } catch {
      const year = String(date.getFullYear());
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const hour = String(date.getHours()).padStart(2, "0");
      const minute = String(date.getMinutes()).padStart(2, "0");
      return `${year}-${month}-${day} ${hour}:${minute}`;
    }
  }

  function renderLastChecked(core, result) {
    if (state.checksLoading || !result || !result.generatedAt) return "";
    const time = formatCheckedDateTime(result.generatedAt);
    if (!time) return "";
    const formatter = t(core, "doctorLastCheckedAt");
    const text = typeof formatter === "function"
      ? formatter(time)
      : String(formatter).replace("{time}", time);
    return `<span class="doctor-last-checked">${escape(core, text)}</span>`;
  }

  function agentDetailName(detail) {
    if (!detail || typeof detail !== "object") return "";
    return String(detail.agentName || detail.agentId || "").trim();
  }

  function formatAgentAttentionNames(core, details) {
    const names = details.map(agentDetailName).filter(Boolean);
    if (!names.length) return formatCount(core, "doctorAgentSummaryAttention", details.length);
    const visible = names.slice(0, AGENT_ATTENTION_NAME_LIMIT);
    const hidden = names.length - visible.length;
    const suffix = hidden > 0 ? ` +${hidden}` : "";
    return `${visible.join(", ")} ${t(core, "doctorAgentSummaryNeedsAttention")}${suffix}`;
  }

  function formatAgentIntegrationSummary(core, check) {
    const details = check && Array.isArray(check.details) ? check.details : [];
    if (!details.length) return "";
    let ok = 0;
    const attentionDetails = [];
    let skipped = 0;
    for (const detail of details) {
      if (detail && detail.status === "ok") ok++;
      else if (agentDetailNeedsAttention(detail)) attentionDetails.push(detail);
      else if (detail && AGENT_INFO_STATUSES.has(detail.status)) skipped++;
      else skipped++;
    }
    const parts = [];
    if (attentionDetails.length) parts.push(formatAgentAttentionNames(core, attentionDetails));
    if (ok) parts.push(formatCount(core, "doctorAgentSummaryOk", ok));
    if (skipped) parts.push(formatCount(core, "doctorAgentSummarySkipped", skipped));
    return parts.join(" · ");
  }

  function isCheckExpanded(check) {
    const id = check && check.id;
    if (!id) return false;
    if (state.checkExpansionOverrides.has(id)) return state.checkExpansionOverrides.get(id);
    return checkNeedsAttention(check);
  }

  function renderAgentRows(core, check) {
    if (!check || !Array.isArray(check.details)) return "";
    return `<div class="doctor-agent-list">${
      check.details.map((detail) => {
        const agentDetail = agentDetailText(detail);
        const fixButton = renderFixButton(core, detail.fixAction);
        const repairFeedback = renderRepairFeedback(core, detail.fixAction);
        return (
          `<div class="doctor-agent-item">` +
            `<div class="doctor-agent-row${fixButton ? " with-action" : ""}">` +
              `<span>${escape(core, detail.agentName || detail.agentId)}</span>` +
              `<span>${escape(core, detail.status || "")}</span>` +
              fixButton +
            `</div>` +
            (agentDetail ? `<div class="doctor-agent-detail">${escape(core, agentDetail)}</div>` : "") +
            repairFeedback +
          `</div>`
        );
      }).join("")
    }</div>`;
  }

  function renderLocalServerCheck(core, check, cls) {
    const fixButton = renderFixButton(core, check.fixAction);
    const repairFeedback = renderRepairFeedback(core, check.fixAction);
    const detail = String(check.detail || "");
    const fullDetail = detail && cls !== "pass"
      ? `<div class="doctor-check-detail">${escape(core, detail)}</div>`
      : "";
    return (
      `<div class="doctor-check-row doctor-check-row-compact ${cls}">` +
        `<div class="doctor-check-main doctor-local-server-main${fixButton ? " with-action" : ""}">` +
          `<span class="doctor-check-dot"></span>` +
          `<span class="doctor-check-label">${escape(core, checkLabel(core, check))}</span>` +
          `<span class="doctor-check-summary" title="${escape(core, detail)}">${escape(core, detail)}</span>` +
          `<span class="doctor-check-status">${escape(core, checkStatusLabel(core, check))}</span>` +
          fixButton +
        `</div>` +
        fullDetail +
        repairFeedback +
      `</div>`
    );
  }

  function renderAgentIntegrationCheck(core, check, cls) {
    const expanded = isCheckExpanded(check);
    const summary = formatAgentIntegrationSummary(core, check) || check.detail || "";
    return (
      `<div class="doctor-check-row doctor-agent-collapsible ${cls}${expanded ? " expanded" : " collapsed"}">` +
        `<button type="button" class="doctor-check-main doctor-agent-toggle" data-action="toggle-check" data-check-id="${escape(core, check.id)}" aria-expanded="${expanded ? "true" : "false"}">` +
          `<span class="doctor-check-dot"></span>` +
          `<span class="doctor-agent-chevron" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><path d="M8 5l5 5-5 5"></path></svg></span>` +
          `<span class="doctor-check-label">${escape(core, checkLabel(core, check))}</span>` +
          `<span class="doctor-check-summary">${escape(core, summary)}</span>` +
          `<span class="doctor-check-status">${escape(core, checkStatusLabel(core, check))}</span>` +
        `</button>` +
        `<div class="doctor-agent-body" aria-hidden="${expanded ? "false" : "true"}"${expanded ? "" : " inert"}>` +
          `<div class="doctor-agent-body-inner">` +
            renderAgentRows(core, check) +
          `</div>` +
        `</div>` +
      `</div>`
    );
  }

  function renderCheckList(core, result) {
    if (state.checksLoading) return renderCheckSkeleton(core);
    const checks = result && Array.isArray(result.checks) ? result.checks : [];
    if (!checks.length) {
      return `<div class="doctor-empty">${escape(core, t(core, "doctorNoResult"))}</div>`;
    }
    return checks.map((check) => {
      const cls = check.level === "critical" ? "critical" : (check.level === "warning" ? "warning" : "pass");
      if (check.id === "local-server") return renderLocalServerCheck(core, check, cls);
      if (check.id === "agent-integrations") return renderAgentIntegrationCheck(core, check, cls);
      const fixButton = renderFixButton(core, check.fixAction);
      const repairFeedback = renderRepairFeedback(core, check.fixAction);
      return (
        `<div class="doctor-check-row ${cls}">` +
          `<div class="doctor-check-main${fixButton ? " with-action" : ""}">` +
            `<span class="doctor-check-dot"></span>` +
            `<span class="doctor-check-label">${escape(core, checkLabel(core, check))}</span>` +
            `<span class="doctor-check-status">${escape(core, checkStatusLabel(core, check))}</span>` +
            fixButton +
          `</div>` +
          (check.detail ? `<div class="doctor-check-detail">${escape(core, check.detail)}</div>` : "") +
          repairFeedback +
        `</div>`
      );
    }).join("");
  }

  function renderCheckSkeleton(core) {
    const labels = [
      t(core, "doctorCheckLocalServer"),
      t(core, "doctorCheckAgentIntegrations"),
      t(core, "doctorCheckPermissionBubbles"),
      t(core, "doctorCheckTheme"),
    ];
    return labels.map((label, index) => (
      `<div class="doctor-check-row doctor-check-skeleton" aria-busy="true">` +
        `<div class="doctor-check-main">` +
          `<span class="doctor-check-dot"></span>` +
          `<span class="doctor-skeleton-title">${escape(core, label)}</span>` +
          `<span class="doctor-skeleton-pill"></span>` +
        `</div>` +
        `<div class="doctor-skeleton-line ${index === 1 ? "short" : ""}"></div>` +
      `</div>`
    )).join("");
  }

  function renderConnectionTest(core) {
    const test = state.connectionTest;
    const cls = `${connectionStatusClass(test)}${state.connectionTesting ? " testing" : ""}`;
    const detail = state.connectionTesting
      ? t(core, "doctorConnectionInstruction")
      : (test && test.detail) || t(core, "doctorConnectionInstruction");
    const progress = state.connectionTesting
      ? `<div class="doctor-connection-progress" aria-hidden="true"><span style="width: ${escape(core, String(connectionProgressPercent()))}%"></span></div>`
      : "";
    return (
      `<div class="doctor-connection-panel ${cls}">` +
        `<div class="doctor-connection-main">` +
          `<span class="doctor-check-dot"></span>` +
          `<span class="doctor-check-label">${escape(core, t(core, "doctorConnectionTitle"))}</span>` +
          `<span class="doctor-check-status">${escape(core, connectionStatusLabel(core, test))}</span>` +
        `</div>` +
        `<div class="doctor-check-detail">${escape(core, detail)}</div>` +
        progress +
      `</div>`
    );
  }

  function connectionProgressPercent() {
    if (!state.connectionTesting) return 0;
    const total = 10;
    const remaining = Math.max(0, Math.min(total, state.connectionRemainingSeconds));
    return Math.round(((total - remaining) / total) * 100);
  }

  function renderActionNotice(core) {
    const notice = state.actionNotice;
    if (!notice || !notice.message) return `<div class="doctor-action-notice-slot" aria-live="polite"></div>`;
    const cls = notice.error ? "error" : "ok";
    const iconPath = notice.error
      ? "M10 5v6M10 15h.01M10 2a8 8 0 100 16 8 8 0 000-16z"
      : "M5 10.5l3 3L15 7";
    return (
      `<div class="doctor-action-notice-slot" aria-live="polite">` +
        `<div class="doctor-action-notice ${cls}" role="status">` +
          `<span class="doctor-action-notice-icon" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><path d="${iconPath}"></path></svg></span>` +
          `<span class="doctor-action-notice-text">${escape(core, notice.message)}</span>` +
        `</div>` +
      `</div>`
    );
  }

  function renderModalBody(core, result, options = {}) {
    state.fixActionByKey = new Map();
    const issueCount = result && result.overall ? result.overall.issueCount || 0 : 0;
    const testDisabled = state.connectionTesting ? " disabled" : "";
    const checkList = renderCheckList(core, result);
    const fixConfirm = renderFixConfirm(core);
    const modalClass = options.entering ? "doctor-modal doctor-modal-entering" : "doctor-modal";
    return (
      `<div class="${modalClass}">` +
        `<div class="doctor-modal-header">` +
          `<div class="doctor-title-row">` +
            `<h2>${escape(core, t(core, "doctorTitle"))}</h2>` +
            `<div class="doctor-overall ${overallClass(result)}">` +
              `<span class="doctor-overall-dot"></span>` +
              `<span>${escape(core, overallText(core, result))}</span>` +
              `<span class="doctor-issue-count">${escape(core, t(core, "doctorIssueCount").replace("{count}", String(issueCount)))}</span>` +
              renderLastChecked(core, result) +
            `</div>` +
          `</div>` +
          `<button type="button" class="doctor-close" aria-label="${escape(core, t(core, "doctorClose"))}" title="${escape(core, t(core, "doctorClose"))}"><svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M6 6l8 8M14 6l-8 8"></path></svg></button>` +
        `</div>` +
        `<div class="doctor-privacy">${escape(core, t(core, "doctorPrivacy"))}</div>` +
        renderRepairSummary(core) +
        `<div class="doctor-check-list">${checkList}</div>` +
        fixConfirm +
        renderConnectionTest(core) +
        `<div class="doctor-action-bar">` +
          `<div class="doctor-action-side">` +
            renderActionNotice(core) +
          `</div>` +
          `<div class="doctor-actions">` +
            `<button type="button" class="soft-btn" data-action="copy">${escape(core, t(core, "doctorCopyReport"))}</button>` +
            `<button type="button" class="soft-btn" data-action="open-log">${escape(core, t(core, "doctorOpenLog"))}</button>` +
            `<button type="button" class="soft-btn" data-action="test-connection"${testDisabled}>${escape(core, t(core, "doctorTestConnection"))}</button>` +
            `<button type="button" class="soft-btn accent" data-action="rerun">${escape(core, t(core, "doctorRerun"))}</button>` +
          `</div>` +
        `</div>` +
      `</div>`
    );
  }

  function closeModal() {
    state.modalOpen = false;
    state.connectionRunId += 1;
    state.repairRunId += 1;
    stopConnectionCountdown();
    clearActionNoticeTimer();
    clearModalEnteringTimer();
    state.actionNotice = null;
    state.modalEntering = false;
    state.checkExpansionOverrides = new Map();
    state.connectionTesting = false;
    state.connectionRemainingSeconds = 0;
    state.connectionTest = null;
    state.repairingKey = null;
    state.repairFeedback = {};
    state.pendingConfirmAction = null;
    state.lastRepairFeedback = null;
    const rootEl = document.getElementById("modalRoot");
    if (rootEl) rootEl.innerHTML = "";
  }

  function stopConnectionCountdown() {
    if (state.connectionTimer) {
      clearInterval(state.connectionTimer);
      state.connectionTimer = null;
    }
  }

  function refreshModal(core) {
    if (state.modalOpen) mountModal(core, state.lastResult);
  }

  function mountModal(core, result) {
    const opening = !state.modalOpen;
    if (opening) startModalEntering();
    const entering = state.modalEntering;
    state.modalOpen = true;
    const rootEl = document.getElementById("modalRoot");
    if (!rootEl) return;
    rootEl.innerHTML = (
      `<div class="modal-backdrop doctor-modal-backdrop">` +
        renderModalBody(core, result, { entering }) +
      `</div>`
    );
    const backdrop = rootEl.querySelector(".doctor-modal-backdrop");
    const modal = rootEl.querySelector(".doctor-modal");
    const close = rootEl.querySelector(".doctor-close");
    const copy = rootEl.querySelector('[data-action="copy"]');
    const rerun = rootEl.querySelector('[data-action="rerun"]');
    const testConnection = rootEl.querySelector('[data-action="test-connection"]');
    const openLog = rootEl.querySelector('[data-action="open-log"]');
    const fixButtons = rootEl.querySelectorAll('[data-action="fix"]');
    const confirmFix = rootEl.querySelector('[data-action="confirm-fix"]');
    const cancelFixConfirm = rootEl.querySelector('[data-action="cancel-fix-confirm"]');
    const toggleCheckButtons = rootEl.querySelectorAll('[data-action="toggle-check"]');
    if (backdrop) {
      backdrop.addEventListener("click", (ev) => {
        if (ev.target === backdrop) closeModal();
      });
    }
    if (modal) modal.addEventListener("click", (ev) => ev.stopPropagation());
    if (close) close.addEventListener("click", closeModal);
    if (copy) {
      copy.addEventListener("click", async () => {
        try {
          const report = await root.doctor.getReport();
          await navigator.clipboard.writeText(report);
          showToast(core, t(core, "doctorCopied"));
        } catch (err) {
          showToast(core, (err && err.message) || t(core, "doctorCopyFailed"), { error: true });
        }
      });
    }
    if (rerun) {
      rerun.addEventListener("click", () => runAndOpen(core));
    }
    if (testConnection) {
      testConnection.addEventListener("click", () => startConnectionTest(core));
    }
    if (openLog) {
      openLog.addEventListener("click", async () => {
        try {
          if (!root.doctor || typeof root.doctor.openClawdLog !== "function") throw new Error(t(core, "doctorOpenLogFailed"));
          const result = await root.doctor.openClawdLog();
          if (!result || result.status !== "ok") throw new Error((result && (result.message || result.reason)) || t(core, "doctorOpenLogFailed"));
          showToast(core, t(core, "doctorOpenLogOpened"));
        } catch (err) {
          showToast(core, (err && err.message) || t(core, "doctorOpenLogFailed"), { error: true });
        }
      });
    }
    for (const button of fixButtons) {
      button.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const key = button.getAttribute("data-fix-key") || "";
        const action = state.fixActionByKey.get(key) || { type: "" };
        startFixAction(core, action);
      });
    }
    if (confirmFix) {
      confirmFix.addEventListener("click", () => {
        const action = state.pendingConfirmAction;
        if (!action) return;
        startFixAction(core, { ...action, confirmed: true });
      });
    }
    if (cancelFixConfirm) {
      cancelFixConfirm.addEventListener("click", () => {
        state.pendingConfirmAction = null;
        refreshModal(core);
      });
    }
    for (const button of toggleCheckButtons) {
      button.addEventListener("click", () => {
        const id = button.getAttribute("data-check-id") || "";
        const expanded = button.getAttribute("aria-expanded") === "true";
        if (id) state.checkExpansionOverrides.set(id, !expanded);
        const row = button.parentElement || button.parentNode;
        const body = row && row.querySelector ? row.querySelector(".doctor-agent-body") : null;
        button.setAttribute("aria-expanded", expanded ? "false" : "true");
        if (row && row.classList) {
          row.classList.toggle("expanded", !expanded);
          row.classList.toggle("collapsed", expanded);
        }
        if (body) {
          body.setAttribute("aria-hidden", expanded ? "true" : "false");
          if (expanded) body.setAttribute("inert", "");
          else body.removeAttribute("inert");
        }
      });
    }
  }

  async function startFixAction(core, action) {
    if (state.repairingKey) return;
    if (!root.settingsAPI || typeof root.settingsAPI.command !== "function") {
      showToast(core, t(core, "doctorFixFailed"), { error: true });
      return;
    }
    if (requiresFixConfirmation(action) && action.confirmed !== true) {
      state.pendingConfirmAction = action;
      refreshModal(core);
      return;
    }
    const repairKey = fixActionKey(action);
    const runId = ++state.repairRunId;
    state.repairingKey = repairKey;
    state.pendingConfirmAction = null;
    state.lastRepairFeedback = null;
    if (state.repairFeedback) delete state.repairFeedback[repairKey];
    refreshModal(core);
    try {
      const commandAction = { ...action };
      if (commandAction.type !== "restart-clawd") delete commandAction.confirmed;
      const result = await root.settingsAPI.command("repairDoctorIssue", commandAction);
      if (runId !== state.repairRunId) return;
      if (!result || result.status !== "ok") {
        throw new Error((result && result.message) || t(core, "doctorFixFailed"));
      }
      let message = (result && result.message) || t(core, "doctorFixApplied");
      // Codex hooks need an explicit user review pass in the codex TUI before
      // they go live (sha256 trusted_hash gate). Append the reminder so users
      // don't have to discover the dead zone themselves.
      if (action && action.type === "agent-integration" && action.agentId === "codex") {
        message = `${message} ${t(core, "codexHookReviewReminder")}`;
      }
      state.repairFeedback[repairKey] = { status: "ok", message };
      state.lastRepairFeedback = { status: "ok", message };
      showToast(core, message);
      // restart-clawd tears the main process down right after this IPC reply,
      // so re-running the checks would race the process exit and surface a
      // spurious error toast. The new process re-renders Doctor on launch.
      if (action && action.type === "restart-clawd") return;
      await runChecks(core);
    } catch (err) {
      if (runId !== state.repairRunId) return;
      const message = (err && err.message) || t(core, "doctorFixFailed");
      state.repairFeedback[repairKey] = { status: "error", message };
      state.lastRepairFeedback = { status: "error", message };
      showToast(core, message, { error: true });
    } finally {
      if (runId !== state.repairRunId) return;
      state.repairingKey = null;
      refreshModal(core);
    }
  }

  async function startConnectionTest(core) {
    if (state.connectionTesting) return;
    if (!root.doctor || typeof root.doctor.testConnection !== "function") {
      showToast(core, t(core, "doctorConnectionError"), { error: true });
      return;
    }
    const durationMs = 10000;
    const runId = ++state.connectionRunId;
    state.connectionTesting = true;
    state.connectionTest = null;
    state.connectionRemainingSeconds = Math.ceil(durationMs / 1000);
    stopConnectionCountdown();
    state.connectionTimer = setInterval(() => {
      state.connectionRemainingSeconds = Math.max(0, state.connectionRemainingSeconds - 1);
      refreshModal(core);
    }, 1000);
    refreshModal(core);
    let nextConnectionTest = null;
    try {
      nextConnectionTest = await root.doctor.testConnection(durationMs);
    } catch (err) {
      nextConnectionTest = {
        status: "error",
        level: "warning",
        detail: (err && err.message) || t(core, "doctorRunFailed"),
      };
    } finally {
      if (runId !== state.connectionRunId) return;
      state.connectionTest = nextConnectionTest;
      state.connectionTesting = false;
      state.connectionRemainingSeconds = 0;
      stopConnectionCountdown();
      refreshModal(core);
    }
  }

  async function runChecks(core) {
    if (!root.doctor || typeof root.doctor.runChecks !== "function") return null;
    if (state.runningPromise) return state.runningPromise;
    state.checksLoading = true;
    if (state.modalOpen) refreshModal(core);
    state.runningPromise = Promise.resolve()
      .then(() => root.doctor.runChecks())
      .then((result) => {
        state.lastResult = result;
        updateIndicator(core, result);
        return result;
      })
      .catch((err) => {
        updateIndicator(core, null);
        throw err;
      })
      .finally(() => {
        state.runningPromise = null;
        state.checksLoading = false;
        if (state.modalOpen) refreshModal(core);
      });
    return state.runningPromise;
  }

  async function runAndOpen(core) {
    mountModal(core, state.lastResult);
    try {
      const result = await runChecks(core);
      mountModal(core, result);
    } catch (err) {
      showToast(core, (err && err.message) || t(core, "doctorRunFailed"), { error: true });
      mountModal(core, state.lastResult);
    }
  }

  function renderSidebarIndicator(sidebar, core) {
    const item = document.createElement("div");
    item.className = "sidebar-item doctor-indicator";
    item.innerHTML =
      `<span class="doctor-indicator-dot"></span>` +
      `<span class="sidebar-item-label">${escape(core, t(core, "doctorSidebarLabel"))}</span>` +
      `<span class="doctor-indicator-status">${escape(core, t(core, "doctorStatusUnknown"))}</span>`;
    item.addEventListener("click", () => runAndOpen(core));
    sidebar.appendChild(item);
    state.indicator = item;
    state.dot = item.querySelector(".doctor-indicator-dot");
    state.label = item.querySelector(".sidebar-item-label");
    state.status = item.querySelector(".doctor-indicator-status");
    updateIndicator(core, state.lastResult);
    if (!state.initialRunStarted && !state.lastResult) {
      state.initialRunStarted = true;
      runChecks(core).catch(() => updateIndicator(core, null));
    }
  }

  root.ClawdSettingsDoctorModal = {
    renderSidebarIndicator,
    runChecks,
    open: runAndOpen,
  };
})(globalThis);
