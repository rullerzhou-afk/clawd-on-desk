#!/usr/bin/env node
// Clawd — CodeBuddy hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.codebuddy/settings.json by hooks/codebuddy-install.js
// CodeBuddy uses Claude Code-compatible hook format with identical event names.

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

// CodeBuddy hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  SessionStart:     { state: "idle",         event: "SessionStart" },
  SessionEnd:       { state: "sleeping",     event: "SessionEnd" },
  UserPromptSubmit: { state: "thinking",     event: "UserPromptSubmit" },
  PreToolUse:       { state: "working",      event: "PreToolUse" },
  PostToolUse:      { state: "working",      event: "PostToolUse" },
  Stop:             { state: "attention",    event: "Stop" },
  // PermissionRequest: handled by HTTP hook (blocking), not this command hook
  Notification:     { state: "notification", event: "Notification" },
  PreCompact:       { state: "sweeping",     event: "PreCompact" },
};

// #634: lifecycle for the shared resolver's cross-process pid cache. Stop is
// deliberately NOT "end" (turn completion, not session end — dropping the
// cache there would force a fresh snapshot flash on the next tool event).
const EVENT_TO_LIFECYCLE = {
  SessionStart: "start",
  UserPromptSubmit: "prompt",
  SessionEnd: "end",
};

const config = getPlatformConfig({
  extraTerminals: { win: ["codebuddy.exe"] },
  extraEditors: {
    win: { "codebuddy.exe": "codebuddy" },
    mac: { "codebuddy": "codebuddy" },
    linux: { "codebuddy": "codebuddy" },
  },
  extraEditorPathChecks: [["codebuddy", "codebuddy"]],
});
let runtimeContext = Object.freeze({
  identity: { ok: false, reason: "not-observed", port: null, ownerPid: null },
  observation: null,
});
const resolve = createPidResolver({
  agentNames: { win: new Set(["codebuddy.exe"]), mac: new Set(["codebuddy"]), linux: new Set(["codebuddy"]) },
  platformConfig: config,
  readRuntimeIdentity: () => runtimeContext.identity,
});

// This command hook only reports state: it answers `{}` for every event and
// never makes a tool or permission decision. Approvals go through the separate
// blocking PermissionRequest HTTP hook. This follows the no-decision policy the
// WorkBuddy hook adopted in PR #618, where an explicit PreToolUse allow could
// bypass the product's own permission UI.
function stdoutForEvent() {
  return "{}";
}

// Safety timeout: guarantee valid JSON on stdout even if stdin never arrives
// or the process tree walk hangs. Without this CodeBuddy would see empty stdout
// which is invalid JSON and logs an error on every hook invocation.
const SAFETY_TIMEOUT_MS = 800;
// Once stdout has been answered, the 800ms guard above has served its purpose.
// The fire-and-forget POST to Clawd still needs the process alive to leave the
// socket: on Windows the synchronous process-tree snapshot alone takes ~1.5s,
// so an overdue safety timer firing right after the walk would process.exit()
// before the POST completed and the session state would never reach Clawd
// (same failure class as the WorkBuddy hook fix). After answering stdout we
// re-arm a generous backstop whose only job is to reap a truly hung process;
// the POST's own 100ms timeout settles the normal path in well under that.
const POST_EXIT_BACKSTOP_MS = 5000;
let _wrote = false;
let _exited = false;
let safetyTimer = null;

// Write the stdout response exactly once. Kept separate from process exit so the
// hook can answer CodeBuddy immediately yet still let the fire-and-forget POST
// to Clawd leave the process before it exits.
function writeStdoutOnce(outLine) {
  if (_wrote) return;
  _wrote = true;
  process.stdout.write(outLine + "\n");
  if (!_exited && safetyTimer) {
    clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => finish(outLine), POST_EXIT_BACKSTOP_MS);
  }
}

function finish(outLine) {
  writeStdoutOnce(outLine);
  if (_exited) return;
  _exited = true;
  if (safetyTimer) clearTimeout(safetyTimer);
  process.exit(0);
}

safetyTimer = setTimeout(() => finish("{}"), SAFETY_TIMEOUT_MS);

readStdinJson()
  .then((payload) => {
    const hookName = (payload && payload.hook_event_name) || "";
    const mapped = HOOK_MAP[hookName];
    const outLine = stdoutForEvent();

    if (!mapped) {
      finish(outLine);
      return;
    }

    const { state, event } = mapped;

    // Write stdout before the synchronous process-tree walk (which can take
    // ~1.5s on Windows), then continue the POST. writeStdoutOnce re-arms the
    // exit backstop for the POST, so answering early does not lose state.
    writeStdoutOnce(outLine);

    const remote = !!process.env.CLAWD_REMOTE;
    if (!remote && process.platform === "win32") {
      runtimeContext = readWindowsProcessChainHookContext("codebuddy");
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

    const sessionId = (payload && payload.session_id) || "default";
    const cwd = (payload && payload.cwd) || "";

    const pidMetadata = authoritativeProcessChain ? {} : resolve({
        namespace: "codebuddy",
        sessionId,
        cacheCwd: cwd,
        lifecycle: EVENT_TO_LIFECYCLE[hookName] || "event",
        cacheable: sessionId !== "default" && !!cwd,
      });
    const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = pidMetadata;

    const body = { state, session_id: sessionId, event };
    body.agent_id = "codebuddy";
    if (cwd) body.cwd = cwd;
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

    // Stdout was already answered above; don't exit yet — the
    // fire-and-forget POST below still needs to leave the process, so we
    // exit in its callback (with the re-armed backstop timer as last resort).
    const postOptions = { timeoutMs: 100 };
    if (serverProcessChainEnabled) {
      postOptions.preferredPort = runtimeObservation.port;
      postOptions.runtimePort = runtimeObservation.port;
      postOptions.windowsProcessChain = {
        agentId: "codebuddy",
        hookPid: process.pid,
        runtimeObservation,
        legacyCacheSource: pidMetadata.cacheSource || "none",
      };
    }
    postStateToRunningServer(JSON.stringify(body), postOptions, () => {
      finish(outLine);
    });
  })
  .catch(() => finish("{}"));
