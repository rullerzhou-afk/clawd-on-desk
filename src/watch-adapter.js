"use strict";

const fs = require("fs");
const path = require("path");
const { WatchSidecarClient } = require("./watch-sidecar-client");
const { WatchController } = require("./watch-controller");
const { normalizeWatchSettings } = require("./watch-settings");

function truthy(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function resolveWatchBridgeScript(env = process.env) {
  if (env.CLAWD_WATCH_BUDDY_SIDECAR) return env.CLAWD_WATCH_BUDDY_SIDECAR;
  const packaged = typeof process !== "undefined" && process.resourcesPath
    ? path.join(process.resourcesPath, "sidecars", "watch-bridge", "watch_buddy_bridge.py")
    : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "..", "scripts", "watch_buddy_bridge.py");
}

function classifyWatchIssue(err) {
  const code = String((err && err.code) || "").trim();
  const message = String((err && err.message) || err || "").trim();
  const lower = message.toLowerCase();
  if (code === "MISSING_BLEAK") {
    return { code, category: "missing_bleak", retryable: false, message, hint: "Python bleak package is required. Use the Install button." };
  }
  if (code === "DISCONNECTED") {
    return { code, category: "disconnected", retryable: true, message, hint: "Check Bluetooth and keep the watch powered on." };
  }
  if (code === "ENOENT" || (lower.includes("spawn") && lower.includes("enoent"))) {
    return { code: "PYTHON_MISSING", category: "python_missing", retryable: false, message, hint: "Python3 is not installed." };
  }
  if (code === "SIDECAR_EXIT") {
    return { code, category: "sidecar_exited", retryable: true, message, hint: "The watch bridge stopped unexpectedly." };
  }
  return { code: code || "WATCH_ERROR", category: "watch_error", retryable: true, message, hint: "Watch bridge reported an error." };
}

function watchApprovalId(perm) {
  const sid = (perm.sessionId || "").slice(-8);
  const tool = perm.toolName || perm.tool || "";
  const ts = perm.createdAt || 0;
  return `${sid}:${tool}:${ts}`;
}

function createWatchAdapter(options = {}) {
  const env = options.env || process.env;
  const log = typeof options.log === "function" ? options.log : () => {};
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const onStatusChanged = typeof options.onStatusChanged === "function" ? options.onStatusChanged : () => {};
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;

  let sidecar = null;
  let controller = null;
  let started = false;
  let lastError = null;
  let retryAttempt = 0;
  let restartTimer = null;
  let activeConfig = readConfig();

  function readConfig() {
    const settings = typeof options.getSettings === "function" ? options.getSettings() : null;
    const config = normalizeWatchSettings(settings || {});
    if (settings === null || settings === undefined) {
      if (truthy(env.CLAWD_WATCH_ENABLED)) config.enabled = true;
    }
    if (truthy(env.CLAWD_WATCH_DISABLED)) config.enabled = false;
    if (env.CLAWD_WATCH_ADDRESS) {
      const addr = String(env.CLAWD_WATCH_ADDRESS).trim().slice(0, 120);
      if (addr && !/[\x00-\x1f\x7f]/.test(addr)) config.address = addr;
    }
    if (env.CLAWD_WATCH_NAME_PREFIX) {
      const prefix = String(env.CLAWD_WATCH_NAME_PREFIX).trim().slice(0, 40);
      if (prefix && !/[\x00-\x1f\x7f]/.test(prefix)) config.namePrefix = prefix;
    }
    return config;
  }

  function publishStatus(extra = {}) {
    const connected = !!(sidecar && sidecar.transport && sidecar.transport.connected);
    const snapshot = {
      enabled: activeConfig.enabled,
      started,
      connected,
      address: activeConfig.address,
      namePrefix: activeConfig.namePrefix,
      permissionsEnabled: activeConfig.permissionsEnabled,
      lastError,
      retryAttempt,
      ...extra,
    };
    onStatusChanged(snapshot);
    return snapshot;
  }

  function handleIssue(err, { restart = false } = {}) {
    const issue = classifyWatchIssue(err);
    retryAttempt += 1;
    const isSetupError = lastError && (lastError.category === "missing_bleak" || lastError.category === "python_missing");
    const isFollowup = issue.category === "sidecar_exited" || issue.category === "disconnected";
    const keepPrevious = isSetupError && isFollowup;
    if (!keepPrevious) {
      lastError = { code: issue.code, category: issue.category, message: issue.message, hint: issue.hint, retryable: issue.retryable, at: now() };
    }
    log(`watch ${issue.category}: ${issue.message}`);
    publishStatus();
    if (!issue.retryable) return;
    if (restart) scheduleRestart(Math.min(15000 * Math.pow(2, Math.min(retryAttempt - 1, 4)), 120000));
  }

  function scheduleRestart(delayMs) {
    if (restartTimer || !activeConfig.enabled) return;
    restartTimer = setTimer(() => {
      restartTimer = null;
      if (!activeConfig.enabled) return;
      try { cleanup({ keepConfig: true }); start(); } catch (err) { log(`restart failed: ${err.message || err}`); }
    }, delayMs);
  }

  function cleanup({ keepConfig = false } = {}) {
    if (restartTimer) { clearTimer(restartTimer); restartTimer = null; }
    if (!keepConfig) retryAttempt = 0;
    started = false;
    if (controller && typeof controller.stop === "function") { try { controller.stop(); } catch (_) {} }
    if (sidecar && typeof sidecar.stop === "function") { try { sidecar.stop(); } catch (_) {} }
    controller = null;
    sidecar = null;
    publishStatus();
  }

  function start() {
    if (started) return true;
    activeConfig = readConfig();
    if (!activeConfig.enabled) { publishStatus(); return false; }

    const python = env.CLAWD_HARDWARE_BUDDY_PYTHON || env.CLAWD_WATCH_PYTHON || "python";
    const script = resolveWatchBridgeScript(env);
    const args = [script, "--backend", "watch"];
    if (activeConfig.namePrefix) args.push("--name-prefix", activeConfig.namePrefix);
    if (activeConfig.address) args.push("--address", activeConfig.address);

    const sidecarOptions = {
      command: python,
      args,
      spawnOptions: { env: { ...process.env, PYTHONIOENCODING: "utf-8:replace" } },
      log: (level, message) => {
        if (/^sidecar exited\b/.test(String(message || ""))) {
          handleIssue({ code: "SIDECAR_EXIT", message }, { restart: true });
          return;
        }
        log(`bridge ${level}: ${message}`);
      },
      onStatus: (status) => {
        if (status && status.connected === true) retryAttempt = 0;
        publishStatus();
      },
      onDevices: () => publishStatus(),
      onError: (err) => handleIssue(err),
      onTransportStateChanged: (state) => {
        if (state && state.connected === true) {
          retryAttempt = 0;
          lastError = null;
          if (controller && typeof controller.resetDedup === "function") controller.resetDedup();
        } else if (state && state.previous && state.previous.connected === true) {
          handleIssue({ code: "DISCONNECTED", message: "transport disconnected" });
        }
        publishStatus();
        if (controller && typeof controller.notifyStateChanged === "function") controller.notifyStateChanged();
      },
      onApprovalResponse: (msg) => {
        if (!msg || !msg.requestId) return;
        if (!activeConfig.permissionsEnabled) return;
        const resolve = typeof options.resolvePermissionEntry === "function" ? options.resolvePermissionEntry : null;
        const getPerms = typeof options.getPendingPermissions === "function" ? options.getPendingPermissions : null;
        if (!resolve || !getPerms) return;
        const perms = getPerms();
        const match = perms.find((p) => watchApprovalId(p) === msg.requestId);
        if (match) {
          const decision = (msg.decision || "").startsWith("allow") ? "allow" : "deny";
          try { resolve(match, decision); } catch (_) {}
        }
      },
    };
    sidecar = typeof options.createSidecar === "function"
      ? options.createSidecar(sidecarOptions)
      : new WatchSidecarClient(sidecarOptions);

    controller = new WatchController({
      transport: sidecar.transport,
      getSessionSnapshot: options.getSessionSnapshot || (() => ({ sessions: [] })),
      getCurrentState: options.getCurrentState || (() => "idle"),
      getCurrentSvg: options.getCurrentSvg || (() => null),
      getPendingPermissions: () => activeConfig.permissionsEnabled
        ? (typeof options.getPendingPermissions === "function" ? options.getPendingPermissions() : [])
        : [],
      buildApprovalId: watchApprovalId,
      keepaliveMs: 10000,
      log: (message) => log(`controller: ${message}`),
    });

    sidecar.start();
    controller.start();
    started = true;
    log(`started namePrefix=${activeConfig.namePrefix}`);
    publishStatus();
    return true;
  }

  function stop() {
    cleanup();
    publishStatus();
  }

  function applySettingsChange(nextSettings) {
    const previous = activeConfig;
    activeConfig = readConfig();
    if (!activeConfig.enabled) { if (started) cleanup({ keepConfig: true }); publishStatus(); return; }
    if (!started) { start(); return; }
    const connectionChanged = previous.address !== activeConfig.address || previous.namePrefix !== activeConfig.namePrefix;
    if (connectionChanged) { cleanup({ keepConfig: true }); start(); }
    publishStatus();
  }

  function notifyStateChanged() {
    if (!started || !controller || typeof controller.notifyStateChanged !== "function") return null;
    return controller.notifyStateChanged();
  }

  function notifyPermissionsChanged() {
    if (!started || !controller || typeof controller.notifyPermissionsChanged !== "function") return null;
    return controller.notifyPermissionsChanged();
  }

  return {
    start,
    stop,
    applySettingsChange,
    notifyStateChanged,
    notifyPermissionsChanged,
    isEnabled: () => activeConfig.enabled,
    isStarted: () => started,
    getStatus: () => publishStatus(),
  };
}

module.exports = { createWatchAdapter, classifyWatchIssue, watchApprovalId };
