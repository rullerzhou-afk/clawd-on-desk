// hooks/pid-cache.js — Cross-process cache for the resolved process-tree
// subset, keyed by session (#627; lease rewrite #627-residual §4.4).
//
// Why this exists: on Windows every hook event spawns a cold PowerShell to
// snapshot the process tree (hooks/shared-process.js getWindowsProcessSnapshot).
// With Windows Terminal as the default terminal application, that spawn flashes
// a visible console window despite windowsHide:true. The process tree is stable
// within a session, so we snapshot once (SessionStart) and let every other
// event read this cache instead of spawning.
//
// Lease semantics (v2, #627-residual plan §4.4): a cache READ no longer
// consults any clock. Validity = shape (positive-int stablePid/agentPid) + cwd
// match — full stop. The caller (clawd-hook.js) still does the real liveness
// check via processAlive(stablePid) && processAlive(agentPid) (kill(pid,0),
// zero spawn) before treating a read as a HIT; that double-PID check is the
// ONLY defense against a dead session's cache lingering, and it needs no clock
// because a dead PID is dead regardless of how long the file has sat there.
// `ts` remains in the JSON (stamped at write) but is now debug/forensic only —
// nothing reads it to decide validity.
//
// Why no time-based read expiry: the earlier design (idle TTL + absolute cap)
// existed only because UserPromptSubmit used to re-resolve and rewrite the
// cache every prompt, so a TTL bounded how stale a *stopped-refreshing* cache
// could get. Now that UserPromptSubmit is itself cache-only (no write), any
// clock-based expiry would just reintroduce a periodic forced-miss ⇒
// forced-fresh-resolve ⇒ console flash on every long-lived session — exactly
// what this whole change exists to avoid. The double-PID liveness check is a
// strictly stronger validity signal than a clock: a cache is only ever used
// while both the terminal/editor process AND the agent process are still
// alive, for as long as that's true, however long the file has sat there.
//
// Sweep still runs (from clawd-hook.js on SessionStart, low frequency) to
// collect orphan files from sessions that crashed without a SessionEnd. It
// requires BOTH an age floor (SWEEP_AGE_MS, keyed off mtime so an
// actively-touched file is never even a candidate) AND a death proof (corrupt
// shape, or either cached PID no longer alive) before deleting — age alone is
// NEVER sufficient, so a long-idle-but-still-alive session's cache is never
// swept out from under it.
//
// Liveness for the sweep is dependency-injected (isProcessAlive) rather than
// required from shared-process.js: PR2 (#634) will have shared-process.js
// require this module for its shared resolver cache, and a reverse require
// here would create a cycle. clawd-hook.js injects processAlive from
// shared-process.js; tests inject a fake.
//
// Design constraints (see docs/plans/plan-issue-627-residual-userprompt-flash.md §4.4,
// and docs/plans/plan-issue-627-hook-snapshot-flash-cache.md for the original shape):
//   - Cache ONLY the stable subset: stablePid, agentPid, agentCommandLine,
//     detectedEditor. NOT pidChain (its head is the per-event ephemeral hook
//     PowerShell; server MERGEs a missing pid_chain, keeping the SessionStart one).
//   - Key by session_id + cwd; disabled entirely when session_id is missing/
//     "default" or cwd is empty (a shared "default" cache would cross sessions).
//   - Reuse json-utils.writeJsonAtomic (tmp + rename) so a concurrent reader
//     never sees a half-written file.
//   - File format/prefix unchanged in this PR (still v1, `clawd-pidcache-`) —
//     namespacing + a v2 shape/prefix + v1→v2 promotion are PR2 (#634) scope.
//   - Zero third-party deps. Zero require of ./shared-process.js (see above).

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomic } = require("./json-utils");

const CACHE_PREFIX = "clawd-pidcache-";
// Sweep-only age floor: a file must be idle (mtime) at least this long before
// it is even considered for cleanup. This is NOT a read-validity clock (see
// module doc above) — it only bounds how eagerly the low-frequency
// SessionStart sweep goes looking for orphaned files. A day is generous
// enough that no realistically long-running session's cache is a candidate
// while it is still being touched (every cache HIT calls touchPidCache).
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

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

// Returns the cached subset, or null on: caching disabled, no file,
// unreadable/unparseable file, shape guard failure, or cwd mismatch. NO clock
// participates in this decision (lease rewrite, §4.4). Liveness of the cached
// PIDs is entirely the caller's job: it must check that BOTH the PID that
// becomes source_pid (stablePid) AND agentPid are alive before treating this
// as a real hit.
function readPidCache(sessionId, cwd) {
  const file = cacheFilePath(sessionId, cwd);
  if (!file) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.ts !== "number") return null; // shape guard; ts itself is debug-only
    if (obj.cwd !== cwd) return null;
    // Shape guard. Liveness is re-validated by the caller. agentPid is
    // REQUIRED (the write condition needs snapshotOk && agentPid, and the hit
    // path does its own processAlive(agentPid)) — pin both to positive
    // integers so a corrupt/hand-edited file can't ship a bad PID.
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
// write time — kept for debug/forensics only; no read path consults it.
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

// Bump the cache file's mtime on a HIT. Under the lease model this no longer
// "renews a TTL" — reads don't consult mtime — but it still feeds the sweep's
// age floor (SWEEP_AGE_MS): a session that keeps getting cache hits keeps
// pushing its file out of sweep-eligibility, so an actively-used session is
// never a sweep candidate. Uses fs.utimesSync, which only modifies an
// EXISTING file and never creates one — so a hit racing a SessionEnd
// dropPidCache() cannot resurrect the dropped file (utimesSync throws on a
// missing file and we swallow it). No spawn, one cheap metadata write.
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
// SessionEnd). Deletes a file only when BOTH hold:
//   1. age floor:  now - mtime > SWEEP_AGE_MS (mtime is bumped by every hit,
//      so an actively-used session's file is never even considered), AND
//   2. death proof: the file's shape is corrupt, OR either cached PID
//      (stablePid / agentPid) is no longer alive per the injected
//      isProcessAlive.
// Age alone NEVER deletes — a long-idle-but-still-alive session's cache
// survives indefinitely, by design (the read-side lease has no clock either;
// see module doc above).
//
// isProcessAlive is dependency-injected (kill(pid,0) semantics, e.g.
// hooks/shared-process.js processAlive) rather than required directly, to
// avoid a reverse-require cycle once PR2 makes shared-process.js depend on
// this module. Called once per session from SessionStart (low frequency);
// silent on any error.
function sweepStalePidCaches(options = {}) {
  const now = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const checkAlive = typeof options.isProcessAlive === "function" ? options.isProcessAlive : () => true;
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
      if (now - st.mtimeMs <= SWEEP_AGE_MS) continue; // too young to even consider

      let dead;
      try {
        const obj = JSON.parse(fs.readFileSync(full, "utf8"));
        const shapeOk = !!obj && typeof obj === "object"
          && isPositivePid(obj.stablePid) && isPositivePid(obj.agentPid);
        dead = !shapeOk || !checkAlive(obj.stablePid) || !checkAlive(obj.agentPid);
      } catch {
        dead = true; // unreadable/corrupt — treated as a damaged shape
      }
      if (dead) {
        // Re-check right before unlink: a concurrent SessionStart's
        // writePidCache (atomic tmp+rename) may have REPLACED this file after
        // we judged the OLD one dead. Deleting the replacement used to be
        // self-healing ("next read misses → one fresh resolve"), but under
        // the no-fallback contract UserPromptSubmit/SessionEnd never
        // re-resolve — the session would stay field-less until the next
        // ordinary event's miss-fallback, i.e. one avoidable flash. A changed
        // mtime means we judged a file that no longer exists; skip it. This
        // narrows the race window from stat→read→liveness→unlink down to
        // stat→unlink (microseconds); a strict guarantee would need
        // cross-process write/sweep coordination, which the residual window
        // does not justify.
        const st2 = fs.statSync(full);
        if (st2.mtimeMs !== st.mtimeMs) continue;
        fs.unlinkSync(full);
      }
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
  SWEEP_AGE_MS,
  CACHE_PREFIX,
};
