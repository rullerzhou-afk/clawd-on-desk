#!/usr/bin/env node
// Clawd - ZCode lifecycle hook (state-only).
// Registered in ~/.zcode/cli/config.json by hooks/zcode-install.js.
//
// ZCode (智谱/Z.ai) is an Electron desktop ADE. Legacy 3.4.x builds spawned a
// standalone `zcode-cli`; current macOS 3.5.x builds run Resources/glm/zcode.cjs
// through Electron's Node mode. That per-session runtime fires these command
// hooks. Phase 1 is state-only: every event maps to a pet state and POSTs
// /state; stdout is always "{}" (no blocking permission decisions).
// ZCode supports exactly 7 events (SessionStart, UserPromptSubmit, PreToolUse,
// PermissionRequest, PostToolUse, PostToolUseFailure, Stop). It does NOT
// support SessionEnd or Notification — session end relies on Stop + the app's
// auto-fallback timeout.

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  postStateToRunningServer,
  readHostPrefix,
  applyWslSourceFields,
} = require("./server-config");
const {
  createPidResolver,
  readStdinJsonDetailed,
  getPlatformConfig,
  applyOrcaPaneKey,
} = require("./shared-process");

const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;
const DEFAULT_HOOK_DEBUG_MAX_BYTES = 256 * 1024;

const EVENT_TO_STATE = {
  SessionStart: "idle",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  Stop: "attention",
};

const EVENT_TO_PID_LIFECYCLE = {
  SessionStart: "start",
  UserPromptSubmit: "prompt",
};

function normalizeZcodeSessionId(value) {
  const raw = value != null && value !== "" ? String(value) : "default";
  return raw.startsWith("zcode:") ? raw : `zcode:${raw}`;
}

function getZcodePidResolverContext(hookName, payload) {
  const rawSessionId = payload && typeof payload.session_id === "string"
    ? payload.session_id.trim()
    : "";
  const cacheCwd = payload && typeof payload.cwd === "string" ? payload.cwd : "";
  const isDefaultSession = rawSessionId === "default" || rawSessionId === "zcode:default";
  return {
    namespace: "zcode",
    sessionId: rawSessionId || "default",
    cacheCwd,
    lifecycle: EVENT_TO_PID_LIFECYCLE[hookName] || "event",
    cacheable: !!rawSessionId && !isDefaultSession && !!cacheCwd,
  };
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
  return require("crypto")
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
  const raw = env.CLAWD_ZCODE_HOOK_DEBUG_MAX_BYTES;
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_HOOK_DEBUG_MAX_BYTES;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_HOOK_DEBUG_MAX_BYTES;
  return parsed;
}

function appendHookDebug(entry, env = process.env) {
  if (env.CLAWD_ZCODE_HOOK_DEBUG !== "1") return;
  const debugPath = env.CLAWD_ZCODE_HOOK_DEBUG_PATH
    || path.join(os.homedir(), ".clawd", "zcode-hook-debug.jsonl");
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

function stdinParseErrorCategory(value) {
  return value ? "invalid-json" : null;
}

// Detect both the legacy standalone `zcode-cli` and the current Electron
// Node-mode runtime (`.../ZCode .../Resources/glm/zcode.cjs app-server
// --stdio`). The executable name is shared with the always-running desktop
// shell, so `zcode`/`zcode.exe` is only eligible for a command-line probe; the
// `zcode.cjs` token is what prevents the shell from being mis-credited.
function isZcodeAgentCommandLine(cmd) {
  if (typeof cmd !== "string") return false;
  const normalized = cmd.toLowerCase().replace(/\\/g, "/");
  return /(^|[\s"'/])zcode-cli(\.js|\.exe)?($|[\s"'/])/.test(normalized)
    || normalized.includes("/zcode-cli")
    || normalized.includes("zcode-hook.js")
    || normalized.includes("zcode.cjs");
}

function getZcodePidResolverOptions(platformConfig) {
  return {
    agentNames: {
      win: new Set(["zcode-cli.exe"]),
      mac: new Set(["zcode-cli"]),
      linux: new Set(["zcode-cli"]),
    },
    agentCmdlineCheck: isZcodeAgentCommandLine,
    // POSIX ps normalizes /Applications/ZCode.app/Contents/MacOS/ZCode to
    // "zcode". Keep node fallbacks for unpacked/dev launches.
    agentCmdlineNames: new Set(["zcode", "zcode.exe", "node.exe", "node"]),
    platformConfig,
  };
}

function getZcodePlatformConfig(factory = getPlatformConfig) {
  return factory({
    // ZCode is a GUI host, not a terminal. Without this boundary the closest
    // Windows "terminal" is often the short-lived PowerShell command wrapper,
    // which makes source_pid die immediately and prevents the durable PID cache
    // from ever hitting on later events.
    extraTerminals: { win: ["zcode.exe"] },
  });
}

function applyLocalProcessFields(body, resolved = {}) {
  const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = resolved;
  if (Number.isFinite(stablePid) && stablePid > 0) body.source_pid = Math.floor(stablePid);
  if (detectedEditor) body.editor = detectedEditor;
  if (Number.isFinite(agentPid) && agentPid > 0) body.agent_pid = Math.floor(agentPid);
  if (Array.isArray(pidChain) && pidChain.length) body.pid_chain = pidChain;
  if (tmuxSocket) body.tmux_socket = tmuxSocket;
  if (tmuxClient) body.tmux_client = tmuxClient;
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
    session_id: normalizeZcodeSessionId(payload && payload.session_id),
    event: hookName,
    agent_id: "zcode",
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
    applyWslSourceFields(body, { remote: true });
    applyOrcaPaneKey(body, options.env);
  } else {
    applyWslSourceFields(body);
    applyOrcaPaneKey(body, options.env);
    const resolved = resolve(getZcodePidResolverContext(hookName, payload || {})) || {};
    applyLocalProcessFields(body, resolved);
    if (typeof options.onProcessMeta === "function") options.onProcessMeta(resolved);
  }

  return body;
}

function buildNoDecisionOutput() {
  return "{}";
}

async function run(payload, argvEvent, deps = {}) {
  const env = deps.env || process.env;
  const hookName = resolveHookName(payload, argvEvent);
  const remote = !!env.CLAWD_REMOTE;
  const resolve = deps.resolvePid || (() => ({}));
  const host = remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined;
  let processMeta = null;

  const body = buildStateBody(hookName, payload || {}, resolve, {
    remote,
    host,
    env,
    onProcessMeta(meta) {
      processMeta = meta;
    },
  });
  if (!body) {
    return {
      hookName,
      stdout: buildNoDecisionOutput(),
      body: null,
      posted: false,
      processMeta,
    };
  }

  return new Promise((resolveRun) => {
    const postState = deps.postState || postStateToRunningServer;
    postState(JSON.stringify(body), { timeoutMs: 100 }, (posted, port) => {
      resolveRun({
        hookName,
        stdout: buildNoDecisionOutput(),
        body,
        posted: !!posted,
        port: port || null,
        processMeta,
      });
    });
  });
}

async function main(argvEvent = process.argv[2], deps = {}) {
  try {
    let stdinResult;
    if (deps.payload !== undefined) {
      stdinResult = {
        payload: deps.payload,
        bytes: Number.isFinite(deps.stdinBytes) ? deps.stdinBytes : 0,
        timedOut: false,
        parseError: null,
        durationMs: 0,
      };
    } else if (typeof deps.readStdinJsonDetailed === "function") {
      stdinResult = await deps.readStdinJsonDetailed();
    } else if (typeof deps.readStdinJson === "function") {
      stdinResult = {
        payload: await deps.readStdinJson(),
        bytes: 0,
        timedOut: false,
        parseError: null,
        durationMs: 0,
      };
    } else {
      stdinResult = await readStdinJsonDetailed();
    }
    const payload = stdinResult.payload || {};
    const config = getZcodePlatformConfig();
    const resolve = deps.resolvePid || createPidResolver(getZcodePidResolverOptions(config));
    const result = await run(payload, argvEvent, {
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
      has_session_id: typeof payload.session_id === "string" && !!payload.session_id.trim(),
      has_cwd: typeof payload.cwd === "string" && !!payload.cwd,
      stdin_bytes: stdinResult.bytes,
      stdin_timed_out: stdinResult.timedOut === true,
      // JSON.parse errors can include input fragments on newer Node releases.
      // Keep diagnostics useful without copying hook payload into JSONL.
      stdin_parse_error: stdinParseErrorCategory(stdinResult.parseError),
      cache_source: result.processMeta && result.processMeta.cacheSource
        ? result.processMeta.cacheSource
        : null,
      source_pid_found: !!(result.body && result.body.source_pid),
      agent_pid_found: !!(result.body && result.body.agent_pid),
    }, deps.env || process.env);
    process.stdout.write(`${result.stdout}\n`);
  } catch (err) {
    appendHookDebug({
      at: new Date().toISOString(),
      error: err && err.message ? err.message : String(err),
    }, deps.env || process.env);
    process.stdout.write(`${buildNoDecisionOutput()}\n`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0), () => {
    process.stdout.write(`${buildNoDecisionOutput()}\n`);
    process.exit(0);
  });
}

module.exports = {
  EVENT_TO_PID_LIFECYCLE,
  EVENT_TO_STATE,
  appendHookDebug,
  buildStateBody,
  buildToolInputFingerprint,
  getZcodePidResolverContext,
  getZcodePidResolverOptions,
  getZcodePlatformConfig,
  isZcodeAgentCommandLine,
  main,
  normalizeZcodeSessionId,
  normalizeToolMatchValue,
  resolveHookName,
  run,
  stdinParseErrorCategory,
};
