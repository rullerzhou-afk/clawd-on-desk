#!/usr/bin/env node
// Clawd Desktop Pet — Kimi CLI Hook Script
// Usage: node kimi-hook.js <event_name>
// Reads stdin JSON from Kimi CLI for session_id, cwd, tool_name, etc.

const { postStateToRunningServer, readHostPrefix } = require("./server-config");
const { createPidResolver, readStdinJson, getPlatformConfig } = require("./shared-process");
const { processNames: kimiProcessNames } = require("../agents/kimi-cli");
const fs = require("fs");
const path = require("path");
const os = require("os");

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
const MODE_EXPLICIT = "explicit";
const MODE_SUSPECT = "suspect";
const DEFAULT_HOOK_DEBUG_MAX_BYTES = 5 * 1024 * 1024;

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

function readPermissionMode() {
  const raw = typeof process.env.CLAWD_KIMI_PERMISSION_MODE === "string"
    ? process.env.CLAWD_KIMI_PERMISSION_MODE.trim().toLowerCase()
    : "";
  if (raw === MODE_EXPLICIT || raw === MODE_SUSPECT) return raw;
  return null;
}

function isTruthySignal(value) {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

function isWaitingApprovalStatus(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  return normalized === "waiting_for_approval"
    || normalized === "awaiting_approval"
    || normalized === "requires_approval"
    || normalized === "approval_required"
    || normalized === "permission_required"
    || normalized === "needs_approval";
}

function isPermissionKeyword(key) {
  if (typeof key !== "string" || !key) return false;
  const normalized = key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return normalized.includes("permission")
    || normalized.includes("approval")
    || normalized.includes("authorize")
    || normalized.includes("consent");
}

function isPermissionPendingLike(value) {
  if (isTruthySignal(value)) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  return normalized.includes("wait")
    || normalized.includes("pend")
    || normalized.includes("request")
    || normalized.includes("require")
    || normalized.includes("need_approval")
    || normalized === "ask";
}

function hasKeywordPermissionSignal(payload, depth = 0) {
  if (!payload || typeof payload !== "object" || depth > 3) return false;
  for (const [key, value] of Object.entries(payload)) {
    if (isPermissionKeyword(key) && isPermissionPendingLike(value)) return true;
    if (value && typeof value === "object") {
      if (hasKeywordPermissionSignal(value, depth + 1)) return true;
    }
  }
  return false;
}

function readHookDebugMaxBytes() {
  const raw = process.env.CLAWD_KIMI_HOOK_DEBUG_MAX_BYTES;
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_HOOK_DEBUG_MAX_BYTES;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_HOOK_DEBUG_MAX_BYTES;
  return parsed;
}

function appendHookDebug(entry) {
  if (process.env.CLAWD_KIMI_HOOK_DEBUG !== "1") return;
  const debugPath = process.env.CLAWD_KIMI_HOOK_DEBUG_PATH
    || path.join(os.homedir(), ".clawd", "kimi-hook-debug.jsonl");
  try {
    const line = `${JSON.stringify(entry)}\n`;
    const maxBytes = readHookDebugMaxBytes();
    if (maxBytes > 0) {
      let currentSize = 0;
      try {
        currentSize = fs.statSync(debugPath).size || 0;
      } catch {}
      if (currentSize + Buffer.byteLength(line) > maxBytes) return;
    }
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.appendFileSync(debugPath, line);
  } catch {}
}

function readToolName(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.tool_name === "string" && payload.tool_name) return payload.tool_name;
  if (typeof payload.toolName === "string" && payload.toolName) return payload.toolName;
  if (typeof payload.tool === "string" && payload.tool) return payload.tool;
  if (payload.tool && typeof payload.tool === "object") {
    if (typeof payload.tool.name === "string" && payload.tool.name) return payload.tool.name;
    if (typeof payload.tool.tool_name === "string" && payload.tool.tool_name) return payload.tool.tool_name;
  }
  return "";
}

function isExplicitPermissionSignal(payload) {
  if (!payload || typeof payload !== "object") return false;
  const topLevelFlags = [
    payload.permission_required,
    payload.requires_approval,
    payload.waiting_for_approval,
    payload.is_permission_request,
    payload.permissionRequired,
    payload.requiresApproval,
    payload.waitingForApproval,
    payload.isPermissionRequest,
    payload.approval_required,
    payload.needs_approval,
    payload.needsApproval,
  ];
  if (topLevelFlags.some(isTruthySignal)) return true;
  if (isWaitingApprovalStatus(payload.permission_status) || isWaitingApprovalStatus(payload.approval_status)) return true;

  const nestedObjects = [payload.permission, payload.approval, payload.permission_request];
  for (const nested of nestedObjects) {
    if (!nested || typeof nested !== "object") continue;
    const nestedFlags = [
      nested.required,
      nested.requires_approval,
      nested.requiresApproval,
      nested.waiting_for_approval,
      nested.waitingForApproval,
      nested.is_permission_request,
      nested.isPermissionRequest,
      nested.needs_approval,
      nested.needsApproval,
    ];
    if (nestedFlags.some(isTruthySignal)) return true;
    if (isWaitingApprovalStatus(nested.status) || isWaitingApprovalStatus(nested.state)) return true;
  }
  // Compatibility fallback for field-shape drift across Kimi versions.
  // Keep explicit-only semantics: only promote when payload itself carries
  // permission/approval semantics (including unknown key names).
  if (hasKeywordPermissionSignal(payload)) return true;
  return false;
}

// Classification of PreToolUse for a permission-gated tool:
//   "immediate"  — flip to notification right now (explicit payload signal,
//                  or CLAWD_KIMI_PERMISSION_IMMEDIATE=1 legacy behavior).
//   "suspect"    — keep state=working, ask the state machine to delay-promote
//                  (cancelled if PostToolUse arrives quickly → auto-approved).
//                  Optional behavior enabled by env.
//   "none"       — no permission signal at all; hook emits plain working.
function classifyPreTool(event, payload) {
  if (event !== "PreToolUse") return "none";
  const normalizedToolName = normalizeToolName(readToolName(payload));
  if (!PERMISSION_TOOLS.has(normalizedToolName)) return "none";
  // Explicit payload signal always wins and skips the heuristic delay.
  if (isExplicitPermissionSignal(payload)) return "immediate";
  // Full opt-out: never treat PreToolUse as a permission request unless the
  // payload itself said so.
  if (process.env.CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION === "1") return "none";
  // Legacy behavior: any permission-gated PreToolUse flips notification
  // instantly. Useful for folks who want the visual cue no matter what.
  if (process.env.CLAWD_KIMI_PERMISSION_IMMEDIATE === "1") return "immediate";
  // Persistent mode switch (written into ~/.kimi/config.toml hook command).
  const mode = readPermissionMode();
  if (mode === MODE_SUSPECT) return "suspect";
  if (mode === MODE_EXPLICIT) return "none";
  // Optional suspect mode: manual opt-in.
  if (process.env.CLAWD_KIMI_PERMISSION_SUSPECT === "1") return "suspect";
  // Default: explicit-only mode to avoid false positives for long-running
  // auto-approved tools (sleep/npm/network I/O).
  return "none";
}

function shouldRemapPreToolToPermission(event, payload) {
  return classifyPreTool(event, payload) === "immediate";
}

function buildStateBody(event, payload, resolve) {
  const state = EVENT_TO_STATE[event];
  if (!state) return null;

  // Kimi currently emits string session_ids; we still coerce defensively so a
  // future payload shape drift (e.g. numeric ids) doesn't throw from
  // `.startsWith` and get silently swallowed by main()'s .catch.
  const rawSessionId = payload.session_id != null && payload.session_id !== ""
    ? String(payload.session_id)
    : "default";
  const sessionId = rawSessionId.startsWith("kimi-cli:") ? rawSessionId : `kimi-cli:${rawSessionId}`;
  const cwd = typeof payload.cwd === "string" ? payload.cwd : "";

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

    const safePayload = payload || {};
    const classification = classifyPreTool(event, safePayload);
    const body = buildStateBody(event, safePayload, resolve);
    appendHookDebug({
      at: new Date().toISOString(),
      event,
      session_id: safePayload.session_id || null,
      tool_name: readToolName(safePayload) || null,
      classification,
      body_event: body && body.event,
      body_state: body && body.state,
      payload: safePayload,
    });
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
  readToolName,
  hasKeywordPermissionSignal,
  readPermissionMode,
  MODE_EXPLICIT,
  MODE_SUSPECT,
  readHookDebugMaxBytes,
  appendHookDebug,
  DEFAULT_HOOK_DEBUG_MAX_BYTES,
};
