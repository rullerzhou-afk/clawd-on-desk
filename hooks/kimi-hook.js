#!/usr/bin/env node
// Clawd Desktop Pet — Kimi CLI Hook Script
// Usage: node kimi-hook.js <event_name>
// Reads stdin JSON from Kimi CLI for session_id, cwd, tool_name, etc.

const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");
const { processNames: kimiProcessNames } = require("../agents/kimi-cli");

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
};

// Tools that typically trigger a user-approval prompt in Kimi CLI.
// When these tools fire PreToolUse, we flash notification so Clawd
// visually signals that Kimi is waiting for permission.
// Kimi CLI uses snake_case tool names in hook payloads (e.g. "shell",
// "write_file") while logs show PascalCase.  Normalize before checking.
const DEFAULT_PERMISSION_TOOLS = [
  "shell",
  "writefile",
  "strreplacefile",
  "background",
];

function normalizeToolName(name) {
  return typeof name === "string"
    ? name.toLowerCase().replace(/_/g, "")
    : "";
}

function resolvePermissionTools() {
  // Kimi currently does not expose a canonical "requires approval" list in
  // hook payload metadata. Keep a sane default and allow env override for
  // quick compatibility updates across CLI releases.
  const raw = process.env.CLAWD_KIMI_PERMISSION_TOOLS;
  if (!raw) return new Set(DEFAULT_PERMISSION_TOOLS);
  const fromEnv = raw
    .split(",")
    .map((name) => normalizeToolName(name))
    .filter(Boolean);
  return new Set(fromEnv.length ? fromEnv : DEFAULT_PERMISSION_TOOLS);
}

const PERMISSION_TOOLS = resolvePermissionTools();

function isExplicitPermissionSignal(payload) {
  if (!payload || typeof payload !== "object") return false;
  return payload.permission_required === true
    || payload.requires_approval === true
    || payload.waiting_for_approval === true
    || payload.is_permission_request === true;
}

// Classification of PreToolUse for a permission-gated tool:
//   "immediate"  — flip to notification right now (explicit payload signal,
//                  or CLAWD_KIMI_PERMISSION_IMMEDIATE=1 legacy behavior).
//   "suspect"    — keep state=working, ask the state machine to delay-promote
//                  (cancelled if PostToolUse arrives quickly → auto-approved).
//   "none"       — no permission signal at all; hook emits plain working.
function classifyPreTool(event, payload) {
  if (event !== "PreToolUse") return "none";
  const normalizedToolName = normalizeToolName(payload && payload.tool_name);
  if (!PERMISSION_TOOLS.has(normalizedToolName)) return "none";
  // Explicit payload signal always wins and skips the heuristic delay.
  if (isExplicitPermissionSignal(payload)) return "immediate";
  // Full opt-out: never treat PreToolUse as a permission request unless the
  // payload itself said so.
  if (process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION === "1") return "none";
  // Legacy behavior: any permission-gated PreToolUse flips notification
  // instantly. Useful for folks who want the visual cue no matter what.
  if (process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE === "1") return "immediate";
  // Default: mark as suspect. The server-side heuristic will defer the
  // notification switch; if the tool was already auto-approved (previously
  // granted permission), the follow-up PostToolUse cancels the timer and
  // the pet never flashes notification.
  return "suspect";
}

function shouldRemapPreToolToPermission(event, payload) {
  return classifyPreTool(event, payload) === "immediate";
}

function buildStateBody(event, payload, resolve) {
  const state = EVENT_TO_STATE[event];
  if (!state) return null;

  const rawSessionId = payload.session_id || "default";
  const sessionId = rawSessionId.startsWith("kimi-cli:") ? rawSessionId : `kimi-cli:${rawSessionId}`;
  const cwd = payload.cwd || "";

  let resolvedState = state;
  let permissionSuspect = false;

  const classification = classifyPreTool(event, payload);
  if (classification === "immediate") {
    // Explicit signal or legacy switch: flip to notification right now.
    resolvedState = "notification";
    event = "PermissionRequest";
  } else if (classification === "suspect") {
    // Keep state as working; let state.js delay-promote to notification only
    // if Kimi really is waiting on the approval TUI (no PostToolUse within
    // the suspect window).
    permissionSuspect = true;
  }

  const body = { state: resolvedState, session_id: sessionId, event };
  body.agent_id = "kimi-cli";
  if (permissionSuspect) body.permission_suspect = true;
  if (cwd) body.cwd = cwd;

  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else {
    const { stablePid, agentPid, detectedEditor, pidChain } = resolve();
    body.source_pid = stablePid;
    if (detectedEditor) body.editor = detectedEditor;
    if (agentPid) {
      body.agent_pid = agentPid;
      body.kimi_pid = agentPid;
    }
    if (pidChain.length) body.pid_chain = pidChain;
  }

  return body;
}

function main() {
  const eventFromArgv = process.argv[2];

  const config = getPlatformConfig();
  const agentNames = {
    mac: new Set(kimiProcessNames.mac || []),
    linux: new Set(kimiProcessNames.linux || []),
    win: new Set(kimiProcessNames.win || []),
  };
  const resolve = createPidResolver({
    agentNames,
    agentCmdlineCheck: (cmd) => cmd.includes("kimi") || cmd.includes("kimi-cli"),
    platformConfig: config,
  });

  readStdinJson().then((payload) => {
    // Kimi CLI passes event via stdin JSON (not argv), so resolve it here.
    // Field name is "hook_event_name" (not "event").
    const event = eventFromArgv || (payload && (payload.hook_event_name || payload.event)) || "";
    if (!EVENT_TO_STATE[event]) process.exit(0);

    // Pre-resolve on SessionStart (runs during stdin buffering, not after)
    if (event === "SessionStart" && !process.env.CLAWD_REMOTE) resolve();

    const body = buildStateBody(event, payload || {}, resolve);
    if (!body) process.exit(0);
    postStateToRunningServer(
      JSON.stringify(body),
      { timeoutMs: 100 },
      () => process.exit(0)
    );
  }).catch(() => process.exit(0));
}

if (require.main === module) main();
module.exports = {
  buildStateBody,
  PERMISSION_TOOLS,
  DEFAULT_PERMISSION_TOOLS,
  resolvePermissionTools,
  shouldRemapPreToolToPermission,
  classifyPreTool,
  isExplicitPermissionSignal,
};
