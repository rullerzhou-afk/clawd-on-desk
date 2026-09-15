#!/usr/bin/env node
// Clawd — Grok Build state hook (Phase 1, state-only).
// Registered in $GROK_HOME/hooks/clawd-on-desk.json by hooks/grok-install.js.
//
// Contract pinned to the official upstream source
// xai-org/grok-build@37949780c144e37df692e3d669051a21fec24f20
// (RawHandler = type/command/url/timeout/env; no per-handler `shell`).
//
// Grok uses Claude-compatible event names but camelCase field names:
//   `hookEventName` is the camelCase key carrying Grok's snake_case value;
//   `hook_event_name` is the snake_case compatibility key carrying the
//   PascalCase value. The runner may also inject `GROK_HOOK_EVENT`.
//
// Contract:
//   - Grok keeps every permission decision. This adapter never calls
//     /permission and never emits allow/deny/ask/block output.
//   - stdout is ALWAYS exactly `{}` followed by a newline, exit code 0, for
//     every input: parse failure, missing identity, unsupported event,
//     disabled/offline Clawd, and intentionally ignored events.
//   - The local state POST is best-effort and short-bounded.
//   - No prompt, tool input/result, error detail, assistant output, task
//     description, cron prompt, session title, PID chain, or free-form
//     Notification message is ever forwarded.
//   - No subagent events reach the state runtime (`subagentType` => drop).
//
// Stop disposition is resolved here, from `reason`, the array lengths of
// `backgroundTasks` / `sessionCrons`, and the boolean `stopHookActive`; the
// raw arrays and their content never leave this process.

"use strict";

const { postStateToRunningServer } = require("./server-config");

const MAX_SESSION_ID_LENGTH = 200;
const MAX_CWD_LENGTH = 512;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_PROMPT_ID_LENGTH = 128;
const STDIN_TIMEOUT_MS = 1500;
const SAFETY_TIMEOUT_MS = 1800;
const POST_TIMEOUT_MS = 150;

const AGENT_ID = "grok-build";

const HOOK_MAP = Object.freeze({
  SessionStart: { state: "idle", event: "SessionStart" },
  SessionEnd: { state: "sleeping", event: "SessionEnd" },
  UserPromptSubmit: { state: "thinking", event: "UserPromptSubmit" },
  PreToolUse: { state: "working", event: "PreToolUse" },
  PostToolUse: { state: "working", event: "PostToolUse" },
  PostToolUseFailure: { state: "error", event: "PostToolUseFailure" },
  Stop: { state: "attention", event: "Stop" },
  StopFailure: { state: "error", event: "StopFailure" },
  StopCancelled: { state: "idle", event: "StopCancelled" },
  Notification: { state: "notification", event: "Notification" },
  PreCompact: { state: "sweeping", event: "PreCompact" },
  PostCompact: { state: "thinking", event: "PostCompact" },
  PermissionDenied: { state: "notification", event: "Notification" },
});

const SNAKE_TO_PASCAL = Object.freeze({
  session_start: "SessionStart",
  session_end: "SessionEnd",
  user_prompt_submit: "UserPromptSubmit",
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  post_tool_use_failure: "PostToolUseFailure",
  stop: "Stop",
  stop_failure: "StopFailure",
  stop_cancelled: "StopCancelled",
  notification: "Notification",
  pre_compact: "PreCompact",
  post_compact: "PostCompact",
  permission_denied: "PermissionDenied",
});

const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

// Events that establish or end a turn must carry a valid bounded promptId.
// Grok Build 1.0.30 emits the real promptId only on UserPromptSubmit and the
// turn-end reports, so tool events are NOT listed here and may be reported
// prompt-less; the server-side turn fence binds them to the session's active
// turn (and drops them when no such turn exists). Session-scoped presentation/
// settle events (SessionStart, SessionEnd, Notification, PreCompact,
// PostCompact, PermissionDenied) may also omit it.
const TURN_SCOPED_EVENTS = new Set([
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "StopCancelled",
]);

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// Only the documented wire pairs are accepted:
//   - `hook_event_name` (snake_case key) carries the PascalCase value;
//   - `hookEventName` (camelCase key) carries the snake_case value;
//   - the runner-injected `GROK_HOOK_EVENT` is snake_case.
// Speculative casing (e.g. `hookEventName:"PreToolUse"`) is rejected, and two
// present-but-disagreeing identities are rejected rather than silently picked.
function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeHookName(payload, env = process.env) {
  if (!payload || typeof payload !== "object") payload = {};
  const identities = [];

  const compat = pickString(payload.hook_event_name);
  if (compat) {
    // Own-property only: `constructor`, `toString`, `__proto__`, etc. must never
    // resolve through Object.prototype into a bogus event identity.
    if (!hasOwn(HOOK_MAP, compat)) return "";
    identities.push(compat);
  }

  const camel = pickString(payload.hookEventName);
  if (camel) {
    if (!hasOwn(SNAKE_TO_PASCAL, camel)) return "";
    identities.push(SNAKE_TO_PASCAL[camel]);
  }

  const runner = pickString(env.GROK_HOOK_EVENT);
  if (runner) {
    if (!hasOwn(SNAKE_TO_PASCAL, runner)) return "";
    identities.push(SNAKE_TO_PASCAL[runner]);
  }

  if (identities.length === 0) return "";
  const [first] = identities;
  if (identities.some((identity) => identity !== first)) return "";
  return first;
}

function isValidSessionId(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SESSION_ID_LENGTH) return false;
  return !/[\u0000-\u001f\u007f\r\n]/.test(trimmed);
}

function pickSessionId(payload, env = process.env) {
  if (!payload || typeof payload !== "object") payload = {};
  const raw = pickString(payload.sessionId, payload.session_id, env.GROK_SESSION_ID);
  return isValidSessionId(raw) ? raw : "";
}

function buildSessionId(rawSessionId) {
  return rawSessionId ? `${AGENT_ID}:${rawSessionId}` : "";
}

function pickSubagentType(payload) {
  if (!payload || typeof payload !== "object") return "";
  return pickString(payload.subagentType, payload.subagent_type);
}

function boundString(value, maxLength) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

// The prompt id is an opaque ordering key. Reject an overlong or
// control-character id instead of truncating it (a truncated id could collide
// with another live turn).
function normalizePromptId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > MAX_PROMPT_ID_LENGTH) return "";
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "";
  return trimmed;
}

function notificationIsIdlePrompt(payload) {
  if (!payload || typeof payload !== "object") return false;
  return pickString(payload.notificationType, payload.notification_type).toLowerCase() === "idle_prompt";
}

function compactSource(payload) {
  if (!payload || typeof payload !== "object") return "";
  return pickString(payload.source, payload.trigger).toLowerCase();
}

// Stop disposition is adapter-local. Only an exact `end_turn` with no live
// background work may become a normal completion. Everything else is either a
// non-terminal continuation or a session-end-shaped drop.
function resolveStopDisposition(payload) {
  if (!payload || typeof payload !== "object") return { action: "drop", reason: "missing-reason" };
  const reason = pickString(payload.reason).toLowerCase();
  if (reason !== "end_turn") {
    return { action: "drop", reason: reason || "missing-reason" };
  }
  const backgroundTasks = Array.isArray(payload.backgroundTasks) ? payload.backgroundTasks : [];
  const sessionCrons = Array.isArray(payload.sessionCrons) ? payload.sessionCrons : [];
  const stopHookActive = payload.stopHookActive === true;
  if (stopHookActive || backgroundTasks.length > 0 || sessionCrons.length > 0) {
    return { action: "continuation" };
  }
  return { action: "terminal" };
}

// Pure: derive the POST decision from a parsed payload. Returning `{ post:
// false }` means stdout stays `{}` and no HTTP request is made.
function buildHookDecision(payload, env = process.env) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { post: false, reason: "malformed-payload" };
  }
  const eventName = normalizeHookName(payload, env);
  const mapped = hasOwn(HOOK_MAP, eventName) ? HOOK_MAP[eventName] : null;
  if (!mapped) return { post: false, reason: "unsupported-event" };

  const rawSessionId = pickSessionId(payload, env);
  if (!rawSessionId) return { post: false, reason: "missing-session" };

  // Phase 1 ignores every subagent event before it can reach the state runtime.
  if (pickSubagentType(payload)) return { post: false, reason: "subagent" };

  // Reject (never truncate) an invalid opaque prompt id so a collision-prone id
  // can never clear or overwrite a live turn. Turn-scoped events fail closed
  // when the id is missing/invalid.
  const promptId = normalizePromptId(payload.promptId || payload.prompt_id);
  if (TURN_SCOPED_EVENTS.has(eventName) && !promptId) {
    return { post: false, reason: "missing-prompt-id" };
  }

  let state = mapped.state;
  let event = mapped.event;
  let notificationType = "";

  if (eventName === "Stop") {
    const disposition = resolveStopDisposition(payload);
    if (disposition.action === "drop") return { post: false, reason: `stop-${disposition.reason}` };
    if (disposition.action === "continuation") {
      // Non-terminal: stay working with no event so the state runtime does not
      // append a Stop tail and the turn fence cannot latch.
      state = "working";
      event = null;
    }
  } else if (eventName === "PostCompact") {
    state = compactSource(payload) === "manual" ? "idle" : "thinking";
  } else if (eventName === "Notification" && notificationIsIdlePrompt(payload)) {
    notificationType = "idle_prompt";
  }

  const body = {
    agent_id: AGENT_ID,
    session_id: buildSessionId(rawSessionId),
    state,
    event,
  };

  const cwd = boundString(payload.cwd, MAX_CWD_LENGTH);
  if (cwd) body.cwd = cwd;

  if (TOOL_EVENTS.has(eventName)) {
    const toolName = boundString(payload.toolName || payload.tool_name, MAX_TOOL_NAME_LENGTH);
    if (toolName) body.tool_name = toolName;
  }

  // Opaque ordering key for the turn fence only; never rendered or persisted.
  if (promptId) body.prompt_id = promptId;

  // Closed enum required by the fence contract so the route can tell a
  // session-settle `idle_prompt` Notification from a presentation-only one.
  // Only ever the single value below — never free-form Notification content.
  if (notificationType) body.notification_type = notificationType;

  return { post: true, body };
}

function readStdinJson(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let data = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
        if (data.length > 4 * 1024 * 1024) finish(null);
      });
      process.stdin.on("error", () => finish(null));
      process.stdin.on("end", () => {
        if (!data.trim()) return finish(null);
        try {
          finish(JSON.parse(data));
        } catch {
          finish(null);
        }
      });
      process.stdin.resume();
    } catch {
      finish(null);
    }
  });
}

let _wrote = false;
let _exited = false;
let _safetyTimer = null;

function writePassiveOutput() {
  if (_wrote) return;
  _wrote = true;
  process.stdout.write("{}\n");
}

function finish() {
  writePassiveOutput();
  if (_exited) return;
  _exited = true;
  if (_safetyTimer) clearTimeout(_safetyTimer);
  process.exit(0);
}

function run() {
  _safetyTimer = setTimeout(() => finish(), SAFETY_TIMEOUT_MS);
  readStdinJson(STDIN_TIMEOUT_MS)
    .then((payload) => {
      let decision = { post: false, reason: "malformed-payload" };
      try {
        decision = buildHookDecision(payload, process.env);
      } catch {
        decision = { post: false, reason: "adapter-error" };
      }
      // stdout is written before the best-effort POST so a slow or offline
      // Clawd can never delay the host command hook.
      writePassiveOutput();
      if (!decision.post) {
        finish();
        return;
      }
      postStateToRunningServer(JSON.stringify(decision.body), { timeoutMs: POST_TIMEOUT_MS }, () => {
        finish();
      });
    })
    .catch(() => finish());
}

if (require.main === module) {
  run();
} else {
  if (_safetyTimer) clearTimeout(_safetyTimer);
  _exited = true;
}

module.exports = {
  AGENT_ID,
  HOOK_MAP,
  SNAKE_TO_PASCAL,
  TURN_SCOPED_EVENTS,
  normalizePromptId,
  normalizeHookName,
  pickSessionId,
  buildSessionId,
  isValidSessionId,
  resolveStopDisposition,
  notificationIsIdlePrompt,
  buildHookDecision,
};
