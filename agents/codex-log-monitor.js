// Codex CLI JSONL log monitor
// Polls ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl for state changes
// Zero external dependencies (node built-ins + local Codex helpers only)
//
// Replay protection is two layers — change one, consider the other:
//   1. Line-level: _processLine skips entries whose `timestamp` field is
//      older than monitor start. Only helps lines that carry a timestamp.
//   2. File-level: _pollFile sets tracked.backfilling when attaching to a
//      file whose mtime predates monitor start. _processLine then suppresses
//      historical emits until the bounded replay reaches its snapshot EOF, then
//      _emitBackfillSnapshot may synthesize ONE current sustained state
//      (thinking / working). Works for any line shape,
//      covers what layer 1 can't.
// The two overlap but don't duplicate each other — collapsing them takes a
// refactor, not a tweak.

const fs = require("fs");
const path = require("path");
const os = require("os");
const CodexSubagentClassifier = require("./codex-subagent-classifier");
const { readCodexThreadName } = require("../hooks/codex-session-index");
const {
  clampAssistantOutputText,
  extractAssistantTextFromRecord,
} = require("../hooks/codex-assistant-output");
const {
  resolveCodexRateLimitReport,
  resolveCodexModelQuotaProvider,
  isFreshCodexQuotaTimestamp,
} = require("../hooks/codex-rate-limits");
const { parseCodexUserInputRecord } = require("../hooks/codex-user-input");
const { normalizeCodexTurnId } = require("../src/codex-turn-id");

const MAX_TRACKED_FILES = 50;
const MAX_RETIRED_TRACKED_FILES = 100;
const MAX_PARTIAL_BYTES = 65536;
const MAX_POLL_READ_BYTES = 4 * 1024 * 1024;
const MAX_POLL_TOTAL_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_POLL_FILE_ATTEMPTS = 64;
const MAX_ACTIVE_DIR_DISCOVERY_ATTEMPTS_PER_POLL = 16;
const MAX_STARTUP_RECOVERY_DISCOVERY_OPERATIONS_PER_POLL = 16;
const MAX_REPLAY_WORK_ITEMS = 40;
const MAX_BACKGROUND_REPLAY_WORK_ITEMS = 32;
const MAX_DEFERRED_RECENT_PATHS = 192;
const MAX_DEFERRED_BACKGROUND_PATHS = 64;
const MAX_REPLAY_NO_PROGRESS_ATTEMPTS = 8;
const REPLAY_NO_PROGRESS_TIMEOUT_MS = 30 * 1000;
const REPLAY_RETRY_BASE_BACKOFF_MS = 30 * 1000;
const REPLAY_RETRY_MAX_BACKOFF_MS = 5 * 60 * 1000;
const RECOVERY_MAX_READ_ATTEMPTS = 8;
const RECENT_DAY_DIR_CACHE_MS = 60 * 60 * 1000; // 1 hour
// A rollout file is considered "active" if written within this window. Used by
// both the untracked-file pickup gate in _poll and the _getActiveDayDirs scan
// so slow Codex desktop sessions (3–5 min write cadence) aren't dropped by one
// path only to be rescued by the other.
const ACTIVE_SESSION_WINDOW_MS = 5 * 60 * 1000;
// Grace window around monitor start. A file with content whose last write
// predates this window is treated as pre-existing history on attach — we
// replay it silently (backfill) instead of emitting stale transitions. A
// file written within the grace window is a live session and emits normally.
const BACKFILL_GRACE_MS = 5 * 1000;
// States that are ongoing rather than one-shot. Safe to re-synthesize from a
// backfill snapshot, and safe for a metadata-only token_count write to carry
// forward. A one-shot (attention, sweeping, …) must never be carried by
// either: re-emitting it replays a finished turn's celebration.
const SUSTAINED_ACTIVE_STATES = new Set(["thinking", "working"]);
// Startup recovery sweep bounds (see _recoverStalePendingUserInput). These
// exist to keep the sweep a bounded, one-time cost — never a full readFileSync
// of an arbitrarily large rollout file on the Electron main process.
// session_meta (cwd / subagent role) is always Codex's first record, but a
// real one can run past 30KB (long cwd, many tools, etc.) — this must be the
// full line or nothing, never a size guess: a truncated read makes
// JSON.parse fail, which silently defaults a subagent to "root" and shows it
// a card it should never get. An unresolved request_user_input is always
// near the end, since Codex stops writing once it's blocked on an answer.
const RECOVERY_HEAD_LINE_MAX_BYTES = 256 * 1024;
const RECOVERY_TAIL_SCAN_BYTES = 1024 * 1024;
// A file this old is treated as abandoned, not "still waiting" — without this
// cap, a session that was killed/crashed with an unanswered question would
// resurrect the exact same ghost card on every single future restart,
// forever, since nothing else ever clears a card with no live process behind
// it. This bounds the damage; it does not fully solve it (see known
// limitations in the PR fix report). Checked against BOTH the file's mtime
// (cheap pre-filter, skips ancient files before any read) and the request's
// own embedded timestamp once found (authoritative — Codex Desktop can
// refresh a dormant file's mtime on focus without the pending question
// itself getting any newer, so mtime alone would under-count a ghost's age).
const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Total budget for one startup sweep, across ALL stale candidate files —
// each file's own read is already bounded, but an unbounded NUMBER of
// candidates still adds up to unbounded main-process blocking. Prioritized
// by most-recently-modified first, since a genuinely still-open question is
// far more likely to be sitting in a recently-touched file than an ancient
// one.
const RECOVERY_SWEEP_MAX_FILES = 20;
const RECOVERY_SWEEP_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function recoveryReadBudgetCost(size) {
  const safeSize = Number.isFinite(Number(size)) ? Math.max(0, Number(size)) : 0;
  // Recovery reads the head and tail independently. They overlap for small
  // files, so min(size, head + tail) under-counts the actual synchronous I/O.
  return Math.min(safeSize, RECOVERY_HEAD_LINE_MAX_BYTES)
    + Math.min(safeSize, RECOVERY_TAIL_SCAN_BYTES)
    + (safeSize > RECOVERY_TAIL_SCAN_BYTES ? 1 : 0);
}

function finiteNonnegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractCodexContextUsage(payload) {
  if (!payload || typeof payload !== "object") return null;
  const info = payload.info && typeof payload.info === "object" ? payload.info : null;
  const lastUsage = info && info.last_token_usage && typeof info.last_token_usage === "object"
    ? info.last_token_usage
    : null;
  const used = finiteNonnegativeNumber(
    (lastUsage && lastUsage.total_tokens)
    ?? payload.total_tokens
    ?? payload.tokens_used
    ?? payload.input_tokens
    ?? payload.context_tokens
  );
  if (used === null) return null;

  const limit = positiveNumber(
    (info && info.model_context_window)
    ?? payload.model_context_window
    ?? payload.context_window
    ?? payload.limit
    ?? payload.max_tokens
  );
  const out = { used, source: "codex" };
  if (limit !== null) {
    out.limit = limit;
    out.percent = Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
  }
  return out;
}

class CodexLogMonitor {
  /**
   * @param {object} agentConfig - codex.js config (logConfig + logEventMap)
   * @param {function} onStateChange - (sessionId, state, event, extra) => void
   * @param {object} options
   */
  constructor(agentConfig, onStateChange, options = {}) {
    this._config = agentConfig;
    this._onStateChange = onStateChange;
    this._classifier = options.classifier || new CodexSubagentClassifier();
    this._onUserInputRequest = typeof options.onUserInputRequest === "function"
      ? options.onUserInputRequest
      : null;
    this._onUserInputResolved = typeof options.onUserInputResolved === "function"
      ? options.onUserInputResolved
      : null;
    this._interval = null;
    // Map<filePath, { offset, sessionId, cwd, lastEventTime, lastState }>
    // offset is the byte immediately after the last committed newline. An
    // incomplete tail stays on disk and is reread after tracker eviction.
    this._tracked = new Map();
    this._retiredTracked = new Map();
    // Lightweight, process-lifetime tail positions outlive both rich tracker
    // LRUs. A long-running monitor may see more than their combined capacity;
    // forgetting the byte offset would replay that rollout when it next grows.
    this._readPositions = new Map();
    this._replayWork = new Map();
    this._deferredRecent = new Map();
    this._deferredBackground = new Map();
    this._pollCursor = 0;
    this._activeDayWalker = null;
    this._startupRecoveryCandidates = new Map();
    this._startupRecoveryWalker = null;
    this._startupRecoveryReady = false;
    this._startupRecoveryFilesScanned = 0;
    this._startupRecoveryBytesScanned = 0;
    this._baseDir = this._resolveBaseDir();
    this._codexDir = options.codexDir || null;
    this._recentDayDirsCache = [];
    this._recentDayDirsCacheAt = 0;
    this._recentDayDirsDateKey = "";
    this._activeDayDirsCache = null;
    this._activeDayDirsCacheAt = 0;
    this._startedAtMs = Date.now();
    // One-shot startup recovery can span bounded poll slices while its
    // directory/path cursor looks for a still-unresolved request_user_input
    // outside ACTIVE_SESSION_WINDOW_MS. Once that pass completes, later polls
    // revert to the cheap mtime-only gate.
    this._didInitialRecoveryScan = false;
  }

  _resolveBaseDir() {
    const dir = this._config.logConfig.sessionDir;
    if (dir.startsWith("~")) {
      return path.join(os.homedir(), dir.slice(1));
    }
    return dir;
  }

  start() {
    if (this._interval) return;
    this._startedAtMs = Date.now();
    // The agent gate can stop() then start() the SAME instance (disable →
    // re-enable within one Clawd process run) — each real start() must get
    // its own recovery sweep, not just the very first one this instance ever
    // saw.
    this._didInitialRecoveryScan = false;
    this._startupRecoveryCandidates.clear();
    this._startupRecoveryWalker = null;
    this._startupRecoveryReady = false;
    this._startupRecoveryFilesScanned = 0;
    this._startupRecoveryBytesScanned = 0;
    this._activeDayWalker = null;
    this._pollCursor = 0;
    // Initial scan
    this._poll();
    this._interval = setInterval(
      () => this._poll(),
      this._config.logConfig.pollIntervalMs || 1500
    );
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._tracked.clear();
    this._retiredTracked.clear();
    this._readPositions.clear();
    this._replayWork.clear();
    this._deferredRecent.clear();
    this._deferredBackground.clear();
    this._activeDayWalker = null;
    this._pollCursor = 0;
    this._startupRecoveryCandidates.clear();
    this._startupRecoveryWalker = null;
    this._startupRecoveryReady = false;
    this._startupRecoveryFilesScanned = 0;
    this._startupRecoveryBytesScanned = 0;
  }

  _poll() {
    const context = {
      remainingAttempts: MAX_POLL_FILE_ATTEMPTS,
      remainingRequestBytes: MAX_POLL_TOTAL_REQUEST_BYTES,
    };
    const dirs = this._getSessionDirs(context);
    const startupObserved = !this._didInitialRecoveryScan
      && !this._startupRecoveryReady
      && !this._activeDayWalker
      ? this._walkStartupRecoveryDiscovery(dirs, context)
      : new Map();
    if (this._startupRecoveryReady && !this._didInitialRecoveryScan) {
      this._runReadyStartupRecovery(context);
    }

    const candidates = [];
    for (const deferred of this._collectDueDeferredCandidates()) {
      candidates.push({ ...deferred, source: "deferred" });
    }
    for (const item of this._replayWork.values()) {
      candidates.push({ filePath: item.filePath, fileName: item.fileName, source: "replay" });
    }
    for (const dir of dirs) {
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
        const filePath = path.join(dir, file);
        candidates.push({ filePath, fileName: file, source: "normal" });
      }
    }

    const unique = [];
    const seen = new Set();
    for (const candidate of candidates) {
      if (!candidate.filePath || seen.has(candidate.filePath)) continue;
      seen.add(candidate.filePath);
      unique.push(candidate);
    }
    if (unique.length > 0) {
      const start = this._pollCursor % unique.length;
      const ordered = unique.slice(start).concat(unique.slice(0, start));
      let processed = 0;
      for (const candidate of ordered) {
        if (context.remainingAttempts <= 0) break;
        const deferred = this._deferredRecent.get(candidate.filePath)
          || this._deferredBackground.get(candidate.filePath);
        if (deferred && Date.now() < deferred.notBefore) {
          processed += 1;
          continue;
        }
        const observedByStartup = startupObserved.has(candidate.filePath);
        let stat = observedByStartup ? startupObserved.get(candidate.filePath) : null;
        if (!observedByStartup) {
          context.remainingAttempts -= 1;
          try {
            stat = fs.statSync(candidate.filePath);
          } catch {
            stat = null;
          }
        }
        if (!stat) {
          if (deferred) {
            this._backoffDeferredStatFailure(deferred);
          } else {
            this._markReplayNoProgress(candidate.filePath, this._tracked.get(candidate.filePath));
          }
          processed += 1;
          continue;
        }
        if (
          candidate.source === "normal"
          && !this._tracked.has(candidate.filePath)
          && Date.now() - stat.mtimeMs > ACTIVE_SESSION_WINDOW_MS
        ) {
          processed += 1;
          continue;
        }
        const result = this._pollFile(candidate.filePath, candidate.fileName, {
          preStat: stat,
          get remainingRequestBytes() { return context.remainingRequestBytes; },
          set remainingRequestBytes(value) { context.remainingRequestBytes = value; },
        });
        if (result && result.kind === "budget") break;
        processed += 1;
      }
      this._pollCursor = (start + Math.max(1, processed)) % unique.length;
    }

    if (this._startupRecoveryReady && !this._didInitialRecoveryScan && context.remainingAttempts > 0) {
      this._runReadyStartupRecovery(context);
    }
    this._pruneTrackedFilesIfNeeded();
  }

  _insertStartupRecoveryCandidate(candidate) {
    this._startupRecoveryCandidates.set(candidate.filePath, candidate);
    if (this._startupRecoveryCandidates.size <= RECOVERY_SWEEP_MAX_FILES) return;
    let oldestPath = null;
    let oldestMtime = Infinity;
    for (const [filePath, entry] of this._startupRecoveryCandidates) {
      if (entry.mtimeMs < oldestMtime) {
        oldestMtime = entry.mtimeMs;
        oldestPath = filePath;
      }
    }
    if (oldestPath) this._startupRecoveryCandidates.delete(oldestPath);
  }

  _walkStartupRecoveryDiscovery(dirs, context) {
    if (!this._startupRecoveryWalker) {
      this._startupRecoveryWalker = {
        dirs: [...dirs],
        dirIndex: 0,
        files: null,
        fileIndex: 0,
      };
    }
    const walker = this._startupRecoveryWalker;
    const observed = new Map();
    let operations = 0;
    while (
      walker.dirIndex < walker.dirs.length
      && operations < MAX_STARTUP_RECOVERY_DISCOVERY_OPERATIONS_PER_POLL
      && context.remainingAttempts > 0
    ) {
      const dir = walker.dirs[walker.dirIndex];
      if (!walker.files) {
        operations += 1;
        try {
          walker.files = fs.readdirSync(dir)
            .filter((file) => file.startsWith("rollout-") && file.endsWith(".jsonl"));
        } catch {
          walker.files = [];
        }
        walker.fileIndex = 0;
      }
      if (walker.fileIndex >= walker.files.length) {
        walker.dirIndex += 1;
        walker.files = null;
        walker.fileIndex = 0;
        continue;
      }
      const file = walker.files[walker.fileIndex];
      walker.fileIndex += 1;
      operations += 1;
      context.remainingAttempts -= 1;
      const filePath = path.join(dir, file);
      let stat = null;
      try {
        stat = fs.statSync(filePath);
      } catch {}
      observed.set(filePath, stat);
      const deferred = this._deferredRecent.get(filePath)
        || this._deferredBackground.get(filePath);
      if (
        stat
        && !this._tracked.has(filePath)
        && !(deferred && Date.now() < deferred.notBefore)
        && Date.now() - stat.mtimeMs > ACTIVE_SESSION_WINDOW_MS
      ) {
        this._insertStartupRecoveryCandidate({
          filePath,
          file,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      }
    }
    if (walker.dirIndex >= walker.dirs.length) {
      this._startupRecoveryWalker = null;
      this._startupRecoveryReady = true;
    }
    return observed;
  }

  _runReadyStartupRecovery(context) {
    const candidates = [...this._startupRecoveryCandidates.values()]
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    let pausedForAttempts = false;
    for (const candidate of candidates) {
      if (this._startupRecoveryFilesScanned >= RECOVERY_SWEEP_MAX_FILES) break;
      if (context.remainingAttempts <= 0) {
        pausedForAttempts = true;
        break;
      }
      context.remainingAttempts -= 1;
      const deferred = this._deferredRecent.get(candidate.filePath)
        || this._deferredBackground.get(candidate.filePath);
      let stat = null;
      try {
        stat = fs.statSync(candidate.filePath);
      } catch {}
      // Discovery and recovery can span polls. The normal poller may have
      // attached this path (or deferred it) in between; consuming the cached
      // candidate would duplicate pending notifications and overwrite the
      // authoritative live tracker.
      if (
        !stat
        || this._tracked.has(candidate.filePath)
        || this._replayWork.has(candidate.filePath)
        || deferred
        || Date.now() - stat.mtimeMs <= ACTIVE_SESSION_WINDOW_MS
      ) {
        this._startupRecoveryCandidates.delete(candidate.filePath);
        continue;
      }
      const candidateCost = recoveryReadBudgetCost(stat.size);
      if (
        this._startupRecoveryBytesScanned + candidateCost
        > RECOVERY_SWEEP_MAX_TOTAL_BYTES
      ) break;
      this._startupRecoveryFilesScanned += 1;
      this._startupRecoveryBytesScanned += candidateCost;
      const recovered = this._recoverStalePendingUserInput(
        candidate.filePath,
        candidate.file,
        stat,
        { deferSideEffects: true }
      );
      let postStat = null;
      try {
        postStat = fs.statSync(candidate.filePath);
      } catch {}
      const snapshotStatus = this._recoverySnapshotStatus(stat, postStat);
      if (snapshotStatus === "missing") {
        this._startupRecoveryCandidates.delete(candidate.filePath);
        continue;
      }
      if (snapshotStatus === "changed") {
        pausedForAttempts = true;
        continue;
      }
      if (recovered) {
        this._finalizeRecoveredTracker(recovered);
        this._tracked.set(candidate.filePath, recovered);
        this._readPositions.set(candidate.filePath, {
          offset: recovered.offset,
          identity: recovered.fileIdentity,
        });
        this._emitPendingUserInputRequests(recovered);
      } else if (snapshotStatus === "grew") {
        // Keep this old-mtime candidate for a later bounded slice. Normal
        // polling deliberately skips untracked old files, so consuming it
        // here would lose an append whose LastWriteTime stayed frozen on
        // Windows. The next slice admits the larger snapshot under the same
        // cumulative file/byte caps instead of expanding this read in-place.
        pausedForAttempts = true;
        continue;
      }
      // Recovery shares the poll-wide attempt budget. Remove completed work so
      // a later poll resumes at the next candidate instead of re-emitting the
      // same pending request when the first poll ran out of attempts.
      this._startupRecoveryCandidates.delete(candidate.filePath);
    }
    if (pausedForAttempts) return;
    this._didInitialRecoveryScan = true;
    this._startupRecoveryReady = false;
    this._startupRecoveryCandidates.clear();
    this._startupRecoveryWalker = null;
    this._startupRecoveryFilesScanned = 0;
    this._startupRecoveryBytesScanned = 0;
  }

  _collectDueDeferredCandidates() {
    const out = [];
    const now = Date.now();
    const recent = [...this._deferredRecent.values()]
      .filter((entry) => !Number.isFinite(entry.notBefore) || entry.notBefore <= now);
    const background = [...this._deferredBackground.values()]
      .filter((entry) => !Number.isFinite(entry.notBefore) || entry.notBefore <= now);
    let recentIndex = 0;
    let backgroundIndex = 0;
    while (
      out.length < MAX_REPLAY_WORK_ITEMS
      && (recentIndex < recent.length || backgroundIndex < background.length)
    ) {
      for (let i = 0; i < 3 && recentIndex < recent.length; i += 1) {
        out.push(recent[recentIndex]);
        recentIndex += 1;
      }
      if (backgroundIndex < background.length) {
        out.push(background[backgroundIndex]);
        backgroundIndex += 1;
      } else if (recentIndex >= recent.length) {
        break;
      }
    }
    return out;
  }

  _runRecoverySweep(candidates) {
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let filesScanned = 0;
    let bytesScanned = 0;
    for (const candidate of candidates) {
      if (filesScanned >= RECOVERY_SWEEP_MAX_FILES) break;
      let stat;
      try {
        stat = fs.statSync(candidate.filePath);
      } catch {
        continue;
      }
      const candidateCost = recoveryReadBudgetCost(stat.size);
      // Check BEFORE adding — accumulating post-hoc lets exactly one
      // over-budget candidate slip through every time the running total
      // lands just under the cap (#707 follow-up review round 4).
      if (bytesScanned + candidateCost > RECOVERY_SWEEP_MAX_TOTAL_BYTES) break;
      filesScanned += 1;
      bytesScanned += candidateCost;
      const recovered = this._recoverStalePendingUserInput(
        candidate.filePath,
        candidate.file,
        stat,
        { deferSideEffects: true }
      );
      let postStat = null;
      try {
        postStat = fs.statSync(candidate.filePath);
      } catch {}
      const snapshotStatus = this._recoverySnapshotStatus(stat, postStat);
      if (snapshotStatus === "missing" || snapshotStatus === "changed") continue;
      if (recovered) {
        this._finalizeRecoveredTracker(recovered);
        this._tracked.set(candidate.filePath, recovered);
        // Bypasses _pollFile's normal new-tracker construction, which is
        // where the ledger is otherwise seeded — without this, evicting this
        // tracker later has no read position to resume from and a reattach
        // falls back to a full replay (defeats #700's own fix).
        this._readPositions.set(candidate.filePath, {
          offset: recovered.offset,
          identity: recovered.fileIdentity,
        });
        this._emitPendingUserInputRequests(recovered);
      }
    }
  }

  // Returns { text, bytesRead, buf }. bytesRead is the TRUE byte count read
  // from disk — callers doing offset math must use it (or `buf`, already
  // sliced to that length), not Buffer.byteLength(text): if `start` lands
  // mid-character in a multi-byte UTF-8 sequence (any non-ASCII content —
  // CJK cwd/output is common), decoding replaces the truncated leading bytes
  // with U+FFFD, whose own UTF-8 length does not equal the raw bytes it
  // replaced. Re-deriving the byte count from the decoded string can
  // overshoot the file's true size, and an offset past real EOF either
  // silently skips the next genuine write forever or gets misread elsewhere
  // as a truncated/rotated file and triggers a full replay from 0 — the
  // exact unbounded read this sweep exists to avoid. `buf` exists for the
  // same reason: a byte-precise search (e.g. the last newline) must run
  // against raw bytes, never against a string that may contain replacement
  // characters.
  _readByteRange(filePath, start, length) {
    if (length <= 0) return { text: "", bytesRead: 0, buf: Buffer.alloc(0) };
    let fd;
    try {
      fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buf, 0, length, start);
      return { text: buf.toString("utf8", 0, bytesRead), bytesRead, buf: buf.subarray(0, bytesRead) };
    } catch {
      return { text: "", bytesRead: 0, buf: Buffer.alloc(0) };
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  }

  // Grows the read window from byte 0 until it captures a complete
  // (newline-terminated) first line, up to maxBytes. Never returns a line
  // that might have been truncated by an arbitrary window cutoff — a fixed
  // small read guessing "session_meta always fits in N KB" is exactly how a
  // subagent's role silently defaults to "root" (JSON.parse throws on the
  // truncated fragment, the caller sees no session_meta at all, and the safe
  // default becomes indistinguishable from "there was none"). Returns null
  // if no newline is found within budget — the caller must fail closed, not
  // guess a role.
  _readCompleteFirstLine(filePath, statSize, maxBytes) {
    let readSoFar = 0;
    let requestedTotal = 0;
    const requestBudget = Math.min(statSize, maxBytes);
    let attempts = 0;
    const chunks = [];
    const requestQuantum = Math.max(1, Math.ceil(requestBudget / RECOVERY_MAX_READ_ATTEMPTS));
    while (requestedTotal < requestBudget && attempts < RECOVERY_MAX_READ_ATTEMPTS) {
      const requestLength = Math.min(requestQuantum, requestBudget - requestedTotal);
      attempts += 1;
      requestedTotal += requestLength;
      const { bytesRead, buf } = this._readByteRange(filePath, readSoFar, requestLength);
      if (!Number.isFinite(bytesRead) || bytesRead <= 0) return null;
      chunks.push(buf);
      readSoFar += bytesRead;
      const raw = Buffer.concat(chunks, readSoFar);
      const newlineIdx = raw.indexOf(0x0a);
      if (newlineIdx !== -1) return raw.subarray(0, newlineIdx).toString("utf8");
    }
    return null;
  }

  _readExactRange(filePath, start, length) {
    if (length <= 0) return { buf: Buffer.alloc(0), complete: true };
    const chunks = [];
    let bytesReadTotal = 0;
    let requestedTotal = 0;
    let attempts = 0;
    const requestQuantum = Math.max(1, Math.ceil(length / RECOVERY_MAX_READ_ATTEMPTS));
    while (bytesReadTotal < length && attempts < RECOVERY_MAX_READ_ATTEMPTS) {
      const requestLength = Math.min(
        length - bytesReadTotal,
        length - requestedTotal,
        requestQuantum
      );
      if (requestLength <= 0) break;
      attempts += 1;
      requestedTotal += requestLength;
      const result = this._readByteRange(
        filePath,
        start + bytesReadTotal,
        requestLength
      );
      if (!result || !Number.isFinite(result.bytesRead) || result.bytesRead <= 0) break;
      chunks.push(result.buf);
      bytesReadTotal += result.bytesRead;
    }
    return {
      buf: Buffer.concat(chunks, bytesReadTotal),
      complete: bytesReadTotal === length,
    };
  }

  // Bounded, standalone pass over an otherwise-ignored old-mtime file. Used
  // only by _runRecoverySweep and never reads more than a fixed head+tail
  // window, regardless of file size. It recovers either a genuinely pending
  // request or a file whose embedded timestamps prove it is still active.
  // The latter matters on Windows: LastWriteTime can remain frozen while
  // Codex keeps an append handle open, so an app restart would otherwise
  // skip the current long-running conversation until the handle closes.
  //
  // A request is "still pending" only up to the next task_complete/
  // turn_aborted for this file — those end the turn that asked, so any
  // earlier open request is moot even without a matching function_call_output
  // (Codex killed mid-turn, terminal closed, etc. leave exactly this shape).
  _recoverStalePendingUserInput(filePath, fileName, recoveryStat = null, options = {}) {
    let stat = recoveryStat;
    if (!stat) {
      try {
        stat = fs.statSync(filePath);
      } catch {
        return null;
      }
    }
    if (stat.size === 0) return null;
    const nowMs = Date.now();
    const tooOldForPendingRecovery = nowMs - stat.mtimeMs > RECOVERY_MAX_AGE_MS;
    const sessionId = this._extractSessionId(fileName);
    if (!sessionId) return null;

    // Head: session_meta (cwd + subagent role) is always Codex's first
    // record. Fail closed (skip this file entirely) if we can't read a
    // complete first line or it isn't session_meta — showing a card is the
    // wrong default when we genuinely don't know whether this is a
    // subagent.
    const firstLine = this._readCompleteFirstLine(filePath, stat.size, RECOVERY_HEAD_LINE_MAX_BYTES);
    if (!firstLine) return null;
    let sessionMeta;
    try {
      sessionMeta = JSON.parse(firstLine);
    } catch {
      return null;
    }
    if (sessionMeta.type !== "session_meta" || !sessionMeta.payload || typeof sessionMeta.payload !== "object") {
      return null;
    }
    const cwd = sessionMeta.payload.cwd || "";
    // classifySessionMeta legitimately returns "unknown" for a normal root
    // session — most session_meta records carry no explicit "I am root"
    // marker; being root IS the absence of subagent markers. That's not a
    // truncation artifact once firstLine is a genuinely complete line (the
    // fail-closed protection above), so it must not be rejected here too —
    // only "subagent" flips isSubagent, exactly like the live _applySessionMeta
    // path treats an unclassifiable role as unchanged-from-default (false).
    // Tail: an unresolved request_user_input, if any, is near the end —
    // Codex stops writing once it's blocked waiting for an answer.
    const tailLen = Math.min(stat.size, RECOVERY_TAIL_SCAN_BYTES);
    const tailStart = stat.size - tailLen;
    // A non-zero tailStart is not necessarily mid-line: it can land exactly
    // on the first byte after a newline. Inspect the preceding raw byte so a
    // valid request at that exact 1 MiB boundary is not discarded below.
    const preceding = tailStart === 0
      ? { buf: Buffer.from([0x0a]), complete: true }
      : this._readExactRange(filePath, tailStart - 1, 1);
    if (!preceding.complete) return null;
    const tailStartsOnRecordBoundary = tailStart === 0 || preceding.buf[0] === 0x0a;
    const tailRead = this._readExactRange(filePath, tailStart, tailLen);
    if (!tailRead.complete) return null;
    let readPostStat = null;
    try {
      readPostStat = fs.statSync(filePath);
    } catch {}
    const readSnapshotStatus = this._recoverySnapshotStatus(stat, readPostStat);
    if (readSnapshotStatus === "missing" || readSnapshotStatus === "changed") return null;
    const tailBuf = tailRead.buf;
    // Find the last complete (newline-terminated) record in RAW BYTE space —
    // 0x0A can never appear inside a multi-byte UTF-8 sequence, so this index
    // is exact even when the window start cuts a leading character in half
    // and decoding replaces it with U+FFFD (see _readByteRange). Everything
    // after this index is a genuinely incomplete final line; it is left on
    // disk rather than buffered as `partial`, mirroring _pollFile's own
    // newline-commit convention so a normal poll rereads it whole once it
    // completes.
    const lastNewlineInTail = tailBuf.lastIndexOf(0x0a);
    if (lastNewlineInTail < 0) return null; // no complete record anywhere in the scan window
    const committedTailBytes = lastNewlineInTail + 1;
    const tailText = tailBuf.toString("utf8", 0, committedTailBytes);
    const rawLines = tailText.split("\n");
    rawLines.pop(); // trailing "" — tailText always ends in the newline we just found
    // Drop the first fragment only when the preceding byte proves the window
    // really started mid-line. At an exact newline boundary, the first line
    // is a complete record and must be retained.
    if (!tailStartsOnRecordBoundary) rawLines.shift();

    const pending = new Map();
    const pendingTimestampMs = new Map();
    let latestEmbeddedTimestampMs = null;
    for (const line of rawLines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const embeddedTimestampMs = typeof obj.timestamp === "string"
        ? Date.parse(obj.timestamp)
        : NaN;
      if (Number.isFinite(embeddedTimestampMs)) {
        latestEmbeddedTimestampMs = latestEmbeddedTimestampMs === null
          ? embeddedTimestampMs
          : Math.max(latestEmbeddedTimestampMs, embeddedTimestampMs);
      }
      const payload = obj && typeof obj === "object" ? obj.payload : null;
      const subtype = payload && typeof payload === "object" ? payload.type || "" : "";
      const key = subtype ? obj.type + ":" + subtype : obj.type;
      if (key === "event_msg:task_complete" || key === "event_msg:turn_aborted") {
        pending.clear();
        pendingTimestampMs.clear();
        continue;
      }
      const record = parseCodexUserInputRecord(obj);
      if (!record) continue;
      if (record.phase === "request") {
        pending.set(record.callId, record);
        const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
        pendingTimestampMs.set(record.callId, Number.isFinite(ts) ? ts : null);
      } else {
        pending.delete(record.callId);
        pendingTimestampMs.delete(record.callId);
      }
    }
    const recentlyActive = latestEmbeddedTimestampMs !== null
      && latestEmbeddedTimestampMs >= nowMs - ACTIVE_SESSION_WINDOW_MS
      && latestEmbeddedTimestampMs <= nowMs + ACTIVE_SESSION_WINDOW_MS;

    // mtime alone isn't a reliable age signal — Codex Desktop can refresh a
    // dormant file's mtime (e.g. on focus) without the pending question
    // itself getting any newer. Cross-check against the oldest request's own
    // timestamp where we have one; a stale question must not survive just
    // because something else touched the file.
    const knownTimestamps = [...pendingTimestampMs.values()].filter((ts) => ts !== null);
    if (knownTimestamps.length > 0 && nowMs - Math.min(...knownTimestamps) > RECOVERY_MAX_AGE_MS) {
      pending.clear();
      pendingTimestampMs.clear();
    }
    if (!recentlyActive && (pending.size === 0 || tooOldForPendingRecovery)) return null;

    const deferSideEffects = options.deferSideEffects === true;
    const recovered = {
      // Stops at the last complete newline, not true EOF — matches
      // _pollFile's own offset convention. A still-growing final line is
      // simply left on disk and reread whole by the next normal poll,
      // instead of needing a separately tracked `partial` fragment here.
      offset: tailStart + committedTailBytes,
      sessionId: "codex:" + sessionId,
      filePath,
      // _pollFile's reattach path compares tracked.fileIdentity against a
      // freshly computed value on every poll; leaving this unset here would
      // read as "identity changed" (undefined !== null) on the very next
      // poll and silently reset the offset to EOF, dropping whatever landed
      // between recovery and that poll.
      fileIdentity: this._getFileIdentity(stat),
      cwd,
      sessionTitle: null,
      codexOriginator: null,
      codexSource: null,
      codexQuotaProviderHint: null,
      lastEventTime: nowMs,
      lastState: recentlyActive ? null : "notification",
      lastStateEvent: null,
      // We're about to emit (or would, if not a subagent) — bookkeeping must
      // reflect that now, not stay at "never emitted" defaults, or this
      // entry becomes a first-priority eviction candidate under
      // MAX_TRACKED_FILES pressure despite genuinely being live.
      hasEmittedState: !recentlyActive,
      hadToolUse: false,
      // Classification is applied exactly once after reconstruction. The
      // deferred production caller waits for post-read snapshot validation;
      // direct callers follow the same one-path rule immediately. For recent
      // recovery, the tail's session_meta performs it when the tail includes
      // the head; otherwise the separately-read head does. Stale pending
      // recovery always uses the separately-read head.
      isSubagent: false,
      agentPid: null,
      assistantLastOutput: null,
      assistantLastOutputTruncated: false,
      contextUsage: null,
      activeTurnId: null,
      turnBoundaryOpen: false,
      codexQuota: null,
      codexSparkQuota: null,
      pendingUserInputs: recentlyActive ? new Map() : pending,
      initializingUserInputs: recentlyActive,
      backfilling: recentlyActive,
    };
    if (deferSideEffects) {
      recovered._recoverySessionMeta = sessionMeta.payload;
      if (recentlyActive) {
        recovered._recoveryRawLines = rawLines;
        recovered._recoveryTailIncludesHead = tailStart === 0;
      }
      return recovered;
    }
    if (!recentlyActive) {
      this._applySessionMeta(sessionMeta.payload, recovered);
      return recovered;
    }

    // Reconstruct only the bounded tail in backfill mode. Historical
    // lifecycle events stay silent, while fresh token_count captures seed
    // the session-independent quota store. Head metadata was read separately
    // above so subagent/cwd classification does not depend on the tail window.
    if (tailStart !== 0) this._applySessionMeta(sessionMeta.payload, recovered);
    for (const line of rawLines) {
      if (!line.trim()) continue;
      this._processLine(line, recovered);
    }
    this._emitBackfillSnapshot(recovered);
    recovered.backfilling = false;
    recovered.initializingUserInputs = false;
    return recovered;
  }

  _recoverySnapshotStatus(before, after) {
    if (!after) return "missing";
    const beforeIdentity = this._getFileIdentity(before);
    const afterIdentity = this._getFileIdentity(after);
    if (beforeIdentity !== null || afterIdentity !== null) {
      if (beforeIdentity !== afterIdentity) return "changed";
    } else if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      // Without an identity we cannot prove that a changed path still names
      // the file whose head/tail were read.
      return "changed";
    }
    if (after.size < before.size) return "changed";
    if (after.size > before.size) return "grew";
    if (after.mtimeMs !== before.mtimeMs) return "changed";
    return "stable";
  }

  _finalizeRecoveredTracker(recovered) {
    const sessionMeta = recovered._recoverySessionMeta;
    const rawLines = recovered._recoveryRawLines;
    const tailIncludesHead = recovered._recoveryTailIncludesHead === true;
    delete recovered._recoverySessionMeta;
    delete recovered._recoveryRawLines;
    delete recovered._recoveryTailIncludesHead;
    if (!Array.isArray(rawLines)) {
      this._applySessionMeta(sessionMeta, recovered);
      return;
    }
    if (!tailIncludesHead) this._applySessionMeta(sessionMeta, recovered);
    for (const line of rawLines) {
      if (!line.trim()) continue;
      this._processLine(line, recovered);
    }
    this._emitBackfillSnapshot(recovered);
    recovered.backfilling = false;
    recovered.initializingUserInputs = false;
  }

  _getSessionDirs(pollContext = null) {
    const dirs = [];
    const seen = new Set();
    const addDir = (dir) => {
      if (!dir || seen.has(dir)) return;
      seen.add(dir);
      dirs.push(dir);
    };
    const now = new Date();
    for (let daysAgo = 0; daysAgo <= 2; daysAgo++) {
      const d = new Date(now);
      d.setDate(d.getDate() - daysAgo);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      addDir(path.join(this._baseDir, String(yyyy), mm, dd));
    }
    // Fallback: include most recent existing day dirs to handle
    // clock/timezone drift and `codex resume` of older sessions
    for (const dir of this._getCachedRecentExistingDayDirs(7)) addDir(dir);
    // Also include any day dir that has a recently-modified rollout file.
    // Covers Codex desktop app's long-lived conversations where new writes
    // keep landing in the ORIGINAL day dir (which can be weeks/months old).
    for (const dir of this._getActiveDayDirs(ACTIVE_SESSION_WINDOW_MS, pollContext)) addDir(dir);
    return dirs;
  }

  // Incrementally scan old day dirs without allowing discovery stat calls to
  // monopolize the Electron main process. The previous completed cache stays
  // live until a full replacement pass finishes.
  _getActiveDayDirs(withinMs = ACTIVE_SESSION_WINDOW_MS, pollContext = null) {
    const now = Date.now();
    if (
      this._activeDayDirsCache
      && !this._activeDayWalker
      && now - this._activeDayDirsCacheAt < 5000
    ) {
      return this._activeDayDirsCache;
    }
    if (!this._activeDayWalker) {
      this._activeDayWalker = {
        years: null,
        yearIndex: 0,
        months: null,
        monthIndex: 0,
        days: null,
        dayIndex: 0,
        files: null,
        fileIndex: 0,
        found: new Set(),
        complete: false,
      };
    }
    const walker = this._activeDayWalker;
    let operations = 0;
    const readDirectoryNames = (dir, pattern) => {
      operations += 1;
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
          .map((entry) => entry.name)
          .sort((a, b) => b.localeCompare(a));
      } catch {
        return [];
      }
    };
    while (
      !walker.complete
      && operations < MAX_ACTIVE_DIR_DISCOVERY_ATTEMPTS_PER_POLL
      && (!pollContext || pollContext.remainingAttempts > 0)
    ) {
      if (!walker.years) {
        walker.years = readDirectoryNames(this._baseDir, /^\d{4}$/);
        continue;
      }
      if (walker.yearIndex >= walker.years.length) {
        walker.complete = true;
        break;
      }
      const yearDir = path.join(this._baseDir, walker.years[walker.yearIndex]);
      if (!walker.months) {
        walker.months = readDirectoryNames(yearDir, /^\d{2}$/);
        walker.monthIndex = 0;
        continue;
      }
      if (walker.monthIndex >= walker.months.length) {
        walker.yearIndex += 1;
        walker.months = null;
        walker.days = null;
        walker.files = null;
        continue;
      }
      const monthDir = path.join(yearDir, walker.months[walker.monthIndex]);
      if (!walker.days) {
        walker.days = readDirectoryNames(monthDir, /^\d{2}$/);
        walker.dayIndex = 0;
        continue;
      }
      if (walker.dayIndex >= walker.days.length) {
        walker.monthIndex += 1;
        walker.days = null;
        walker.files = null;
        continue;
      }
      const dayDir = path.join(monthDir, walker.days[walker.dayIndex]);
      if (!walker.files) {
        operations += 1;
        try {
          walker.files = fs.readdirSync(dayDir)
            .filter((file) => file.startsWith("rollout-") && file.endsWith(".jsonl"));
        } catch {
          walker.files = [];
        }
        walker.fileIndex = 0;
      }
      if (walker.fileIndex >= walker.files.length) {
        walker.dayIndex += 1;
        walker.fileIndex = 0;
        walker.files = null;
        continue;
      }
      const file = walker.files[walker.fileIndex];
      walker.fileIndex += 1;
      operations += 1;
      if (pollContext) pollContext.remainingAttempts -= 1;
      try {
        const mtime = fs.statSync(path.join(dayDir, file)).mtimeMs;
        if (now - mtime < withinMs) {
          walker.found.add(dayDir);
          walker.dayIndex += 1;
          walker.fileIndex = 0;
          walker.files = null;
        }
      } catch {}
    }
    const visible = new Set(this._activeDayDirsCache || []);
    for (const dir of walker.found) visible.add(dir);
    if (walker.complete) {
      this._activeDayDirsCache = [...walker.found];
      this._activeDayDirsCacheAt = now;
      this._activeDayWalker = null;
      return this._activeDayDirsCache;
    }
    return [...visible];
  }

  _getCachedRecentExistingDayDirs(limit = 7) {
    const now = Date.now();
    const dateKey = this._getLocalDateKey();
    const cacheStale = now - this._recentDayDirsCacheAt > RECENT_DAY_DIR_CACHE_MS;
    const dayChanged = dateKey !== this._recentDayDirsDateKey;
    if (!this._recentDayDirsCache.length || cacheStale || dayChanged) {
      this._recentDayDirsCache = this._getRecentExistingDayDirs(limit);
      this._recentDayDirsCacheAt = now;
      this._recentDayDirsDateKey = dateKey;
    }
    return this._recentDayDirsCache.slice(0, limit);
  }

  _getLocalDateKey() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  _getRecentExistingDayDirs(limit = 7) {
    const out = [];
    let years;
    try {
      years = fs.readdirSync(this._baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return out;
    }
    for (const y of years) {
      const yPath = path.join(this._baseDir, y);
      let months;
      try {
        months = fs.readdirSync(yPath, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
          .map((d) => d.name)
          .sort((a, b) => b.localeCompare(a));
      } catch { continue; }
      for (const m of months) {
        const mPath = path.join(yPath, m);
        let days;
        try {
          days = fs.readdirSync(mPath, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
            .map((d) => d.name)
            .sort((a, b) => b.localeCompare(a));
        } catch { continue; }
        for (const d of days) {
          out.push(path.join(mPath, d));
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
  }

  _pollFile(filePath, fileName, pollContext = null) {
    let tracked = this._tracked.get(filePath) || null;
    const now = Date.now();
    const earlyPosition = this._readPositions.get(filePath) || null;
    if (
      earlyPosition
      && Number.isFinite(earlyPosition.readBackoffUntil)
      && now < earlyPosition.readBackoffUntil
    ) {
      return { kind: "backoff", requestedBytes: 0, bytesRead: 0 };
    }
    let stat;
    try {
      stat = pollContext && pollContext.preStat ? pollContext.preStat : fs.statSync(filePath);
    } catch {
      this._markReplayNoProgress(filePath, tracked);
      return { kind: "error", requestedBytes: 0, bytesRead: 0 };
    }

    const fileIdentity = this._getFileIdentity(stat);
    if (tracked) {
      const identityChanged = tracked.fileIdentity !== null
        && fileIdentity !== null
        && tracked.fileIdentity !== fileIdentity;
      if (identityChanged || stat.size < tracked.offset) {
        this._rebaselineTrackedFile(filePath, tracked, stat.size, fileIdentity);
        return { kind: "rebaseline", requestedBytes: 0, bytesRead: 0 };
      }
    }

    if (!tracked) {
      const sessionId = this._extractSessionId(fileName);
      if (!sessionId) return { kind: "ignored", requestedBytes: 0, bytesRead: 0 };
      const retiredEntry = this._retiredTracked.get(filePath) || null;
      const savedPosition = this._readPositions.get(filePath) || null;
      const savedOffset = savedPosition && Number.isFinite(savedPosition.offset)
        ? savedPosition.offset
        : null;
      const sameFile = savedPosition
        && savedPosition.identity !== null
        && fileIdentity !== null
        && savedPosition.identity === fileIdentity;
      if (
        sameFile
        && Number.isFinite(savedPosition.readBackoffUntil)
        && Date.now() < savedPosition.readBackoffUntil
      ) {
        return { kind: "backoff", requestedBytes: 0, bytesRead: 0 };
      }
      const retired = retiredEntry && (!savedPosition || sameFile) ? retiredEntry : null;
      const resumeOffset = savedPosition
        ? sameFile
          ? Math.min(savedOffset, stat.size)
          : stat.size
        : retired && stat.size >= retired.offset
          ? retired.offset
          : 0;
      const isFreshAttach = !retired && !savedPosition;
      tracked = {
        offset: resumeOffset,
        sessionId: "codex:" + sessionId,
        filePath,
        fileIdentity,
        cwd: retired ? retired.cwd : "",
        sessionTitle: retired ? retired.sessionTitle : null,
        codexOriginator: retired ? retired.codexOriginator : null,
        codexSource: retired ? retired.codexSource : null,
        codexQuotaProviderHint: retired ? retired.codexQuotaProviderHint || null : null,
        lastEventTime: Date.now(),
        lastState: retired ? retired.lastState : null,
        lastStateEvent: retired ? retired.lastStateEvent : null,
        hasEmittedState: retired ? retired.hasEmittedState === true : false,
        hadToolUse: retired ? retired.hadToolUse === true : false,
        isSubagent: retired ? retired.isSubagent === true : false,
        agentPid: retired ? retired.agentPid : null,
        assistantLastOutput: retired ? retired.assistantLastOutput || null : null,
        assistantLastOutputTruncated: retired ? retired.assistantLastOutputTruncated === true : false,
        contextUsage: retired ? retired.contextUsage || null : null,
        activeTurnId: retired ? retired.activeTurnId || null : null,
        turnBoundaryOpen: retired ? retired.turnBoundaryOpen === true : false,
        codexQuota: retired ? retired.codexQuota || null : null,
        codexSparkQuota: retired ? retired.codexSparkQuota || null : null,
        pendingUserInputs: retired && retired.pendingUserInputs instanceof Map
          ? new Map(retired.pendingUserInputs)
          : new Map(),
        initializingUserInputs: isFreshAttach,
        backfilling:
          isFreshAttach
          && stat.size > 0
          && stat.mtimeMs < this._startedAtMs - BACKFILL_GRACE_MS,
      };
      const needsReplaySlot = this._isReplayActive(tracked);
      if (needsReplaySlot && !this._admitReplayWork(filePath, fileName, tracked, stat)) {
        return { kind: "deferred", requestedBytes: 0, bytesRead: 0 };
      }
      // Admission comes first: a full replay working set must not evict a
      // completed/live tracker merely to discover that this path cannot get a
      // replay slot. Once admitted, at most 40 protected replay entries leave
      // enough ordinary entries for this pruning pass to free one active slot.
      if (this._tracked.size >= MAX_TRACKED_FILES) {
        this._pruneTrackedFilesIfNeeded(MAX_TRACKED_FILES - 1);
        if (this._tracked.size >= MAX_TRACKED_FILES) {
          if (needsReplaySlot) this._replayWork.delete(filePath);
          this._enqueueDeferred(filePath, fileName, stat);
          return { kind: "deferred", requestedBytes: 0, bytesRead: 0 };
        }
      }
      if (retiredEntry) this._retiredTracked.delete(filePath);
      this._tracked.set(filePath, tracked);
      this._readPositions.set(filePath, { offset: resumeOffset, identity: fileIdentity });
    } else if (this._isReplayActive(tracked) && !this._replayWork.has(filePath)) {
      if (!this._admitReplayWork(filePath, fileName, tracked, stat)) {
        this._tracked.delete(filePath);
        return { kind: "deferred", requestedBytes: 0, bytesRead: 0 };
      }
    }

    const savedPosition = this._readPositions.get(filePath) || null;
    if (
      savedPosition
      && savedPosition.identity === fileIdentity
      && Number.isFinite(savedPosition.readBackoffUntil)
      && Date.now() < savedPosition.readBackoffUntil
    ) {
      return { kind: "backoff", requestedBytes: 0, bytesRead: 0 };
    }

    if (stat.size <= tracked.offset) {
      this._finalizeReplayAfterScan(filePath, tracked);
      return { kind: "eof", requestedBytes: 0, bytesRead: 0 };
    }

    let fd = null;
    let buf;
    let bytesRead = 0;
    let openedStat;
    let openedIdentity = fileIdentity;
    let readLen = 0;
    const readStartOffset = tracked.offset;
    try {
      fd = fs.openSync(filePath, "r");
      openedStat = fs.fstatSync(fd);
      openedIdentity = this._getFileIdentity(openedStat);
      const openedIdentityChanged = openedIdentity !== fileIdentity
        && (openedIdentity !== null || fileIdentity !== null);
      if (openedIdentityChanged || openedStat.size < tracked.offset) {
        this._rebaselineTrackedFile(filePath, tracked, openedStat.size, openedIdentity);
        return { kind: "rebaseline", requestedBytes: 0, bytesRead: 0 };
      }
      this._recordValidatedReplaySnapshot(filePath, openedStat.size, openedIdentity);
      const unreadBytes = openedStat.size - tracked.offset;
      if (unreadBytes <= 0) {
        this._finalizeReplayAfterScan(filePath, tracked);
        return { kind: "eof", requestedBytes: 0, bytesRead: 0 };
      }
      readLen = Math.min(unreadBytes, MAX_POLL_READ_BYTES);
      if (
        pollContext
        && Number.isFinite(pollContext.remainingRequestBytes)
        && pollContext.remainingRequestBytes < readLen
      ) {
        return { kind: "budget", requestedBytes: 0, bytesRead: 0 };
      }
      if (pollContext && Number.isFinite(pollContext.remainingRequestBytes)) {
        pollContext.remainingRequestBytes -= readLen;
      }
      buf = Buffer.alloc(readLen);
      bytesRead = fs.readSync(fd, buf, 0, readLen, tracked.offset);
    } catch {
      this._markReplayNoProgress(filePath, tracked);
      return { kind: "error", requestedBytes: readLen, bytesRead: 0 };
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }

    if (!Number.isFinite(bytesRead) || bytesRead <= 0) {
      this._markReplayNoProgress(filePath, tracked);
      return { kind: "no-progress", requestedBytes: readLen, bytesRead: 0 };
    }
    buf = buf.subarray(0, Math.min(bytesRead, buf.length));
    const scannedToSnapshotEnd = readStartOffset + bytesRead >= openedStat.size;
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      const fullRead = bytesRead === readLen;
      const mayDiscard = buf.length > MAX_PARTIAL_BYTES
        && fullRead
        && (readLen === MAX_POLL_READ_BYTES || scannedToSnapshotEnd);
      if (mayDiscard) {
        tracked.offset += bytesRead;
        tracked.fileIdentity = openedIdentity;
        this._readPositions.set(filePath, { offset: tracked.offset, identity: openedIdentity });
        this._markReplayProgress(filePath);
      } else if (!scannedToSnapshotEnd) {
        this._markReplayNoProgress(filePath, tracked);
      }
      if (scannedToSnapshotEnd) this._finalizeReplayAfterScan(filePath, tracked);
      return {
        kind: mayDiscard ? "discarded" : "incomplete",
        requestedBytes: readLen,
        bytesRead,
      };
    }

    const committedBytes = lastNewline + 1;
    const text = buf.subarray(0, committedBytes).toString("utf8");
    tracked.offset += committedBytes;
    tracked.fileIdentity = openedIdentity;
    this._readPositions.set(filePath, { offset: tracked.offset, identity: openedIdentity });
    this._markReplayProgress(filePath);
    const lines = text.split("\n");
    lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      this._processLine(line, tracked);
    }
    if (scannedToSnapshotEnd) this._finalizeReplayAfterScan(filePath, tracked);
    return { kind: "progress", requestedBytes: readLen, bytesRead };
  }

  _isReplayActive(tracked) {
    return !!(tracked && (tracked.backfilling || tracked.initializingUserInputs));
  }

  _admitReplayWork(filePath, fileName, tracked, stat) {
    if (this._replayWork.has(filePath)) return true;
    const deferred = this._deferredRecent.get(filePath)
      || this._deferredBackground.get(filePath);
    const lane = Date.now() - stat.mtimeMs <= ACTIVE_SESSION_WINDOW_MS ? "recent" : "background";
    let backgroundCount = 0;
    for (const item of this._replayWork.values()) {
      if (item.lane === "background") backgroundCount += 1;
    }
    if (
      this._replayWork.size >= MAX_REPLAY_WORK_ITEMS
      || (lane === "background" && backgroundCount >= MAX_BACKGROUND_REPLAY_WORK_ITEMS)
    ) {
      this._enqueueDeferred(filePath, fileName, stat, lane);
      return false;
    }
    this._replayWork.set(filePath, {
      filePath,
      fileName,
      tracked,
      lane,
      consecutiveNoProgress: 0,
      lastProgressAt: Date.now(),
      hasValidatedSnapshot: false,
      lastValidatedSnapshotSize: null,
      lastValidatedIdentity: null,
      retryLevel: deferred && Number.isFinite(deferred.retryLevel) ? deferred.retryLevel : 0,
    });
    this._deferredRecent.delete(filePath);
    this._deferredBackground.delete(filePath);
    return true;
  }

  _enqueueDeferred(filePath, fileName, stat, forcedLane = null, retry = null) {
    const lane = forcedLane
      || (Date.now() - stat.mtimeMs <= ACTIVE_SESSION_WINDOW_MS ? "recent" : "background");
    const queue = lane === "recent" ? this._deferredRecent : this._deferredBackground;
    const limit = lane === "recent" ? MAX_DEFERRED_RECENT_PATHS : MAX_DEFERRED_BACKGROUND_PATHS;
    const existing = queue.get(filePath);
    if (existing) queue.delete(filePath);
    queue.set(filePath, {
      filePath,
      fileName,
      lane,
      mtimeMs: stat.mtimeMs,
      identity: this._getFileIdentity(stat),
      notBefore: retry && Number.isFinite(retry.notBefore) ? retry.notBefore : 0,
      retryLevel: retry && Number.isFinite(retry.retryLevel) ? retry.retryLevel : 0,
    });
    while (queue.size > limit) queue.delete(queue.keys().next().value);
  }

  _backoffDeferredStatFailure(entry) {
    if (!entry) return;
    const retryLevel = Math.min(5, Math.max(0, Number(entry.retryLevel) || 0) + 1);
    const backoffMs = Math.min(
      REPLAY_RETRY_MAX_BACKOFF_MS,
      REPLAY_RETRY_BASE_BACKOFF_MS * (2 ** (retryLevel - 1))
    );
    entry.retryLevel = retryLevel;
    entry.notBefore = Date.now() + backoffMs;
  }

  _recordValidatedReplaySnapshot(filePath, snapshotSize, identity) {
    const item = this._replayWork.get(filePath);
    if (!item) return;
    item.hasValidatedSnapshot = true;
    item.lastValidatedSnapshotSize = snapshotSize;
    item.lastValidatedIdentity = identity;
  }

  _markReplayProgress(filePath) {
    const item = this._replayWork.get(filePath);
    if (!item) return;
    item.consecutiveNoProgress = 0;
    item.lastProgressAt = Date.now();
    item.retryLevel = 0;
  }

  _markReplayNoProgress(filePath, tracked) {
    const item = this._replayWork.get(filePath);
    if (!item) {
      this._schedulePostBaselineReadBackoff(filePath, tracked);
      return;
    }
    if (!tracked) return;
    item.consecutiveNoProgress += 1;
    const now = Date.now();
    if (
      item.consecutiveNoProgress < MAX_REPLAY_NO_PROGRESS_ATTEMPTS
      || now - item.lastProgressAt < REPLAY_NO_PROGRESS_TIMEOUT_MS
    ) return;
    this._abandonReplayAtValidatedSnapshot(filePath, tracked, item, now);
  }

  _schedulePostBaselineReadBackoff(filePath, tracked) {
    const previous = this._readPositions.get(filePath) || null;
    if (!previous || !(Number(previous.readBackoffLevel) > 0)) return false;
    const now = Date.now();
    if (Number.isFinite(previous.readBackoffUntil) && now < previous.readBackoffUntil) {
      return true;
    }
    const retryLevel = Math.min(5, Number(previous.readBackoffLevel) + 1);
    const backoffMs = Math.min(
      REPLAY_RETRY_MAX_BACKOFF_MS,
      REPLAY_RETRY_BASE_BACKOFF_MS * (2 ** (retryLevel - 1))
    );
    this._readPositions.set(filePath, {
      offset: tracked && Number.isFinite(tracked.offset) ? tracked.offset : previous.offset,
      identity: tracked ? tracked.fileIdentity : previous.identity,
      readBackoffUntil: now + backoffMs,
      readBackoffLevel: retryLevel,
    });
    return true;
  }

  _abandonReplayAtValidatedSnapshot(filePath, tracked, item, now) {
    const previous = this._readPositions.get(filePath) || {};
    const retryLevel = Math.min(
      5,
      Math.max(Number(previous.readBackoffLevel) || 0, Number(item.retryLevel) || 0) + 1
    );
    const backoffMs = Math.min(
      REPLAY_RETRY_MAX_BACKOFF_MS,
      REPLAY_RETRY_BASE_BACKOFF_MS * (2 ** (retryLevel - 1))
    );
    if (!item.hasValidatedSnapshot) {
      this._clearUnpublishedReplayState(tracked);
      this._tracked.delete(filePath);
      this._replayWork.delete(filePath);
      // This attach never reached an authoritative opened snapshot. Keeping
      // the provisional offset ledger would make the retry look like a
      // completed reattach and bypass initialization/replay admission.
      this._readPositions.delete(filePath);
      this._enqueueDeferred(filePath, item.fileName, {
        mtimeMs: Date.now(),
        dev: 0,
        ino: 0,
      }, item.lane, { notBefore: now + backoffMs, retryLevel });
      return;
    }
    this._clearUnpublishedReplayState(tracked);
    tracked.offset = item.lastValidatedSnapshotSize;
    tracked.fileIdentity = item.lastValidatedIdentity;
    tracked.backfilling = false;
    tracked.initializingUserInputs = false;
    this._readPositions.set(filePath, {
      offset: tracked.offset,
      identity: tracked.fileIdentity,
      readBackoffUntil: now + backoffMs,
      readBackoffLevel: retryLevel,
    });
    this._replayWork.delete(filePath);
  }

  _clearUnpublishedReplayState(tracked) {
    if (!tracked) return;
    if (tracked.initializingUserInputs && tracked.pendingUserInputs instanceof Map) {
      tracked.pendingUserInputs.clear();
    }
    if (tracked.backfilling) {
      tracked.lastState = null;
      tracked.lastStateEvent = null;
      tracked.hadToolUse = false;
      tracked.assistantLastOutput = null;
      tracked.assistantLastOutputTruncated = false;
      tracked.contextUsage = null;
      tracked.activeTurnId = null;
      tracked.turnBoundaryOpen = false;
      tracked.codexQuota = null;
      tracked.codexSparkQuota = null;
    }
  }

  _finalizeReplayAfterScan(filePath, tracked) {
    if (!tracked) return;
    if (tracked.backfilling) {
      this._emitBackfillSnapshot(tracked);
      tracked.backfilling = false;
    }
    if (tracked.initializingUserInputs) {
      tracked.initializingUserInputs = false;
      this._emitPendingUserInputRequests(tracked);
    }
    this._replayWork.delete(filePath);
  }

  _rebaselineTrackedFile(filePath, tracked, offset, identity) {
    this._clearUnpublishedReplayState(tracked);
    tracked.offset = offset;
    tracked.fileIdentity = identity;
    tracked.backfilling = false;
    tracked.initializingUserInputs = false;
    this._replayWork.delete(filePath);
    this._readPositions.set(filePath, { offset, identity });
  }

  _getFileIdentity(stat) {
    if (!stat) return null;
    const dev = Number(stat.dev);
    const ino = Number(stat.ino);
    if (Number.isFinite(dev) && Number.isFinite(ino) && (dev !== 0 || ino !== 0)) {
      return `inode:${dev}:${ino}`;
    }
    const birthtimeMs = Number(stat.birthtimeMs);
    if (Number.isFinite(birthtimeMs) && birthtimeMs > 0) {
      return `birth:${birthtimeMs}`;
    }
    return null;
  }

  _processLine(line, tracked) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // corrupted line, skip
    }

    const type = obj.type;
    const payload = obj.payload;
    const subtype =
      payload && typeof payload === "object" ? payload.type || "" : "";

    // Build lookup key
    const key = subtype ? type + ":" + subtype : type;

    // Turn identity is file-order bookkeeping, not a live callback. Apply it
    // before both replay guards so an old task_started seeds the active ID and
    // an old terminal clears it even though neither historical record is
    // allowed to replay visible state.
    const recordTurnId = normalizeCodexTurnId(
      payload && typeof payload === "object" ? payload.turn_id : null
    );
    const isTurnStart = key === "event_msg:task_started";
    const isTurnTerminal = key === "event_msg:task_complete" || key === "event_msg:turn_aborted";
    let effectiveTurnId = recordTurnId || tracked.activeTurnId || null;
    if (isTurnStart) {
      tracked.activeTurnId = recordTurnId;
      tracked.turnBoundaryOpen = true;
      effectiveTurnId = recordTurnId;
    }
    const finishTurnTerminal = () => {
      if (!isTurnTerminal) return;
      tracked.activeTurnId = null;
      tracked.turnBoundaryOpen = false;
    };
    const parsedOccurredAt = obj && typeof obj.timestamp === "string"
      ? Date.parse(obj.timestamp)
      : NaN;
    const rawToolUseId = payload && typeof payload === "object"
      ? (payload.call_id || payload.tool_use_id || payload.id)
      : null;
    const turnExtra = {
      ...(effectiveTurnId ? { turnId: effectiveTurnId, recapDedupeId: effectiveTurnId } : {}),
      ...(Number.isFinite(parsedOccurredAt) ? { recapOccurredAt: parsedOccurredAt } : {}),
      ...(typeof rawToolUseId === "string" && rawToolUseId ? { toolUseId: rawToolUseId } : {}),
      ...(key === "response_item:function_call" && payload && payload.name === "web_search"
        ? { recapIsWebSearch: true }
        : {}),
    };

    // Metadata is needed for future live writes even when the session_meta
    // record itself predates monitor start.
    if (type === "session_meta") {
      this._applySessionMeta(payload, tracked);
    }
    if (type === "turn_context" && payload && typeof payload === "object") {
      const providerHint = resolveCodexModelQuotaProvider(payload.model);
      if (providerHint) tracked.codexQuotaProviderHint = providerHint;
    }

    // request_user_input/function_call_output correlation must survive the
    // timestamp guard below: Codex Desktop can rewrite event_msg:token_count
    // on focus long after the session went idle, which bumps the file's
    // mtime into the "live" window even though the actual question line is
    // old. A still-open question must not be dropped just because the guard
    // saw a stale timestamp on the line that carries it.
    if (this._processCodexUserInputRecord(obj, tracked)) return;

    // Skip historical events that predate monitor start — prevents replay
    // storms on app restart from driving stale state transitions.
    if (obj && typeof obj.timestamp === "string") {
      const ts = Date.parse(obj.timestamp);
      if (!tracked.backfilling && Number.isFinite(ts) && ts < this._startedAtMs - 1500) {
        finishTurnTerminal();
        return;
      }
    }

    const assistantText = extractAssistantTextFromRecord(obj);
    if (assistantText) {
      const assistantOutput = clampAssistantOutputText(assistantText);
      tracked.assistantLastOutput = assistantOutput ? assistantOutput.text : null;
      tracked.assistantLastOutputTruncated = !!(assistantOutput && assistantOutput.truncated);
    }

    if (key === "event_msg:token_count") {
      const contextUsage = extractCodexContextUsage(payload);
      if (contextUsage) tracked.contextUsage = contextUsage;
      // Subscription quota rides the same event. Gated on the line's own
      // timestamp: backfill/restart replays parse old lines, and posting
      // their quota would stamp fresh arbitration metadata on stale data.
      // capturedAt (the same line timestamp) rides on every bucket so the
      // account store can reject out-of-order writes — with two live
      // sessions, one session's older observation must never overwrite the
      // other's newer one.
      const quotaReport = isFreshCodexQuotaTimestamp(obj && obj.timestamp)
        ? resolveCodexRateLimitReport(payload, {
          capturedAt: Date.parse(obj.timestamp),
          providerHint: tracked.codexQuotaProviderHint,
        })
        : null;
      const quotaExtra = quotaReport
        ? { [quotaReport.providerKey]: quotaReport.quota }
        : null;
      if (quotaReport) tracked[quotaReport.providerKey] = quotaReport.quota;
      if ((contextUsage || quotaReport) && !tracked.backfilling) {
        // token_count is a metadata refresh, not a turn boundary: Codex
        // Desktop rewrites it on focus long after a session went idle. Never
        // replay one-shot states such as attention (#535).
        const carry = SUSTAINED_ACTIVE_STATES.has(tracked.lastState)
          ? tracked.lastState
          : "idle";
        // Quota is attached ONLY to the emission of the event that captured
        // it (plus the backfill snapshot) — never re-attached from the
        // per-session cache on ordinary lifecycle events, which would keep
        // replaying a session's last-seen value as if it were a new report.
        this._emitStateChange(tracked, carry, key,
          quotaExtra);
      }
      return;
    }

    // Extract Codex-authored session summary (turn_context.summary).
    // Updates tracked.sessionTitle in place; gets picked up by the next
    // _onStateChange call. Intentionally no metaOnly side-channel —
    // accepts brief staleness until the next state emit.
    const extractedTitle = this._extractSessionTitle(obj);
    if (extractedTitle && extractedTitle !== tracked.sessionTitle) {
      tracked.sessionTitle = extractedTitle;
    }
    const threadName = readCodexThreadName(tracked.sessionId, { codexDir: this._codexDir });
    if (threadName && threadName !== tracked.sessionTitle) {
      tracked.sessionTitle = threadName;
    }

    // Look up state mapping
    const map = this._config.logEventMap;
    const state = map[key];
    if (state === undefined) {
      finishTurnTerminal();
      return; // unmapped event, skip
    }
    if (state === null) {
      finishTurnTerminal();
      return; // explicitly ignored
    }
    tracked.lastStateEvent = key;

    // Track tool use per turn — reset on task_started, set on function_call
    if (key === "event_msg:task_started") {
      tracked.hadToolUse = false;
      tracked.assistantLastOutput = null;
      tracked.assistantLastOutputTruncated = false;
    }
    const isToolBoundary = key === "response_item:function_call"
      || key === "response_item:custom_tool_call"
      || key === "response_item:web_search_call";
    if (isToolBoundary) {
      tracked.hadToolUse = true;
    }

    // Turn-end: happy if tools were used or the turn produced assistant text;
    // metadata-only completions stay idle to avoid noisy fallback animation.
    if (state === "codex-turn-end") {
      const resolved = this._isTrackedSubagent(tracked)
        ? "idle"
        : (tracked.hadToolUse || !!tracked.assistantLastOutput ? "attention" : "idle");
      tracked.hadToolUse = false;
      tracked.lastState = resolved;
      // task_complete means the turn that asked is over — any question still
      // open for it is moot; Codex will not act on an answer after this.
      this._clearPendingUserInputsForTrackedSession(tracked, "turn-complete");
      if (tracked.backfilling) {
        finishTurnTerminal();
        return;
      }
      this._emitStateChange(tracked, resolved, key, {
        ...(this._assistantOutputExtra(tracked) || {}),
        ...(turnExtra || {}),
      });
      finishTurnTerminal();
      return;
    }

    // turn_aborted: same reasoning as task_complete above, just a different
    // terminal signal (the turn didn't finish, it was cut short).
    if (key === "event_msg:turn_aborted") {
      this._clearPendingUserInputsForTrackedSession(tracked, "turn-aborted");
    }

    // Backfill gate: first-pass replay of a file's historical content skips
    // every callback, but it still updates
    // internal state so attach can synthesize the current visible state once.
    // Independent of the timestamp-based replay guard, which only helps lines
    // that carry a timestamp field.
    if (tracked.backfilling) {
      tracked.lastState = state;
      finishTurnTerminal();
      return;
    }

    // Avoid spamming repeated working state, except for one-shot tool
    // boundaries. The official hook emits every PreToolUse; JSONL fallback
    // must preserve the same counting boundary even when the pet is already
    // visually working.
    if (state === tracked.lastState && state === "working" && !isToolBoundary) return;
    tracked.lastState = state;
    this._emitStateChange(tracked, state, key, turnExtra);
    finishTurnTerminal();
  }

  _applySessionMeta(payload, tracked) {
    if (!payload || typeof payload !== "object") return;
    tracked.cwd = payload.cwd || "";
    tracked.codexOriginator = typeof payload.originator === "string" && payload.originator.trim()
      ? payload.originator.trim()
      : tracked.codexOriginator;
    tracked.codexSource = typeof payload.source === "string" && payload.source.trim()
      ? payload.source.trim()
      : tracked.codexSource;
    const role = this._classifier.registerSession(tracked.sessionId, { sessionMeta: payload });
    if (role === "subagent") tracked.isSubagent = true;
    else if (role === "root") tracked.isSubagent = false;
  }

  // Codex-authored session summary, extracted from turn_context.summary.
  // Filters "none" / "auto" placeholder values that Codex writes when
  // the model hasn't produced a real summary yet.
  _extractSessionTitle(obj) {
    if (!obj || typeof obj !== "object") return null;
    const payload = obj.payload && typeof obj.payload === "object" ? obj.payload : null;
    if (!payload) return null;
    if (obj.type === "turn_context" && typeof payload.summary === "string") {
      const summary = payload.summary.trim();
      if (summary && summary !== "none" && summary !== "auto") return summary;
    }
    return null;
  }

  // Extract UUID from rollout filename
  // rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl
  _extractSessionId(fileName) {
    // UUID v7 is the last 5 segments of the filename (before .jsonl)
    const base = fileName.replace(".jsonl", "");
    const parts = base.split("-");
    // UUID: last 5 parts (8-4-4-4-12 hex)
    if (parts.length < 10) return null;
    return parts.slice(-5).join("-");
  }

  _resolveTrackedAgentPid(tracked) {
    if (tracked.agentPid && this._isProcessAlive(tracked.agentPid)) {
      return tracked.agentPid;
    }
    const pid = this._findCodexWriterPid(tracked.filePath);
    tracked.agentPid = pid || null;
    return tracked.agentPid;
  }

  _isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err && err.code === "EPERM";
    }
  }

  // Linux-only: find codex process that has the rollout file open via /proc
  _findCodexWriterPid(filePath) {
    if (process.platform !== "linux" || !filePath) return null;
    let procEntries;
    try {
      procEntries = fs.readdirSync("/proc", { withFileTypes: true });
    } catch {
      return null;
    }
    for (const ent of procEntries) {
      if (!ent.isDirectory() || !/^\d+$/.test(ent.name)) continue;
      const pid = Number(ent.name);
      if (!Number.isFinite(pid) || pid <= 1) continue;
      // Fast prefilter: skip non-codex processes
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!cmd.includes("codex")) continue;
      } catch { continue; }
      let fds;
      try {
        fds = fs.readdirSync(`/proc/${pid}/fd`);
      } catch { continue; }
      for (const fd of fds) {
        try {
          const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (target === filePath) return pid;
        } catch {}
      }
    }
    return null;
  }

  _pruneTrackedFilesIfNeeded(maxSize = MAX_TRACKED_FILES) {
    if (this._tracked.size <= maxSize) return;
    const byAge = (a, b) => (a[1].lastEventTime || 0) - (b[1].lastEventTime || 0);
    const neverEmitted = [...this._tracked.entries()]
      .filter(([filePath, tracked]) => (
        tracked && !tracked.hasEmittedState && !this._replayWork.has(filePath)
      ))
      .sort(byAge);
    const emitted = [...this._tracked.entries()]
      .filter(([filePath, tracked]) => (
        tracked && tracked.hasEmittedState && !this._replayWork.has(filePath)
      ))
      .sort(byAge);
    for (const [filePath, tracked] of [...neverEmitted, ...emitted]) {
      if (this._tracked.size <= maxSize) break;
      this._retireTrackedFile(filePath, tracked);
    }
  }

  _retireTrackedFile(filePath, tracked) {
    if (this._replayWork.has(filePath)) return;
    this._tracked.delete(filePath);
    if (!filePath || !tracked) return;
    this._retiredTracked.delete(filePath);
    this._retiredTracked.set(filePath, {
      offset: Number.isFinite(tracked.offset) ? tracked.offset : 0,
      cwd: tracked.cwd || "",
      sessionTitle: tracked.sessionTitle || null,
      codexOriginator: tracked.codexOriginator || null,
      codexSource: tracked.codexSource || null,
      codexQuotaProviderHint: tracked.codexQuotaProviderHint || null,
      lastState: tracked.lastState || null,
      lastStateEvent: tracked.lastStateEvent || null,
      hasEmittedState: tracked.hasEmittedState === true,
      hadToolUse: tracked.hadToolUse === true,
      isSubagent: tracked.isSubagent === true,
      agentPid: tracked.agentPid || null,
      assistantLastOutput: tracked.assistantLastOutput || null,
      assistantLastOutputTruncated: tracked.assistantLastOutputTruncated === true,
      contextUsage: tracked.contextUsage || null,
      activeTurnId: tracked.activeTurnId || null,
      turnBoundaryOpen: tracked.turnBoundaryOpen === true,
      codexQuota: tracked.codexQuota || null,
      codexSparkQuota: tracked.codexSparkQuota || null,
      pendingUserInputs: tracked.pendingUserInputs instanceof Map
        ? new Map(tracked.pendingUserInputs)
        : new Map(),
    });
    while (this._retiredTracked.size > MAX_RETIRED_TRACKED_FILES) {
      const oldest = this._retiredTracked.keys().next().value;
      this._retiredTracked.delete(oldest);
    }
  }

  _emitBackfillSnapshot(tracked) {
    // The backfill snapshot is the one non-capture emission that carries the
    // cached quota: it is how a restart re-seeds the account store with the
    // last-known (still freshness-gated) numbers parsed from history.
    const quotaExtra = {
      ...(tracked.codexQuota ? { codexQuota: tracked.codexQuota } : {}),
      ...(tracked.codexSparkQuota ? { codexSparkQuota: tracked.codexSparkQuota } : {}),
    };
    const hasQuota = Object.keys(quotaExtra).length > 0;
    // A pending question already gets its own card via
    // _emitPendingUserInputRequests, so a root session's redundant sustained-
    // state snapshot is skipped here. Subagents never get that card
    // (_emitUserInputRequest no-ops for them) — skipping their snapshot too
    // would leave them with no state at all, so only root sessions qualify.
    if (
      !this._isTrackedSubagent(tracked)
      && tracked.pendingUserInputs instanceof Map
      && tracked.pendingUserInputs.size > 0
    ) {
      // The question callback does not carry account quota. Seed the
      // session-independent store without replaying the sustained state.
      if (hasQuota) {
        this._emitStateChange(tracked, "idle", "event_msg:token_count", quotaExtra);
      }
      return;
    }
    const snapshotState = tracked.lastState;
    if (!SUSTAINED_ACTIVE_STATES.has(snapshotState)) {
      if (tracked.contextUsage || hasQuota) {
        this._emitStateChange(tracked, "idle", "event_msg:token_count", quotaExtra);
      }
      return;
    }
    this._emitStateChange(
      tracked,
      snapshotState,
      tracked.lastStateEvent || "session_meta",
      {
        ...(hasQuota ? quotaExtra : {}),
        syntheticBackfill: true,
        turnBoundaryOpen: tracked.turnBoundaryOpen === true,
        ...(tracked.activeTurnId ? { turnId: tracked.activeTurnId } : {}),
      }
    );
  }

  _processCodexUserInputRecord(obj, tracked) {
    const record = parseCodexUserInputRecord(obj);
    if (!record) return false;
    if (!(tracked.pendingUserInputs instanceof Map)) tracked.pendingUserInputs = new Map();
    if (record.phase === "request") {
      // #707 follow-up review round 4: the recovery sweep's own age cap only
      // protects files it actually opens (mtime outside the active window).
      // A file Codex Desktop refreshed back into the active window attaches
      // here instead, with no age check at all — a genuinely dead question
      // from days ago would flash a card just because something unrelated
      // touched the file recently. Only during the initial catch-up read
      // (backfill or a fresh-mtime file's first attach): reject a request
      // whose OWN timestamp is already past RECOVERY_MAX_AGE_MS. A live
      // request encountered after that never fails this check — it's
      // freshly-timestamped by definition.
      if (tracked.initializingUserInputs) {
        const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
        if (Number.isFinite(ts) && Date.now() - ts > RECOVERY_MAX_AGE_MS) return true;
      }
      tracked.pendingUserInputs.set(record.callId, record);
      tracked.hadToolUse = true;
      if (!tracked.backfilling && !tracked.initializingUserInputs) {
        this._emitUserInputRequest(tracked, record);
      }
      return true;
    }
    if (!tracked.pendingUserInputs.has(record.callId)) return true;
    tracked.pendingUserInputs.delete(record.callId);
    if (!tracked.backfilling && !tracked.initializingUserInputs && this._onUserInputResolved) {
      this._onUserInputResolved(tracked.sessionId, record.callId);
    }
    return true;
  }

  // Drop any request_user_input still open for this session because its
  // context just ended (turn completed/aborted) — Codex is not going to
  // consume an answer after this, so the card is no longer actionable.
  // Bookkeeping (the Map) is cleared unconditionally so a later
  // function_call_output for the same callId can't resurrect it; the
  // dismiss callback only fires for a genuinely live (non-backfill,
  // non-initializing) transition, matching every other emit in this file.
  _clearPendingUserInputsForTrackedSession(tracked, reason = "turn-terminal") {
    if (!(tracked.pendingUserInputs instanceof Map) || tracked.pendingUserInputs.size === 0) return;
    const callIds = [...tracked.pendingUserInputs.keys()];
    tracked.pendingUserInputs.clear();
    if (tracked.backfilling || tracked.initializingUserInputs || !this._onUserInputResolved) return;
    for (const callId of callIds) {
      this._onUserInputResolved(tracked.sessionId, callId, {
        source: "turn-terminal",
        reason,
      });
    }
  }

  _emitPendingUserInputRequests(tracked) {
    if (!(tracked.pendingUserInputs instanceof Map)) return;
    for (const request of tracked.pendingUserInputs.values()) {
      this._emitUserInputRequest(tracked, request);
    }
  }

  _emitUserInputRequest(tracked, request) {
    if (!this._onUserInputRequest || this._isTrackedSubagent(tracked)) return;
    const agentPid = this._resolveTrackedAgentPid(tracked);
    this._onUserInputRequest(tracked.sessionId, request, {
      cwd: tracked.cwd,
      sourcePid: agentPid,
      agentPid,
      sessionTitle: tracked.sessionTitle,
      codexOriginator: tracked.codexOriginator || null,
      codexSource: tracked.codexSource || null,
      ...(tracked.contextUsage ? { contextUsage: tracked.contextUsage } : {}),
      headless: false,
    });
  }

  _assistantOutputExtra(tracked) {
    if (!tracked || typeof tracked.assistantLastOutput !== "string" || !tracked.assistantLastOutput) {
      return null;
    }
    return {
      assistantLastOutput: tracked.assistantLastOutput,
      assistantLastOutputTruncated: tracked.assistantLastOutputTruncated === true,
    };
  }

  // contextUsage only, deliberately NOT either tracked account-quota
  // provider: context usage is a per-session property (re-attaching the
  // cached value to lifecycle events keeps the session card current), but
  // account quota is not — a cached copy goes stale the moment another
  // session reports, and blindly re-attaching it would replay old numbers
  // into the account store on every lifecycle event (see token_count above).
  _withTrackedContextUsage(tracked, extra = null) {
    if (!tracked || !tracked.contextUsage) return extra;
    return { ...(extra || {}), contextUsage: tracked.contextUsage };
  }

  _isTrackedSubagent(tracked) {
    if (!tracked) return false;
    const role = this._classifier && typeof this._classifier.classify === "function"
      ? this._classifier.classify(tracked.sessionId)
      : "unknown";
    if (role === "subagent") {
      tracked.isSubagent = true;
      return true;
    }
    if (role === "root") {
      tracked.isSubagent = false;
      return false;
    }
    return tracked.isSubagent === true;
  }

  _emitStateChange(tracked, state, event, extra = null) {
    tracked.lastState = state;
    tracked.lastEventTime = Date.now();
    tracked.hasEmittedState = true;
    const agentPid = this._resolveTrackedAgentPid(tracked);
    this._onStateChange(tracked.sessionId, state, event, {
      cwd: tracked.cwd,
      sourcePid: extra && Object.prototype.hasOwnProperty.call(extra, "sourcePid")
        ? extra.sourcePid
        : agentPid,
      agentPid: extra && Object.prototype.hasOwnProperty.call(extra, "agentPid")
        ? extra.agentPid
        : agentPid,
      sessionTitle: tracked.sessionTitle,
      codexOriginator: tracked.codexOriginator || null,
      codexSource: tracked.codexSource || null,
      ...this._withTrackedContextUsage(tracked, extra),
      headless: this._isTrackedSubagent(tracked)
        ? true
        : (extra && Object.prototype.hasOwnProperty.call(extra, "headless") ? extra.headless : undefined),
    });
  }
}

module.exports = CodexLogMonitor;
