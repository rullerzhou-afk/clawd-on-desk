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
// I/O is asynchronous and bounded: each poll lists the archive directory once,
// validates at most `validateBatchSize` not-yet-confirmed files, and retains a
// per-file confirmation cache. A directory larger than one batch drains across
// successive polls instead of blocking a hot path or an arbitrary cap.

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
  const getLiveCandidateIds = typeof options.getLiveCandidateIds === "function"
    ? options.getLiveCandidateIds
    : () => [];
  const onArchiveConfirmed = typeof options.onArchiveConfirmed === "function"
    ? options.onArchiveConfirmed
    : () => {};
  const onArchiveCleared = typeof options.onArchiveCleared === "function"
    ? options.onArchiveCleared
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
  // Confirmed archive evidence, keyed by file name (the validation cache) and
  // by canonical session id (the lookup index). Both are proportional to the
  // on-disk archive directory; the per-poll work is bounded separately.
  const confirmed = new Map();
  const indexById = new Map();
  // Names awaiting validation, drained `validateBatchSize` per poll.
  const pending = [];
  const pendingNames = new Set();

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

  async function validateCandidate(fileName, id) {
    const filePath = path.join(archiveDir, fileName);
    let before;
    try {
      before = await statFile(filePath);
    } catch (err) {
      debugLog(`codex-archive stat-unknown file=${fileName} reason=${err && err.code ? err.code : "error"}`);
      return null;
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
    const declared = [payload.id, payload.session_id].filter((value) => typeof value === "string");
    if (!declared.includes(id)) return null;

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
    const nameSet = new Set(Array.isArray(names) ? names : []);

    // A removal is only trusted against a *complete* directory listing (one
    // readdir, not a partial validation batch), so an unscanned entry is never
    // silently declared unarchived.
    for (const [fileName, entry] of [...confirmed]) {
      if (nameSet.has(fileName)) continue;
      confirmed.delete(fileName);
      if (indexById.get(entry.id) === fileName) indexById.delete(entry.id);
      onArchiveCleared(entry.id);
    }

    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const item = pending[i];
      if (nameSet.has(item.fileName) && !confirmed.has(item.fileName)) continue;
      pendingNames.delete(item.fileName);
      pending.splice(i, 1);
    }

    const live = normalizeLiveSet();
    for (const name of nameSet) {
      if (confirmed.has(name) || pendingNames.has(name)) continue;
      const id = deriveCanonicalSessionId(name);
      if (!id) continue;
      pending.push({ fileName: name, id });
      pendingNames.add(name);
    }
    if (live.size > 0 && pending.length > 1) {
      // Late candidates still drain after live ones, but a live archived
      // session is retired on the earliest poll that reaches it. A stable
      // partition is O(n); a full sort on a very large backlog is not.
      const liveFirst = [];
      const rest = [];
      for (const item of pending) {
        if (live.has(item.id)) liveFirst.push(item);
        else rest.push(item);
      }
      pending.length = 0;
      for (const item of liveFirst) pending.push(item);
      for (const item of rest) pending.push(item);
    }

    let budget = validateBatchSize;
    while (budget > 0 && pending.length > 0) {
      if (gen !== generation) return;
      const item = pending.shift();
      pendingNames.delete(item.fileName);
      budget -= 1;
      const evidence = await validateCandidate(item.fileName, item.id);
      if (gen !== generation) return;
      if (!evidence) continue;
      confirmed.set(item.fileName, evidence);
      indexById.set(item.id, item.fileName);
    }

    if (gen !== generation) return;
    // Idempotent per-poll reconciliation: a session recreated by a late hook
    // after it was first indexed is retired on the next poll. `onArchiveConfirmed`
    // implementations must tolerate a session that is already gone.
    for (const raw of live) {
      const fileName = indexById.get(raw);
      if (!fileName) continue;
      const evidence = confirmed.get(fileName);
      if (evidence) onArchiveConfirmed(raw, evidence);
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
    confirmed.clear();
    indexById.clear();
    pending.length = 0;
    pendingNames.clear();
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
    return fileName ? (confirmed.get(fileName) || null) : null;
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
  };
}

createCodexArchiveTracker.resolveCodexHome = resolveCodexHome;
createCodexArchiveTracker.deriveCanonicalSessionId = deriveCanonicalSessionId;
createCodexArchiveTracker.ARCHIVE_DIR_NAME = ARCHIVE_DIR_NAME;
createCodexArchiveTracker.CANONICAL_SESSION_ID_RE = CANONICAL_SESSION_ID_RE;
createCodexArchiveTracker.DEFAULT_POLL_INTERVAL_MS = DEFAULT_POLL_INTERVAL_MS;
createCodexArchiveTracker.DEFAULT_VALIDATE_BATCH_SIZE = DEFAULT_VALIDATE_BATCH_SIZE;

module.exports = createCodexArchiveTracker;
