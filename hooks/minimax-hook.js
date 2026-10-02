#!/usr/bin/env node
// Clawd — MiniMax Code hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Deployed as the local plugin ~/.minimax/plugins/clawd-state/ by hooks/minimax-install.js
// MiniMax Code parses plugin hook documents in the Claude Code-compatible format
// (sourceFormat CLAUDE) and feeds hooks a snake_case Claude-compatible stdin payload.

const {
  postStateToRunningServer,
  readHostPrefix,
  applyWslSourceFields,
} = require("./server-config");
const {
  createPidResolver,
  readStdinJson,
  getPlatformConfig,
  applyOrcaPaneKey,
} = require("./shared-process");

// MiniMax hook event → { state, event } for the Clawd state machine.
// PermissionRequest is deliberately not registered (see agents/minimax.js):
// the plugin-hook runner's 1–10s timeout budget makes blocking approval
// impossible, so MiniMax keeps its native permission flow.
const HOOK_MAP = {
  SessionStart:     { state: "idle",      event: "SessionStart" },
  SessionEnd:       { state: "sleeping",  event: "SessionEnd" },
  UserPromptSubmit: { state: "thinking",  event: "UserPromptSubmit" },
  PreToolUse:       { state: "working",   event: "PreToolUse" },
  PostToolUse:      { state: "working",   event: "PostToolUse" },
  Stop:             { state: "attention", event: "Stop" },
  SubagentStart:    { state: "juggling",  event: "SubagentStart" },
  SubagentStop:     { state: "working",   event: "SubagentStop" },
  PreCompact:       { state: "sweeping",  event: "PreCompact" },
  // PostCompact is "compaction finished", not turn completion (#406, same rule
  // as the Claude Code adapter): an automatic compaction resumes the task, so
  // stay busy; main() settles a manual compaction (trigger "manual") to idle.
  PostCompact:      { state: "thinking",  event: "PostCompact" },
};

// Lifecycle for the shared resolver's cross-process pid cache. Stop is
// deliberately NOT "end" (turn completion, not session end — dropping the
// cache there would force a fresh snapshot flash on the next tool event).
const EVENT_TO_LIFECYCLE = {
  SessionStart: "start",
  UserPromptSubmit: "prompt",
  SessionEnd: "end",
};

// Session title handling — MiniMax's documented hook input carries session_id,
// cwd, model and prompt metadata but no session title field. The HUD title is
// derived from the first line of the user's prompt, mirroring the traecode
// hook's extractPromptTitle. The server keeps the first successful title per
// minimax session (state.js first-wins), so follow-up prompts never overwrite it.
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

function resolveSessionTitle(payload, event) {
  if (!payload || typeof payload !== "object") return null;
  const sessionTitle = normalizeTitle(payload.session_title);
  if (sessionTitle) return sessionTitle;
  if (event === "UserPromptSubmit") {
    return extractPromptTitle(payload.prompt);
  }
  return null;
}

// The resolver compares lowercased process basenames (normalizePosixProcessName
// and the Windows snapshot both lowercase), so every entry must be lowercase —
// a mixed-case name can never match. The mcode CLI retitles itself at startup
// (`process.title = "minimax-code"`), which on macOS and Linux is the process
// name `ps -o comm=` reports, so that is the name to match there. The desktop
// app's "MiniMax Code Helper" processes are deliberately absent: hooks are
// spawned by a NodeService helper that can restart while the app keeps
// running, and an agent pid that dies with it would retire live sessions. The
// walk continues to the long-lived main "MiniMax Code" process instead.
const AGENT_NAMES = {
  win: ["minimax code.exe", "mcode.exe"],
  mac: ["minimax code", "minimax-code", "mcode"],
  linux: ["minimax-code", "mcode", "minimax code"],
};

// Split a command line into argv-like tokens. Only double quotes group: that is
// CommandLineToArgvW's rule on Windows (where process snapshots quote each
// path), while POSIX `ps` output is unquoted and carries quote characters
// literally. Treating single quotes as grouping would swallow a path that
// contains an apostrophe (e.g. /Users/o'brien/...) into one bogus token. An
// unquoted path with spaces is split and simply fails to match — that loses one
// match and falls back to the previous behavior rather than matching something
// else.
function splitCommandLine(cmd) {
  const tokens = [];
  let current = "";
  let inQuote = false;
  let hasToken = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (inQuote) {
      if (ch === "\"") inQuote = false;
      else current += ch;
      hasToken = true;
      continue;
    }
    if (ch === "\"") {
      inQuote = true;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

// Node options that consume the following token as their value, so the script
// search must skip both.
const NODE_OPTIONS_WITH_VALUE = new Set([
  "-r", "--require", "--import", "--loader", "--experimental-loader",
  "-C", "--conditions", "--title", "--env-file", "--input-type", "--disable-warning",
]);
const MINIMAX_LAUNCHER_RE = /^(mcode|minimax-code)(\.(c?js|mjs|cmd|ps1|exe))?$/;
const NODE_EXEC_RE = /^node(\.exe)?$/;

function commandBasename(token) {
  return token.replace(/\\/g, "/").split("/").pop().toLowerCase();
}

// Where the CLI still runs under a node / node.exe image name (Windows, where
// process.title only changes the console title), recognize it by command line:
// the launcher itself, the npm package directory (`/@minimax-ai/code/`), or the
// official installer's `.minimax-code` directory — but only where a script
// argument sits, never from an arbitrary option value or later argument. Without
// an agent pid Clawd cannot tell when the CLI exits — MiniMax sends no SessionEnd
// on exit — and the session row would outlive it as long as the terminal is open.
function isMinimaxAgentCommandLine(cmd) {
  if (typeof cmd !== "string") return false;
  const tokens = splitCommandLine(cmd.trim());
  if (tokens.length === 0) return false;

  const first = commandBasename(tokens[0]);
  if (MINIMAX_LAUNCHER_RE.test(first)) return true;
  if (!NODE_EXEC_RE.test(first)) return false;

  // Find the script argument after node's own options.
  let script = null;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "-e" || token === "--eval" || token === "-p" || token === "--print" || token === "-") {
      return false;
    }
    if (token === "--") {
      script = i + 1 < tokens.length ? tokens[i + 1] : null;
      break;
    }
    if (NODE_OPTIONS_WITH_VALUE.has(token)) {
      i += 2;
      continue;
    }
    if (token.startsWith("-")) {
      i += 1;
      continue;
    }
    script = token;
    break;
  }
  if (!script) return false;

  if (MINIMAX_LAUNCHER_RE.test(commandBasename(script))) return true;
  const normalizedScript = script.replace(/\\/g, "/").toLowerCase();
  return normalizedScript.includes("/@minimax-ai/code/")
    || normalizedScript.includes("/.minimax-code/");
}

const config = getPlatformConfig({});
const RESOLVER_OPTIONS = {
  agentNames: {
    win: new Set(AGENT_NAMES.win),
    mac: new Set(AGENT_NAMES.mac),
    linux: new Set(AGENT_NAMES.linux),
  },
  agentCmdlineCheck: isMinimaxAgentCommandLine,
  platformConfig: config,
};
const resolve = createPidResolver(RESOLVER_OPTIONS);

// This integration is state-only and does not own permission decisions, so
// every event emits {} — for MiniMax's wire contract an empty output means
// permissionDecision defaults to abstain and the native flow proceeds.

// Safety timeout: guarantee valid JSON on stdout even if stdin never arrives
// or the process tree walk hangs. Without this MiniMax would see empty stdout,
// which is invalid JSON and logs an error on every hook invocation.
const SAFETY_TIMEOUT_MS = 800;

// Everything that runs the real hook lifecycle — reading stdin, arming the
// safety timer, answering MiniMax on stdout, the fire-and-forget POST to
// Clawd, and process exit — lives inside main(), which only runs when this
// file is the entry point. Importing the module for tests must not read stdin,
// arm timers, write stdout, or exit.
function main(deps = {}) {
  const readStdin = deps.readStdinJson || readStdinJson;
  const postState = deps.postState || postStateToRunningServer;
  let _wrote = false;
  let _exited = false;
  let safetyTimer = null;

  // Write the stdout response exactly once. Kept separate from process exit so
  // the hook can answer MiniMax immediately yet still let the fire-and-forget
  // POST to Clawd leave the process before it exits. Exit in the write callback
  // so a pipe-backed stdout actually flushes before the process terminates.
  function writeStdoutOnce(outLine, done) {
    if (_wrote) {
      if (done) done();
      return;
    }
    _wrote = true;
    process.stdout.write(outLine + "\n", () => {
      if (done) done();
    });
  }

  function finish(outLine) {
    if (_exited) return;
    _exited = true;
    if (safetyTimer) clearTimeout(safetyTimer);
    writeStdoutOnce(outLine, () => process.exit(0));
  }

  // MiniMax session ids are namespaced with the agent prefix so they cannot
  // collide with other agents' sessions. A bare missing id must not collapse
  // every hook invocation into one phantom "default" session — drop the event
  // when it is absent, because a hook without a session cannot be attributed.
  function normalizeSessionId(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw || raw === "default") return "";
    return `minimax:${raw}`;
  }

  safetyTimer = setTimeout(() => finish("{}"), SAFETY_TIMEOUT_MS);

  readStdin()
    .then((payload) => {
      const hookName = (payload && payload.hook_event_name) || "";
      const mapped = HOOK_MAP[hookName];
      const outLine = "{}";

      if (!mapped) {
        finish(outLine);
        return;
      }

      const { state, event } = mapped;
      const remote = !!process.env.CLAWD_REMOTE;
      if (hookName === "SessionStart" && !remote) resolve();

      const sessionId = normalizeSessionId(payload && payload.session_id);
      const cwd = (payload && typeof payload.cwd === "string") ? payload.cwd : "";
      // No session id means the event cannot be attributed to any session —
      // answer MiniMax immediately and skip the POST rather than collapsing
      // into a phantom "default" session on the server.
      if (!sessionId) {
        finish(outLine);
        return;
      }

      const pidMetadata = resolve({
        namespace: "minimax",
        sessionId,
        cacheCwd: cwd,
        lifecycle: EVENT_TO_LIFECYCLE[hookName] || "event",
        cacheable: !!cwd,
      });
      const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = pidMetadata;

      const resolvedState = hookName === "PostCompact" && payload && payload.trigger === "manual"
        ? "idle"
        : state;
      const body = { state: resolvedState, session_id: sessionId, event };
      body.agent_id = "minimax";
      if (cwd) body.cwd = cwd;
      const resolvedTitle = resolveSessionTitle(payload, event);
      if (resolvedTitle) body.session_title = resolvedTitle;
      if (remote) {
        body.host = readHostPrefix();
        applyWslSourceFields(body, { remote: true });
        applyOrcaPaneKey(body);
      } else {
        applyWslSourceFields(body);
        body.source_pid = stablePid;
        if (detectedEditor) body.editor = detectedEditor;
        if (agentPid) body.agent_pid = agentPid;
        if (Array.isArray(pidChain) && pidChain.length) body.pid_chain = pidChain;
        if (tmuxSocket) body.tmux_socket = tmuxSocket;
        if (tmuxClient) body.tmux_client = tmuxClient;
        applyOrcaPaneKey(body);
      }

      // Answer MiniMax immediately so it never sees empty stdout, but don't
      // exit yet — the fire-and-forget POST below still needs to leave the
      // process, so we exit in its callback (with the safety timer as backstop).
      writeStdoutOnce(outLine);

      postState(JSON.stringify(body), { timeoutMs: 100 }, () => {
        finish(outLine);
      });
    })
    .catch(() => finish("{}"));
}

if (require.main === module) {
  main();
}

module.exports = {
  __test: {
    AGENT_NAMES,
    RESOLVER_OPTIONS,
    isMinimaxAgentCommandLine,
    splitCommandLine,
    resolveSessionTitle,
    extractPromptTitle,
    normalizeTitle,
    main,
  },
};
