#!/usr/bin/env node
// Clawd — Gemini CLI hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.gemini/settings.json by hooks/gemini-install.js

const { postStateToRunningServer, readHostPrefix, applyWslSourceFields } = require("./server-config");
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

  if (options.remote) {
    body.host = options.host || readHostPrefix();
    applyWslSourceFields(body, { remote: true });
    return body;
  }
  applyWslSourceFields(body);

  const pidMeta = options.pidMeta;
  if (!pidMeta || typeof pidMeta !== "object") return body;
  if (Number.isFinite(pidMeta.stablePid) && pidMeta.stablePid > 0) body.source_pid = Math.floor(pidMeta.stablePid);
  if (pidMeta.detectedEditor) body.editor = pidMeta.detectedEditor;
  if (Number.isFinite(pidMeta.agentPid) && pidMeta.agentPid > 0) body.agent_pid = Math.floor(pidMeta.agentPid);
  if (Array.isArray(pidMeta.pidChain) && pidMeta.pidChain.length) body.pid_chain = pidMeta.pidChain;
  if (pidMeta.tmuxSocket) body.tmux_socket = pidMeta.tmuxSocket;
  if (pidMeta.tmuxClient) body.tmux_client = pidMeta.tmuxClient;
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

// Safety timeout: guarantee valid JSON on stdout even if stdin never arrives.
const SAFETY_TIMEOUT_MS = 800;
let _wrote = false;
let _exited = false;
let safetyTimer = null;

// Write the stdout response exactly once. Kept separate from process exit so the
// hook can answer Gemini immediately yet still let the fire-and-forget POST to
// Clawd leave the process before it tears down.
function writeStdoutOnce(outLine) {
  if (_wrote) return;
  _wrote = true;
  process.stdout.write(outLine + "\n");
}

function finish(outLine) {
  writeStdoutOnce(outLine);
  if (_exited) return;
  _exited = true;
  if (safetyTimer) clearTimeout(safetyTimer);
  process.exit(0);
}

async function main(argvEvent = process.argv[2], deps = {}) {
  const payload = deps.payload !== undefined
    ? deps.payload
    : await (deps.readStdinJson || readStdinJson)();
  const hookName = resolveHookName(payload, argvEvent);
  const outLine = stdoutForEvent(hookName);

  // Answer Gemini immediately so it never sees empty stdout, but do NOT exit
  // here — exiting would kill the POST below before it leaves the process.
  writeStdoutOnce(outLine);

  await sendHookEvent(payload, argvEvent, {
    env: deps.env || process.env,
    postState: deps.postState || postStateToRunningServer,
    readHostPrefix: deps.readHostPrefix || readHostPrefix,
    resolvePid: deps.resolvePid || resolve,
  }).catch(() => {});

  finish(outLine);
}

if (require.main === module) {
  // Arm the safety timer only on the CLI path so importing this module in tests
  // never leaves a stray timer that pollutes stdout or kills the test runner.
  safetyTimer = setTimeout(() => finish("{}"), SAFETY_TIMEOUT_MS);
  main().catch(() => finish("{}"));
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
