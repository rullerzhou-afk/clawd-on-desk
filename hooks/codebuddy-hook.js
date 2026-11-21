#!/usr/bin/env node
// Clawd — CodeBuddy hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Registered in ~/.codebuddy/settings.json by hooks/codebuddy-install.js
// CodeBuddy uses Claude Code-compatible hook format with identical event names.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

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

// CodeBuddy 5.x IDE and CodeBuddy CLI share the same harness. The hook payload
// distinguishes them with client: "CodeBuddyIDE" vs "CLI" (bare CLI also omits
// agent_type). Forward it so Clawd can choose an app-window focus target for
// IDE conversations without confusing them with real terminal sessions.
const SESSION_TITLE_MAX = 60;
const PROMPT_TITLE_SECRET_RE = /\b(api[_-]?key|authorization|bearer|password|passwd|private[_-]?key|secret|token)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/=_-]{32,}/i;

function deriveSessionTitle(hookName, payload) {
  const rawTitle =
    payload && typeof payload.session_title === "string" ? payload.session_title.trim() : "";
  if (rawTitle) {
    return rawTitle.length > SESSION_TITLE_MAX
      ? rawTitle.slice(0, SESSION_TITLE_MAX - 1) + "\u2026"
      : rawTitle;
  }
  if (hookName === "UserPromptSubmit" && payload && typeof payload.prompt === "string") {
    for (const line of payload.prompt.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate) {
        if (PROMPT_TITLE_SECRET_RE.test(candidate)) return null;
        return candidate.length > SESSION_TITLE_MAX
          ? candidate.slice(0, SESSION_TITLE_MAX - 1) + "\u2026"
          : candidate;
      }
    }
  }
  return null;
}

// Identify the CodeBuddy distribution that owns the hook process. Both release
// and Insiders ship product.json next to the app bundle, so we can report the
// exact bundle to activate and, when that build implements /conversation/open,
// its system URL scheme without hard-coding install paths or protocol names.
function readCodeBuddyAppInfo(command, fsApi = fs) {
  const text = typeof command === "string" ? command : "";
  const marker = text.indexOf(".app/");
  if (marker < 1) return null;
  let dir = text.slice(0, marker + 4);
  for (let i = 0; i < 8 && dir; i++) {
    const appRoot = path.posix.join(dir, "Contents", "Resources", "app");
    try {
      const product = JSON.parse(fsApi.readFileSync(path.posix.join(appRoot, "product.json"), "utf8"));
      const value = product.urlProtocol;
      if (typeof value !== "string" || !value.trim()) {
        const parent = path.posix.dirname(dir);
        if (parent === dir) break;
        dir = parent;
        continue;
      }
      let urlScheme = null;
      try {
        const main = fsApi.readFileSync(path.posix.join(appRoot, "out", "main.js"), "utf8");
        if (main.includes("/conversation/open")) urlScheme = value.trim();
      } catch {}
      return { bundlePath: dir, urlScheme };
    } catch {}
    const parent = path.posix.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Session metadata shared by IDE and CLI hooks. CodeBuddy 5.x IDE reports
// client: "CodeBuddyIDE" while a bare CLI reports "CLI"; the marker is kept
// sticky by the state machine so later tool/Stop events keep the focus carrier.
function attachSessionMetadata(hookName, payload, body, { appInfo = null } = {}) {
  const codebuddyClient = payload && typeof payload.client === "string"
    ? payload.client.trim()
    : "";
  if (codebuddyClient) body.codebuddy_client = codebuddyClient;
  if (appInfo && appInfo.urlScheme) body.codebuddy_url_scheme = appInfo.urlScheme;
  if (appInfo && appInfo.bundlePath) body.codebuddy_app_bundle = appInfo.bundlePath;
  const sessionTitle = deriveSessionTitle(hookName, payload);
  if (sessionTitle) {
    body.session_title = sessionTitle;
    body.session_title_from_prompt = !(payload && typeof payload.session_title === "string"
      && payload.session_title.trim());
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
let runtimeContext = Object.freeze({
  identity: { ok: false, reason: "not-observed", port: null, ownerPid: null },
  observation: null,
});
const resolve = createPidResolver({
  agentNames: { win: new Set(["codebuddy.exe"]), mac: new Set(["codebuddy"]), linux: new Set(["codebuddy"]) },
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
      let appInfo = null;
      const isIdeHook = payload && typeof payload.client === "string"
        && payload.client.trim() === "CodeBuddyIDE";
      if (isIdeHook && !remote && process.platform === "darwin") {
        let ancestorPid = process.ppid;
        for (let depth = 0; depth < 6 && ancestorPid > 1 && !appInfo; depth++) {
          try {
            const ancestor = execFileSync("ps", ["-o", "comm=", "-p", String(ancestorPid)], { encoding: "utf8", timeout: 500 }).trim();
            appInfo = readCodeBuddyAppInfo(ancestor);
            ancestorPid = parseInt(execFileSync("ps", ["-o", "ppid=", "-p", String(ancestorPid)], { encoding: "utf8", timeout: 500 }).trim(), 10);
          } catch { break; }
        }
      }
      attachSessionMetadata(hookName, payload, body, { appInfo });
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
} else if (safetyTimer) {
  clearTimeout(safetyTimer);
  _exited = true;
}

module.exports = {
  HOOK_MAP,
  stdoutForEvent,
  deriveSessionTitle,
  attachSessionMetadata,
  readCodeBuddyAppInfo,
  SESSION_TITLE_MAX,
};
