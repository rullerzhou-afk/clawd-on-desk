"use strict";

function createIntegrationSyncRuntime(options = {}) {
  const ctx = options.ctx || {};
  const getHookServerPort = options.getHookServerPort;
  const shouldManageClaudeHooks = options.shouldManageClaudeHooks;
  const isAgentEnabled = options.isAgentEnabled;
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
      const { registerHooks } = require("../hooks/install.js");
      const { added, updated, removed } = registerHooks({
        silent: true,
        autoStart: ctx.autoStartWithClaude,
        port: getHookServerPort(),
      });
      if (added > 0 || updated > 0 || removed > 0) {
        console.log(`Clawd: synced hooks (added ${added}, updated ${updated}, removed ${removed})`);
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
      const { added, updated } = registerGeminiHooks({ silent: true });
      if (added > 0 || updated > 0) {
        console.log(`Clawd: synced Gemini hooks (added ${added}, updated ${updated})`);
      }
      return { status: "ok", added, updated };
    } catch (err) {
      console.warn("Clawd: failed to sync Gemini hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Gemini hooks" };
    }
  }

  function syncCodeBuddyHooks() {
    try {
      if (typeof ctx.syncCodeBuddyHooksImpl === "function") return ctx.syncCodeBuddyHooksImpl();
      const { registerCodeBuddyHooks } = require("../hooks/codebuddy-install.js");
      const { added, updated } = registerCodeBuddyHooks({ silent: true });
      if (added > 0 || updated > 0) {
        console.log(`Clawd: synced CodeBuddy hooks (added ${added}, updated ${updated})`);
      }
      return { status: "ok", added, updated };
    } catch (err) {
      console.warn("Clawd: failed to sync CodeBuddy hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync CodeBuddy hooks" };
    }
  }

  function syncKiroHooks() {
    try {
      if (typeof ctx.syncKiroHooksImpl === "function") return ctx.syncKiroHooksImpl();
      const { registerKiroHooks } = require("../hooks/kiro-install.js");
      const { added, updated } = registerKiroHooks({ silent: true });
      if (added > 0 || updated > 0) {
        console.log(`Clawd: synced Kiro hooks (added ${added}, updated ${updated})`);
      }
      return { status: "ok", added, updated };
    } catch (err) {
      console.warn("Clawd: failed to sync Kiro hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Kiro hooks" };
    }
  }

  function syncKimiHooks() {
    try {
      if (typeof ctx.syncKimiHooksImpl === "function") return ctx.syncKimiHooksImpl();
      const { registerKimiHooks } = require("../hooks/kimi-install.js");
      const { added, updated } = registerKimiHooks({ silent: true });
      if (added > 0 || updated > 0) {
        console.log(`Clawd: synced Kimi hooks (added ${added}, updated ${updated})`);
      }
      return { status: "ok", added, updated };
    } catch (err) {
      console.warn("Clawd: failed to sync Kimi hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Kimi hooks" };
    }
  }

  function syncCodexHooks() {
    try {
      if (typeof ctx.syncCodexHooksImpl === "function") return ctx.syncCodexHooksImpl();
      const { registerCodexHooks } = require("../hooks/codex-install.js");
      const { added, updated, warnings } = registerCodexHooks({ silent: true });
      if (added > 0 || updated > 0) {
        console.log(`Clawd: synced Codex hooks (added ${added}, updated ${updated})`);
      }
      if (Array.isArray(warnings)) {
        for (const warning of warnings) console.warn(`Clawd: Codex hook sync warning: ${warning}`);
      }
      return { status: "ok", added, updated, warnings };
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
      const { added, updated } = registerCursorHooks({ silent: true });
      if (added > 0 || updated > 0) {
        console.log(`Clawd: synced Cursor hooks (added ${added}, updated ${updated})`);
      }
      return { status: "ok", added, updated };
    } catch (err) {
      console.warn("Clawd: failed to sync Cursor hooks:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Cursor hooks" };
    }
  }

  function syncOpencodePlugin() {
    try {
      if (typeof ctx.syncOpencodePluginImpl === "function") return ctx.syncOpencodePluginImpl();
      const { registerOpencodePlugin } = require("../hooks/opencode-install.js");
      const { added, created } = registerOpencodePlugin({ silent: true });
      if (added || created) {
        console.log(`Clawd: synced opencode plugin (added=${added}, created=${created})`);
      }
      return { status: "ok", added, created };
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
      return { status: "ok", ...result };
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
      return { status: "ok", ...result };
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
      return result && typeof result === "object" ? result : { status: "ok" };
    } catch (err) {
      console.warn("Clawd: failed to sync Hermes plugin:", err.message);
      return { status: "error", message: err && err.message ? err.message : "Failed to sync Hermes plugin" };
    }
  }

  const AGENT_INTEGRATION_SYNCERS = Object.freeze({
    "gemini-cli": syncGeminiHooks,
    "cursor-agent": syncCursorHooks,
    codebuddy: syncCodeBuddyHooks,
    "kiro-cli": syncKiroHooks,
    "kimi-cli": syncKimiHooks,
    codex: syncCodexHooks,
    opencode: syncOpencodePlugin,
    pi: syncPiExtension,
    openclaw: syncOpenClawPlugin,
    hermes: syncHermesPlugin,
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
    if (result && typeof result === "object" && result.status === "error") return result;
    if (result && typeof result === "object" && result.status === "ok") return result;
    return true;
  }

  function stopIntegrationForAgent(agentId) {
    if (agentId !== "claude-code") return false;
    return stopClaudeSettingsWatcher();
  }

  function syncEnabledStartupIntegrations() {
    if (shouldManageClaudeHooks() && isAgentEnabled("claude-code")) {
      syncClawdHooks();
      startClaudeSettingsWatcher();
    }
    for (const [agentId, sync] of Object.entries(AGENT_INTEGRATION_SYNCERS)) {
      if (isAgentEnabled(agentId)) sync();
    }
  }

  return {
    syncClawdHooks,
    syncGeminiHooks,
    syncCursorHooks,
    syncCodeBuddyHooks,
    syncKiroHooks,
    syncKimiHooks,
    syncCodexHooks,
    syncOpencodePlugin,
    syncPiExtension,
    syncOpenClawPlugin,
    syncHermesPlugin,
    repairCodexHooks,
    repairOpenClawPlugin,
    syncIntegrationForAgent,
    repairIntegrationForAgent,
    stopIntegrationForAgent,
    syncEnabledStartupIntegrations,
  };
}

module.exports = {
  createIntegrationSyncRuntime,
};
