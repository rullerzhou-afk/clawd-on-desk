#!/usr/bin/env node
// Clawd — Qoder hook (Phase 1: state-only).
//
// Registered in ~/.qoder/settings.json by hooks/qoder-install.js. Reads the
// hook payload from stdin (JSON with hook_event_name), POSTs a state event to
// the running Clawd server, and ALWAYS writes `{}` to stdout. Clawd never
// answers a Qoder permission decision in Phase 1, so PermissionRequest /
// PermissionDenied are observed as passive `notification` state only and
// Qoder's native permission flow stays in control.

const crypto = require("crypto");
const { postStateToRunningServer, readHostPrefix, applyWslSourceFields } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;

// Qoder hook event → { state, event } for the Clawd state machine. Every
// event returns `{}` (no gating) in Phase 1.
const HOOK_MAP = {
  SessionStart:       { state: "idle",         event: "SessionStart" },
  UserPromptSubmit:   { state: "thinking",     event: "UserPromptSubmit" },
  PreToolUse:         { state: "working",      event: "PreToolUse" },
  PostToolUse:        { state: "working",      event: "PostToolUse" },
  PostToolUseFailure: { state: "error",        event: "PostToolUseFailure" },
  Stop:               { state: "attention",    event: "Stop" },
  Notification:       { state: "notification", event: "Notification" },
  // State-only: Qoder's permission events are surfaced as a passive Clawd
  // Notification (event: "Notification"), NOT as a Clawd PermissionRequest.
  // That keeps them on the normal notification path so they (a) honor the
  // per-agent notification-hook mute toggle in state.js and (b) write session
  // bookkeeping consistently — Clawd never answers the decision and the hook
  // still returns `{}`. Phase 1 does not distinguish the originating Qoder
  // event, so both collapse to a single Notification cue.
  PermissionRequest:  { state: "notification", event: "Notification" },
  PermissionDenied:   { state: "notification", event: "Notification" },
  SessionEnd:         { state: "sleeping",     event: "SessionEnd" },
};

const NO_DECISION_OUTPUT = "{}";

// Raw hook session IDs are namespaced as `qoder:<raw>`. The `local|agent|session`
// shape is for session-alias keys (src/session-alias.js), NOT raw hook IDs.
function normalizeSessionId(value) {
  const raw = value != null && value !== "" ? String(value) : "default";
  return raw.startsWith("qoder:") ? raw : `qoder:${raw}`;
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

// Match `qoder` / `qodercli` / `qoder-cli` as an executable token (bounded by
// path separators, quotes, or whitespace) instead of a bare `includes("qoder")`
// substring, so a node process running inside an unrelated `~/qoder-notes/`
// repo is not misattributed to the Qoder agent. `qodercli` is the official CLI
// binary (npm @qoder-ai/qodercli); `qoder-cli` is kept as a defensive alias.
function isQoderAgentCommandLine(cmd) {
  if (typeof cmd !== "string") return false;
  const normalized = cmd.toLowerCase().replace(/\\/g, "/");
  return normalized.includes("node_modules/.bin/qodercli")
    || normalized.includes("node_modules/.bin/qoder")
    || /(^|[\s"'/])qoder(cli|-cli)?(\.js)?($|[\s"'/])/.test(normalized);
}

const config = getPlatformConfig();
const defaultResolve = createPidResolver({
  agentNames: {
    win: new Set(["qoder.exe", "qodercli.exe", "qoder-cli.exe"]),
    mac: new Set(["qoder", "qodercli", "qoder-cli"]),
    linux: new Set(["qoder", "qodercli", "qoder-cli"]),
  },
  agentCmdlineCheck: isQoderAgentCommandLine,
  platformConfig: config,
});

function resolveHookName(payload, argvEvent) {
  return (payload && typeof payload.hook_event_name === "string" && payload.hook_event_name)
    || (typeof argvEvent === "string" ? argvEvent : "")
    || "";
}

function shouldResolvePid(hookName, env = process.env) {
  return !!HOOK_MAP[hookName] && !env.CLAWD_REMOTE;
}

function applyLocalProcessFields(body, pidMeta) {
  if (!pidMeta || typeof pidMeta !== "object") return;
  if (Number.isFinite(pidMeta.stablePid) && pidMeta.stablePid > 0) body.source_pid = Math.floor(pidMeta.stablePid);
  if (pidMeta.detectedEditor) body.editor = pidMeta.detectedEditor;
  if (Number.isFinite(pidMeta.agentPid) && pidMeta.agentPid > 0) body.agent_pid = Math.floor(pidMeta.agentPid);
  if (Array.isArray(pidMeta.pidChain) && pidMeta.pidChain.length) body.pid_chain = pidMeta.pidChain;
  if (pidMeta.tmuxSocket) body.tmux_socket = pidMeta.tmuxSocket;
  if (pidMeta.tmuxClient) body.tmux_client = pidMeta.tmuxClient;
}

const TOOL_METADATA_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "PermissionDenied",
]);

function maybeAddToolMetadata(body, payload) {
  const toolName = typeof payload.tool_name === "string" && payload.tool_name ? payload.tool_name : null;
  const toolUseId = normalizeToolUseId(payload.tool_use_id ?? payload.toolUseId ?? payload.toolUseID);
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : null;
  const toolInputFingerprint = buildToolInputFingerprint(toolInput);
  if (toolName) body.tool_name = toolName;
  if (toolUseId) body.tool_use_id = toolUseId;
  if (toolInputFingerprint) body.tool_input_fingerprint = toolInputFingerprint;
}

function buildStateBody(hookName, payload, options = {}) {
  const mapped = HOOK_MAP[hookName];
  if (!mapped) return null;

  const body = {
    state: mapped.state,
    session_id: normalizeSessionId(payload && payload.session_id),
    event: mapped.event,
    agent_id: "qoder",
  };

  if (payload && typeof payload.cwd === "string" && payload.cwd) body.cwd = payload.cwd;
  if (payload && typeof payload.model === "string" && payload.model) body.model = payload.model;
  if (payload && typeof payload.permission_mode === "string" && payload.permission_mode) {
    body.permission_mode = payload.permission_mode;
  }
  if (payload && typeof payload.transcript_path === "string" && payload.transcript_path) {
    body.transcript_path = payload.transcript_path;
  }
  if (payload && TOOL_METADATA_EVENTS.has(hookName)) {
    maybeAddToolMetadata(body, payload);
  }

  if (options.remote) {
    body.host = options.host || readHostPrefix();
    applyWslSourceFields(body, { remote: true });
  } else {
    applyWslSourceFields(body);
    applyLocalProcessFields(body, options.pidMeta);
  }

  return body;
}

function sendHookEvent(payload, argvEvent, deps = {}) {
  const env = deps.env || process.env;
  const hookName = resolveHookName(payload, argvEvent);
  const remote = !!env.CLAWD_REMOTE;
  const body = buildStateBody(hookName, payload, {
    remote,
    host: remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined,
    pidMeta: shouldResolvePid(hookName, env)
      ? (deps.resolvePid ? deps.resolvePid() : undefined)
      : undefined,
  });

  if (!body) {
    return Promise.resolve({ hookName, stdout: NO_DECISION_OUTPUT, body: null, posted: false, port: null });
  }

  const postState = deps.postState || postStateToRunningServer;
  return new Promise((resolvePost) => {
    postState(JSON.stringify(body), { timeoutMs: 100 }, (posted, port) => {
      resolvePost({ hookName, stdout: NO_DECISION_OUTPUT, body, posted: !!posted, port: port || null });
    });
  });
}

async function main(argvEvent = process.argv[2], deps = {}) {
  try {
    const payload = deps.payload !== undefined
      ? deps.payload
      : await (deps.readStdinJson || readStdinJson)();
    const result = await sendHookEvent(payload || {}, argvEvent, {
      env: deps.env || process.env,
      postState: deps.postState || postStateToRunningServer,
      readHostPrefix: deps.readHostPrefix || readHostPrefix,
      resolvePid: deps.resolvePid || defaultResolve,
    });
    process.stdout.write(`${result.stdout}\n`);
  } catch {
    process.stdout.write(`${NO_DECISION_OUTPUT}\n`);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0), () => {
    process.stdout.write(`${NO_DECISION_OUTPUT}\n`);
    process.exit(0);
  });
}

module.exports = {
  HOOK_MAP,
  NO_DECISION_OUTPUT,
  buildStateBody,
  sendHookEvent,
  normalizeSessionId,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
  isQoderAgentCommandLine,
  resolveHookName,
  shouldResolvePid,
  main,
};
