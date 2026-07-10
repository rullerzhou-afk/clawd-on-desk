#!/usr/bin/env node
// Clawd - WorkBuddy hook.
// Registered in ~/.workbuddy/settings.json by hooks/workbuddy-install.js

const { postStateToRunningServer, readHostPrefix, applyWslSourceFields } = require("./server-config");
const { readStdinJson } = require("./shared-process");

const HOOK_MAP = {
  SessionStart:     { state: "idle",         event: "SessionStart" },
  SessionEnd:       { state: "sleeping",     event: "SessionEnd" },
  UserPromptSubmit: { state: "thinking",     event: "UserPromptSubmit" },
  PreToolUse:       { state: "working",      event: "PreToolUse" },
  PostToolUse:      { state: "working",      event: "PostToolUse" },
  Stop:             { state: "attention",    event: "Stop" },
  Notification:     { state: "notification", event: "Notification" },
  PreCompact:       { state: "sweeping",     event: "PreCompact" },
};

function stdoutForEvent(hookName) {
  if (hookName === "PreToolUse") return JSON.stringify({ decision: "allow" });
  return "{}";
}

const SAFETY_TIMEOUT_MS = 800;
let wrote = false;
let exited = false;
let safetyTimer = null;

function writeStdoutOnce(outLine) {
  if (wrote) return;
  wrote = true;
  process.stdout.write(`${outLine}\n`);
}

function finish(outLine) {
  writeStdoutOnce(outLine);
  if (exited) return;
  exited = true;
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

    const sessionId = (payload && payload.session_id) || "default";
    const cwd = (payload && payload.cwd) || "";
    const body = {
      state: mapped.state,
      session_id: sessionId,
      event: mapped.event,
      agent_id: "workbuddy",
    };
    if (cwd) body.cwd = cwd;

    if (process.env.CLAWD_REMOTE) {
      body.host = readHostPrefix();
      applyWslSourceFields(body, { remote: true });
    } else {
      applyWslSourceFields(body);
    }

    writeStdoutOnce(outLine);

    postStateToRunningServer(JSON.stringify(body), { timeoutMs: 100 }, () => {
      finish(outLine);
    });
  })
  .catch(() => finish("{}"));
