#!/usr/bin/env node
// Clawd — QwenWork hook (Phase 1: state-only).
//
// Registered in ~/.QwenWorkCN/settings.json by hooks/qwenwork-install.js.
// Reads the hook payload from stdin (JSON with hook_event_name), POSTs a
// state event to the running Clawd server, and ALWAYS writes `{}` to stdout.
// Clawd never answers a QwenWork permission decision in Phase 1, so
// PermissionRequest / PermissionDenied are observed as passive `working`
// state only and QwenWork's native permission flow stays in control.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { postStateToRunningServer, readHostPrefix, applyWslSourceFields } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig, applyOrcaPaneKey } = require("./shared-process");

const DEFAULT_HOOK_DEBUG_MAX_BYTES = 256 * 1024;
const HOOK_DEBUG_FIELDS_MAX = 64;
const HOOK_DEBUG_FIELD_NAME_MAX = 64;
const HOOK_DEBUG_DIR_MODE = 0o700;
const HOOK_DEBUG_FILE_MODE = 0o600;

// ── Debug logging ────────────────────────────────────────────────────────────
// QwenWork's stdin payload shape is not fully documented, so troubleshooting
// needs to see what actually arrived. But that payload carries the user's
// prompt, tool input, local paths and business metadata, so there are TWO
// levels:
//
//   CLAWD_QWENWORK_HOOK_DEBUG=1      → summary only. Event names, whether the
//                                      POST landed, the mapped state/event and
//                                      a field-SHAPE summary (key names plus
//                                      type/length). No values, ever.
//   ...and CLAWD_QWENWORK_HOOK_DEBUG_RAW=1
//                                    → adds `rawPayload`: the COMPLETE, VERBATIM
//                                      hook payload. THIS FILE THEN CONTAINS
//                                      SENSITIVE DATA — prompts, tool inputs,
//                                      file paths, business names. Only turn it
//                                      on deliberately, and delete the file
//                                      afterwards.
//
// The file is written 0600 on POSIX. A debug directory created by this hook is
// tightened to 0700; an existing shared ~/.clawd keeps its current permissions
// (Windows keeps the inherited ACL; chmod there only maps to the read-only
// bit). Every failure is swallowed: debug logging must never change the hook's
// stdout or exit code.
function readHookDebugMaxBytes(env = process.env) {
  const raw = env.CLAWD_QWENWORK_HOOK_DEBUG_MAX_BYTES;
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_HOOK_DEBUG_MAX_BYTES;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_HOOK_DEBUG_MAX_BYTES;
  return parsed;
}

function hookDebugMode(env = process.env) {
  if (!env || env.CLAWD_QWENWORK_HOOK_DEBUG !== "1") return "off";
  return env.CLAWD_QWENWORK_HOOK_DEBUG_RAW === "1" ? "raw" : "summary";
}

// Type + size of a field, never its contents.
function describeDebugValue(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(len=${value.length})`;
  const type = typeof value;
  if (type === "string") return `string(len=${value.length})`;
  if (type === "object") return `object(keys=${Object.keys(value).length})`;
  return type;
}

// Top-level key names are QwenWork's schema, not user content, so listing them
// is the whole point: it answers "which fields does this event actually carry".
// Values are never read, and nested objects are described by key count only.
function summarizeHookPayload(payload) {
  if (payload === undefined || payload === null) return { present: false };
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return { present: true, shape: describeDebugValue(payload) };
  }
  const keys = Object.keys(payload).sort();
  const fields = {};
  for (const key of keys.slice(0, HOOK_DEBUG_FIELDS_MAX)) {
    const name = key.length > HOOK_DEBUG_FIELD_NAME_MAX
      ? `${key.slice(0, HOOK_DEBUG_FIELD_NAME_MAX)}...`
      : key;
    fields[name] = describeDebugValue(payload[key]);
  }
  const summary = { present: true, shape: "object", keyCount: keys.length, fields };
  if (keys.length > HOOK_DEBUG_FIELDS_MAX) summary.fieldsTruncated = true;
  return summary;
}

// Node quotes the offending input inside JSON.parse SyntaxErrors, so the
// message itself can echo payload bytes — name/code only unless raw is on.
function describeDebugError(err, mode) {
  const out = { name: (err && err.name) || "Error" };
  if (err && typeof err.code === "string" && err.code) out.code = err.code;
  if (mode === "raw") out.message = err && err.message ? String(err.message) : String(err);
  return out;
}

function ensureDebugDir(dir) {
  const created = fs.mkdirSync(dir, { recursive: true, mode: HOOK_DEBUG_DIR_MODE });
  // mkdir's mode is masked by umask; tighten only what this call created so an
  // existing shared ~/.clawd is never re-permissioned behind the user's back.
  if (created) {
    try { fs.chmodSync(created, HOOK_DEBUG_DIR_MODE); } catch {}
  }
}

function inspectDebugTarget(debugPath) {
  try {
    const stat = fs.lstatSync(debugPath);
    // A custom debug path must already be a regular file. In particular, do
    // not chmod a directory/FIFO/socket, and do not follow a symlink into an
    // unrelated target just because debug logging was enabled.
    if (stat.isSymbolicLink() || !stat.isFile()) return { writable: false };
    return { writable: true, exists: true, size: stat.size || 0, mode: stat.mode };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { writable: true, exists: false, size: 0, mode: null };
    }
    return { writable: false };
  }
}

function appendHookDebug(entry, env = process.env) {
  const mode = hookDebugMode(env);
  if (mode === "off") return;
  const debugPath = env.CLAWD_QWENWORK_HOOK_DEBUG_PATH
    || path.join(os.homedir(), ".clawd", "qwenwork-hook-debug.jsonl");
  try {
    const record = { ...(entry && typeof entry === "object" ? entry : {}) };
    if (Object.prototype.hasOwnProperty.call(record, "payload")) {
      const payload = record.payload;
      delete record.payload;
      record.payloadSummary = summarizeHookPayload(payload);
      // Second opt-in only. See the banner above: this is the sensitive part.
      if (mode === "raw") record.rawPayload = payload === undefined ? null : payload;
    }
    if (Object.prototype.hasOwnProperty.call(record, "error")) {
      record.error = describeDebugError(record.error, mode);
    }

    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line);
    const maxBytes = readHookDebugMaxBytes(env);
    const target = inspectDebugTarget(debugPath);
    if (!target.writable) return;
    if (maxBytes > 0 && target.size + lineBytes > maxBytes) return;

    ensureDebugDir(path.dirname(debugPath));
    // O_NOFOLLOW closes the lstat/open race on POSIX. Windows has no matching
    // fs flag, but still rejects a symlink observed by inspectDebugTarget().
    const noFollow = process.platform !== "win32" && Number.isInteger(fs.constants.O_NOFOLLOW)
      ? fs.constants.O_NOFOLLOW
      : 0;
    const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow;
    let fd;
    try {
      // `mode` applies at creation and umask can only clear bits, so a file
      // this call creates is 0600 on POSIX regardless of the ambient umask.
      fd = fs.openSync(debugPath, flags, HOOK_DEBUG_FILE_MODE);
      const liveStat = fs.fstatSync(fd);
      if (!liveStat.isFile()) return;
      if (maxBytes > 0 && (liveStat.size || 0) + lineBytes > maxBytes) return;

      // A regular file an older build created under a loose umask stays
      // group/world readable otherwise. Tighten the opened file itself rather
      // than resolving the path a second time.
      if (process.platform !== "win32" && (liveStat.mode & 0o077) !== 0) {
        fs.fchmodSync(fd, HOOK_DEBUG_FILE_MODE);
      }
      fs.writeSync(fd, line, null, "utf8");
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  } catch {}
}

const TOOL_MATCH_STRING_MAX = 240;
const TOOL_MATCH_ARRAY_MAX = 16;
const TOOL_MATCH_OBJECT_KEYS_MAX = 32;
const TOOL_MATCH_DEPTH_MAX = 6;

// QwenWork hook event → { state, event } for the Clawd state machine. Every
// event returns `{}` (no gating) in Phase 1.
const HOOK_MAP = {
  SessionStart:       { state: "idle",         event: "SessionStart" },
  UserPromptSubmit:   { state: "thinking",     event: "UserPromptSubmit" },
  PreToolUse:         { state: "working",      event: "PreToolUse" },
  PostToolUse:        { state: "working",      event: "PostToolUse" },
  PostToolUseFailure: { state: "error",        event: "PostToolUseFailure" },
  Stop:               { state: "attention",    event: "Stop" },
  Notification:       { state: "notification", event: "Notification" },
  // State-only: QwenWork's permission events are part of its normal working
  // flow (file reads, command execution, etc.), NOT user-facing notifications.
  // Map to "working" so the pet stays in its working animation instead of
  // flashing notification repeatedly (40+ events per task). The hook still
  // returns `{}` — Clawd never answers the permission decision in Phase 1.
  PermissionRequest:  { state: "working",      event: "PreToolUse" },
  PermissionDenied:   { state: "working",      event: "PreToolUse" },
  SessionEnd:         { state: "sleeping",     event: "SessionEnd" },
};

const NO_DECISION_OUTPUT = "{}";

// Raw hook session IDs are namespaced as `qwenwork:<raw>`. The
// `local|agent|session` shape is for session-alias keys (src/session-alias.js),
// NOT raw hook IDs.
function normalizeSessionId(value) {
  const raw = value != null && value !== "" ? String(value) : "default";
  return raw.startsWith("qwenwork:") ? raw : `qwenwork:${raw}`;
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

// Match `QwenWorkCN` as an executable token (bounded by path separators,
// quotes, or whitespace). On macOS the process name is "千问办公" (Chinese),
// so we also match the lowercase "qwenworkcn" for the executable path.
function isQwenWorkAgentCommandLine(cmd) {
  if (typeof cmd !== "string") return false;
  const normalized = cmd.toLowerCase().replace(/\\/g, "/");
  return /(^|[\s"'/])qwenworkcn(\.exe)?($|[\s"'/])/.test(normalized);
}

const config = getPlatformConfig();
const defaultResolve = createPidResolver({
  agentNames: {
    // macOS process name is "千问办公" but the executable path contains
    // "QwenWorkCN", which is what `ps -o comm=` reports.
    //
    // Linux is an explicit EMPTY set, not an omission: createPidResolver falls
    // back to the mac set when `linux` is absent, and QwenWork has no Linux
    // client (macOS / Windows / HarmonyOS only), so there is nothing to match.
    win: new Set(["qwenworkcn.exe"]),
    mac: new Set(["qwenworkcn"]),
    linux: new Set(),
  },
  agentCmdlineCheck: isQwenWorkAgentCommandLine,
  platformConfig: config,
});

function resolveHookName(payload, argvEvent) {
  return (payload && typeof payload.hook_event_name === "string" && payload.hook_event_name)
    || (typeof argvEvent === "string" ? argvEvent : "")
    || "";
}

// PermissionRequest / PermissionDenied fire 40+ times per task and QwenWork
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
  // Before the pidMeta gate: the pane key comes from the environment, so it has
  // to survive the events where shouldResolvePid skips the process snapshot.
  applyOrcaPaneKey(body);
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

// #634: lifecycle for the shared resolver's cross-process pid cache. Stop is
// deliberately NOT "end" (turn completion); SessionEnd IS a true session end
// (registered by qwenwork-install.js) and drops the cache. cacheable keys off
// the RAW session id — normalizeSessionId prefixes, so its "qwenwork:default"
// fallback would defeat the #583 same-key guard — and rejects a literal
// "default" id for the same reason.
const EVENT_TO_LIFECYCLE = {
  SessionStart: "start",
  UserPromptSubmit: "prompt",
  SessionEnd: "end",
};

function pidCacheContext(hookName, payload) {
  const raw = payload && payload.session_id != null && payload.session_id !== ""
    ? String(payload.session_id)
    : "";
  const cwd = payload && typeof payload.cwd === "string" ? payload.cwd : "";
  return {
    namespace: "qwenwork",
    sessionId: normalizeSessionId(payload && payload.session_id),
    cacheCwd: cwd,
    lifecycle: EVENT_TO_LIFECYCLE[hookName] || "event",
    cacheable: !!raw && raw !== "default" && !!cwd,
  };
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

function buildStateBody(hookName, payload, options = {}) {
  const mapped = HOOK_MAP[hookName];
  if (!mapped) return null;

  const body = {
    state: mapped.state,
    session_id: normalizeSessionId(payload && payload.session_id),
    event: mapped.event,
    agent_id: "qwenwork",
  };
  if (hookName === "PermissionRequest" || hookName === "PermissionDenied") {
    body.recap_boundary = "permission";
  }

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
    // Stop events carry the QwenWork task name via parent_business_info.name.
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
    applyOrcaPaneKey(body, options.env);
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
      ? (deps.resolvePid ? deps.resolvePid(pidCacheContext(hookName, payload)) : undefined)
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
    appendHookDebug({
      argvEvent,
      // Summarized (or, with the second opt-in, captured raw) inside
      // appendHookDebug — never stringified verbatim from here.
      payload: payload === undefined ? null : payload,
      resolvedHookName: result.hookName,
      posted: result.posted,
      port: result.port,
      bodyState: result.body && result.body.state,
      bodyEvent: result.body && result.body.event,
    }, deps.env || process.env);
    process.stdout.write(`${result.stdout}\n`);
  } catch (err) {
    appendHookDebug({ argvEvent, error: err }, deps.env || process.env);
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
  DEFAULT_HOOK_DEBUG_MAX_BYTES,
  HOOK_MAP,
  NO_DECISION_OUTPUT,
  appendHookDebug,
  hookDebugMode,
  summarizeHookPayload,
  buildStateBody,
  sendHookEvent,
  normalizeSessionId,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
  isQwenWorkAgentCommandLine,
  resolveHookName,
  shouldResolvePid,
  main,
};
