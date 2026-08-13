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

// CodeBuddy PreToolUse gating — allow by default
function stdoutForEvent(hookName) {
  if (hookName === "PreToolUse") return JSON.stringify({ decision: "allow" });
  return "{}";
}

// Safety timeout: guarantee valid JSON on stdout even if stdin never arrives
// or the process tree walk hangs. Without this CodeBuddy would see empty stdout
// which is invalid JSON and logs an error on every hook invocation.
const SAFETY_TIMEOUT_MS = 800;
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
    const outLine = stdoutForEvent(hookName);

    if (!mapped) {
      finish(outLine);
      return;
    }

    const { state, event } = mapped;
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

    // Answer CodeBuddy immediately so it never sees empty stdout, but don't
    // exit yet — the fire-and-forget POST below still needs to leave the
    // process, so we exit in its callback (with the safety timer as backstop).
    writeStdoutOnce(outLine);

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
