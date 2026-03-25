/**
 * Session Manager for Clawd Desktop Pet
 *
 * Manages Claude Code session tracking with timestamp-based cleanup.
 * No dependency on PID detection - relies purely on updatedAt timestamps.
 */

// Session storage: session_id → { state, updatedAt, cwd, editor, pidChain }
const sessions = new Map();

// Session stale timeout: 2 minutes without update = dead session
const SESSION_STALE_MS = 120000; // 2 minutes

// State priority for display resolution
const STATE_PRIORITY = {
  error: 8,
  notification: 7,
  sweeping: 6,
  attention: 5,
  carrying: 4,
  juggling: 4,
  working: 3,
  thinking: 2,
  idle: 1,
  sleeping: 0,
};

// Oneshot states that should preserve previous session state
const ONESHOT_STATES = new Set(["attention", "error", "sweeping", "notification", "carrying"]);

// Sleep sequence states
const SLEEP_SEQUENCE = new Set(["yawning", "dozing", "collapsing", "sleeping", "waking"]);

/**
 * Get all sessions (read-only access for external code)
 */
function getSessions() {
  return sessions;
}

/**
 * Get session count
 */
function getSessionCount() {
  return sessions.size;
}

/**
 * Check if a session exists
 */
function hasSession(sessionId) {
  return sessions.has(sessionId);
}

/**
 * Get a specific session
 */
function getSession(sessionId) {
  return sessions.get(sessionId);
}

/**
 * Update or create a session based on incoming event.
 *
 * Key behavior:
 * - Any event with a session_id ensures that session exists
 * - SessionEnd deletes the session
 * - Updates updatedAt timestamp on every call
 */
function updateSession(sessionId, state, event, metadata = {}) {
  const { sourcePid, cwd, editor, pidChain, claudePid } = metadata;

  // Preserve existing fields — only SessionStart sends them all
  const existing = sessions.get(sessionId);
  const srcPid = sourcePid ?? existing?.sourcePid ?? null;
  const srcCwd = cwd ?? existing?.cwd ?? "";
  const srcEditor = editor ?? existing?.editor ?? null;
  const srcPidChain = (pidChain && pidChain.length) ? pidChain : existing?.pidChain ?? null;
  const srcClaudePid = claudePid ?? existing?.claudePid ?? null;

  const base = {
    sourcePid: srcPid,
    cwd: srcCwd,
    editor: srcEditor,
    pidChain: srcPidChain,
    claudePid: srcClaudePid
  };

  // SessionEnd: delete the session
  if (event === "SessionEnd") {
    sessions.delete(sessionId);
    return { deleted: true };
  }

  // PermissionRequest: don't mutate session state (handled separately by HTTP hook)
  if (event === "PermissionRequest") {
    // Still ensure session exists and update timestamp
    if (existing) {
      existing.updatedAt = Date.now();
    } else {
      sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), ...base });
    }
    return { permissionRequest: true };
  }

  // Attention/notification/sleep: session goes idle
  if (state === "attention" || state === "notification" || SLEEP_SEQUENCE.has(state)) {
    sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), ...base });
    return { updated: true };
  }

  // Oneshot states: preserve previous state but update timestamp
  if (ONESHOT_STATES.has(state)) {
    if (existing) {
      existing.updatedAt = Date.now();
      if (sourcePid) existing.sourcePid = sourcePid;
      if (cwd) existing.cwd = cwd;
      if (editor) existing.editor = editor;
      if (pidChain && pidChain.length) existing.pidChain = pidChain;
      if (claudePid) existing.claudePid = claudePid;
    } else {
      sessions.set(sessionId, { state: "idle", updatedAt: Date.now(), ...base });
    }
    return { updated: true, oneshot: true };
  }

  // Preserve juggling: subagent's own tool use shouldn't override juggling
  if (existing && existing.state === "juggling" && state === "working" && event !== "SubagentStop") {
    existing.updatedAt = Date.now();
    return { updated: true };
  }

  // Normal state update
  sessions.set(sessionId, { state, updatedAt: Date.now(), ...base });
  return { updated: true };
}

/**
 * Delete a session immediately
 */
function deleteSession(sessionId) {
  return sessions.delete(sessionId);
}

/**
 * Clean up stale sessions based on timestamp.
 * No PID detection - pure timestamp-based cleanup.
 *
 * @returns {object} { changed: boolean, sessionCount: number }
 */
function cleanStaleSessions() {
  const now = Date.now();
  let changed = false;

  for (const [id, s] of sessions) {
    const age = now - s.updatedAt;

    if (age > SESSION_STALE_MS) {
      sessions.delete(id);
      changed = true;
    }
  }

  return { changed, sessionCount: sessions.size };
}

/**
 * Resolve the display state from all active sessions.
 * Returns the highest priority state among all sessions.
 */
function resolveDisplayState() {
  if (sessions.size === 0) return "idle";

  let best = "sleeping";
  for (const [, s] of sessions) {
    if ((STATE_PRIORITY[s.state] || 0) > (STATE_PRIORITY[best] || 0)) {
      best = s.state;
    }
  }
  return best;
}

/**
 * Get count of active working sessions (working/thinking/juggling)
 */
function getActiveWorkingCount() {
  let n = 0;
  for (const [, s] of sessions) {
    if (s.state === "working" || s.state === "thinking" || s.state === "juggling") {
      n++;
    }
  }
  return n;
}

/**
 * Get working SVG based on active session count
 */
function getWorkingSvg() {
  const n = getActiveWorkingCount();
  if (n >= 3) return "clawd-working-building.svg";
  if (n >= 2) return "clawd-working-juggling.svg";
  return "clawd-working-typing.svg";
}

/**
 * Get juggling SVG based on juggling session count
 */
function getJugglingSvg() {
  let n = 0;
  for (const [, s] of sessions) {
    if (s.state === "juggling") n++;
  }
  return n >= 2 ? "clawd-working-conducting.svg" : "clawd-working-juggling.svg";
}

/**
 * Build session submenu entries for context menu
 */
function buildSessionEntries(lang, t) {
  const entries = [];
  for (const [id, s] of sessions) {
    entries.push({
      id,
      state: s.state,
      updatedAt: s.updatedAt,
      sourcePid: s.sourcePid,
      cwd: s.cwd,
      editor: s.editor,
      pidChain: s.pidChain,
    });
  }

  if (entries.length === 0) {
    return [{ label: t("noSessions"), enabled: false }];
  }

  // Sort by priority desc, then updatedAt desc
  entries.sort((a, b) => {
    const pa = STATE_PRIORITY[a.state] || 0;
    const pb = STATE_PRIORITY[b.state] || 0;
    if (pb !== pa) return pb - pa;
    return b.updatedAt - a.updatedAt;
  });

  const STATE_EMOJI = {
    working: "\u{1F528}",
    thinking: "\u{1F914}",
    juggling: "\u{1F939}",
    idle: "\u{1F4A4}",
    sleeping: "\u{1F4A4}",
  };

  const STATE_LABEL_KEY = {
    working: "sessionWorking",
    thinking: "sessionThinking",
    juggling: "sessionJuggling",
    idle: "sessionIdle",
    sleeping: "sessionSleeping",
  };

  const path = require("path");
  const now = Date.now();

  return entries.map((e) => {
    const emoji = STATE_EMOJI[e.state] || "";
    const stateText = t(STATE_LABEL_KEY[e.state] || "sessionIdle");
    const name = e.cwd
      ? path.basename(e.cwd)
      : e.id.length > 6
        ? e.id.slice(0, 6) + ".."
        : e.id;
    const elapsed = formatElapsed(now - e.updatedAt, t);
    const hasPid = !!e.sourcePid;

    return {
      label: `${emoji} ${name}  ${stateText}  ${elapsed}`,
      enabled: hasPid,
      sourcePid: e.sourcePid,
      cwd: e.cwd,
      editor: e.editor,
      pidChain: e.pidChain,
    };
  });
}

/**
 * Format elapsed time for display
 */
function formatElapsed(ms, t) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return t("sessionJustNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("sessionMinAgo").replace("{n}", min);
  const hr = Math.floor(min / 60);
  return t("sessionHrAgo").replace("{n}", hr);
}

module.exports = {
  // Constants
  SESSION_STALE_MS,
  STATE_PRIORITY,
  ONESHOT_STATES,
  SLEEP_SEQUENCE,

  // Core functions
  getSessions,
  getSessionCount,
  hasSession,
  getSession,
  updateSession,
  deleteSession,
  cleanStaleSessions,
  resolveDisplayState,

  // Helper functions
  getActiveWorkingCount,
  getWorkingSvg,
  getJugglingSvg,
  buildSessionEntries,
};
