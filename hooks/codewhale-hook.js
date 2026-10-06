#!/usr/bin/env node
// Clawd on Desk — CodeWhale Hook Script
//
// Invoked by CodeWhale lifecycle hooks ([[hooks.hooks]] in config.toml).
// CodeWhale passes context via environment variables:
//   DEEPSEEK_SESSION_ID     — session identifier ("sess_xxxxxxxx")
//   DEEPSEEK_TOOL_NAME      — name of the tool being called/returned
//   DEEPSEEK_TOOL_SUCCESS   — "true" / "false" (tool_call_after only)
//   DEEPSEEK_TOOL_EXIT_CODE — exit code (tool_call_after only)
//   DEEPSEEK_MODE           — "agent" / "plan" / "yolo"
//   DEEPSEEK_PREVIOUS_MODE  — previous mode (mode_change only)
//   DEEPSEEK_WORKSPACE      — workspace path
//   DEEPSEEK_MODEL          — current model name
//   DEEPSEEK_ERROR          — error message (on_error only)
//   DEEPSEEK_TOTAL_TOKENS   — total tokens used
//
// Event name is passed as first CLI argument:
//   node codewhale-hook.js session_start
//   node codewhale-hook.js tool_call_before
//   ...

const fs = require("fs");
const os = require("os");
const path = require("path");
const { postStateToRunningServer, applyWslSourceFields } = require("./server-config");

const AGENT_ID = "codewhale";
const HOOK_SOURCE = "codewhale-hook";

// ── Stable Session ID Cache ───────────────────────────────────────────────────
// Some events (e.g. mode_change) may fire without DEEPSEEK_SESSION_ID set.
// We cache the last known session id so all events for the same codewhale
// instance map to the same Clawd session, preventing duplicate HUD labels.
const SESSION_CACHE = path.join(os.tmpdir(), "codewhale-hook-session");

function readCachedSessionId(cachePath = SESSION_CACHE) {
  try {
    const raw = fs.readFileSync(cachePath, "utf8").trim();
    if (raw) return raw;
  } catch {}
  return null;
}

function writeCachedSessionId(id, cachePath = SESSION_CACHE) {
  try { fs.writeFileSync(cachePath, String(id), "utf8"); } catch {}
}

function clearCachedSessionId(cachePath = SESSION_CACHE) {
  try { fs.unlinkSync(cachePath); } catch {}
}

// ── Event Translation ────────────────────────────────────────────────────────
// CodeWhale snake_case lifecycle events → Clawd PascalCase + state.

const EVENT_MAP = {
  session_start: { event: "SessionStart", state: "idle" },
  session_end: { event: "SessionEnd", state: "sleeping" },
  message_submit: { event: "UserPromptSubmit", state: "thinking" },
  tool_call_before: { event: "PreToolUse", state: "working" },
  tool_call_after: { event: "PostToolUse", state: "working" },
  mode_change: { event: "PreCompact", state: "sweeping" },
  on_error: { event: "StopFailure", state: "error" },
};

// Events whose POST must be awaited to ensure delivery.
const AWAIT_EVENTS = new Set(["session_end"]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeString(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim() || fallback;
}

function safeBool(value) {
  const s = safeString(value);
  return s === "true" ? true : s === "false" ? false : null;
}

function safePositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

// ── Payload Construction ─────────────────────────────────────────────────────

function buildPayload(codewhaleEventName, env, options = {}) {
  const mapping = EVENT_MAP[codewhaleEventName];
  if (!mapping) return null;
  const cachePath = options.sessionCachePath || SESSION_CACHE;
  const readSession = options.readCachedSessionId || (() => readCachedSessionId(cachePath));
  const writeSession = options.writeCachedSessionId || ((id) => writeCachedSessionId(id, cachePath));

  // Stable session id: use DEEPSEEK_SESSION_ID when available, fall back to
  // cached value so events like mode_change (which may lack the env var) still
  // map to the same Clawd session instead of creating duplicate labels.
  let sessionId = safeString(env.DEEPSEEK_SESSION_ID, null) || readSession();
  if (!sessionId) {
    sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }
  writeSession(sessionId);

  const payload = {
    agent_id: AGENT_ID,
    hook_source: HOOK_SOURCE,
    event: mapping.event,
    state: mapping.state,
    session_id: `${AGENT_ID}:${sessionId}`,
  };

  // Workspace → cwd (for session menu label in Clawd)
  const workspace = safeString(env.DEEPSEEK_WORKSPACE, "");
  if (workspace) {
    payload.cwd = workspace;
    // Override display title so HUD shows "CodeWhale" instead of
    // path.basename(cwd) (which would be e.g. "claude_on_desk").
    payload.session_title = "CodeWhale";
  } else {
    payload.session_title = "CodeWhale";
  }

  // Model info
  const model = safeString(env.DEEPSEEK_MODEL, "");
  if (model) payload.model = model;

  // Tool context (tool_call_before / tool_call_after)
  const toolName = safeString(env.DEEPSEEK_TOOL_NAME, "");
  if (toolName) payload.tool_name = toolName;

  // tool_call_after: detect failure
  if (codewhaleEventName === "tool_call_after") {
    const toolSuccess = safeBool(env.DEEPSEEK_TOOL_SUCCESS);
    if (toolSuccess === false) {
      payload.event = "PostToolUseFailure";
      payload.state = "error";
    }
  }

  // mode_change: detect compact vs other mode switches
  if (codewhaleEventName === "mode_change") {
    const mode = safeString(env.DEEPSEEK_MODE, "").toLowerCase();
    const prevMode = safeString(env.DEEPSEEK_PREVIOUS_MODE, "").toLowerCase();
    // Only treat compact transitions as sweeping; other mode changes → attention
    if (mode !== "compact" && prevMode !== "compact") {
      payload.event = "Notification";
      payload.state = "attention";
    }
  }

  // Error info
  const errorMsg = safeString(env.DEEPSEEK_ERROR, "");
  if (errorMsg) payload.error_message = errorMsg;

  // CodeWhale has no remote (SSH) mode of its own, but respect CLAWD_REMOTE
  // if set so a future remote setup doesn't get its host overridden.
  applyWslSourceFields(payload, { remote: !!process.env.CLAWD_REMOTE });

  return payload;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run(eventName = process.argv[2] || "", deps = {}) {
  if (!eventName) {
    // Called without an event name — nothing to do.
    return { eventName, payload: null, posted: false, port: null };
  }

  const mapping = EVENT_MAP[eventName];
  if (!mapping) {
    // Unknown event (e.g. shell_env which we ignore in Phase 1)
    return { eventName, payload: null, posted: false, port: null };
  }

  const env = deps.env || process.env;
  const payload = buildPayload(eventName, env, deps);
  if (!payload) return { eventName, payload: null, posted: false, port: null };

  // Clear the session cache on session_end so the next codewhale instance
  // starts fresh instead of inheriting the stale session id.
  if (eventName === "session_end") {
    if (deps.clearCachedSessionId) deps.clearCachedSessionId();
    else clearCachedSessionId(deps.sessionCachePath || SESSION_CACHE);
  }

  const shouldAwait = AWAIT_EVENTS.has(eventName);
  const postState = deps.postState || postStateToRunningServer;
  const options = { timeoutMs: shouldAwait ? 2000 : 100 };
  return await new Promise((resolve) => {
    postState(JSON.stringify(payload), options, (posted, port) => {
      resolve({ eventName, payload, posted: !!posted, port: port || null, options });
    });
  });
}

async function main() {
  await run();
}

if (require.main === module) {
  main().then(() => {
    process.exit(0);
  });
}

module.exports = {
  __test: {
    AWAIT_EVENTS,
    EVENT_MAP,
    buildPayload,
    clearCachedSessionId,
    readCachedSessionId,
    run,
    safeBool,
    safePositiveInt,
    safeString,
    writeCachedSessionId,
  },
};
