"use strict";

function hasPositiveCount(value) {
  return Number.isFinite(value) && value > 0;
}

function asOk(result, fallback = {}) {
  if (result && typeof result === "object") {
    if (typeof result.status === "string") return result;
    return { status: "ok", ...result };
  }
  return { status: "ok", ...fallback };
}

function asSkipped(result, reason, message) {
  const base = result && typeof result === "object" ? result : {};
  return {
    status: "skipped",
    ...base,
    reason: (base.reason || reason),
    message: (base.message || message),
  };
}

function normalizeCountSyncResult(result, agentName, reason) {
  if (!result || typeof result !== "object") return { status: "ok" };
  if (typeof result.status === "string") return result;
  const changed =
    hasPositiveCount(result.added)
    || hasPositiveCount(result.updated)
    || hasPositiveCount(result.removed)
    || result.changed === true
    || result.created === true
    || result.configChanged === true;
  const alreadyCurrent = hasPositiveCount(result.skipped);
  if (!changed && !alreadyCurrent) {
    return asSkipped(result, reason, `${agentName} is not installed; skipped integration sync`);
  }
  return asOk(result);
}

function normalizeInstalledFlagResult(result, agentName, reason) {
  if (!result || typeof result !== "object") return { status: "ok" };
  if (typeof result.status === "string") return result;
  if (result.installed === false) {
    const skipReason = result.reason || reason;
    return asSkipped(result, skipReason, result.message || defaultInstalledFlagSkipMessage(agentName, skipReason));
  }
  return asOk(result);
}

function isNotInstalledReason(reason) {
  return reason === "not-found"
    || reason === "not-installed"
    || (typeof reason === "string" && (
      reason.endsWith("-not-found")
      || reason.endsWith("-not-installed")
    ));
}

function defaultInstalledFlagSkipMessage(agentName, reason) {
  if (isNotInstalledReason(reason)) {
    return `${agentName} is not installed; skipped integration sync`;
  }
  return reason
    ? `${agentName} integration sync skipped: ${reason}`
    : `${agentName} integration sync skipped`;
}

function createIntegrationSyncRuntime(options = {}) {
  const ctx = options.ctx || {};
  const getHookServerPort = options.getHookServerPort;
  const shouldManageClaudeHooks = options.shouldManageClaudeHooks;
  const isAgentEnabled = typeof options.isAgentEnabled === "function" ? options.isAgentEnabled : (() => true);
  const shouldSyncAgentIntegration = typeof options.shouldSyncAgentIntegration === "function"
    ? options.shouldSyncAgentIntegration
    : isAgentEnabled;
  const startClaudeSettingsWatcher = options.startClaudeSettingsWatcher;
  const stopClaudeSettingsWatcher = options.stopClaudeSettingsWatcher;

  function syncClawdHooks() {
    try {
      if (typeof ctx.syncClawdHooksImpl === "function") {
        return ctx.syncClawdHooksImpl({
          autoStart: ctx.autoStartWithClaude,
          port: getHookServerPort(),
        });
      }
      const { registerHooks, registerClaudeStatusline } = require("../hooks/install.js");
      const { added, updated, removed } = registerHooks({
        silent: true,
        autoStart: ctx.autoStartWithClaude,
        port: getHookServerPort(),
      });
      if (added > 0 || updated > 0 || removed > 0) {
        console.log(`Clawd: synced hooks (added ${added}, updated ${updated}, removed ${removed})`);
      }
      // Statusline registration is best-effort and reported separately: it only
      // takes the slot when empty/already ours (never overwrites a user's own
      // statusline), so a skip here is expected and must not affect the
      // hooks-sync status returned below.
      try {
        const statuslineResult = registerClaudeStatusline({ silent: true });
        if (statuslineResult.changed) {
          console.log("Clawd: registered Claude Code statusline (rate limit quota)");
        }
      } catch (statuslineErr) {
        console.warn("Clawd: failed to sync Claude Code statusline:", statuslineErr.message);
      }
      return { status: "ok", added, updated, removed };
    } catch (err) {
      console.warn("Clawd: failed to sync hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Claude hooks" };
    }
  }

  function syncGeminiHooks() {
    try {
      if (typeof ctx.syncGeminiHooksImpl === "function") return ctx.syncGeminiHooksImpl();
      const { registerGeminiHooks } = require("../hooks/gemini-install.js");
      const result = registerGeminiHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced Gemini hooks (added ${result.added}, updated ${result.updated})`);
      }
      return normalizeCountSyncResult(result, "Gemini CLI", "gemini-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync Gemini hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Gemini hooks" };
    }
  }

  function syncAntigravityHooks() {
    try {
      if (typeof ctx.syncAntigravityHooksImpl === "function") return ctx.syncAntigravityHooksImpl();
      const { registerAntigravityHooks, registerAntigravityStatusline } = require("../hooks/antigravity-install.js");
      const result = registerAntigravityHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced Antigravity hooks (added ${result.added}, updated ${result.updated})`);
      }
      // Statusline registration is best-effort and reported separately: it only
      // takes the slot when empty/already ours (never overwrites a user's own
      // statusline), so a skip here is expected and must not affect the
      // hooks-sync status returned below.
      try {
        const statuslineResult = registerAntigravityStatusline({ silent: true });
        if (statuslineResult.changed) {
          console.log("Clawd: registered Antigravity statusline (context usage)");
        }
      } catch (statuslineErr) {
        console.warn("Clawd: failed to sync Antigravity statusline:", statuslineErr.message);
      }
      return normalizeInstalledFlagResult(result, "Antigravity CLI", "antigravity-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync Antigravity hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Antigravity hooks" };
    }
  }

  function syncCodeBuddyHooks() {
    try {
      if (typeof ctx.syncCodeBuddyHooksImpl === "function") return ctx.syncCodeBuddyHooksImpl();
      const { registerCodeBuddyHooks } = require("../hooks/codebuddy-install.js");
      const result = registerCodeBuddyHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced CodeBuddy hooks (added ${result.added}, updated ${result.updated})`);
      }
      return normalizeCountSyncResult(result, "CodeBuddy", "codebuddy-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync CodeBuddy hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync CodeBuddy hooks" };
    }
  }

  function syncKiroHooks() {
    try {
      if (typeof ctx.syncKiroHooksImpl === "function") return ctx.syncKiroHooksImpl();
      const { registerKiroHooks } = require("../hooks/kiro-install.js");
      const result = registerKiroHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced Kiro hooks (added ${result.added}, updated ${result.updated})`);
      }
      return normalizeCountSyncResult(result, "Kiro CLI", "kiro-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync Kiro hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Kiro hooks" };
    }
  }

  function syncKimiHooks() {
    try {
      if (typeof ctx.syncKimiHooksImpl === "function") return ctx.syncKimiHooksImpl();
      const { registerKimiHooks } = require("../hooks/kimi-install.js");
      const result = registerKimiHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced Kimi hooks (added ${result.added}, updated ${result.updated})`);
      }
      return normalizeCountSyncResult(result, "Kimi Code", "kimi-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync Kimi hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Kimi hooks" };
    }
  }

  function syncQwenHooks() {
    try {
      if (typeof ctx.syncQwenHooksImpl === "function") return ctx.syncQwenHooksImpl();
      const { registerQwenCodeHooks } = require("../hooks/qwen-code-install.js");
      const result = registerQwenCodeHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced Qwen hooks (added ${result.added}, updated ${result.updated})`);
      }
      return normalizeCountSyncResult(result, "Qwen Code", "qwen-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync Qwen hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Qwen hooks" };
    }
  }

  function syncCodexHooks() {
    try {
      if (typeof ctx.syncCodexHooksImpl === "function") return ctx.syncCodexHooksImpl();
      const { registerCodexHooks } = require("../hooks/codex-install.js");
      const result = registerCodexHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced Codex hooks (added ${result.added}, updated ${result.updated})`);
      }
      if (Array.isArray(result.warnings)) {
        for (const warning of result.warnings) console.warn(`Clawd: Codex hook sync warning: ${warning}`);
      }
      return normalizeCountSyncResult(result, "Codex CLI", "codex-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync Codex hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Codex hooks" };
    }
  }

  function repairCodexHooks(options = {}) {
    try {
      if (typeof ctx.repairCodexHooksImpl === "function") return ctx.repairCodexHooksImpl(options);
      const { registerCodexHooks } = require("../hooks/codex-install.js");
      const { added, updated, configChanged, warnings } = registerCodexHooks({
        silent: true,
        forceCodexHooksFeature: options && options.forceCodexHooksFeature === true,
      });
      if (added > 0 || updated > 0 || configChanged) {
        console.log(`Clawd: repaired Codex hooks (added ${added}, updated ${updated}, configChanged=${!!configChanged})`);
      }
      if (Array.isArray(warnings)) {
        for (const warning of warnings) console.warn(`Clawd: Codex hook repair warning: ${warning}`);
        if (warnings.length > 0) {
          return {
            status: "error",
            message: `Codex hooks were repaired, but ${warnings.join("; ")}`,
          };
        }
      }
      return {
        status: "ok",
        added,
        updated,
        configChanged,
        message: configChanged
          ? "Codex hooks repaired and [features].hooks updated"
          : "Codex hooks repaired",
      };
    } catch (err) {
      console.warn("Clawd: failed to repair Codex hooks:", err.message);
      return { status: "error", message: err && err.message };
    }
  }

  function syncCursorHooks() {
    try {
      if (typeof ctx.syncCursorHooksImpl === "function") return ctx.syncCursorHooksImpl();
      const { registerCursorHooks } = require("../hooks/cursor-install.js");
      const result = registerCursorHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced Cursor hooks (added ${result.added}, updated ${result.updated})`);
      }
      return normalizeCountSyncResult(result, "Cursor Agent", "cursor-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync Cursor hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Cursor hooks" };
    }
  }

  function syncCopilotHooks() {
    try {
      if (typeof ctx.syncCopilotHooksImpl === "function") return ctx.syncCopilotHooksImpl();
      const { registerCopilotHooks } = require("../hooks/copilot-install.js");
      const result = registerCopilotHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced Copilot hooks (added ${result.added}, updated ${result.updated})`);
      }
      return normalizeCountSyncResult(result, "Copilot CLI", "copilot-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync Copilot hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Copilot hooks" };
    }
  }

  function syncOpencodePlugin() {
    try {
      if (typeof ctx.syncOpencodePluginImpl === "function") return ctx.syncOpencodePluginImpl();
      const { registerOpencodePlugin } = require("../hooks/opencode-install.js");
      const result = registerOpencodePlugin({ silent: true });
      if (result.added || result.created) {
        console.log(`Clawd: synced opencode plugin (added=${result.added}, created=${result.created})`);
      }
      if (result && result.reason === "opencode-not-found") {
        return asSkipped(result, "opencode-not-found", "opencode is not installed; skipped plugin sync");
      }
      return asOk(result);
    } catch (err) {
      console.warn("Clawd: failed to sync opencode plugin:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync opencode plugin" };
    }
  }

  function syncPiExtension() {
    try {
      if (typeof ctx.syncPiExtensionImpl === "function") return ctx.syncPiExtensionImpl();
      const { registerPiExtension } = require("../hooks/pi-install.js");
      const result = registerPiExtension({ silent: true });
      if (result.installed && result.updated) {
        console.log("Clawd: synced Pi extension");
      }
      return normalizeInstalledFlagResult(result, "Pi", "pi-not-found");
    } catch (err) {
      console.warn("Clawd: failed to sync Pi extension:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Pi extension" };
    }
  }

  function syncOpenClawPlugin() {
    try {
      if (typeof ctx.syncOpenClawPluginImpl === "function") return ctx.syncOpenClawPluginImpl();
      const { registerOpenClawPlugin } = require("../hooks/openclaw-install.js");
      const result = registerOpenClawPlugin({ silent: true });
      if (result.installed && result.updated) {
        console.log("Clawd: synced OpenClaw plugin");
      }
      return normalizeInstalledFlagResult(result, "OpenClaw", "openclaw-not-found");
    } catch (err) {
      console.warn("Clawd: failed to sync OpenClaw plugin:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync OpenClaw plugin" };
    }
  }

  function repairOpenClawPlugin() {
    try {
      if (typeof ctx.repairOpenClawPluginImpl === "function") return ctx.repairOpenClawPluginImpl();
      const { registerOpenClawPlugin } = require("../hooks/openclaw-install.js");
      const result = registerOpenClawPlugin({ silent: true, useCliFallback: true });
      if (result.status === "error" || result.installed === false) {
        return {
          status: "error",
          message: result.message || result.reason || "Failed to repair OpenClaw plugin",
        };
      }
      return { status: "ok", ...result, message: "OpenClaw plugin repaired" };
    } catch (err) {
      console.warn("Clawd: failed to repair OpenClaw plugin:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to repair OpenClaw plugin" };
    }
  }

  function syncHermesPlugin() {
    try {
      if (typeof ctx.syncHermesPluginImpl === "function") return ctx.syncHermesPluginImpl();
      const { isHermesInstalled, registerHermesPlugin } = require("../hooks/hermes-install.js");
      const installed = typeof ctx.isHermesInstalledImpl === "function"
        ? ctx.isHermesInstalledImpl()
        : isHermesInstalled();
      if (!installed) {
        return {
          status: "skipped",
          reason: "hermes-not-installed",
          message: "Hermes Agent is not installed; skipped plugin sync",
        };
      }
      const result = registerHermesPlugin({ silent: true });
      if (result && result.status === "error") {
        console.warn("Clawd: failed to sync Hermes plugin:", result.message);
        return result;
      }
      if (result && (result.installed > 0 || result.updated > 0)) {
        console.log(`Clawd: synced Hermes plugin (installed=${result.installed}, updated=${result.updated})`);
      }
      return asOk(result);
    } catch (err) {
      console.warn("Clawd: failed to sync Hermes plugin:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Hermes plugin" };
    }
  }

  function syncQoderHooks() {
    try {
      if (typeof ctx.syncQoderHooksImpl === "function") return ctx.syncQoderHooksImpl();
      const { registerQoderHooks } = require("../hooks/qoder-install.js");
      const result = registerQoderHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced Qoder hooks (added ${result.added}, updated ${result.updated})`);
      }
      return normalizeCountSyncResult(result, "Qoder", "qoder-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync Qoder hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Qoder hooks" };
    }
  }

  function syncCodewhaleHooks() {
    try {
      if (typeof ctx.syncCodewhaleHooksImpl === "function") return ctx.syncCodewhaleHooksImpl();
      const { registerCodewhaleHooks } = require("../hooks/codewhale-install.js");
      const result = registerCodewhaleHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced CodeWhale hooks (added ${result.added}, updated ${result.updated})`);
      }
      return normalizeCountSyncResult(result, "CodeWhale", "codewhale-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync CodeWhale hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync CodeWhale hooks" };
    }
  }

  function syncReasonixHooks() {
    try {
      if (typeof ctx.syncReasonixHooksImpl === "function") return ctx.syncReasonixHooksImpl();
      const { registerReasonixHooks } = require("../hooks/reasonix-install.js");
      const result = registerReasonixHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced Reasonix hooks (added ${result.added}, updated ${result.updated})`);
      }
      return normalizeCountSyncResult(result, "Reasonix", "reasonix-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync Reasonix hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Reasonix hooks" };
    }
  }

  function syncQoderWorkHooks() {
    try {
      if (typeof ctx.syncQoderWorkHooksImpl === "function") return ctx.syncQoderWorkHooksImpl();
      const { registerQoderWorkHooks } = require("../hooks/qoderwork-install.js");
      const result = registerQoderWorkHooks({ silent: true });
      if (hasPositiveCount(result.added) || hasPositiveCount(result.updated)) {
        console.log(`Clawd: synced QoderWork hooks (added ${result.added}, updated ${result.updated})`);
      }
      return normalizeCountSyncResult(result, "QoderWork", "qoderwork-not-installed");
    } catch (err) {
      console.warn("Clawd: failed to sync QoderWork hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync QoderWork hooks" };
    }
  }

  const AGENT_INTEGRATION_SYNCERS = Object.freeze({
    "gemini-cli": syncGeminiHooks,
    "antigravity-cli": syncAntigravityHooks,
    "cursor-agent": syncCursorHooks,
    "copilot-cli": syncCopilotHooks,
    codebuddy: syncCodeBuddyHooks,
    "kiro-cli": syncKiroHooks,
    "kimi-cli": syncKimiHooks,
    "qwen-code": syncQwenHooks,
    codewhale: syncCodewhaleHooks,
    codex: syncCodexHooks,
    opencode: syncOpencodePlugin,
    pi: syncPiExtension,
    openclaw: syncOpenClawPlugin,
    hermes: syncHermesPlugin,
    qoder: syncQoderHooks,
    reasonix: syncReasonixHooks,
    qoderwork: syncQoderWorkHooks,
  });

  const AGENT_INTEGRATION_REPAIRERS = Object.freeze({
    ...AGENT_INTEGRATION_SYNCERS,
    codex: repairCodexHooks,
    openclaw: repairOpenClawPlugin,
  });

  function syncIntegrationForAgent(agentId) {
    if (agentId === "claude-code") {
      if (!shouldManageClaudeHooks()) return false;
      const result = syncClawdHooks();
      startClaudeSettingsWatcher();
      return result && typeof result === "object" ? result : true;
    }
    const sync = AGENT_INTEGRATION_SYNCERS[agentId];
    if (typeof sync !== "function") return false;
    const result = sync();
    return result && typeof result === "object" ? result : true;
  }

  function repairIntegrationForAgent(agentId, options = {}) {
    if (agentId === "claude-code") {
      return syncIntegrationForAgent(agentId);
    }
    const repair = AGENT_INTEGRATION_REPAIRERS[agentId];
    if (typeof repair !== "function") return false;
    const result = repair(options);
    if (result && typeof result === "object" && typeof result.status === "string") return result;
    return true;
  }

  function stopIntegrationForAgent(agentId) {
    if (agentId !== "claude-code") return false;
    return stopClaudeSettingsWatcher();
  }

  function uninstallIntegrationForAgent(agentId) {
    try {
      if (
        ctx.uninstallIntegrationImpls
        && typeof ctx.uninstallIntegrationImpls === "object"
        && typeof ctx.uninstallIntegrationImpls[agentId] === "function"
      ) {
        if (agentId === "claude-code") stopClaudeSettingsWatcher();
        return ctx.uninstallIntegrationImpls[agentId]({ silent: true });
      }
      const {
        AGENT_CLEANERS,
        buildCleanupOptionsForHome,
      } = require("../hooks/cleanup-integrations.js");
      const uninstall = AGENT_CLEANERS && AGENT_CLEANERS[agentId];
      if (typeof uninstall !== "function") return false;
      if (agentId === "claude-code") stopClaudeSettingsWatcher();
      const cleanupOptions = ctx.cleanupOptions && typeof ctx.cleanupOptions === "object"
        ? ctx.cleanupOptions
        : {};
      const plan = buildCleanupOptionsForHome(ctx.cleanupHomeDir || ctx.homeDir, cleanupOptions);
      const agentOptions = plan.byAgent && plan.byAgent[agentId];
      if (!agentOptions) return false;
      const result = uninstall({ ...agentOptions, silent: true });
      return result && typeof result === "object" ? result : true;
    } catch (err) {
      console.warn(`Clawd: failed to uninstall ${agentId} integration:`, err.message);
      return {
        status: "error",
        message: err && err.message ? err.message : `Failed to uninstall ${agentId} integration`,
      };
    }
  }

  function syncEnabledStartupIntegrations() {
    if (shouldManageClaudeHooks() && shouldSyncAgentIntegration("claude-code")) {
      syncClawdHooks();
      startClaudeSettingsWatcher();
    }
    for (const [agentId, sync] of Object.entries(AGENT_INTEGRATION_SYNCERS)) {
      if (shouldSyncAgentIntegration(agentId)) sync();
    }
  }

  return {
    syncClawdHooks,
    syncGeminiHooks,
    syncAntigravityHooks,
    syncCursorHooks,
    syncCopilotHooks,
    syncCodeBuddyHooks,
    syncKiroHooks,
    syncKimiHooks,
    syncQwenHooks,
    syncCodewhaleHooks,
    syncCodexHooks,
    syncOpencodePlugin,
    syncPiExtension,
    syncOpenClawPlugin,
    syncHermesPlugin,
    syncQoderHooks,
    syncReasonixHooks,
    syncQoderWorkHooks,
    repairCodexHooks,
    repairOpenClawPlugin,
    syncIntegrationForAgent,
    repairIntegrationForAgent,
    stopIntegrationForAgent,
    uninstallIntegrationForAgent,
    syncEnabledStartupIntegrations,
  };
}

module.exports = {
  createIntegrationSyncRuntime,
};
