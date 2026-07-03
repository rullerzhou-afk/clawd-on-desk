// src/server.js — HTTP server + routes (/state, /permission, /health)
// Extracted from main.js L1337-1528

const http = require("http");
const {
  DEFAULT_SERVER_PORT,
  RUNTIME_CONFIG_PATH,
  clearRuntimeConfig,
  getPortCandidates,
  readRuntimePort,
  writeRuntimeConfig,
} = require("../hooks/server-config");
const {
  entriesContainCommandMarker,
  entriesContainHttpHookUrl,
  settingsNeedClaudeHookResync,
  createClaudeSettingsWatcher,
} = require("./claude-settings-watcher");
const { createIntegrationSyncRuntime } = require("./integration-sync");
const {
  sendStateHealthResponse,
  handleStatePost,
} = require("./server-route-state");
const {
  handlePermissionPost,
  shouldBypassCCBubble,
  shouldBypassCodexBubble,
  shouldBypassOpencodeBubble,
} = require("./server-route-permission");
const {
  getCodexOfficialTurnKey,
  resolveCodexOfficialHookState,
} = require("./server-codex-official-turns");
const {
  HOOK_EVENT_RING_SIZE_PER_AGENT,
  createSingleRequestHookEventRecorder,
  recordHookEventInBuffer,
  getRecentHookEventsFromBuffer,
} = require("./server-hook-events");
const {
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  normalizeCodexPermissionToolInput,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
  findPendingPermissionForStateEvent,
} = require("./server-permission-utils");

module.exports = function initServer(ctx) {

const createHttpServer = ctx.createHttpServer || http.createServer.bind(http);
const setImmediateFn = ctx.setImmediate || setImmediate;
const nowFn = typeof ctx.now === "function" ? ctx.now : Date.now;
const clearRuntimeConfigFn = ctx.clearRuntimeConfig || clearRuntimeConfig;
const getPortCandidatesFn = ctx.getPortCandidates || getPortCandidates;
const readRuntimePortFn = ctx.readRuntimePort || readRuntimePort;
const writeRuntimeConfigFn = ctx.writeRuntimeConfig || writeRuntimeConfig;
const CLAUDE_HOOK_GUARD_NOTICE_TTL_MS = 30 * 60 * 1000;

let httpServer = null;
let activeServerPort = null;
let lastClaudeHookGuardNotice = null;
const codexOfficialTurns = new Map();
const recentHookEvents = new Map();

function shouldDropForDnd() {
  if (typeof ctx.shouldDropForDnd === "function") {
    try {
      return !!ctx.shouldDropForDnd();
    } catch {}
  }
  return !!ctx.doNotDisturb;
}

function recordHookEvent(data, route, outcome) {
  return recordHookEventInBuffer(recentHookEvents, data, route, outcome, { now: nowFn });
}

function createRequestHookRecorder(data, defaultRoute) {
  return createSingleRequestHookEventRecorder(recordHookEvent, data, defaultRoute);
}

function getRecentHookEvents(options = {}) {
  return getRecentHookEventsFromBuffer(recentHookEvents, options);
}

function clearRecentHookEvents(agentId) {
  if (typeof agentId === "string" && agentId) recentHookEvents.delete(agentId);
  else recentHookEvents.clear();
}

function shouldManageClaudeHooks() {
  return ctx.manageClaudeHooksAutomatically !== false;
}

function isAgentEnabled(agentId) {
  if (typeof ctx.isAgentEnabled !== "function") return true;
  return ctx.isAgentEnabled(agentId) !== false;
}

function shouldSyncAgentIntegration(agentId) {
  if (typeof ctx.shouldSyncAgentIntegration === "function") {
    return ctx.shouldSyncAgentIntegration(agentId) !== false;
  }
  return isAgentEnabled(agentId);
}

function getHookServerPort() {
  return activeServerPort || readRuntimePortFn() || DEFAULT_SERVER_PORT;
}

function getRuntimeStatus() {
  let address = null;
  try {
    address = httpServer && typeof httpServer.address === "function" ? httpServer.address() : null;
  } catch {
    address = null;
  }
  const addressPort = address && typeof address === "object" && Number.isInteger(address.port)
    ? address.port
    : null;
  const port = activeServerPort || addressPort || null;
  const runtimePort = readRuntimePortFn();
  return {
    listening: !!port && (!httpServer || httpServer.listening !== false),
    port,
    runtimePath: typeof ctx.runtimeConfigPath === "string" ? ctx.runtimeConfigPath : RUNTIME_CONFIG_PATH,
    runtimePort,
    runtimeFileExists: Number.isInteger(runtimePort),
    runtimeMatches: Number.isInteger(port) && runtimePort === port,
  };
}

function getClaudeHookGuardStatus() {
  if (!lastClaudeHookGuardNotice) return null;
  if (nowFn() - lastClaudeHookGuardNotice.at > CLAUDE_HOOK_GUARD_NOTICE_TTL_MS) return null;
  return { ...lastClaudeHookGuardNotice };
}

function clearClaudeHookGuardStatus() {
  const hadNotice = !!lastClaudeHookGuardNotice;
  lastClaudeHookGuardNotice = null;
  return hadNotice;
}

const integrationSync = createIntegrationSyncRuntime({
  ctx,
  getHookServerPort,
  shouldManageClaudeHooks,
  isAgentEnabled,
  shouldSyncAgentIntegration,
  startClaudeSettingsWatcher,
  stopClaudeSettingsWatcher,
});
const {
  syncClawdHooks,
  syncGeminiHooks,
  syncAntigravityHooks,
  syncCursorHooks,
  syncCodeBuddyHooks,
  syncKiroHooks,
  syncKimiHooks,
  syncCodexHooks,
  syncOpencodePlugin,
  syncPiExtension,
  syncIntegrationForAgent: syncIntegrationForAgentBase,
  repairIntegrationForAgent: repairIntegrationForAgentBase,
  stopIntegrationForAgent,
  uninstallIntegrationForAgent,
  syncEnabledStartupIntegrations,
} = integrationSync;

function notifySuspiciousShrink(before, after) {
  lastClaudeHookGuardNotice = {
    type: "suspicious-shrink",
    at: nowFn(),
    before: before ? { ...before } : null,
    after: after ? { ...after } : null,
  };
  if (typeof ctx.notifySuspiciousShrink === "function") {
    ctx.notifySuspiciousShrink(before, after, lastClaudeHookGuardNotice);
  }
}

function shouldClearClaudeHookGuardAfterSync(agentId, result) {
  if (agentId !== "claude-code") return false;
  if (result === false) return false;
  if (result && typeof result === "object" && result.status === "error") return false;
  return true;
}

function clearClaudeHookGuardAfterClaudeSync(agentId, result) {
  if (shouldClearClaudeHookGuardAfterSync(agentId, result)) clearClaudeHookGuardStatus();
  return result;
}

function syncIntegrationForAgent(agentId) {
  return clearClaudeHookGuardAfterClaudeSync(agentId, syncIntegrationForAgentBase(agentId));
}

function repairIntegrationForAgent(agentId, options = {}) {
  return clearClaudeHookGuardAfterClaudeSync(agentId, repairIntegrationForAgentBase(agentId, options));
}

function repairRuntimeStatus() {
  const status = getRuntimeStatus();
  if (status && status.listening && Number.isInteger(status.port)) {
    const written = writeRuntimeConfigFn(status.port);
    return written
      ? { status: "ok" }
      : { status: "error", message: "Failed to write runtime config" };
  }
  if (!httpServer) {
    startHttpServer();
    return { status: "ok" };
  }
  return {
    status: "error",
    message: "Local server is not listening; restart Clawd",
  };
}

const claudeSettingsWatcher = createClaudeSettingsWatcher({
  ...ctx,
  shouldManageClaudeHooks,
  isAgentEnabled,
  shouldSyncAgentIntegration,
  getHookServerPort,
  syncClawdHooks,
  notifySuspiciousShrink,
});

// Watch ~/.claude/ directory for settings.json overwrites (e.g. CC-Switch)
// that wipe our hooks. Re-register when hooks disappear.
// Watch the directory (not the file) because atomic rename replaces the inode
// and fs.watch on the old file silently stops firing on Windows.
function startClaudeSettingsWatcher() {
  return claudeSettingsWatcher.start();
}

function stopClaudeSettingsWatcher() {
  return claudeSettingsWatcher.stop();
}

function startHttpServer() {
  httpServer = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/state") {
      sendStateHealthResponse(res, { getHookServerPort });
    } else if (req.method === "POST" && req.url === "/state") {
      handleStatePost(req, res, {
        ctx,
        createRequestHookRecorder,
        shouldDropForDnd,
        codexOfficialTurns,
      });
    } else if (req.method === "POST" && req.url === "/permission") {
      handlePermissionPost(req, res, {
        ctx,
        createRequestHookRecorder,
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const listenPorts = getPortCandidatesFn();
  let listenIndex = 0;
  // Resolves with the bound port once the server is actually listening, or
  // null if every candidate port is occupied (or a non-EADDRINUSE bind error
  // fires before listening). Callers that read the port synchronously to wire
  // downstream connections — e.g. remote-ssh connect-on-launch, whose
  // runtime.connect() builds the SSH reverse tunnel off getHookServerPort() —
  // MUST await this. listen() is async, so activeServerPort is still null when
  // startHttpServer() returns; acting before the 'listening' event would read
  // a stale fallback port (readRuntimePort()/DEFAULT) and target the wrong
  // local port whenever the bind drifted off the first candidate.
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    httpServer.on("error", (err) => {
      if (!activeServerPort && err.code === "EADDRINUSE" && listenIndex < listenPorts.length - 1) {
        listenIndex++;
        httpServer.listen(listenPorts[listenIndex], "127.0.0.1");
        return;
      }
      if (!activeServerPort && err.code === "EADDRINUSE") {
        const firstPort = listenPorts[0];
        const lastPort = listenPorts[listenPorts.length - 1];
        console.warn(`Ports ${firstPort}-${lastPort} are occupied — state sync and permission bubbles are disabled`);
      } else {
        console.error("HTTP server error:", err.message);
      }
      // Pre-listening failure: resolve null so startup callbacks can skip work
      // that needs a live port. A post-listening runtime 'error' arrives after
      // settle(port), so this is a no-op in that case.
      settle(null);
    });

    httpServer.on("listening", () => {
      activeServerPort = listenPorts[listenIndex];
      writeRuntimeConfigFn(activeServerPort);
      console.log(`Clawd state server listening on 127.0.0.1:${activeServerPort}`);
      // Defer hook/plugin registration off the startup path. Each sync call
      // reads+parses+writes a config JSON (50-150ms cumulative on slow disks),
      // and they operate on independent files for independent agents, so
      // none of them need to block the HTTP server from accepting traffic.
      setImmediateFn(() => {
        syncEnabledStartupIntegrations();
      });
      settle(activeServerPort);
    });

    try {
      httpServer.listen(listenPorts[listenIndex], "127.0.0.1");
    } catch (err) {
      // listen() can throw synchronously (bad args, certain Windows
      // conditions). Honor the "resolves, never rejects" contract: log and
      // resolve null so port-dependent startup work is skipped — same outcome
      // as a pre-listening 'error' event, rather than rejecting and risking an
      // unhandled rejection in a caller that forgot to .catch().
      console.error("HTTP server listen threw:", err && err.message);
      settle(null);
    }
  });
}

function cleanup() {
  clearRuntimeConfigFn();
  clearClaudeHookGuardStatus();
  stopClaudeSettingsWatcher();
  if (httpServer) httpServer.close();
}

return {
  startHttpServer,
  getHookServerPort,
  getRuntimeStatus,
  getClaudeHookGuardStatus,
  clearClaudeHookGuardStatus,
  getRecentHookEvents,
  clearRecentHookEvents,
  syncClawdHooks,
  syncGeminiHooks,
  syncAntigravityHooks,
  syncCursorHooks,
  syncCodeBuddyHooks,
  syncKiroHooks,
  syncKimiHooks,
  syncCodexHooks,
  syncOpencodePlugin,
  syncPiExtension,
  syncIntegrationForAgent,
  repairIntegrationForAgent,
  uninstallIntegrationForAgent,
  repairRuntimeStatus,
  stopIntegrationForAgent,
  startClaudeSettingsWatcher,
  stopClaudeSettingsWatcher,
  cleanup,
};

};

module.exports.__test = {
  entriesContainCommandMarker,
  entriesContainHttpHookUrl,
  settingsNeedClaudeHookResync,
  shouldBypassCCBubble,
  shouldBypassCodexBubble,
  shouldBypassOpencodeBubble,
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
  normalizeCodexPermissionToolInput,
  normalizeToolMatchValue,
  buildToolInputFingerprint,
  findPendingPermissionForStateEvent,
  getCodexOfficialTurnKey,
  resolveCodexOfficialHookState,
  recordHookEventInBuffer,
  getRecentHookEventsFromBuffer,
  createSingleRequestHookEventRecorder,
  HOOK_EVENT_RING_SIZE_PER_AGENT,
};
