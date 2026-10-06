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

// WorkBuddy's own lifecycle chatter, not a blocked request for the user.
// `idle_prompt` is a "send another message" reminder (observed on 5.2.6,
// ~60 seconds after Stop; 5.6.2's per-turn host exits before it can fire, so it
// was not observed there) and `auth_success` is the login-success toast (5.6.2,
// emitted at the start of every turn). Forwarding either would create or settle
// a session — a phantom idle row before the first UserPromptSubmit, or knocking
// a running turn back to idle. Real permission/input prompts and untyped legacy
// notifications still follow the native-control path in run().
const IGNORED_NOTIFICATION_TYPES = new Set(["idle_prompt", "auth_success"]);

function getWorkBuddyPlatformConfig(factory = getPlatformConfig) {
  return factory({
    extraTerminals: { win: ["workbuddy.exe"] },
    extraEditors: {
      win: { "workbuddy.exe": "workbuddy" },
      mac: { "workbuddy": "workbuddy" },
      linux: { "workbuddy": "workbuddy" },
    },
    extraEditorPathChecks: [["workbuddy", "workbuddy"]],
  });
}

const WORKBUDDY_AGENT_NAMES = Object.freeze({
  // Every Windows WorkBuddy role runs the same WorkBuddy.exe, so no process
  // NAME can single out the long-lived GUI main process. It is identified by
  // command line (isWorkBuddyMainProcessCommand) instead of by name.
  win: new Set(),
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

// Windows WorkBuddy 5.6.x runs each turn in a short-lived, prewarmed host
// ("...\app.asar.unpacked\cli\bin\codebuddy" --prewarm) that exits a few
// seconds after Stop, and its daemon, sidecar, edge-sync connector, and 5.2.6
// conversation processes all execute scripts out of app.asar / app.asar.unpacked
// too. The GUI main process is the only WorkBuddy.exe that runs no app.asar
// script and carries no Chromium --type= role switch, and it lives exactly as
// long as the app. Anchor agent_pid there so a finished turn is not retired by
// agent-exit when its per-turn host goes away. An empty/unreadable command line
// is deliberately "not the main process": no agent_pid is better than crediting
// the per-turn host.
function isWorkBuddyMainProcessCommand(commandLine) {
  const normalized = String(commandLine || "").replace(/\\/g, "/").toLowerCase();
  if (!normalized.trim()) return false;
  if (normalized.includes("app.asar")) return false;
  // Chromium role switches can arrive as a bare argument or as a whole quoted
  // argument (`"--type=renderer"` on Windows).
  if (/(^|[\s"])--type=/.test(normalized)) return false;
  return true;
}

// The resolver picks its platform at construction time, so the command-line
// predicate is selected here too. Tests pass an explicit platform to exercise
// both branches against the same options shape the hook ships.
function getWorkBuddyPidResolverOptions(platformConfig, platform = process.platform) {
  return {
    agentNames: WORKBUDDY_AGENT_NAMES,
    agentCmdlineCheck: platform === "win32"
      ? isWorkBuddyMainProcessCommand
      : isWorkBuddyCliCommand,
    // Replaces DEFAULT_AGENT_CMDLINE_NAMES. On macOS `electron` is the CLI host
    // name; on Windows every WorkBuddy role is the same `workbuddy.exe`, so the
    // command-line predicate (not the name) picks out the main process.
    agentCmdlineNames: new Set(["electron", "workbuddy.exe"]),
    platformConfig,
  };
}

const resolve = createPidResolver(getWorkBuddyPidResolverOptions(getWorkBuddyPlatformConfig()));

// State-only integration: never make a tool or permission decision. WorkBuddy's
// hook contract treats an empty JSON object as "continue with the native flow";
// an explicit allow can bypass the product permission UI.
function stdoutForEvent() {
  return "{}";
}

const SESSION_TITLE_MAX = 60;
// Check the complete fallback line before truncating it (same policy as Claude).
const PROMPT_TITLE_SECRET_RE = /\b(api[_-]?key|authorization|bearer|password|passwd|private[_-]?key|secret|token)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/=_-]{32,}/i;

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
        if (PROMPT_TITLE_SECRET_RE.test(candidate)) return null;
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
// Once stdout has been answered, the 800ms guard above has served its purpose.
// The fire-and-forget POST to Clawd still needs the process alive to leave the
// socket: on Windows the synchronous process-tree snapshot alone takes ~1.5s,
// so an overdue safety timer firing right after the walk would process.exit()
// before the POST completed and the session state would never reach Clawd
// (pet never reacts even though hooks fire). After answering stdout we re-arm
// a generous backstop whose only job is to reap a truly hung process; the
// POST's own 100ms timeout settles the normal path in well under that.
const POST_EXIT_BACKSTOP_MS = 5000;
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

      // Only WorkBuddy's own lifecycle notifications are swallowed here (see
      // IGNORED_NOTIFICATION_TYPES); real permission/input prompts and untyped
      // legacy notifications still follow the native-control path below.
      if (hookName === "Notification" && IGNORED_NOTIFICATION_TYPES.has(payload.notification_type)) {
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

      // Answer WorkBuddy before the process-tree walk: the walk is synchronous
      // and takes ~1.5s on Windows, which would otherwise delay the gate
      // response on every event. The POST below still runs to completion
      // afterwards — writeStdoutOnce re-arms the exit backstop for exactly
      // that — so no state is lost by answering early.
      writeStdoutOnce(outLine);

      if (hookName === "SessionStart" && !process.env.CLAWD_REMOTE) resolve();

      const cwd = (payload && payload.cwd) || "";

      const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = resolve();

      const body = { state, session_id: sessionId, event };
      body.agent_id = "workbuddy";
      if (cwd) body.cwd = cwd;

      // WorkBuddy 5.6.x delivers UserPromptSubmit ~0.1s BEFORE SessionStart on
      // every turn (SessionStart source is "startup" on the first turn and
      // "resume" afterwards). SessionStart maps to idle, so without
      // preserve_state that late event would flip the just-started turn back to
      // idle and the HUD would read "idle" until the next event.
      if (hookName === "SessionStart") body.preserve_state = true;

      const sessionTitle = deriveSessionTitle(hookName, payload);
      if (sessionTitle) {
        body.session_title = sessionTitle;
        // A later prompt must not overwrite a native or explicitly named chat.
        body.session_title_from_prompt = !(typeof payload.session_title === "string"
          && payload.session_title.trim());
      }
      if (typeof payload.transcript_path === "string" && payload.transcript_path.trim()) {
        body.transcript_path = payload.transcript_path.trim();
      }

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

      // Stdout was already answered above; don't exit yet — the
      // fire-and-forget POST below still needs to leave the process, so we
      // exit in its callback (with the re-armed backstop timer as last resort).
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
  IGNORED_NOTIFICATION_TYPES,
  isWorkBuddyCliCommand,
  isWorkBuddyMainProcessCommand,
  getWorkBuddyPlatformConfig,
  getWorkBuddyPidResolverOptions,
};
