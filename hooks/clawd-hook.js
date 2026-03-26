#!/usr/bin/env node
// Clawd Desktop Pet — Claude Code Hook Script
// Zero dependencies, fast cold start, 1s timeout
// Usage: node clawd-hook.js <event_name>
// Reads stdin JSON from Claude Code for session_id

const { walkProcessTree } = require("../lib/process-tree");

const EVENT_TO_STATE = {
  SessionStart: "idle",
  SessionEnd: "sleeping",
  UserPromptSubmit: "thinking",
  PreToolUse: "working",
  PostToolUse: "working",
  PostToolUseFailure: "error",
  Stop: "attention",
  StopFailure: "error",
  SubagentStart: "juggling",
  SubagentStop: "working",
  PreCompact: "sweeping",
  PostCompact: "attention",
  Notification: "notification",
  // PermissionRequest is handled by HTTP hook (blocking) — not command hook
  Elicitation: "notification",
  WorktreeCreate: "carrying",
};

const event = process.argv[2];
const state = EVENT_TO_STATE[event];
if (!state) process.exit(0);

// Cached process info
let _result = null;

function getStablePid() {
  if (_result) return _result.stablePid;
  _result = walkProcessTree();
  return _result.stablePid;
}

// Pre-resolve on SessionStart (runs during stdin buffering, not after)
if (event === "SessionStart") getStablePid();

// Read stdin for session_id (Claude Code pipes JSON with session metadata)
const chunks = [];
let sent = false;

process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  let sessionId = "default";
  let cwd = "";
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    sessionId = payload.session_id || "default";
    cwd = payload.cwd || "";
  } catch {}
  send(sessionId, cwd);
});

// Safety: if stdin doesn't end in 400ms, send with default session
// (200ms was too aggressive on slow machines / AV scanning)
setTimeout(() => send("default", ""), 400);

function send(sessionId, cwd) {
  if (sent) return;
  sent = true;

  // Ensure process tree is walked
  getStablePid();

  const body = { state, session_id: sessionId, event };
  body.agent_id = "claude-code";
  if (cwd) body.cwd = cwd;
  // Always walk to stable terminal PID — process.ppid is an ephemeral shell
  // that dies when the hook exits, so it's useless for later focus calls
  body.source_pid = _result.stablePid;
  if (_result.detectedEditor) body.editor = _result.detectedEditor;
  if (_result.agentPid) {
    body.agent_pid = _result.agentPid;
    body.claude_pid = _result.agentPid; // backward compat with older Clawd versions
  }
  if (_result.pidChain.length) body.pid_chain = _result.pidChain;

  const data = JSON.stringify(body);
  const req = require("http").request(
    {
      hostname: "127.0.0.1",
      port: 23333,
      path: "/state",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 500,  // 400ms stdin + 500ms HTTP = 900ms < 1000ms Claude Code budget
    },
    () => process.exit(0)
  );
  req.on("error", () => process.exit(0));
  req.on("timeout", () => { req.destroy(); process.exit(0); });
  req.end(data);
}
