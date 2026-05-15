"use strict";

const PI_AGENT_ID = "pi";
const PI_HOOK_SOURCE = "pi-extension";
const DEFAULT_PERMISSION_DENY_REASON = "Denied by Clawd.";
const DEFAULT_PERMISSION_FALLBACK_DENY_REASON = "Pi permission fallback was unavailable; blocked by Clawd.";
const PERMISSION_TOOL_NAMES = new Set(["bash", "write", "edit"]);

const DEFAULT_EVENT_BINDINGS = Object.freeze([
  Object.freeze(["session_start", "SessionStart", "idle"]),
  Object.freeze(["before_agent_start", "UserPromptSubmit", "thinking"]),
  Object.freeze(["agent_end", "Stop", "attention"]),
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
    agent_id: PI_AGENT_ID,
    hook_source: PI_HOOK_SOURCE,
    event: safeString(options.event, "SessionStart"),
    state: safeString(options.state, "idle"),
    session_id: `${PI_AGENT_ID}:${readSessionId(ctx)}`,
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

  if (metadata.editor === "code" || metadata.editor === "cursor") {
    payload.editor = metadata.editor;
  }

  addToolFields(payload, options.nativeEvent);
  return payload;
}

function normalizeToolInput(input) {
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}

function buildPermissionPayload(options = {}) {
  const ctx = options.ctx || {};
  const metadata = options.metadata || {};
  const payload = {
    agent_id: PI_AGENT_ID,
    hook_source: PI_HOOK_SOURCE,
    session_id: `${PI_AGENT_ID}:${readSessionId(ctx)}`,
    tool_input: normalizeToolInput(options.nativeEvent && options.nativeEvent.input),
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

  if (metadata.editor === "code" || metadata.editor === "cursor") {
    payload.editor = metadata.editor;
  }

  addToolFields(payload, options.nativeEvent);
  return payload;
}

function shouldRequestPermission(nativeEvent) {
  if (!nativeEvent || typeof nativeEvent !== "object") return false;
  return PERMISSION_TOOL_NAMES.has(safeString(nativeEvent.toolName, "").toLowerCase());
}

function normalizePermissionDecision(value) {
  if (!value || typeof value !== "object") return null;
  const behavior = value.behavior;
  if (behavior !== "allow" && behavior !== "deny" && behavior !== "no-decision") return null;
  const decision = { behavior };
  if (typeof value.message === "string" && value.message) decision.message = value.message;
  return decision;
}

function normalizeTerminalDecision(value) {
  if (typeof value === "boolean") {
    return value
      ? { behavior: "allow" }
      : { behavior: "deny", message: DEFAULT_PERMISSION_DENY_REASON };
  }
  return normalizePermissionDecision(value);
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

function attach(pi, deps = {}) {
  if (!pi || typeof pi.on !== "function") {
    throw new Error("Pi extension API missing on()");
  }

  const shouldReportFn = typeof deps.shouldReport === "function" ? deps.shouldReport : shouldReport;
  const buildPayloadFn = typeof deps.buildPayload === "function" ? deps.buildPayload : buildPayload;
  const buildPermissionPayloadFn = typeof deps.buildPermissionPayload === "function"
    ? deps.buildPermissionPayload
    : buildPermissionPayload;
  const postStateFn = typeof deps.postState === "function" ? deps.postState : () => false;
  const deliveryChains = new Map();

  function send(state, event, nativeEvent, ctx, waitForDelivery = false) {
    if (!shouldReportFn(ctx)) return waitForDelivery ? Promise.resolve(false) : false;
    const payload = buildPayloadFn({ state, event, nativeEvent, ctx });
    const sessionKey = payload && payload.session_id ? payload.session_id : "pi:default";
    const task = () => Promise.resolve(postStateFn(payload));
    if (waitForDelivery) return chainDelivery(deliveryChains, sessionKey, task);
    task().catch(() => {});
    return true;
  }

  async function resolvePermission(nativeEvent, ctx) {
    const payload = buildPermissionPayloadFn({
      nativeEvent,
      ctx,
    });
    const postPermissionFn = typeof deps.postPermission === "function" ? deps.postPermission : null;
    const confirmPermissionFn = typeof deps.confirmPermission === "function" ? deps.confirmPermission : null;

    if (postPermissionFn) {
      try {
        const posted = normalizePermissionDecision(await postPermissionFn(payload, nativeEvent, ctx));
        if (posted && posted.behavior !== "no-decision") return posted;
      } catch {
        // Fall through to Pi's terminal confirmation path.
      }
    }

    if (confirmPermissionFn) {
      try {
        const confirmed = normalizeTerminalDecision(await confirmPermissionFn(payload, nativeEvent, ctx));
        if (confirmed) return confirmed;
      } catch {
        return { behavior: "deny", message: DEFAULT_PERMISSION_FALLBACK_DENY_REASON };
      }
    }

    return { behavior: "deny", message: DEFAULT_PERMISSION_FALLBACK_DENY_REASON };
  }

  async function handleToolCall(nativeEvent, ctx) {
    try {
      if (!shouldReportFn(ctx)) return undefined;
      const permissionEnabled =
        typeof deps.postPermission === "function" ||
        typeof deps.confirmPermission === "function";

      if (!permissionEnabled || !shouldRequestPermission(nativeEvent)) {
        send("working", "PreToolUse", nativeEvent, ctx);
        return undefined;
      }

      const decision = await resolvePermission(nativeEvent, ctx);
      if (decision.behavior === "allow") {
        send("working", "PreToolUse", nativeEvent, ctx);
        return undefined;
      }

      await send("error", "PostToolUseFailure", nativeEvent, ctx, true);
      return {
        block: true,
        reason: decision.message || DEFAULT_PERMISSION_DENY_REASON,
      };
    } catch (err) {
      const message = err && typeof err.message === "string" && err.message
        ? err.message
        : DEFAULT_PERMISSION_FALLBACK_DENY_REASON;
      return { block: true, reason: message };
    }
  }

  for (const [nativeName, clawdEvent, state] of DEFAULT_EVENT_BINDINGS) {
    const wait = nativeName === "agent_end" || nativeName === "session_shutdown";
    pi.on(nativeName, (nativeEvent, ctx) => send(state, clawdEvent, nativeEvent, ctx, wait));
  }

  pi.on("tool_call", handleToolCall);

  pi.on("tool_result", (nativeEvent, ctx) => {
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

  return { deliveryChains, send };
}

const api = {
  DEFAULT_EVENT_BINDINGS,
  DEFAULT_PERMISSION_DENY_REASON,
  DEFAULT_PERMISSION_FALLBACK_DENY_REASON,
  PERMISSION_TOOL_NAMES,
  PI_AGENT_ID,
  PI_HOOK_SOURCE,
  attach,
  buildPermissionPayload,
  buildPayload,
  isInteractiveMode,
  normalizePermissionDecision,
  parseMode,
  shouldReport,
  shouldRequestPermission,
};

module.exports = api;
module.exports.default = api;
