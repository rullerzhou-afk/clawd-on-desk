// hooks/pid-cache.js — Cross-process cache for the resolved process-tree
// subset, keyed by session (#627).
//
// Why this exists: on Windows every hook event spawns a cold PowerShell to
// snapshot the process tree (hooks/shared-process.js getWindowsProcessSnapshot).
// With Windows Terminal as the default terminal application, that spawn flashes
// a visible console window despite windowsHide:true. The process tree is stable
// within a session, so we snapshot once (SessionStart / UserPromptSubmit) and
// let the high-frequency events (PreToolUse/PostToolUse/Stop) read this cache
// instead of spawning. Also collapses the ~270ms PS cold start tracked in #350.
//
// Design constraints (see docs/plans/plan-issue-627-hook-snapshot-flash-cache.md):
//   - Cache ONLY the stable subset: stablePid, agentPid, agentCommandLine,
//     detectedEditor. NOT pidChain (its head is the per-event ephemeral hook
//     PowerShell; server MERGEs a missing pid_chain, keeping the SessionStart one).
//   - Key by session_id + cwd; disabled entirely when session_id is missing/
//     "default" or cwd is empty (a shared "default" cache would cross sessions).
//   - Reuse json-utils.writeJsonAtomic (tmp + rename) so a concurrent reader
//     never sees a half-written file.
//   - Zero third-party deps.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomic } = require("./json-utils");

const CACHE_PREFIX = "clawd-pidcache-";
// Session-scoped invalidation (SessionEnd drops the file) is the primary
// lifecycle control; TTL is only a backstop for sessions that crash without a
// SessionEnd. Kept under 10 min so a stale entry cannot outlive a terminal that
// was closed and whose PID may have been reused.
const CACHE_TTL_MS = 5 * 60 * 1000;

// A session_id of "default" is the placeholder clawd-hook.js falls back to when
// the agent's stdin JSON lacked one (#583): caching under it would let unrelated
// sessions read each other's PIDs. Empty cwd removes the second identity guard.
function canCache(sessionId, cwd) {
  return !!sessionId && sessionId !== "default" && !!cwd;
}

function isPositivePid(v) {
  return Number.isInteger(v) && v > 0;
}

function cacheFilePath(sessionId, cwd) {
  if (!canCache(sessionId, cwd)) return null;
  const hash = crypto
    .createHash("sha1")
    .update(`${sessionId}\0${cwd}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(os.tmpdir(), `${CACHE_PREFIX}${hash}.json`);
}

// Returns the cached subset, or null on: caching disabled, no file, unreadable/
// unparseable file, expired ts, or cwd mismatch (the second identity guard).
// Liveness of the cached PID is the caller's job — it checks the PID that will
// actually become source_pid (see clawd-hook.js).
function readPidCache(sessionId, cwd) {
  const file = cacheFilePath(sessionId, cwd);
  if (!file) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.ts !== "number" || Date.now() - obj.ts > CACHE_TTL_MS) return null;
    if (obj.cwd !== cwd) return null;
    // Shape guard: a corrupt/hand-edited file that still parses as JSON must not
    // ship a non-numeric source_pid/agent_pid downstream. stablePid is validated
    // again by the caller's liveness check, but agentPid is not — so pin both.
    if (!isPositivePid(obj.stablePid)) return null;
    if (obj.agentPid != null && !isPositivePid(obj.agentPid)) return null;
    return obj;
  } catch {
    return null;
  }
}

// Persist the stable subset. Callers MUST only pass a subset from a non-degraded
// resolve() (snapshotOk && agentPid) — a failed snapshot decays stablePid to
// process.ppid, and caching that would poison the whole session. Returns true on
// write, false when caching is disabled or the write failed.
function writePidCache(sessionId, cwd, subset) {
  const file = cacheFilePath(sessionId, cwd);
  if (!file) return false;
  try {
    writeJsonAtomic(file, { ...subset, cwd, ts: Date.now() });
    return true;
  } catch {
    return false;
  }
}

function dropPidCache(sessionId, cwd) {
  const file = cacheFilePath(sessionId, cwd);
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone / race with another SessionEnd — fine */
  }
}

// Best-effort sweep of orphaned cache files (sessions that crashed without a
// SessionEnd). Only removes our own prefix and only entries older than 2x TTL,
// so a live session's file (refreshed on every UserPromptSubmit) is never
// swept, and a not-yet-expired entry is left alone. Called once per session
// from SessionStart (low frequency); silent on any error.
function sweepStalePidCaches(nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const dir = os.tmpdir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(CACHE_PREFIX) || !name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      // Narrow stat-then-unlink TOCTOU: if a session rewrote this exact file
      // (rename) between the statSync and the unlinkSync, we could delete a
      // just-written entry. Harmless and self-healing — the next readPidCache
      // misses and rebuilds via one fresh resolve — so not worth a lock.
      if (now - st.mtimeMs > 2 * CACHE_TTL_MS) fs.unlinkSync(full);
    } catch {
      /* raced with a writer/other sweeper — skip */
    }
  }
}

module.exports = {
  canCache,
  cacheFilePath,
  readPidCache,
  writePidCache,
  dropPidCache,
  sweepStalePidCaches,
  CACHE_TTL_MS,
  CACHE_PREFIX,
};
