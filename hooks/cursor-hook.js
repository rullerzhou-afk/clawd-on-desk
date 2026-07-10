#!/usr/bin/env node
// Clawd — Cursor Agent hook (stdin JSON, hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.cursor/hooks.json by hooks/cursor-install.js

const { postStateToRunningServer, readHostPrefix, applyWslSourceFields } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");

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

const config = getPlatformConfig({ extraTerminals: { win: ["cursor.exe"] } });
const resolve = createPidResolver({
  agentNames: { win: new Set(["cursor.exe"]), mac: new Set(["cursor"]), linux: new Set(["cursor"]) },
  platformConfig: config,
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

// Safety timeout: guarantee valid JSON on stdout within 1s even if stdin never
// arrives or the process tree walk hangs. Without this Cursor would see empty
// stdout which is invalid JSON and logs an error on every hook invocation.
const SAFETY_TIMEOUT_MS = 800;
let _wrote = false;
let _exited = false;
let safetyTimer = null;

// Write the stdout response exactly once. Kept separate from process exit so the
// hook can answer Cursor immediately yet still let the fire-and-forget POST to
// Clawd leave the process before it exits.
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
    const argvOverride = process.argv[2];
    const hookNameResolved = argvOverride || (payload && payload.hook_event_name) || "";
    const mapped = resolveStateAndEvent(payload, hookNameResolved);
    const outLine = stdoutForCursorHook(hookNameResolved);

    if (!mapped) {
      finish(outLine);
      return;
    }

    const { state, event } = mapped;
    if (hookNameResolved === "sessionStart" && !process.env.CLAWD_REMOTE) resolve();

    const sessionId =
      (payload && (payload.conversation_id || payload.session_id)) || "default";
    let cwd = (payload && payload.cwd) || "";
    if (!cwd && payload && Array.isArray(payload.workspace_roots) && payload.workspace_roots[0]) {
      cwd = payload.workspace_roots[0];
    }

    const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = resolve();

    const body = { state, session_id: sessionId, event };
    body.agent_id = "cursor-agent";
    const hint = displaySvgFromToolHook(hookNameResolved, payload);
    if (hint !== undefined) body.display_svg = hint;
    if (cwd) body.cwd = cwd;
    if (process.env.CLAWD_REMOTE) {
      body.host = readHostPrefix();
      applyWslSourceFields(body, { remote: true });
    } else {
      applyWslSourceFields(body);
      body.source_pid = stablePid;
      body.editor = detectedEditor || "cursor";
      if (agentPid) {
        body.agent_pid = agentPid;
        body.cursor_pid = agentPid;
      }
      if (pidChain.length) body.pid_chain = pidChain;
      if (tmuxSocket) body.tmux_socket = tmuxSocket;
      if (tmuxClient) body.tmux_client = tmuxClient;
    }

    // Answer Cursor immediately so it never sees empty/malformed stdout, but
    // don't exit yet — the fire-and-forget POST below still needs to leave the
    // process, so we exit in its callback (with the safety timer as backstop).
    writeStdoutOnce(outLine);

    postStateToRunningServer(JSON.stringify(body), { timeoutMs: 100 }, () => {
      finish(outLine);
    });
  })
  .catch(() => finish("{}"));
