"use strict";

// Local Codex archive observation (#655).
//
// Codex's official archive contract moves a thread's persisted rollout JSONL
// out of the live sessions tree into <CODEX_HOME>/archived_sessions and emits
// thread/archived. Clawd does not own an app-server connection, so this tracker
// observes only the local filesystem: a regular rollout-*.jsonl file under the
// archive root whose bounded session_meta identifies the exact canonical task.
//
// Positive evidence only. A missing live file, a permission error, an
// unreadable/malformed/truncated first line, a directory that cannot be listed,
// or a scan interrupted mid-flight are all UNKNOWN and never retire a session.
// The tracker is deliberately independent of the JSONL turn-content parser so
// it also covers official-hook-only sessions the monitor never tracked.
//
// Bounded I/O. Each poll lists the archive directory once, validates at most
// `validateBatchSize` candidates, and keeps LRU-capped evidence + failure
// caches instead of one permanent entry per historical file. A directory larger
// than one batch is swept with a rotating cursor (live candidates always first)
// so late entries are reached across polls without a cap that could permanently
// skip the tail. A failing candidate that has not changed is not re-read until
// its backoff expires; a changed/replaced file is re-validated immediately.
//
// Evidence staleness. Before a live candidate is retired, its evidence is
// re-checked against the current filesystem (and re-validated in full if it
// changed). This closes the cross-candidate await race where A was unarchived
// while B was being validated: the stale cached entry is dropped, never applied.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { bareCodexSessionId } = require("../hooks/codex-session-index");

const ARCHIVE_DIR_NAME = "archived_sessions";
const ROLLOUT_PREFIX = "rollout-";
const ROLLOUT_SUFFIX = ".jsonl";
// UUID v7 rollout ids are lowercase hex; a filename-derived candidate that does
// not match this shape (or contains a path separator / traversal token) is
// rejected before any filesystem access.
const CANONICAL_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIRST_LINE_MAX_BYTES = 256 * 1024;
const FIRST_LINE_MAX_READS = 8;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_VALIDATE_BATCH_SIZE = 64;
// Retained caches are capped so a user with a huge archive history does not
// keep one metadata entry per file forever. Eviction is not a permanent miss:
// a name without evidence is a candidate again on the next rotating sweep.
const DEFAULT_MAX_EVIDENCE_ENTRIES = 2048;
const DEFAULT_MAX_FAILED_ENTRIES = 2048;
const FAILED_RETRY_BASE_MS = 15 * 1000;
const FAILED_RETRY_MAX_MS = 10 * 60 * 1000;
const FAILED_RETRY_MAX_LEVEL = 6;

function resolveCodexHome(env = process.env, homedir = os.homedir) {
  const configured = env && env.CODEX_HOME;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return path.join(homedir(), ".codex");
}

// rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl
// The trailing five dash segments are the rollout UUID, matching
// agents/codex-log-monitor.js:_extractSessionId. Reject anything that is not a
// plain basename with a canonical id.
function deriveCanonicalSessionId(fileName) {
  if (typeof fileName !== "string" || !fileName) return null;
  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) return null;
  if (!fileName.startsWith(ROLLOUT_PREFIX) || !fileName.endsWith(ROLLOUT_SUFFIX)) return null;
  const base = fileName.slice(0, -ROLLOUT_SUFFIX.length);
  const parts = base.split("-");
  if (parts.length < 10) return null;
  const candidate = parts.slice(-5).join("-");
  return CANONICAL_SESSION_ID_RE.test(candidate) ? candidate : null;
}

function statIdentity(stat) {
  if (!stat) return null;
  const dev = Number(stat.dev);
  const ino = Number(stat.ino);
  if (Number.isFinite(dev) && Number.isFinite(ino) && (dev !== 0 || ino !== 0)) {
    return `inode:${dev}:${ino}`;
  }
  const birthtimeMs = Number(stat.birthtimeMs);
  if (Number.isFinite(birthtimeMs) && birthtimeMs > 0) return `birth:${birthtimeMs}`;
  return null;
}

function isRegularFileStat(stat) {
  if (!stat) return false;
  if (typeof stat.isFile === "function") return stat.isFile() === true;
  return stat.isFile === true;
}

function isSymlinkStat(stat) {
  if (!stat) return false;
  if (typeof stat.isSymbolicLink === "function") return stat.isSymbolicLink() === true;
  return stat.isSymbolicLink === true;
}

function statSize(stat) {
  const size = Number(stat && stat.size);
  return Number.isFinite(size) ? size : NaN;
}

function statMtime(stat) {
  const mtime = Number(stat && stat.mtimeMs);
  return Number.isFinite(mtime) ? mtime : NaN;
}

// Cheap, allocation-light identity for a failed candidate so an unchanged bad
// file does not get its head re-read every poll. `null` means the stat itself
// was unavailable, in which case no negative cache entry is kept.
function failureFingerprint(stat) {
  if (!stat || !isRegularFileStat(stat)) return null;
  const identity = statIdentity(stat);
  const size = statSize(stat);
  const mtime = statMtime(stat);
  return `${identity || "no-identity"}|${Number.isFinite(size) ? size : "?"}|${Number.isFinite(mtime) ? mtime : "?"}`;
}

async function defaultListDirectory(dir) {
  return fs.promises.readdir(dir);
}

async function defaultStatFile(filePath) {
  try {
    return await fs.promises.lstat(filePath);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
    throw err;
  }
}

async function defaultReadFirstLine(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(FIRST_LINE_MAX_BYTES);
    let total = 0;
    for (let attempt = 0; attempt < FIRST_LINE_MAX_READS && total < FIRST_LINE_MAX_BYTES; attempt += 1) {
      const { bytesRead } = await handle.read(buf, total, FIRST_LINE_MAX_BYTES - total, total);
      if (!Number.isFinite(bytesRead) || bytesRead <= 0) break;
      total += bytesRead;
      if (buf.subarray(0, total).indexOf(0x0a) !== -1) break;
    }
    if (total <= 0) return null;
    const slice = buf.subarray(0, total);
    const newline = slice.indexOf(0x0a);
    if (newline === -1) return null;
    return slice.subarray(0, newline).toString("utf8");
  } catch {
    return null;
  } finally {
    try { await handle.close(); } catch {}
  }
}

function createCodexArchiveTracker(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const debugLog = typeof options.debugLog === "function" ? options.debugLog : () => {};
  const listDirectory = options.listDirectory || defaultListDirectory;
  const statFile = options.statFile || defaultStatFile;
  const readFirstLine = options.readFirstLine || defaultReadFirstLine;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0
    ? options.pollIntervalMs
    : DEFAULT_POLL_INTERVAL_MS;
  const validateBatchSize = Number.isInteger(options.validateBatchSize) && options.validateBatchSize > 0
    ? options.validateBatchSize
    : DEFAULT_VALIDATE_BATCH_SIZE;
  const maxEvidenceEntries = Number.isInteger(options.maxEvidenceEntries) && options.maxEvidenceEntries > 0
    ? options.maxEvidenceEntries
    : DEFAULT_MAX_EVIDENCE_ENTRIES;
  const maxFailedEntries = Number.isInteger(options.maxFailedEntries) && options.maxFailedEntries > 0
    ? options.maxFailedEntries
    : DEFAULT_MAX_FAILED_ENTRIES;
  const getLiveCandidateIds = typeof options.getLiveCandidateIds === "function"
    ? options.getLiveCandidateIds
    : () => [];
  const onArchiveConfirmed = typeof options.onArchiveConfirmed === "function"
    ? options.onArchiveConfirmed
    : () => {};
  const codexHome = typeof options.codexHome === "string" && options.codexHome
    ? options.codexHome
    : (typeof options.resolveCodexHome === "function"
      ? options.resolveCodexHome()
      : resolveCodexHome());
  const archiveDir = path.join(codexHome, ARCHIVE_DIR_NAME);

  let generation = 0;
  let started = false;
  let timer = null;
  let inFlight = null;
  // Cursor into the current directory listing for the rotating sweep. Live
  // candidates are always evaluated first; this only orders non-live work so a
  // directory larger than one batch is covered across polls without starving
  // the tail. It advances by entries examined, so a changing cache size cannot
  // trap it in a subset.
  let cursor = 0;
  // LRU-capped evidence, keyed by file name; indexById is the id -> file name
  // lookup the suppression gate uses. A name without evidence is re-evaluated
  // on the next rotating sweep, so an eviction is never a permanent miss.
  const evidenceByFile = new Map();
  const indexById = new Map();
  // Unchanged failing candidates are not re-read until retryAt; a changed
  // fingerprint (replaced/repaired file) bypasses the backoff immediately.
  const failedByFile = new Map();

  function evictOldest(map, limit, onEvict) {
    while (map.size > limit) {
      const oldestKey = map.keys().next().value;
      const oldestValue = map.get(oldestKey);
      map.delete(oldestKey);
      if (onEvict) onEvict(oldestKey, oldestValue);
    }
  }

  function setEvidence(fileName, evidence) {
    evidenceByFile.delete(fileName);
    evidenceByFile.set(fileName, evidence);
    indexById.set(evidence.id, fileName);
    evictOldest(evidenceByFile, maxEvidenceEntries, (evictedName, evicted) => {
      if (evicted && indexById.get(evicted.id) === evictedName) indexById.delete(evicted.id);
    });
  }

  function clearEvidence(fileName) {
    const existing = evidenceByFile.get(fileName);
    evidenceByFile.delete(fileName);
    if (existing && indexById.get(existing.id) === fileName) indexById.delete(existing.id);
  }

  function setFailure(fileName, fingerprint, retryLevel, retryAt) {
    failedByFile.delete(fileName);
    failedByFile.set(fileName, { fingerprint, retryLevel, retryAt });
    evictOldest(failedByFile, maxFailedEntries);
  }

  function normalizeLiveSet() {
    const live = new Set();
    let candidates = [];
    try {
      candidates = getLiveCandidateIds() || [];
    } catch {
      candidates = [];
    }
    for (const value of candidates) {
      const raw = bareCodexSessionId(value);
      if (raw && CANONICAL_SESSION_ID_RE.test(raw)) live.add(raw);
    }
    return live;
  }

  // stat -> bounded head read -> stat. Returns validated evidence only when a
  // regular file's session_meta declares exactly this canonical id and the
  // pre/post snapshots agree. `preStat` lets callers reuse a stat they already
  // performed.
  async function validateCandidate(fileName, id, preStat = null) {
    const filePath = path.join(archiveDir, fileName);
    let before = preStat;
    if (!before) {
      try {
        before = await statFile(filePath);
      } catch (err) {
        debugLog(`codex-archive stat-unknown file=${fileName} reason=${err && err.code ? err.code : "error"}`);
        return null;
      }
    }
    // lstat + isFile rejects symlinks, directories and other special files.
    if (!isRegularFileStat(before)) return null;
    const beforeSize = statSize(before);
    if (!Number.isFinite(beforeSize) || beforeSize <= 0) return null;

    let firstLine;
    try {
      firstLine = await readFirstLine(filePath);
    } catch {
      return null;
    }
    if (typeof firstLine !== "string" || !firstLine) return null;

    let record;
    try {
      record = JSON.parse(firstLine);
    } catch {
      return null;
    }
    if (!record || record.type !== "session_meta") return null;
    const payload = record.payload;
    if (!payload || typeof payload !== "object") return null;
    // Both id fields may be present. They must agree with each other and with
    // the filename-derived id; a conflict is UNKNOWN, never "one matched".
    const declared = [];
    if (typeof payload.id === "string") declared.push(payload.id);
    if (typeof payload.session_id === "string") declared.push(payload.session_id);
    if (declared.length === 0) return null;
    if (new Set(declared).size !== 1) return null;
    if (declared[0] !== id) return null;

    // Reconcile the read against a fresh snapshot: a file removed, replaced or
    // grown between stat and read is UNKNOWN, so an unarchive that lands mid-
    // scan can never be committed as fresh archive evidence.
    let after;
    try {
      after = await statFile(filePath);
    } catch {
      return null;
    }
    if (!isRegularFileStat(after)) return null;
    const beforeIdentity = statIdentity(before);
    const afterIdentity = statIdentity(after);
    if (beforeIdentity !== null || afterIdentity !== null) {
      if (beforeIdentity !== afterIdentity) return null;
    }
    const afterSize = statSize(after);
    const afterMtime = statMtime(after);
    const beforeMtime = statMtime(before);
    if (!Number.isFinite(afterSize) || afterSize !== beforeSize) return null;
    if (Number.isFinite(afterMtime) && Number.isFinite(beforeMtime) && afterMtime !== beforeMtime) {
      return null;
    }

    return {
      fileName,
      id,
      identity: afterIdentity,
      size: afterSize,
      mtimeMs: afterMtime,
      validatedAt: now(),
    };
  }

  // Current-filesystem check of an already-cached entry. Cheap (one lstat) and
  // used immediately before retirement so an async gap cannot apply stale
  // evidence that an unarchive or replacement invalidated.
  async function currentEvidenceStatus(fileName, evidence) {
    const filePath = path.join(archiveDir, fileName);
    let stat;
    try {
      stat = await statFile(filePath);
    } catch {
      return { status: "missing" };
    }
    if (!isRegularFileStat(stat)) return { status: "missing" };
    const identity = statIdentity(stat);
    if (identity !== null || evidence.identity !== null) {
      if (identity !== evidence.identity) return { status: "changed", stat };
    }
    const size = statSize(stat);
    const mtimeMs = statMtime(stat);
    // Compare mtime even when the inode matches: an in-place same-size rewrite
    // must trigger a full re-validation rather than being trusted from cache.
    if (size !== evidence.size) return { status: "changed", stat };
    if (Number.isFinite(mtimeMs) && Number.isFinite(evidence.mtimeMs) && mtimeMs !== evidence.mtimeMs) {
      return { status: "changed", stat };
    }
    return { status: "stable", stat };
  }

  function buildQueue(names, live) {
    const liveCandidates = [];
    for (const name of names) {
      if (evidenceByFile.has(name)) continue;
      const id = deriveCanonicalSessionId(name);
      if (!id) continue;
      if (live.has(id)) liveCandidates.push({ fileName: name, id });
    }
    const remaining = Math.max(0, validateBatchSize - liveCandidates.length);
    const picked = [];
    const count = names.length;
    if (count > 0 && remaining > 0) {
      const start = cursor % count;
      let examined = 0;
      while (examined < count && picked.length < remaining) {
        const name = names[(start + examined) % count];
        examined += 1;
        if (evidenceByFile.has(name)) continue;
        const id = deriveCanonicalSessionId(name);
        if (!id || live.has(id)) continue;
        picked.push({ fileName: name, id });
      }
      cursor = (start + examined) % count;
    }
    return { queue: liveCandidates.concat(picked) };
  }

  async function runScan(gen) {
    // Never follow a symlinked archive root: the archive tree must be the real
    // CODEX_HOME/archived_sessions directory, not a link to an arbitrary tree.
    let rootStat = null;
    try {
      rootStat = await statFile(archiveDir);
    } catch (err) {
      debugLog(`codex-archive root-unknown dir=${archiveDir} reason=${err && err.code ? err.code : "error"}`);
      return;
    }
    if (gen !== generation) return;
    if (rootStat && isSymlinkStat(rootStat)) {
      debugLog(`codex-archive root-unknown dir=${archiveDir} reason=symlink`);
      return;
    }
    let names;
    try {
      names = await listDirectory(archiveDir);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        names = [];
      } else {
        // Permission / transient I/O failure: keep the previous knowledge
        // rather than declaring everything unarchived.
        debugLog(`codex-archive list-unknown dir=${archiveDir} reason=${err && err.code ? err.code : "error"}`);
        return;
      }
    }
    if (gen !== generation) return;
    const nameList = Array.isArray(names) ? names : [];
    const nameSet = new Set(nameList);

    // A removal is only trusted against a *complete* directory listing (one
    // readdir, not a partial validation batch), so an unscanned entry is never
    // silently declared unarchived.
    for (const fileName of [...evidenceByFile.keys()]) {
      if (nameSet.has(fileName)) continue;
      clearEvidence(fileName);
    }
    for (const fileName of [...failedByFile.keys()]) {
      if (!nameSet.has(fileName)) failedByFile.delete(fileName);
    }

    const live = normalizeLiveSet();
    const { queue } = buildQueue(nameList, live);

    let budget = validateBatchSize;
    for (const item of queue) {
      if (budget <= 0) break;
      if (gen !== generation) return;
      budget -= 1;
      let stat = null;
      try {
        stat = await statFile(path.join(archiveDir, item.fileName));
      } catch (err) {
        debugLog(`codex-archive stat-unknown file=${item.fileName} reason=${err && err.code ? err.code : "error"}`);
        continue;
      }
      if (gen !== generation) return;
      const fingerprint = failureFingerprint(stat);
      const failed = failedByFile.get(item.fileName);
      // Unchanged failing candidates are not re-read until their backoff
      // expires. Live candidates bypass the skip so a wanted retirement is not
      // delayed by a previous transient failure.
      if (
        failed
        && !live.has(item.id)
        && fingerprint
        && failed.fingerprint === fingerprint
        && now() < failed.retryAt
      ) {
        continue;
      }
      const evidence = await validateCandidate(item.fileName, item.id, stat);
      if (gen !== generation) return;
      if (evidence) {
        failedByFile.delete(item.fileName);
        setEvidence(item.fileName, evidence);
        continue;
      }
      if (fingerprint) {
        const retryLevel = Math.min(
          FAILED_RETRY_MAX_LEVEL,
          (failed && failed.fingerprint === fingerprint ? failed.retryLevel : 0) + 1
        );
        const backoffMs = Math.min(
          FAILED_RETRY_MAX_MS,
          FAILED_RETRY_BASE_MS * (2 ** (retryLevel - 1))
        );
        setFailure(item.fileName, fingerprint, retryLevel, now() + backoffMs);
      } else {
        failedByFile.delete(item.fileName);
      }
    }

    // Retire only after re-checking each live candidate's evidence against the
    // current filesystem. This is the point where an unarchive/replacement that
    // happened during the validation awaits above must win over the cache.
    for (const raw of live) {
      if (gen !== generation) return;
      const fileName = indexById.get(raw);
      if (!fileName) continue;
      const cached = evidenceByFile.get(fileName);
      if (!cached) {
        indexById.delete(raw);
        continue;
      }
      const current = await currentEvidenceStatus(fileName, cached);
      if (gen !== generation) return;
      if (current.status === "missing") {
        clearEvidence(fileName);
        continue;
      }
      if (current.status === "changed") {
        const refreshed = await validateCandidate(fileName, raw, current.stat);
        if (gen !== generation) return;
        if (!refreshed) {
          clearEvidence(fileName);
          continue;
        }
        setEvidence(fileName, refreshed);
        onArchiveConfirmed(raw, refreshed);
        continue;
      }
      onArchiveConfirmed(raw, cached);
    }
  }

  function scan() {
    if (inFlight) return inFlight;
    const gen = generation;
    inFlight = (async () => {
      try {
        await runScan(gen);
      } catch (err) {
        debugLog(`codex-archive scan-failed reason=${err && err.message ? err.message : "error"}`);
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function scanNow() {
    const current = inFlight;
    if (current) {
      try { await current; } catch {}
    }
    return scan();
  }

  function start() {
    if (started) return;
    started = true;
    generation += 1;
    cursor = 0;
    try {
      timer = setIntervalFn(() => { scan(); }, pollIntervalMs);
    } catch {
      timer = null;
    }
    if (timer && typeof timer.unref === "function") timer.unref();
    scan();
  }

  function stop() {
    started = false;
    generation += 1;
    if (timer !== null) {
      try { clearIntervalFn(timer); } catch {}
      timer = null;
    }
    evidenceByFile.clear();
    indexById.clear();
    failedByFile.clear();
    cursor = 0;
  }

  function isArchived(rawSessionId) {
    const raw = bareCodexSessionId(rawSessionId);
    if (!raw || !CANONICAL_SESSION_ID_RE.test(raw)) return false;
    return indexById.has(raw);
  }

  function getEvidence(rawSessionId) {
    const raw = bareCodexSessionId(rawSessionId);
    if (!raw || !CANONICAL_SESSION_ID_RE.test(raw)) return null;
    const fileName = indexById.get(raw);
    return fileName ? (evidenceByFile.get(fileName) || null) : null;
  }

  return {
    archiveDir,
    codexHome,
    start,
    stop,
    scan,
    scanNow,
    isArchived,
    getEvidence,
    get started() { return started; },
    get size() { return indexById.size; },
    get failedSize() { return failedByFile.size; },
  };
}

createCodexArchiveTracker.resolveCodexHome = resolveCodexHome;
createCodexArchiveTracker.deriveCanonicalSessionId = deriveCanonicalSessionId;
createCodexArchiveTracker.ARCHIVE_DIR_NAME = ARCHIVE_DIR_NAME;
createCodexArchiveTracker.CANONICAL_SESSION_ID_RE = CANONICAL_SESSION_ID_RE;
createCodexArchiveTracker.DEFAULT_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
createCodexArchiveTracker.DEFAULT_VALIDATE_BATCH_SIZE = DEFAULT_VALIDATE_BATCH_SIZE;
createCodexArchiveTracker.DEFAULT_MAX_EVIDENCE_ENTRIES = DEFAULT_MAX_EVIDENCE_ENTRIES;
createCodexArchiveTracker.DEFAULT_MAX_FAILED_ENTRIES = DEFAULT_MAX_FAILED_ENTRIES;

module.exports = createCodexArchiveTracker;
