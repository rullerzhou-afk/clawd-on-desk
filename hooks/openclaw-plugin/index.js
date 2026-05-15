import { readFileSync } from "fs";
import { request } from "http";
import { homedir } from "os";
import { join } from "path";

export const PLUGIN_ID = "clawd-on-desk";
export const AGENT_ID = "openclaw";
export const STOP_DEBOUNCE_MS = 1500;

const CLAWD_DIR = join(homedir(), ".clawd");
const RUNTIME_CONFIG_PATH = join(CLAWD_DIR, "runtime.json");
const SERVER_PORTS = [23333, 23334, 23335, 23336, 23337];
const POST_TIMEOUT_MS = 1000;

const HOOK_NAMES = [
  "session_start",
  "model_call_started",
  "model_call_ended",
  "before_tool_call",
  "after_tool_call",
  "before_compaction",
  "after_compaction",
  "session_end",
];

let cachedPort = null;

function readRuntimePort() {
  try {
    const raw = JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, "utf8"));
    const port = Number(raw && raw.port);
    if (Number.isInteger(port) && SERVER_PORTS.includes(port)) return port;
  } catch {}
  return null;
}

function getPortCandidates() {
  const ordered = [];
  const seen = new Set();
  const add = (port) => {
    if (Number.isInteger(port) && SERVER_PORTS.includes(port) && !seen.has(port)) {
      seen.add(port);
      ordered.push(port);
    }
  };
  add(cachedPort);
  if (cachedPort == null) add(readRuntimePort());
  for (const port of SERVER_PORTS) add(port);
  return ordered;
}

function stripUndefined(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined && entry !== null && entry !== "") out[key] = entry;
  }
  return out;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function getSessionId(event, ctx) {
  const value = firstString(
    event && event.sessionId,
    ctx && ctx.sessionId,
    event && event.sessionKey,
    ctx && ctx.sessionKey,
    event && event.runId,
    ctx && ctx.runId,
  );
  return value || "openclaw:default";
}

function getPendingKey(event, ctx) {
  return firstString(
    event && event.runId,
    ctx && ctx.runId,
    event && event.sessionId,
    ctx && ctx.sessionId,
    event && event.sessionKey,
    ctx && ctx.sessionKey,
  ) || "openclaw:default";
}

export function mapModelCallEnded(event = {}) {
  if (event.outcome !== "error") {
    return { action: "debounce-stop", state: "attention", event: "Stop" };
  }

  const failureKind = typeof event.failureKind === "string" ? event.failureKind : "";
  if (failureKind === "aborted" || failureKind === "terminated") {
    return { action: "send", state: "attention", event: "Stop", error_present: false };
  }

  return { action: "send", state: "error", event: "StopFailure", error_present: true };
}

export function mapSessionEnd(event = {}) {
  const reason = typeof event.reason === "string" && event.reason ? event.reason : "unknown";
  if (reason === "new" || reason === "reset" || reason === "compaction") {
    return null;
  }
  return { action: "send", state: "sleeping", event: "SessionEnd", session_end_reason: reason };
}

export function createOpenClawRuntime(options = {}) {
  const pendingStops = new Map();
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const postState = typeof options.postState === "function" ? options.postState : postStateToClawd;
  const processInfo = options.processInfo === undefined ? null : options.processInfo;

  function clearPendingStop(key) {
    if (!pendingStops.has(key)) return;
    clearTimeoutFn(pendingStops.get(key));
    pendingStops.delete(key);
  }

  function clearAllPendingStops() {
    for (const timer of pendingStops.values()) clearTimeoutFn(timer);
    pendingStops.clear();
  }

  function buildPayload(state, eventName, nativeEvent = {}, ctx = {}, extra = {}) {
    const info = processInfo || {};
    const body = {
      agent_id: AGENT_ID,
      hook_source: "openclaw-plugin",
      state,
      event: eventName,
      session_id: getSessionId(nativeEvent, ctx),
      cwd: firstString(ctx.workspaceDir, nativeEvent.cwd, nativeEvent.workspaceDir),
      agent_pid: process.pid,
      source_pid: firstNumber(info.source_pid),
      pid_chain: Array.isArray(info.pid_chain) && info.pid_chain.length ? info.pid_chain : undefined,
      editor: info.editor === "code" || info.editor === "cursor" ? info.editor : undefined,
      tool_name: firstString(nativeEvent.toolName, ctx.toolName),
      tool_use_id: firstString(nativeEvent.toolCallId, ctx.toolCallId),
      openclaw_run_id: firstString(nativeEvent.runId, ctx.runId),
      openclaw_call_id: firstString(nativeEvent.callId),
      ...extra,
    };
    return stripUndefined(body);
  }

  function send(state, eventName, nativeEvent = {}, ctx = {}, extra = {}) {
    postState(buildPayload(state, eventName, nativeEvent, ctx, extra));
  }

  function scheduleStop(nativeEvent = {}, ctx = {}) {
    const key = getPendingKey(nativeEvent, ctx);
    clearPendingStop(key);
    const timer = setTimeoutFn(() => {
      pendingStops.delete(key);
      send("attention", "Stop", nativeEvent, ctx);
    }, STOP_DEBOUNCE_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
    pendingStops.set(key, timer);
  }

  function handleHook(hookName, nativeEvent = {}, ctx = {}) {
    const pendingKey = getPendingKey(nativeEvent, ctx);

    if (
      hookName === "model_call_started"
      || hookName === "before_tool_call"
      || hookName === "before_compaction"
      || hookName === "session_end"
    ) {
      clearPendingStop(pendingKey);
    }

    switch (hookName) {
      case "session_start":
        send("idle", "SessionStart", nativeEvent, ctx);
        return;
      case "model_call_started":
        send("thinking", "UserPromptSubmit", nativeEvent, ctx);
        return;
      case "before_tool_call":
        send("working", "PreToolUse", nativeEvent, ctx);
        return;
      case "after_tool_call": {
        if (nativeEvent && nativeEvent.error) {
          send("error", "PostToolUseFailure", nativeEvent, ctx, { error_present: true });
        } else {
          send("working", "PostToolUse", nativeEvent, ctx);
        }
        return;
      }
      case "before_compaction":
        send("sweeping", "PreCompact", nativeEvent, ctx);
        return;
      case "after_compaction":
        send("attention", "PostCompact", nativeEvent, ctx);
        return;
      case "model_call_ended": {
        const mapped = mapModelCallEnded(nativeEvent);
        if (!mapped) return;
        if (mapped.action === "debounce-stop") scheduleStop(nativeEvent, ctx);
        else send(mapped.state, mapped.event, nativeEvent, ctx, { error_present: mapped.error_present });
        return;
      }
      case "session_end": {
        const mapped = mapSessionEnd(nativeEvent);
        if (mapped) send(mapped.state, mapped.event, nativeEvent, ctx, {
          session_end_reason: mapped.session_end_reason,
        });
        return;
      }
      default:
        return;
    }
  }

  function register(api) {
    if (!api || typeof api.on !== "function") return;
    for (const hookName of HOOK_NAMES) {
      api.on(hookName, (event, ctx) => {
        try {
          handleHook(hookName, event, ctx);
        } catch {}
      }, { priority: -100, timeoutMs: 1000 });
    }
  }

  return {
    clearAllPendingStops,
    clearPendingStop,
    handleHook,
    pendingStopCount: () => pendingStops.size,
    register,
  };
}

export function postStateToClawd(body) {
  const payload = JSON.stringify(body);

  (async () => {
    for (const port of getPortCandidates()) {
      if (await postJsonToPort(port, payload)) {
        cachedPort = port;
        return;
      }
    }
    cachedPort = null;
  })().catch(() => {});
}

function postJsonToPort(port, payload) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = request({
      hostname: "127.0.0.1",
      port,
      path: "/state",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: POST_TIMEOUT_MS,
    }, (res) => {
      const isClawd = res.headers["x-clawd-server"] === "clawd-on-desk";
      res.resume();
      res.on("end", () => finish(isClawd));
    });
    req.on("timeout", () => {
      req.destroy();
      finish(false);
    });
    req.on("error", () => finish(false));
    req.write(payload);
    req.end();
  });
}

let defaultRuntime = null;

export default {
  id: PLUGIN_ID,
  name: "Clawd on Desk",
  register(api) {
    if (!defaultRuntime) defaultRuntime = createOpenClawRuntime();
    defaultRuntime.register(api);
  },
};
