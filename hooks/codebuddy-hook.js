#!/usr/bin/env node
// Clawd — CodeBuddy hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.codebuddy/settings.json by hooks/codebuddy-install.js
// CodeBuddy uses Claude Code-compatible hook format with identical event names.

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

// CodeBuddy hook event → { state, event } for the Clawd state machine
const HOOK_MAP = {
  SessionStart:     { state: "idle",         event: "SessionStart" },
  SessionEnd:       { state: "sleeping",     event: "SessionEnd" },
  UserPromptSubmit: { state: "thinking",     event: "UserPromptSubmit" },
  PreToolUse:       { state: "working",      event: "PreToolUse" },
  PostToolUse:      { state: "working",      event: "PostToolUse" },
  Stop:             { state: "attention",    event: "Stop" },
  // PermissionRequest: handled by HTTP hook (blocking), not this command hook
  Notification:     { state: "notification", event: "Notification" },
  PreCompact:       { state: "sweeping",     event: "PreCompact" },
};

// #634: lifecycle for the shared resolver's cross-process pid cache. Stop is
// deliberately NOT "end" (turn completion, not session end — dropping the
// cache there would force a fresh snapshot flash on the next tool event).
const EVENT_TO_LIFECYCLE = {
  SessionStart: "start",
  UserPromptSubmit: "prompt",
  SessionEnd: "end",
};

// Session title handling mirrors the MiniMax hook: CodeBuddy reports no
// guaranteed session title, so the HUD falls back to the first prompt line.
// Truncation counts Unicode code points and includes the ellipsis in the limit,
// so it never splits a surrogate pair. An input that already contains an
// isolated surrogate is passed through as-is; this helper does not repair it.
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;
const PROMPT_TITLE_MAX = 40;
const PROMPT_TITLE_SECRET_RE =
  /\b(api[_-]?key|authorization|bearer|password|passwd|private[_-]?key|secret|token)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/=_-]{32,}/i;

function truncateTitle(text, maxLength) {
  const points = Array.from(text);
  return points.length > maxLength
    ? `${points.slice(0, maxLength - 1).join("")}\u2026`
    : text;
}

function normalizeTitle(value, maxLength = SESSION_TITLE_MAX) {
  if (typeof value !== "string") return null;
  const collapsed = value
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  return truncateTitle(collapsed, maxLength);
}

function looksSecretishPromptTitle(value) {
  return typeof value === "string" && PROMPT_TITLE_SECRET_RE.test(value);
}

function extractPromptTitle(prompt) {
  if (typeof prompt !== "string") return null;
  for (const line of prompt.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    // Judge the complete first prompt line before truncation, and never fall
    // through to the next line once it looks like a secret.
    if (looksSecretishPromptTitle(candidate)) return null;
    return normalizeTitle(candidate, PROMPT_TITLE_MAX);
  }
  return null;
}

// Return the title and whether it came from the prompt in the same decision, so
// the wire marker can never disagree with the chosen title. A native title that
// cleans down to nothing (for example control characters only) falls through to
// the prompt and is then marked as prompt-derived.
function resolveSessionTitle(payload, event) {
  if (!payload || typeof payload !== "object") return { title: null, fromPrompt: false };
  const sessionTitle = normalizeTitle(payload.session_title);
  if (sessionTitle) return { title: sessionTitle, fromPrompt: false };
  if (event === "UserPromptSubmit") {
    const title = extractPromptTitle(payload.prompt);
    return { title, fromPrompt: !!title };
  }
  return { title: null, fromPrompt: false };
}

// Session metadata shared by IDE and CLI hooks. CodeBuddy 5.x IDE reports
// client: "CodeBuddyIDE" while a bare CLI reports "CLI"; the marker is kept
// sticky by the state machine so later tool/Stop events keep the focus carrier.
function attachSessionMetadata(hookName, payload, body) {
  const codebuddyClient = payload && typeof payload.client === "string"
    ? payload.client.trim()
    : "";
  if (codebuddyClient) body.codebuddy_client = codebuddyClient;
  const { title, fromPrompt } = resolveSessionTitle(payload, hookName);
  if (title) {
    body.session_title = title;
    body.session_title_from_prompt = fromPrompt;
  }
  if (payload && typeof payload.transcript_path === "string" && payload.transcript_path.trim()) {
    body.transcript_path = payload.transcript_path.trim();
  }
  return body;
}

const config = getPlatformConfig({
  extraTerminals: { win: ["codebuddy.exe"] },
  extraEditors: {
    win: { "codebuddy.exe": "codebuddy" },
    mac: { "codebuddy": "codebuddy" },
    linux: { "codebuddy": "codebuddy" },
  },
  extraEditorPathChecks: [["codebuddy", "codebuddy"]],
});
// The CodeBuddy 5.x IDE runs its hooks under the bundled agent runtime
// (`agent-harness.exe`, parent of the hook's shell) on Windows, never under a
// process called codebuddy.exe; the stand-alone CLI keeps codebuddy.exe. Without
// a live agent PID the Windows PID cache is never written, so every
// UserPromptSubmit (cache-only by design) reaches Clawd without a source PID and
// a freshly started conversation cannot be focused until its first tool event.
// agent-harness.exe lives for the IDE's chat session, the same lifetime the
// cache needs; it is not a terminal, so terminal-first anchoring is unchanged.
const CODEBUDDY_AGENT_NAMES = Object.freeze({
  win: new Set(["codebuddy.exe", "agent-harness.exe"]),
  mac: new Set(["codebuddy"]),
  linux: new Set(["codebuddy"]),
});
let runtimeContext = Object.freeze({
  identity: { ok: false, reason: "not-observed", port: null, ownerPid: null },
  observation: null,
});
const resolve = createPidResolver({
  agentNames: CODEBUDDY_AGENT_NAMES,
  platformConfig: config,
  readRuntimeIdentity: () => runtimeContext.identity,
});

// This command hook only reports state: it answers `{}` for every event and
// never makes a tool or permission decision. Approvals go through the separate
// blocking PermissionRequest HTTP hook. This follows the no-decision policy the
// WorkBuddy hook adopted in PR #618, where an explicit PreToolUse allow could
// bypass the product's own permission UI.
function stdoutForEvent() {
  return "{}";
}

// Safety timeout: guarantee valid JSON on stdout even if stdin never arrives
// or the process tree walk hangs. Without this CodeBuddy would see empty stdout
// which is invalid JSON and logs an error on every hook invocation.
const SAFETY_TIMEOUT_MS = 800;
// Once stdout has been answered, the 800ms guard above has served its purpose.
// The fire-and-forget POST to Clawd still needs the process alive to leave the
// socket: on Windows the synchronous process-tree snapshot alone takes ~1.5s,
// so an overdue safety timer firing right after the walk would process.exit()
// before the POST completed and the session state would never reach Clawd
// (same failure class as the WorkBuddy hook fix). After answering stdout we
// re-arm a generous backstop whose only job is to reap a truly hung process;
// the POST's own 100ms timeout settles the normal path in well under that.
const POST_EXIT_BACKSTOP_MS = 5000;
let _wrote = false;
let _exited = false;
let safetyTimer = null;

// Write the stdout response exactly once. Kept separate from process exit so the
// hook can answer CodeBuddy immediately yet still let the fire-and-forget POST
// to Clawd leave the process before it exits.
function writeStdoutOnce(outLine) {
  if (_wrote) return;
  _wrote = true;
  process.stdout.write(outLine + "\n");
  if (!_exited && safetyTimer) {
    clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => finish(outLine), POST_EXIT_BACKSTOP_MS);
  }
}

function finish(outLine) {
  writeStdoutOnce(outLine);
  if (_exited) return;
  _exited = true;
  if (safetyTimer) clearTimeout(safetyTimer);
  process.exit(0);
}


function run() {
  safetyTimer = setTimeout(() => finish("{}"), SAFETY_TIMEOUT_MS);

  readStdinJson()
    .then((payload) => {
      const hookName = (payload && payload.hook_event_name) || "";
      const mapped = HOOK_MAP[hookName];
      const outLine = stdoutForEvent();

      if (!mapped) {
        finish(outLine);
        return;
      }

      const { state, event } = mapped;

      // Write stdout before the synchronous process-tree walk (which can take
      // ~1.5s on Windows), then continue the POST. writeStdoutOnce re-arms the
      // exit backstop for the POST, so answering early does not lose state.
      writeStdoutOnce(outLine);

      const remote = !!process.env.CLAWD_REMOTE;
      if (!remote && process.platform === "win32") {
        runtimeContext = readWindowsProcessChainHookContext("codebuddy");
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
          namespace: "codebuddy",
          sessionId,
          cacheCwd: cwd,
          lifecycle: EVENT_TO_LIFECYCLE[hookName] || "event",
          cacheable: sessionId !== "default" && !!cwd,
        });
      const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = pidMetadata;

      const body = { state, session_id: sessionId, event };
      body.agent_id = "codebuddy";
      if (cwd) body.cwd = cwd;
      attachSessionMetadata(hookName, payload, body);
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

      // Stdout was already answered above; don't exit yet — the
      // fire-and-forget POST below still needs to leave the process, so we
      // exit in its callback (with the re-armed backstop timer as last resort).
      const postOptions = { timeoutMs: 100 };
      if (serverProcessChainEnabled) {
        postOptions.preferredPort = runtimeObservation.port;
        postOptions.runtimePort = runtimeObservation.port;
        postOptions.windowsProcessChain = {
          agentId: "codebuddy",
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
}

if (require.main === module) {
  run();
}

module.exports = {
  CODEBUDDY_AGENT_NAMES,
  normalizeTitle,
  extractPromptTitle,
  resolveSessionTitle,
  attachSessionMetadata,
  SESSION_TITLE_MAX,
  PROMPT_TITLE_MAX,
};
