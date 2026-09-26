#!/usr/bin/env node
// Clawd — Cursor Agent hook (stdin JSON, hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.cursor/hooks.json by hooks/cursor-install.js

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
const { resolveSessionTitle } = require("./cursor-session-title");
const { CURSOR_HOOK_SENTINEL } = require("./json-utils");

// Grok scans Claude-compatible settings by default and must never produce a
// phantom cursor-agent session. Only the runner-injected official
// GROK_HOOK_EVENT activates this guard; GROK_HOME / an unrelated GROK_*
// variable must not. Cursor hooks execute at require time, so the passive
// response and exit happen before any resolver or POST work.
function launchedByGrok(env = process.env) {
  return Boolean(env && env.GROK_HOOK_EVENT && String(env.GROK_HOOK_EVENT).trim());
}

if (launchedByGrok()) {
  process.stdout.write("{}\n");
  process.exit(0);
}

const HOOK_TO_STATE = {
  sessionStart: { state: "idle", event: "SessionStart" },
  sessionEnd: { state: "sleeping", event: "SessionEnd" },
  beforeSubmitPrompt: { state: "thinking", event: "UserPromptSubmit" },
  preToolUse: { state: "working", event: "PreToolUse" },
  postToolUse: { state: "working", event: "PostToolUse" },
  postToolUseFailure: { state: "working", event: "PostToolUseFailure" },
  subagentStart: { state: "juggling", event: "SubagentStart" },
  subagentStop: { state: "working", event: "SubagentStop" },
  preCompact: { state: "sweeping", event: "PreCompact" },
  afterAgentThought: { state: "thinking", event: "AfterAgentThought" },
};

// #634: lifecycle for the shared resolver's cross-process pid cache. Raw
// Cursor hook names (pre-mapping). sessionEnd drops the cache; everything
// unlisted is "event" (cache hit = zero snapshot spawns).
const EVENT_TO_LIFECYCLE = {
  sessionStart: "start",
  beforeSubmitPrompt: "prompt",
  sessionEnd: "end",
};

const config = getPlatformConfig({ extraTerminals: { win: ["cursor.exe"] } });
let runtimeContext = Object.freeze({
  identity: { ok: false, reason: "not-observed", port: null, ownerPid: null },
  observation: null,
});
const resolve = createPidResolver({
  agentNames: { win: new Set(["cursor.exe"]), mac: new Set(["cursor"]), linux: new Set(["cursor"]) },
  platformConfig: config,
  readRuntimeIdentity: () => runtimeContext.identity,
});

function stdoutForCursorHook(hookName) {
  // Only respond with continue for prompt submission; don't override Cursor's permission system
  if (hookName === "beforeSubmitPrompt") return JSON.stringify({ continue: true });
  return "{}";
}

/** Maps Cursor preToolUse/postToolUse tool_name to assets/svg basenames (see state.js DISPLAY_HINT_SVGS). */
function displaySvgFromToolHook(hookName, payload) {
  if (hookName !== "preToolUse" && hookName !== "postToolUse") return undefined;
  const name = payload && payload.tool_name;
  if (!name || typeof name !== "string") return undefined;
  if (name === "Shell" || name.startsWith("MCP:")) return "clawd-working-building.svg";
  if (name === "Task") return "clawd-headphones-groove.svg";
  if (name === "Write" || name === "Delete") return "clawd-working-typing.svg";
  if (name === "Read" || name === "Grep") return "clawd-idle-reading.svg";
  return undefined;
}

function resolveStateAndEvent(payload, hookName) {
  if (!hookName) return null;
  if (hookName === "stop") {
    const st = payload && payload.status;
    if (st === "error") return { state: "error", event: "StopFailure" };
    return { state: "attention", event: "Stop" };
  }
  return HOOK_TO_STATE[hookName] || null;
}

// readStdinJson bounds input waiting separately. Start the delivery watchdog
// only after synchronous metadata work: a slow Windows process snapshot can
// exceed 800ms, leaving an earlier timer ready to exit before HTTP gets a turn.
const DELIVERY_TIMEOUT_MS = 800;
let _wrote = false;
let _exited = false;
let deliveryTimer = null;
let outLine = "{}";

// Respond once, after delivery completes/fails or its watchdog expires.
function writeStdoutOnce(outLine) {
  if (_wrote) return;
  _wrote = true;
  process.stdout.write(outLine + "\n");
}

function finish(outLine) {
  writeStdoutOnce(outLine);
  if (_exited) return;
  _exited = true;
  if (deliveryTimer) clearTimeout(deliveryTimer);
  process.exit(0);
}

readStdinJson()
  .then((payload) => {
    const argvOverride = process.argv[2] === CURSOR_HOOK_SENTINEL ? process.argv[3] : process.argv[2];
    const hookNameResolved = argvOverride || (payload && payload.hook_event_name) || "";
    const mapped = resolveStateAndEvent(payload, hookNameResolved);
    outLine = stdoutForCursorHook(hookNameResolved);

    if (!mapped) {
      finish(outLine);
      return;
    }

    const { state, event } = mapped;
    const remote = !!process.env.CLAWD_REMOTE;
    if (!remote && process.platform === "win32") {
      runtimeContext = readWindowsProcessChainHookContext("cursor-agent");
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
    if (hookNameResolved === "sessionStart" && !remote && !authoritativeProcessChain) resolve();

    const sessionId =
      (payload && (payload.conversation_id || payload.session_id)) || "default";
    let cwd = (payload && payload.cwd) || "";
    if (!cwd && payload && Array.isArray(payload.workspace_roots) && payload.workspace_roots[0]) {
      cwd = payload.workspace_roots[0];
    }

    const pidMetadata = authoritativeProcessChain ? {} : resolve({
        namespace: "cursor-agent",
        sessionId,
        cacheCwd: cwd,
        lifecycle: EVENT_TO_LIFECYCLE[hookNameResolved] || "event",
        cacheable: sessionId !== "default" && !!cwd,
      });
    const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = pidMetadata;

    const body = { state, session_id: sessionId, event };
    body.agent_id = "cursor-agent";
    const sessionTitle = resolveSessionTitle(payload, hookNameResolved, { readDatabase: !remote });
    if (sessionTitle) body.session_title = sessionTitle;
    const hint = displaySvgFromToolHook(hookNameResolved, payload);
    if (hint !== undefined) body.display_svg = hint;
    if (cwd) body.cwd = cwd;
    if (remote) {
      body.host = readHostPrefix();
      applyWslSourceFields(body, { remote: true });
      applyOrcaPaneKey(body);
    } else {
      applyWslSourceFields(body);
      if (!authoritativeProcessChain) {
        body.source_pid = stablePid;
        body.editor = detectedEditor || "cursor";
        if (agentPid) {
          body.agent_pid = agentPid;
          body.cursor_pid = agentPid;
        }
        if (Array.isArray(pidChain) && pidChain.length) body.pid_chain = pidChain;
        if (tmuxSocket) body.tmux_socket = tmuxSocket;
        if (tmuxClient) body.tmux_client = tmuxClient;
      }
      applyOrcaPaneKey(body);
    }

    const postOptions = { timeoutMs: 100 };
    if (serverProcessChainEnabled) {
      postOptions.preferredPort = runtimeObservation.port;
      postOptions.runtimePort = runtimeObservation.port;
      postOptions.windowsProcessChain = {
        agentId: "cursor-agent",
        hookPid: process.pid,
        runtimeObservation,
        legacyCacheSource: pidMetadata.cacheSource || "none",
      };
    }
    deliveryTimer = setTimeout(() => finish(outLine), DELIVERY_TIMEOUT_MS);
    postStateToRunningServer(JSON.stringify(body), postOptions, () => {
      finish(outLine);
    });
  })
  .catch(() => finish(outLine));
