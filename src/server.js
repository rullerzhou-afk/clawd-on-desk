// src/server.js — HTTP server + routes (/state, /permission, /health)
// Extracted from main.js L1337-1528

const fs = require("fs");
const http = require("http");
const {
  DEFAULT_SERVER_PORT,
  RUNTIME_CONFIG_PATH,
  buildPermissionUrl,
  clearRuntimeConfig,
  getPortCandidates,
  readRuntimeIdentity,
  readRuntimePort,
  writeRuntimeConfig,
} = require("../hooks/server-config");
const { processAlive } = require("../hooks/shared-process");
const {
  getClaudeHookScriptPath,
  getClaudeAutoStartScriptPath,
  CLAUDE_CORE_HOOK_EVENTS,
  DEFAULT_CONFIG_PATH: CLAUDE_DEFAULT_CONFIG_PATH,
} = require("../hooks/install");
const { inspectClaudeHookHealth, isExplicitRepairVerified } = require("./claude-hook-health");
const {
  entriesContainCommandMarker,
  entriesContainHttpHookUrl,
  settingsNeedClaudeHookResync,
  createClaudeSettingsWatcher,
} = require("./claude-settings-watcher");
const { createIntegrationSyncRuntime } = require("./integration-sync");
const { createClaudeHookOperations } = require("./claude-hook-operations");
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
// #681. Injectable so tests never read the developer's real ~/.clawd/runtime.json
// (whose contents depend on whether Clawd happens to be running right now).
const readRuntimeIdentityFn = ctx.readRuntimeIdentity
  || (() => readRuntimeIdentity({ runtimeConfigPath: ctx.runtimeConfigPath }));
const isProcessAliveFn = ctx.isProcessAlive || processAlive;
// #681: where the runtime file lives is a pure expression — answering it must
// not read the file, probe a PID, or touch any of the seams above. Callers that
// only want the path used to reach it through getRuntimeStatus(), which costs
// two reads, two JSON.parses and a kill() syscall to build a string that ignores
// all of them, and which drags three throw-capable seams into the callsite.
function runtimeConfigFilePath() {
  return typeof ctx.runtimeConfigPath === "string" ? ctx.runtimeConfigPath : RUNTIME_CONFIG_PATH;
}
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
  // #681: the runtime file is now the hook resolver's offline gate, so its
  // identity — not just its port — decides whether hooks can report process
  // metadata at all. A stale ownerPid (a crashed instance's leftover file) reads
  // as "Clawd offline" to every hook even while this server is happily
  // listening, which is exactly the state Doctor must surface.
  const identity = readRuntimeIdentityFn();
  const runtimeOwnerPid = identity && identity.ok ? identity.ownerPid : null;
  return {
    listening: !!port && (!httpServer || httpServer.listening !== false),
    port,
    runtimePath: runtimeConfigFilePath(),
    runtimePort,
    runtimeFileExists: Number.isInteger(runtimePort),
    runtimeMatches: Number.isInteger(port) && runtimePort === port,
    runtimeOwnerPid,
    runtimeOwnerAlive: runtimeOwnerPid ? isProcessAliveFn(runtimeOwnerPid) : false,
    runtimeIdentityValid: !!(identity && identity.ok),
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

// Server-owned, instance-level serialization for every process-internal Claude
// settings.json mutation (register/unregister hooks, statusline, auto-start).
// Gate mirrors the three required conditions: automatic management on, and the
// integration both installed and enabled. Re-checked by the queue right before
// each automatic task actually runs — not just at enqueue time.
function shouldRunAutomaticClaudeHookOperation() {
  return shouldManageClaudeHooks() && shouldSyncAgentIntegration("claude-code");
}

const claudeHookOperations = createClaudeHookOperations({
  shouldRunAutomatic: shouldRunAutomaticClaudeHookOperation,
});

// Sources whose hooks-write also takes the (best-effort, single-slot) Claude
// statusline. Keeping this list explicit — rather than "every register call" —
// is what keeps periodic health/Doctor repair from ever touching statusline;
// see AGENTS.md / the #657 plan §6.4 for the full source matrix.
const CLAUDE_STATUSLINE_REGISTER_SOURCES = new Set(["startup", "settings-agent-install", "settings-agent-enable"]);
const CLAUDE_STATUSLINE_UNREGISTER_SOURCES = new Set(["settings-agent-uninstall", "cleanup"]);

// Shared by every register-path queue task (startup/Settings/Doctor/watcher/
// periodic-health) for the same two safety checks the periodic supervisor
// already does on its own automatic path: never write toward a source script
// that doesn't exist, and never trust the installer's own success signal —
// re-read and re-run the same inspector to confirm the fix actually landed.
// Without this, Doctor Fix / Settings Install could report success while
// writing a command at a path that can never work (#657 review finding).
const claudeFsApi = ctx.fs || fs;
const claudeExpectedHookScriptPath = typeof ctx.expectedHookScriptPath === "string"
  ? ctx.expectedHookScriptPath
  : getClaudeHookScriptPath();
const claudeExpectedAutoStartScriptPath = typeof ctx.expectedAutoStartScriptPath === "string"
  ? ctx.expectedAutoStartScriptPath
  : getClaudeAutoStartScriptPath();
const claudeCoreEventsForHealth = Array.isArray(ctx.coreEvents) ? ctx.coreEvents : CLAUDE_CORE_HOOK_EVENTS;
const claudeHookPlatformForHealth = ctx.platform || process.platform;
const claudeSettingsVerifyPath = typeof ctx.claudeSettingsPath === "string"
  ? ctx.claudeSettingsPath
  : CLAUDE_DEFAULT_CONFIG_PATH;

function claudeHookSourceMissing({ requireAutoStart = false } = {}) {
  try {
    if (!claudeFsApi.existsSync(claudeExpectedHookScriptPath)) return true;
    // auto-start.js is its own packaged source script — a register call that
    // writes a SessionStart auto-start command must not do so toward a path
    // that doesn't exist either, same reasoning as the core script check
    // above. Only checked when this call actually writes an auto-start
    // command, so a plain (non-auto-start) register/repair is never blocked
    // by an unrelated, unused script being missing.
    if (requireAutoStart && !claudeFsApi.existsSync(claudeExpectedAutoStartScriptPath)) return true;
    return false;
  } catch {
    return true;
  }
}

function readClaudeSettingsRawForVerify() {
  try {
    return claudeFsApi.readFileSync(claudeSettingsVerifyPath, "utf-8");
  } catch {
    return "";
  }
}

function buildClaudeHookReportForVerify(overrides = {}) {
  const requireAutoStart = overrides.requireAutoStart !== undefined
    ? overrides.requireAutoStart
    : !!ctx.autoStartWithClaude;
  return inspectClaudeHookHealth(readClaudeSettingsRawForVerify(), {
    expectedPermissionUrl: buildPermissionUrl(getHookServerPort()),
    expectedHookScriptPath: claudeExpectedHookScriptPath,
    expectedAutoStartScriptPath: claudeExpectedAutoStartScriptPath,
    requireAutoStart,
    coreEvents: claudeCoreEventsForHealth,
    platform: claudeHookPlatformForHealth,
    fs: claudeFsApi,
  });
}

function registerClaudeHooksTask(meta) {
  return async () => {
    // Source preflight: reconcile only ever rewrites toward this path, so if
    // it doesn't exist writing is pointless (and would just leave a command
    // pointing nowhere). Matches the periodic supervisor's own source-missing
    // short-circuit, now for every register source, not just the automatic one.
    if (claudeHookSourceMissing({ requireAutoStart: !!meta.autoStart })) {
      return {
        status: "error",
        reason: "source-script-missing",
        message: "Claude hook source script is missing; reinstall or re-extract Clawd",
      };
    }

    const { registerHooksAsync, registerClaudeStatusline } = require("../hooks/install.js");
    const result = await registerHooksAsync({
      silent: true,
      autoStart: meta.autoStart,
      port: meta.port,
    });
    if (CLAUDE_STATUSLINE_REGISTER_SOURCES.has(meta.source)) {
      try {
        const statuslineResult = registerClaudeStatusline({ silent: true });
        if (statuslineResult.changed) {
          console.log("Clawd: registered Claude Code statusline");
        }
      } catch (statuslineErr) {
        console.warn("Clawd: failed to sync Claude Code statusline:", statuslineErr.message);
      }
    }
    const { added, updated, removed } = result;
    if (added > 0 || updated > 0 || removed > 0) {
      console.log(`Clawd: synced hooks (added ${added}, updated ${updated}, removed ${removed}) [${meta.source || "unspecified"}]`);
    }

    // Never trust the installer's own success signal alone — re-read and
    // verify with the same inspector the periodic supervisor uses, so every
    // caller (Doctor Fix and Settings Install included, not just the
    // automatic supervisor path) consumes a verified result instead of a
    // blind "ok" (#657 review finding).
    const verifyReport = buildClaudeHookReportForVerify({ requireAutoStart: !!meta.autoStart });
    if (!isExplicitRepairVerified(verifyReport)) {
      return {
        status: "error",
        message: "Claude hook repair did not verify healthy",
        added,
        updated,
        removed,
        verifyIssues: verifyReport.issues,
      };
    }

    return { status: "ok", added, updated, removed };
  };
}

function unregisterClaudeHooksTask(meta) {
  return async () => {
    const { unregisterHooksAsync, unregisterClaudeStatusline } = require("../hooks/install.js");
    const hooksResult = await unregisterHooksAsync({ backup: true });
    let statuslineResult = null;
    if (CLAUDE_STATUSLINE_UNREGISTER_SOURCES.has(meta.source)) {
      try {
        statuslineResult = unregisterClaudeStatusline({ backup: true, silent: true });
      } catch (statuslineErr) {
        console.warn("Clawd: failed to unregister Claude Code statusline:", statuslineErr.message);
      }
    }
    const removed = (hooksResult.removed || 0) + (statuslineResult ? (statuslineResult.removed || 0) : 0);
    const changed = !!hooksResult.changed || !!(statuslineResult && statuslineResult.changed);
    const backupPaths = [hooksResult.backupPath, statuslineResult && statuslineResult.backupPath].filter(Boolean);
    return { status: "ok", removed, changed, backupPaths, hooks: hooksResult, statusline: statuslineResult };
  };
}

function syncClawdHooksQueued(implOptions = {}) {
  const source = typeof implOptions.source === "string" ? implOptions.source : "unspecified";
  const automatic = implOptions.automatic !== false;
  const meta = { source, autoStart: implOptions.autoStart, port: implOptions.port };
  return claudeHookOperations.enqueue({ source, automatic }, registerClaudeHooksTask(meta));
}

function uninstallClaudeHooksQueued(callOptions = {}) {
  const source = typeof callOptions.source === "string" ? callOptions.source : "unspecified";
  const automatic = callOptions.automatic === true;
  return claudeHookOperations.enqueue({ source, automatic }, unregisterClaudeHooksTask({ source }));
}

function setClaudeAutoStart(callOptions = {}) {
  const source = typeof callOptions.source === "string" ? callOptions.source : "auto-start";
  const enabled = callOptions.enabled === true;
  return claudeHookOperations.enqueue({ source, automatic: false }, async () => {
    if (!enabled) {
      // #657 plan §6.3 only carves out unregisterAutoStart() to keep its
      // existing synchronous call — it still runs inside this queue task, so
      // it's serialized against other Claude mutations without being made
      // async itself.
      const { unregisterAutoStart } = require("../hooks/install.js");
      unregisterAutoStart();
      return { status: "ok", enabled };
    }

    if (claudeHookSourceMissing({ requireAutoStart: true })) {
      return {
        status: "error",
        reason: "source-script-missing",
        message: "Claude hook source script is missing; reinstall or re-extract Clawd",
      };
    }

    // Enabling writes the full hook set (not just the auto-start entry) and
    // must not block the Electron main thread with the synchronous Claude
    // version probe registerHooks() performs — use the async installer, like
    // every other register path.
    const { registerHooksAsync } = require("../hooks/install.js");
    await registerHooksAsync({ silent: true, autoStart: true, port: getHookServerPort() });

    const verifyReport = buildClaudeHookReportForVerify({ requireAutoStart: true });
    if (!isExplicitRepairVerified(verifyReport)) {
      return {
        status: "error",
        message: "Claude auto-start did not verify healthy",
        verifyIssues: verifyReport.issues,
      };
    }

    return { status: "ok", enabled: true };
  });
}

// integration-sync.js's Claude branch delegates through the ctx.syncClawdHooksImpl
// / ctx.uninstallIntegrationImpls seams. Only fill in the queue-backed default
// when the caller hasn't already provided one — production (main.js) never
// does, so it gets the real queued implementation; tests that inject their own
// seam (e.g. test/server-hook-management.test.js) keep their exact synchronous
// contract, unwrapped, exactly as before this PR.
const integrationSyncCtx = {
  ...ctx,
  // ctx.autoStartWithClaude is a live getter on the object main.js passes in
  // (see main.js's _serverCtx) — {...ctx} above evaluates it once and
  // freezes the result as a plain value, so a later runtime toggle of the
  // Settings "auto-start with Claude" switch would never be seen through
  // this copy. Redefine the same key as its own live getter, forwarding to
  // the original (unspread) ctx, so every read here tracks the CURRENT
  // setting instead of whatever it was when the server started (#657
  // follow-up review finding).
  get autoStartWithClaude() { return ctx.autoStartWithClaude; },
  syncClawdHooksImpl: typeof ctx.syncClawdHooksImpl === "function"
    ? ctx.syncClawdHooksImpl
    : (implOptions) => syncClawdHooksQueued(implOptions),
  uninstallIntegrationImpls: {
    "claude-code": () => uninstallClaudeHooksQueued({ source: "settings-agent-uninstall", automatic: false }),
    ...(ctx.uninstallIntegrationImpls || {}),
  },
};

const integrationSync = createIntegrationSyncRuntime({
  ctx: integrationSyncCtx,
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

function isThenableResult(value) {
  return !!value && typeof value === "object" && typeof value.then === "function";
}

function clearClaudeHookGuardAfterClaudeSync(agentId, result) {
  // A pending Promise is not a result yet — clearing the guard here would
  // treat "operation enqueued" as "operation succeeded". Decide only once it
  // actually settles; synchronous/test-injected results take the fast path.
  if (isThenableResult(result)) {
    return result.then((resolved) => {
      if (shouldClearClaudeHookGuardAfterSync(agentId, resolved)) clearClaudeHookGuardStatus();
      return resolved;
    });
  }
  if (shouldClearClaudeHookGuardAfterSync(agentId, result)) clearClaudeHookGuardStatus();
  return result;
}

function syncIntegrationForAgent(agentId, options) {
  return clearClaudeHookGuardAfterClaudeSync(agentId, syncIntegrationForAgentBase(agentId, options));
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
  // Same live-getter fix as integrationSyncCtx above — the periodic health
  // check's requireAutoStart (claude-settings-watcher.js's buildReport())
  // must track the CURRENT setting, not whatever it was when the watcher
  // was constructed at startup.
  get autoStartWithClaude() { return ctx.autoStartWithClaude; },
  shouldManageClaudeHooks,
  isAgentEnabled,
  shouldSyncAgentIntegration,
  getHookServerPort,
  syncClawdHooks,
  notifySuspiciousShrink,
});

// Richer runtime status (healthy/repairing/degraded/manual-fix-required/
// guarded/stopped) from the periodic health supervisor — complements
// getClaudeHookGuardStatus() above, which is scoped to the older
// suspicious-shrink-only notice. Doctor uses this to explain *why* a Claude
// hook problem hasn't self-healed (source missing, retry scheduled, stuck).
function getClaudeHookHealthStatus() {
  return claudeSettingsWatcher.getHealthStatus();
}

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
        captureForegroundWindowsTerminal: ctx.captureForegroundWindowsTerminal,
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
      // #681: settle() is at the bottom of this handler, and this is an event
      // callback with no main-process uncaughtException handler behind it — so a
      // throw from here takes the Electron main process down, and under a host
      // that does catch (the test runner) it instead strands startHttpServer's
      // promise and every caller awaiting the port. writeRuntimeConfig owes a
      // boolean contract (its mkdirSync used to sit outside its own try), but a
      // ctx-injected implementation can throw for any reason. Report, never
      // propagate.
      let runtimeWritten = false;
      try {
        runtimeWritten = writeRuntimeConfigFn(activeServerPort) === true;
      } catch (err) {
        runtimeWritten = false;
        console.warn("Failed to write the Clawd runtime file:", (err && err.message) || err);
      }
      if (!runtimeWritten) {
        // Hooks fall back to probing the port range, so state/permission POSTs
        // still land. What is lost is the resolver's offline gate input: with no
        // readable runtime identity the hook fail-closes and OMITS process
        // metadata (no terminal focus for new sessions) rather than snapshot the
        // machine to guess it. Surfaced in Doctor → Local server.
        // runtimeConfigFilePath(), not getRuntimeStatus().runtimePath: the status
        // object reads the runtime file twice and probes the owner PID to build
        // fields this log line discards, and each of those is a throw-capable
        // ctx seam sitting above settle().
        console.warn(
          `Clawd runtime file was not written (${runtimeConfigFilePath()}) — `
          + "hook process metadata will be omitted until this is repaired (see Doctor → Local server)"
        );
      }
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
  // Stop the supervisor before disposing the queue: a fs-watch event firing
  // during teardown must not enqueue new work onto a queue that is about to
  // reject everything. Runtime status is cleared last since nothing after
  // this point can observe it anyway.
  stopClaudeSettingsWatcher();
  claudeHookOperations.dispose();
  clearRuntimeConfigFn();
  clearClaudeHookGuardStatus();
  if (httpServer) httpServer.close();
}

return {
  startHttpServer,
  getHookServerPort,
  getRuntimeStatus,
  getClaudeHookGuardStatus,
  clearClaudeHookGuardStatus,
  getClaudeHookHealthStatus,
  getRecentHookEvents,
  clearRecentHookEvents,
  syncClawdHooks,
  uninstallClaudeHooks: uninstallClaudeHooksQueued,
  setClaudeAutoStart,
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
