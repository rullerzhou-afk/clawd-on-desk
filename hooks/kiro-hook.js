#!/usr/bin/env node
// Clawd — Kiro CLI hook (stdin JSON with hook_event_name; exit code gating)
// Registered in ~/.kiro/agents/clawd.json by hooks/kiro-install.js

const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

// Kiro CLI hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  agentSpawn:       { state: "idle",      event: "agentSpawn" },
  userPromptSubmit: { state: "thinking",  event: "userPromptSubmit" },
  preToolUse:       { state: "working",   event: "preToolUse" },
  postToolUse:      { state: "working",   event: "postToolUse" },
  stop:             { state: "attention", event: "stop" },
};

const config = getPlatformConfig();
const resolve = createPidResolver({
  agentNames: { win: new Set(["kiro-cli.exe"]), mac: new Set(["kiro-cli"]), linux: new Set(["kiro-cli"]) },
  platformConfig: config,
});

readStdinJson().then((payload) => {
  const hookName = (payload && payload.hook_event_name) || "";
  const mapped = HOOK_MAP[hookName];
  if (!mapped) {
    process.exit(0);
    return;
  }

  const { state, event } = mapped;
  if (hookName === "agentSpawn" && !process.env.CLAWD_REMOTE) resolve();

  // Kiro CLI stdin has no session_id — use "default" (all sessions merged)
  const sessionId = "default";
  const cwd = (payload && payload.cwd) || "";

  const { stablePid, agentPid, detectedEditor, pidChain } = resolve();

  const body = { state, session_id: sessionId, event };
  body.agent_id = "kiro-cli";
  if (cwd) body.cwd = cwd;
  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    body.source_pid = stablePid;
    if (detectedEditor) body.editor = detectedEditor;
    if (agentPid) body.agent_pid = agentPid;
    if (pidChain.length) body.pid_chain = pidChain;
  }

  postStateToRunningServer(JSON.stringify(body), { timeoutMs: 100 }, () => {
    process.exit(0);
  });
});
