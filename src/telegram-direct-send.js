"use strict";

const { getEntryDisplaySessionTag } = require("./state-session-snapshot");

const { execFile: defaultExecFile } = require("child_process");
const {
  getSessionFocusTarget,
  isFocusableLocalHudSession,
} = require("./session-focus");
const { createTranslator } = require("./i18n");
const { isPassiveNotifyEntry } = require("./passive-notify-entry");

const DEFAULT_MAPPING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_AUTO_SUBMIT_TEXT = 3800;
const DEFAULT_MAX_MAPPINGS = 1000;
const DEFAULT_MAX_DELIVERIES = 100;
const WINDOWS_PASTE_RESTORE_DELAY_MS = 800;
const WINDOWS_PASTE_READY_DELAY_MS = 250;
const WINDOWS_EDITOR_PASTE_READY_DELAY_MS = 1200;
const WINDOWS_PASTE_TIMEOUT_MS = 1500;
const DELIVERY_STATUSES = new Set([
  "focus_only",
  "sent_with_enter",
  "queued",
  "pasted_without_enter",
  "fallback_copied",
  "failed",
]);
const TARGET_GUARD_ERRORS = new Set([
  "direct_send_cancelled",
  "direct_send_disabled",
  "permission_pending",
  "session_identity_changed",
  "session_not_live",
  "session_not_ready",
  "target_not_focusable",
  "target_validation_failed",
]);
const NO_FALLBACK_ERRORS = new Set([
  ...TARGET_GUARD_ERRORS,
  "partial_console_write",
  "console_input_result_unknown",
  "codex_queue_result_unknown",
]);

function normalizeMessageId(value) {
  if (value == null) return "";
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? trimmed : "";
  }
  return "";
}

function normalizeChatId(value) {
  if (value == null) return "";
  const text = String(value).trim();
  return /^-?[1-9]\d{0,19}$/.test(text) ? text : "";
}

function mappingKey(messageId, chatId = "") {
  const message = normalizeMessageId(messageId);
  if (!message) return "";
  const chat = normalizeChatId(chatId);
  return chat ? `${chat}\u0000${message}` : message;
}

function normalizeHwndString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!/^[1-9]\d{0,18}$/.test(text)) return null;
  try {
    return BigInt(text) <= 9223372036854775807n ? text : null;
  } catch {
    return null;
  }
}

function normalizeSessionId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizePromptText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .trim();
}

function shortSessionId(entry) {
  return getEntryDisplaySessionTag(entry);
}

function findSession(snapshot, sessionId) {
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  return sessions.find((entry) => entry && entry.id === sessionId) || null;
}

function collectOtherSessionAgentPids(snapshot, targetEntry) {
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  const targetId = String(targetEntry && targetEntry.id || "");
  const targetPid = normalizePid(targetEntry && targetEntry.agentPid);
  const out = [];
  for (const entry of sessions) {
    if (!entry || String(entry.id || "") === targetId) continue;
    if (entry.host || entry.headless || entry.hiddenFromHud || entry.state === "sleeping") continue;
    const pid = normalizePid(entry.agentPid);
    if (!pid || pid === targetPid || out.includes(pid)) continue;
    out.push(pid);
  }
  return out;
}

function hasSameAgentPidPeer(snapshot, targetEntry) {
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  const targetId = String(targetEntry && targetEntry.id || "");
  const targetPid = normalizePid(targetEntry && targetEntry.agentPid);
  if (!targetId || !targetPid) return false;
  return sessions.some((entry) => {
    if (!entry || String(entry.id || "") === targetId) return false;
    if (entry.host || entry.headless || entry.hiddenFromHud || entry.state === "sleeping") return false;
    return normalizePid(entry.agentPid) === targetPid;
  });
}

function deliveryAdapterRequiresFocus(deliveryAdapter) {
  return !(deliveryAdapter && deliveryAdapter.requiresFocus === false);
}

function deliveryAdapterRequiresMappedAgentPid(deliveryAdapter) {
  return !!(deliveryAdapter && deliveryAdapter.requiresMappedAgentPid === true);
}

function deliveryAdapterRequiresFocusableTarget(deliveryAdapter) {
  return !(deliveryAdapter && deliveryAdapter.requiresFocusableTarget === false);
}

function deliveryAdapterRequiresPidDisambiguation(deliveryAdapter) {
  return !(deliveryAdapter && deliveryAdapter.requiresPidDisambiguation === false);
}

function deliveryAdapterAllowsTarget(deliveryAdapter, entry) {
  if (!deliveryAdapter || typeof deliveryAdapter.canDeliver !== "function") return true;
  try {
    return deliveryAdapter.canDeliver(entry) === true;
  } catch {
    return false;
  }
}

function normalizePid(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : null;
}

function normalizeEditorIdentity(value) {
  return value === "code" || value === "cursor" ? value : null;
}

function normalizeStringIdentity(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOriginatorIdentity(value) {
  const text = normalizeStringIdentity(value);
  return text ? text.toLowerCase() : null;
}

function captureSessionIdentity(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    id: normalizeSessionId(entry.id),
    rawSessionId: normalizeStringIdentity(entry.rawSessionId),
    agentId: normalizeSessionId(entry.agentId),
    sourcePid: normalizePid(entry.sourcePid),
    agentPid: normalizePid(entry.agentPid),
    editor: normalizeEditorIdentity(entry.editor),
    wtHwnd: normalizeHwndString(entry.wtHwnd),
    orcaPaneKey: normalizeSessionId(entry.orcaPaneKey) || null,
    codexOriginator: normalizeOriginatorIdentity(entry.codexOriginator || entry.originator),
  };
}

// Completion mappings may come from older callers that only recorded a
// session id (or one of the process ids). Compare only identity fields that
// were present when the mapping was created; a missing field cannot establish
// an identity fence, while a recorded field must still match exactly.
function mappingIdentityMatches(entry, mapping) {
  const current = captureSessionIdentity(entry);
  if (!current || !mapping) return false;
  const expected = {
    rawSessionId: normalizeStringIdentity(mapping.rawSessionId),
    agentId: normalizeSessionId(mapping.agentId) || null,
    sourcePid: normalizePid(mapping.sourcePid),
    agentPid: normalizePid(mapping.agentPid),
    editor: normalizeEditorIdentity(mapping.editor),
    wtHwnd: normalizeHwndString(mapping.wtHwnd),
    orcaPaneKey: normalizeSessionId(mapping.orcaPaneKey) || null,
    codexOriginator: normalizeOriginatorIdentity(mapping.codexOriginator),
  };
  for (const field of Object.keys(expected)) {
    if (expected[field] != null && current[field] !== expected[field]) return false;
  }
  return true;
}

function hasSameSessionIdentity(entry, expectedIdentity) {
  if (!expectedIdentity) return true;
  const current = captureSessionIdentity(entry);
  if (!current || current.id !== expectedIdentity.id) return false;
  for (const field of [
    "rawSessionId",
    "agentId",
    "sourcePid",
    "agentPid",
    "editor",
    "wtHwnd",
    "orcaPaneKey",
    "codexOriginator",
  ]) {
    if (expectedIdentity[field] != null && current[field] !== expectedIdentity[field]) return false;
  }
  return true;
}

function isReplyReadySession(entry) {
  return !!entry
    && entry.state === "idle"
    && (entry.badge === "done" || entry.badge === "interrupted");
}

function isInteractivePermissionEntryForSession(permEntry, sessionId) {
  return !!permEntry
    && String(permEntry.sessionId || "") === String(sessionId || "")
    && !isPassiveNotifyEntry(permEntry);
}

function hasInteractivePermissionPending(entry, getPendingPermissions) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof getPendingPermissions === "function") {
    let pending;
    try {
      pending = getPendingPermissions();
    } catch {
      return true;
    }
    const list = Array.isArray(pending) ? pending : [];
    return list.some((permEntry) => isInteractivePermissionEntryForSession(permEntry, entry.id));
  }
  return entry.state === "notification";
}

function normalizeOrcaPaneOutcome(value) {
  if (!value || typeof value !== "object") return null;
  return {
    ok: value.ok === true,
    match: value.match === "exact" || value.match === "cwd" ? value.match : null,
    reason: typeof value.reason === "string" && value.reason ? value.reason : "unknown",
  };
}

function normalizeFocusGateResult(value) {
  if (value && typeof value === "object") {
    return {
      reason: typeof value.reason === "string" && value.reason ? value.reason : "unknown",
      token: typeof value.token === "string" && value.token ? value.token : null,
      targetHwnd: normalizeHwndString(value.targetHwnd),
      foregroundHwnd: normalizeHwndString(value.foregroundHwnd),
      confirmed: value.confirmed === true,
      status: value.confirmed === true ? "confirmed" : "unconfirmed",
      // This normalizer is a whitelist: without a line here the pane outcome is
      // dropped between focusSession and the adapter, and the gate reads undefined
      // on every real delivery while hand-built test payloads still pass.
      orcaPane: normalizeOrcaPaneOutcome(value.orcaPane),
    };
  }
  return {
    reason: value === true ? "legacy-focus-without-result" : "focus-not-submitted",
    token: null,
    targetHwnd: null,
    foregroundHwnd: null,
    confirmed: false,
    status: "unconfirmed",
    orcaPane: null,
  };
}

function createFocusOnlyDeliveryAdapter() {
  return {
    deliver: async () => ({
      status: "focus_only",
      delivered: false,
      errorClass: "delivery_not_implemented",
    }),
  };
}

function createClipboardFallbackDeliveryAdapter({ clipboard } = {}) {
  return {
    copy: async (payload = {}) => {
      const promptText = typeof payload.promptText === "string" ? payload.promptText : "";
      if (!promptText) {
        return { status: "failed", delivered: false, errorClass: "empty_prompt" };
      }
      if (!clipboard || typeof clipboard.writeText !== "function") {
        return { status: "failed", delivered: false, errorClass: "clipboard_unavailable" };
      }
      try {
        clipboard.writeText(promptText, "clipboard");
      } catch {
        return { status: "failed", delivered: false, errorClass: "clipboard_write_failed" };
      }
      if (typeof clipboard.readText === "function") {
        try {
          if (clipboard.readText("clipboard") !== promptText) {
            return { status: "failed", delivered: false, errorClass: "clipboard_write_unconfirmed" };
          }
        } catch {
          return { status: "failed", delivered: false, errorClass: "clipboard_verify_failed" };
        }
      }
      return {
        status: "fallback_copied",
        delivered: false,
        autoEnter: false,
        errorClass: null,
      };
    },
  };
}

function buildWindowsPasteShortcutScript() {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ClawdPasteKeys {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[ClawdPasteKeys]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
[ClawdPasteKeys]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
[ClawdPasteKeys]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)
[ClawdPasteKeys]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
`;
}

function execFileAsync(execFile, command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function defaultDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// These hosts complete their terminal-tab switch asynchronously, after the window
// focus has already been confirmed. On the default ready delay the paste lands in
// whichever tab was previously active — dropping the user's reply into another
// session's prompt, and losing it from the one they answered. For Orca the switch
// is now awaited outright (see isOrcaPaneConfirmed), so this delay only covers the
// composer settling after the tab is already in front.
// The field arrives via buildSessionSnapshotEntry, which is a whitelist — a host
// added here needs its identifier carried there too or this stays dead code.
function isAsyncTabSwitchEntry(entry) {
  if (!entry) return false;
  return entry.editor === "code" || entry.editor === "cursor" || !!entry.orcaPaneKey;
}

// A confirmed focus only means Orca's window came forward; the pane switch is a
// separate CLI round-trip that can miss, time out, or land on a worktree guess.
// Pasting on anything short of an exact pane match types the reply into a composer
// the user never chose, so the delivery has to fail into the clipboard fallback
// instead of reporting success.
function isOrcaPaneConfirmed(payload) {
  if (!payload || !payload.entry || !payload.entry.orcaPaneKey) return true;
  const pane = payload.focusResult && payload.focusResult.orcaPane;
  return !!(pane && pane.ok === true && pane.match === "exact");
}

function createWindowsPasteOnlyDeliveryAdapter({
  clipboard,
  execFile = defaultExecFile,
  osPlatform = process.platform,
  restoreDelayMs = WINDOWS_PASTE_RESTORE_DELAY_MS,
  readyDelayMs = WINDOWS_PASTE_READY_DELAY_MS,
  timeoutMs = WINDOWS_PASTE_TIMEOUT_MS,
  delay = defaultDelay,
  restoreClipboardOnSuccess = false,
} = {}) {
  return {
    async deliver(payload = {}) {
      const promptText = typeof payload.promptText === "string" ? payload.promptText : "";
      if (osPlatform !== "win32") {
        return { status: "failed", delivered: false, errorClass: "platform_unsupported" };
      }
      if (!payload.focusResult || payload.focusResult.confirmed !== true) {
        return { status: "failed", delivered: false, errorClass: "focus_unconfirmed" };
      }
      if (!promptText) {
        return { status: "failed", delivered: false, errorClass: "empty_prompt" };
      }
      if (/[\r\n]/.test(promptText)) {
        return { status: "failed", delivered: false, errorClass: "multiline_unsupported" };
      }
      if (!clipboard || typeof clipboard.writeText !== "function") {
        return { status: "failed", delivered: false, errorClass: "clipboard_unavailable" };
      }
      // Ahead of the clipboard write: the fallback adapter owns the clipboard on
      // this path, and overwriting it here would clobber what the user gets told
      // was copied for them.
      if (!isOrcaPaneConfirmed(payload)) {
        return { status: "failed", delivered: false, errorClass: "orca_pane_unconfirmed" };
      }

      let previousText = null;
      let canRestore = false;
      if (typeof clipboard.readText === "function") {
        try {
          previousText = clipboard.readText();
          canRestore = typeof previousText === "string";
        } catch {}
      }

      try {
        clipboard.writeText(promptText);
      } catch {
        return { status: "failed", delivered: false, errorClass: "clipboard_write_failed" };
      }

      try {
        const effectiveReadyDelayMs = isAsyncTabSwitchEntry(payload.entry)
          ? Math.max(readyDelayMs, WINDOWS_EDITOR_PASTE_READY_DELAY_MS)
          : readyDelayMs;
        await delay(effectiveReadyDelayMs);
        await execFileAsync(execFile, "powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          buildWindowsPasteShortcutScript(),
        ], {
          windowsHide: true,
          timeout: timeoutMs,
          encoding: "utf8",
        });
      } catch {
        if (canRestore) {
          try { clipboard.writeText(previousText); } catch {}
        }
        return { status: "failed", delivered: false, errorClass: "paste_shortcut_failed" };
      }

      let errorClass = null;
      let clipboardRestored = false;
      if (canRestore && restoreClipboardOnSuccess) {
        try {
          await delay(restoreDelayMs);
          clipboard.writeText(previousText);
          clipboardRestored = true;
        } catch {
          errorClass = "clipboard_restore_failed";
        }
      }

      return {
        status: "pasted_without_enter",
        delivered: true,
        autoEnter: false,
        errorClass,
        clipboardRestored,
      };
    },
  };
}

function normalizeDeliveryStatus(value) {
  const status = typeof value === "string" ? value : "";
  return DELIVERY_STATUSES.has(status) ? status : "failed";
}

function normalizeDeliveryResult(value) {
  if (value && typeof value === "object") {
    const status = normalizeDeliveryStatus(value.status);
    return {
      status,
      delivered: value.delivered === true
        || status === "sent_with_enter"
        || status === "queued"
        || status === "pasted_without_enter",
      autoEnter: value.autoEnter === true,
      errorClass: typeof value.errorClass === "string" && value.errorClass
        ? value.errorClass.replace(/[\r\n\t]+/g, " ").slice(0, 80)
        : null,
      clipboardRestored: value.clipboardRestored === true,
    };
  }
  return {
    status: "failed",
    delivered: false,
    autoEnter: false,
    errorClass: "invalid_delivery_result",
  };
}

async function invokeDeliveryAdapter(deliveryAdapter, payload) {
  const adapter = deliveryAdapter || createFocusOnlyDeliveryAdapter();
  if (typeof adapter === "function") return adapter(payload);
  if (adapter && typeof adapter.deliver === "function") return adapter.deliver(payload);
  return { status: "failed", delivered: false, errorClass: "delivery_adapter_missing" };
}

async function invokeFallbackAdapter(fallbackAdapter, payload) {
  if (!fallbackAdapter) return { status: "failed", delivered: false, errorClass: "fallback_not_configured" };
  if (typeof fallbackAdapter === "function") return fallbackAdapter(payload);
  if (fallbackAdapter && typeof fallbackAdapter.copy === "function") return fallbackAdapter.copy(payload);
  if (fallbackAdapter && typeof fallbackAdapter.deliver === "function") return fallbackAdapter.deliver(payload);
  return { status: "failed", delivered: false, errorClass: "fallback_adapter_missing" };
}

// Function-form replacement: shortId is dynamic and must not be parsed for
// $$/$&/$`/$' replacement-pattern sequences.
function interpolate(template, token, value) {
  return template.replace(token, () => value);
}

function formatDeliveryAck(status, entry, deliveryResult, t) {
  const shortId = shortSessionId(entry);
  switch (status) {
    case "sent_with_enter":
      return interpolate(t("directSendAckSent"), "{session}", shortId);
    case "queued":
      return interpolate(t("directSendAckQueued"), "{session}", shortId);
    case "pasted_without_enter":
      if (deliveryResult && deliveryResult.clipboardRestored === true) {
        return interpolate(t("directSendAckPastedRestored"), "{session}", shortId);
      }
      return interpolate(t("directSendAckPastedManual"), "{session}", shortId);
    case "fallback_copied":
      return interpolate(t("directSendAckCopied"), "{session}", shortId);
    case "failed":
      if (deliveryResult && deliveryResult.errorClass === "permission_pending") {
        return t("directSendPermissionPending");
      }
      if (deliveryResult && TARGET_GUARD_ERRORS.has(deliveryResult.errorClass)) {
        return t("directSendSessionChanged");
      }
      return t("directSendAckFailed");
    case "focus_only":
    default:
      if (deliveryResult && deliveryResult.errorClass === "delivery_not_implemented") {
        return interpolate(t("directSendAckFocusOnlyDogfood"), "{session}", shortId);
      }
      return interpolate(t("directSendAckFocusOnly"), "{session}", shortId);
  }
}

function createTelegramDirectSend({
  getSessionSnapshot,
  getPendingPermissions,
  focusSession,
  deliveryAdapter = createFocusOnlyDeliveryAdapter(),
  fallbackAdapter = null,
  isEnabled = () => false,
  getRouteGeneration = null,
  getDeliveryAdapter = null,
  now = () => Date.now(),
  mappingTtlMs = DEFAULT_MAPPING_TTL_MS,
  maxMappings = DEFAULT_MAX_MAPPINGS,
  maxDeliveries = DEFAULT_MAX_DELIVERIES,
  osPlatform = process.platform,
  log = () => {},
  getLang = () => "en",
} = {}) {
  const t = createTranslator(getLang);
  const mappings = new Map(); // chat + completion message id -> { sessionId, expiresAt }
  const sessionSubmissionWatermarks = new Map(); // session id -> { sequence, expiresAt }
  const deliveries = new Map(); // delivery id -> in-memory prompt delivery entry
  let deliverySeq = 0;
  let mappingGeneration = 0;
  let notificationRouteGeneration = 0;
  let notificationSequence = 0;
  // Focus and clipboard are process-global resources on Windows. Queue the
  // whole operation, including fallback and clipboard restoration, so two
  // overlapping Telegram updates cannot switch the foreground window or
  // overwrite each other's clipboard between focus confirmation and key input.
  let deliveryChain = Promise.resolve();

  function safeLog(level, message, meta) {
    try { log(level, message, meta); } catch {}
  }

  function directSendEnabled() {
    try {
      return typeof isEnabled !== "function" || isEnabled() === true;
    } catch {
      return false;
    }
  }

  function routeInvalidation(
    expectedGeneration = null,
    signal = null,
    expectedRouteGeneration = undefined,
  ) {
    if (signal && signal.aborted) {
      return {
        status: "cancelled",
        errorClass: "direct_send_cancelled",
        textKey: "directSendSessionChanged",
      };
    }
    if (expectedGeneration != null && expectedGeneration !== mappingGeneration) {
      return {
        status: "disabled",
        errorClass: "direct_send_disabled",
        textKey: "directSendSessionChanged",
      };
    }
    // A completion mapping may outlive a native polling stop/restart when the
    // token and recipient stay unchanged. Keep the mapping local to the exact
    // polling route that delivered its notification; a new route must never
    // reuse an old Telegram message as a session selector.
    if (expectedRouteGeneration !== undefined) {
      const expectedRoute = normalizeRouteGeneration(expectedRouteGeneration);
      const currentRoute = readRouteGeneration();
      if (expectedRoute === null
        || currentRoute.bound !== true
        || currentRoute.value === null
        || currentRoute.value !== expectedRoute) {
        return {
          status: "disabled",
          errorClass: "direct_send_disabled",
          textKey: "directSendSessionChanged",
        };
      }
    }
    if (!directSendEnabled()) {
      return {
        status: "disabled",
        errorClass: "direct_send_disabled",
        textKey: "directSendSessionChanged",
      };
    }
    return null;
  }

  function readRouteGeneration() {
    if (typeof getRouteGeneration !== "function") {
      return { bound: false, value: null };
    }
    try {
      const rawValue = getRouteGeneration();
      if (rawValue == null || rawValue === "") {
        return { bound: true, value: null };
      }
      const value = Number(rawValue);
      return {
        bound: true,
        value: Number.isSafeInteger(value) && value >= 0 ? value : null,
      };
    } catch {
      return { bound: true, value: null };
    }
  }

  function normalizeRouteGeneration(value) {
    if (value == null || value === "") return null;
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
  }

  function mappingRouteIsCurrent(mapping) {
    if (!mapping || !Object.prototype.hasOwnProperty.call(mapping, "routeGeneration")) {
      return true;
    }
    const expectedRoute = normalizeRouteGeneration(mapping.routeGeneration);
    const currentRoute = readRouteGeneration();
    return expectedRoute !== null
      && currentRoute.bound === true
      && currentRoute.value !== null
      && currentRoute.value === expectedRoute;
  }

  function validateCurrentTarget(
    sessionId,
    expectedIdentity = null,
    expectedGeneration = null,
    signal = null,
    expectedRouteGeneration = undefined,
    targetAdapter = deliveryAdapter,
  ) {
    const invalidation = routeInvalidation(expectedGeneration, signal, expectedRouteGeneration);
    if (invalidation) {
      return {
        ok: false,
        entry: null,
        ...invalidation,
      };
    }
    let snapshot;
    try {
      snapshot = typeof getSessionSnapshot === "function" ? getSessionSnapshot() : null;
    } catch {
      return {
        ok: false,
        entry: null,
        status: "session_changed",
        errorClass: "target_validation_failed",
        textKey: "directSendSessionChanged",
      };
    }
    const entry = findSession(snapshot, sessionId);
    if (!entry) {
      return {
        ok: false,
        entry: null,
        status: "session_not_live",
        errorClass: "session_not_live",
        textKey: "directSendSessionNotLive",
      };
    }
    if (!hasSameSessionIdentity(entry, expectedIdentity)) {
      return {
        ok: false,
        entry,
        status: "session_changed",
        errorClass: "session_identity_changed",
        textKey: "directSendSessionChanged",
      };
    }
    if (hasInteractivePermissionPending(entry, getPendingPermissions)) {
      return {
        ok: false,
        entry,
        status: "permission_pending",
        errorClass: "permission_pending",
        textKey: "directSendPermissionPending",
      };
    }
    if (!isReplyReadySession(entry)) {
      return {
        ok: false,
        entry,
        status: "session_changed",
        errorClass: "session_not_ready",
        textKey: "directSendSessionChanged",
      };
    }
    const allowsTarget = deliveryAdapterAllowsTarget(targetAdapter, entry);
    const requiresFocusableTarget = deliveryAdapterRequiresFocusableTarget(targetAdapter);
    const focusTarget = requiresFocusableTarget
      ? getSessionFocusTarget(entry, { osPlatform })
      : null;
    if (!allowsTarget || (requiresFocusableTarget
      && (!isFocusableLocalHudSession(entry, { osPlatform }) || focusTarget.type !== "terminal"))) {
      return {
        ok: false,
        entry,
        status: "not_focusable",
        errorClass: "target_not_focusable",
        textKey: "directSendNotFocusable",
      };
    }
    return { ok: true, entry, snapshot, focusTarget, status: null, errorClass: null, textKey: null };
  }

  function selectDeliveryAdapter(entry, mapping, payload) {
    let selected = deliveryAdapter;
    if (typeof getDeliveryAdapter !== "function") return selected;
    try {
      const candidate = getDeliveryAdapter({
        entry,
        mapping,
        payload,
      });
      if (candidate) selected = candidate;
    } catch (err) {
      safeLog("warn", "direct-send delivery adapter selection failed", {
        sessionId: entry && entry.id,
        error: err && err.message,
      });
    }
    return selected;
  }

  function targetChangedResponse(deliveryEntry, validation, sessionId, focusResult = null) {
    const entry = validation.entry || { id: sessionId };
    safeLog("info", "direct-send stopped: target changed before delivery", {
      sessionId,
      errorClass: validation.errorClass,
    });
    updateDeliveryEntry(deliveryEntry, validation.status, {
      sessionId,
      agentId: entry.agentId || deliveryEntry.agentId || null,
      focusResult: focusResult || deliveryEntry.focusResult || null,
      errorClass: validation.errorClass,
    });
    return {
      status: validation.status,
      sessionId,
      deliveryId: deliveryEntry.id,
      focusResult: focusResult || undefined,
      text: t(validation.textKey || "directSendSessionChanged"),
    };
  }

  function nextDeliveryId() {
    deliverySeq += 1;
    return `tds-${now().toString(36)}-${deliverySeq.toString(36)}`;
  }

  function pruneDeliveries() {
    const limit = Math.max(1, Number.isFinite(maxDeliveries) ? Math.floor(maxDeliveries) : DEFAULT_MAX_DELIVERIES);
    while (deliveries.size > limit) {
      const firstKey = deliveries.keys().next().value;
      if (!firstKey) break;
      deliveries.delete(firstKey);
    }
  }

  function createDeliveryEntry(payload, promptText) {
    const ts = now();
    const entry = {
      id: nextDeliveryId(),
      promptText,
      chatId: payload.chatId != null ? String(payload.chatId) : null,
      fromId: payload.fromId != null ? String(payload.fromId) : null,
      telegramMessageId: normalizeMessageId(payload.messageId) || null,
      replyToMessageId: normalizeMessageId(payload.replyToMessageId) || null,
      sessionId: null,
      agentId: null,
      status: "received",
      errorClass: null,
      focusResult: null,
      deliveryResult: null,
      createdAt: ts,
      updatedAt: ts,
      statusHistory: [{ status: "received", at: ts }],
    };
    deliveries.set(entry.id, entry);
    pruneDeliveries();
    return entry;
  }

  function updateDeliveryEntry(deliveryEntry, status, patch = {}) {
    if (!deliveryEntry) return null;
    const nextStatus = typeof status === "string" && status ? status : deliveryEntry.status;
    deliveryEntry.status = nextStatus;
    deliveryEntry.updatedAt = now();
    deliveryEntry.statusHistory.push({ status: nextStatus, at: deliveryEntry.updatedAt });
    Object.assign(deliveryEntry, patch);
    return deliveryEntry;
  }

  async function tryClipboardFallback(
    deliveryEntry,
    entry,
    reason,
    patch = {},
    expectedGeneration = null,
    signal = null,
    expectedRouteGeneration = undefined,
  ) {
    if (!fallbackAdapter) return null;
    if ((signal && signal.aborted)
      || !directSendEnabled()
      || (expectedGeneration != null && expectedGeneration !== mappingGeneration)
      || (expectedRouteGeneration !== undefined
        && !mappingRouteIsCurrent({ routeGeneration: expectedRouteGeneration }))) {
      updateDeliveryEntry(deliveryEntry, "disabled", {
        ...patch,
        errorClass: signal && signal.aborted
          ? "direct_send_cancelled"
          : "direct_send_disabled",
      });
      return null;
    }
    let fallbackResult;
    try {
      fallbackResult = normalizeDeliveryResult(await invokeFallbackAdapter(fallbackAdapter, {
        deliveryId: deliveryEntry && deliveryEntry.id,
        promptText: deliveryEntry && deliveryEntry.promptText,
        sessionId: patch.sessionId || (entry && entry.id) || null,
        agentId: patch.agentId || (entry && entry.agentId) || null,
        reason,
        entry,
        focusResult: patch.focusResult || null,
        autoEnter: false,
        signal,
      }));
    } catch {
      fallbackResult = normalizeDeliveryResult({
        status: "failed",
        delivered: false,
        errorClass: "fallback_adapter_threw",
      });
    }

    // The fallback adapter may have an asynchronous clipboard/OS boundary.
    // Re-check the route after it resolves before reporting a successful copy:
    // a token/recipient reset or polling abort can happen while that operation
    // is in flight. The clipboard write is already an external side effect, so
    // retain its result as an uncertain delivery, but never emit a success ack
    // or let the stale operation masquerade as a current one.
    const cancelled = !!(signal && signal.aborted);
    const staleGeneration = expectedGeneration != null
      && expectedGeneration !== mappingGeneration;
    const staleRoute = expectedRouteGeneration !== undefined
      && !mappingRouteIsCurrent({ routeGeneration: expectedRouteGeneration });
    const disabled = !directSendEnabled();
    if (cancelled || staleGeneration || staleRoute || disabled) {
      const errorClass = cancelled ? "direct_send_cancelled" : "direct_send_disabled";
      updateDeliveryEntry(deliveryEntry, cancelled ? "cancelled" : "disabled", {
        ...patch,
        deliveryResult: fallbackResult,
        fallbackReason: reason,
        fallbackErrorClass: errorClass,
        errorClass,
        fallbackUncertain: fallbackResult.status === "fallback_copied",
      });
      safeLog("info", "direct-send fallback completed after route became inactive", {
        sessionId: patch.sessionId || (entry && entry.id) || undefined,
        reason,
        errorClass,
        fallbackStatus: fallbackResult.status,
      });
      return null;
    }

    if (fallbackResult.status !== "fallback_copied") {
      safeLog("warn", "direct-send fallback copy failed", {
        sessionId: patch.sessionId || (entry && entry.id) || undefined,
        reason,
        errorClass: fallbackResult.errorClass || undefined,
      });
      if (deliveryEntry) {
        Object.assign(deliveryEntry, {
          deliveryResult: fallbackResult,
          fallbackReason: reason,
          fallbackErrorClass: fallbackResult.errorClass,
          updatedAt: now(),
        });
      }
      return null;
    }

    safeLog("info", "direct-send fallback copied", {
      sessionId: patch.sessionId || (entry && entry.id) || undefined,
      reason,
    });
    updateDeliveryEntry(deliveryEntry, "fallback_copied", {
      ...patch,
      deliveryResult: fallbackResult,
      fallbackReason: reason,
    });
    return {
      status: "fallback_copied",
      sessionId: patch.sessionId || (entry && entry.id) || null,
      deliveryId: deliveryEntry && deliveryEntry.id,
      focusResult: patch.focusResult || undefined,
      deliveryResult: fallbackResult,
      text: formatDeliveryAck("fallback_copied", entry || { id: patch.sessionId }, fallbackResult, t),
    };
  }

  function pruneExpired() {
    const ts = now();
    for (const [messageId, mapping] of mappings) {
      if (!mapping || mapping.expiresAt <= ts) mappings.delete(messageId);
    }
    for (const [sessionId, watermark] of sessionSubmissionWatermarks) {
      if (!watermark || watermark.expiresAt <= ts) sessionSubmissionWatermarks.delete(sessionId);
    }
  }

  function pruneMappingsToLimit() {
    const limit = Math.max(1, Number.isFinite(maxMappings) ? Math.floor(maxMappings) : DEFAULT_MAX_MAPPINGS);
    while (mappings.size > limit) {
      const firstKey = mappings.keys().next().value;
      if (!firstKey) break;
      mappings.delete(firstKey);
    }
    while (sessionSubmissionWatermarks.size > limit) {
      const firstKey = sessionSubmissionWatermarks.keys().next().value;
      if (!firstKey) break;
      sessionSubmissionWatermarks.delete(firstKey);
    }
  }

  function createCompletionNotificationContext(entry = {}) {
    notificationSequence += 1;
    let identity = captureSessionIdentity(entry);
    // The shared snapshot intentionally omits agentPid. The main-process
    // snapshot supplied to Direct Send adds it from the live runtime map, but
    // keep a synchronous best-effort backfill for callers that pass the public
    // snapshot shape directly. Capturing it here is important: looking it up
    // only after Telegram send completes can observe a reused session's new
    // process and defeat the identity fence.
    if (identity && identity.id && typeof getSessionSnapshot === "function") {
      try {
        const liveEntry = findSession(getSessionSnapshot(), identity.id);
        const liveAgentPid = normalizePid(liveEntry && liveEntry.agentPid);
        if (identity.agentPid == null && liveAgentPid != null) identity = {
          ...identity,
          agentPid: liveAgentPid,
        };
      } catch {}
    }
    const context = {
      generation: mappingGeneration,
      notificationRouteGeneration,
      sequence: notificationSequence,
      sessionId: normalizeSessionId(entry.sessionId || entry.id) || null,
      identity,
    };
    const route = readRouteGeneration();
    if (route.bound) context.routeGeneration = route.value;
    return context;
  }

  function invalidateMappings({ notificationRouteChanged = true } = {}) {
    mappingGeneration += 1;
    if (notificationRouteChanged) notificationRouteGeneration += 1;
    mappings.clear();
    sessionSubmissionWatermarks.clear();
    return mappingGeneration;
  }

  function isCompletionNotificationRouteCurrent(context) {
    if (!context || typeof context !== "object") return false;
    const expectedNotificationRoute = Number(context.notificationRouteGeneration);
    if (!Number.isSafeInteger(expectedNotificationRoute)
      || expectedNotificationRoute !== notificationRouteGeneration) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(context, "routeGeneration")) {
      const rawExpectedRoute = context.routeGeneration;
      if (rawExpectedRoute == null || rawExpectedRoute === "") return false;
      const expectedRoute = Number(rawExpectedRoute);
      const currentRoute = readRouteGeneration();
      if (!Number.isSafeInteger(expectedRoute)
        || currentRoute.bound !== true
        || currentRoute.value === null
        || currentRoute.value !== expectedRoute) {
        return false;
      }
    } else if (typeof getRouteGeneration === "function") {
      return false;
    }
    return true;
  }

  function isCompletionNotificationContextCurrent(context) {
    if (!context || typeof context !== "object") return false;
    const generation = Number(context.generation);
    if (!Number.isSafeInteger(generation) || generation !== mappingGeneration) return false;
    return isCompletionNotificationRouteCurrent(context);
  }

  function registerCompletionNotification({
    messageId,
    sessionId,
    chatId,
    rawSessionId,
    agentId,
    sourcePid,
    agentPid,
    editor,
    wtHwnd,
    orcaPaneKey,
    codexOriginator,
    notificationContext,
  } = {}) {
    const key = normalizeMessageId(messageId);
    const id = normalizeSessionId(sessionId);
    if (!key || !id) return false;
    // Production binds mappings to the native poller's route generation. A
    // context-free registration would silently create a mapping that survives
    // stop/start and recipient lifecycle changes, so retain that compatibility
    // only for standalone callers that did not configure a route provider.
    const hasNotificationContext = !!notificationContext && typeof notificationContext === "object";
    const routeProviderBound = typeof getRouteGeneration === "function";
    if (!hasNotificationContext && routeProviderBound) return false;
    let sequence;
    let routeGeneration;
    let hasRouteGeneration = false;
    let contextIdentity = null;
    if (hasNotificationContext) {
      const generation = Number(notificationContext.generation);
      sequence = Number(notificationContext.sequence);
      if (!Number.isSafeInteger(generation) || generation !== mappingGeneration) return false;
      if (!Number.isSafeInteger(sequence) || sequence <= 0) return false;
      const contextSessionId = normalizeSessionId(notificationContext.sessionId);
      if (contextSessionId && contextSessionId !== id) return false;
      if (!isCompletionNotificationContextCurrent(notificationContext)) return false;
      notificationSequence = Math.max(notificationSequence, sequence);
      if (Object.prototype.hasOwnProperty.call(notificationContext, "routeGeneration")) {
        routeGeneration = normalizeRouteGeneration(notificationContext.routeGeneration);
        if (routeGeneration === null) return false;
        hasRouteGeneration = true;
      } else if (routeProviderBound) {
        return false;
      }
      if (notificationContext.identity && typeof notificationContext.identity === "object") {
        contextIdentity = captureSessionIdentity(notificationContext.identity);
      }
    } else {
      notificationSequence += 1;
      sequence = notificationSequence;
    }
    const normalizedChatId = normalizeChatId(chatId);
    const scopedKey = mappingKey(key, normalizedChatId);
    pruneExpired();
    const watermark = sessionSubmissionWatermarks.get(id);
    if (watermark && sequence <= watermark.sequence) return false;
    // Refreshing an existing Telegram message mapping makes it the newest
    // entry for capacity pruning, while preserving reference-based consume
    // protection for an in-flight delivery that resolved the older value.
    mappings.delete(scopedKey);
    const identityValue = (field, fallback) => {
      if (contextIdentity && Object.prototype.hasOwnProperty.call(contextIdentity, field)) {
        return contextIdentity[field];
      }
      return fallback;
    };
    const mapping = {
      sessionId: id,
      chatId: normalizedChatId || null,
      rawSessionId: normalizeStringIdentity(identityValue("rawSessionId", rawSessionId)),
      agentId: normalizeSessionId(identityValue("agentId", agentId)) || null,
      sourcePid: normalizePid(identityValue("sourcePid", sourcePid)),
      agentPid: normalizePid(identityValue("agentPid", agentPid)),
      editor: normalizeEditorIdentity(identityValue("editor", editor)),
      wtHwnd: normalizeHwndString(identityValue("wtHwnd", wtHwnd)),
      orcaPaneKey: normalizeSessionId(identityValue("orcaPaneKey", orcaPaneKey)) || null,
      codexOriginator: normalizeOriginatorIdentity(identityValue("codexOriginator", codexOriginator)),
      generation: mappingGeneration,
      sequence,
      expiresAt: now() + Math.max(1, mappingTtlMs),
    };
    if (hasRouteGeneration) mapping.routeGeneration = routeGeneration;
    mappings.set(scopedKey, mapping);
    pruneMappingsToLimit();
    safeLog("debug", "direct-send mapping registered", {
      messageId: key,
      chatId: normalizedChatId || undefined,
      sessionId: id,
      rawSessionId: normalizeStringIdentity(rawSessionId) || undefined,
      agentId: normalizeSessionId(agentId) || undefined,
      sourcePid: normalizePid(sourcePid) || undefined,
      agentPid: normalizePid(agentPid) || undefined,
      codexOriginator: normalizeOriginatorIdentity(codexOriginator) || undefined,
    });
    return true;
  }

  function resolveMapping(messageId, chatId) {
    pruneExpired();
    const key = normalizeMessageId(messageId);
    if (!key) return null;
    const normalizedChatId = normalizeChatId(chatId);
    // Prefer a chat-scoped mapping. The unscoped fallback preserves mappings
    // created by older callers and keeps the public helper backwards-compatible.
    const scopedKey = normalizedChatId ? mappingKey(key, normalizedChatId) : "";
    const resolvedKey = (scopedKey && mappings.has(scopedKey)) ? scopedKey : key;
    const mapping = mappings.get(resolvedKey);
    if (!mapping) return null;
    if (mapping.generation !== mappingGeneration || !mappingRouteIsCurrent(mapping)) {
      mappings.delete(resolvedKey);
      return null;
    }
    if (mapping.expiresAt <= now()) {
      mappings.delete(resolvedKey);
      return null;
    }
    return { key: resolvedKey, mapping };
  }

  function hasReplyableCompletionMapping(sessionId, entry = null) {
    const id = normalizeSessionId(sessionId);
    if (!id || !directSendEnabled()) return false;
    pruneExpired();
    for (const [key, mapping] of mappings) {
      if (!mapping || mapping.sessionId !== id) continue;
      if (mapping.generation !== mappingGeneration || !mappingRouteIsCurrent(mapping)) {
        mappings.delete(key);
        continue;
      }
      if (entry && !mappingIdentityMatches({ ...entry, id }, mapping)) continue;
      return true;
    }
    return false;
  }

  function consumeMapping(resolved) {
    if (!resolved || !resolved.key || !resolved.mapping) return false;
    if (mappings.get(resolved.key) !== resolved.mapping) return false;
    return mappings.delete(resolved.key);
  }

  function consumeSessionMappings(resolved, sequenceFence) {
    if (!resolved || !resolved.mapping) return false;
    if (resolved.mapping.generation !== mappingGeneration) return false;
    const sessionId = normalizeSessionId(resolved.mapping.sessionId);
    if (!sessionId) return consumeMapping(resolved);
    const mappingSequence = Number(resolved.mapping.sequence);
    const requestedFence = Number(sequenceFence);
    const fence = Number.isSafeInteger(requestedFence) && requestedFence > 0
      ? requestedFence
      : mappingSequence;
    if (!Number.isSafeInteger(fence) || fence <= 0) return consumeMapping(resolved);
    const expiresAt = now() + Math.max(1, mappingTtlMs);
    const previousWatermark = sessionSubmissionWatermarks.get(sessionId);
    const watermarkSequence = previousWatermark
      && Number.isSafeInteger(previousWatermark.sequence)
      ? Math.max(previousWatermark.sequence, fence)
      : fence;
    sessionSubmissionWatermarks.delete(sessionId);
    sessionSubmissionWatermarks.set(sessionId, {
      sequence: watermarkSequence,
      expiresAt: Math.max(expiresAt, Number(previousWatermark && previousWatermark.expiresAt) || 0),
    });
    let consumed = false;
    for (const [key, mapping] of mappings) {
      if (
        mapping
        && mapping.sessionId === sessionId
        && mapping.generation === mappingGeneration
        && Number(mapping.sequence) <= watermarkSequence
      ) {
        mappings.delete(key);
        consumed = true;
      }
    }
    pruneMappingsToLimit();
    return consumed;
  }

  async function handleTextMessageNow(payload = {}) {
    const signal = payload && payload.signal;
    if (signal && signal.aborted) return null;
    if (!directSendEnabled()) return null;
    const promptText = normalizePromptText(payload.text);
    if (!promptText) {
      return {
        status: "empty",
        text: t("directSendEmptyText"),
      };
    }

    const deliveryEntry = createDeliveryEntry(payload, promptText);

    const resolvedMapping = resolveMapping(payload.replyToMessageId, payload.chatId);
    if (!resolvedMapping) {
      updateDeliveryEntry(deliveryEntry, "unmapped", { errorClass: "completion_mapping_missing" });
      return {
        status: "unmapped",
        deliveryId: deliveryEntry.id,
        text: t("directSendUnmapped"),
      };
    }
    const mapping = resolvedMapping.mapping;
    const expectedMappingGeneration = mapping.generation;
    const expectedRouteGeneration = Object.prototype.hasOwnProperty.call(mapping, "routeGeneration")
      ? mapping.routeGeneration
      : undefined;

    const snapshot = typeof getSessionSnapshot === "function" ? getSessionSnapshot() : null;
    let entry = findSession(snapshot, mapping.sessionId);
    if (!entry) {
      safeLog("info", "direct-send fallback: session not live", { sessionId: mapping.sessionId });
      updateDeliveryEntry(deliveryEntry, "session_not_live", {
        sessionId: mapping.sessionId,
        errorClass: "session_not_live",
      });
      const fallback = await tryClipboardFallback(
        deliveryEntry,
        { id: mapping.sessionId },
        "session_not_live",
        { sessionId: mapping.sessionId, errorClass: "session_not_live" },
        expectedMappingGeneration,
        signal,
        expectedRouteGeneration,
      );
      if (fallback) return fallback;
      return {
        status: "session_not_live",
        sessionId: mapping.sessionId,
        deliveryId: deliveryEntry.id,
        text: t("directSendSessionNotLive"),
      };
    }
    if (!mappingIdentityMatches(entry, mapping)) {
      return targetChangedResponse(deliveryEntry, {
        ok: false,
        entry,
        status: "session_changed",
        errorClass: "session_identity_changed",
        textKey: "directSendSessionChanged",
      }, mapping.sessionId);
    }

    // A session can have a delivery channel other than the foreground
    // terminal. Codex Desktop owns a shared app-server and must receive text
    // through its thread queue; ordinary CLI sessions continue through the
    // Console adapter. Resolve this only after the mapping identity fence so
    // the selected channel is based on the same live session we will validate.
    const activeDeliveryAdapter = selectDeliveryAdapter(entry, mapping, payload);

    updateDeliveryEntry(deliveryEntry, "target_resolved", {
      sessionId: entry.id,
      agentId: entry.agentId || null,
    });

    if (hasInteractivePermissionPending(entry, getPendingPermissions)) {
      safeLog("info", "direct-send rejected: session waiting for permission", { sessionId: entry.id });
      updateDeliveryEntry(deliveryEntry, "permission_pending", { errorClass: "permission_pending" });
      const fallback = await tryClipboardFallback(
        deliveryEntry,
        entry,
        "permission_pending",
        { errorClass: "permission_pending" },
        expectedMappingGeneration,
        signal,
        expectedRouteGeneration,
      );
      if (fallback) return fallback;
      return {
        status: "permission_pending",
        sessionId: entry.id,
        deliveryId: deliveryEntry.id,
        text: t("directSendPermissionPending"),
      };
    }

    if (!isReplyReadySession(entry)) {
      return targetChangedResponse(deliveryEntry, {
        ok: false,
        entry,
        status: "session_changed",
        errorClass: "session_not_ready",
        textKey: "directSendSessionChanged",
      }, entry.id);
    }

    const requiresFocusableTarget = deliveryAdapterRequiresFocusableTarget(activeDeliveryAdapter);
    const allowsTarget = deliveryAdapterAllowsTarget(activeDeliveryAdapter, entry);
    const focusTarget = requiresFocusableTarget
      ? getSessionFocusTarget(entry, { osPlatform })
      : null;
    const localFocusable = requiresFocusableTarget
      ? isFocusableLocalHudSession(entry, { osPlatform })
      : true;
    if (!allowsTarget || (requiresFocusableTarget && (!localFocusable || focusTarget.type !== "terminal"))) {
      safeLog("info", "direct-send fallback: session not local terminal", {
        sessionId: entry.id,
        type: focusTarget && focusTarget.type || "queue-or-none",
      });
      updateDeliveryEntry(deliveryEntry, "not_focusable", {
        errorClass: "not_focusable_terminal",
      });
      const fallback = await tryClipboardFallback(
        deliveryEntry,
        entry,
        "not_focusable_terminal",
        { errorClass: "not_focusable_terminal" },
        expectedMappingGeneration,
        signal,
        expectedRouteGeneration,
      );
      if (fallback) return fallback;
      return {
        status: "not_focusable",
        sessionId: entry.id,
        deliveryId: deliveryEntry.id,
        text: t("directSendNotFocusable"),
      };
    }

    // Never silently truncate a reply and then press Enter. Keep the full text
    // in the clipboard fallback so the user can review and submit it manually.
    if (promptText.length > MAX_AUTO_SUBMIT_TEXT) {
      const deliveryResult = normalizeDeliveryResult({
        status: "failed",
        delivered: false,
        errorClass: "reply_too_long",
      });
      updateDeliveryEntry(deliveryEntry, "failed", {
        deliveryResult,
        errorClass: deliveryResult.errorClass,
      });
      const fallback = await tryClipboardFallback(
        deliveryEntry,
        entry,
        deliveryResult.errorClass,
        { deliveryResult, errorClass: deliveryResult.errorClass },
        expectedMappingGeneration,
        signal,
        expectedRouteGeneration,
      );
      if (fallback) return fallback;
      return {
        status: "failed",
        sessionId: entry.id,
        deliveryId: deliveryEntry.id,
        deliveryResult,
        text: formatDeliveryAck("failed", entry, deliveryResult, t),
      };
    }

    const expectedIdentity = captureSessionIdentity(entry);
    const requiresFocus = deliveryAdapterRequiresFocus(activeDeliveryAdapter);
    let focusResult = null;
    let latestSnapshot = snapshot;

    if (requiresFocus) {
      if (signal && signal.aborted) {
        return targetChangedResponse(deliveryEntry, {
          ok: false,
          entry,
          status: "cancelled",
          errorClass: "direct_send_cancelled",
          textKey: "directSendSessionChanged",
        }, entry.id);
      }
      try {
        updateDeliveryEntry(deliveryEntry, "focus_requested");
        const rawFocusResult = typeof focusSession === "function"
          ? await focusSession(entry.id, { requestSource: "telegram-direct-send", fallbackEntry: entry })
          : false;
        focusResult = normalizeFocusGateResult(rawFocusResult);
      } catch (err) {
        safeLog("warn", "direct-send focus threw", { sessionId: entry.id, error: err && err.message });
        focusResult = normalizeFocusGateResult({ reason: "focus-threw", confirmed: false });
      }

      if (!focusResult.confirmed) {
        safeLog("info", "direct-send fallback: focus result unconfirmed", {
          sessionId: entry.id,
          reason: focusResult.reason,
        });
        updateDeliveryEntry(deliveryEntry, "focus_unconfirmed", {
          focusResult,
          errorClass: "focus_unconfirmed",
        });
        const fallback = await tryClipboardFallback(
          deliveryEntry,
          entry,
          "focus_unconfirmed",
          { focusResult, errorClass: "focus_unconfirmed" },
          expectedMappingGeneration,
          signal,
          expectedRouteGeneration,
        );
        if (fallback) return fallback;
        return {
          status: "focus_unconfirmed",
          sessionId: entry.id,
          deliveryId: deliveryEntry.id,
          focusResult,
          text: t("directSendFocusUnconfirmed"),
        };
      }

      const postFocusValidation = validateCurrentTarget(
        entry.id,
        expectedIdentity,
        expectedMappingGeneration,
        signal,
        expectedRouteGeneration,
        activeDeliveryAdapter,
      );
      if (!postFocusValidation.ok) {
        return targetChangedResponse(deliveryEntry, postFocusValidation, entry.id, focusResult);
      }
      entry = postFocusValidation.entry;
      latestSnapshot = postFocusValidation.snapshot;
      updateDeliveryEntry(deliveryEntry, "focus_confirmed", { focusResult });
    } else {
      const preDeliveryValidation = validateCurrentTarget(
        entry.id,
        expectedIdentity,
        expectedMappingGeneration,
        signal,
        expectedRouteGeneration,
        activeDeliveryAdapter,
      );
      if (!preDeliveryValidation.ok) {
        return targetChangedResponse(deliveryEntry, preDeliveryValidation, entry.id);
      }
      entry = preDeliveryValidation.entry;
      latestSnapshot = preDeliveryValidation.snapshot;
      updateDeliveryEntry(deliveryEntry, "target_revalidated");
    }

    let deliveryResult;
    // Capture notifications that existed before input submission. A completion
    // emitted after Console input but before the helper returns stays replyable.
    let submissionFence = notificationSequence;
    try {
      updateDeliveryEntry(deliveryEntry, "delivery_attempted");
      if (deliveryAdapterRequiresMappedAgentPid(activeDeliveryAdapter)
        && !normalizePid(mapping.agentPid)) {
        deliveryResult = normalizeDeliveryResult({
          status: "failed",
          delivered: false,
          errorClass: "agent_pid_unavailable",
        });
      } else if (deliveryAdapterRequiresPidDisambiguation(activeDeliveryAdapter)
        && hasSameAgentPidPeer(latestSnapshot, entry)) {
        deliveryResult = normalizeDeliveryResult({
          status: "failed",
          delivered: false,
          errorClass: "console_ambiguous",
        });
      } else {
        deliveryResult = normalizeDeliveryResult(await invokeDeliveryAdapter(activeDeliveryAdapter, {
          deliveryId: deliveryEntry.id,
          promptText,
          sessionId: entry.id,
          agentId: entry.agentId || null,
          entry,
          focusResult,
          autoEnter: false,
          signal,
          otherSessionAgentPids: collectOtherSessionAgentPids(latestSnapshot, entry),
          validateBeforeInput: () => {
            const validation = validateCurrentTarget(
              entry.id,
              expectedIdentity,
              expectedMappingGeneration,
              signal,
              expectedRouteGeneration,
              activeDeliveryAdapter,
            );
            if (!validation.ok) return { ok: false, errorClass: validation.errorClass };
            if (deliveryAdapterRequiresPidDisambiguation(activeDeliveryAdapter)
              && hasSameAgentPidPeer(validation.snapshot, validation.entry)) {
              return { ok: false, errorClass: "console_ambiguous" };
            }
            submissionFence = notificationSequence;
            return {
              ok: true,
              otherSessionAgentPids: collectOtherSessionAgentPids(validation.snapshot, validation.entry),
            };
          },
        }));
      }
    } catch (err) {
      safeLog("warn", "direct-send delivery adapter threw", {
        sessionId: entry.id,
        errorClass: signal && signal.aborted
          ? "direct_send_cancelled"
          : "delivery_adapter_threw",
      });
      deliveryResult = normalizeDeliveryResult({
        status: "failed",
        delivered: false,
        errorClass: signal && signal.aborted
          ? "direct_send_cancelled"
          : "delivery_adapter_threw",
      });
    }

    // The adapter may cross an OS boundary (Console input or clipboard) after
    // its last validation callback. A stop, feature-toggle change, or mapping
    // invalidation can therefore happen before it resolves. Treat that result
    // as uncertain: keep the caller-facing response out of the success path,
    // avoid consuming a newer completion mapping, and let the native runner's
    // route fence suppress the reply when the poll lifecycle was aborted.
    const invalidation = routeInvalidation(
      expectedMappingGeneration,
      signal,
      expectedRouteGeneration,
    );
    if (invalidation) {
      const adapterAlreadyFailed = deliveryResult.status === "failed";
      const responseStatus = adapterAlreadyFailed ? "failed" : invalidation.status;
      const staleDeliveryResult = {
        ...deliveryResult,
        status: "failed",
        delivered: false,
        autoEnter: false,
        errorClass: invalidation.errorClass,
      };
      updateDeliveryEntry(deliveryEntry, responseStatus, {
        deliveryResult: staleDeliveryResult,
        errorClass: invalidation.errorClass,
      });
      safeLog("info", "direct-send delivery completed after route became inactive", {
        sessionId: entry.id,
        attemptedStatus: deliveryResult.status,
        errorClass: invalidation.errorClass,
      });
      return {
        // Preserve the existing failed-delivery contract when the adapter
        // already reported a validation error; a late success is downgraded
        // to the route status so it can never be acknowledged as delivered.
        status: responseStatus,
        sessionId: entry.id,
        deliveryId: deliveryEntry.id,
        focusResult,
        deliveryResult: staleDeliveryResult,
        text: t(invalidation.textKey || "directSendSessionChanged"),
      };
    }

    const resultStatus = deliveryResult.status === "focus_only"
      ? "focused"
      : deliveryResult.status;
    updateDeliveryEntry(deliveryEntry, resultStatus, {
      deliveryResult,
      errorClass: deliveryResult.errorClass,
    });

    if (
      deliveryResult.status === "sent_with_enter"
      || deliveryResult.status === "queued"
      || deliveryResult.errorClass === "partial_console_write"
      || deliveryResult.errorClass === "console_input_result_unknown"
      || deliveryResult.errorClass === "codex_queue_result_unknown"
    ) {
      consumeSessionMappings(resolvedMapping, submissionFence);
    }

    if (
      deliveryResult.status === "failed"
      && !NO_FALLBACK_ERRORS.has(deliveryResult.errorClass)
    ) {
      const fallback = await tryClipboardFallback(
        deliveryEntry,
        entry,
        deliveryResult.errorClass || "delivery_failed",
        {
          focusResult,
          deliveryResult,
          errorClass: deliveryResult.errorClass,
        },
        expectedMappingGeneration,
        signal,
        expectedRouteGeneration,
      );
      if (fallback) return fallback;
    }

    safeLog("info", "direct-send delivery result", {
      sessionId: entry.id,
      status: resultStatus,
      reason: focusResult ? focusResult.reason : "terminal-channel",
      errorClass: deliveryResult.errorClass || undefined,
    });
    return {
      status: resultStatus,
      sessionId: entry.id,
      deliveryId: deliveryEntry.id,
      focusResult,
      deliveryResult,
      text: formatDeliveryAck(deliveryResult.status, entry, deliveryResult, t),
    };
  }

  function handleTextMessage(payload = {}) {
    const run = deliveryChain
      .catch(() => {})
      .then(() => handleTextMessageNow(payload));
    // Keep the queue alive after a caller-facing rejection while preserving
    // that rejection for the current caller.
    deliveryChain = run.catch(() => {});
    return run;
  }

  return {
    createCompletionNotificationContext,
    isCompletionNotificationRouteCurrent,
    isCompletionNotificationContextCurrent,
    invalidateMappings,
    registerCompletionNotification,
    hasReplyableCompletionMapping,
    handleTextMessage,
    _mappings: mappings,
    _deliveries: deliveries,
  };
}

module.exports = {
  DEFAULT_MAPPING_TTL_MS,
  formatDeliveryAck,
  DEFAULT_MAX_MAPPINGS,
  DEFAULT_MAX_DELIVERIES,
  createTelegramDirectSend,
  createClipboardFallbackDeliveryAdapter,
  createFocusOnlyDeliveryAdapter,
  createWindowsPasteOnlyDeliveryAdapter,
  buildWindowsPasteShortcutScript,
  normalizeMessageId,
  normalizeDeliveryResult,
  normalizePromptText,
};
