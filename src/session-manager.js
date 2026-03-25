/**
 * Session Manager for Clawd Desktop Pet
 *
 * Manages Claude Code session tracking with type-based alive detection.
 * - LocalSession: PID is reachable locally, uses PID detection + timeout
 * - RemoteSession: PID is not reachable (WSL2/remote), uses timeout only
 */

// ── Constants ───────────────────────────────────────────────────────────────

const SESSION_STALE_MS = 300000; // 5 minutes: max session lifetime without update
const WORKING_STALE_MS = 300000; // 5 min: working/juggling/thinking with no update → decay to idle

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

const ONESHOT_STATES = new Set(["attention", "error", "sweeping", "notification", "carrying"]);
const SLEEP_SEQUENCE = new Set(["yawning", "dozing", "collapsing", "sleeping", "waking"]);

// ── PID Detection ────────────────────────────────────────────────────────────

function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: process exists but we don't have permission to signal it
    return e.code === "EPERM";
  }
}

// ── Base Session Class ───────────────────────────────────────────────────────

class BaseSession {
  constructor(sessionId, pid, metadata = {}) {
    this.sessionId = sessionId;
    this.pid = pid || null; // sourcePid (terminal process)
    this.state = metadata.state || "idle";
    this.updatedAt = Date.now();
    this.cwd = metadata.cwd || "";
    this.editor = metadata.editor || null;
    this.pidChain = metadata.pidChain || null;
    this.agentPid = metadata.agentPid || null; // agent process PID (claude/codex/copilot)
    this.agentId = metadata.agentId || "claude-code"; // agent identifier
    this.usage = null;
  }

  /**
   * Update timestamp and optional fields
   */
  touch(metadata = {}) {
    this.updatedAt = Date.now();
    if (metadata.sourcePid) this.pid = metadata.sourcePid;
    if (metadata.cwd) this.cwd = metadata.cwd;
    if (metadata.editor) this.editor = metadata.editor;
    if (metadata.pidChain) this.pidChain = metadata.pidChain;
    if (metadata.agentPid) this.agentPid = metadata.agentPid;
    if (metadata.agentId) this.agentId = metadata.agentId;
  }

  /**
   * Get age in milliseconds
   */
  get age() {
    return Date.now() - this.updatedAt;
  }

  /**
   * Check if session is still alive. Must be implemented by subclasses.
   * @returns {boolean} true if session should be kept, false if it should be deleted
   */
  alive() {
    throw new Error("alive() must be implemented by subclass");
  }

  /**
   * Check and apply state decay (working/juggling/thinking → idle after timeout)
   * @returns {boolean} true if state was changed
   */
  decayState() {
    if (this.age > WORKING_STALE_MS) {
      if (this.state === "working" || this.state === "juggling" || this.state === "thinking") {
        this.state = "idle";
        return true;
      }
    }
    return false;
  }
}

// ── Local Session ────────────────────────────────────────────────────────────

class LocalSession extends BaseSession {
  /**
   * Session with locally reachable PID.
   * Uses PID detection for faster cleanup when process dies.
   */
  alive() {
    // 1. Check if agent process is dead → orphan session, delete immediately
    if (this.agentPid && !isProcessAlive(this.agentPid)) {
      return false;
    }

    // 2. Check if terminal process is dead
    if (this.pid && !isProcessAlive(this.pid)) {
      return false;
    }

    // 3. Apply state decay (working → idle after 30s)
    this.decayState();

    // 4. Check timeout
    if (this.age > SESSION_STALE_MS) {
      return false;
    }

    return true;
  }

  get type() {
    return "local";
  }
}

// ── Remote Session ───────────────────────────────────────────────────────────

class RemoteSession extends BaseSession {
  /**
   * Session with remote PID (WSL2, SSH, etc).
   * PID is stored for reference but not used for alive detection.
   * Relies purely on timeout.
   */
  alive() {
    // 1. Apply state decay
    this.decayState();

    // 2. Check timeout only
    if (this.age > SESSION_STALE_MS) {
      return false;
    }

    return true;
  }

  get type() {
    return "remote";
  }
}

// ── Session Factory ──────────────────────────────────────────────────────────

const SessionFactory = {
  /**
   * Create appropriate session type based on PID reachability.
   * @param {string} sessionId
   * @param {number|null} pid
   * @param {object} metadata
   * @returns {BaseSession}
   */
  create(sessionId, pid, metadata = {}) {
    // Check if PID is reachable locally
    if (pid && isProcessAlive(pid)) {
      return new LocalSession(sessionId, pid, metadata);
    } else {
      return new RemoteSession(sessionId, pid, metadata);
    }
  }
};

// ── Session Manager ──────────────────────────────────────────────────────────

const sessions = new Map();

function getSessions() {
  return sessions;
}

function getSessionCount() {
  return sessions.size;
}

function hasSession(sessionId) {
  return sessions.has(sessionId);
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

/**
 * Update or create a session based on incoming event.
 */
function updateSession(sessionId, state, event, metadata = {}) {
  const { sourcePid, cwd, editor, pidChain, agentPid, agentId } = metadata;

  // SessionEnd: delete the session
  if (event === "SessionEnd") {
    sessions.delete(sessionId);
    return { deleted: true };
  }

  // Get or create session
  let session = sessions.get(sessionId);

  if (!session) {
    // Create new session using factory
    session = SessionFactory.create(sessionId, sourcePid, {
      state,
      cwd,
      editor,
      pidChain,
      agentPid,
      agentId,
    });
    sessions.set(sessionId, session);
  } else {
    // Update existing session
    session.touch({ sourcePid, cwd, editor, pidChain, agentPid, agentId });
  }

  // PermissionRequest: don't mutate session state
  if (event === "PermissionRequest") {
    return { permissionRequest: true };
  }

  // Attention/notification/sleep: session goes idle
  if (state === "attention" || state === "notification" || SLEEP_SEQUENCE.has(state)) {
    session.state = "idle";
    return { updated: true };
  }

  // Oneshot states: preserve session's previous state
  if (ONESHOT_STATES.has(state)) {
    // Don't change session.state, just update timestamp (already done in touch)
    return { updated: true, oneshot: true };
  }

  // Preserve juggling: subagent's own tool use shouldn't override juggling
  if (session.state === "juggling" && state === "working" && event !== "SubagentStop" && event !== "subagentStop") {
    return { updated: true };
  }

  // Normal state update
  session.state = state;
  return { updated: true };
}

/**
 * Delete a session immediately
 */
function deleteSession(sessionId) {
  return sessions.delete(sessionId);
}

/**
 * Update usage info for a session
 */
function updateUsage(sessionId, usage) {
  const session = sessions.get(sessionId);
  if (session) {
    session.usage = usage;
    session.updatedAt = Date.now();
    return true;
  }
  return false;
}

/**
 * Clean up stale sessions.
 * Each session's alive() method determines if it should be deleted.
 * @returns {object} { changed: boolean, sessionCount: number }
 */
function cleanStaleSessions() {
  let changed = false;

  for (const [id, session] of sessions) {
    if (!session.alive()) {
      sessions.delete(id);
      changed = true;
    }
  }

  return { changed, sessionCount: sessions.size };
}

/**
 * Resolve the display state from all active sessions.
 */
function resolveDisplayState() {
  if (sessions.size === 0) return "idle";

  let best = "sleeping";
  for (const [, session] of sessions) {
    if ((STATE_PRIORITY[session.state] || 0) > (STATE_PRIORITY[best] || 0)) {
      best = session.state;
    }
  }
  return best;
}

/**
 * Get count of active working sessions
 */
function getActiveWorkingCount() {
  let n = 0;
  for (const [, session] of sessions) {
    if (session.state === "working" || session.state === "thinking" || session.state === "juggling") {
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
  for (const [, session] of sessions) {
    if (session.state === "juggling") n++;
  }
  return n >= 2 ? "clawd-working-conducting.svg" : "clawd-working-juggling.svg";
}

/**
 * Build session submenu entries for context menu
 */
function buildSessionEntries(lang, t) {
  const entries = [];
  for (const [id, session] of sessions) {
    entries.push({
      id,
      state: session.state,
      updatedAt: session.updatedAt,
      sourcePid: session.pid,
      cwd: session.cwd,
      editor: session.editor,
      pidChain: session.pidChain,
      usage: session.usage,
      type: session.type,
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

    // Format usage info
    let usageText = "";
    if (e.usage) {
      const inputK = Math.round((e.usage.input_tokens || 0) / 1000);
      const outputK = Math.round((e.usage.output_tokens || 0) / 1000);
      if (inputK > 0 || outputK > 0) {
        usageText = `  ${inputK}k in, ${outputK}k out`;
      }
    }

    return {
      label: `${emoji} ${name}  ${stateText}${usageText}  ${elapsed}`,
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
  WORKING_STALE_MS,
  STATE_PRIORITY,
  ONESHOT_STATES,
  SLEEP_SEQUENCE,

  // Classes
  BaseSession,
  LocalSession,
  RemoteSession,
  SessionFactory,

  // Core functions
  getSessions,
  getSessionCount,
  hasSession,
  getSession,
  updateSession,
  updateUsage,
  deleteSession,
  cleanStaleSessions,
  resolveDisplayState,

  // Helper functions
  getActiveWorkingCount,
  getWorkingSvg,
  getJugglingSvg,
  buildSessionEntries,

  // Utility
  isProcessAlive,
};
