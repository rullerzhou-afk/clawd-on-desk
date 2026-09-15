"use strict";

// Durable resume index for local agent sessions.
//
// This is the deliberate counterpart to session-recovery-lease.js, not an
// extension of it. A lease answers "is this session still running?", so it
// fails closed: loadActiveRecoveryLeases() unlinks any record whose PID is
// gone. After an OS restart every recorded PID is gone, so the first Clawd
// launch after a reboot erases exactly the rows a user needs to find the
// conversation they lost.
//
// History answers a different question — "what was I working on?" — and so
// must outlive the process it describes. It is written from the same hook
// events, but nothing here consults process liveness, and a record is only
// dropped by age or count. The two stores stay separate so the lease can
// keep its strict liveness checks without weakening them for recall.
//
// Contents are pointers, never conversation: session id, working directory,
// title, timestamps. No prompts, responses, or tool output.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeJsonAtomic } = require("./json-utils");
const { normalizeClaudeSessionId } = require("./claude-session-id");
const {
  SUPPORTED_AGENT_IDS,
  classifyStateBodyForRecovery,
  acquireLeaseLock,
  releaseLeaseLock,
  cleanupOrphanedLeaseLocks,
} = require("./session-recovery-lease");

const HISTORY_VERSION = 1;
const HISTORY_DIR_NAME = "session-history-v1";
const HISTORY_FILE_PREFIX = "session-history-v1-";
const MAX_HISTORY_BYTES = 16 * 1024;
const MAX_HISTORY_FILES = 200;
const MAX_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Hook traffic is high-frequency (tens of events per task). A session that is
// merely still running does not need a new row every event; only first sight,
// a terminal event, or changed identity fields bypass this.
const REFRESH_INTERVAL_MS = 30 * 1000;
// os.uptime() is whole seconds and the wall clock can be stepped by NTP, so
// two readings inside one boot drift. Compare boots with tolerance rather
// than equality.
const BOOT_TOLERANCE_MS = 5 * 60 * 1000;

const ALLOWED_RECORD_KEYS = new Set([
  "version",
  "agentId",
  "sessionId",
  "cwd",
  "title",
  "lastState",
  "firstSeenAt",
  "lastEventAt",
  "endedAt",
  "bootApproxAt",
]);

const SUSTAINED_STATES = new Set(["thinking", "working", "juggling"]);

function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  let id;
  try { id = normalizeClaudeSessionId(value); } catch { return null; }
  if (!id || id === "default" || id.length > 256) return null;
  return id;
}

function normalizeAgentId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : null;
}

function normalizeCwd(value) {
  if (typeof value !== "string") return "";
  const cwd = value.trim();
  if (!cwd || cwd.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(cwd)) return "";
  return cwd;
}

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.length > 120 ? title.slice(0, 120) : title;
}

// Boot identity without spawning anything. The Windows lease writer is bound
// by an explicit "never spawn a second PowerShell" rule, and this runs on the
// same hook path, so sysctl/wmic-style probes are not an option here.
function getBootApproxAt(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const uptimeMs = (typeof options.uptime === "function" ? options.uptime() : os.uptime()) * 1000;
  if (!Number.isFinite(uptimeMs) || uptimeMs < 0) return null;
  return Math.round(now - uptimeMs);
}

function isSameBoot(a, b, toleranceMs = BOOT_TOLERANCE_MS) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= toleranceMs;
}

function getHistoryDir(options = {}) {
  if (typeof options.historyDir === "string" && options.historyDir) {
    return path.resolve(options.historyDir);
  }
  return path.join(os.homedir(), ".clawd", HISTORY_DIR_NAME);
}

function ensureHistoryDir(options = {}) {
  const dir = getHistoryDir(options);
  try {
    const parent = path.dirname(dir);
    let parentStat;
    try {
      parentStat = fs.lstatSync(parent);
    } catch (err) {
      if (!err || err.code !== "ENOENT") return null;
      const grandparentStat = fs.lstatSync(path.dirname(parent));
      if (!grandparentStat.isDirectory() || grandparentStat.isSymbolicLink()) return null;
      fs.mkdirSync(parent, { mode: 0o700 });
      parentStat = fs.lstatSync(parent);
    }
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return null;
    try { fs.mkdirSync(dir, { mode: 0o700 }); }
    catch (err) { if (!err || err.code !== "EEXIST") return null; }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    try { fs.chmodSync(dir, 0o700); } catch {}
    return dir;
  } catch {
    return null;
  }
}

function historyHash(agentId, sessionId) {
  return crypto.createHash("sha256").update(`${agentId}\0${sessionId}`).digest("hex").slice(0, 32);
}

function getHistoryFilePath(agentId, sessionId, options = {}) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedAgentId || !normalizedSessionId) return null;
  return path.join(
    getHistoryDir(options),
    `${HISTORY_FILE_PREFIX}${historyHash(normalizedAgentId, normalizedSessionId)}.json`,
  );
}

function validateRecord(record, options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  if (Object.keys(record).some((key) => !ALLOWED_RECORD_KEYS.has(key))) return null;
  if (record.version !== HISTORY_VERSION) return null;
  const agentId = normalizeAgentId(record.agentId);
  const sessionId = normalizeSessionId(record.sessionId);
  if (!agentId || !SUPPORTED_AGENT_IDS.has(agentId) || !sessionId
    || agentId !== record.agentId || sessionId !== record.sessionId) return null;
  if (!Number.isFinite(record.firstSeenAt) || record.firstSeenAt <= 0) return null;
  if (!Number.isFinite(record.lastEventAt) || record.lastEventAt <= 0) return null;
  if (record.lastEventAt < record.firstSeenAt) return null;
  if (record.endedAt !== null && (!Number.isFinite(record.endedAt) || record.endedAt <= 0)) return null;
  if (record.bootApproxAt !== null && !Number.isFinite(record.bootApproxAt)) return null;
  if (record.lastState !== null && !SUSTAINED_STATES.has(record.lastState)) return null;
  const cwd = normalizeCwd(record.cwd);
  if (cwd !== record.cwd) return null;
  const title = record.title === null ? null : normalizeTitle(record.title);
  if (title !== record.title) return null;
  if (options.filePath) {
    const expected = getHistoryFilePath(agentId, sessionId, {
      historyDir: path.dirname(options.filePath),
    });
    if (!expected || path.basename(expected) !== path.basename(options.filePath)) return null;
  }
  return {
    version: HISTORY_VERSION,
    agentId,
    sessionId,
    cwd,
    title,
    lastState: record.lastState,
    firstSeenAt: record.firstSeenAt,
    lastEventAt: record.lastEventAt,
    endedAt: record.endedAt,
    bootApproxAt: record.bootApproxAt,
  };
}

function readHistoryFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_HISTORY_BYTES) {
      return null;
    }
    return validateRecord(JSON.parse(fs.readFileSync(filePath, "utf8")), { filePath });
  } catch {
    return null;
  }
}

function listHistoryFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.startsWith(HISTORY_FILE_PREFIX) && name.endsWith(".json"));
  } catch {
    return [];
  }
}

// Age first, then count. Unlike the lease pruner there is no liveness gate:
// a record whose process is long gone is precisely what this store keeps.
function pruneHistoryFiles(dir, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxAgeMs = Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
    ? options.maxAgeMs
    : MAX_HISTORY_AGE_MS;
  const maxFiles = Number.isFinite(options.maxFiles) && options.maxFiles > 0
    ? options.maxFiles
    : MAX_HISTORY_FILES;
  const skipFilePath = typeof options.skipFilePath === "string"
    ? path.resolve(options.skipFilePath)
    : null;

  let entries = listHistoryFiles(dir).map((name) => {
    const filePath = path.join(dir, name);
    return { name, filePath, record: readHistoryFile(filePath) };
  });

  // Invalid/foreign rows are not ours to delete and do not count toward the
  // retention budget. Every deletion re-reads under the writer's own lock.
  entries = entries.filter((entry) => entry.record);
  const remove = (entry) => {
    if (skipFilePath && path.resolve(entry.filePath) === skipFilePath) return false;
    const lock = acquireLeaseLock(entry.filePath, { nonBlocking: true });
    if (!lock) return false;
    try {
      const current = readHistoryFile(entry.filePath);
      if (!current || current.lastEventAt !== entry.record.lastEventAt) return false;
      fs.unlinkSync(entry.filePath);
      return true;
    } catch {
      return false;
    } finally {
      releaseLeaseLock(lock);
    }
  };

  for (const entry of entries) {
    if (now - entry.record.lastEventAt > maxAgeMs) entry.deleted = remove(entry);
  }
  entries = entries.filter((entry) => !entry.deleted);

  if (entries.length > maxFiles) {
    const oldestFirst = entries
      .slice()
      .sort((a, b) => a.record.lastEventAt - b.record.lastEventAt);
    for (const entry of oldestFirst) {
      if (entries.length <= maxFiles) break;
      if (remove(entry)) entries = entries.filter((candidate) => candidate !== entry);
    }
  }
  return entries.map((entry) => entry.name);
}

/**
 * Append or refresh this session's history row from a hook state body.
 *
 * Best-effort in the same sense as the recovery lease: it never throws and
 * never influences the hook's stdout or exit contract.
 */
function recordSessionHistoryFromStateBody(body, options = {}) {
  if (options.remote === true || process.env.CLAWD_REMOTE || (body && body.wsl_distro)) {
    return { written: false, reason: "remote-filesystem" };
  }
  // Headless one-shots are not resumable conversations.
  if (body && body.headless === true) return { written: false, reason: "headless" };

  const agentId = normalizeAgentId(body && body.agent_id);
  const sessionId = normalizeSessionId(body && body.session_id);
  if (!agentId || !SUPPORTED_AGENT_IDS.has(agentId) || !sessionId) {
    return { written: false, reason: "unsupported" };
  }

  // Reuse the recovery arbiter rather than deciding "still running" twice.
  const classified = classifyStateBodyForRecovery(body, options);
  if (!classified) return { written: false, reason: "unclassified" };

  const dir = ensureHistoryDir(options);
  const filePath = dir ? getHistoryFilePath(agentId, sessionId, { historyDir: dir }) : null;
  if (!filePath) return { written: false, reason: "path" };

  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) return { written: false, reason: "unsafe-file" };
    }
  } catch {
    return { written: false, reason: "unsafe-file" };
  }

  const lock = acquireLeaseLock(filePath);
  if (!lock) return { written: false, reason: "locked" };
  try {
    const existing = readHistoryFile(filePath);
    // An existing invalid row may belong to a future schema or another owner.
    if (!existing && fs.existsSync(filePath)) return { written: false, reason: "invalid-record" };
    const observedAt = Number.isFinite(options.eventAt) && options.eventAt > 0
      ? options.eventAt
      : Date.now();
    // Same tie-break as the lease: a terminal hook wins over same-tick work.
    const eventAt = observedAt + (classified.terminal ? 0.5 : 0);
    if (existing && existing.lastEventAt > eventAt) {
      return { written: false, reason: "older-event" };
    }

    const cwd = normalizeCwd(body.cwd) || (existing && existing.cwd) || "";
    const title = body._sessionTitleFromPrompt === true
      ? (existing && existing.title) || null
      : normalizeTitle(body.session_title) || (existing && existing.title) || null;
    const lastState = classified.active && SUSTAINED_STATES.has(classified.state)
      ? classified.state
      : (existing && existing.lastState) || null;
    // A session that goes quiet and then receives another prompt is live
    // again, so an earlier terminal event must not stick.
    const endedAt = classified.active
      ? null
      : (classified.terminal ? observedAt : (existing && existing.endedAt) || null);

    if (existing) {
      const identityUnchanged = existing.cwd === cwd
        && existing.title === title
        && existing.lastState === lastState
        && existing.endedAt === endedAt;
      const refreshIntervalMs = Number.isFinite(options.refreshIntervalMs)
        ? options.refreshIntervalMs
        : REFRESH_INTERVAL_MS;
      if (identityUnchanged && eventAt - existing.lastEventAt < refreshIntervalMs) {
        return { written: false, reason: "debounced", filePath, record: existing };
      }
    }

    const record = {
      version: HISTORY_VERSION,
      agentId,
      sessionId,
      cwd,
      title,
      lastState,
      firstSeenAt: existing ? existing.firstSeenAt : eventAt,
      lastEventAt: eventAt,
      endedAt,
      // In production sample wall clock and uptime together, after any hook
      // buffering/lock wait. Fixtures may supply a paired event clock.
      bootApproxAt: getBootApproxAt(options.uptime ? { now: observedAt, uptime: options.uptime } : {}),
    };
    writeJsonAtomic(filePath, record);
    try { fs.chmodSync(filePath, 0o600); } catch {}
    releaseLeaseLock(lock);
    pruneHistoryFiles(dir, { ...options, now: observedAt, skipFilePath: filePath });
    return { written: true, filePath, record };
  } catch {
    return { written: false, reason: "write-failed" };
  } finally {
    releaseLeaseLock(lock);
  }
}

/**
 * Read the history index, newest first, with sessions that were interrupted
 * by a restart ranked above ones that ended on their own.
 *
 * `interrupted` means: this session never reported a terminal event, and the
 * machine has booted since it was last seen. That is the crash case — nothing
 * got the chance to write an ending.
 */
function loadSessionHistory(options = {}) {
  const dir = getHistoryDir(options);
  try {
    const parentStat = fs.lstatSync(path.dirname(dir));
    const dirStat = fs.lstatSync(dir);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return [];
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return [];
  } catch {
    return [];
  }

  const now = Number.isFinite(options.now) ? options.now : Date.now();
  cleanupOrphanedLeaseLocks(dir, {
    ...options, filePrefix: HISTORY_FILE_PREFIX, requireDeadOwner: true,
  });
  const names = pruneHistoryFiles(dir, { ...options, now });
  const currentBootApproxAt = getBootApproxAt({ now, uptime: options.uptime });
  const isAgentEnabled = typeof options.isAgentEnabled === "function"
    ? options.isAgentEnabled
    : () => true;

  const records = [];
  for (const name of names) {
    const record = readHistoryFile(path.join(dir, name));
    if (!record) continue;
    if (!isAgentEnabled(record.agentId)) continue;
    // Clock stepped backwards far enough that the row claims the future.
    if (record.lastEventAt > now + 60_000) continue;
    records.push({
      ...record,
      interrupted: record.endedAt === null
        && !isSameBoot(record.bootApproxAt, currentBootApproxAt, options.bootToleranceMs),
    });
  }

  records.sort((a, b) => {
    if (a.interrupted !== b.interrupted) return a.interrupted ? -1 : 1;
    return b.lastEventAt - a.lastEventAt;
  });
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : records.length;
  return records.slice(0, limit);
}

module.exports = {
  HISTORY_VERSION,
  HISTORY_DIR_NAME,
  HISTORY_FILE_PREFIX,
  MAX_HISTORY_AGE_MS,
  MAX_HISTORY_FILES,
  REFRESH_INTERVAL_MS,
  BOOT_TOLERANCE_MS,
  getHistoryDir,
  getHistoryFilePath,
  getBootApproxAt,
  isSameBoot,
  readHistoryFile,
  validateRecord,
  pruneHistoryFiles,
  recordSessionHistoryFromStateBody,
  loadSessionHistory,
};
