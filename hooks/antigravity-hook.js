#!/usr/bin/env node
// Clawd - Antigravity CLI hook adapter
// Registered in Antigravity's global hooks file by hooks/antigravity-install.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { postPermissionToRunningServer, postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const ANTIGRAVITY_PERMISSION_TIMEOUT_MS = 590000;
const TOOL_INPUT_STRING_MAX = 2000;
const TOOL_INPUT_ARRAY_MAX = 32;
const TOOL_INPUT_OBJECT_KEYS_MAX = 64;
const TOOL_INPUT_DEPTH_MAX = 6;
const DEBUG_STRING_MAX = 2000;
const DEBUG_TOOL_INPUT_STRING_MAX = 240;
const DEBUG_OBJECT_KEYS_MAX = 32;
const DEBUG_ARRAY_MAX = 16;
const DEBUG_DEPTH_MAX = 4;

const HOOK_MAP = {
  PreInvocation: { state: "thinking", event: "UserPromptSubmit" },
  PreToolUse: { state: "working", event: "PreToolUse" },
  PostToolUse: { state: "working", event: "PostToolUse" },
  PostInvocation: { state: "idle", event: "AfterAgent" },
  Stop: { state: "attention", event: "Stop" },
};

const config = getPlatformConfig();

function isAntigravityAgentCommandLine(cmd) {
  if (typeof cmd !== "string") return false;
  const normalized = cmd.toLowerCase().replace(/\\/g, "/");
  return /(^|[\s"'/])agy(\.exe)?($|[\s"'/])/.test(normalized)
    || normalized.includes("/agy/bin/agy.exe")
    || normalized.includes("/antigravity-cli/");
}

const resolve = createPidResolver({
  agentNames: { win: new Set(["agy.exe"]), mac: new Set(["agy"]), linux: new Set(["agy"]) },
  agentCmdlineCheck: isAntigravityAgentCommandLine,
  platformConfig: config,
});

function getAntigravityPermissionTimeoutMs(env = process.env) {
  const raw = Number(env.CLAWD_ANTIGRAVITY_PERMISSION_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, ANTIGRAVITY_PERMISSION_TIMEOUT_MS);
  return ANTIGRAVITY_PERMISSION_TIMEOUT_MS;
}

function isTruthyDebugValue(value) {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function isAntigravityHookDebugEnabled(env = process.env) {
  return isTruthyDebugValue(String(env.CLAWD_ANTIGRAVITY_HOOK_DEBUG || "").toLowerCase());
}

function getAntigravityHookDebugLogPath(env = process.env) {
  if (typeof env.CLAWD_ANTIGRAVITY_HOOK_DEBUG_FILE === "string" && env.CLAWD_ANTIGRAVITY_HOOK_DEBUG_FILE.trim()) {
    return env.CLAWD_ANTIGRAVITY_HOOK_DEBUG_FILE.trim();
  }
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "clawd-hook-debug.log");
}

function truncateDebugString(value, max = DEBUG_STRING_MAX) {
  if (typeof value !== "string") return value;
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function normalizeDebugValue(value, depth = 0) {
  if (depth > DEBUG_DEPTH_MAX) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, DEBUG_ARRAY_MAX).map((entry) => normalizeDebugValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, DEBUG_OBJECT_KEYS_MAX)) {
      if (/token|secret|password|authorization|credential|api[_-]?key/i.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = normalizeDebugValue(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return truncateDebugString(value, DEBUG_TOOL_INPUT_STRING_MAX);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  return value === undefined ? undefined : String(value);
}

function writeAntigravityHookDebug(env, event, fields = {}) {
  if (!isAntigravityHookDebugEnabled(env)) return false;
  let line;
  try {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
    });
  } catch {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      event: "debug-serialize-failed",
      originalEvent: event,
    });
  }

  if (isTruthyDebugValue(String(env.CLAWD_ANTIGRAVITY_HOOK_DEBUG_STDERR || "").toLowerCase())) {
    try {
      process.stderr.write(`[clawd-antigravity] ${line}\n`);
    } catch {}
  }

  try {
    const debugPath = getAntigravityHookDebugLogPath(env);
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.appendFileSync(debugPath, `${line}${os.EOL}`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function buildAntigravityNoDecisionOutput(reason) {
  const body = { decision: "ask" };
  if (typeof reason === "string" && reason.trim()) body.reason = reason.trim();
  return JSON.stringify(body);
}

function stdoutForEvent(hookName) {
  if (hookName === "PreToolUse") return buildAntigravityNoDecisionOutput();
  if (hookName === "Stop") return JSON.stringify({ decision: "allow" });
  return "{}";
}

function resolveHookName(payload, argvEvent) {
  return (payload && payload.hookEventName) || (payload && payload.hook_event_name) || argvEvent || "";
}

function shouldResolvePid(hookName, env = process.env) {
  return !!HOOK_MAP[hookName] && !env.CLAWD_REMOTE;
}

function normalizeSessionId(value, payload) {
  const fallback = payload && typeof payload.transcriptPath === "string" && payload.transcriptPath
    ? path.basename(path.dirname(payload.transcriptPath)) || "default"
    : "default";
  const raw = value != null && value !== "" ? String(value) : fallback;
  return raw.startsWith("antigravity:") ? raw : `antigravity:${raw}`;
}

function resolveCwd(payload) {
  const toolArgs = payload && payload.toolCall && payload.toolCall.args;
  if (toolArgs && typeof toolArgs.Cwd === "string" && toolArgs.Cwd) return toolArgs.Cwd;
  if (payload && Array.isArray(payload.workspacePaths)) {
    const first = payload.workspacePaths.find((entry) => typeof entry === "string" && entry);
    if (first) return first;
  }
  return "";
}

function normalizeToolInputValue(value, depth = 0) {
  if (depth > TOOL_INPUT_DEPTH_MAX) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, TOOL_INPUT_ARRAY_MAX)
      .map((entry) => normalizeToolInputValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, TOOL_INPUT_OBJECT_KEYS_MAX)) {
      out[key] = normalizeToolInputValue(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > TOOL_INPUT_STRING_MAX
      ? `${value.slice(0, TOOL_INPUT_STRING_MAX - 3)}...`
      : value;
  }
  return value;
}

function resolveToolName(payload) {
  const toolCall = payload && payload.toolCall && typeof payload.toolCall === "object"
    ? payload.toolCall
    : null;
  const candidates = [
    toolCall && toolCall.name,
    toolCall && toolCall.toolName,
    payload && payload.toolName,
    payload && payload.tool_name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "Unknown";
}

function resolveToolInput(payload) {
  const toolCall = payload && payload.toolCall && typeof payload.toolCall === "object"
    ? payload.toolCall
    : null;
  const raw = toolCall && toolCall.args && typeof toolCall.args === "object"
    ? toolCall.args
    : (payload && payload.toolInput && typeof payload.toolInput === "object"
      ? payload.toolInput
      : (payload && payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {}));
  return normalizeToolInputValue(raw) || {};
}

function hasToolError(payload) {
  if (!payload || typeof payload !== "object") return false;
  const error = payload.error;
  return error !== undefined && error !== null && error !== false && error !== "";
}

function hasStopError(payload) {
  if (hasToolError(payload)) return true;
  const reason = payload && typeof payload.terminationReason === "string"
    ? payload.terminationReason.toLowerCase()
    : "";
  return reason.includes("error") || reason.includes("failed") || reason.includes("failure");
}

function resolveHookMapping(hookName, payload) {
  const mapped = HOOK_MAP[hookName];
  if (!mapped) return null;

  if (hookName === "PostToolUse" && hasToolError(payload)) {
    return { state: "error", event: "PostToolUseFailure" };
  }
  if (hookName === "Stop" && hasStopError(payload)) {
    return { state: "error", event: "StopFailure" };
  }
  if (hookName === "Stop" && payload && payload.fullyIdle === false) {
    return { state: "working", event: "PostToolUse" };
  }

  return mapped;
}

function buildStateBody(hookName, payload, options = {}) {
  const mapped = resolveHookMapping(hookName, payload);
  if (!mapped) return null;

  const { state, event } = mapped;
  const sessionId = normalizeSessionId(payload && payload.conversationId, payload);
  const cwd = resolveCwd(payload);
  const body = {
    state,
    session_id: sessionId,
    event,
    agent_id: "antigravity-cli",
  };

  if (cwd) body.cwd = cwd;

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

function buildPermissionBody(hookName, payload, options = {}) {
  if (hookName !== "PreToolUse") return null;
  const sessionId = normalizeSessionId(payload && payload.conversationId, payload);
  const cwd = resolveCwd(payload);
  const body = {
    agent_id: "antigravity-cli",
    hook_source: "antigravity-hook",
    session_id: sessionId,
    tool_name: resolveToolName(payload),
    tool_input: resolveToolInput(payload),
  };

  if (cwd) body.cwd = cwd;
  if (Number.isInteger(payload && payload.stepIdx)) body.step_idx = payload.stepIdx;
  if (typeof (payload && payload.transcriptPath) === "string" && payload.transcriptPath) {
    body.transcript_path = payload.transcriptPath;
  }
  if (typeof (payload && payload.artifactDirectoryPath) === "string" && payload.artifactDirectoryPath) {
    body.artifact_directory_path = payload.artifactDirectoryPath;
  }

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

function sanitizeAntigravityPermissionOutput(rawBody, statusCode = 0) {
  if (statusCode === 204) return buildAntigravityNoDecisionOutput();
  if (typeof rawBody !== "string" || !rawBody.trim()) return buildAntigravityNoDecisionOutput();
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return buildAntigravityNoDecisionOutput();
  }

  const directDecision = parsed && typeof parsed.decision === "string" ? parsed.decision : "";
  const hookDecision = parsed
    && parsed.hookSpecificOutput
    && parsed.hookSpecificOutput.decision
    && typeof parsed.hookSpecificOutput.decision.behavior === "string"
    ? parsed.hookSpecificOutput.decision.behavior
    : "";
  const decision = directDecision || hookDecision;
  const normalized = decision === "deny" ? "deny"
    : (decision === "allow" ? "allow"
      : (decision === "ask" || decision === "force_ask" ? decision : null));
  if (!normalized) return buildAntigravityNoDecisionOutput();

  const out = { decision: normalized };
  const reason = typeof parsed.reason === "string" && parsed.reason
    ? parsed.reason
    : (parsed.hookSpecificOutput
      && parsed.hookSpecificOutput.decision
      && typeof parsed.hookSpecificOutput.decision.message === "string"
      ? parsed.hookSpecificOutput.decision.message
      : "");
  if (reason && normalized !== "allow") out.reason = reason;
  if (normalized === "allow") out.allowTool = true;
  if (normalized === "deny" && reason) out.denyReason = reason;
  return JSON.stringify(out);
}

function postStateBody(body, deps, env) {
  if (!body) return Promise.resolve({ posted: false, port: null });
  const postState = deps.postState || postStateToRunningServer;
  return new Promise((resolvePost) => {
    postState(JSON.stringify(body), { timeoutMs: 100, env }, (posted, port) => {
      resolvePost({ posted: !!posted, port: port || null });
    });
  });
}

function requestAntigravityPermission(body, deps = {}) {
  const env = deps.env || process.env;
  const postPermission = deps.postPermission || postPermissionToRunningServer;
  return new Promise((resolvePermission) => {
    postPermission(
      JSON.stringify(body),
      {
        timeoutMs: getAntigravityPermissionTimeoutMs(env),
        probeTimeoutMs: 100,
        env,
      },
      (ok, port, responseBody, statusCode) => {
        const stdout = ok
          ? sanitizeAntigravityPermissionOutput(responseBody, statusCode)
          : buildAntigravityNoDecisionOutput();
        writeAntigravityHookDebug(env, "permission-response", {
          sessionId: body && body.session_id,
          toolName: body && body.tool_name,
          posted: !!ok,
          port: port || null,
          statusCode: statusCode || 0,
          responseBody: typeof responseBody === "string" ? truncateDebugString(responseBody) : "",
          stdout,
        });
        resolvePermission({
          posted: !!ok,
          port: port || null,
          statusCode: statusCode || 0,
          stdout,
        });
      }
    );
  });
}

async function sendHookEvent(payload, argvEvent, deps = {}) {
  const env = deps.env || process.env;
  const hookName = resolveHookName(payload, argvEvent);
  const outLine = stdoutForEvent(hookName);
  const remote = !!env.CLAWD_REMOTE;
  const pidMeta = shouldResolvePid(hookName, env)
    ? (deps.resolvePid ? deps.resolvePid() : undefined)
    : undefined;
  const body = buildStateBody(hookName, payload || {}, {
    remote,
    host: remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined,
    pidMeta,
  });
  const permissionBody = buildPermissionBody(hookName, payload || {}, {
    remote,
    host: remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined,
    pidMeta,
  });

  if (permissionBody) {
    writeAntigravityHookDebug(env, "permission-request", {
      hookName,
      sessionId: permissionBody.session_id,
      toolName: permissionBody.tool_name,
      cwd: permissionBody.cwd || "",
      stepIdx: permissionBody.step_idx ?? null,
      toolInput: normalizeDebugValue(permissionBody.tool_input),
    });
  }

  if (!body) {
    if (!permissionBody) return { hookName, stdout: outLine, body: null, posted: false, port: null };
  }

  const stateResult = await postStateBody(body, deps, env);
  if (!permissionBody) {
    return { hookName, stdout: outLine, body, posted: stateResult.posted, port: stateResult.port };
  }

  const permissionResult = await requestAntigravityPermission(permissionBody, deps);
  writeAntigravityHookDebug(env, "hook-result", {
    hookName,
    sessionId: permissionBody.session_id,
    toolName: permissionBody.tool_name,
    stdout: permissionResult.stdout,
    permissionPosted: permissionResult.posted,
    permissionPort: permissionResult.port,
    permissionStatusCode: permissionResult.statusCode,
  });
  return {
    hookName,
    stdout: permissionResult.stdout,
    body,
    permissionBody,
    posted: stateResult.posted,
    port: stateResult.port,
    permissionPosted: permissionResult.posted,
    permissionPort: permissionResult.port,
    permissionStatusCode: permissionResult.statusCode,
  };
}

async function main(argvEvent = process.argv[2], deps = {}) {
  const payload = deps.payload !== undefined
    ? deps.payload
    : await (deps.readStdinJson || readStdinJson)();
  const result = await sendHookEvent(payload, argvEvent, {
    env: deps.env || process.env,
    postState: deps.postState || postStateToRunningServer,
    postPermission: deps.postPermission || postPermissionToRunningServer,
    readHostPrefix: deps.readHostPrefix || readHostPrefix,
    resolvePid: deps.resolvePid || resolve,
  });
  writeAntigravityHookDebug(deps.env || process.env, "stdout-write", {
    hookName: result.hookName,
    stdout: result.stdout,
  });
  process.stdout.write(result.stdout + "\n");
}

if (require.main === module) {
  main()
    .catch((err) => {
      // Antigravity treats a hook command failure as an agent failure. This
      // integration must fail open, so every local failure must fall back to
      // Antigravity's native behavior instead of aborting the agent run.
      writeAntigravityHookDebug(process.env, "hook-error", {
        hookName: process.argv[2] || "",
        error: err && err.message ? err.message : String(err || "unknown"),
      });
      process.stdout.write(stdoutForEvent(process.argv[2]) + "\n");
    })
    .finally(() => {
      process.exit(0);
    });
}

module.exports = {
  __test: {
    buildStateBody,
    buildPermissionBody,
    sanitizeAntigravityPermissionOutput,
    isAntigravityHookDebugEnabled,
    getAntigravityHookDebugLogPath,
    normalizeDebugValue,
    writeAntigravityHookDebug,
    buildAntigravityNoDecisionOutput,
    getAntigravityPermissionTimeoutMs,
    resolveHookName,
    resolveCwd,
    resolveToolName,
    resolveToolInput,
    sendHookEvent,
    shouldResolvePid,
    stdoutForEvent,
    isAntigravityAgentCommandLine,
  },
};
