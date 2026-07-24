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
  resolveCodexRateLimitQuota,
  isFreshCodexQuotaTimestamp,
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

// Map<filePath, { offset, sessionId, cwd, lastEventTime, lastState, partial }>
const tracked = new Map();
// One-shot: the first poll() is allowed to open files outside the 2-minute
// active window to check for a still-unresolved request_user_input. Every
// later poll reverts to the cheap mtime-only gate below — this is a startup
// recovery sweep, not an ongoing scan of Codex's full history.
let didInitialRecoveryScan = false;

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
// metadata_only POST (same contract as the statusline scripts) so the
// server can only annotate the session this monitor's lifecycle posts
// already created — never create/resurrect one, never touch recentEvents
// or updatedAt. Same session_id namespace ("codex:<uuid>") as the
// lifecycle posts, or the annotation would silently miss.
function buildPostQuotaBody(sessionId, codexQuota, host) {
  return JSON.stringify({
    state: "idle",
    preserve_state: true,
    metadata_only: true,
    session_id: sessionId,
    agent_id: "codex",
    host: host || hostPrefix,
    codex_quota: codexQuota,
  });
}

function postQuota(sessionId, codexQuota) {
  postStateToRunningServer(
    buildPostQuotaBody(sessionId, codexQuota, undefined),
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
    const codexQuota = isFreshCodexQuotaTimestamp(obj.timestamp)
      ? resolveCodexRateLimitQuota(payload, { capturedAt: Date.parse(obj.timestamp) })
      : null;
    if (codexQuota) {
      const postQuotaFn = typeof options.postQuota === "function" ? options.postQuota : postQuota;
      postQuotaFn(entry.sessionId, codexQuota);
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
// Returns a ready-to-track entry (already caught up to EOF, so normal
// polling only reads NEW bytes from here on) or null if nothing is pending.
// If found, also emits the recovered CodexUserInputRequest(s) directly —
// pollFile is deliberately NOT called on the same file, because it has no
// backfill/silent-replay concept and would replay this file's entire
// ordinary history as if it were live.
// Returns { text, bytesRead }. bytesRead is the TRUE byte count read from
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
  if (length <= 0) return { text: "", bytesRead: 0 };
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, start);
    return { text: buf.toString("utf8", 0, bytesRead), bytesRead };
  } catch {
    return { text: "", bytesRead: 0 };
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
  // Reads only the NEW portion at each step (not a fresh 0..chunkSize read
  // every retry) so the physical bytes read never exceed maxBytes even in
  // the worst case — the recovery sweep's total-byte budget assumes this
  // function never reads more than maxBytes per file (#707 follow-up review
  // round 4).
  let readSoFar = 0;
  let text = "";
  let target = Math.min(statSize, 8 * 1024, maxBytes);
  for (;;) {
    const additional = target - readSoFar;
    if (additional > 0) {
      const { text: chunkText } = readByteRange(filePath, readSoFar, additional);
      text += chunkText;
      readSoFar = target;
    }
    const newlineIdx = text.indexOf("\n");
    if (newlineIdx !== -1) return text.slice(0, newlineIdx);
    if (readSoFar >= statSize || readSoFar >= maxBytes) return null;
    target = Math.min(readSoFar * 4, maxBytes, statSize);
  }
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
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
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
  const tailStartsOnRecordBoundary = tailStart === 0
    || readByteRange(filePath, tailStart - 1, 1).text === "\n";
  const { text: tailText, bytesRead: tailBytesRead } = readByteRange(filePath, tailStart, tailLen);
  const rawLines = tailText.split("\n");
  // Drop the first fragment only when the preceding byte proves the window
  // really started mid-line. At an exact newline boundary, the first line is
  // a complete record and must be retained.
  if (!tailStartsOnRecordBoundary) rawLines.shift();
  // The window always ends at true EOF, so a non-empty last element is a
  // genuinely incomplete final line — preserve it the same way pollFile's
  // own `entry.partial` does, instead of consuming those bytes unparsed.
  const trailingPartial = rawLines.pop() || "";

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

  // Advance PAST the partial's bytes using the TRUE bytes read (mirrors
  // pollFile's own `entry.offset = stat.size` convention) — `partial` is
  // what reconstructs the line once the rest of it lands on a normal poll.
  const entry = {
    offset: tailStart + tailBytesRead,
    sessionId: "codex:" + sessionId,
    cwd,
    isSubagent,
    lastEventTime: Date.now(),
    lastState: "notification",
    assistantLastOutput: null,
    assistantLastOutputTruncated: false,
    pendingUserInputs: pending,
    initializing: false,
    partial: trailingPartial,
    stale: false,
  };

  if (!isSubagent) {
    const postStateFn = typeof options.postState === "function" ? options.postState : postState;
    for (const request of pending.values()) {
      postStateFn(entry.sessionId, "notification", "CodexUserInputRequest", entry.cwd, false, {
        codexUserInput: request,
      });
    }
  }
  return entry;
}

function pollFile(filePath, fileName, options = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }

  let entry = tracked.get(filePath);
  if (!entry) {
    const sessionId = extractSessionId(fileName);
    if (!sessionId) return;
    entry = {
      offset: 0,
      sessionId: "codex:" + sessionId,
      cwd: "",
      isSubagent: false,
      lastEventTime: Date.now(),
      lastState: null,
      assistantLastOutput: null,
      assistantLastOutputTruncated: false,
      pendingUserInputs: new Map(),
      initializing: true,
      partial: "",
      stale: false,
    };
    tracked.set(filePath, entry);
  }

  // Truncation guard: a retained offset can outlive the bytes it points into.
  // If the file is now smaller than our offset the offset is meaningless —
  // restart from 0 and drop any buffered partial, otherwise we'd skip the whole
  // file forever (and splice a stale partial onto fresh bytes). Mirrors the
  // local monitor's `stat.size >= retired.offset ? retired.offset : 0` guard.
  //
  // Known limitation (size-only): this does NOT catch a same-size or larger
  // in-place replacement of a same-named file — only file-identity tracking
  // (dev/ino, + a Windows ctime fallback) would. We deliberately don't do that:
  // Codex rollout files are append-only and uniquely named
  // (rollout-<ISO ts>-<uuid>.jsonl), never rewritten/recreated in place, so the
  // uncaught cases can't occur in practice and aren't worth the cross-platform
  // identity bookkeeping on an already-large monitor.
  if (stat.size < entry.offset) {
    entry.offset = 0;
    entry.partial = "";
  }

  if (stat.size <= entry.offset) return;

  let buf;
  try {
    const fd = fs.openSync(filePath, "r");
    const readLen = stat.size - entry.offset;
    buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, entry.offset);
    fs.closeSync(fd);
  } catch {
    return;
  }
  entry.offset = stat.size;

  const text = entry.partial + buf.toString("utf8");
  const lines = text.split("\n");
  entry.partial = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    processLine(line, entry, options);
  }
  if (entry.initializing) {
    entry.initializing = false;
    if (!entry.isSubagent && entry.pendingUserInputs instanceof Map) {
      const postStateFn = typeof options.postState === "function" ? options.postState : postState;
      for (const request of entry.pendingUserInputs.values()) {
        postStateFn(entry.sessionId, "notification", "CodexUserInputRequest", entry.cwd, false, {
          codexUserInput: request,
        });
      }
    }
  }
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
    if (!inWindow.has(path.dirname(filePath))) tracked.delete(filePath);
  }
}

function runRecoverySweep(candidates, options = {}) {
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
    // over-budget candidate slip through every time the running total lands
    // just under the cap (#707 follow-up review round 4).
    if (bytesScanned + candidateCost > RECOVERY_SWEEP_MAX_TOTAL_BYTES) break;
    filesScanned += 1;
    bytesScanned += candidateCost;
    const recovered = recoverStalePendingUserInputEntry(candidate.filePath, candidate.file, options);
    if (recovered) tracked.set(candidate.filePath, recovered);
  }
}

function poll() {
  const dirs = getSessionDirs();
  const recoveryCandidates = [];
  for (const dir of dirs) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const now = Date.now();
    for (const file of files) {
      if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, file);
      if (!tracked.has(filePath)) {
        let stat;
        try {
          stat = fs.statSync(filePath);
        } catch { continue; }
        if (now - stat.mtimeMs > 120000) {
          // Only the one-time startup sweep may even consider it. Collected
          // here, not read yet: candidates are sorted and budgeted in
          // runRecoverySweep so an unbounded NUMBER of stale files can't add
          // up to unbounded blocking even though each individual read is
          // already capped.
          if (!didInitialRecoveryScan) {
            recoveryCandidates.push({ filePath, file, mtimeMs: stat.mtimeMs, size: stat.size });
          }
          continue;
        }
      }
      pollFile(filePath, file);
    }
  }
  if (!didInitialRecoveryScan) {
    runRecoverySweep(recoveryCandidates);
    didInitialRecoveryScan = true;
  }
  cleanStaleFiles();
  pruneTrackedOutOfWindow();
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

if (require.main === module) main();

module.exports.__test = {
  resolveCodexSessionDir,
  buildPostStateBody,
  buildPostQuotaBody,
  processLine,
  pollFile,
  recoverStalePendingUserInputEntry,
  readByteRange,
  readCompleteFirstLine,
  runRecoverySweep,
  cleanStaleFiles,
  pruneTrackedOutOfWindow,
  tracked,
  STALE_MS,
  DELIVERY_FAILURE_EXIT_MS,
  createDeliveryWatchdog,
};
