#!/usr/bin/env node
// Clawd — WorkBuddy hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Registered in the active WorkBuddy settings.json by hooks/workbuddy-install.js
// WorkBuddy uses Claude Code-compatible hook format with identical event names.

const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig, applyOrcaPaneKey } = require("./shared-process");

// WorkBuddy hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  SessionStart:     { state: "idle",         event: "SessionStart" },
  SessionEnd:       { state: "sleeping",     event: "SessionEnd" },
  UserPromptSubmit: { state: "thinking",     event: "UserPromptSubmit" },
  PreToolUse:       { state: "working",      event: "PreToolUse" },
  PostToolUse:      { state: "working",      event: "PostToolUse" },
  Stop:             { state: "attention",    event: "Stop" },
  // Permission prompts arrive as Notification; WorkBuddy owns approval natively.
  Notification:     { state: "notification", event: "Notification" },
  PreCompact:       { state: "sweeping",     event: "PreCompact" },
};

const config = getPlatformConfig({
  extraTerminals: { win: ["workbuddy.exe"] },
  extraEditors: {
    win: { "workbuddy.exe": "workbuddy" },
    mac: { "workbuddy": "workbuddy" },
    linux: { "workbuddy": "workbuddy" },
  },
  extraEditorPathChecks: [["workbuddy", "workbuddy"]],
});
const WORKBUDDY_AGENT_NAMES = Object.freeze({
  win: new Set(["workbuddy.exe"]),
  // Fallback for builds that spawn hooks under a Helper. Current WorkBuddy AI
  // 5.2.3 instead spawns them under its bundled CLI task runner, matched below.
  mac: new Set([
    "workbuddy ai helper",
    "workbuddy ai helper (renderer)",
    "workbuddy helper",
    "workbuddy helper (renderer)",
  ]),
  linux: new Set(["workbuddy"]),
});

// Current macOS WorkBuddy's GUI Helpers are siblings of the task runner, not
// ancestors of command hooks. The real immediate ancestor is a bundled Electron
// process running app.asar(.unpacked)/cli/bin/codebuddy with a per-task
// --session-id. Require the bundle executable path, exact CLI entry, --serve,
// and --session-id together so the main app, daemon, sidecar, persistent
// connector server, or another Electron app can never become agent_pid. Legacy
// WorkBuddy.app remains supported.
function isWorkBuddyCliCommand(commandLine) {
  const normalized = String(commandLine || "").replace(/\\/g, "/").toLowerCase();
  const bundleNames = ["workbuddy ai.app", "workbuddy.app"];
  const isBundledTaskRunner = bundleNames.some((bundleName) => {
    const executable = `/${bundleName}/contents/macos/electron`;
    const packedCli = `/${bundleName}/contents/resources/app.asar/cli/bin/codebuddy`;
    const unpackedCli = `/${bundleName}/contents/resources/app.asar.unpacked/cli/bin/codebuddy`;
    const executableAt = normalized.indexOf(executable);
    const cliAt = Math.max(normalized.indexOf(packedCli), normalized.indexOf(unpackedCli));
    return executableAt >= 0 && cliAt > executableAt;
  });
  return isBundledTaskRunner
    && /\s--serve(?:\s|$)/.test(normalized)
    && /\s--session-id(?:[=\s]|$)/.test(normalized);
}

const resolve = createPidResolver({
  agentNames: WORKBUDDY_AGENT_NAMES,
  agentCmdlineCheck: isWorkBuddyCliCommand,
  agentCmdlineNames: new Set(["electron"]),
  platformConfig: config,
});

// State-only integration: never make a tool or permission decision. WorkBuddy's
// hook contract treats an empty JSON object as "continue with the native flow";
// an explicit allow can bypass the product permission UI.
function stdoutForEvent() {
  return "{}";
}

const SESSION_TITLE_MAX = 60;

// Derive the session title Clawd shows in the HUD. Without it the HUD falls
// back to the agent label ("WorkBuddy") and two same-session bubbles can't be
// told apart (#648). Only high-quality sources are used — we deliberately do
// NOT fall back to cwd/session_id: the server already resolves
// path.basename(cwd) when no title is stored, and a low-quality value would
// overwrite a good title via the server's sticky `||` chain on later events.
// Priority: payload.session_title (WorkBuddy /rename, if present) → first
// non-blank line of the user prompt on UserPromptSubmit (matches
// clawd-hook.js / qoderwork-hook.js behaviour). Returns null when nothing
// high-quality is available.
function deriveSessionTitle(hookName, payload) {
  const rawTitle =
    payload && typeof payload.session_title === "string" ? payload.session_title.trim() : "";
  if (rawTitle) {
    return rawTitle.length > SESSION_TITLE_MAX
      ? `${rawTitle.slice(0, SESSION_TITLE_MAX - 1)}\u2026`
      : rawTitle;
  }
  if (hookName === "UserPromptSubmit" && payload && typeof payload.prompt === "string") {
    for (const line of payload.prompt.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate) {
        return candidate.length > SESSION_TITLE_MAX
          ? `${candidate.slice(0, SESSION_TITLE_MAX - 1)}\u2026`
          : candidate;
      }
    }
  }
  return null;
}

// Safety timeout: guarantee valid JSON on stdout even if stdin never arrives
// or the process tree walk hangs. Without this WorkBuddy would see empty stdout
// which is invalid JSON and logs an error on every hook invocation.
const SAFETY_TIMEOUT_MS = 800;
let _wrote = false;
let _exited = false;
let safetyTimer = null;

// Write the stdout response exactly once. Kept separate from process exit so the
// hook can answer WorkBuddy immediately yet still let the fire-and-forget POST
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

function run() {
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

      // #618 / #648: a hook event with no session_id cannot be attributed to a
      // session. Forwarding it under a synthetic "default" id creates a phantom
      // bubble that no later event can update or clear — the root cause behind
      // the duplicate "thinking" bubbles and stuck sessions (per @200780381's
      // suggestion ②). So we answer the gate and stop here: no POST, no
      // placeholder session is ever produced.
      const rawSessionId = payload && payload.session_id;
      const sessionId =
        rawSessionId != null && String(rawSessionId).trim() !== "" ? String(rawSessionId).trim() : "";
      if (!sessionId) {
        finish(outLine);
        return;
      }

      if (hookName === "SessionStart" && !process.env.CLAWD_REMOTE) resolve();

      const cwd = (payload && payload.cwd) || "";

      const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = resolve();

      const body = { state, session_id: sessionId, event };
      body.agent_id = "workbuddy";
      if (cwd) body.cwd = cwd;

      const sessionTitle = deriveSessionTitle(hookName, payload);
      if (sessionTitle) body.session_title = sessionTitle;

      if (process.env.CLAWD_REMOTE) {
        body.host = readHostPrefix();
        applyOrcaPaneKey(body);
      } else {
        body.source_pid = stablePid;
        if (detectedEditor) body.editor = detectedEditor;
        if (agentPid) body.agent_pid = agentPid;
        if (pidChain.length) body.pid_chain = pidChain;
        if (tmuxSocket) body.tmux_socket = tmuxSocket;
        if (tmuxClient) body.tmux_client = tmuxClient;
        applyOrcaPaneKey(body);
      }

      // Answer WorkBuddy immediately so it never sees empty stdout, but don't
      // exit yet — the fire-and-forget POST below still needs to leave the
      // process, so we exit in its callback (with the safety timer as backstop).
      writeStdoutOnce(outLine);

      postStateToRunningServer(JSON.stringify(body), { timeoutMs: 100 }, () => {
        finish(outLine);
      });
    })
    .catch(() => finish("{}"));
}

if (require.main === module) {
  run();
} else {
  // Imported for unit testing (deriveSessionTitle). The safety timer above must
  // not keep the test runner alive or fire a stray stdout write.
  if (safetyTimer) clearTimeout(safetyTimer);
  _exited = true;
}

module.exports = {
  HOOK_MAP,
  stdoutForEvent,
  deriveSessionTitle,
  SESSION_TITLE_MAX,
  WORKBUDDY_AGENT_NAMES,
  isWorkBuddyCliCommand,
};
