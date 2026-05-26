#!/usr/bin/env node
// Clawd - Qwen Code lifecycle and permission hook.
// Registered in ~/.qwen/settings.json by hooks/qwen-code-install.js

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  postPermissionToRunningServer,
  postStateToRunningServer,
  readHostPrefix,
} = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;
const QWEN_PERMISSION_HTTP_TIMEOUT_MS = 590000;
const DEFAULT_HOOK_DEBUG_MAX_BYTES = 256 * 1024;

// Qwen Code 0.16.1 quirks driving this map:
//  1. Notification ~250ms after every Stop is a generic "task done" signal.
//     Drop it from the map so it never POSTs /state. The hook installer
//     still registers the event so qwen sees a hook and gets a clean `{}`
//     reply. PermissionRequest is on a separate code path and unaffected.
//  2. PostToolUse → UserPromptSubmit self-submit (~900-1000ms) is the
//     agentic-loop tool-result feedback, NOT user input. It used to flash
//     "thinking" between working and idle. The server-side filter in
//     `src/state.js#updateSession` (lastBoundaryAt + 2s window) drops these
//     synthetic events, so Stop can stay on "attention" and play the happy
//     end-of-turn animation. SessionEnd → sleeping handles true session end.
const EVENT_TO_STATE = {
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  Stop: "attention",
};

function normalizeQwenSessionId(value) {
  const raw = value != null && value !== "" ? String(value) : "default";
  return raw.startsWith("qwen-code:") ? raw : `qwen-code:${raw}`;
}

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
      ? `${value.slice(0, Math.max(0, TOOL_MATCH_STRING_MAX - 3))}...`
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

function resolveHookName(payload, argvEvent) {
  return (payload && typeof payload.hook_event_name === "string" && payload.hook_event_name)
    || (typeof argvEvent === "string" ? argvEvent : "")
    || "";
}

function readHookDebugMaxBytes(env = process.env) {
  const raw = env.CLAWD_QWEN_HOOK_DEBUG_MAX_BYTES;
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_HOOK_DEBUG_MAX_BYTES;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_HOOK_DEBUG_MAX_BYTES;
  return parsed;
}

function appendHookDebug(entry, env = process.env) {
  if (env.CLAWD_QWEN_HOOK_DEBUG !== "1") return;
  const debugPath = env.CLAWD_QWEN_HOOK_DEBUG_PATH
    || path.join(os.homedir(), ".clawd", "qwen-hook-debug.jsonl");
  try {
    const line = `${JSON.stringify(entry)}\n`;
    const maxBytes = readHookDebugMaxBytes(env);
    if (maxBytes > 0) {
      let currentSize = 0;
      try {
        currentSize = fs.statSync(debugPath).size || 0;
      } catch {}
      if (currentSize + Buffer.byteLength(line) > maxBytes) return;
    }
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.appendFileSync(debugPath, line);
  } catch {}
}

function isQwenAgentCommandLine(cmd) {
  if (typeof cmd !== "string") return false;
  const normalized = cmd.toLowerCase().replace(/\\/g, "/");
  return normalized.includes("@qwen-code/qwen-code")
    || normalized.includes("/node_modules/.bin/qwen")
    || /(^|[\s"'/])qwen(\.js)?($|[\s"'/])/.test(normalized);
}

function applyLocalProcessFields(body, resolve) {
  const { stablePid, agentPid, detectedEditor, pidChain } = resolve();
  if (Number.isFinite(stablePid) && stablePid > 0) body.source_pid = Math.floor(stablePid);
  if (detectedEditor) body.editor = detectedEditor;
  if (Number.isFinite(agentPid) && agentPid > 0) body.agent_pid = Math.floor(agentPid);
  if (Array.isArray(pidChain) && pidChain.length) body.pid_chain = pidChain;
}

function maybeAddToolMetadata(body, payload) {
  const toolName = typeof payload.tool_name === "string" && payload.tool_name ? payload.tool_name : null;
  const toolUseId = normalizeToolUseId(payload.tool_use_id ?? payload.toolUseId ?? payload.toolUseID);
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : null;
  const toolInputFingerprint = buildToolInputFingerprint(toolInput);
  if (toolName) body.tool_name = toolName;
  if (toolUseId) body.tool_use_id = toolUseId;
  if (toolInputFingerprint) body.tool_input_fingerprint = toolInputFingerprint;
}

function buildStateBody(hookName, payload, resolve, options = {}) {
  if (!EVENT_TO_STATE[hookName]) return null;

  const body = {
    state: EVENT_TO_STATE[hookName],
    session_id: normalizeQwenSessionId(payload && payload.session_id),
    event: hookName,
    agent_id: "qwen-code",
  };

  if (payload && typeof payload.cwd === "string" && payload.cwd) body.cwd = payload.cwd;
  if (payload && typeof payload.model === "string" && payload.model) body.model = payload.model;
  if (payload && typeof payload.permission_mode === "string" && payload.permission_mode) {
    body.permission_mode = payload.permission_mode;
  }
  if (payload && typeof payload.transcript_path === "string" && payload.transcript_path) {
    body.transcript_path = payload.transcript_path;
  }
  if (payload && (hookName === "PreToolUse" || hookName === "PostToolUse")) {
    maybeAddToolMetadata(body, payload);
  }

  if (options.remote) {
    body.host = options.host || readHostPrefix();
  } else {
    applyLocalProcessFields(body, resolve);
  }

  return body;
}

function sanitizeQwenPermissionDecision(decision) {
  if (!decision || typeof decision !== "object") return null;
  const behavior = decision.behavior === "deny" ? "deny"
    : (decision.behavior === "allow" ? "allow" : null);
  if (!behavior) return null;
  const out = { behavior };
  if (behavior === "deny" && typeof decision.message === "string" && decision.message) {
    out.message = decision.message;
  }
  return out;
}

function buildQwenNoDecisionOutput() {
  return "{}";
}

function buildQwenPermissionOutput(decision) {
  const safeDecision = sanitizeQwenPermissionDecision(decision);
  if (!safeDecision) return buildQwenNoDecisionOutput();
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: safeDecision,
    },
  });
}

function sanitizeQwenPermissionOutput(rawBody) {
  if (typeof rawBody !== "string" || !rawBody.trim()) return buildQwenNoDecisionOutput();
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return buildQwenNoDecisionOutput();
  }
  const decision = parsed
    && parsed.hookSpecificOutput
    && parsed.hookSpecificOutput.hookEventName === "PermissionRequest"
    ? parsed.hookSpecificOutput.decision
    : null;
  return buildQwenPermissionOutput(decision);
}

function buildPermissionBody(hookName, payload, resolve, options = {}) {
  if (hookName !== "PermissionRequest") return null;
  const rawToolInput = payload && payload.tool_input && typeof payload.tool_input === "object"
    ? payload.tool_input
    : {};
  const toolName = payload && typeof payload.tool_name === "string" && payload.tool_name
    ? payload.tool_name
    : "Unknown";
  const body = {
    agent_id: "qwen-code",
    session_id: normalizeQwenSessionId(payload && payload.session_id),
    tool_name: toolName,
    tool_input: normalizeToolMatchValue(rawToolInput) || {},
    permission_suggestions: [],
  };

  if (payload && typeof payload.cwd === "string" && payload.cwd) body.cwd = payload.cwd;
  if (payload && typeof payload.model === "string" && payload.model) body.model = payload.model;
  if (payload && typeof payload.permission_mode === "string" && payload.permission_mode) {
    body.permission_mode = payload.permission_mode;
  }
  if (payload && typeof payload.transcript_path === "string" && payload.transcript_path) {
    body.transcript_path = payload.transcript_path;
  }

  const toolUseId = normalizeToolUseId(payload && (payload.tool_use_id ?? payload.toolUseId ?? payload.toolUseID));
  const toolInputFingerprint = buildToolInputFingerprint(rawToolInput);
  if (toolUseId) body.tool_use_id = toolUseId;
  if (toolInputFingerprint) body.tool_input_fingerprint = toolInputFingerprint;

  if (options.remote) {
    body.host = options.host || readHostPrefix();
  } else {
    applyLocalProcessFields(body, resolve);
  }
  return body;
}

function requestQwenPermission(body, callback, deps = {}) {
  const postPermission = deps.postPermission || postPermissionToRunningServer;
  postPermission(
    JSON.stringify(body),
    {
      timeoutMs: QWEN_PERMISSION_HTTP_TIMEOUT_MS,
      probeTimeoutMs: 100,
    },
    (ok, _port, responseBody) => {
      callback(ok ? sanitizeQwenPermissionOutput(responseBody) : buildQwenNoDecisionOutput());
    }
  );
}

async function run(payload, argvEvent, deps = {}) {
  const env = deps.env || process.env;
  const hookName = resolveHookName(payload, argvEvent);
  const remote = !!env.CLAWD_REMOTE;
  const resolve = deps.resolvePid || (() => ({}));
  const host = remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined;

  const permissionBody = buildPermissionBody(hookName, payload || {}, resolve, { remote, host });
  if (permissionBody) {
    return new Promise((resolveRun) => {
      requestQwenPermission(permissionBody, (stdout) => {
        resolveRun({ hookName, stdout, body: permissionBody, posted: true });
      }, deps);
    });
  }

  const body = buildStateBody(hookName, payload || {}, resolve, { remote, host });
  if (!body) return { hookName, stdout: buildQwenNoDecisionOutput(), body: null, posted: false };

  return new Promise((resolveRun) => {
    const postState = deps.postState || postStateToRunningServer;
    postState(JSON.stringify(body), { timeoutMs: 100 }, (posted, port) => {
      resolveRun({ hookName, stdout: buildQwenNoDecisionOutput(), body, posted: !!posted, port: port || null });
    });
  });
}

async function main(argvEvent = process.argv[2], deps = {}) {
  try {
    const payload = deps.payload !== undefined
      ? deps.payload
      : await (deps.readStdinJson || readStdinJson)();
    const config = getPlatformConfig();
    const resolve = deps.resolvePid || createPidResolver({
      agentNames: { win: new Set(["qwen.exe"]), mac: new Set(["qwen"]), linux: new Set(["qwen"]) },
      agentCmdlineCheck: isQwenAgentCommandLine,
      platformConfig: config,
    });
    const result = await run(payload || {}, argvEvent, {
      ...deps,
      resolvePid: resolve,
      readHostPrefix: deps.readHostPrefix || readHostPrefix,
    });
    appendHookDebug({
      at: new Date().toISOString(),
      event: result.hookName,
      posted: result.posted,
      body_event: result.body && result.body.event,
      body_state: result.body && result.body.state,
    }, deps.env || process.env);
    process.stdout.write(`${result.stdout}\n`);
  } catch (err) {
    appendHookDebug({
      at: new Date().toISOString(),
      error: err && err.message ? err.message : String(err),
    }, deps.env || process.env);
    process.stdout.write(`${buildQwenNoDecisionOutput()}\n`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0), () => {
    process.stdout.write(`${buildQwenNoDecisionOutput()}\n`);
    process.exit(0);
  });
}

module.exports = {
  EVENT_TO_STATE,
  QWEN_PERMISSION_HTTP_TIMEOUT_MS,
  appendHookDebug,
  buildPermissionBody,
  buildQwenNoDecisionOutput,
  buildQwenPermissionOutput,
  buildStateBody,
  buildToolInputFingerprint,
  isQwenAgentCommandLine,
  main,
  normalizeQwenSessionId,
  normalizeToolMatchValue,
  requestQwenPermission,
  resolveHookName,
  run,
  sanitizeQwenPermissionDecision,
  sanitizeQwenPermissionOutput,
};
