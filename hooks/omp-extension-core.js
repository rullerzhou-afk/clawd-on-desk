"use strict";

// OMP (oh-my-pi) extension core.
//
// Structurally parallel to hooks/pi-extension-core.js — OMP is a fork of the
// same coding agent, so the extension API and the event vocabulary match. Three
// behaviours differ on purpose; each is noted where it happens.
//
// Like the Pi core, this module is copied verbatim into the installed extension
// directory, so it must stay dependency-free (Node builtins only, and not even
// those unless required).

const OMP_AGENT_ID = "omp";
const OMP_HOOK_SOURCE = "omp-extension";

// Kept in step with hooks/shared-process.js NESTED_TERMINAL_ENV; duplicated
// rather than imported because this module ships standalone in the extension.
const NESTED_TERMINAL_ENV = [
  "WT_SESSION",
  "ALACRITTY_WINDOW_ID",
  "WEZTERM_PANE",
  "KITTY_WINDOW_ID",
  "KONSOLE_VERSION",
  "GNOME_TERMINAL_SCREEN",
  "ConEmuPID",
  "TMUX",
  "STY",
  "ZELLIJ",
];

// Difference 1 vs the Pi core: completion is bound to `session_stop`, not
// `agent_end`. OMP fires `agent_end` at every agent-loop boundary, including
// scheduling pauses — background jobs still running, queued follow-ups, settles
// that left tool calls in flight — so reporting completion from it makes Clawd
// play the finish chime while the session is still working. `session_stop` is
// the settled turn: it never fires for task/subagent sessions and it defers
// until agent-owned background jobs are idle.
//
// Difference 2: `session_switch` and `session_branch` are reported. OMP can move
// an interactive session without a shutdown/start pair, and without these the
// entry in Clawd keeps pointing at the conversation the user left.
const DEFAULT_EVENT_BINDINGS = Object.freeze([
  Object.freeze(["session_start", "SessionStart", "idle"]),
  Object.freeze(["session_switch", "SessionStart", "idle"]),
  Object.freeze(["session_branch", "SessionStart", "idle"]),
  Object.freeze(["before_agent_start", "UserPromptSubmit", "thinking"]),
  Object.freeze(["session_stop", "Stop", "attention"]),
  Object.freeze(["session_before_compact", "PreCompact", "sweeping"]),
  Object.freeze(["session_compact", "PostCompact", "attention"]),
  Object.freeze(["session_shutdown", "SessionEnd", "sleeping"]),
]);

function parseMode(argv = process.argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p" || arg === "--print") return "print";
    if (arg === "--mode") {
      const value = args[i + 1];
      if (value === "print" || value === "json" || value === "rpc") return value;
    }
    if (typeof arg === "string" && arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value === "print" || value === "json" || value === "rpc") return value;
    }
  }
  return "interactive";
}

function isInteractiveMode(runtime = {}) {
  const mode = parseMode(runtime.argv || process.argv);
  if (mode !== "interactive") return false;
  const stdin = runtime.stdin || process.stdin;
  const stdout = runtime.stdout || process.stdout;
  return !!(stdin && stdin.isTTY && stdout && stdout.isTTY);
}

// Headless workers share the process with interactive sessions; only a session
// that owns a UI is a conversation a user can be sent back to.
function shouldReport(ctx, runtime = {}) {
  if (ctx && typeof ctx.hasUI === "boolean") return ctx.hasUI;
  return isInteractiveMode(runtime);
}

function safeString(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function safePositiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function safeCall(fn) {
  if (typeof fn !== "function") return null;
  try {
    return fn();
  } catch {
    return null;
  }
}

function readSessionId(ctx) {
  const manager = ctx && ctx.sessionManager;
  const candidates = [
    safeCall(manager && manager.getSessionId && manager.getSessionId.bind(manager)),
    safeCall(manager && manager.getSessionFile && manager.getSessionFile.bind(manager)),
  ];
  for (const candidate of candidates) {
    const value = safeString(candidate, "");
    if (value) return value;
  }
  return "default";
}

function basename(value) {
  const text = safeString(value, "");
  if (!text) return "";
  const parts = text.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : text;
}

// Difference 3: a title is always sent. Several interactive OMP sessions
// legitimately share one working directory, and Clawd falls back to the folder
// name — so without this the list (and every jump target in it) shows the same
// label several times over. OMP's own session name is preferred; the folder is
// only the fallback.
function readSessionTitle(ctx) {
  const manager = ctx && ctx.sessionManager;
  const named = safeString(
    safeCall(manager && manager.getSessionName && manager.getSessionName.bind(manager)),
    ""
  );
  const label = named || basename(ctx && ctx.cwd);
  return label ? `OMP · ${label}` : "OMP";
}

function addToolFields(payload, nativeEvent) {
  if (!nativeEvent || typeof nativeEvent !== "object") return;
  const toolName = safeString(nativeEvent.toolName, "");
  const toolCallId = safeString(nativeEvent.toolCallId, "");
  if (toolName) payload.tool_name = toolName;
  if (toolCallId) payload.tool_use_id = toolCallId;
}

function buildPayload(options = {}) {
  const ctx = options.ctx || {};
  const metadata = options.metadata || {};
  const payload = {
    agent_id: OMP_AGENT_ID,
    hook_source: OMP_HOOK_SOURCE,
    event: safeString(options.event, "SessionStart"),
    state: safeString(options.state, "idle"),
    session_id: `${OMP_AGENT_ID}:${readSessionId(ctx)}`,
    session_title: readSessionTitle(ctx),
  };

  const agentPid = safePositiveInteger(options.agentPid);
  if (agentPid) payload.agent_pid = agentPid;

  const cwd = safeString(metadata.cwd, "") || safeString(ctx.cwd, "");
  if (cwd) payload.cwd = cwd;

  const sourcePid = safePositiveInteger(metadata.sourcePid);
  if (sourcePid) payload.source_pid = sourcePid;

  const pidChain = Array.isArray(metadata.pidChain)
    ? metadata.pidChain.map(safePositiveInteger).filter(Boolean).slice(0, 12)
    : [];
  if (pidChain.length > 0) payload.pid_chain = pidChain;

  const tmuxSocket = typeof metadata.tmuxSocket === "string" && /^[\w.-]{1,64}$/.test(metadata.tmuxSocket)
    ? metadata.tmuxSocket : (
      typeof metadata.tmuxSocket === "string"
        && metadata.tmuxSocket.startsWith("/")
        && metadata.tmuxSocket.length <= 4096
        && !/[\0\r\n]/.test(metadata.tmuxSocket)
        ? metadata.tmuxSocket : null
    );
  if (tmuxSocket) payload.tmux_socket = tmuxSocket;

  const tmuxClient = typeof metadata.tmuxClient === "string"
    && metadata.tmuxClient.length <= 256
    && !metadata.tmuxClient.startsWith("-")
    && /^[\w./:-]+$/.test(metadata.tmuxClient)
    ? metadata.tmuxClient : null;
  if (tmuxClient) payload.tmux_client = tmuxClient;

  // Not resolver metadata: the extension runs in-process with the OMP CLI, so
  // Orca's pane key is simply in the env. Validated locally rather than
  // imported because this module ships standalone. See orcaPaneKeyFromEnv in
  // shared-process.js for the list and the residual gap.
  const env = options.env || process.env;
  const inOrcaPane = !!env && env.TERM_PROGRAM === "Orca" && !NESTED_TERMINAL_ENV.some((key) => env[key]);
  const rawPaneKey = inOrcaPane && typeof env.ORCA_PANE_KEY === "string"
    ? env.ORCA_PANE_KEY.trim() : null;
  const orcaPaneKey = rawPaneKey
    && rawPaneKey.length <= 256
    && /^[\w-]+:[\w-]+$/.test(rawPaneKey)
    ? rawPaneKey : null;
  if (orcaPaneKey) payload.orca_pane_key = orcaPaneKey;

  if (metadata.editor === "code" || metadata.editor === "cursor") {
    payload.editor = metadata.editor;
  }

  addToolFields(payload, options.nativeEvent);
  return payload;
}

function chainDelivery(chains, key, task) {
  const previous = chains.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task)
    .catch(() => {});
  chains.set(key, next);
  const cleanup = () => {
    if (chains.get(key) === next) chains.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

// Sessions deliver on independent chains, which is right for ordinary events:
// one slow session must not hold up another. A shutdown is different — it is
// the last thing the process will say. Awaiting only the shutting-down
// session's chain lets the process exit with another chain still queued,
// including the synthetic SessionEnd for the conversation this terminal
// switched away from, which lives on the *old* session's chain. Clawd would
// then keep a live row for a session nothing will ever report on again. So the
// shutdown awaits every tail the extension still owes. Tails are read after
// the shutdown itself is enqueued, and each tail already carries its own
// predecessors.
function drainDeliveries(chains) {
  return Promise.all([...new Set(chains.values())]).then(() => undefined);
}

function attach(omp, deps = {}) {
  if (!omp || typeof omp.on !== "function") {
    throw new Error("OMP extension API missing on()");
  }

  const shouldReportFn = typeof deps.shouldReport === "function" ? deps.shouldReport : shouldReport;
  const buildPayloadFn = typeof deps.buildPayload === "function" ? deps.buildPayload : buildPayload;
  const postStateFn = typeof deps.postState === "function" ? deps.postState : () => false;
  const deliveryChains = new Map();
  // The last payload reported for the live session, used only to close it out
  // when OMP switches away. Cleared on a real SessionEnd so a shutdown is never
  // followed by a second, synthetic one.
  let current = null;

  function deliver(payload, waitForDelivery, drainAll = false) {
    const sessionKey = payload && payload.session_id ? payload.session_id : `${OMP_AGENT_ID}:default`;
    const task = () => Promise.resolve(postStateFn(payload));
    const tail = chainDelivery(deliveryChains, sessionKey, task);
    if (!waitForDelivery) return true;
    return drainAll ? drainDeliveries(deliveryChains) : tail;
  }

  function send(state, event, nativeEvent, ctx, waitForDelivery = false, drainAll = false) {
    let report;
    try {
      report = shouldReportFn(ctx);
    } catch {
      report = false;
    }
    if (!report) return waitForDelivery ? Promise.resolve(false) : false;
    let payload;
    try {
      payload = buildPayloadFn({ state, event, nativeEvent, ctx });
    } catch {
      return waitForDelivery ? Promise.resolve(false) : false;
    }

    // session_switch / session_branch move the terminal to another
    // conversation without a shutdown for the one being left. Retire it
    // explicitly, or Clawd keeps a live row for a session nothing will report
    // on again.
    if (current && payload && current.session_id !== payload.session_id) {
      deliver({ ...current, event: "SessionEnd", state: "sleeping" }, false);
    }
    current = event === "SessionEnd" ? null : payload;

    return deliver(payload, waitForDelivery, drainAll);
  }

  for (const [nativeName, clawdEvent, state] of DEFAULT_EVENT_BINDINGS) {
    // A completion or a shutdown is the last thing a session says; await
    // delivery so the process cannot exit with it still queued. A shutdown
    // additionally drains every other session's tail — see drainDeliveries.
    const wait = nativeName === "session_stop" || nativeName === "session_shutdown";
    const drainAll = nativeName === "session_shutdown";
    omp.on(nativeName, (nativeEvent, ctx) => send(state, clawdEvent, nativeEvent, ctx, wait, drainAll));
  }

  omp.on("tool_call", (nativeEvent, ctx) => {
    try {
      send("working", "PreToolUse", nativeEvent, ctx);
    } catch {}
    return undefined;
  });

  omp.on("tool_result", (nativeEvent, ctx) => {
    const isError = !!(nativeEvent && nativeEvent.isError);
    // Await failed tool delivery so a following lifecycle event cannot hide
    // the error state before Clawd receives it.
    return send(
      isError ? "error" : "working",
      isError ? "PostToolUseFailure" : "PostToolUse",
      nativeEvent,
      ctx,
      isError
    );
  });

  return { deliveryChains, send, getCurrent: () => current };
}

const api = {
  DEFAULT_EVENT_BINDINGS,
  OMP_AGENT_ID,
  OMP_HOOK_SOURCE,
  attach,
  buildPayload,
  isInteractiveMode,
  parseMode,
  readSessionTitle,
  shouldReport,
};

module.exports = api;
module.exports.default = api;
