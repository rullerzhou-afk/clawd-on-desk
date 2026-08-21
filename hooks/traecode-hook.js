#!/usr/bin/env node
// Clawd — TraeCode hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.trae-cn/hooks.json by hooks/traecode-install.js
// TraeCode uses Claude Code-compatible hook format with identical event names.

const {
  postStateToRunningServer,
  readHostPrefix,
  applyWslSourceFields,
  readWindowsProcessChainHookContext,
} = require("./server-config");
const {
  createPidResolver,
  readStdinJson,
  getPlatformConfig,
  applyOrcaPaneKey,
  processAlive,
} = require("./shared-process");

// TraeCode hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  SessionStart:     { state: "idle",         event: "SessionStart" },
  UserPromptSubmit: { state: "thinking",     event: "UserPromptSubmit" },
  PreToolUse:       { state: "working",      event: "PreToolUse" },
  PostToolUse:      { state: "working",      event: "PostToolUse" },
  Stop:             { state: "attention",    event: "Stop" },
  // Notification: async, never blocks the main flow
  Notification:     { state: "notification", event: "Notification" },
};

// #634: lifecycle for the shared resolver's cross-process pid cache. Stop is
// deliberately NOT "end" (turn completion, not session end — dropping the
// cache there would force a fresh snapshot flash on the next tool event).
const EVENT_TO_LIFECYCLE = {
  SessionStart: "start",
  UserPromptSubmit: "prompt",
};

// Session title handling — Trae sends no session_title field (verified live:
// SessionStart/UserPromptSubmit payloads carry only session_id, cwd,
// workspace_roots). The HUD title is therefore derived from the first line of
// the user's prompt, mirroring the claude-code hook's extractPromptTitle. The
// server keeps the first successful title per session (state.js first-wins for
// traecode), so follow-up prompts never overwrite it.
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;
const PROMPT_TITLE_MAX = 40;
const PROMPT_TITLE_SECRET_RE =
  /\b(api[_-]?key|authorization|bearer|password|passwd|private[_-]?key|secret|token)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/=_-]{32,}/i;

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = value
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  return collapsed.length > SESSION_TITLE_MAX
    ? `${collapsed.slice(0, SESSION_TITLE_MAX - 1)}…`
    : collapsed;
}

function normalizeTitleWithMax(value, maxLen) {
  const title = normalizeTitle(value);
  if (!title || title.length <= maxLen) return title;
  return `${title.slice(0, maxLen - 1)}…`;
}

function looksSecretishPromptTitle(value) {
  return typeof value === "string" && PROMPT_TITLE_SECRET_RE.test(value);
}

function extractPromptTitle(prompt) {
  if (typeof prompt !== "string") return null;
  for (const line of prompt.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (looksSecretishPromptTitle(candidate)) return null;
    return normalizeTitleWithMax(candidate, PROMPT_TITLE_MAX);
  }
  return null;
}

// Trae sends no session_title field (verified live against the running IDE),
// so the HUD title is derived from the first line of the user's prompt on
// UserPromptSubmit — showing the task instead of the project folder name.
function resolveSessionTitle(payload, event) {
  if (!payload || typeof payload !== "object") return null;
  const sessionTitle = normalizeTitle(payload.session_title);
  if (sessionTitle) return sessionTitle;
  if (event === "UserPromptSubmit") {
    return extractPromptTitle(payload.prompt);
  }
  return null;
}

const config = getPlatformConfig({
  // Trae CN ships as "Trae CN.exe" (process name lowercased to "trae cn.exe"
  // by the Windows process snapshot). The international build "Trae.exe" is
  // deliberately NOT matched — this first release only covers Trae CN.
  extraTerminals: { win: ["trae cn.exe", "traecn.exe"] },
  extraEditors: {
    win: { "trae cn.exe": "trae", "traecn.exe": "trae" },
    mac: { "Trae": "trae", "trae": "trae" },
    linux: { "trae": "trae", "Trae": "trae" },
  },
  extraEditorPathChecks: [["trae", "trae"]],
});
let runtimeContext = Object.freeze({
  identity: { ok: false, reason: "not-observed", port: null, ownerPid: null },
  observation: null,
});
const resolve = createPidResolver({
  agentNames: { win: new Set(["trae cn.exe", "traecn.exe"]), mac: new Set(["Trae", "trae"]), linux: new Set(["trae", "Trae"]) },
  platformConfig: config,
  readRuntimeIdentity: () => runtimeContext.identity,
});

// TraeCode's documented tool-decision shape is
// hookSpecificOutput.permissionDecision. This integration is state-only and
// does not own permission decisions, so every event emits {} (an empty
// permission decision allows the tool). Emitting a top-level {"decision":
// "allow"} would violate the Trae hook contract.

// Safety timeout: guarantee valid JSON on stdout even if stdin never arrives
// or the process tree walk hangs. Without this TraeCode would see empty stdout
// which is invalid JSON and logs an error on every hook invocation.
const SAFETY_TIMEOUT_MS = 800;

// Everything that runs the real hook lifecycle — reading stdin, arming the
// safety timer, answering TraeCode on stdout, the fire-and-forget POST to
// Clawd, and process exit — lives inside main(), which only runs when this
// file is the entry point. Importing the module for tests must not read stdin,
// arm timers, write stdout, or exit.
function main(deps = {}) {
  const readStdin = deps.readStdinJson || readStdinJson;
  const postState = deps.postState || postStateToRunningServer;
  let _wrote = false;
  let _exited = false;
  let safetyTimer = null;

  // Write the stdout response exactly once. Kept separate from process exit so
  // the hook can answer TraeCode immediately yet still let the fire-and-forget
  // POST to Clawd leave the process before it exits. Exit in the write callback
  // so a pipe-backed stdout actually flushes before the process terminates —
  // exiting immediately after write() can truncate the response TraeCode is
  // waiting on.
  function writeStdoutOnce(outLine, done) {
    if (_wrote) {
      if (done) done();
      return;
    }
    _wrote = true;
    process.stdout.write(outLine + "\n", () => {
      if (done) done();
    });
  }

  function finish(outLine) {
    if (_exited) return;
    _exited = true;
    if (safetyTimer) clearTimeout(safetyTimer);
    writeStdoutOnce(outLine, () => process.exit(0));
  }

  // Trae session ids are not globally unique, and a bare missing id must not
  // collapse every hook invocation into one phantom "default" session. Namespace
  // the id with the agent prefix and drop the event when it is absent — a hook
  // without a session cannot be attributed, so there is nothing to post.
  function normalizeSessionId(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw || raw === "default") return "";
    return `traecode:${raw}`;
  }

  safetyTimer = setTimeout(() => finish("{}"), SAFETY_TIMEOUT_MS);

  readStdin()
    .then((payload) => {
      const hookName = (payload && payload.hook_event_name) || "";
      const mapped = HOOK_MAP[hookName];
      const outLine = "{}";

      if (!mapped) {
        finish(outLine);
        return;
      }

      const { state, event } = mapped;
      const remote = !!process.env.CLAWD_REMOTE;
      if (!remote && process.platform === "win32") {
        runtimeContext = readWindowsProcessChainHookContext("traecode");
      }
      const runtimeObservation = runtimeContext.observation;
      const serverProcessChainEnabled = !!(
        !remote
        && process.platform === "win32"
        && runtimeObservation
        && runtimeObservation.agentMode !== "legacy"
        && processAlive(runtimeObservation.ownerPid)
      );
      const authoritativeProcessChain = serverProcessChainEnabled
        && runtimeObservation.agentMode === "b1a-authoritative";
      if (hookName === "SessionStart" && !remote && !authoritativeProcessChain) resolve();

      const sessionId = normalizeSessionId(payload && payload.session_id);
      const cwd = (payload && typeof payload.cwd === "string") ? payload.cwd : "";
      // No session id means the event cannot be attributed to any session —
      // answer TraeCode immediately and skip the POST rather than collapsing
      // into a phantom "default" session on the server.
      if (!sessionId) {
        finish(outLine);
        return;
      }

      const pidMetadata = authoritativeProcessChain ? {} : resolve({
          namespace: "traecode",
          sessionId,
          cacheCwd: cwd,
          lifecycle: EVENT_TO_LIFECYCLE[hookName] || "event",
          cacheable: !!cwd,
        });
      const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = pidMetadata;

      const body = { state, session_id: sessionId, event };
      body.agent_id = "traecode";
      if (cwd) body.cwd = cwd;
      // Trae stores the session title server-side, so Clawd derives it from the
      // first prompt line (matching Trae's constant session title). The server
      // keeps the FIRST successful title per session (state.js first-wins for
      // traecode), so a title that fails to post is not permanently claimed and
      // follow-up prompts never overwrite the first one.
      const resolvedTitle = resolveSessionTitle(payload, event);
      if (resolvedTitle) body.session_title = resolvedTitle;
      if (remote) {
        body.host = readHostPrefix();
        applyWslSourceFields(body, { remote: true });
        applyOrcaPaneKey(body);
      } else {
        applyWslSourceFields(body);
        if (!authoritativeProcessChain) {
          body.source_pid = stablePid;
          if (detectedEditor) body.editor = detectedEditor;
          if (agentPid) body.agent_pid = agentPid;
          if (Array.isArray(pidChain) && pidChain.length) body.pid_chain = pidChain;
          if (tmuxSocket) body.tmux_socket = tmuxSocket;
          if (tmuxClient) body.tmux_client = tmuxClient;
        }
        applyOrcaPaneKey(body);
      }

      // Answer TraeCode immediately so it never sees empty stdout, but don't
      // exit yet — the fire-and-forget POST below still needs to leave the
      // process, so we exit in its callback (with the safety timer as backstop).
      writeStdoutOnce(outLine);

      const postOptions = { timeoutMs: 100 };
      if (serverProcessChainEnabled) {
        postOptions.preferredPort = runtimeObservation.port;
        postOptions.runtimePort = runtimeObservation.port;
        postOptions.windowsProcessChain = {
          agentId: "traecode",
          hookPid: process.pid,
          runtimeObservation,
          legacyCacheSource: pidMetadata.cacheSource || "none",
        };
      }
      postState(JSON.stringify(body), postOptions, () => {
        finish(outLine);
      });
    })
    .catch(() => finish("{}"));
}

if (require.main === module) {
  main();
}

module.exports = {
  __test: {
    resolveSessionTitle,
    extractPromptTitle,
    normalizeTitle,
    main,
  },
};
