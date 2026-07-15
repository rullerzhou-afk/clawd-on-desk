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
// required from shared-process.js: PR2 (#634) has shared-process.js require this
// module for its shared resolver cache, and a reverse require here would create a
// cycle. The shared resolver (PR2) / clawd-hook.js (PR1) injects processAlive
// from shared-process.js; tests inject a fake.
//
// Cache v2 (#634): PR2 sinks the per-session cache into the shared resolver and
// namespaces it by agent. v2 lives ALONGSIDE v1 (untouched) for at least one
// release cycle so a session already running across the upgrade keeps hitting
// its v1 file until it is promoted (hooks/shared-process.js). The two schemes
// differ only in prefix, key input, and shape:
//   - v1: prefix `clawd-pidcache-`, key sha1(sessionId\0cwd), no version/namespace.
//   - v2: prefix `clawd-pidcache2-`, key sha1("2\0namespace\0sessionId\0cwd"),
//     shape adds `version` + `namespace`. The two prefixes are deliberately
//     non-overlapping under startsWith() ("clawd-pidcache2-" does NOT start with
//     "clawd-pidcache-": index 14 is "2" vs "-"), so the sweep classifies every
//     file with a single startsWith() and never double-counts (plan §5.2/§5.4).
// The lease read semantics (no clock, double-PID liveness by the caller) are
// identical for both.
//
// #681: v2 is also the SANITIZED shape. v1 persisted the agent's raw command
// line; v2 stores only the one boolean (`headless`) anything ever derived from
// it. Nothing writes v1 any more — writePidCache has no callers left, kept only
// so the migration tests can author legacy fixtures — so once a session's v1 is
// promoted or dropped, no raw command line survives on disk anywhere. The
// resolver promotes v1→v2 by deriving the boolean in memory and then deleting
// the v1, INCLUDING when the v2 write fails: the sanitized data is already in
// hand for the current event, and keeping the raw line around to save a possible
// future re-resolve is not a trade this project wants to make (plan §4.4.5/6).
//
// Design constraints (see docs/plans/plan-issue-627-residual-userprompt-flash.md §4.4/§5,
// and docs/plans/plan-issue-627-hook-snapshot-flash-cache.md for the original shape):
//   - Cache ONLY the stable subset: stablePid, agentPid, detectedEditor, and
//     (v2 only) the derived `headless` boolean. v1 also cached agentCommandLine;
//     v2 does not, and nothing writes v1 any more (#681, see above). NOT pidChain
//     (its head is the per-event ephemeral hook PowerShell; server MERGEs a
//     missing pid_chain, keeping the SessionStart one).
//   - v1 keys by session_id + cwd; v2 keys by namespace + session_id + cacheCwd.
//     Both are disabled when an identity ingredient is missing (a shared cache
//     would cross sessions); the CALLER declares cacheability (an agent's
//     "default" session id / empty cwd is non-cacheable).
//   - Reuse json-utils.writeJsonAtomic (tmp + rename) so a concurrent reader
//     never sees a half-written file. The promotion no-clobber path additionally
//     uses tmp + linkSync (atomic create-if-absent) so a stale v1→v2 promotion
//     never overwrites a concurrent fresh v2 (plan §5.5/§6.10).
//   - Zero third-party deps. Zero require of ./shared-process.js (see above).

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { writeJsonAtomic } = require("./json-utils");

const CACHE_PREFIX = "clawd-pidcache-";
// v2 (#634): a DISTINCT, non-overlapping prefix (see module doc). CACHE_PREFIX_V2
// deliberately does not startsWith CACHE_PREFIX and vice versa, so sweep
// classification is unambiguous.
const CACHE_PREFIX_V2 = "clawd-pidcache2-";
const CACHE_VERSION_V2 = 2;
// Sweep-only age floor: a file must be idle (mtime) at least this long before
// it is even considered for cleanup. This is NOT a read-validity clock (see
// module doc above) — it only bounds how eagerly the low-frequency
// SessionStart sweep goes looking for orphaned files. A day is generous
// enough that no realistically long-running session's cache is a candidate
// while it is still being touched (every cache HIT calls touchPidCache).
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

// The directory every cache file lives in. Production always uses os.tmpdir().
// Tests inject an isolated directory (__setCacheDirForTests) so a fake-liveness
// sweep can never scan the real temp dir — which would both interfere with
// concurrently-running test PROCESSES and delete a developer's genuine >24h
// session caches (the sweep does not spawn, so it happily walks everything under
// the shared prefix). No production env surface: the override is an in-process
// test seam only.
let _cacheDirOverride = null;
function cacheDir() {
  return _cacheDirOverride || os.tmpdir();
}
function __setCacheDirForTests(dir) {
  _cacheDirOverride = dir || null;
}

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
  return path.join(cacheDir(), `${CACHE_PREFIX}${hash}.json`);
}

// The v1 shape guard, shared by readPidCache and readPidCacheEntry so they can
// never drift. NO clock participates (lease rewrite, §4.4). Liveness of the
// cached PIDs is the CALLER's job — it must check BOTH the PID that becomes
// source_pid (stablePid) AND agentPid are alive before treating this as a hit.
// agentPid is REQUIRED (the write condition needs snapshotOk && agentPid, and
// the hit path liveness-checks it), so both are pinned to positive integers and
// a corrupt/hand-edited file can't ship a bad PID.
function isValidV1Shape(obj, cwd) {
  return !!obj && typeof obj === "object"
    && typeof obj.ts === "number" // ts itself is debug-only, but its presence is a shape guard
    && obj.cwd === cwd
    && isPositivePid(obj.stablePid)
    && isPositivePid(obj.agentPid);
}

// Returns the cached subset, or null on: caching disabled, no file,
// unreadable/unparseable file, shape guard failure, or cwd mismatch.
function readPidCache(sessionId, cwd) {
  const file = cacheFilePath(sessionId, cwd);
  if (!file) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    return isValidV1Shape(obj, cwd) ? obj : null;
  } catch {
    return null;
  }
}

// Read the v1 file in a SINGLE observation and return BOTH the validated subset
// AND the file identity (mtimeMs + size + raw content) from that same read. A
// caller that later conditionally deletes the file (promotion / end) MUST bind
// its delete-guard to this identity so it never deletes bytes it did not read
// (plan §5.5). This closes the race where readPidCache and a separate identity
// read straddle a concurrent replacement — the parsed subset and the identity
// then describe different files, and the fresh replacement gets promoted-over
// and deleted. Using ONE fd means the fstat and the read see the same inode even
// if a concurrent writer renames a replacement over the path mid-call. Returns
// null on caching disabled / missing / unreadable / shape-invalid.
function readPidCacheEntry(sessionId, cwd) {
  const file = cacheFilePath(sessionId, cwd);
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const st = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd).toString("utf8"); // same inode as the fstat above
    const obj = JSON.parse(raw);
    if (!isValidV1Shape(obj, cwd)) return null;
    return { subset: obj, identity: { mtimeMs: st.mtimeMs, size: st.size, raw } };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

// LEGACY v1 writer. No production caller remains (#681): the resolver writes v2
// only, and v1 exists solely to be read once and promoted. This is kept so the
// migration tests can author pre-#681 fixtures — if production code starts
// calling it again, v1 files (and the raw command lines in them) come back.
// test/pid-cache-sanitized.test.js asserts it stays caller-free.
//
// Historic contract, still true of the shape: callers MUST only pass a subset
// from a non-degraded resolve(). The resolver now enforces that at the source —
// a Windows walk that reads nothing returns an unavailable shape rather than
// decaying stablePid to process.ppid — so a degraded subset can no longer reach
// a writer in the first place. Stamps ts = write time, debug/forensics only; no
// read path consults it.
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

// ── Cache v2 (#634): namespaced + versioned ────────────────────────────────────
// The v2 surface mirrors v1 read/write/touch/drop but keys by
// namespace + sessionId + cacheCwd and stamps version + namespace into the file.
// Read validity is the same lease model as v1: NO clock, shape + identity only;
// liveness (double processAlive) stays the caller's job.

// v2 key input pins version + namespace + sessionId + cacheCwd with NUL
// separators (so "a"+"bc" and "ab"+"c" can't collide) before the same 16-char
// SHA-1 truncation v1 uses. namespace MUST be in the key so two agents that
// happen to share a session_id + cwd never read each other's cache. Returns null
// (caching off) when any identity ingredient is empty.
function cacheFilePathV2(namespace, sessionId, cacheCwd) {
  if (!namespace || !sessionId || !cacheCwd) return null;
  const hash = crypto
    .createHash("sha1")
    .update(`2\0${namespace}\0${sessionId}\0${cacheCwd}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(cacheDir(), `${CACHE_PREFIX_V2}${hash}.json`);
}

// The v2 on-disk shape. `cwd` stores the cacheCwd (not necessarily an adapter's
// body cwd). pidChain / foregroundWtHwnd / tmuxClient are deliberately NOT
// cached (a cache hit must never fake them); tmuxSocket is recomputed from env
// by the resolver, zero spawn.
//
// #681 privacy boundary: `agentCommandLine` is GONE from this shape. v1 cached
// the agent's raw command line, but the only thing anything ever did with it was
// derive one boolean — `headless` (Claude's -p/--print). Persisting the raw line
// to a world-readable %TEMP% file for the life of a session, to answer a yes/no
// question, is data we have no reason to keep. The resolver derives the boolean
// in memory from the live walk and stores only that (plan §4.4).
//
// Adding a field back here is a privacy decision, not a refactor: everything in
// this object lands on disk, outlives the hook process, and survives until the
// session ends or the 24h sweep. test/pid-cache-sanitized.test.js pins the exact
// key set for that reason.
function v2Payload(namespace, cacheCwd, subset) {
  return {
    version: CACHE_VERSION_V2,
    namespace,
    cwd: cacheCwd,
    stablePid: subset.stablePid,
    agentPid: subset.agentPid,
    headless: subset.headless === true,
    detectedEditor: subset.detectedEditor,
    ts: Date.now(),
  };
}

// Returns the cached v2 subset, or null on: caching disabled, no file,
// unreadable/unparseable, version/namespace/cwd mismatch, a non-positive
// stablePid/agentPid, or a missing headless boolean. NO clock participates
// (lease model, §4.4). The caller re-validates liveness of BOTH cached PIDs
// before treating this as a hit.
//
// The return is an explicit PROJECTION, not the parsed object: a file that
// somehow carries agentCommandLine (a hand-edited file, or one written by a
// pre-#681 build of this branch) can never leak it back into a body, a log, or
// a promotion. The `headless` boolean guard rejects that pre-#681 shape outright
// — it costs one fresh re-resolve and the file is rewritten sanitized.
function readPidCacheV2(namespace, sessionId, cacheCwd) {
  const file = cacheFilePathV2(namespace, sessionId, cacheCwd);
  if (!file) return null;
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!obj || typeof obj !== "object") return null;
    if (obj.version !== CACHE_VERSION_V2) return null;
    if (obj.namespace !== namespace) return null; // defense-in-depth; key already encodes it
    if (typeof obj.ts !== "number") return null; // shape guard, mirrors v1; ts is debug-only
    if (obj.cwd !== cacheCwd) return null;
    if (!isPositivePid(obj.stablePid)) return null;
    if (!isPositivePid(obj.agentPid)) return null;
    if (typeof obj.headless !== "boolean") return null; // sanitized shape, or nothing
    return {
      version: obj.version,
      namespace: obj.namespace,
      cwd: obj.cwd,
      stablePid: obj.stablePid,
      agentPid: obj.agentPid,
      headless: obj.headless,
      detectedEditor: typeof obj.detectedEditor === "string" ? obj.detectedEditor : null,
      ts: obj.ts,
    };
  } catch {
    return null;
  }
}

// Overwriting atomic write (tmp + rename), for the authoritative `start`/`event`
// fresh path. Callers MUST only pass a non-degraded subset (snapshotOk &&
// agentPid). Returns false when caching is disabled or the write fails.
function writePidCacheV2(namespace, sessionId, cacheCwd, subset) {
  const file = cacheFilePathV2(namespace, sessionId, cacheCwd);
  if (!file) return false;
  try {
    writeJsonAtomic(file, v2Payload(namespace, cacheCwd, subset));
    return true;
  } catch {
    return false;
  }
}

// Atomic create-if-absent v2 write for v1→v2 promotion (plan §5.5/§6.10).
// Returns:
//   "created" — we wrote the v2 (we won the race);
//   "exists"  — a concurrent writer already placed a v2 here. This is NOT a
//               failure: the caller prefers that (fresher) file and must not
//               overwrite it. This is exactly what keeps a stale promotion from
//               clobbering a concurrent fresh SessionStart v2 — the documented
//               recheck-is-not-CAS residual (plan §6.10) is closed by it;
//   false     — the write/link failed for another reason (e.g. a filesystem
//               without hard-link support). The caller falls back to returning
//               the validated v1 WITHOUT deleting it, and never spawns.
// Uses a sibling temp + linkSync: link is an atomic O_EXCL-style create, so a
// concurrent fresh v2 (written via writePidCacheV2's tmp+rename) is never
// overwritten. Never throws.
function writePidCacheV2IfAbsent(namespace, sessionId, cacheCwd, subset) {
  const file = cacheFilePathV2(namespace, sessionId, cacheCwd);
  if (!file) return false;
  const dir = path.dirname(file);
  const base = path.basename(file);
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.nc.tmp`
  );
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(v2Payload(namespace, cacheCwd, subset), null, 2), "utf-8");
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
  try {
    fs.linkSync(tmpPath, file); // atomic create-if-absent; throws EEXIST if file exists
    return "created";
  } catch (err) {
    return err && err.code === "EEXIST" ? "exists" : false;
  } finally {
    // On success the inode survives via `file`; on any failure this removes the
    // orphan temp. Either way the temp name never lingers.
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

function touchPidCacheV2(namespace, sessionId, cacheCwd) {
  const file = cacheFilePathV2(namespace, sessionId, cacheCwd);
  if (!file) return;
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    /* file gone (SessionEnd drop) / race — fine */
  }
}

function dropPidCacheV2(namespace, sessionId, cacheCwd) {
  const file = cacheFilePathV2(namespace, sessionId, cacheCwd);
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone / race — fine */
  }
}

// Classify a temp-dir entry as a v1/v2 cache file or neither. The prefixes are
// non-overlapping under startsWith (see module doc), so this is unambiguous.
function classifyPidCacheName(name) {
  if (!name.endsWith(".json")) return null;
  if (name.startsWith(CACHE_PREFIX_V2)) return "v2";
  if (name.startsWith(CACHE_PREFIX)) return "v1";
  return null;
}

// Best-effort sweep of orphaned cache files (sessions that crashed without a
// SessionEnd). Scans BOTH the v1 and v2 prefixes (#634, plan §5.4) so v1 files
// keep getting collected for at least one release cycle after PR2. Deletes a
// file only when BOTH hold:
//   1. age floor:  now - mtime > SWEEP_AGE_MS (mtime is bumped by every hit,
//      so an actively-used session's file is never even considered), AND
//   2. death proof: the file's shape is corrupt (a v2-prefixed file must also
//      carry version === 2), OR either cached PID (stablePid / agentPid) is no
//      longer alive per the injected isProcessAlive.
// Age alone NEVER deletes — a long-idle-but-still-alive session's cache
// survives indefinitely, by design (the read-side lease has no clock either;
// see module doc above).
//
// isProcessAlive is dependency-injected (kill(pid,0) semantics, e.g.
// hooks/shared-process.js processAlive) rather than required directly, to
// avoid a reverse-require cycle once PR2 makes shared-process.js depend on
// this module. Called at low frequency from the shared resolver (SessionStart
// for adapters that have one); silent on any error.
function sweepStalePidCaches(options = {}) {
  const now = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const checkAlive = typeof options.isProcessAlive === "function" ? options.isProcessAlive : () => true;
  const dir = cacheDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const kind = classifyPidCacheName(name);
    if (!kind) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (now - st.mtimeMs <= SWEEP_AGE_MS) continue; // too young to even consider

      let dead;
      try {
        const obj = JSON.parse(fs.readFileSync(full, "utf8"));
        let shapeOk = !!obj && typeof obj === "object"
          && isPositivePid(obj.stablePid) && isPositivePid(obj.agentPid);
        // A v2-prefixed file must carry the full v2 shape (version + namespace +
        // cwd + ts + the sanitized headless boolean); any missing/malformed
        // field is corrupt → dead. (A normal atomic write never produces this; a
        // hand-edited/partial file can.) headless is included so a file in the
        // pre-#681 v2 shape — the one that still carried agentCommandLine — is
        // treated as garbage and collected rather than left sitting in %TEMP%.
        if (shapeOk && kind === "v2") {
          shapeOk = obj.version === CACHE_VERSION_V2
            && typeof obj.namespace === "string" && obj.namespace.length > 0
            && typeof obj.cwd === "string" && obj.cwd.length > 0
            && typeof obj.ts === "number"
            && typeof obj.headless === "boolean";
        }
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
  readPidCacheEntry,
  writePidCache,
  touchPidCache,
  dropPidCache,
  sweepStalePidCaches,
  SWEEP_AGE_MS,
  CACHE_PREFIX,
  // v2 (#634) — namespaced, versioned; lives alongside v1 for the migration.
  CACHE_PREFIX_V2,
  CACHE_VERSION_V2,
  cacheFilePathV2,
  readPidCacheV2,
  writePidCacheV2,
  writePidCacheV2IfAbsent,
  touchPidCacheV2,
  dropPidCacheV2,
  // Test-only seam (no production env surface); see cacheDir() above.
  __setCacheDirForTests,
};
