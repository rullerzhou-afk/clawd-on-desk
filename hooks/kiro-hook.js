#!/usr/bin/env node
// Clawd — Kiro CLI hook (stdin JSON with hook_event_name; exit code gating)
// Registered in ~/.kiro/agents/clawd.json by hooks/kiro-install.js

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

// Kiro CLI hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  agentSpawn:       { state: "idle",      event: "agentSpawn" },
  userPromptSubmit: { state: "thinking",  event: "userPromptSubmit" },
  preToolUse:       { state: "working",   event: "preToolUse" },
  postToolUse:      { state: "working",   event: "postToolUse" },
  stop:             { state: "attention", event: "stop" },
};

const config = getPlatformConfig();
let runtimeContext = Object.freeze({
  identity: { ok: false, reason: "not-observed", port: null, ownerPid: null },
  observation: null,
});
const resolve = createPidResolver({
  agentNames: { win: new Set(["kiro-cli.exe"]), mac: new Set(["kiro-cli"]), linux: new Set(["kiro-cli"]) },
  platformConfig: config,
  readRuntimeIdentity: () => runtimeContext.identity,
});

readStdinJson()
  .then((payload) => {
    const hookName = (payload && payload.hook_event_name) || "";
    const mapped = HOOK_MAP[hookName];
    if (!mapped) {
      process.exit(0);
      return;
    }

    const { state, event } = mapped;
    const remote = !!process.env.CLAWD_REMOTE;
    if (!remote && process.platform === "win32") {
      runtimeContext = readWindowsProcessChainHookContext("kiro-cli");
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
    if (hookName === "agentSpawn" && !remote && !authoritativeProcessChain) resolve();

    // Kiro CLI stdin has no session_id — use "default" (all sessions merged)
    const sessionId = "default";
    const cwd = (payload && payload.cwd) || "";

    // #634: no stable session id → cacheable stays false (never key a
    // cross-process cache under the shared "default" sid, cf. #583) and no
    // "prompt" mapping (cache-only would ship empty fields where today's
    // per-event fresh snapshot ships real ones). agentSpawn→"start" still
    // reuses the existing in-process prewarm; with cacheable:false it does no
    // disk sweep/write/drop. Everything else stays a plain fresh snapshot.
    const pidMetadata = authoritativeProcessChain ? {} : resolve({
        namespace: "kiro-cli",
        sessionId,
        cacheCwd: cwd,
        lifecycle: hookName === "agentSpawn" ? "start" : "event",
        cacheable: false,
      });
    const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = pidMetadata;

    const body = { state, session_id: sessionId, event };
    body.agent_id = "kiro-cli";
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

    const postOptions = { timeoutMs: 100 };
    if (serverProcessChainEnabled) {
      postOptions.preferredPort = runtimeObservation.port;
      postOptions.runtimePort = runtimeObservation.port;
      postOptions.windowsProcessChain = {
        agentId: "kiro-cli",
        hookPid: process.pid,
        runtimeObservation,
        legacyCacheSource: pidMetadata.cacheSource || "none",
      };
    }
    postStateToRunningServer(JSON.stringify(body), postOptions, () => {
      process.exit(0);
    });
  })
  .catch(() => process.exit(0));
