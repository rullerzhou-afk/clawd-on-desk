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
// Bounded sliding TTL (#627 plan §8): a cache HIT refreshes the file mtime
// (touchPidCache) so an active session's cache never expires mid-turn — this
// removes the every-5-min re-snapshot on long turns and the thundering herd at
// each TTL boundary. Two clocks bound it:
//   - idle TTL    (IDLE_TTL_MS):     now - mtime; last-use timeout.
//   - absolute cap (ABSOLUTE_CAP_MS): now - ts;   creation cap, so a reused
//     stablePid/agentPid cannot keep a dead session's cache alive forever.
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
// Idle TTL: time since last hit, measured by the file's mtime. A cache hit
// touches the file (touchPidCache), so an actively-used session stays warm and
// only genuine inactivity (a crashed/orphaned session) lets it expire. Kept
// under 10 min so a truly idle entry cannot outlive a terminal whose PID may
// have been reused.
const IDLE_TTL_MS = 5 * 60 * 1000;
// Absolute cap: time since creation, measured by the JSON `ts` (stamped once at
// write, never bumped by a hit). Bounds how long a reused stablePid/agentPid
// could keep a dead session's cache alive under sliding TTL — this preserves the
// short-TTL PID-reuse backstop that plain "renew forever" would remove.
const ABSOLUTE_CAP_MS = 30 * 60 * 1000;

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
// unparseable file, idle-expired (mtime), absolute-cap-expired (ts), or cwd
// mismatch. Liveness of the cached PIDs is the caller's job — it checks that the
// PID that becomes source_pid (stablePid) AND agentPid are both alive.
function readPidCache(sessionId, cwd) {
  const file = cacheFilePath(sessionId, cwd);
  if (!file) return null;
  try {
    const now = Date.now();
    const st = fs.statSync(file);
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.ts !== "number") return null;
    // Bounded sliding TTL: idle timeout on mtime (last use), hard cap on ts
    // (creation). One `now` for both comparisons to avoid boundary jitter.
    if (now - st.mtimeMs > IDLE_TTL_MS) return null;
    if (now - obj.ts > ABSOLUTE_CAP_MS) return null;
    if (obj.cwd !== cwd) return null;
    // Shape guard. stablePid is re-validated by the caller's liveness check.
    // agentPid is now REQUIRED (the write condition already needs snapshotOk &&
    // agentPid, and the hit path does a second processAlive(agentPid)) — pin both
    // to positive integers so a corrupt/hand-edited file can't ship a bad PID.
    if (!isPositivePid(obj.stablePid)) return null;
    if (!isPositivePid(obj.agentPid)) return null;
    return obj;
  } catch {
    return null;
  }
}

// Persist the stable subset. Callers MUST only pass a subset from a non-degraded
// resolve() (snapshotOk && agentPid) — a failed snapshot decays stablePid to
// process.ppid, and caching that would poison the whole session. Stamps ts =
// creation time (the absolute-cap anchor); a later hit only bumps the file mtime
// via touchPidCache, never ts. Returns true on write, false when caching is
// disabled or the write failed.
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

// Sliding-TTL refresh: bump the cache file's mtime (the idle-TTL anchor) on a
// hit, WITHOUT rewriting ts (the absolute-cap anchor). Uses fs.utimesSync, which
// only modifies an EXISTING file and never creates one — so a hit racing a
// SessionEnd dropPidCache() cannot resurrect the dropped file (utimesSync throws
// on a missing file and we swallow it). No spawn, one cheap metadata write.
function touchPidCache(sessionId, cwd) {
  const file = cacheFilePath(sessionId, cwd);
  if (!file) return;
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    /* file gone (SessionEnd drop) / race — fine; next read misses and rebuilds */
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
// SessionEnd). Keys off mtime — which under sliding TTL is the last-use time, so
// a live session's file (touched on every hit) is never swept; only entries idle
// past 2x IDLE_TTL_MS go. Called once per session from SessionStart (low
// frequency); silent on any error.
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
      // Narrow stat-then-unlink TOCTOU: if a session touched/rewrote this exact
      // file between the statSync and the unlinkSync, we could delete a
      // just-refreshed entry. Harmless and self-healing — the next readPidCache
      // misses and rebuilds via one fresh resolve — so not worth a lock.
      if (now - st.mtimeMs > 2 * IDLE_TTL_MS) fs.unlinkSync(full);
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
  touchPidCache,
  dropPidCache,
  sweepStalePidCaches,
  IDLE_TTL_MS,
  ABSOLUTE_CAP_MS,
  CACHE_PREFIX,
};
