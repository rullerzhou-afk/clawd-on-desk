#!/usr/bin/env node
// Clawd — TraeCode hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.trae-cn/hooks.json by hooks/traecode-install.js
// TraeCode uses Claude Code-compatible hook format with identical event names.

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
const { claimTitle, sweepStaleMarkers } = require("./traecode-title-lock");

// TraeCode hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  SessionStart:     { state: "idle",         event: "SessionStart" },
  UserPromptSubmit: { state: "thinking",     event: "UserPromptSubmit" },
  PreToolUse:       { state: "working",      event: "PreToolUse" },
  PostToolUse:      { state: "working",      event: "PostToolUse" },
  Stop:             { state: "attention",    event: "Stop" },
  // Notification: async, never blocks the main flow
  Notification:     { state: "notification", event: "Notification" },
};

// #634: lifecycle for the shared resolver's cross-process pid cache. Stop is
// deliberately NOT "end" (turn completion, not session end — dropping the
// cache there would force a fresh snapshot flash on the next tool event).
const EVENT_TO_LIFECYCLE = {
  SessionStart: "start",
  UserPromptSubmit: "prompt",
};

// Session title handling — Trae sends no session_title field (verified live:
// SessionStart/UserPromptSubmit payloads carry only session_id, cwd,
// workspace_roots). The HUD title is therefore derived from the first line of
// the user's prompt, mirroring the claude-code hook's extractPromptTitle.
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;
const PROMPT_TITLE_MAX = 40;
const PROMPT_TITLE_SECRET_RE =
  /\b(api[_-]?key|authorization|bearer|password|passwd|private[_-]?key|secret|token)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/=_-]{32,}/i;

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = value
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  return collapsed.length > SESSION_TITLE_MAX
    ? `${collapsed.slice(0, SESSION_TITLE_MAX - 1)}…`
    : collapsed;
}

function normalizeTitleWithMax(value, maxLen) {
  const title = normalizeTitle(value);
  if (!title || title.length <= maxLen) return title;
  return `${title.slice(0, maxLen - 1)}…`;
}

function looksSecretishPromptTitle(value) {
  return typeof value === "string" && PROMPT_TITLE_SECRET_RE.test(value);
}

function extractPromptTitle(prompt) {
  if (typeof prompt !== "string") return null;
  for (const line of prompt.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (looksSecretishPromptTitle(candidate)) return null;
    return normalizeTitleWithMax(candidate, PROMPT_TITLE_MAX);
  }
  return null;
}

// Trae sends no session_title field (verified live against the running IDE),
// so the HUD title is derived from the first line of the user's prompt on
// UserPromptSubmit — showing the task instead of the project folder name.
function resolveSessionTitle(payload, event) {
  if (!payload || typeof payload !== "object") return null;
  const sessionTitle = normalizeTitle(payload.session_title);
  if (sessionTitle) return sessionTitle;
  if (event === "UserPromptSubmit") {
    return extractPromptTitle(payload.prompt);
  }
  return null;
}

const config = getPlatformConfig({
  // Trae CN ships as "Trae CN.exe" (process name lowercased to "trae cn.exe"
  // by the Windows process snapshot); the international build is "Trae.exe".
  // Cover both spellings plus a space-less variant.
  extraTerminals: { win: ["trae.exe", "trae cn.exe", "traecn.exe"] },
  extraEditors: {
    win: { "trae.exe": "trae", "trae cn.exe": "trae", "traecn.exe": "trae" },
    mac: { "Trae": "trae", "trae": "trae" },
    linux: { "trae": "trae", "Trae": "trae" },
  },
  extraEditorPathChecks: [["trae", "trae"]],
});
let runtimeContext = Object.freeze({
  identity: { ok: false, reason: "not-observed", port: null, ownerPid: null },
  observation: null,
});
const resolve = createPidResolver({
  agentNames: { win: new Set(["trae.exe", "trae cn.exe", "traecn.exe"]), mac: new Set(["Trae", "trae"]), linux: new Set(["trae", "Trae"]) },
  platformConfig: config,
  readRuntimeIdentity: () => runtimeContext.identity,
});

// TraeCode PreToolUse gating — allow by default
function stdoutForEvent(hookName) {
  if (hookName === "PreToolUse") return JSON.stringify({ decision: "allow" });
  return "{}";
}

// Safety timeout: guarantee valid JSON on stdout even if stdin never arrives
// or the process tree walk hangs. Without this TraeCode would see empty stdout
// which is invalid JSON and logs an error on every hook invocation.
const SAFETY_TIMEOUT_MS = 800;
let _wrote = false;
let _exited = false;
let safetyTimer = null;

// Write the stdout response exactly once. Kept separate from process exit so the
// hook can answer TraeCode immediately yet still let the fire-and-forget POST
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
    const remote = !!process.env.CLAWD_REMOTE;
    if (!remote && process.platform === "win32") {
      runtimeContext = readWindowsProcessChainHookContext("traecode");
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
    if (hookName === "SessionStart" && !remote && !authoritativeProcessChain) resolve();

    const sessionId = (payload && payload.session_id) || "default";
    const cwd = (payload && payload.cwd) || "";

    const pidMetadata = authoritativeProcessChain ? {} : resolve({
        namespace: "traecode",
        sessionId,
        cacheCwd: cwd,
        lifecycle: EVENT_TO_LIFECYCLE[hookName] || "event",
        cacheable: sessionId !== "default" && !!cwd,
      });
    const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = pidMetadata;

    const body = { state, session_id: sessionId, event };
    body.agent_id = "traecode";
    if (cwd) body.cwd = cwd;
    // First prompt wins: claim the session title only once, so follow-up
    // prompts never overwrite it (matching Trae's constant session title).
    const resolvedTitle = resolveSessionTitle(payload, event);
    if (resolvedTitle) {
      const claimed = claimTitle("traecode", sessionId, cwd, resolvedTitle);
      if (claimed.claimed) {
        body.session_title = claimed.title;
        sweepStaleMarkers();
      }
    }
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

    // Answer TraeCode immediately so it never sees empty stdout, but don't
    // exit yet — the fire-and-forget POST below still needs to leave the
    // process, so we exit in its callback (with the safety timer as backstop).
    writeStdoutOnce(outLine);

    const postOptions = { timeoutMs: 100 };
    if (serverProcessChainEnabled) {
      postOptions.preferredPort = runtimeObservation.port;
      postOptions.runtimePort = runtimeObservation.port;
      postOptions.windowsProcessChain = {
        agentId: "traecode",
        hookPid: process.pid,
        runtimeObservation,
        legacyCacheSource: pidMetadata.cacheSource || "none",
      };
    }
    postStateToRunningServer(JSON.stringify(body), postOptions, () => {
      finish(outLine);
    });
  })
  .catch(() => finish("{}"));

module.exports = {
  __test: {
    resolveSessionTitle,
    extractPromptTitle,
    normalizeTitle,
  },
};
