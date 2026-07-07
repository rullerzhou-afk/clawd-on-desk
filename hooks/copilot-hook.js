#!/usr/bin/env node
// Clawd Desktop Pet — Copilot CLI Hook Script
// Usage: node copilot-hook.js <event_name>
// Reads stdin JSON from Copilot CLI for sessionId (camelCase)
//
// Two dispatch paths:
//   - state events (sessionStart, preToolUse, ...) → POST /state, fire-and-forget
//   - permissionRequest                            → POST /permission, blocks
//                                                    until Clawd resolves and
//                                                    emits Copilot stdout JSON
//
// The hook MUST always exit 0 with empty stdout on any failure path.
// Phase 0 §4.2 (docs/investigations/copilot-permission-payload-2026-05.md)
// confirmed Copilot 1.0.54 deadlocks its prompt UI if it has to kill the
// hook on `timeoutSec` expiry, instead of falling back to native menu.
// A top-level try/catch + process-level exception handlers guarantee
// no uncaught throw can push us into that path.

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  postStateToRunningServer,
  postPermissionToRunningServer,
  readHostPrefix,
  applyWslSourceFields,
} = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

// PERMISSION_HTTP_TIMEOUT_MS is the internal Clawd /permission HTTP timeout.
// It MUST stay strictly below `permissionRequest` hook `timeoutSec * 1000` so
// the hook always returns and exits cleanly *before* Copilot kills it on
// `timeoutSec` expiry — Phase 0 §4.2 capture confirmed Copilot 1.0.54
// deadlocks the prompt UI when it kills a hook on timeout, instead of falling
// back to native menu. The 60s buffer covers port discovery (up to 25s on
// remote mode = 5s × 5 ports) + stdout flush + safeExit overhead.
//
// Mirrored in hooks/copilot-install.js. Both files inline the constant
// instead of cross-requiring to keep this hook's require chain minimal —
// require-time failure escapes the main() try/catch and skips the
// process-level exception handlers, which would push us back into the
// deadlock path (Phase 0 §4.2).
const PERMISSION_HTTP_TIMEOUT_MS = 540000;

const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;
const WORKSPACE_YAML_MAX_BYTES = 16384; // 16 KB — workspace.yaml is tiny

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = value
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  return collapsed.length > SESSION_TITLE_MAX
    ? `${collapsed.slice(0, SESSION_TITLE_MAX - 1)}\u2026`
    : collapsed;
}

// Strip a single layer of matching surrounding quotes from a YAML scalar.
function stripYamlQuotes(value) {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

// Parse the top-level `name:` scalar from Copilot's workspace.yaml.
// workspace.yaml is a flat key:value file (no nesting), so a per-line
// regex is sufficient and avoids pulling in a YAML dependency.
function parseWorkspaceYamlName(text) {
  if (typeof text !== "string" || !text) return null;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const match = raw.match(/^name:\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[1];
    // Drop trailing inline comments on unquoted scalars
    if (value && value[0] !== '"' && value[0] !== "'") {
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trimEnd();
    }
    value = stripYamlQuotes(value);
    return value || null;
  }
  return null;
}

// Resolve the Copilot session-state directory.
//   - $COPILOT_HOME (trimmed, non-empty) overrides the default copilot home.
//   - Empty / whitespace-only env falls back to ~/.copilot.
// Inlined here (not imported from copilot-install) to keep this hook script
// independent and avoid module-load overhead on every event spawn.
function resolveCopilotSessionStateDir(options = {}) {
  const env = (options && options.env) || process.env;
  if (env && typeof env.COPILOT_HOME === "string") {
    const trimmed = env.COPILOT_HOME.trim();
    if (trimmed) return path.join(trimmed, "session-state");
  }
  const homeDir = options.homeDir || os.homedir();
  if (!homeDir) return null;
  return path.join(homeDir, ".copilot", "session-state");
}

// Read the renamed session title from Copilot's workspace.yaml.
// Returns null if the session id is missing/invalid, the file doesn't
// exist, or it has no usable `name:` field.
//
// Path traversal is blocked by three layers:
//   1. Charset gate: only [A-Za-z0-9._-] (no separators, no NUL, no
//      drive letters, no whitespace).
//   2. Pure-dot rejection: ".", "..", "..." etc. pass the charset gate
//      but resolve to ancestors of session-state/, so reject them
//      explicitly.
//   3. Containment check: after path.resolve, the session directory
//      must lie strictly under the resolved session-state/ base, even
//      if a future change loosens layers 1 or 2.
function readCopilotSessionTitle(sessionId, options = {}) {
  if (typeof sessionId !== "string") return null;
  const trimmed = sessionId.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  if (/^\.+$/.test(trimmed)) return null;
  const sessionStateDir = resolveCopilotSessionStateDir(options);
  if (!sessionStateDir) return null;
  const baseDir = path.resolve(sessionStateDir);
  const sessionDir = path.resolve(path.join(baseDir, trimmed));
  if (!sessionDir.startsWith(baseDir + path.sep)) return null;
  const filePath = path.join(sessionDir, "workspace.yaml");
  let fd = null;
  let data;
  try {
    const stat = fs.statSync(filePath);
    fd = fs.openSync(filePath, "r");
    const readLen = Math.min(stat.size, WORKSPACE_YAML_MAX_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, 0);
    data = buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return normalizeTitle(parseWorkspaceYamlName(data));
}

const EVENT_TO_STATE = {
  sessionStart: "idle",
  sessionEnd: "sleeping",
  userPromptSubmitted: "thinking",
  preToolUse: "working",
  postToolUse: "working",
  errorOccurred: "error",
  agentStop: "attention",
  subagentStart: "juggling",
  subagentStop: "working",
  preCompact: "sweeping",
};

// Hook-side caps for permission payload. `src/server-route-permission.js`
// rejects bodies >512KB *before* it can route by agent_id, so an
// unbounded payload (e.g. an `edit` tool's full git-style diff for a
// multi-MB file — confirmed worst-case carrier in Phase 0) would silently
// fall back to native flow. Cap aggressively here so the bubble still
// gets a useful preview while staying well under the route limit.
const HOOK_TOOL_INPUT_STRING_MAX = 32768;       // 32 KB per string
const HOOK_TOOL_INPUT_ARRAY_MAX = 64;
const HOOK_TOOL_INPUT_KEYS_MAX = 64;
const HOOK_TOOL_INPUT_DEPTH_MAX = 6;
const HOOK_PERMISSION_BODY_MAX_BYTES = 262144;  // 256 KB final serialized body

function capToolInput(value, depth) {
  if ((depth || 0) > HOOK_TOOL_INPUT_DEPTH_MAX) return null;
  if (Array.isArray(value)) {
    return value.slice(0, HOOK_TOOL_INPUT_ARRAY_MAX)
      .map((v) => capToolInput(v, (depth || 0) + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).slice(0, HOOK_TOOL_INPUT_KEYS_MAX);
    const out = {};
    for (const [k, v] of entries) out[k] = capToolInput(v, (depth || 0) + 1);
    return out;
  }
  if (typeof value === "string" && value.length > HOOK_TOOL_INPUT_STRING_MAX) {
    return value.slice(0, HOOK_TOOL_INPUT_STRING_MAX) + "…[truncated]";
  }
  return value;
}

// After per-field caps, do a final serialized-byte check. If we're still
// over the route limit (would only happen if the structure itself is
// pathological, since per-string is already capped), replace tool_input
// with a stub so Clawd at least gets the routing fields and can fall back
// to no-decision rather than the route-level 413.
function enforceBodySizeCap(body) {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") <= HOOK_PERMISSION_BODY_MAX_BYTES) {
    return { body, serialized, truncated: false };
  }
  const fallback = {
    ...body,
    tool_input: {
      _truncated: true,
      reason: "permission payload exceeded hook size cap",
    },
  };
  return { body: fallback, serialized: JSON.stringify(fallback), truncated: true };
}

function normalizePermissionSuggestions(value) {
  // Copilot 1.0.54 emits `permissionSuggestions: []` (camelCase) on the
  // wire, but Clawd's existing /permission route consumes the snake_case
  // `permission_suggestions` field (matches Codex/Qwen). Forward either
  // shape if present; the field is kept for forward-compat — empirical
  // capture showed it is always [] in current Copilot CLI.
  const raw = Array.isArray(value) ? value : [];
  return capToolInput(raw, 0) || [];
}

// Build the Clawd /permission POST body from a Copilot permissionRequest
// stdin payload. Field reference: docs/investigations/copilot-permission-payload-2026-05.md §5.
//
// Throws when the payload is missing required fields (sessionId, toolName,
// toolInput). The caller in runPermissionPath() catches this and exits 0
// with empty stdout — Copilot then falls back to its native menu, and the
// user makes the call in-terminal against the actual request.
//
// Why strict instead of forgiving: a malformed/truncated stdin used to be
// rebuilt as {sessionId:"default", toolName:"unknown", toolInput:{}}. If
// the user then approved that "unknown" bubble, the hook would emit
// allow on stdout for whatever the real (unread) Copilot request was.
// That is a blind-sign vulnerability — better to fail-open into native flow.
function buildPermissionBody(payload, resolve, options = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("copilot permissionRequest: stdin payload missing or non-object");
  }
  const safe = payload;

  const sessionId = (typeof safe.sessionId === "string" && safe.sessionId)
    || (typeof safe.session_id === "string" && safe.session_id)
    || null;
  if (!sessionId) {
    throw new Error("copilot permissionRequest: missing sessionId");
  }

  // Copilot toolName is lowercase on the wire (e.g. `edit`, `powershell`).
  // Display-layer casing/normalization happens in Clawd's bubble formatter,
  // not here — keep the wire shape unchanged.
  const toolName = (typeof safe.toolName === "string" && safe.toolName)
    || (typeof safe.tool_name === "string" && safe.tool_name)
    || null;
  if (!toolName) {
    throw new Error("copilot permissionRequest: missing toolName");
  }

  const rawToolInput = (safe.toolInput && typeof safe.toolInput === "object" && !Array.isArray(safe.toolInput))
    ? safe.toolInput
    : ((safe.tool_input && typeof safe.tool_input === "object" && !Array.isArray(safe.tool_input))
      ? safe.tool_input
      : null);
  if (!rawToolInput) {
    throw new Error("copilot permissionRequest: missing or non-object toolInput");
  }

  const cwd = typeof safe.cwd === "string" ? safe.cwd : "";

  const body = {
    agent_id: "copilot-cli",
    hook_source: "copilot-hook",
    event: "permissionRequest",
    session_id: sessionId,
    tool_name: toolName,
    tool_input: capToolInput(rawToolInput, 0) || {},
    permission_suggestions: normalizePermissionSuggestions(
      safe.permissionSuggestions || safe.permission_suggestions
    ),
  };
  if (cwd) body.cwd = cwd;

  if (process.env.CLAWD_REMOTE) {
    const readHost = options.readHostPrefix || readHostPrefix;
    body.host = readHost();
    applyWslSourceFields(body, { remote: true });
  } else if (typeof resolve === "function") {
    const { stablePid, agentPid, pidChain, tmuxSocket, tmuxClient } = resolve();
    if (stablePid) body.source_pid = stablePid;
    if (agentPid) body.agent_pid = agentPid;
    if (Array.isArray(pidChain) && pidChain.length) body.pid_chain = pidChain;
    if (tmuxSocket) body.tmux_socket = tmuxSocket;
    if (tmuxClient) body.tmux_client = tmuxClient;
    applyWslSourceFields(body);
  } else {
    applyWslSourceFields(body);
  }

  return body;
}

// Map a Clawd /permission response to a Copilot decision, or null for
// no-decision (empty stdout fallback). Phase 0 §3 locked empty stdout
// as the no-decision wire format.
function parseClawdPermissionResponse(ok, responseBody, statusCode) {
  if (!ok) return null;
  if (statusCode === 204) return null;
  if (typeof statusCode !== "number" || statusCode < 200 || statusCode >= 300) return null;
  if (typeof responseBody !== "string" || responseBody.length === 0) return null;
  let parsed;
  try { parsed = JSON.parse(responseBody); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const behavior = parsed.behavior;
  if (behavior === "allow") return { behavior: "allow" };
  if (behavior === "deny") {
    const message = typeof parsed.message === "string" && parsed.message
      ? parsed.message
      : "Denied by Clawd";
    return { behavior: "deny", message };
  }
  return null;
}

// Serialize a Copilot decision to stdout. ONLY the fields Copilot's
// hook contract documents are written: `behavior` (required for allow/deny),
// optional `message`, optional `interrupt` (currently unused). For
// no-decision the function writes nothing — Phase 0 verified empty stdout
// returns Copilot to native flow (auto-allow / native prompt as appropriate).
//
// IMPORTANT: writes MUST be synchronous. process.stdout.write() over a pipe
// (which is how Copilot invokes the hook) is asynchronous on Windows — a
// `safeExit(0)` immediately after the write can truncate the JSON before
// the kernel flushes it, silently downgrading an Allow/Deny decision into
// empty stdout / native fallback. fs.writeSync(1, ...) is a direct syscall
// on fd 1 and bypasses the Node stdout async buffer entirely.
function writeCopilotDecision(decision, stdoutWrite) {
  const write = typeof stdoutWrite === "function"
    ? stdoutWrite
    : (chunk) => {
        try { fs.writeSync(1, chunk); } catch {}
      };
  if (!decision || typeof decision !== "object") return; // empty stdout
  if (decision.behavior !== "allow" && decision.behavior !== "deny") return;
  const out = { behavior: decision.behavior };
  if (decision.behavior === "deny" && typeof decision.message === "string" && decision.message) {
    out.message = decision.message;
  }
  if (decision.interrupt === true) out.interrupt = true;
  write(JSON.stringify(out));
}

function buildStateBody(event, payload, resolve, options = {}) {
  const state = EVENT_TO_STATE[event];
  if (!state) return null;

  // Copilot CLI uses camelCase: sessionId, not session_id
  const sessionId = payload.sessionId || payload.session_id || "default";
  const cwd = payload.cwd || "";

  const body = { state, session_id: sessionId, event };
  body.agent_id = "copilot-cli";
  if (cwd) body.cwd = cwd;

  // Session title: prefer payload field if present, otherwise read the
  // renamed name from ~/.copilot/session-state/<sid>/workspace.yaml so
  // /rename in Copilot CLI propagates to Clawd on the next hook event.
  const sessionTitle =
    normalizeTitle(payload.session_title) ||
    normalizeTitle(payload.sessionTitle) ||
    readCopilotSessionTitle(sessionId);
  if (sessionTitle) body.session_title = sessionTitle;

  if (process.env.CLAWD_REMOTE) {
    const readHost = options.readHostPrefix || readHostPrefix;
    body.host = readHost();
    applyWslSourceFields(body, { remote: true });
  } else {
    applyWslSourceFields(body);
    const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = resolve();
    body.source_pid = stablePid;
    if (detectedEditor) body.editor = detectedEditor;
    if (agentPid) body.agent_pid = agentPid;
    if (pidChain.length) body.pid_chain = pidChain;
    if (tmuxSocket) body.tmux_socket = tmuxSocket;
    if (tmuxClient) body.tmux_client = tmuxClient;
  }

  return body;
}

// Per Copilot CLI hooks reference, the repo-level merged hook chain includes
// FIVE sources beyond user-level (https://docs.github.com/en/copilot/reference/hooks-configuration):
//
//   1. <repo>/.github/hooks/*.json
//   2. <repo>/.github/copilot/settings.json         (inline `hooks` block)
//   3. <repo>/.github/copilot/settings.local.json   (inline `hooks` block)
//   4. <repo>/.claude/settings.json                 (cross-tool inline)
//   5. <repo>/.claude/settings.local.json           (cross-tool inline)
//
// AND the docs are silent on whether Copilot itself discovers <repo> from a
// subdirectory invocation. We take the conservative position: if a user
// could plausibly hit a project audit/deny hook by running Copilot somewhere
// inside their repo tree, we must fall open from anywhere inside that tree.
// So this helper walks cwd's ancestor chain and checks every level for any
// of the 5 sources. As soon as ONE level + ONE source declares
// permissionRequest, we return true so the Clawd hook fails open.
//
// Cost: per cwd, ~depth × (one readdir + 4 statSync + at most a handful of
// small reads). Path depths are short in practice (< 20) and the directories
// we look for don't exist in most repos at all, so the early-exit makes this
// a sub-millisecond check in the common case.
//
// Conservative: any FS / parse error treats the source as "no hook" so a
// transient hiccup doesn't permanently force fail-open into native flow on
// every request.

function fileDeclaresPermissionHook(filePath, fsImpl) {
  let raw;
  try { raw = fsImpl.readFileSync(filePath, "utf8"); } catch { return false; }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (!parsed || typeof parsed !== "object") return false;
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  const arr = hooks.permissionRequest;
  return Array.isArray(arr) && arr.length > 0;
}

function dirHasPermissionHookJson(dir, fsImpl, pathImpl) {
  let entries;
  try { entries = fsImpl.readdirSync(dir); } catch { return false; }
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    if (fileDeclaresPermissionHook(pathImpl.join(dir, name), fsImpl)) return true;
  }
  return false;
}

function levelDeclaresPermissionHook(level, fsImpl, pathImpl) {
  // 1. <level>/.github/hooks/*.json
  if (dirHasPermissionHookJson(pathImpl.join(level, ".github", "hooks"), fsImpl, pathImpl)) return true;
  // 2-5. inline `hooks` blocks across .github/copilot/* and cross-tool .claude/*
  const inlineFiles = [
    pathImpl.join(level, ".github", "copilot", "settings.json"),
    pathImpl.join(level, ".github", "copilot", "settings.local.json"),
    pathImpl.join(level, ".claude", "settings.json"),
    pathImpl.join(level, ".claude", "settings.local.json"),
  ];
  for (const filePath of inlineFiles) {
    if (fileDeclaresPermissionHook(filePath, fsImpl)) return true;
  }
  return false;
}

function hasUserPermissionHookInRepoHooks(cwd, options = {}) {
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  if (typeof cwd !== "string" || !cwd) return false;
  if (!pathImpl.isAbsolute(cwd)) return false;

  let level = cwd;
  // Walk up until fs root. 64-level cap is a string-dirname depth limit
  // (we never follow symlinks here), defending against pathological cwd
  // strings or unexpected dirname() behavior on a future Node release.
  // Real absolute paths never approach this depth.
  for (let i = 0; i < 64; i++) {
    if (levelDeclaresPermissionHook(level, fsImpl, pathImpl)) return true;
    const parent = pathImpl.dirname(level);
    if (parent === level) return false; // fs root
    level = parent;
  }
  return false;
}

function buildResolver() {
  const config = getPlatformConfig();
  return createPidResolver({
    agentNames: {
      win: new Set(["copilot.exe"]),
      mac: new Set(["copilot"]),
      // Phase 0 follow-up: Linux process name unconfirmed by capture.
      // Mirror macOS naming as the most likely value; if Linux ships a
      // different binary name the PID chain just degrades to source-only.
      linux: new Set(["copilot"]),
    },
    agentCmdlineCheck: (cmd) => cmd.includes("@github/copilot"),
    platformConfig: config,
  });
}

function runStatePath(event, resolve, safeExit) {
  // Pre-resolve on sessionStart. Remote mode skips PID collection because
  // remote PIDs are meaningless on the local machine.
  if (event === "sessionStart" && !process.env.CLAWD_REMOTE) resolve();

  readStdinJson().then((payload) => {
    let body = null;
    try { body = buildStateBody(event, payload || {}, resolve); } catch {}
    if (!body) { safeExit(0); return; }
    try {
      postStateToRunningServer(
        JSON.stringify(body),
        { timeoutMs: 100 },
        () => safeExit(0)
      );
    } catch {
      safeExit(0);
    }
  }).catch(() => safeExit(0));
}

function runPermissionPath(resolve, safeExit) {
  readStdinJson().then((payload) => {
    // Repo-level safe-v1: if the workspace ships its own permissionRequest
    // hook in .github/hooks/*.json, fall open into Copilot's native chain
    // so a project-authored audit/deny rule isn't silently overridden.
    const cwdField = (payload && typeof payload === "object" && typeof payload.cwd === "string")
      ? payload.cwd
      : "";
    if (cwdField && hasUserPermissionHookInRepoHooks(cwdField)) {
      safeExit(0);
      return;
    }

    let body;
    try {
      body = buildPermissionBody(payload || {}, resolve);
    } catch {
      // Body construction failed → no-decision, let Copilot's native flow run.
      safeExit(0);
      return;
    }
    const capped = enforceBodySizeCap(body);

    try {
      postPermissionToRunningServer(
        capped.serialized,
        { timeoutMs: PERMISSION_HTTP_TIMEOUT_MS },
        (ok, _confirmedPort, responseBody, statusCode) => {
          try {
            const decision = parseClawdPermissionResponse(ok, responseBody, statusCode);
            writeCopilotDecision(decision);
          } catch {}
          safeExit(0);
        }
      );
    } catch {
      safeExit(0);
    }
  }).catch(() => safeExit(0));
}

function main() {
  let exited = false;
  function safeExit(code) {
    if (exited) return;
    exited = true;
    process.exit(code);
  }

  // Last-ditch guards against any throw escaping the dispatch. Phase 0 §4.2:
  // letting Copilot kill the hook on `timeoutSec` would deadlock its UI.
  process.on("uncaughtException", () => safeExit(0));
  process.on("unhandledRejection", () => safeExit(0));

  try {
    const event = process.argv[2];

    // permissionRequest must dispatch BEFORE the EVENT_TO_STATE early-exit
    // guard, which only knows state events. Without this ordering the
    // hook would exit 0 with empty stdout and never POST /permission.
    if (event === "permissionRequest") {
      runPermissionPath(buildResolver(), safeExit);
      return;
    }

    if (!EVENT_TO_STATE[event]) {
      safeExit(0);
      return;
    }

    runStatePath(event, buildResolver(), safeExit);
  } catch {
    safeExit(0);
  }
}

if (require.main === module) main();

module.exports = {
  buildStateBody,
  buildPermissionBody,
  capToolInput,
  enforceBodySizeCap,
  normalizePermissionSuggestions,
  parseClawdPermissionResponse,
  writeCopilotDecision,
  hasUserPermissionHookInRepoHooks,
  normalizeTitle,
  parseWorkspaceYamlName,
  readCopilotSessionTitle,
  resolveCopilotSessionStateDir,
  HOOK_TOOL_INPUT_STRING_MAX,
  HOOK_TOOL_INPUT_ARRAY_MAX,
  HOOK_TOOL_INPUT_KEYS_MAX,
  HOOK_TOOL_INPUT_DEPTH_MAX,
  HOOK_PERMISSION_BODY_MAX_BYTES,
};
