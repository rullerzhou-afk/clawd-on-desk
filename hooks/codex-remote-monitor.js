#!/usr/bin/env node
// Codex CLI JSONL log monitor — standalone remote version
// Polls ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl for state changes
// and POSTs them via HTTP to the local Clawd desktop pet (through SSH tunnel).
//
// Zero external dependencies — Node.js built-ins + same-directory hook helpers only.
//
// Usage:
//   node codex-remote-monitor.js            # run as long-lived daemon
//   node codex-remote-monitor.js --once     # single scan then exit (debug)
//   node codex-remote-monitor.js --port 23334  # custom server port
//
// A bounded delivery watchdog allows temporary tunnel outages, but exits an
// orphaned monitor after 24 hours of attempted delivery with no success.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { classifySessionMeta } = require("./codex-subagent-fields");
const {
  clampAssistantOutputText,
  extractAssistantTextFromRecord,
} = require("./codex-assistant-output");
const {
  resolveCodexRateLimitReport,
  resolveCodexModelQuotaProvider,
  isFreshCodexQuotaTimestamp,
  CODEX_MAIN_QUOTA_PROVIDER,
  CODEX_SPARK_QUOTA_PROVIDER,
} = require("./codex-rate-limits");
const { parseCodexUserInputRecord } = require("./codex-user-input");

// ── Inline config from agents/codex.js (zero-dependency requirement) ──

function resolveCodexSessionDir(options = {}) {
  const env = options.env || process.env;
  const codexHome = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()
    ? env.CODEX_HOME.trim()
    : path.join(options.homeDir || os.homedir(), ".codex");
  return path.join(codexHome, "sessions");
}
const POLL_INTERVAL_MS = 1500;
const STALE_MS = 300000;
const DELIVERY_FAILURE_EXIT_MS = 24 * 60 * 60 * 1000;
const MAX_PARTIAL_BYTES = 65536;
const MAX_POLL_READ_BYTES = 4 * 1024 * 1024;
const MAX_POLL_TOTAL_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_POLL_FILE_ATTEMPTS = 64;
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

function createDeliveryWatchdog(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const exit = typeof options.exit === "function" ? options.exit : () => process.exit(0);
  const thresholdMs = Number.isFinite(options.thresholdMs) && options.thresholdMs > 0
    ? options.thresholdMs
    : DELIVERY_FAILURE_EXIT_MS;
  let lastSuccessAt = now();
  let exitTriggered = false;
  return {
    record(ok) {
      if (ok === true) {
        lastSuccessAt = now();
        return false;
      }
      if (!exitTriggered && now() - lastSuccessAt >= thresholdMs) {
        exitTriggered = true;
        exit();
        return true;
      }
      return false;
    },
    getLastSuccessAt() {
      return lastSuccessAt;
    },
  };
}

const deliveryWatchdog = createDeliveryWatchdog();
// Startup recovery sweep bounds (see recoverStalePendingUserInputEntry).
// Bounded head+tail reads, never a full readFileSync of an arbitrarily large
// rollout file. session_meta (cwd / subagent role) is always Codex's first
// record, but a real one can run past 30KB (long cwd, many tools, etc.) —
// this must be the full line or nothing, never a size guess: a truncated
// read makes JSON.parse fail, which silently defaults a subagent to "root"
// and shows it a card it should never get. An unresolved request_user_input
// is always near the end, since Codex stops writing once it's blocked on an
// answer.
const RECOVERY_HEAD_LINE_MAX_BYTES = 256 * 1024;
const RECOVERY_TAIL_SCAN_BYTES = 1024 * 1024;
// A file this old is abandoned, not "still waiting" — without this cap, a
// session killed with an unanswered question resurrects the same ghost card
// on every future restart, forever, since nothing else clears a card with no
// live process behind it. Bounds the damage; does not fully solve it. Checked
// against BOTH the file's mtime (cheap pre-filter) and the request's own
// embedded timestamp once found (authoritative — Codex Desktop can refresh a
// dormant file's mtime on focus without the pending question itself getting
// any newer).
const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Total budget for one startup sweep, across ALL stale candidate files —
// each file's own read is already bounded, but an unbounded NUMBER of
// candidates still adds up to unbounded blocking. Prioritized by
// most-recently-modified first, since a genuinely still-open question is far
// more likely to be sitting in a recently-touched file than an ancient one.
const RECOVERY_SWEEP_MAX_FILES = 20;
const RECOVERY_SWEEP_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function recoveryReadBudgetCost(size) {
  const safeSize = Number.isFinite(Number(size)) ? Math.max(0, Number(size)) : 0;
  // Head and tail are separate bounded reads and can overlap for small files.
  return Math.min(safeSize, RECOVERY_HEAD_LINE_MAX_BYTES)
    + Math.min(safeSize, RECOVERY_TAIL_SCAN_BYTES)
    + (safeSize > RECOVERY_TAIL_SCAN_BYTES ? 1 : 0);
}

function recoverySnapshotStatus(before, after) {
  if (!after) return "missing";
  if (after.size < before.size) return "changed";
  if (after.size > before.size) return "grew";
  if (after.mtimeMs !== before.mtimeMs) return "changed";
  return "stable";
}

function emitRecoveredPendingUserInputs(entry, options = {}) {
  if (!entry || entry.isSubagent) return;
  const postStateFn = typeof options.postState === "function" ? options.postState : postState;
  for (const request of entry.pendingUserInputs.values()) {
    postStateFn(entry.sessionId, "notification", "CodexUserInputRequest", entry.cwd, false, {
      codexUserInput: request,
    });
  }
}

// JSONL record type[:subtype] → pet state. This standalone remote monitor keeps
// a zero-dep subset of agents/codex.js because it posts final states directly
// and does not carry the full local monitor's turn-end/approval heuristics.
// Keep shared Codex JSONL event additions in sync where they affect both paths.
const LOG_EVENT_MAP = {
  "session_meta": "idle",
  "event_msg:task_started": "thinking",
  "event_msg:user_message": "thinking",
  "event_msg:agent_message": "working",
  "event_msg:guardian_assessment": "working",
  "response_item:function_call": "working",
  "response_item:custom_tool_call": "working",
  "response_item:web_search_call": "working",
  "event_msg:task_complete": "attention",
  "event_msg:context_compacted": "sweeping",
  "event_msg:turn_aborted": "idle",
};

// ── CLI args ──

const args = process.argv.slice(2);
const onceMode = args.includes("--once");
const portIndex = args.indexOf("--port");
const preferredPort = portIndex >= 0 ? parseInt(args[portIndex + 1], 10) : undefined;

const hostPrefix = readHostPrefix();

// ── State tracking ──

// Map<filePath, { offset, sessionId, cwd, lastEventTime, lastState }>
const tracked = new Map();
const replayWork = new Map();
const deferredRecent = new Map();
const deferredBackground = new Map();
let pollCursor = 0;
// One-shot startup recovery can span bounded poll slices while its path cursor
// checks files outside the 2-minute active window for a still-unresolved
// request_user_input. Once complete, later polls use the cheap mtime-only gate.
let didInitialRecoveryScan = false;
const startupRecoveryCandidates = new Map();
let startupRecoveryWalker = null;
let startupRecoveryReady = false;
let startupRecoveryFilesScanned = 0;
let startupRecoveryBytesScanned = 0;

// ── Core polling logic (mirrors agents/codex-log-monitor.js) ──

function getSessionDirs() {
  const dirs = [];
  const sessionDir = resolveCodexSessionDir();
  const now = new Date();
  for (let daysAgo = 0; daysAgo <= 1; daysAgo++) {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    dirs.push(path.join(sessionDir, String(yyyy), mm, dd));
  }
  return dirs;
}

function extractSessionId(fileName) {
  // rollout-2026-03-25T15-10-51-019d23d4-f1a9-7633-b9c7-758327137228.jsonl
  const base = fileName.replace(".jsonl", "");
  const parts = base.split("-");
  if (parts.length < 10) return null;
  return parts.slice(-5).join("-");
}

function buildPostStateBody(sessionId, state, event, cwd, isSubagent, host, extra = null) {
  const body = {
    state,
    session_id: sessionId,
    event,
    agent_id: "codex",
    cwd: cwd || "",
    host: host || hostPrefix,
    headless: isSubagent === true,
  };
  if (extra && typeof extra.assistantLastOutput === "string" && extra.assistantLastOutput) {
    body.assistant_last_output = extra.assistantLastOutput;
    if (extra.assistantLastOutputTruncated === true) body.assistant_last_output_truncated = true;
  }
  if (extra && extra.codexUserInput) {
    const request = extra.codexUserInput;
    body.codex_user_input = {
      phase: request.phase,
      call_id: request.callId,
    };
    if (request.phase === "request") {
      body.codex_user_input.questions = request.questions;
      if (request.autoResolutionMs) {
        body.codex_user_input.auto_resolution_ms = request.autoResolutionMs;
      }
    }
  }
  return JSON.stringify(body);
}

function postState(sessionId, state, event, cwd, isSubagent, extra = null) {
  const body = buildPostStateBody(sessionId, state, event, cwd, isSubagent, undefined, extra);
  postStateToRunningServer(
    body,
    { timeoutMs: 100, preferredPort, remote: true },
    (ok) => deliveryWatchdog.record(ok)
  );
}

// Subscription quota is telemetry, not lifecycle: it goes out as a
// metadata_only POST (same contract as the statusline scripts). The desktop
// stores it independently from session lifecycle and must never
// create/resurrect a session or touch its recentEvents/updatedAt. Keep the
// normal session_id namespace for the shared metadata-only transport contract.
function buildPostQuotaBody(sessionId, quotaReport, host) {
  const wireField = quotaReport && quotaReport.providerKey === CODEX_MAIN_QUOTA_PROVIDER
    ? "codex_quota"
    : (quotaReport && quotaReport.providerKey === CODEX_SPARK_QUOTA_PROVIDER
      ? "codex_spark_quota"
      : null);
  if (!wireField || !quotaReport.quota) return null;
  return JSON.stringify({
    state: "idle",
    preserve_state: true,
    metadata_only: true,
    session_id: sessionId,
    agent_id: "codex",
    host: host || hostPrefix,
    [wireField]: quotaReport.quota,
  });
}

function postQuota(sessionId, quotaReport) {
  const body = buildPostQuotaBody(sessionId, quotaReport, undefined);
  if (!body) return;
  postStateToRunningServer(
    body,
    { timeoutMs: 100, preferredPort, remote: true },
    (ok) => deliveryWatchdog.record(ok)
  );
}

function processLine(line, entry, options = {}) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return;
  }

  const type = obj.type;
  const payload = obj.payload;
  const subtype =
    payload && typeof payload === "object" ? payload.type || "" : "";
  const key = subtype ? type + ":" + subtype : type;

  // Extract CWD from session_meta
  if (type === "session_meta" && payload) {
    entry.cwd = payload.cwd || "";
    entry.isSubagent = classifySessionMeta(payload) === "subagent";
  }
  if (type === "turn_context" && payload && typeof payload === "object") {
    const providerHint = resolveCodexModelQuotaProvider(payload.model);
    if (providerHint) entry.codexQuotaProviderHint = providerHint;
  }

  const userInputRecord = parseCodexUserInputRecord(obj);
  if (userInputRecord) {
    if (!(entry.pendingUserInputs instanceof Map)) entry.pendingUserInputs = new Map();
    const postStateFn = typeof options.postState === "function" ? options.postState : postState;
    if (userInputRecord.phase === "request") {
      // #707 follow-up review round 4: the recovery sweep's own age cap only
      // protects files it actually opens (mtime outside the active window).
      // A file whose mtime got refreshed back into the active window
      // attaches here instead, with no age check at all. Only during the
      // initial catch-up read: reject a request whose OWN timestamp is
      // already past RECOVERY_MAX_AGE_MS. A live request encountered after
      // that never fails this check — it's freshly-timestamped by definition.
      if (entry.initializing) {
        const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
        if (Number.isFinite(ts) && Date.now() - ts > RECOVERY_MAX_AGE_MS) return;
      }
      entry.pendingUserInputs.set(userInputRecord.callId, userInputRecord);
      // A blocking question is itself a real, live event — refresh the same
      // staleness bookkeeping the generic event path below updates.
      // Otherwise a session idle long enough to be near STALE_MS gets its
      // notification posted here and is immediately flipped back to
      // "sleeping" by the very next cleanStaleFiles() poll (#707 follow-up).
      entry.lastEventTime = Date.now();
      entry.lastState = "notification";
      entry.stale = false;
      if (!entry.isSubagent && !entry.initializing) {
        postStateFn(entry.sessionId, "notification", "CodexUserInputRequest", entry.cwd, false, {
          codexUserInput: userInputRecord,
        });
      }
      return;
    }
    if (!entry.pendingUserInputs.has(userInputRecord.callId)) return;
    entry.pendingUserInputs.delete(userInputRecord.callId);
    entry.lastEventTime = Date.now();
    entry.lastState = "idle";
    entry.stale = false;
    if (!entry.isSubagent && !entry.initializing) {
      postStateFn(entry.sessionId, "idle", "CodexUserInputResolved", entry.cwd, false, {
        codexUserInput: userInputRecord,
      });
    }
    return;
  }

  const assistantText = extractAssistantTextFromRecord(obj);
  if (assistantText) {
    const assistantOutput = clampAssistantOutputText(assistantText);
    entry.assistantLastOutput = assistantOutput ? assistantOutput.text : null;
    entry.assistantLastOutputTruncated = !!(assistantOutput && assistantOutput.truncated);
  }

  // token_count is deliberately NOT in LOG_EVENT_MAP (telemetry, not
  // lifecycle) — but it is the only carrier of the account's subscription
  // rate limits. Freshness-gated on the line's own timestamp: pollFile
  // re-reads recent files from offset 0 after a monitor restart, and a
  // replayed line's quota posted now would stamp fresh arbitration
  // metadata (metadataUpdatedAt) on stale data.
  if (key === "event_msg:token_count") {
    // capturedAt = the line's own timestamp: lets the desktop's account
    // store order this report by observation time, not tunnel arrival time.
    const quotaReport = isFreshCodexQuotaTimestamp(obj.timestamp)
      ? resolveCodexRateLimitReport(payload, {
        capturedAt: Date.parse(obj.timestamp),
        providerHint: entry.codexQuotaProviderHint,
      })
      : null;
    if (quotaReport) {
      const postQuotaFn = typeof options.postQuota === "function" ? options.postQuota : postQuota;
      postQuotaFn(entry.sessionId, quotaReport);
    }
    return;
  }

  const state = LOG_EVENT_MAP[key];
  if (state === undefined || state === null) return;
  const finalState = entry.isSubagent && state === "attention" ? "idle" : state;
  if (key === "event_msg:task_started") {
    entry.assistantLastOutput = null;
    entry.assistantLastOutputTruncated = false;
  }

  // Avoid spamming same state — but never swallow the event when the session
  // is stale: after a "sleeping" post, the next working event must wake the pet
  // back up (post working, refresh lastEventTime, clear stale). Without the
  // `!entry.stale` guard a session whose last state was "working" would stay
  // asleep through every subsequent working event until a state change.
  if (finalState === entry.lastState && finalState === "working" && !entry.stale) return;
  entry.lastState = finalState;
  entry.lastEventTime = Date.now();
  // A real event re-activates the session, so a later idle window re-arms the
  // one-shot "sleeping" post in cleanStaleFiles.
  entry.stale = false;

  const postStateFn = typeof options.postState === "function" ? options.postState : postState;

  // task_complete/turn_aborted means the turn that asked is over — any
  // question still open for it is moot, Codex will not consume an answer
  // after this. Mirrors agents/codex-log-monitor.js's local-monitor fix.
  if (
    (key === "event_msg:task_complete" || key === "event_msg:turn_aborted")
    && entry.pendingUserInputs instanceof Map
    && entry.pendingUserInputs.size > 0
  ) {
    const abandonedCallIds = [...entry.pendingUserInputs.keys()];
    entry.pendingUserInputs.clear();
    if (!entry.isSubagent && !entry.initializing) {
      for (const callId of abandonedCallIds) {
        postStateFn(entry.sessionId, "idle", "CodexUserInputResolved", entry.cwd, false, {
          codexUserInput: { phase: "resolved", callId },
        });
      }
    }
  }

  const extra = key === "event_msg:task_complete" && entry.assistantLastOutput
    ? {
      assistantLastOutput: entry.assistantLastOutput,
      assistantLastOutputTruncated: entry.assistantLastOutputTruncated === true,
    }
    : null;
  postStateFn(entry.sessionId, finalState, key, entry.cwd, entry.isSubagent, extra);
}

// Cheap, standalone pass over an otherwise-ignored file's own
// request_user_input records — does not touch `tracked` and does not run
// the normal event pipeline. Used only by poll()'s one-time startup sweep to
// decide whether a file outside the active window is worth attaching to.
// Returns a ready-to-track entry whose offset stops after the last complete
// newline in the recovery window; an incomplete tail remains on disk for the
// normal poll to reread after it is completed.
// If found, also emits the recovered CodexUserInputRequest(s) directly —
// pollFile is deliberately NOT called on the same file, because it has no
// backfill/silent-replay concept and would replay this file's entire
// ordinary history as if it were live.
// Returns { text, bytesRead, buf }. bytesRead is the TRUE byte count read from
// disk — callers doing offset math must use it, not Buffer.byteLength(text):
// if `start` lands mid-character in a multi-byte UTF-8 sequence (any
// non-ASCII content — CJK cwd/output is common), decoding replaces the
// truncated leading bytes with U+FFFD, whose own UTF-8 length does not equal
// the raw bytes it replaced. Re-deriving the byte count from the decoded
// string can overshoot the file's true size, and an offset past real EOF
// either silently skips the next genuine write forever or gets misread
// elsewhere as a truncated/rotated file and triggers a full replay from 0 —
// the exact unbounded read this sweep exists to avoid.
function readByteRange(filePath, start, length) {
  if (length <= 0) return { text: "", bytesRead: 0, buf: Buffer.alloc(0) };
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, start);
    return {
      text: buf.toString("utf8", 0, bytesRead),
      bytesRead,
      buf: buf.subarray(0, bytesRead),
    };
  } catch {
    return { text: "", bytesRead: 0, buf: Buffer.alloc(0) };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// Grows the read window from byte 0 until it captures a complete
// (newline-terminated) first line, up to maxBytes. Never returns a line that
// might have been truncated by an arbitrary window cutoff — a fixed small
// read guessing "session_meta always fits in N KB" is exactly how a
// subagent's role silently defaults to "root" (JSON.parse throws on the
// truncated fragment, the caller sees no session_meta at all, and the safe
// default becomes indistinguishable from "there was none"). Returns null if
// no newline is found within budget — the caller must fail closed, not
// guess a role.
function readCompleteFirstLine(filePath, statSize, maxBytes) {
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
    const { bytesRead, buf } = readByteRange(filePath, readSoFar, requestLength);
    if (!Number.isFinite(bytesRead) || bytesRead <= 0) return null;
    chunks.push(buf);
    readSoFar += bytesRead;
    const raw = Buffer.concat(chunks, readSoFar);
    const newlineIdx = raw.indexOf(0x0a);
    if (newlineIdx !== -1) return raw.subarray(0, newlineIdx).toString("utf8");
  }
  return null;
}

function readExactRange(filePath, start, length) {
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
    const result = readByteRange(filePath, start + bytesReadTotal, requestLength);
    if (!result || !Number.isFinite(result.bytesRead) || result.bytesRead <= 0) break;
    chunks.push(result.buf);
    bytesReadTotal += result.bytesRead;
  }
  return {
    buf: Buffer.concat(chunks, bytesReadTotal),
    complete: bytesReadTotal === length,
  };
}

// Bounded, standalone pass over an otherwise-ignored old file — does not
// run processLine's normal event pipeline and never reads more than a fixed
// head+tail window, regardless of file size. Used only by runRecoverySweep.
// Returns a ready-to-track entry (offset already caught up, so normal
// polling only reads NEW bytes from here on), also emitting the recovered
// CodexUserInputRequest(s) directly — or null if nothing is genuinely still
// pending or the file's role can't be confirmed safely.
//
// A request is "still pending" only up to the next task_complete/
// turn_aborted within the scanned window — those end the turn that asked,
// so any earlier open request is moot even without a matching
// function_call_output (Codex killed mid-turn, terminal closed, etc. leave
// exactly this shape). Mirrors agents/codex-log-monitor.js's local fix.
function recoverStalePendingUserInputEntry(filePath, fileName, options = {}) {
  let stat = options.preStat || null;
  if (!stat) {
    try {
      stat = fs.statSync(filePath);
    } catch {
      return null;
    }
  }
  if (stat.size === 0 || Date.now() - stat.mtimeMs > RECOVERY_MAX_AGE_MS) return null;
  const sessionId = extractSessionId(fileName);
  if (!sessionId) return null;

  // Head: session_meta (cwd + subagent role) is always Codex's first record.
  // Fail closed (skip this file entirely) if we can't read a complete first
  // line or it isn't session_meta — showing a card is the wrong default when
  // we genuinely don't know whether this is a subagent.
  const firstLine = readCompleteFirstLine(filePath, stat.size, RECOVERY_HEAD_LINE_MAX_BYTES);
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
  // fail-closed protection above), so only "subagent" flips isSubagent —
  // matches the live path's default-to-root-unless-explicitly-subagent
  // behavior.
  const isSubagent = classifySessionMeta(sessionMeta.payload) === "subagent";

  const tailLen = Math.min(stat.size, RECOVERY_TAIL_SCAN_BYTES);
  const tailStart = stat.size - tailLen;
  // A non-zero tailStart can still be an exact record boundary. Inspect the
  // preceding byte before deciding whether the first scanned line is only a
  // fragment; otherwise a request starting exactly 1 MiB from EOF is lost.
  const preceding = tailStart === 0
    ? { buf: Buffer.from([0x0a]), complete: true }
    : readExactRange(filePath, tailStart - 1, 1);
  if (!preceding.complete) return null;
  const tailStartsOnRecordBoundary = tailStart === 0 || preceding.buf[0] === 0x0a;
  const tailRead = readExactRange(filePath, tailStart, tailLen);
  if (!tailRead.complete) return null;
  let readPostStat = null;
  try {
    readPostStat = fs.statSync(filePath);
  } catch {}
  const readSnapshotStatus = recoverySnapshotStatus(stat, readPostStat);
  if (readSnapshotStatus === "missing" || readSnapshotStatus === "changed") return null;
  const lastNewlineInTail = tailRead.buf.lastIndexOf(0x0a);
  if (lastNewlineInTail < 0) return null;
  const committedTailBytes = lastNewlineInTail + 1;
  const tailText = tailRead.buf.toString("utf8", 0, committedTailBytes);
  const rawLines = tailText.split("\n");
  // Drop the first fragment only when the preceding byte proves the window
  // really started mid-line. At an exact newline boundary, the first line is
  // a complete record and must be retained.
  if (!tailStartsOnRecordBoundary) rawLines.shift();
  rawLines.pop();

  const pending = new Map();
  const pendingTimestampMs = new Map();
  for (const line of rawLines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
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
  if (pending.size === 0) return null;

  // mtime alone isn't a reliable age signal — Codex Desktop can refresh a
  // dormant file's mtime (e.g. on focus) without the pending question itself
  // getting any newer. Cross-check against the oldest request's own
  // timestamp where we have one; a stale question must not survive just
  // because something else touched the file.
  const knownTimestamps = [...pendingTimestampMs.values()].filter((ts) => ts !== null);
  if (knownTimestamps.length > 0 && Date.now() - Math.min(...knownTimestamps) > RECOVERY_MAX_AGE_MS) {
    return null;
  }

  const entry = {
    // Stop after the last complete newline. The incomplete tail remains on
    // disk and is reread whole by pollFile after it is completed.
    offset: tailStart + committedTailBytes,
    sessionId: "codex:" + sessionId,
    cwd,
    isSubagent,
    lastEventTime: Date.now(),
    lastState: "notification",
    assistantLastOutput: null,
    assistantLastOutputTruncated: false,
    codexQuotaProviderHint: null,
    pendingUserInputs: pending,
    initializing: false,
    stale: false,
  };

  if (options.deferEmit !== true) emitRecoveredPendingUserInputs(entry, options);
  return entry;
}

function pollFile(filePath, fileName, options = {}) {
  const now = typeof options.now === "function" ? options.now() : Date.now();
  const existingEntry = tracked.get(filePath) || null;
  if (
    existingEntry
    && Number.isFinite(existingEntry.readBackoffUntil)
    && now < existingEntry.readBackoffUntil
  ) {
    return { kind: "backoff", requestedBytes: 0, bytesRead: 0 };
  }
  let stat;
  try {
    stat = options.preStat || fs.statSync(filePath);
  } catch {
    markRemoteReplayNoProgress(filePath, tracked.get(filePath), options);
    return { kind: "error", requestedBytes: 0, bytesRead: 0 };
  }

  let entry = tracked.get(filePath);
  if (!entry) {
    const sessionId = extractSessionId(fileName);
    if (!sessionId) return { kind: "ignored", requestedBytes: 0, bytesRead: 0 };
    entry = {
      offset: 0,
      sessionId: "codex:" + sessionId,
      cwd: "",
      isSubagent: false,
      lastEventTime: Date.now(),
      lastState: null,
      assistantLastOutput: null,
      assistantLastOutputTruncated: false,
      codexQuotaProviderHint: null,
      pendingUserInputs: new Map(),
      initializing: true,
      stale: false,
    };
    if (!admitRemoteReplay(filePath, fileName, entry, stat)) {
      return { kind: "deferred", requestedBytes: 0, bytesRead: 0 };
    }
    tracked.set(filePath, entry);
  } else if (entry.initializing && !replayWork.has(filePath)) {
    if (!admitRemoteReplay(filePath, fileName, entry, stat)) {
      tracked.delete(filePath);
      return { kind: "deferred", requestedBytes: 0, bytesRead: 0 };
    }
  }

  // Truncation guard: a retained offset can outlive the bytes it points into.
  // If the file is now smaller than our offset the offset is meaningless —
  // restart from 0 and clear staged pending input, otherwise we'd skip the
  // whole replacement forever. Incomplete JSONL tails stay on disk and do not
  // have a separate in-memory partial buffer.
  //
  // Known limitation (size-only): this does NOT catch a same-size or larger
  // in-place replacement of a same-named file — only file-identity tracking
  // (dev/ino, + a Windows ctime fallback) would. We deliberately don't do that:
  // Codex rollout files are append-only and uniquely named
  // (rollout-<ISO ts>-<uuid>.jsonl), never rewritten/recreated in place, so the
  // uncaught cases can't occur in practice and aren't worth the cross-platform
  // identity bookkeeping on an already-large monitor.
  if (stat.size < entry.offset) {
    if (entry.pendingUserInputs instanceof Map) entry.pendingUserInputs.clear();
    entry.offset = 0;
    entry.initializing = true;
    replayWork.delete(filePath);
    if (!admitRemoteReplay(filePath, fileName, entry, stat)) {
      tracked.delete(filePath);
      return { kind: "deferred", requestedBytes: 0, bytesRead: 0 };
    }
  }

  if (Number.isFinite(entry.readBackoffUntil) && now < entry.readBackoffUntil) {
    return { kind: "backoff", requestedBytes: 0, bytesRead: 0 };
  }
  recordRemoteValidatedSnapshot(filePath, stat.size);
  if (stat.size <= entry.offset) {
    finalizeRemoteReplay(filePath, entry, options);
    return { kind: "eof", requestedBytes: 0, bytesRead: 0 };
  }

  let buf;
  let fd = null;
  let bytesRead = 0;
  let readLen = 0;
  const readStartOffset = entry.offset;
  try {
    fd = fs.openSync(filePath, "r");
    readLen = Math.min(stat.size - entry.offset, MAX_POLL_READ_BYTES);
    if (
      options.pollContext
      && Number.isFinite(options.pollContext.remainingRequestBytes)
      && options.pollContext.remainingRequestBytes < readLen
    ) {
      return { kind: "budget", requestedBytes: 0, bytesRead: 0 };
    }
    if (options.pollContext && Number.isFinite(options.pollContext.remainingRequestBytes)) {
      options.pollContext.remainingRequestBytes -= readLen;
    }
    buf = Buffer.alloc(readLen);
    bytesRead = fs.readSync(fd, buf, 0, readLen, entry.offset);
  } catch {
    markRemoteReplayNoProgress(filePath, entry, options);
    return { kind: "error", requestedBytes: readLen, bytesRead: 0 };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  if (!Number.isFinite(bytesRead) || bytesRead <= 0) {
    markRemoteReplayNoProgress(filePath, entry, options);
    return { kind: "no-progress", requestedBytes: readLen, bytesRead: 0 };
  }
  buf = buf.subarray(0, Math.min(bytesRead, buf.length));
  const scannedToSnapshotEnd = readStartOffset + bytesRead >= stat.size;
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    const fullRead = bytesRead === readLen;
    const mayDiscard = buf.length > MAX_PARTIAL_BYTES
      && fullRead
      && (readLen === MAX_POLL_READ_BYTES || scannedToSnapshotEnd);
    if (mayDiscard) {
      entry.offset += bytesRead;
      markRemoteReplayProgress(filePath, entry);
    } else if (!scannedToSnapshotEnd) {
      markRemoteReplayNoProgress(filePath, entry, options);
    }
    if (scannedToSnapshotEnd) finalizeRemoteReplay(filePath, entry, options);
    return {
      kind: mayDiscard ? "discarded" : "incomplete",
      requestedBytes: readLen,
      bytesRead,
    };
  }

  const committedBytes = lastNewline + 1;
  const text = buf.subarray(0, committedBytes).toString("utf8");
  entry.offset += committedBytes;
  markRemoteReplayProgress(filePath, entry);
  const lines = text.split("\n");
  lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;
    processLine(line, entry, options);
  }
  if (scannedToSnapshotEnd) finalizeRemoteReplay(filePath, entry, options);
  return { kind: "progress", requestedBytes: readLen, bytesRead };
}

function admitRemoteReplay(filePath, fileName, entry, stat) {
  if (replayWork.has(filePath)) return true;
  const deferred = deferredRecent.get(filePath) || deferredBackground.get(filePath);
  const lane = Date.now() - stat.mtimeMs <= 120000 ? "recent" : "background";
  let backgroundCount = 0;
  for (const item of replayWork.values()) {
    if (item.lane === "background") backgroundCount += 1;
  }
  if (
    replayWork.size >= MAX_REPLAY_WORK_ITEMS
    || (lane === "background" && backgroundCount >= MAX_BACKGROUND_REPLAY_WORK_ITEMS)
  ) {
    enqueueRemoteDeferred(filePath, fileName, stat, lane);
    return false;
  }
  replayWork.set(filePath, {
    filePath,
    fileName,
    entry,
    lane,
    consecutiveNoProgress: 0,
    lastProgressAt: Date.now(),
    hasValidatedSnapshot: false,
    lastValidatedSnapshotSize: null,
    retryLevel: deferred && Number.isFinite(deferred.retryLevel) ? deferred.retryLevel : 0,
  });
  deferredRecent.delete(filePath);
  deferredBackground.delete(filePath);
  return true;
}

function enqueueRemoteDeferred(filePath, fileName, stat, forcedLane = null, retry = null) {
  const lane = forcedLane || (Date.now() - stat.mtimeMs <= 120000 ? "recent" : "background");
  const queue = lane === "recent" ? deferredRecent : deferredBackground;
  const limit = lane === "recent" ? MAX_DEFERRED_RECENT_PATHS : MAX_DEFERRED_BACKGROUND_PATHS;
  if (queue.has(filePath)) queue.delete(filePath);
  queue.set(filePath, {
    filePath,
    fileName,
    lane,
    mtimeMs: stat.mtimeMs,
    notBefore: retry && Number.isFinite(retry.notBefore) ? retry.notBefore : 0,
    retryLevel: retry && Number.isFinite(retry.retryLevel) ? retry.retryLevel : 0,
  });
  while (queue.size > limit) queue.delete(queue.keys().next().value);
}

function backoffRemoteDeferredStatFailure(entry, options = {}) {
  if (!entry) return;
  const retryLevel = Math.min(5, Math.max(0, Number(entry.retryLevel) || 0) + 1);
  const backoffMs = Math.min(
    REPLAY_RETRY_MAX_BACKOFF_MS,
    REPLAY_RETRY_BASE_BACKOFF_MS * (2 ** (retryLevel - 1))
  );
  const now = typeof options.now === "function" ? options.now() : Date.now();
  entry.retryLevel = retryLevel;
  entry.notBefore = now + backoffMs;
}

function recordRemoteValidatedSnapshot(filePath, snapshotSize) {
  const item = replayWork.get(filePath);
  if (!item) return;
  item.hasValidatedSnapshot = true;
  item.lastValidatedSnapshotSize = snapshotSize;
}

function markRemoteReplayProgress(filePath, entry) {
  const item = replayWork.get(filePath);
  if (item) {
    item.consecutiveNoProgress = 0;
    item.lastProgressAt = Date.now();
    item.retryLevel = 0;
  }
  if (entry) {
    entry.readBackoffUntil = 0;
    entry.readBackoffLevel = 0;
  }
}

function markRemoteReplayNoProgress(filePath, entry, options = {}) {
  const item = replayWork.get(filePath);
  if (!entry) return;
  if (!item) {
    scheduleRemotePostBaselineReadBackoff(entry, options);
    return;
  }
  item.consecutiveNoProgress += 1;
  const now = typeof options.now === "function" ? options.now() : Date.now();
  if (
    item.consecutiveNoProgress < MAX_REPLAY_NO_PROGRESS_ATTEMPTS
    || now - item.lastProgressAt < REPLAY_NO_PROGRESS_TIMEOUT_MS
  ) return;
  const retryLevel = Math.min(
    5,
    Math.max(Number(entry.readBackoffLevel) || 0, Number(item.retryLevel) || 0) + 1
  );
  const backoffMs = Math.min(
    REPLAY_RETRY_MAX_BACKOFF_MS,
    REPLAY_RETRY_BASE_BACKOFF_MS * (2 ** (retryLevel - 1))
  );
  if (!item.hasValidatedSnapshot) {
    if (entry.pendingUserInputs instanceof Map) entry.pendingUserInputs.clear();
    tracked.delete(filePath);
    replayWork.delete(filePath);
    enqueueRemoteDeferred(filePath, item.fileName, { mtimeMs: now }, item.lane, {
      notBefore: now + backoffMs,
      retryLevel,
    });
    return;
  }
  if (entry.pendingUserInputs instanceof Map) entry.pendingUserInputs.clear();
  entry.offset = item.lastValidatedSnapshotSize;
  entry.initializing = false;
  entry.readBackoffUntil = now + backoffMs;
  entry.readBackoffLevel = retryLevel;
  replayWork.delete(filePath);
}

function scheduleRemotePostBaselineReadBackoff(entry, options = {}) {
  if (!entry || !(Number(entry.readBackoffLevel) > 0)) return false;
  const now = typeof options.now === "function" ? options.now() : Date.now();
  if (Number.isFinite(entry.readBackoffUntil) && now < entry.readBackoffUntil) return true;
  const retryLevel = Math.min(5, Number(entry.readBackoffLevel) + 1);
  const backoffMs = Math.min(
    REPLAY_RETRY_MAX_BACKOFF_MS,
    REPLAY_RETRY_BASE_BACKOFF_MS * (2 ** (retryLevel - 1))
  );
  entry.readBackoffUntil = now + backoffMs;
  entry.readBackoffLevel = retryLevel;
  return true;
}

function finalizeRemoteReplay(filePath, entry, options = {}) {
  if (!entry || !entry.initializing) {
    replayWork.delete(filePath);
    return;
  }
  entry.initializing = false;
  const inWindow = options.inWindow !== false;
  if (!inWindow) {
    if (entry.pendingUserInputs instanceof Map) entry.pendingUserInputs.clear();
    replayWork.delete(filePath);
    return;
  }
  if (!entry.isSubagent && entry.pendingUserInputs instanceof Map) {
    const postStateFn = typeof options.postState === "function" ? options.postState : postState;
    for (const request of entry.pendingUserInputs.values()) {
      postStateFn(entry.sessionId, "notification", "CodexUserInputRequest", entry.cwd, false, {
        codexUserInput: request,
      });
    }
  }
  replayWork.delete(filePath);
}

// Post a one-shot "sleeping" after a session goes idle, but KEEP the tracked
// entry (and its byte offset). Deleting it used to drop the offset, so a later
// resume of the same rollout file re-attached at offset 0 and re-read the whole
// JSONL — re-emitting historical terminal events (task_complete) as fresh ones,
// which double-fired completion notifications and dashboard state. Retaining the
// offset means a resume only ever processes newly appended lines.
function cleanStaleFiles(options = {}) {
  const now = typeof options.now === "function" ? options.now() : Date.now();
  const postStateFn = typeof options.postState === "function" ? options.postState : postState;
  for (const [, entry] of tracked) {
    // Initial replay can legitimately span minutes under the bounded 4 MiB /
    // file and 16 MiB / poll budgets. Its lastEventTime describes attach or a
    // staged historical record, not a committed live-idle interval. Publishing
    // sleeping before replay reaches its snapshot EOF creates a false state
    // transition that the initialization gate is meant to suppress.
    if (entry.initializing) continue;
    if (!entry.stale && now - entry.lastEventTime > STALE_MS) {
      postStateFn(entry.sessionId, "sleeping", "stale-cleanup", entry.cwd, entry.isSubagent);
      entry.stale = true;
    }
  }
}

// Memory bound: poll() only ever reads files under today/yesterday dirs, so a
// rollout file outside that window can never be re-attached and its retained
// entry is dead weight. Drop entries whose directory left the scan window
// (e.g. once the day rolls over). Directory membership is race-free, unlike a
// readdir listing, so an in-window file is never wrongly pruned mid-flight.
function pruneTrackedOutOfWindow(options = {}) {
  const dirs = (typeof options.getSessionDirs === "function" ? options.getSessionDirs : getSessionDirs)();
  const inWindow = new Set(dirs);
  for (const filePath of Array.from(tracked.keys())) {
    if (!inWindow.has(path.dirname(filePath)) && !replayWork.has(filePath)) tracked.delete(filePath);
  }
}

function runRecoverySweep(candidates, options = {}) {
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
    // over-budget candidate slip through every time the running total lands
    // just under the cap (#707 follow-up review round 4).
    if (bytesScanned + candidateCost > RECOVERY_SWEEP_MAX_TOTAL_BYTES) break;
    filesScanned += 1;
    bytesScanned += candidateCost;
    const recovered = recoverStalePendingUserInputEntry(candidate.filePath, candidate.file, {
      ...options,
      preStat: stat,
      deferEmit: true,
    });
    let postStat = null;
    try {
      postStat = fs.statSync(candidate.filePath);
    } catch {}
    const snapshotStatus = recoverySnapshotStatus(stat, postStat);
    if (snapshotStatus === "missing" || snapshotStatus === "changed") continue;
    if (recovered) {
      tracked.set(candidate.filePath, recovered);
      emitRecoveredPendingUserInputs(recovered, options);
    }
  }
}

function collectRemoteDeferredCandidates() {
  const out = [];
  const now = Date.now();
  const recent = [...deferredRecent.values()]
    .filter((entry) => !Number.isFinite(entry.notBefore) || entry.notBefore <= now);
  const background = [...deferredBackground.values()]
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

function insertRemoteRecoveryCandidate(candidate) {
  startupRecoveryCandidates.set(candidate.filePath, candidate);
  if (startupRecoveryCandidates.size <= RECOVERY_SWEEP_MAX_FILES) return;
  let oldestPath = null;
  let oldestMtime = Infinity;
  for (const [filePath, entry] of startupRecoveryCandidates) {
    if (entry.mtimeMs < oldestMtime) {
      oldestMtime = entry.mtimeMs;
      oldestPath = filePath;
    }
  }
  if (oldestPath) startupRecoveryCandidates.delete(oldestPath);
}

function walkRemoteStartupRecoveryDiscovery(dirs, context) {
  if (!startupRecoveryWalker) {
    startupRecoveryWalker = {
      dirs: [...dirs],
      dirIndex: 0,
      files: null,
      fileIndex: 0,
    };
  }
  const walker = startupRecoveryWalker;
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
    const deferred = deferredRecent.get(filePath) || deferredBackground.get(filePath);
    if (
      stat
      && !tracked.has(filePath)
      && !(deferred && Date.now() < deferred.notBefore)
      && Date.now() - stat.mtimeMs > 120000
    ) {
      insertRemoteRecoveryCandidate({
        filePath,
        file,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }
  }
  if (walker.dirIndex >= walker.dirs.length) {
    startupRecoveryWalker = null;
    startupRecoveryReady = true;
  }
  return observed;
}

function runReadyRemoteRecovery(context) {
  const candidates = [...startupRecoveryCandidates.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  let pausedForAttempts = false;
  for (const candidate of candidates) {
    if (startupRecoveryFilesScanned >= RECOVERY_SWEEP_MAX_FILES) break;
    if (context.remainingAttempts <= 0) {
      pausedForAttempts = true;
      break;
    }
    context.remainingAttempts -= 1;
    const deferred = deferredRecent.get(candidate.filePath) || deferredBackground.get(candidate.filePath);
    let stat = null;
    try {
      stat = fs.statSync(candidate.filePath);
    } catch {}
    // A cached recovery candidate is advisory only. Normal polling may have
    // attached or deferred the path while discovery was paused across polls;
    // never replace that newer state or emit its pending request twice.
    if (
      !stat
      || tracked.has(candidate.filePath)
      || replayWork.has(candidate.filePath)
      || deferred
      || Date.now() - stat.mtimeMs <= 120000
    ) {
      startupRecoveryCandidates.delete(candidate.filePath);
      continue;
    }
    const candidateCost = recoveryReadBudgetCost(stat.size);
    if (startupRecoveryBytesScanned + candidateCost > RECOVERY_SWEEP_MAX_TOTAL_BYTES) break;
    startupRecoveryFilesScanned += 1;
    startupRecoveryBytesScanned += candidateCost;
    const recoveryOptions = { ...(context.options || {}), preStat: stat, deferEmit: true };
    const recovered = recoverStalePendingUserInputEntry(
      candidate.filePath,
      candidate.file,
      recoveryOptions
    );
    let postStat = null;
    try {
      postStat = fs.statSync(candidate.filePath);
    } catch {}
    const snapshotStatus = recoverySnapshotStatus(stat, postStat);
    if (snapshotStatus === "missing") {
      startupRecoveryCandidates.delete(candidate.filePath);
      continue;
    }
    if (snapshotStatus === "changed") {
      pausedForAttempts = true;
      continue;
    }
    if (recovered) {
      tracked.set(candidate.filePath, recovered);
      emitRecoveredPendingUserInputs(recovered, recoveryOptions);
    } else if (snapshotStatus === "grew") {
      pausedForAttempts = true;
      continue;
    }
    // A recovery pass may span polls when the shared attempt budget is spent.
    // Retire completed candidates so resuming cannot emit them twice.
    startupRecoveryCandidates.delete(candidate.filePath);
  }
  if (pausedForAttempts) return false;
  didInitialRecoveryScan = true;
  startupRecoveryReady = false;
  startupRecoveryCandidates.clear();
  startupRecoveryWalker = null;
  startupRecoveryFilesScanned = 0;
  startupRecoveryBytesScanned = 0;
  return true;
}

function poll(options = {}) {
  const getDirs = typeof options.getSessionDirs === "function"
    ? options.getSessionDirs
    : getSessionDirs;
  const dirs = getDirs();
  const inWindow = new Set(dirs);
  const context = {
    remainingAttempts: MAX_POLL_FILE_ATTEMPTS,
    remainingRequestBytes: MAX_POLL_TOTAL_REQUEST_BYTES,
    options,
  };
  const startupObserved = !didInitialRecoveryScan && !startupRecoveryReady
    ? walkRemoteStartupRecoveryDiscovery(dirs, context)
    : new Map();
  if (startupRecoveryReady && !didInitialRecoveryScan) runReadyRemoteRecovery(context);
  const candidates = [];
  for (const deferred of collectRemoteDeferredCandidates()) {
    candidates.push({ ...deferred, source: "deferred" });
  }
  for (const item of replayWork.values()) {
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
    const start = pollCursor % unique.length;
    const ordered = unique.slice(start).concat(unique.slice(0, start));
    let processed = 0;
    for (const candidate of ordered) {
      if (context.remainingAttempts <= 0) break;
      const deferred = deferredRecent.get(candidate.filePath) || deferredBackground.get(candidate.filePath);
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
          backoffRemoteDeferredStatFailure(deferred, options);
        } else {
          markRemoteReplayNoProgress(candidate.filePath, tracked.get(candidate.filePath), options);
        }
        processed += 1;
        continue;
      }
      if (
        candidate.source === "normal"
        && !tracked.has(candidate.filePath)
        && Date.now() - stat.mtimeMs > 120000
      ) {
        processed += 1;
        continue;
      }
      const result = pollFile(candidate.filePath, candidate.fileName, {
        ...options,
        preStat: stat,
        pollContext: context,
        inWindow: inWindow.has(path.dirname(candidate.filePath)),
      });
      if (result && result.kind === "budget") break;
      processed += 1;
    }
    pollCursor = (start + Math.max(1, processed)) % unique.length;
  }

  if (startupRecoveryReady && !didInitialRecoveryScan && context.remainingAttempts > 0) {
    runReadyRemoteRecovery(context);
  }
  cleanStaleFiles(options);
  pruneTrackedOutOfWindow({ getSessionDirs: () => dirs });
}

function main() {
  console.log(`Clawd Codex remote monitor started`);
  console.log(`  Session dir: ${resolveCodexSessionDir()}`);
  console.log(`  Poll interval: ${POLL_INTERVAL_MS}ms`);
  if (preferredPort) console.log(`  Preferred port: ${preferredPort}`);
  console.log(`  Press Ctrl+C to stop\n`);

  poll();

  if (!onceMode) {
    const interval = setInterval(poll, POLL_INTERVAL_MS);

    process.on("SIGINT", () => {
      clearInterval(interval);
      console.log("\nStopped.");
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      clearInterval(interval);
      process.exit(0);
    });
  }
}

function resetMonitorStateForTests() {
  tracked.clear();
  replayWork.clear();
  deferredRecent.clear();
  deferredBackground.clear();
  startupRecoveryCandidates.clear();
  startupRecoveryWalker = null;
  didInitialRecoveryScan = false;
  startupRecoveryReady = false;
  pollCursor = 0;
  startupRecoveryFilesScanned = 0;
  startupRecoveryBytesScanned = 0;
}

if (require.main === module) main();

module.exports.__test = {
  resolveCodexSessionDir,
  buildPostStateBody,
  buildPostQuotaBody,
  processLine,
  poll,
  pollFile,
  recoverStalePendingUserInputEntry,
  readByteRange,
  readCompleteFirstLine,
  readExactRange,
  runRecoverySweep,
  runReadyRemoteRecovery,
  recoveryReadBudgetCost,
  cleanStaleFiles,
  pruneTrackedOutOfWindow,
  tracked,
  replayWork,
  deferredRecent,
  deferredBackground,
  startupRecoveryCandidates,
  admitRemoteReplay,
  enqueueRemoteDeferred,
  collectRemoteDeferredCandidates,
  resetMonitorStateForTests,
  MAX_POLL_READ_BYTES,
  MAX_POLL_TOTAL_REQUEST_BYTES,
  MAX_POLL_FILE_ATTEMPTS,
  MAX_REPLAY_WORK_ITEMS,
  MAX_BACKGROUND_REPLAY_WORK_ITEMS,
  STALE_MS,
  DELIVERY_FAILURE_EXIT_MS,
  createDeliveryWatchdog,
};
