"use strict";

// Native OS notifications (Windows toasts) for agent lifecycle events.
//
// This module owns no agent state. It is a second consumer of two seams that
// already exist for the Slack notifier:
//   - the session snapshot fanout (main.js broadcastSessionSnapshot) for
//     "task finished" / "task failed or interrupted";
//   - the permission announce point (permission.js) for "a human has to act".
// Completion semantics are imported from slack-notify-client so the two
// channels cannot drift apart on what counts as a finished main task.
//
// Display rules: the toast carries the agent name, the project folder and a
// status line. Prompts, commands, tool input, model output and session titles
// (which may be derived from a prompt) never reach it.

// Settings copy remains in its browser bundle; load that same static catalog
// in main so native notifications use the identical seven translations.
require("./settings-i18n");
const { STRINGS } = globalThis.ClawdSettingsI18n;
const { isCompletion, dedupeKey } = require("./slack-notify-client");
const { redactSecrets } = require("./secret-redact");

// One constant decides where the feature exists. Everywhere else the module is
// inert: every entry point returns early and no Notification is constructed.
const SUPPORTED_PLATFORMS = new Set(["win32"]);

const LABEL_MAX = 48;
const SHOW_TIMEOUT_MS = 10_000;
// Upper bound for holding a toast whose banner never reports being closed.
const RETENTION_MS = 10 * 60_000;
const MAX_LIVE = 16;
// A second completion of the same kind for a session that never went back to
// work is a repeated hook delivery, not a second finished task.
const DUPLICATE_COMPLETION_WINDOW_MS = 60_000;
// Parallel tool calls raise several requests at once; one toast covers them.
const ATTENTION_COALESCE_MS = 10_000;
// How often a live "waiting for you" toast is re-checked against its request.
// A request can end without any session event following it (the terminal was
// closed), so the snapshot fanout alone would leave the toast behind.
const ATTENTION_SWEEP_MS = 2_000;

const ATTENTION_KINDS = new Set(["approval", "question"]);

function isSystemNotificationPlatform(platform) {
  return SUPPORTED_PLATFORMS.has(platform);
}

function getStrings(lang) { return STRINGS[lang] || STRINGS.en; }

function text(strings, key) {
  return typeof strings[key] === "string" ? strings[key] : STRINGS.en[key];
}

// Single-line, redacted, bounded. Applied to every value that originates
// outside Clawd (folder names, agent names, tool names).
function safeLabel(value, max = LABEL_MAX) {
  if (typeof value !== "string") return "";
  let label = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!label) return "";
  label = redactSecrets(label);
  if (label.length > max) label = `${label.slice(0, Math.max(0, max - 1))}…`;
  return label;
}

function basename(value) {
  const parts = typeof value === "string" ? value.trim().split(/[\\/]+/).filter(Boolean) : [];
  return parts.length ? parts[parts.length - 1] : "";
}

// An explicit empty displayFolder means "this session has no project to show"
// (internal workspaces); do not fall back to the raw cwd in that case.
function entryFolder(entry) {
  if (entry && typeof entry.displayFolder === "string") return safeLabel(entry.displayFolder);
  return safeLabel(basename(entry && entry.cwd));
}

function buildTitle(agentName, folder) {
  const agent = safeLabel(agentName) || "Clawd";
  return folder ? `${agent} · ${folder}` : agent;
}

function formatCompletionMessage(entry, lang) {
  const strings = getStrings(lang);
  const rawEvent = entry && entry.lastEvent && entry.lastEvent.rawEvent;
  let key = "systemNotifyDoneBody";
  if (entry && entry.badge === "interrupted") {
    // The session keeps no error text, only which terminal event ended the
    // turn. That class is the whole "short error message": nothing free-form.
    key = rawEvent === "ApiError" ? "systemNotifyApiErrorBody" : "systemNotifyErrorBody";
  }
  return {
    title: buildTitle(entry && (entry.agentName || entry.agentId), entryFolder(entry)),
    body: text(strings, key),
  };
}

function formatAttentionMessage(payload, lang) {
  const strings = getStrings(lang);
  const folder = safeLabel(basename(payload && payload.folder));
  const title = buildTitle(payload && (payload.agentName || payload.agentId), folder);
  if (payload && payload.kind === "question") {
    return { title, body: text(strings, "systemNotifyQuestionBody") };
  }
  // The tool name is an identifier ("Bash", "Edit"), never its arguments.
  const tool = safeLabel(payload && payload.toolName, 32);
  return {
    title,
    body: tool
      ? text(strings, "systemNotifyApprovalToolBody").replace("{tool}", tool)
      : text(strings, "systemNotifyApprovalBody"),
  };
}

function formatTestMessage(lang) {
  const strings = getStrings(lang);
  return { title: text(strings, "systemNotifyTestTitle"), body: text(strings, "systemNotifyTestBody") };
}

function createSystemNotifications(options) {
  const { Notification } = options;
  const platform = options.platform || process.platform;
  const supported = isSystemNotificationPlatform(platform);
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const now = options.now || Date.now;
  const log = typeof options.log === "function" ? options.log : () => {};

  // sessionId -> dedupe key of the last completion that has been settled
  // (shown, or deliberately not shown).
  const settled = new Map();
  // sessionId -> { kind, at } of the last completion toast, cleared once the
  // session is seen working again.
  const lastShown = new Map();
  // Live toasts, oldest first.
  const live = new Set();
  let primed = false;
  let disposed = false;
  // Log-only sequence number, so one toast can be followed through
  // shown / clicked / closed without logging anything about its content.
  let toastSeq = 0;
  let sweepTimer = null;

  function readSettings() {
    let raw = null;
    try { raw = options.getSettings(); } catch {}
    const value = raw && typeof raw === "object" ? raw : {};
    return {
      enabled: value.enabled === true,
      onDone: value.onDone === true,
      onError: value.onError === true,
      onPermission: value.onPermission === true,
    };
  }

  // Clawd's own Do Not Disturb, quitting, and "not ready" all mean "stay
  // quiet". Windows' Focus Assist / per-app toggle is not consulted and never
  // worked around: the toast is handed to the OS, which decides.
  function isSuppressed() {
    try { return options.isSuppressed() === true; } catch { return true; }
  }

  function readLang() {
    try { return options.getLang(); } catch { return "en"; }
  }

  function openDashboard() {
    try { options.openDashboard(); } catch (err) { log(`open dashboard failed: ${err && err.message}`); }
  }

  // Jump to exactly the session the toast was about. Anything short of a real
  // target falls back to the session list; it never guesses another session.
  function activate(target) {
    const sessionId = target && target.sessionId ? String(target.sessionId) : "";
    if (!sessionId || typeof options.focusSession !== "function") { openDashboard(); return; }
    // focusSession answers false when it has no target at all, or a focus
    // result. A result that located no window (targetHwnd reported as empty)
    // brought nothing forward; one that located a window is trusted even if
    // the foreground change could not be confirmed.
    const unfocusable = (result) => {
      if (result === false || result == null) return true;
      if (typeof result !== "object") return false;
      if (result.reason === "no-source-pid") return true;
      return Object.prototype.hasOwnProperty.call(result, "targetHwnd")
        && !result.targetHwnd && result.confirmed !== true;
    };
    let result = false;
    try {
      result = options.focusSession(sessionId, { fallbackEntry: target.fallbackEntry || null });
    } catch (err) {
      log(`focus failed: ${err && err.message}`);
      result = false;
    }
    if (result && typeof result.then === "function") {
      result.then((value) => { if (unfocusable(value)) openDashboard(); }, () => openDashboard());
      return;
    }
    if (unfocusable(result)) openDashboard();
  }

  function closeRecord(record) { if (record) record.close(); }

  function trimLive() {
    while (live.size >= MAX_LIVE) closeRecord(live.values().next().value);
  }

  // Resolves true only when the OS reported the toast as shown.
  function present(message, meta = {}) {
    if (disposed || !supported) return Promise.resolve(false);
    const onClick = typeof meta.onClick === "function" ? meta.onClick : openDashboard;
    let isSupported = false;
    try { isSupported = !!(Notification && Notification.isSupported()); } catch {}
    if (!isSupported) {
      // Same best-effort Windows fallback the quota reminders use. A balloon
      // has no delivery acknowledgement, so "dispatched" is the best answer.
      try {
        const owner = options.trayBalloonOwner;
        const tray = typeof options.getTray === "function" ? options.getTray() : null;
        return Promise.resolve(!!owner && owner.show(tray, {
          title: message.title, content: message.body, iconType: "info", onClick,
        }) === true);
      } catch { return Promise.resolve(false); }
    }
    return new Promise((resolve) => {
      let notification = null;
      let timer = null;
      let settledShow = false;
      const settle = (shown) => { if (!settledShow) { settledShow = true; resolve(shown); } };
      const seq = ++toastSeq;
      const tag = `#${seq} kind=${meta.kind || "unknown"}`;
      const record = {
        sessionId: meta.sessionId ? String(meta.sessionId) : "",
        kind: meta.kind || "",
        tag,
        shownAt: now(),
        relevance: typeof meta.isStillRelevant === "function" ? [meta.isStillRelevant] : [],
        release() {
          if (timer) clearTimer(timer);
          timer = null;
          live.delete(record);
          try { if (notification) notification.removeAllListeners(); } catch {}
          settle(false);
        },
        close() {
          record.release();
          try { if (notification) notification.close(); } catch {}
        },
      };
      trimLive();
      live.add(record);
      try {
        // Always silent: Clawd already plays its own completion / confirm
        // sounds (and honors its own mute), so the OS chime would double up.
        notification = new Notification({ title: message.title, body: message.body, silent: true });
        notification.once("show", () => {
          log(`toast shown ${tag}`);
          settle(true);
          if (timer) clearTimer(timer);
          timer = setTimer(record.close, RETENTION_MS);
          if (timer && typeof timer.unref === "function") timer.unref();
        });
        notification.once("failed", (_event, error) => {
          log(`toast failed ${tag}: ${safeLabel(String(error || "unknown"), 120)}`);
          record.close();
        });
        // On Windows "close" also fires when the banner merely times out and
        // the toast moves to the notification center. A finished-task toast
        // stays there as history, so let go of it. A "waiting for you" toast
        // is kept in hand: only its owner can take it out of the notification
        // center once the request is settled (see sweepResolvedAttention).
        notification.once("close", () => {
          log(`toast closed ${tag}`);
          if (ATTENTION_KINDS.has(record.kind) && record.relevance.length) {
            if (timer) clearTimer(timer);
            timer = null;
            return;
          }
          record.release();
        });
        notification.once("click", () => {
          log(`toast clicked ${tag}`);
          record.release();
          try { onClick(); } catch (err) { log(`toast click failed: ${err && err.message}`); }
        });
        timer = setTimer(record.close, SHOW_TIMEOUT_MS);
        if (timer && typeof timer.unref === "function") timer.unref();
        notification.show();
      } catch (err) {
        log(`toast threw: ${err && err.message}`);
        record.close();
      }
    });
  }

  function findLive(sessionId, predicate) {
    for (const record of live) {
      if (record.sessionId === sessionId && predicate(record)) return record;
    }
    return null;
  }

  function closeLiveForSession(sessionId, predicate) {
    for (const record of [...live]) {
      if (record.sessionId === sessionId && predicate(record)) record.close();
    }
  }

  // A request that was answered (or timed out) should not leave a stale
  // "waiting for you" toast behind, on screen or in the notification center.
  function sweepResolvedAttention() {
    for (const record of [...live]) {
      if (!ATTENTION_KINDS.has(record.kind) || !record.relevance.length) continue;
      let relevant = false;
      for (const check of record.relevance) {
        try { if (check() === true) { relevant = true; break; } } catch {}
      }
      if (!relevant) {
        log(`toast withdrawn ${record.tag}`);
        record.close();
      }
    }
  }

  function hasWatchedAttention() {
    for (const record of live) {
      if (ATTENTION_KINDS.has(record.kind) && record.relevance.length) return true;
    }
    return false;
  }

  // Runs only while a "waiting for you" toast is being held.
  function scheduleAttentionSweep() {
    if (disposed || sweepTimer || !hasWatchedAttention()) return;
    sweepTimer = setTimer(() => {
      sweepTimer = null;
      if (disposed) return;
      sweepResolvedAttention();
      scheduleAttentionSweep();
    }, ATTENTION_SWEEP_MS);
    if (sweepTimer && typeof sweepTimer.unref === "function") sweepTimer.unref();
  }

  function showCompletion(entry, interrupted) {
    const sessionId = String(entry.id);
    const kind = interrupted ? "interrupted" : "done";
    const previous = lastShown.get(sessionId);
    if (previous && previous.kind === kind && now() - previous.at < DUPLICATE_COMPLETION_WINDOW_MS) {
      return;
    }
    lastShown.set(sessionId, { kind, at: now() });
    let message = null;
    try { message = formatCompletionMessage(entry, readLang()); } catch (err) {
      log(`completion format threw: ${err && err.message}`);
      return;
    }
    // The turn is over, so anything this session was still asking for is moot.
    closeLiveForSession(sessionId, () => true);
    void present(message, { sessionId, kind, onClick: () => activate({ sessionId }) });
  }

  // Marks what is already history without notifying, and makes the notifier
  // live so the first genuine completion after a restart is delivered.
  function prime(snapshot) {
    const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    for (const entry of sessions) {
      if (!entry || !entry.id || !isCompletion(entry)) continue;
      settled.set(String(entry.id), dedupeKey(entry));
    }
    primed = true;
  }

  // Sync, fire-and-forget, never throws into the snapshot broadcast.
  function onSnapshot(snapshot) {
    if (disposed) return;
    const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const settings = readSettings();
    const active = supported && settings.enabled && !isSuppressed();
    const priming = !primed;
    const seenIds = new Set();

    sweepResolvedAttention();

    for (const entry of sessions) {
      if (!entry || !entry.id) continue;
      const sessionId = String(entry.id);
      seenIds.add(sessionId);
      if (!isCompletion(entry)) {
        // Back at work: the next completion is a new one.
        lastShown.delete(sessionId);
        continue;
      }
      const key = dedupeKey(entry);
      if (settled.get(sessionId) === key) continue;
      // Priming, a disabled feature and Do Not Disturb all settle the event so
      // that turning notifications back on never replays old completions.
      if (priming || !active) { settled.set(sessionId, key); continue; }
      // Headless sessions are subagents / background runs, not the main task.
      if (entry.headless === true) { settled.set(sessionId, key); continue; }
      // The parent turn ended while its subagents are still running. Leave the
      // event unsettled: the same key is re-evaluated when they finish, and it
      // simply disappears if the parent goes back to work instead.
      if (Number(entry.activeSubagentCount) > 0) continue;
      settled.set(sessionId, key);
      const interrupted = entry.badge === "interrupted";
      if (interrupted ? !settings.onError : !settings.onDone) continue;
      showCompletion(entry, interrupted);
    }

    for (const id of [...settled.keys()]) if (!seenIds.has(id)) settled.delete(id);
    for (const id of [...lastShown.keys()]) if (!seenIds.has(id)) lastShown.delete(id);
    primed = true;
  }

  // "A human has to act now." Callers guarantee the request is visible to the
  // user and was not auto-resolved; the checks here only decide presentation.
  function notifyAttention(payload, meta = {}) {
    if (disposed || !supported) return false;
    if (!payload || !ATTENTION_KINDS.has(payload.kind)) return false;
    const settings = readSettings();
    if (!settings.enabled || !settings.onPermission || isSuppressed()) return false;
    const isStillRelevant = typeof meta.isStillRelevant === "function" ? meta.isStillRelevant : null;
    if (isStillRelevant) {
      let relevant = false;
      try { relevant = isStillRelevant() === true; } catch {}
      if (!relevant) return false;
    }
    const sessionId = payload.sessionId ? String(payload.sessionId) : "";
    if (sessionId) {
      const recent = findLive(sessionId, (record) => (
        record.kind === payload.kind && now() - record.shownAt < ATTENTION_COALESCE_MS
      ));
      if (recent) {
        if (isStillRelevant) recent.relevance.push(isStillRelevant);
        return false;
      }
      closeLiveForSession(sessionId, (record) => ATTENTION_KINDS.has(record.kind));
    }
    let message = null;
    try { message = formatAttentionMessage(payload, readLang()); } catch (err) {
      log(`attention format threw: ${err && err.message}`);
      return false;
    }
    void present(message, {
      sessionId,
      kind: payload.kind,
      isStillRelevant,
      onClick: () => activate({ sessionId, fallbackEntry: payload.focusEntry || null }),
    });
    scheduleAttentionSweep();
    return true;
  }

  // The test button bypasses the per-event switches and Clawd's DND on
  // purpose (the user asked for it), but never the OS notification settings.
  function test() {
    if (disposed || !supported) return Promise.resolve(false);
    return present(formatTestMessage(readLang()), { kind: "test", onClick: openDashboard });
  }

  function dispose() {
    disposed = true;
    if (sweepTimer) clearTimer(sweepTimer);
    sweepTimer = null;
    for (const record of [...live]) record.close();
    settled.clear();
    lastShown.clear();
  }

  return {
    isSupported: () => supported,
    onSnapshot,
    prime,
    notifyAttention,
    test,
    dispose,
  };
}

module.exports = {
  createSystemNotifications,
  isSystemNotificationPlatform,
  formatCompletionMessage,
  formatAttentionMessage,
  formatTestMessage,
  safeLabel,
  SUPPORTED_PLATFORMS,
  DUPLICATE_COMPLETION_WINDOW_MS,
  ATTENTION_COALESCE_MS,
  ATTENTION_SWEEP_MS,
  RETENTION_MS,
};
