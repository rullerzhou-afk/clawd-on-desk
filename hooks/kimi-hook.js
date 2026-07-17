#!/usr/bin/env node
// Clawd Desktop Pet — Kimi Hook Script (legacy Kimi CLI + Kimi Code)
// Usage: node kimi-hook.js <event_name>
// Reads stdin JSON (snake_case, identical shape across both generations) for
// session_id, cwd, tool_name, etc.

const { postStateToRunningServer, readHostPrefix, applyWslSourceFields } = require("./server-config");
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
  // Kimi Code (TypeScript CLI) native events — the legacy Python CLI never
  // sends these. PermissionRequest fires right before the approval TUI
  // blocks; its body event matches what buildStateBody synthesizes from a
  // legacy suspect/immediate PreToolUse, so state.js serves both generations
  // through the same path. PermissionResult ends the approval (approved or
  // rejected) and Interrupt is the user's Esc — both mean "stop showing the
  // permission bubble".
  PermissionRequest: "notification",
  PermissionResult: "working",
  Interrupt: "idle",
};

// Tools that typically trigger a user-approval prompt in the LEGACY Kimi CLI.
// When these tools fire PreToolUse, we flash notification so Clawd
// visually signals that Kimi is waiting for permission.
// Legacy Kimi CLI uses snake_case tool names in hook payloads (e.g. "shell",
// "write_file") while logs show PascalCase.  Normalize before checking.
// Kimi Code renamed its built-ins (Bash/Edit/Write, PascalCase) but also
// ships native PermissionRequest/PermissionResult events, so this heuristic
// list is legacy-only by design — the kimi-code install never sets a
// permission mode and classifyPreTool stays "none" there.
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

function normalizePermissionModeValue(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === MODE_EXPLICIT || raw === MODE_SUSPECT) return raw;
  return null;
}

function readPermissionMode() {
  return normalizePermissionModeValue(process.env.CLAWD_KIMI_PERMISSION_MODE);
}

// Persistent mode switch written into the hook command line by the installer
// (`--permission-mode=suspect`). argv instead of an env prefix because both
// Kimi generations execute hooks through a real shell on Windows
// (create_subprocess_shell / %COMSPEC%), where the POSIX `VAR=x cmd` form
// silently does not execute. Runtime env vars stay the higher-priority escape
// hatch — see classifyPreTool.
let argvPermissionMode = null;

function setArgvPermissionMode(value) {
  argvPermissionMode = normalizePermissionModeValue(value);
  return argvPermissionMode;
}

// Splits argv tail into { event, mode }. `--permission-mode=<x>` (and the
// space-separated `--permission-mode <x>` form, whose value is consumed so it
// can never be misread as an event) set the persistent mode; other `--` flags
// are ignored. A positional token may claim the event slot ONLY when it is a
// known event name: kimi-cli itself passes no event argv (the real event
// arrives as hook_event_name on stdin), and an arbitrary token promoted to
// eventFromArgv would override that stdin event and make main() exit(0) on
// the unknown name — a silently dead hook. Residual corner: the value of an
// UNKNOWN flag that happens to spell a valid event name is still taken as the
// event; unknowable without a registry of which flags take values.
function parseHookArgv(argvTail) {
  const parsed = { event: "", mode: null, ignoredFlags: [] };
  const args = Array.isArray(argvTail) ? argvTail : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string" || !arg) continue;
    if (arg.startsWith("--")) {
      const eqMatch = arg.match(/^--permission-mode=(.*)$/);
      if (eqMatch) {
        const normalized = normalizePermissionModeValue(eqMatch[1]);
        if (normalized) parsed.mode = normalized;
        else parsed.ignoredFlags.push(arg);
        continue;
      }
      if (arg === "--permission-mode") {
        const value = typeof args[i + 1] === "string" ? args[i + 1] : "";
        i += 1;
        const normalized = normalizePermissionModeValue(value);
        if (normalized) parsed.mode = normalized;
        else parsed.ignoredFlags.push(value ? `${arg} ${value}` : arg);
        continue;
      }
      parsed.ignoredFlags.push(arg);
      continue;
    }
    if (!parsed.event && EVENT_TO_STATE[arg]) {
      parsed.event = arg;
    } else {
      parsed.ignoredFlags.push(arg);
    }
  }
  return parsed;
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

const PERMISSION_GATE_ID_MAX_CHARS = 100;

// Legacy kimi-cli threads the same tool_call_id through PreToolUse /
// PostToolUse / PostToolUseFailure (verified against 1.37 site-packages and
// current upstream events.py/toolset.py), which lets state.js pair a gated
// PreToolUse with the Post that settles it. Tolerate shape drift like the
// other payload readers; null just downgrades that gate to FIFO matching.
function readToolCallId(payload) {
  if (!payload || typeof payload !== "object") return null;
  const candidates = [
    payload.tool_call_id,
    payload.toolCallId,
    payload.tool_call && typeof payload.tool_call === "object" ? payload.tool_call.id : undefined,
    payload.toolCall && typeof payload.toolCall === "object" ? payload.toolCall.id : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().slice(0, PERMISSION_GATE_ID_MAX_CHARS);
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return null;
}

function isGatedPostEvent(event, payload) {
  if (event !== "PostToolUse" && event !== "PostToolUseFailure") return false;
  return PERMISSION_TOOLS.has(normalizeToolName(readToolName(payload)));
}

const PERMISSION_TOOL_INPUT_MAX_CHARS = 500;

// Whitelisted subset of a native PermissionRequest's structured tool_input,
// forwarded so the bubble can render tool-aware cues (command for Bash, file
// path for Write/Edit) through the same formatter Claude bubbles use. Kimi
// Code's file tools say `path` where Claude says `file_path` (captured from
// kimi-code 0.14.3, unchanged in the 0.23.6 bundle's Write/Edit schemas);
// map it so the formatter finds it. src/server-route-state.js re-runs this
// exact function at the trust boundary rather than trusting the hook.
// Everything else is dropped by construction: content / old_string /
// new_string can be arbitrarily large (an oversized /state body is rejected
// whole), and Bash's optional `description` is model-authored text that
// formatDetail would show instead of the real command — the card must show
// what actually runs, not what the model says about it.
function extractPermissionToolInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  const take = (target, value) => {
    // First writer wins: an explicit file_path beats the mapped `path` alias.
    if (typeof value !== "string" || out[target] !== undefined) return;
    // Trim first, matching the server's trim-then-clamp order: a value with
    // ≥500 chars of leading whitespace would otherwise clamp to whitespace
    // only and be dropped server-side.
    const trimmed = value.trim();
    if (trimmed) out[target] = trimmed.slice(0, PERMISSION_TOOL_INPUT_MAX_CHARS);
  };
  take("command", raw.command);
  take("file_path", raw.file_path);
  take("file_path", raw.path);
  take("pattern", raw.pattern);
  return Object.keys(out).length ? out : null;
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
  // Runtime env escape hatch: always beats the persisted argv mode.
  const envMode = readPermissionMode();
  if (envMode === MODE_SUSPECT) return "suspect";
  if (envMode === MODE_EXPLICIT) return "none";
  // Optional suspect mode: manual opt-in (env level, still beats argv).
  if (process.env.CLAWD_KIMI_PERMISSION_SUSPECT === "1") return "suspect";
  // Persistent mode switch baked into the hook command line by the installer
  // (legacy flavor defaults to `--permission-mode=suspect` since the
  // batched-approvals work — current kimi-cli never emits explicit permission
  // fields, so explicit-only was a cue that never fired).
  if (argvPermissionMode === MODE_SUSPECT) return "suspect";
  if (argvPermissionMode === MODE_EXPLICIT) return "none";
  // Default without any switch: explicit-only mode to avoid false positives
  // for long-running auto-approved tools (sleep/npm/network I/O). Kimi Code
  // installs carry no mode flag and land here by design.
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

  // Gate-ledger markers (legacy kimi-cli heuristic only). state.js keeps a
  // per-session ledger of outstanding permission-gated tool calls so batched
  // approvals (kimi-cli fires every queued PreToolUse up front) re-surface
  // the passive cue after each one is answered. Both classified PreToolUse
  // shapes open a gate — the suspect path on its raw PreToolUse, the
  // immediate path on the PermissionRequest it was rewritten into. Native
  // Kimi Code PermissionRequests never take the rewrite branch, so they stay
  // out of the ledger by construction. Gated PostToolUse/PostToolUseFailure
  // close a gate again, paired by tool_call_id when present, FIFO otherwise.
  if (classification === "suspect" || classification === "immediate") {
    body.permission_gate_open = true;
    const gateId = readToolCallId(payload);
    if (gateId) body.permission_gate_id = gateId;
  } else if (isGatedPostEvent(event, payload)) {
    body.permission_gated = true;
    const gateId = readToolCallId(payload);
    if (gateId) body.permission_gate_id = gateId;
  }

  // Permission context for the bubble. Native Kimi Code payloads carry a
  // human-readable action ("Running: echo hi") and a display block with the
  // real command; forward them so the bubble can show what actually needs
  // approval instead of the generic "check the Kimi terminal" line. A
  // synthesized PermissionRequest (rewritten PreToolUse) usually has neither
  // and degrades to tool_name only — but when its payload does carry
  // tool_input (immediate mode fires on the raw PreToolUse), the same
  // whitelist applies and the cue stays accurate. A gated suspect PreToolUse
  // forwards the same fields: state.js stores them in the gate ledger so the
  // re-armed cue after a batched approval shows the NEXT pending tool rather
  // than the generic line.
  //
  // Action/command/tool_name are clamped to the server's own limits
  // (trim().slice at 300/500, src/server-route-state.js): a heredoc Bash
  // call embeds the command in both action and display.command, and
  // unclamped they could push the body past the 16KB /state cap — that 413
  // is headerless and silently drops the whole notification. Clamps keep
  // realistic bodies well under the cap. The hooks that carry
  // assistant_last_output (clawd, codex) byte-fit via
  // fitStateBodyToByteBudget instead, but that helper only sacrifices
  // assistant_last_output, which this body never has, so deterministic
  // clamps are the fit here.
  if (event === "PermissionRequest" || event === "PermissionResult" || classification === "suspect") {
    const toolName = readToolName(payload).trim();
    if (toolName) body.tool_name = toolName.slice(0, 200);
    if (typeof payload.action === "string" && payload.action.trim()) {
      body.permission_action = payload.action.trim().slice(0, 300);
    }
    if (
      payload.display && typeof payload.display === "object"
      && typeof payload.display.command === "string" && payload.display.command.trim()
    ) {
      body.permission_command = payload.display.command.trim().slice(0, 500);
    }
    // Not on PermissionResult: it just clears the bubble — there is nothing
    // left to render a cue for.
    if (event === "PermissionRequest" || classification === "suspect") {
      const permissionToolInput = extractPermissionToolInput(payload.tool_input);
      if (permissionToolInput) body.permission_tool_input = permissionToolInput;
    }
    if (typeof payload.decision === "string" && payload.decision) {
      body.permission_decision = payload.decision;
    }
    // Rejected approval: upstream already fired PostToolUseFailure (it
    // arrives BEFORE PermissionResult on this path) and the pet played the
    // error one-shot. Pushing "working" now would overwrite that with a
    // running look while nothing is running. Keep the stored state and let
    // the event clear the permission hold; the model's follow-up events
    // (text, Stop) advance the state naturally. Approved keeps plain
    // "working" — the tool really is about to run.
    if (event === "PermissionResult" && payload.decision === "rejected") {
      body.preserve_state = true;
    }
  }

  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
    applyWslSourceFields(body, { remote: true });
  } else {
    applyWslSourceFields(body);
    const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = resolve();
    body.source_pid = stablePid;
    if (detectedEditor) body.editor = detectedEditor;
    if (agentPid) {
      body.agent_pid = agentPid;
      body.kimi_pid = agentPid;
    }
    if (pidChain.length) body.pid_chain = pidChain;
    if (tmuxSocket) body.tmux_socket = tmuxSocket;
    if (tmuxClient) body.tmux_client = tmuxClient;
  }

  return body;
}

function main() {
  const parsedArgv = parseHookArgv(process.argv.slice(2));
  if (parsedArgv.mode) setArgvPermissionMode(parsedArgv.mode);
  if (parsedArgv.ignoredFlags.length) {
    appendHookDebug({ at: new Date().toISOString(), ignored_flags: parsedArgv.ignoredFlags });
  }
  const eventFromArgv = parsedArgv.event;

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
  extractPermissionToolInput,
  readToolCallId,
  isGatedPostEvent,
  PERMISSION_GATE_ID_MAX_CHARS,
  PERMISSION_TOOLS,
  DEFAULT_PERMISSION_TOOLS,
  resolvePermissionTools,
  shouldRemapPreToolToPermission,
  classifyPreTool,
  isExplicitPermissionSignal,
  readToolName,
  hasKeywordPermissionSignal,
  readPermissionMode,
  parseHookArgv,
  setArgvPermissionMode,
  MODE_EXPLICIT,
  MODE_SUSPECT,
  readHookDebugMaxBytes,
  appendHookDebug,
  DEFAULT_HOOK_DEBUG_MAX_BYTES,
};
