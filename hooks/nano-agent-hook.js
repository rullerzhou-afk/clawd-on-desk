#!/usr/bin/env node
// Clawd Desktop Pet — Nano Agent Hook Script
// Usage: node nano-agent-hook.js [event_name]
//
// nano-agent's pkg/hookservice injects payload via the NANO_HOOK_INPUT env var
// (JSON), with NANO_TOOL_NAME and NANO_TOOL_INPUT as legacy companions.
// stdin is not used by nano-agent for command hooks. We accept the event name
// from argv, NANO_HOOK_EVENT, or the parsed envelope's `event` / `hook_event_name`
// field, normalize snake_case to PascalCase, and report state to the running
// Clawd server via /state.

const crypto = require("crypto");
const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, getPlatformConfig } = require("./shared-process");

const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;

// snake_case → PascalCase event normalization. Mirrors nano-agent's
// hookservice.hookEventName() in pkg/hookservice/service.go.
function snakeToPascal(name) {
  if (typeof name !== "string" || !name) return null;
  return name
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

const EVENT_TO_STATE = {
  SessionStart:       "idle",
  SessionEnd:         "sleeping",
  UserPromptSubmit:   "thinking",
  PreToolUse:         "working",
  PostToolUse:        "working",
  PostToolUseFailure: "error",
  Stop:               "attention",
  StopFailure:        "error",
  SubagentStart:      "juggling",
  SubagentStop:       "working",
  PreCompact:         "sweeping",
  PostCompact:        "attention",
  Notification:       "notification",
  // PermissionRequest is wired as type:http (blocking) — the command hook here
  // would only fire if someone configured it; map it for safety.
  PermissionRequest:  "notification",
};

function normalizeToolUseId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeToolMatchValue(value, depth = 0) {
  if (depth > TOOL_MATCH_DEPTH_MAX) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, TOOL_MATCH_ARRAY_MAX)
      .map((entry) => normalizeToolMatchValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, TOOL_MATCH_OBJECT_KEYS_MAX)) {
      out[key] = normalizeToolMatchValue(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > TOOL_MATCH_STRING_MAX
      ? `${value.slice(0, TOOL_MATCH_STRING_MAX - 1)}…`
      : value;
  }
  return value;
}

function buildToolInputFingerprint(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const normalized = normalizeToolMatchValue(toolInput);
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function parseEnvJson(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function readNanoHookEnvelope(env) {
  const e = env || process.env;
  const envelope = parseEnvJson(e.NANO_HOOK_INPUT) || {};
  // Legacy fallback: NANO_TOOL_INPUT carries just the tool params (no envelope).
  if (!envelope.params) {
    const legacyParams = parseEnvJson(e.NANO_TOOL_INPUT);
    if (legacyParams && typeof legacyParams === "object") envelope.params = legacyParams;
  }
  if (!envelope.tool_name && typeof e.NANO_TOOL_NAME === "string") {
    envelope.tool_name = e.NANO_TOOL_NAME;
  }
  return envelope;
}

function resolveEvent(argv, env, envelope) {
  const fromArgv = typeof argv[2] === "string" ? argv[2] : "";
  const fromEnv = typeof env.NANO_HOOK_EVENT === "string" ? env.NANO_HOOK_EVENT : "";
  const fromEnvelope = envelope && (envelope.hook_event_name || envelope.event);
  const candidates = [fromArgv, fromEnv, fromEnvelope].filter(Boolean);
  for (const cand of candidates) {
    // Already PascalCase or snake_case — both routes go through normalization
    if (EVENT_TO_STATE[cand]) return cand;
    const normalized = snakeToPascal(cand);
    if (normalized && EVENT_TO_STATE[normalized]) return normalized;
  }
  return null;
}

function isTaskToolStart(event, params) {
  // Hook payload may surface a Task-like delegation as PreToolUse without a
  // matching SubagentStart. Use juggling for any tool name that looks like a
  // delegation (Task/main_agent/spawn) so the pet reflects parallel work.
  if (event !== "PreToolUse" || !params) return false;
  const toolName = typeof params.tool_name === "string" ? params.tool_name : "";
  if (!toolName) return false;
  return toolName === "Task" || toolName === "main_agent" || toolName === "spawn_agent";
}

function buildStateBody(event, envelope, resolve) {
  const state = EVENT_TO_STATE[event];
  if (!state) return null;

  const params = (envelope && typeof envelope.params === "object" && envelope.params) || {};
  const sessionId = envelope.session_id || params.session_id || "default";
  const cwd = envelope.cwd || envelope.working_dir || params.cwd || "";
  const syntheticSubagentStart = isTaskToolStart(event, { tool_name: envelope.tool_name || params.tool_name });
  const resolvedState = syntheticSubagentStart ? "juggling" : state;
  const resolvedEvent = syntheticSubagentStart ? "SubagentStart" : event;

  const body = {
    state: resolvedState,
    session_id: sessionId,
    event: resolvedEvent,
    agent_id: "nano-agent",
  };
  if (cwd) body.cwd = cwd;

  const toolName = typeof envelope.tool_name === "string" && envelope.tool_name
    ? envelope.tool_name
    : (typeof params.tool_name === "string" && params.tool_name ? params.tool_name : null);
  const toolUseId = normalizeToolUseId(
    envelope.tool_use_id ?? params.tool_use_id ?? params.toolUseId ?? params.toolUseID
  );
  const toolInput = (params.tool_input && typeof params.tool_input === "object") ? params.tool_input : null;
  const toolInputFingerprint = buildToolInputFingerprint(toolInput);
  if (toolName) body.tool_name = toolName;
  if (toolUseId) body.tool_use_id = toolUseId;
  if (toolInputFingerprint) body.tool_input_fingerprint = toolInputFingerprint;

  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    const { stablePid, agentPid, agentCommandLine, detectedEditor, pidChain } = resolve();
    body.source_pid = stablePid;
    if (detectedEditor) body.editor = detectedEditor;
    if (agentPid) {
      body.agent_pid = agentPid;
      body.nano_pid = agentPid;
      // Match clawd-hook headless detection: -p / --print are headless flags
      // in many CLIs; nano binary mode passes the prompt as positional arg, so
      // this is mostly a safety net for daemon CLI flags.
      if (agentCommandLine && /\s(-p|--print)(\s|$)/.test(agentCommandLine)) {
        body.headless = true;
      }
    }
    if (pidChain && pidChain.length) body.pid_chain = pidChain;
  }

  return body;
}

function main() {
  const envelope = readNanoHookEnvelope(process.env);
  const event = resolveEvent(process.argv, process.env, envelope);
  if (!event) process.exit(0);

  const config = getPlatformConfig();
  const resolve = createPidResolver({
    agentNames: { win: new Set(["nano.exe"]), mac: new Set(["nano"]) },
    agentCmdlineCheck: (cmd) => /\bnano(-agent)?\b/.test(cmd) && /\bnano-agent\b/.test(cmd),
    platformConfig: config,
  });

  if (event === "SessionStart" && !process.env.CLAWD_REMOTE) resolve();

  const body = buildStateBody(event, envelope, resolve);
  if (!body) process.exit(0);
  postStateToRunningServer(
    JSON.stringify(body),
    { timeoutMs: 100 },
    () => process.exit(0)
  );
}

if (require.main === module) main();

module.exports = {
  EVENT_TO_STATE,
  buildStateBody,
  readNanoHookEnvelope,
  resolveEvent,
  snakeToPascal,
};
