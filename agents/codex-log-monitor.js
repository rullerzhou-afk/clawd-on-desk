// Codex CLI JSONL log monitor
// Polls ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl for state changes
// Zero external dependencies (node built-ins + local Codex helpers only)
//
// Replay protection is two layers — change one, consider the other:
//   1. Line-level: _processLine skips entries whose `timestamp` field is
//      older than monitor start. Only helps lines that carry a timestamp.
//   2. File-level: _pollFile sets tracked.backfilling when attaching to a
//      file whose mtime predates monitor start. _processLine then suppresses
//      historical emits until the first read drains, then
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

const MAX_TRACKED_FILES = 50;
const MAX_RETIRED_TRACKED_FILES = 100;
const MAX_PARTIAL_BYTES = 65536;
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
    this._baseDir = this._resolveBaseDir();
    this._codexDir = options.codexDir || null;
    this._recentDayDirsCache = [];
    this._recentDayDirsCacheAt = 0;
    this._recentDayDirsDateKey = "";
    this._activeDayDirsCache = null;
    this._activeDayDirsCacheAt = 0;
    this._startedAtMs = Date.now();
    // One-shot: the first _poll() after start() is allowed to open files
    // outside ACTIVE_SESSION_WINDOW_MS to check for a still-unresolved
    // request_user_input (see _mightHavePendingUserInput). Every later poll
    // reverts to the cheap mtime-only gate — this is a startup recovery
    // sweep, not an ongoing scan of Codex's full history.
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
  }

  _poll() {
    const dirs = this._getSessionDirs();
    const recoveryCandidates = [];
    for (const dir of dirs) {
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue; // directory doesn't exist yet
      }
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
        const filePath = path.join(dir, file);
        // Skip files we're not already tracking if they haven't been written recently
        if (!this._tracked.has(filePath)) {
          let stat;
          try {
            stat = fs.statSync(filePath);
          } catch { continue; }
          if (now - stat.mtimeMs > ACTIVE_SESSION_WINDOW_MS) {
            // Outside the steady-state polling window. Only the one-time
            // startup sweep may even consider it — Codex genuinely blocked
            // on request_user_input can sit quiet far longer than 5 minutes,
            // and an untracked file is otherwise never seen again. Collected
            // here, not read yet: candidates are sorted and budgeted in
            // _runRecoverySweep so an unbounded NUMBER of stale files can't
            // add up to unbounded main-process blocking even though each
            // individual read is already capped.
            if (!this._didInitialRecoveryScan) {
              recoveryCandidates.push({ filePath, file, mtimeMs: stat.mtimeMs, size: stat.size });
            }
            continue;
          }
        }
        this._pollFile(filePath, file);
      }
    }
    if (!this._didInitialRecoveryScan) {
      this._runRecoverySweep(recoveryCandidates);
      this._didInitialRecoveryScan = true;
    }
    this._pruneTrackedFilesIfNeeded();
  }

  _runRecoverySweep(candidates) {
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let filesScanned = 0;
    let bytesScanned = 0;
    for (const candidate of candidates) {
      if (filesScanned >= RECOVERY_SWEEP_MAX_FILES) break;
      const candidateCost = Math.min(
        candidate.size,
        RECOVERY_HEAD_LINE_MAX_BYTES + RECOVERY_TAIL_SCAN_BYTES + 1
      );
      // Check BEFORE adding — accumulating post-hoc lets exactly one
      // over-budget candidate slip through every time the running total
      // lands just under the cap (#707 follow-up review round 4).
      if (bytesScanned + candidateCost > RECOVERY_SWEEP_MAX_TOTAL_BYTES) break;
      filesScanned += 1;
      bytesScanned += candidateCost;
      const recovered = this._recoverStalePendingUserInput(candidate.filePath, candidate.file);
      if (recovered) {
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
    // Reads only the NEW portion at each step (not a fresh 0..chunkSize read
    // every retry) so the physical bytes read never exceed maxBytes even in
    // the worst case — the recovery sweep's total-byte budget assumes this
    // function never reads more than maxBytes per file (#707 follow-up
    // review round 4).
    let readSoFar = 0;
    let text = "";
    let target = Math.min(statSize, 8 * 1024, maxBytes);
    for (;;) {
      const additional = target - readSoFar;
      if (additional > 0) {
        const { text: chunkText } = this._readByteRange(filePath, readSoFar, additional);
        text += chunkText;
        readSoFar = target;
      }
      const newlineIdx = text.indexOf("\n");
      if (newlineIdx !== -1) return text.slice(0, newlineIdx);
      if (readSoFar >= statSize || readSoFar >= maxBytes) return null;
      target = Math.min(readSoFar * 4, maxBytes, statSize);
    }
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
  _recoverStalePendingUserInput(filePath, fileName) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
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
    const role = this._classifier.registerSession("codex:" + sessionId, { sessionMeta: sessionMeta.payload });
    const isSubagent = role === "subagent";

    // Tail: an unresolved request_user_input, if any, is near the end —
    // Codex stops writing once it's blocked waiting for an answer.
    const tailLen = Math.min(stat.size, RECOVERY_TAIL_SCAN_BYTES);
    const tailStart = stat.size - tailLen;
    // A non-zero tailStart is not necessarily mid-line: it can land exactly
    // on the first byte after a newline. Inspect the preceding raw byte so a
    // valid request at that exact 1 MiB boundary is not discarded below.
    const tailStartsOnRecordBoundary = tailStart === 0
      || this._readByteRange(filePath, tailStart - 1, 1).buf[0] === 0x0a;
    const { buf: tailBuf } = this._readByteRange(filePath, tailStart, tailLen);
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
      isSubagent,
      agentPid: null,
      assistantLastOutput: null,
      assistantLastOutputTruncated: false,
      contextUsage: null,
      codexQuota: null,
      codexSparkQuota: null,
      pendingUserInputs: recentlyActive ? new Map() : pending,
      initializingUserInputs: recentlyActive,
      backfilling: recentlyActive,
    };
    if (!recentlyActive) return recovered;

    // Reconstruct only the bounded tail in backfill mode. Historical
    // lifecycle events stay silent, while fresh token_count captures seed
    // the session-independent quota store. Head metadata was read separately
    // above so subagent/cwd classification does not depend on the tail window.
    this._applySessionMeta(sessionMeta.payload, recovered);
    for (const line of rawLines) {
      if (!line.trim()) continue;
      this._processLine(line, recovered);
    }
    this._emitBackfillSnapshot(recovered);
    recovered.backfilling = false;
    recovered.initializingUserInputs = false;
    return recovered;
  }

  _getSessionDirs() {
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
    for (const dir of this._getActiveDayDirs()) addDir(dir);
    return dirs;
  }

  // Scan baseDir for any day dir containing a rollout-*.jsonl whose mtime
  // is within `withinMs`. Returns the set of such day dirs.
  // Cached for 5s to keep polling cheap.
  _getActiveDayDirs(withinMs = ACTIVE_SESSION_WINDOW_MS) {
    const now = Date.now();
    if (this._activeDayDirsCache && now - this._activeDayDirsCacheAt < 5000) {
      return this._activeDayDirsCache;
    }
    const out = new Set();
    let years;
    try {
      years = fs.readdirSync(this._baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d{4}$/.test(d.name))
        .map((d) => d.name);
    } catch {
      this._activeDayDirsCache = [];
      this._activeDayDirsCacheAt = now;
      return [];
    }
    for (const y of years) {
      const yPath = path.join(this._baseDir, y);
      let months;
      try {
        months = fs.readdirSync(yPath, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
          .map((d) => d.name);
      } catch { continue; }
      for (const m of months) {
        const mPath = path.join(yPath, m);
        let days;
        try {
          days = fs.readdirSync(mPath, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name))
            .map((d) => d.name);
        } catch { continue; }
        for (const day of days) {
          const dPath = path.join(mPath, day);
          let files;
          try {
            files = fs.readdirSync(dPath);
          } catch { continue; }
          for (const file of files) {
            if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
            try {
              const mtime = fs.statSync(path.join(dPath, file)).mtimeMs;
              if (now - mtime < withinMs) {
                out.add(dPath);
                break;
              }
            } catch {}
          }
        }
      }
    }
    this._activeDayDirsCache = Array.from(out);
    this._activeDayDirsCacheAt = now;
    return this._activeDayDirsCache;
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

  _pollFile(filePath, fileName) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }

    const fileIdentity = this._getFileIdentity(stat);
    let tracked = this._tracked.get(filePath);
    if (tracked) {
      const identityChanged = tracked.fileIdentity !== null
        && fileIdentity !== null
        && tracked.fileIdentity !== fileIdentity;
      if (identityChanged || stat.size < tracked.offset) {
        tracked.offset = stat.size;
        tracked.fileIdentity = fileIdentity;
        this._readPositions.set(filePath, { offset: stat.size, identity: fileIdentity });
        return;
      }
    }
    if (!tracked) {
      // New file — extract session ID from filename
      // Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
      const sessionId = this._extractSessionId(fileName);
      if (!sessionId) return;
      // Cap tracked files to prevent unbounded Map growth
      if (this._tracked.size >= MAX_TRACKED_FILES) {
        this._pruneTrackedFilesIfNeeded();
        if (this._tracked.size >= MAX_TRACKED_FILES) return;
      }
      const retiredEntry = this._retiredTracked.get(filePath) || null;
      const savedPosition = this._readPositions.get(filePath) || null;
      const savedOffset = savedPosition && Number.isFinite(savedPosition.offset)
        ? savedPosition.offset
        : null;
      const sameFile = savedPosition
        && savedPosition.identity !== null
        && fileIdentity !== null
        && savedPosition.identity === fileIdentity;
      const retired = retiredEntry && (!savedPosition || sameFile) ? retiredEntry : null;
      const resumeOffset = savedPosition
        ? sameFile
          ? Math.min(savedOffset, stat.size)
          : stat.size
        : retired && stat.size >= retired.offset
          ? retired.offset
          : 0;
      if (retiredEntry) this._retiredTracked.delete(filePath);
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
        codexQuota: retired ? retired.codexQuota || null : null,
        codexSparkQuota: retired ? retired.codexSparkQuota || null : null,
        pendingUserInputs: retired && retired.pendingUserInputs instanceof Map
          ? new Map(retired.pendingUserInputs)
          : new Map(),
        initializingUserInputs: !retired,
        // Backfill mode: only a file whose last write predates monitor
        // start (by more than BACKFILL_GRACE_MS) is treated as stale
        // history — we replay it silently to advance offset + pick up
        // cwd/sessionTitle without emitting old transitions. Files written
        // inside the grace window are live sessions and emit normally.
        // Empty files have nothing to replay.
        backfilling:
          !retired &&
          !savedPosition &&
          stat.size > 0 &&
          stat.mtimeMs < this._startedAtMs - BACKFILL_GRACE_MS,
      };
      this._tracked.set(filePath, tracked);
      this._readPositions.set(filePath, { offset: resumeOffset, identity: fileIdentity });
    }

    // No new data
    if (stat.size <= tracked.offset) return;

    // Read incremental bytes. The file can shrink after statSync; readSync's
    // return value, not the earlier size, is authoritative.
    let fd = null;
    let buf;
    let bytesRead = 0;
    let openedStat;
    let openedIdentity = fileIdentity;
    try {
      fd = fs.openSync(filePath, "r");
      openedStat = fs.fstatSync(fd);
      openedIdentity = this._getFileIdentity(openedStat);
      const openedIdentityChanged = openedIdentity !== fileIdentity
        && (openedIdentity !== null || fileIdentity !== null);
      if (openedIdentityChanged || openedStat.size < tracked.offset) {
        tracked.offset = openedStat.size;
        tracked.fileIdentity = openedIdentity;
        this._readPositions.set(filePath, {
          offset: openedStat.size,
          identity: openedIdentity,
        });
        return;
      }
      const readLen = openedStat.size - tracked.offset;
      if (readLen <= 0) return;
      buf = Buffer.alloc(readLen);
      bytesRead = fs.readSync(fd, buf, 0, readLen, tracked.offset);
    } catch {
      return;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
    if (!Number.isFinite(bytesRead) || bytesRead <= 0) return;
    buf = buf.subarray(0, Math.min(bytesRead, buf.length));

    // Commit only complete newline-delimited bytes. An incomplete tail stays
    // behind the offset and will be reread on the next poll. Oversized lines
    // retain the existing 64KB discard behavior without retaining memory.
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      if (buf.length > MAX_PARTIAL_BYTES) {
        tracked.offset += buf.length;
        this._readPositions.set(filePath, { offset: tracked.offset, identity: openedIdentity });
      }
      return;
    }
    const committedBytes = lastNewline + 1;
    const text = buf.subarray(0, committedBytes).toString("utf8");
    tracked.offset += committedBytes;
    tracked.fileIdentity = openedIdentity;
    this._readPositions.set(filePath, { offset: tracked.offset, identity: openedIdentity });
    const lines = text.split("\n");
    lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      this._processLine(line, tracked);
    }

    // First pass drained the historical bytes we picked up on attach;
    // subsequent writes to this file are live and must emit normally.
    if (tracked.backfilling && tracked.offset >= openedStat.size) {
      this._emitBackfillSnapshot(tracked);
      tracked.backfilling = false;
    }
    if (tracked.initializingUserInputs) {
      tracked.initializingUserInputs = false;
      this._emitPendingUserInputRequests(tracked);
    }
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
      if (!tracked.backfilling && Number.isFinite(ts) && ts < this._startedAtMs - 1500) return;
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
    if (state === undefined) return; // unmapped event, skip
    if (state === null) return; // explicitly ignored
    tracked.lastStateEvent = key;

    // Track tool use per turn — reset on task_started, set on function_call
    if (key === "event_msg:task_started") {
      tracked.hadToolUse = false;
      tracked.assistantLastOutput = null;
      tracked.assistantLastOutputTruncated = false;
    }
    if (key === "response_item:function_call") {
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
      this._clearPendingUserInputsForTrackedSession(tracked);
      if (tracked.backfilling) return;
      this._emitStateChange(tracked, resolved, key, this._assistantOutputExtra(tracked));
      return;
    }

    // turn_aborted: same reasoning as task_complete above, just a different
    // terminal signal (the turn didn't finish, it was cut short).
    if (key === "event_msg:turn_aborted") {
      this._clearPendingUserInputsForTrackedSession(tracked);
    }

    // Backfill gate: first-pass replay of a file's historical content skips
    // every callback, but it still updates
    // internal state so attach can synthesize the current visible state once.
    // Independent of the timestamp-based replay guard, which only helps lines
    // that carry a timestamp field.
    if (tracked.backfilling) {
      tracked.lastState = state;
      return;
    }

    // Avoid spamming same state
    if (state === tracked.lastState && state === "working") return;
    tracked.lastState = state;
    this._emitStateChange(tracked, state, key);
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

  _pruneTrackedFilesIfNeeded() {
    if (this._tracked.size < MAX_TRACKED_FILES) return;
    const byAge = (a, b) => (a[1].lastEventTime || 0) - (b[1].lastEventTime || 0);
    const neverEmitted = [...this._tracked.entries()]
      .filter(([, tracked]) => tracked && !tracked.hasEmittedState)
      .sort(byAge);
    const emitted = [...this._tracked.entries()]
      .filter(([, tracked]) => tracked && tracked.hasEmittedState)
      .sort(byAge);
    for (const [filePath, tracked] of [...neverEmitted, ...emitted]) {
      if (this._tracked.size < MAX_TRACKED_FILES) break;
      this._retireTrackedFile(filePath, tracked);
    }
  }

  _retireTrackedFile(filePath, tracked) {
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
      hasQuota ? quotaExtra : null
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
  _clearPendingUserInputsForTrackedSession(tracked) {
    if (!(tracked.pendingUserInputs instanceof Map) || tracked.pendingUserInputs.size === 0) return;
    const callIds = [...tracked.pendingUserInputs.keys()];
    tracked.pendingUserInputs.clear();
    if (tracked.backfilling || tracked.initializingUserInputs || !this._onUserInputResolved) return;
    for (const callId of callIds) this._onUserInputResolved(tracked.sessionId, callId);
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
