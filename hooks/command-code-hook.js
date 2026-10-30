#!/usr/bin/env node
// Clawd — Command Code hook (Phase 1: state-only).
// Registered in ~/.commandcode/settings.json by hooks/command-code-install.js.
//
// Contract (verified against command-code 1.79.2):
//   - Events: SessionStart / PreToolUse / PostToolUse / Stop. There is no
//     SessionEnd, Notification, UserPromptSubmit, or PermissionRequest event,
//     so this adapter never owns a permission decision and stdout is ALWAYS
//     exactly `{}` followed by a newline, exit code 0, for every input:
//     parse failure, unmapped event, missing session, disabled/offline Clawd.
//   - stdin is snake_case (`hook_event_name`, `session_id`, `cwd`,
//     `permission_mode`, `tool_name`, `tool_input`). Stop additionally carries
//     `stop_hook_active`; SessionStart carries `source`.
//   - The local state POST is best-effort and short-bounded. No prompt, tool
//     input/result, transcript content, or free-form text is ever forwarded —
//     only the bounded identifiers the state runtime needs.
//
// The CLI sets `process.title = "command-code"`, so on macOS/Linux the agent
// process is matched by name; on Windows it stays `node.exe` and is matched by
// its command line (`command-code/dist/index.mjs`) through the shared resolver.

"use strict";

const { postStateToRunningServer, readHostPrefix, applyWslSourceFields } = require("./server-config");
const {
  createPidResolver,
  readStdinJson,
  getPlatformConfig,
  applyOrcaPaneKey,
} = require("./shared-process");

const AGENT_ID = "command-code";

// Command Code hook event → { state, event } for the Clawd state machine.
const HOOK_MAP = Object.freeze({
  SessionStart: { state: "idle", event: "SessionStart" },
  PreToolUse: { state: "working", event: "PreToolUse" },
  PostToolUse: { state: "working", event: "PostToolUse" },
  Stop: { state: "attention", event: "Stop" },
});

// #634: lifecycle for the shared resolver's cross-process pid cache. Stop is
// deliberately NOT "end" (turn completion, not session end — dropping the
// cache there would force a fresh snapshot flash on the next tool event), and
// Command Code reports no SessionEnd at all.
const EVENT_TO_LIFECYCLE = Object.freeze({
  SessionStart: "start",
});

const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const MAX_SESSION_ID_LENGTH = 200;
const MAX_CWD_LENGTH = 512;
const MAX_TOOL_NAME_LENGTH = 128;

// Safety timeout: guarantee valid JSON on stdout even if stdin never arrives.
// Command Code parses stdout on every exit code, but a passive `{}` keeps the
// hook provably non-deciding. This guards ONLY the stdin wait — stdout is
// answered before the process-tree walk, so the timer can never race the
// resolver's own Windows snapshot budget (3s by default) and drop an event.
const SAFETY_TIMEOUT_MS = 2000;
// Once stdout has been answered, the guard above is re-armed as a backstop for
// the pid walk + POST. The synchronous Windows snapshot alone may use 3s of the
// shared resolver budget, and `timeout: 5` in settings.json is where Command
// Code aborts the hook, so this has to sit between the two: long enough for a
// slow walk plus the 150ms POST, short enough to reap a truly wedged process
// before the host does.
const POST_EXIT_BACKSTOP_MS = 4000;
const POST_TIMEOUT_MS = 150;

// Command Code has no distinct Windows image name (it runs under node.exe),
// so the Windows path is recognized by its package directory. Matching the
// bare bin aliases (`cmd` / `cmdc`) would collide with unrelated executables;
// the dist entry path is specific to this package. A bare `command-code`
// elsewhere in a command line (a folder, an argument) does not identify the
// agent.
function isCommandCodeAgentCommandLine(cmd) {
  if (typeof cmd !== "string") return false;
  return cmd.toLowerCase().replace(/\\/g, "/").includes("/command-code/dist/");
}

const platformConfig = getPlatformConfig();
const defaultResolvePid = createPidResolver({
  agentNames: {
    win: new Set(),
    mac: new Set(["command-code"]),
    linux: new Set(["command-code"]),
  },
  agentCmdlineCheck: isCommandCodeAgentCommandLine,
  platformConfig,
});

function isValidSessionId(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SESSION_ID_LENGTH) return false;
  return !/[\u0000-\u001f\u007f\r\n]/.test(trimmed);
}

// Raw hook session IDs are namespaced as `command-code:<raw>`. A missing or
// placeholder id cannot be attributed to a session, so the event is dropped
// instead of collapsing every invocation into one phantom "default" session.
function normalizeSessionId(value) {
  if (!isValidSessionId(value)) return "";
  const raw = value.trim();
  if (raw === "default" || raw === `${AGENT_ID}:default`) return "";
  return `${AGENT_ID}:${raw}`;
}

function boundString(value, maxLength) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

// Pure: derive the POST body from a parsed payload. Returning null means
// stdout stays `{}` and no HTTP request is made.
function buildStateBody(payload, deps = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const hookName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const mapped = Object.prototype.hasOwnProperty.call(HOOK_MAP, hookName)
    ? HOOK_MAP[hookName]
    : null;
  if (!mapped) return null;

  const sessionId = normalizeSessionId(payload.session_id);
  if (!sessionId) return null;

  const body = {
    agent_id: AGENT_ID,
    session_id: sessionId,
    state: mapped.state,
    event: mapped.event,
  };

  const cwd = boundString(payload.cwd, MAX_CWD_LENGTH);
  if (cwd) body.cwd = cwd;

  if (TOOL_EVENTS.has(hookName)) {
    const toolName = boundString(payload.tool_name, MAX_TOOL_NAME_LENGTH);
    if (toolName) body.tool_name = toolName;
  }

  if (deps.remote) {
    body.host = deps.host || readHostPrefix();
    applyWslSourceFields(body, { remote: true });
    applyOrcaPaneKey(body, deps.env);
  } else {
    applyWslSourceFields(body);
    const pidMeta = deps.pidMeta;
    if (pidMeta && typeof pidMeta === "object") {
      if (Number.isFinite(pidMeta.stablePid) && pidMeta.stablePid > 0) {
        body.source_pid = Math.floor(pidMeta.stablePid);
      }
      if (pidMeta.detectedEditor) body.editor = pidMeta.detectedEditor;
      if (Number.isFinite(pidMeta.agentPid) && pidMeta.agentPid > 0) {
        body.agent_pid = Math.floor(pidMeta.agentPid);
      }
      if (Array.isArray(pidMeta.pidChain) && pidMeta.pidChain.length) body.pid_chain = pidMeta.pidChain;
      if (pidMeta.tmuxSocket) body.tmux_socket = pidMeta.tmuxSocket;
      if (pidMeta.tmuxClient) body.tmux_client = pidMeta.tmuxClient;
    }
    applyOrcaPaneKey(body, deps.env);
  }

  return body;
}

// Pure: the #634 resolver lifecycle context. cacheable keys off the RAW
// session id (normalizeSessionId prefixes, and a placeholder must never key a
// shared cache entry) and requires a cwd.
function pidCacheContext(payload) {
  const raw = payload && typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  const cwd = payload && typeof payload.cwd === "string" ? payload.cwd : "";
  const hookName = payload && typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
  const lifecycle = Object.prototype.hasOwnProperty.call(EVENT_TO_LIFECYCLE, hookName)
    ? EVENT_TO_LIFECYCLE[hookName]
    : "event";
  return {
    namespace: "command-code",
    sessionId: normalizeSessionId(payload && payload.session_id) || `${AGENT_ID}:default`,
    cacheCwd: cwd,
    lifecycle,
    cacheable: !!raw && raw !== "default" && !!cwd,
  };
}

function shouldResolvePid(payload, env = process.env) {
  if (env.CLAWD_REMOTE) return false;
  if (!payload || typeof payload !== "object") return false;
  return Object.prototype.hasOwnProperty.call(HOOK_MAP, payload.hook_event_name);
}

function sendHookEvent(payload, deps = {}) {
  const env = deps.env || process.env;
  const remote = !!env.CLAWD_REMOTE;
  const body = buildStateBody(payload, {
    remote,
    host: remote && deps.readHostPrefix ? deps.readHostPrefix() : undefined,
    env,
    pidMeta: shouldResolvePid(payload, env)
      ? (deps.resolvePid ? deps.resolvePid(pidCacheContext(payload)) : defaultResolvePid(pidCacheContext(payload)))
      : undefined,
  });

  if (!body) {
    return Promise.resolve({ stdout: "{}\n", body: null, posted: false, port: null });
  }

  const postState = deps.postState || postStateToRunningServer;
  return new Promise((resolvePost) => {
    postState(JSON.stringify(body), { timeoutMs: POST_TIMEOUT_MS }, (posted, port) => {
      resolvePost({ stdout: "{}\n", body, posted: !!posted, port: port || null });
    });
  });
}

// Everything that runs the real hook lifecycle — reading stdin, arming the
// safety timer, answering Command Code on stdout, the best-effort POST to
// Clawd, and process exit — lives inside main(), which only runs when this
// file is the entry point. Importing the module for tests must not read
// stdin, arm timers, write stdout, or exit.
function main(deps = {}) {
  const readStdin = deps.readStdinJson || readStdinJson;
  const exit = deps.exit || ((code) => process.exit(code));
  const writeStdout = deps.writeStdout
    || ((chunk, callback) => process.stdout.write(chunk, callback));
  let _wrote = false;
  let _exited = false;
  let safetyTimer = null;

  // Write the stdout response exactly once. Kept separate from process exit so
  // the hook can answer Command Code immediately yet still let the
  // fire-and-forget POST to Clawd leave the process before it exits. Exit in
  // the write callback so a pipe-backed stdout actually flushes before the
  // process terminates.
  function writeStdoutOnce(outLine, done) {
    if (_wrote) {
      if (done) done();
      return;
    }
    _wrote = true;
    writeStdout(outLine, () => {
      if (done) done();
    });
    // stdin has been answered, so the safety guard has done its job; re-arm it
    // as the POST backstop. Without this the overdue 2s guard would fire right
    // after a slow Windows snapshot and exit the process before the state POST
    // left the socket — the session state would never reach Clawd.
    if (!_exited && safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = setTimeout(() => finish(outLine), POST_EXIT_BACKSTOP_MS);
    }
  }

  function finish(outLine) {
    if (_exited) return;
    _exited = true;
    if (safetyTimer) clearTimeout(safetyTimer);
    writeStdoutOnce(outLine, () => exit(0));
  }

  safetyTimer = setTimeout(() => finish("{}\n"), SAFETY_TIMEOUT_MS);

  readStdin()
    .then((payload) => {
      // Answer Command Code before the synchronous process-tree walk. The walk
      // can take seconds on Windows and the CLI waits on our response, so it
      // must never be able to turn a slow snapshot into a missing `{}`; the
      // state POST continues afterwards under the re-armed backstop.
      writeStdoutOnce("{}\n");
      return sendHookEvent(payload || {}, {
        env: deps.env || process.env,
        postState: deps.postState || postStateToRunningServer,
        readHostPrefix: deps.readHostPrefix || readHostPrefix,
        resolvePid: deps.resolvePid || defaultResolvePid,
      });
    })
    .then(() => finish("{}\n"))
    .catch(() => finish("{}\n"));
}

if (require.main === module) {
  main();
}

module.exports = {
  AGENT_ID,
  HOOK_MAP,
  EVENT_TO_LIFECYCLE,
  SAFETY_TIMEOUT_MS,
  POST_EXIT_BACKSTOP_MS,
  isCommandCodeAgentCommandLine,
  normalizeSessionId,
  buildStateBody,
  pidCacheContext,
  shouldResolvePid,
  sendHookEvent,
  main,
};
