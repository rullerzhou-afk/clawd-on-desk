#!/usr/bin/env node
// Clawd — Gemini CLI hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.gemini/settings.json by hooks/gemini-install.js

const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

// Gemini hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  SessionStart:  { state: "idle",         event: "SessionStart" },
  SessionEnd:    { state: "sleeping",     event: "SessionEnd" },
  BeforeAgent:   { state: "thinking",     event: "UserPromptSubmit" },
  BeforeTool:    { state: "working",      event: "PreToolUse" },
  AfterTool:     { state: "working",      event: "PostToolUse" },
  AfterAgent:    { state: "idle",         event: "AfterAgent" },
  Notification:  { state: "notification", event: "Notification" },
  PreCompress:   { state: "idle",         event: "PreCompress", preserveState: true },
};

const config = getPlatformConfig();
function isGeminiAgentCommandLine(cmd) {
  if (typeof cmd !== "string") return false;
  const normalized = cmd.toLowerCase().replace(/\\/g, "/");
  return normalized.includes("@google/gemini-cli")
    || normalized.includes("gemini-cli")
    || normalized.includes("/node_modules/.bin/gemini")
    || /(^|[\s"'/])gemini(\.js)?($|[\s"'/])/.test(normalized);
}

const resolve = createPidResolver({
  agentNames: { win: new Set(["gemini.exe"]), mac: new Set(["gemini"]), linux: new Set(["gemini"]) },
  agentCmdlineCheck: isGeminiAgentCommandLine,
  platformConfig: config,
});

// Gemini CLI gating hooks need stdout JSON response
function stdoutForEvent(hookName) {
  if (hookName === "BeforeTool") return JSON.stringify({ decision: "allow" });
  if (hookName === "AfterTool") return JSON.stringify({ decision: "allow" });
  if (hookName === "BeforeAgent") return JSON.stringify({});
  return "{}";
}

function resolveHookName(payload, argvEvent) {
  return (payload && payload.hook_event_name) || argvEvent || "";
}

function shouldResolvePid(hookName, env = process.env) {
  return !!HOOK_MAP[hookName] && !env.CLAWD_REMOTE;
}

function normalizeSessionId(value) {
  const raw = value != null && value !== "" ? String(value) : "default";
  return raw.startsWith("gemini:") ? raw : `gemini:${raw}`;
}

function hasToolResponseError(payload) {
  const response = payload && payload.tool_response;
  if (!response || typeof response !== "object") return false;
  const error = response.error;
  return error !== undefined && error !== null && error !== false && error !== "";
}

function resolveHookMapping(hookName, payload) {
  const mapped = HOOK_MAP[hookName];
  if (!mapped) return null;

  if (hookName === "AfterTool" && hasToolResponseError(payload)) {
    return { state: "error", event: "PostToolUseFailure" };
  }

  const reason = payload && (payload.reason || payload.source);
  if (hookName === "SessionEnd" && reason === "clear") {
    return { state: "sweeping", event: "SessionEnd" };
  }

  return mapped;
}

const TOKEN_USAGE_FIELD_NAMES = [
  "input",
  "output",
  "total",
  "input_tokens",
  "output_tokens",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "promptTokenCount",
  "candidatesTokenCount",
  "totalTokenCount",
];

function extractExplicitTokenUsage(payload) {
  if (!payload || typeof payload !== "object") return null;
  let source = null;
  for (const key of ["token_usage", "tokenUsage", "usage", "tokens"]) {
    if (payload[key] && typeof payload[key] === "object") {
      source = payload[key];
      break;
    }
  }
  if (!source) source = payload;
  const out = {};
  for (const key of TOKEN_USAGE_FIELD_NAMES) {
    if (Number.isFinite(source[key])) out[key] = source[key];
  }
  return Object.keys(out).length ? out : null;
}

function addTokenUsage(body, payload) {
  const tokenUsage = extractExplicitTokenUsage(payload);
  if (!tokenUsage) return;
  body.token_usage = tokenUsage;
  const suffix = payload.turn_id || payload.turnId || payload.request_id || payload.requestId ||
    payload.response_id || payload.responseId || payload.message_id || payload.messageId ||
    payload.tool_use_id || payload.toolUseId || payload.toolUseID || payload.event_id || payload.eventId || "";
  if (suffix) {
    body.usage_event_id = [body.agent_id, body.session_id, body.event, suffix].filter(Boolean).join(":");
  }
}

function buildStateBody(hookName, payload, options = {}) {
  const mapped = resolveHookMapping(hookName, payload);
  if (!mapped) return null;

  const { state, event, preserveState } = mapped;
  const sessionId = normalizeSessionId(payload && payload.session_id);
  const cwd = (payload && payload.cwd) || "";
  const body = {
    state,
    session_id: sessionId,
    event,
    agent_id: "gemini-cli",
  };

  if (cwd) body.cwd = cwd;
  if (preserveState) body.preserve_state = true;
  addTokenUsage(body, payload);

  if (options.remote) {
    body.host = options.host || readHostPrefix();
    return body;
  }

  const pidMeta = options.pidMeta;
  if (!pidMeta || typeof pidMeta !== "object") return body;
  if (Number.isFinite(pidMeta.stablePid) && pidMeta.stablePid > 0) body.source_pid = Math.floor(pidMeta.stablePid);
  if (pidMeta.detectedEditor) body.editor = pidMeta.detectedEditor;
  if (Number.isFinite(pidMeta.agentPid) && pidMeta.agentPid > 0) body.agent_pid = Math.floor(pidMeta.agentPid);
  if (Array.isArray(pidMeta.pidChain) && pidMeta.pidChain.length) body.pid_chain = pidMeta.pidChain;
  return body;
}

function sendHookEvent(payload, argvEvent, deps = {}) {
  const env = deps.env || process.env;
  const hookName = resolveHookName(payload, argvEvent);
  const outLine = stdoutForEvent(hookName);
  const remote = !!env.CLAWD_REMOTE;
  const body = buildStateBody(hookName, payload, {
    remote,
    host: remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined,
    pidMeta: shouldResolvePid(hookName, env)
      ? (deps.resolvePid ? deps.resolvePid() : undefined)
      : undefined,
  });

  if (!body) {
    return Promise.resolve({ hookName, stdout: outLine, body: null, posted: false, port: null });
  }

  const postState = deps.postState || postStateToRunningServer;
  return new Promise((resolvePost) => {
    postState(JSON.stringify(body), { timeoutMs: 100 }, (posted, port) => {
      resolvePost({ hookName, stdout: outLine, body, posted: !!posted, port: port || null });
    });
  });
}

async function main(argvEvent = process.argv[2], deps = {}) {
  const payload = deps.payload !== undefined
    ? deps.payload
    : await (deps.readStdinJson || readStdinJson)();
  const result = await sendHookEvent(payload, argvEvent, {
    env: deps.env || process.env,
    postState: deps.postState || postStateToRunningServer,
    readHostPrefix: deps.readHostPrefix || readHostPrefix,
    resolvePid: deps.resolvePid || resolve,
  });
  process.stdout.write(result.stdout + "\n");
}

if (require.main === module) {
  main().then(() => {
    process.exit(0);
  });
}

module.exports = {
  __test: {
    buildStateBody,
    resolveHookName,
    sendHookEvent,
    shouldResolvePid,
    stdoutForEvent,
    isGeminiAgentCommandLine,
  },
};
