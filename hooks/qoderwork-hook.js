#!/usr/bin/env node
// Clawd — QoderWork hook (Phase 1: state-only).
//
// Registered in ~/.qoderwork/settings.json by hooks/qoderwork-install.js.
// Reads the hook payload from stdin (JSON with hook_event_name), POSTs a
// state event to the running Clawd server, and ALWAYS writes `{}` to stdout.
// Clawd never answers a QoderWork permission decision in Phase 1, so
// PermissionRequest / PermissionDenied are observed as passive `working`
// state only and QoderWork's native permission flow stays in control.

const crypto = require("crypto");
const { postStateToRunningServer, readHostPrefix, applyWslSourceFields } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;

// QoderWork hook event → { state, event } for the Clawd state machine. Every
// event returns `{}` (no gating) in Phase 1.
const HOOK_MAP = {
  SessionStart:       { state: "idle",         event: "SessionStart" },
  UserPromptSubmit:   { state: "thinking",     event: "UserPromptSubmit" },
  PreToolUse:         { state: "working",      event: "PreToolUse" },
  PostToolUse:        { state: "working",      event: "PostToolUse" },
  PostToolUseFailure: { state: "error",        event: "PostToolUseFailure" },
  Stop:               { state: "attention",    event: "Stop" },
  Notification:       { state: "notification", event: "Notification" },
  // State-only: QoderWork's permission events are part of its normal working
  // flow (file reads, command execution, etc.), NOT user-facing notifications.
  // Map to "working" so the pet stays in its working animation instead of
  // flashing notification repeatedly (40+ events per task). The hook still
  // returns `{}` — Clawd never answers the permission decision in Phase 1.
  PermissionRequest:  { state: "working",      event: "PreToolUse" },
  PermissionDenied:   { state: "working",      event: "PreToolUse" },
  SessionEnd:         { state: "sleeping",     event: "SessionEnd" },
};

const NO_DECISION_OUTPUT = "{}";

// Raw hook session IDs are namespaced as `qoderwork:<raw>`. The
// `local|agent|session` shape is for session-alias keys (src/session-alias.js),
// NOT raw hook IDs.
function normalizeSessionId(value) {
  const raw = value != null && value !== "" ? String(value) : "default";
  return raw.startsWith("qoderwork:") ? raw : `qoderwork:${raw}`;
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

// Match `QoderWork` as an executable token (bounded by path separators,
// quotes, or whitespace). We deliberately do NOT match `qodercli` here
// because it is shared with Qoder IDE and cannot be attributed to
// QoderWork specifically.
function isQoderWorkAgentCommandLine(cmd) {
  if (typeof cmd !== "string") return false;
  const normalized = cmd.toLowerCase().replace(/\\/g, "/");
  return /(^|[\s"'/])qoderwork(\.exe)?($|[\s"'/])/.test(normalized);
}

const config = getPlatformConfig();
const defaultResolve = createPidResolver({
  agentNames: {
    // Only match QoderWork IDE process — `qodercli` is shared with Qoder IDE
    // and would cause cross-agent mis-attribution.
    win: new Set(["qoderwork.exe"]),
    mac: new Set(["qoderwork"]),
    linux: new Set(["qoderwork"]),
  },
  agentCmdlineCheck: isQoderWorkAgentCommandLine,
  platformConfig: config,
});

function resolveHookName(payload, argvEvent) {
  return (payload && typeof payload.hook_event_name === "string" && payload.hook_event_name)
    || (typeof argvEvent === "string" ? argvEvent : "")
    || "";
}

// PermissionRequest / PermissionDenied fire 40+ times per task and QoderWork
// waits on the hook's stdout before continuing its native permission flow, so
// skip the process-tree walk (PowerShell snapshot on Windows) for them. The
// server keeps a session's existing pids when an event arrives without them,
// and every other lifecycle event still refreshes pid metadata.
const PID_RESOLUTION_SKIP_EVENTS = new Set(["PermissionRequest", "PermissionDenied"]);

function shouldResolvePid(hookName, env = process.env) {
  return !!HOOK_MAP[hookName]
    && !PID_RESOLUTION_SKIP_EVENTS.has(hookName)
    && !env.CLAWD_REMOTE;
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
    agent_id: "qoderwork",
  };

  if (payload && typeof payload.cwd === "string" && payload.cwd) body.cwd = payload.cwd;
  if (payload && typeof payload.model === "string" && payload.model) body.model = payload.model;
  if (payload && typeof payload.permission_mode === "string" && payload.permission_mode) {
    body.permission_mode = payload.permission_mode;
  }
  if (payload && typeof payload.transcript_path === "string" && payload.transcript_path) {
    body.transcript_path = payload.transcript_path;
  }

  // Session title: only set from high-quality sources. Do NOT send cwd
  // fallback here \u2014 the server's state-session-snapshot.js already resolves
  // path.basename(session.cwd) when no title is stored. Sending a low-quality
  // workspace ID (e.g. "mqgw60jiigjsjcid") as session_title would overwrite a
  // good title via the server's sticky `||` chain on subsequent events.
  //
  // Priority: session_title \u2192 prompt first line \u2192 parent_business_info.name.
  const rawTitle = payload && typeof payload.session_title === "string" ? payload.session_title.trim() : "";
  if (rawTitle) {
    body.session_title = rawTitle;
  } else if (hookName === "UserPromptSubmit" && payload && typeof payload.prompt === "string") {
    // On UserPromptSubmit, use the first non-blank line of the user prompt
    // as the session title (matches clawd-hook.js behaviour).
    for (const line of payload.prompt.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate) {
        body.session_title = candidate.length > 60 ? `${candidate.slice(0, 59)}\u2026` : candidate;
        break;
      }
    }
  } else if (payload && payload.parent_business_info && typeof payload.parent_business_info.name === "string") {
    // Stop events carry the QoderWork task name via parent_business_info.name.
    const bizName = payload.parent_business_info.name.trim();
    if (bizName) {
      body.session_title = bizName.length > 60 ? `${bizName.slice(0, 59)}\u2026` : bizName;
    }
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
  isQoderWorkAgentCommandLine,
  resolveHookName,
  shouldResolvePid,
  main,
};
