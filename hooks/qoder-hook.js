#!/usr/bin/env node
// Clawd — Qoder IDE hook (stdin JSON with hook_event_name; stdout JSON — no gating in Phase 1)
// Registered in Qoder's hook configuration by hooks/qoder-install.js

const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

// Qoder hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  SessionStart:       { state: "idle",         event: "SessionStart" },
  UserPromptSubmit:   { state: "thinking",     event: "UserPromptSubmit" },
  PreToolUse:         { state: "working",      event: "PreToolUse" },
  PostToolUse:        { state: "working",      event: "PostToolUse" },
  PostToolUseFailure: { state: "error",        event: "PostToolUseFailure" },
  Notification:       { state: "notification", event: "Notification" },
  Stop:               { state: "idle",         event: "Stop" },
  SessionEnd:         { state: "sleeping",     event: "SessionEnd" },
};

const config = getPlatformConfig();
function isQoderAgentCommandLine(cmd) {
  if (typeof cmd !== "string") return false;
  const normalized = cmd.toLowerCase().replace(/\\/g, "/");
  return normalized.includes("qoder");
}

const resolve = createPidResolver({
  agentNames: { win: new Set(["qoder.exe", "qoder-cli.exe"]), mac: new Set(["qoder", "qoder-cli"]), linux: new Set(["qoder", "qoder-cli"]) },
  agentCmdlineCheck: isQoderAgentCommandLine,
  platformConfig: config,
});

function resolveHookName(payload, argvEvent) {
  return (payload && payload.hook_event_name) || argvEvent || "";
}

function shouldResolvePid(hookName, env = process.env) {
  return !!HOOK_MAP[hookName] && !env.CLAWD_REMOTE;
}

function normalizeSessionId(value) {
  const raw = value != null && value !== "" ? String(value) : "default";
  return `local|qoder|${raw}`;
}

function resolveHookMapping(hookName, payload) {
  const mapped = HOOK_MAP[hookName];
  if (!mapped) return null;
  return mapped;
}

function buildStateBody(hookName, payload, options = {}) {
  const mapped = resolveHookMapping(hookName, payload);
  if (!mapped) return null;

  const { state, event } = mapped;
  const sessionId = normalizeSessionId(payload && payload.session_id);
  const cwd = (payload && payload.cwd) || "";
  const toolName = (payload && payload.tool_name) || "";
  const body = {
    state,
    session_id: sessionId,
    event,
    agent_id: "qoder",
  };

  if (cwd) body.cwd = cwd;
  if (toolName) body.tool_name = toolName;

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
  const outLine = "{}";
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
    HOOK_MAP,
    buildStateBody,
    sendHookEvent,
    resolveHookMapping,
  },
};
