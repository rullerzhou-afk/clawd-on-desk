"use strict";

const path = require("path");
const {
  normalizeHardwareBuddySettings,
  hardwareBuddySettingsEqual,
} = require("./hardware-buddy-settings");

function truthy(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function isEnabledFromEnv(env = process.env) {
  if (truthy(env.CLAWD_HARDWARE_BUDDY_DISABLED)) return false;
  if (truthy(env.CLAWD_HARDWARE_BUDDY)) return true;
  if (env.CLAWD_HARDWARE_BUDDY_BACKEND) return true;
  if (env.CLAWD_HARDWARE_BUDDY_ADDRESS) return true;
  return false;
}

const FALLBACK_QUICK_COMMAND_PRESETS = Object.freeze([
  Object.freeze({ id: "continue", label: "\u7ee7\u7eed" }),
  Object.freeze({ id: "correct", label: "\u4e0d\u662f\u8fd9\u6837\u7684" }),
  Object.freeze({ id: "no_commit", label: "\u4e0d\u8981 commit" }),
  Object.freeze({ id: "no_source_edits", label: "\u4e0d\u8981\u6539\u6e90\u6587\u4ef6" }),
  Object.freeze({ id: "show_diff", label: "show diff" }),
  Object.freeze({ id: "plain_language", label: "\u8bf4\u4eba\u8bdd" }),
  Object.freeze({ id: "plan_first", label: "\u5148\u5217\u8ba1\u5212" }),
]);
const FALLBACK_QUICK_COMMAND_PRESET_BY_ID = new Map(
  FALLBACK_QUICK_COMMAND_PRESETS.map((preset) => [preset.id, preset])
);
const FALLBACK_CONSTRAINT_COMMANDS = new Set(["no_commit", "no_source_edits"]);
const FALLBACK_QUICK_COMMAND_SOURCES = new Set(["tray", "hardware", "http", "cli", "test"]);

function quickCommandError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 400 });
}

function cloneQuickCommandPreset(preset) {
  return { id: preset.id, label: preset.label };
}

function normalizeQuickCommandString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeFallbackQuickCommand(input = {}) {
  const object = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const preset = FALLBACK_QUICK_COMMAND_PRESET_BY_ID.get(normalizeQuickCommandString(object.id));
  if (!preset) {
    throw quickCommandError(
      "invalid_quick_command",
      `unknown quick command preset: ${normalizeQuickCommandString(object.id) || "<empty>"}`
    );
  }
  const clientRequestId = normalizeQuickCommandString(object.clientRequestId);
  if (!clientRequestId) {
    throw quickCommandError("missing_client_request_id", "clientRequestId is required");
  }
  const targetInput = object.target && typeof object.target === "object" && !Array.isArray(object.target)
    ? object.target
    : { scope: object.scope, sessionId: object.sessionId };
  const scope = normalizeQuickCommandString(targetInput.scope) || "active_session";
  if (scope !== "active_session") {
    throw quickCommandError("invalid_quick_command_target", "quick command target.scope must be active_session");
  }
  const duration = normalizeQuickCommandString(object.duration);
  if (FALLBACK_CONSTRAINT_COMMANDS.has(preset.id)) {
    if (duration && duration !== "next_turn") {
      throw quickCommandError("invalid_quick_command_duration", "constraint quick command duration must be next_turn");
    }
  } else if (duration) {
    throw quickCommandError("invalid_quick_command_duration", "message quick command duration must be null");
  }
  const source = normalizeQuickCommandString(object.source).toLowerCase();
  const sessionId = normalizeQuickCommandString(targetInput.sessionId) || null;
  return {
    type: "quick_command",
    version: 1,
    id: preset.id,
    label: preset.label,
    target: {
      scope: "active_session",
      sessionId,
      resolution: sessionId ? "client_provided" : "defer_to_adapter",
    },
    duration: FALLBACK_CONSTRAINT_COMMANDS.has(preset.id) ? (duration || "next_turn") : null,
    source: FALLBACK_QUICK_COMMAND_SOURCES.has(source) ? source : "unknown",
    clientRequestId,
    userText: object.userText == null ? null : (normalizeQuickCommandString(object.userText) || null),
  };
}

class FallbackMemoryQuickCommandSink {
  constructor(options = {}) {
    this.maxRecords = Math.max(1, Math.floor(Number(options.maxRecords || 100)));
    this.dedupeMs = Math.max(0, Math.floor(Number(options.dedupeMs || 30000)));
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.records = [];
    this.nextSeq = 1;
    this.dedupe = new Map();
  }

  write(input = {}) {
    const now = this.now();
    for (const [key, entry] of this.dedupe.entries()) {
      if (!entry || entry.expiresAt <= now) this.dedupe.delete(key);
    }
    const normalized = normalizeFallbackQuickCommand(input);
    const existing = this.dedupeMs > 0 ? this.dedupe.get(normalized.clientRequestId) : null;
    if (existing && existing.expiresAt > now) {
      return { record: existing.record, duplicate: true };
    }
    const record = { seq: this.nextSeq, ...normalized, createdAt: now };
    this.nextSeq += 1;
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    if (this.dedupeMs > 0) {
      this.dedupe.set(record.clientRequestId, { record, expiresAt: now + this.dedupeMs });
    }
    return { record, duplicate: false };
  }

  list(options = {}) {
    const after = Math.max(0, Math.floor(Number(options.after || 0)));
    const limit = Math.max(1, Math.min(this.maxRecords, Math.floor(Number(options.limit || this.maxRecords))));
    const available = this.records.filter((record) => record.seq > after);
    const items = available.slice(0, limit);
    return {
      cursor: after,
      nextCursor: items.length ? items[items.length - 1].seq : after,
      latestSeq: this.records.length ? this.records[this.records.length - 1].seq : 0,
      oldestSeq: this.records.length ? this.records[0].seq : 0,
      hasMore: available.length > items.length,
      items,
    };
  }

  status() {
    return {
      type: "memory",
      size: this.records.length,
      maxRecords: this.maxRecords,
      dedupeMs: this.dedupeMs,
      nextSeq: this.nextSeq,
      oldestSeq: this.records.length ? this.records[0].seq : 0,
      latestSeq: this.records.length ? this.records[this.records.length - 1].seq : 0,
    };
  }

  stop() {
    this.records = [];
    this.dedupe.clear();
  }
}

function numberFromEnv(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function defaultCoreRoot(env = process.env) {
  return env.CLAWD_HARDWARE_BUDDY_ROOT
    || path.resolve(__dirname, "..", "..", "ClaudeBuddy");
}

function loadCoreModules(coreRoot) {
  const controllerPath = path.join(coreRoot, "src", "hardware-buddy", "controller.js");
  const sidecarPath = path.join(coreRoot, "src", "hardware-buddy", "sidecar-client.js");
  return {
    HardwareBuddyController: require(controllerPath).HardwareBuddyController,
    SidecarClient: require(sidecarPath).SidecarClient,
  };
}

function loadQuickCommandModules(coreRoot) {
  try {
    const presets = require(path.join(coreRoot, "src", "runtime", "quick-command-presets.js"));
    const sink = require(path.join(coreRoot, "src", "runtime", "memory-quick-command-sink.js"));
    return {
      QUICK_COMMAND_PRESETS: presets.QUICK_COMMAND_PRESETS,
      createMemoryQuickCommandSink: sink.createMemoryQuickCommandSink,
    };
  } catch {
    return {
      QUICK_COMMAND_PRESETS: FALLBACK_QUICK_COMMAND_PRESETS,
      createMemoryQuickCommandSink: (options) => new FallbackMemoryQuickCommandSink(options),
    };
  }
}

function defaultSidecarScript(coreRoot, env = process.env) {
  return env.CLAWD_HARDWARE_BUDDY_SIDECAR
    || path.join(coreRoot, "tools", "hardware_buddy_bridge.py");
}

function readSettings(options) {
  if (typeof options.getSettings === "function") return options.getSettings() || {};
  if (options.settings && typeof options.settings === "object") return options.settings;
  return null;
}

function readRuntimeConfig(options, env = process.env) {
  const settings = readSettings(options);
  const hasSettings = settings !== null;
  const config = normalizeHardwareBuddySettings(settings || {});
  if (!hasSettings) config.enabled = isEnabledFromEnv(env);

  if (truthy(env.CLAWD_HARDWARE_BUDDY_DISABLED)) config.enabled = false;
  else if (options.enabled != null) config.enabled = !!options.enabled;
  else if (truthy(env.CLAWD_HARDWARE_BUDDY)) config.enabled = true;

  if (options.permissionsEnabled != null) config.permissionsEnabled = !!options.permissionsEnabled;
  else if (truthy(env.CLAWD_HARDWARE_BUDDY_PERMISSIONS)) config.permissionsEnabled = true;

  if (options.quickCommandsEnabled != null) config.quickCommandsEnabled = !!options.quickCommandsEnabled;
  else if (truthy(env.CLAWD_HARDWARE_BUDDY_QUICK_COMMANDS) || truthy(env.CLAWD_QUICK_COMMANDS)) {
    config.quickCommandsEnabled = true;
  }
  if (truthy(env.CLAWD_HARDWARE_BUDDY_QUICK_COMMANDS_DISABLED) || truthy(env.CLAWD_QUICK_COMMANDS_DISABLED)) {
    config.quickCommandsEnabled = false;
  }

  if (env.CLAWD_HARDWARE_BUDDY_BACKEND) config.backend = env.CLAWD_HARDWARE_BUDDY_BACKEND;
  if (env.CLAWD_HARDWARE_BUDDY_ADDRESS) config.address = String(env.CLAWD_HARDWARE_BUDDY_ADDRESS).trim();
  if (env.CLAWD_HARDWARE_BUDDY_NAME_PREFIX) config.namePrefix = String(env.CLAWD_HARDWARE_BUDDY_NAME_PREFIX).trim();
  if (options.autoConnectAddress) config.address = String(options.autoConnectAddress).trim();

  config.backend = config.backend === "fake" ? "fake" : "bleak";
  if (!config.namePrefix) config.namePrefix = "Clawstick";
  config.autoConnectByNamePrefix = !config.address && (hasSettings || !!env.CLAWD_HARDWARE_BUDDY_NAME_PREFIX);
  return config;
}

function buildSidecarArgs(options) {
  const {
    env,
    coreRoot,
    config,
  } = options;
  const backend = config.backend || env.CLAWD_HARDWARE_BUDDY_BACKEND || "bleak";
  const args = [
    defaultSidecarScript(coreRoot, env),
    "--backend",
    backend,
  ];
  if (env.CLAWD_HARDWARE_BUDDY_SCAN_TIMEOUT) {
    args.push("--scan-timeout", String(env.CLAWD_HARDWARE_BUDDY_SCAN_TIMEOUT));
  }
  if (env.CLAWD_HARDWARE_BUDDY_CONNECT_TIMEOUT) {
    args.push("--connect-timeout", String(env.CLAWD_HARDWARE_BUDDY_CONNECT_TIMEOUT));
  }
  if (config.namePrefix) {
    args.push("--name-prefix", config.namePrefix);
  }
  if (backend === "fake"
    && /^(true|false)$/i.test(String(env.CLAWD_HARDWARE_BUDDY_FAKE_SECURE || "").trim())) {
    args.push("--fake-secure", String(env.CLAWD_HARDWARE_BUDDY_FAKE_SECURE).trim().toLowerCase());
  }
  return args;
}

function callSafely(fn, log) {
  try {
    return fn();
  } catch (err) {
    if (typeof log === "function") log(`callback failed: ${err && err.message ? err.message : err}`);
    return undefined;
  }
}

function classifyHardwareBuddyIssue(err) {
  const code = String((err && err.code) || "").trim();
  const message = String((err && err.message) || err || "").trim();
  const lower = message.toLowerCase();
  if (code === "MISSING_BLEAK") {
    return {
      code,
      category: "missing_bleak",
      retryable: false,
      message: message || "Python bleak dependency is missing",
      hint: "Install the Hardware Buddy sidecar requirements.",
    };
  }
  if (code === "AUTH_REQUIRED") {
    return {
      code,
      category: "auth_required",
      retryable: true,
      message: message || "BLE pairing is required",
      hint: "Pair the device in Windows Bluetooth settings.",
    };
  }
  if (code === "NO_DEVICE" || lower.includes("device not found")) {
    return {
      code: code || "NO_DEVICE",
      category: "device_not_found",
      retryable: true,
      message: message || "device not found",
      hint: "Make sure Bluetooth is on and the device is advertising.",
    };
  }
  if (code === "DISCONNECTED") {
    return {
      code,
      category: "transport_disconnected",
      retryable: true,
      message: message || "transport disconnected",
      hint: "Check Bluetooth and keep the device powered on.",
    };
  }
  if (code === "ENOENT" || lower.includes("spawn") && lower.includes("enoent")) {
    return {
      code: code || "ENOENT",
      category: "python_missing",
      retryable: false,
      message: message || "Python executable was not found",
      hint: "Install Python or configure CLAWD_HARDWARE_BUDDY_PYTHON.",
    };
  }
  if (code === "BAD_CONTROL" || code === "BAD_MESSAGE" || code === "BAD_SNAPSHOT") {
    return {
      code,
      category: "bad_config",
      retryable: false,
      message,
      hint: "Check the Hardware Buddy settings.",
    };
  }
  if (code === "SIDECAR_EXIT") {
    return {
      code,
      category: "sidecar_exited",
      retryable: true,
      message: message || "sidecar exited",
      hint: "The sidecar process stopped unexpectedly.",
    };
  }
  return {
    code: code || "SIDECAR_ERROR",
    category: "sidecar_error",
    retryable: true,
    message: message || "sidecar error",
    hint: "Hardware Buddy sidecar reported an error.",
  };
}

function createHardwareBuddyAdapter(options = {}) {
  const env = options.env || process.env;
  const log = typeof options.log === "function" ? options.log : () => {};
  const coreRoot = options.coreRoot || defaultCoreRoot(env);
  const keepaliveMs = numberFromEnv(env.CLAWD_HARDWARE_BUDDY_KEEPALIVE_MS, 10000);
  const autoConnectDelayMs = numberFromEnv(env.CLAWD_HARDWARE_BUDDY_CONNECT_DELAY_MS, 1000);
  const autoConnectRetryMs = numberFromEnv(env.CLAWD_HARDWARE_BUDDY_CONNECT_RETRY_MS, 15000);
  const autoConnectRetryMaxMs = numberFromEnv(env.CLAWD_HARDWARE_BUDDY_CONNECT_RETRY_MAX_MS, 120000);
  const quickCommandBufferSize = numberFromEnv(env.CLAWD_HARDWARE_BUDDY_QUICK_COMMAND_BUFFER_SIZE, 100);
  const quickCommandDedupeMs = numberFromEnv(env.CLAWD_HARDWARE_BUDDY_QUICK_COMMAND_DEDUPE_MS, 30000);
  const notifyDebounceMs = options.notifyDebounceMs != null
    ? numberFromEnv(options.notifyDebounceMs, 50)
    : numberFromEnv(env.CLAWD_HARDWARE_BUDDY_NOTIFY_DEBOUNCE_MS, 50);
  const logThrottleMs = numberFromEnv(env.CLAWD_HARDWARE_BUDDY_LOG_THROTTLE_MS, 60000);
  const setTimer = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const onStatusChanged = typeof options.onStatusChanged === "function"
    ? options.onStatusChanged
    : () => {};

  let controller = null;
  let sidecar = null;
  let started = false;
  let autoConnectTimer = null;
  let restartTimer = null;
  let stateNotifyTimer = null;
  let quickCommandSink = null;
  let quickCommandModules = null;
  let lastStatus = null;
  let lastDevices = [];
  let activeConfig = readRuntimeConfig(options, env);
  let retryAttempt = 0;
  let lastError = null;
  let lastPublishedStatus = "";
  const lastLogAt = new Map();

  function publishStatus(extra = {}) {
    const connected = !!(sidecar && sidecar.transport && sidecar.transport.connected === true);
    const secure = !!(sidecar && sidecar.transport && sidecar.transport.secure === true);
    const snapshot = {
      enabled: activeConfig.enabled === true,
      started,
      sidecarRunning: !!(sidecar && sidecar.started),
      backend: activeConfig.backend,
      address: activeConfig.address,
      namePrefix: activeConfig.namePrefix,
      permissionsEnabled: activeConfig.permissionsEnabled === true,
      quickCommands: {
        enabled: activeConfig.quickCommandsEnabled === true,
        sink: quickCommandSink && typeof quickCommandSink.status === "function"
          ? quickCommandSink.status()
          : { type: "none" },
      },
      connected,
      secure,
      lastStatus,
      lastDevices: lastDevices.slice(),
      lastError,
      retryAttempt,
      ...extra,
    };
    const encoded = JSON.stringify(snapshot);
    if (encoded === lastPublishedStatus) return snapshot;
    lastPublishedStatus = encoded;
    onStatusChanged(snapshot);
    return snapshot;
  }

  function throttledLog(key, message, meta) {
    const ts = now();
    const prev = lastLogAt.get(key) || 0;
    if (ts - prev < logThrottleMs) return;
    lastLogAt.set(key, ts);
    log(message, meta);
  }

  function getQuickCommandModules() {
    if (quickCommandModules) return quickCommandModules;
    if (options.quickCommandModules && typeof options.quickCommandModules === "object") {
      quickCommandModules = options.quickCommandModules;
    } else {
      quickCommandModules = loadQuickCommandModules(coreRoot);
    }
    if (!Array.isArray(quickCommandModules.QUICK_COMMAND_PRESETS)) {
      quickCommandModules.QUICK_COMMAND_PRESETS = FALLBACK_QUICK_COMMAND_PRESETS;
    }
    if (typeof quickCommandModules.createMemoryQuickCommandSink !== "function") {
      quickCommandModules.createMemoryQuickCommandSink = (sinkOptions) => new FallbackMemoryQuickCommandSink(sinkOptions);
    }
    return quickCommandModules;
  }

  function getQuickCommandPresets() {
    const modules = getQuickCommandModules();
    return {
      enabled: activeConfig.quickCommandsEnabled === true,
      presets: modules.QUICK_COMMAND_PRESETS.map(cloneQuickCommandPreset),
    };
  }

  function ensureQuickCommandSink() {
    if (activeConfig.quickCommandsEnabled !== true) return null;
    if (!quickCommandSink) {
      const modules = getQuickCommandModules();
      quickCommandSink = modules.createMemoryQuickCommandSink({
        maxRecords: quickCommandBufferSize,
        quickCommandBufferSize,
        dedupeMs: quickCommandDedupeMs,
        quickCommandDedupeMs,
        now,
        log: (_level, message) => log(`quick-command: ${message}`),
      });
    }
    return quickCommandSink;
  }

  function stopQuickCommandSink() {
    if (quickCommandSink && typeof quickCommandSink.stop === "function") {
      try {
        quickCommandSink.stop();
      } catch (err) {
        log(`quick-command stop failed: ${err && err.message ? err.message : err}`);
      }
    }
    quickCommandSink = null;
  }

  function syncQuickCommandSink() {
    if (activeConfig.quickCommandsEnabled === true) {
      ensureQuickCommandSink();
    } else {
      stopQuickCommandSink();
    }
  }

  function createQuickCommand(input = {}) {
    if (activeConfig.quickCommandsEnabled !== true) {
      return {
        status: "error",
        code: "quick_commands_disabled",
        message: "Quick Commands are disabled.",
      };
    }
    const sink = ensureQuickCommandSink();
    if (!sink || typeof sink.write !== "function") {
      return {
        status: "error",
        code: "quick_commands_unavailable",
        message: "Quick Commands are not configured.",
      };
    }
    try {
      const result = sink.write(input);
      publishStatus();
      return {
        status: "ok",
        quickCommand: result && result.record ? result.record : null,
        duplicate: !!(result && result.duplicate),
      };
    } catch (err) {
      return {
        status: "error",
        code: (err && err.code) || "quick_command_error",
        message: err && err.message ? err.message : String(err),
      };
    }
  }

  function listQuickCommands(options = {}) {
    if (activeConfig.quickCommandsEnabled !== true) {
      return {
        cursor: 0,
        nextCursor: 0,
        latestSeq: 0,
        oldestSeq: 0,
        hasMore: false,
        items: [],
      };
    }
    const sink = ensureQuickCommandSink();
    if (sink && typeof sink.list === "function") return sink.list(options);
    return {
      cursor: 0,
      nextCursor: 0,
      latestSeq: 0,
      oldestSeq: 0,
      hasMore: false,
      items: [],
    };
  }

  function clearAutoConnectTimer() {
    if (autoConnectTimer) clearTimer(autoConnectTimer);
    autoConnectTimer = null;
  }

  function clearRestartTimer() {
    if (restartTimer) clearTimer(restartTimer);
    restartTimer = null;
  }

  function isSidecarConnected() {
    return !!(sidecar && sidecar.transport && sidecar.transport.connected === true);
  }

  function retryDelay(issue) {
    if (!issue || !issue.retryable) return null;
    if (issue.category === "auth_required") return Math.max(autoConnectRetryMs, 60000);
    const attempt = Math.max(0, retryAttempt - 1);
    const delay = autoConnectRetryMs * Math.pow(2, Math.min(attempt, 4));
    return Math.max(autoConnectRetryMs, Math.min(delay, autoConnectRetryMaxMs));
  }

  function scheduleAutoConnect(delayMs) {
    if (autoConnectTimer || !started || !sidecar || isSidecarConnected()) return;
    if (!activeConfig.address && !activeConfig.autoConnectByNamePrefix) return;
    autoConnectTimer = setTimer(() => {
      autoConnectTimer = null;
      if (!started || !sidecar || isSidecarConnected()) return;
      try {
        if (activeConfig.address) {
          sidecar.connect(activeConfig.address);
        } else if (typeof sidecar.scan === "function") {
          sidecar.scan();
        } else {
          handleIssue({ code: "BAD_CONTROL", message: "Hardware Buddy sidecar does not support scan" });
        }
        publishStatus();
      } catch (err) {
        handleIssue(err);
      }
    }, delayMs);
    publishStatus({ nextRetryAt: now() + delayMs, retryDelayMs: delayMs });
  }

  function scheduleRestart(delayMs) {
    if (restartTimer || activeConfig.enabled !== true) return;
    restartTimer = setTimer(() => {
      restartTimer = null;
      if (!activeConfig.enabled) return;
      try {
        cleanupStartedParts({ keepConfig: true });
        start();
      } catch (err) {
        // start() records retryable startup failures and schedules the next
        // restart. The timer callback must never surface an uncaught exception
        // into Electron's main process.
        throttledLog("restart:failed", `restart failed: ${err && err.message ? err.message : err}`, err);
      }
    }, delayMs);
    publishStatus({ nextRetryAt: now() + delayMs, retryDelayMs: delayMs });
  }

  function handleIssue(err, { restart = false } = {}) {
    const issue = classifyHardwareBuddyIssue(err);
    retryAttempt += 1;
    lastError = {
      code: issue.code,
      category: issue.category,
      message: issue.message,
      hint: issue.hint,
      retryable: issue.retryable,
      at: now(),
    };
    throttledLog(`issue:${issue.category}:${issue.code}`, `sidecar ${issue.category}: ${issue.message}`, err);
    const delay = retryDelay(issue);
    publishStatus({ retryDelayMs: delay || 0, nextRetryAt: delay ? now() + delay : null });
    if (!delay) return;
    if (restart) scheduleRestart(delay);
    else scheduleAutoConnect(delay);
  }

  function clearStateNotifyTimer() {
    if (stateNotifyTimer) clearTimer(stateNotifyTimer);
    stateNotifyTimer = null;
  }

  function getPendingPermissions() {
    if (activeConfig.permissionsEnabled !== true) return [];
    if (typeof options.getPendingPermissions !== "function") return [];
    return callSafely(() => options.getPendingPermissions(), log) || [];
  }

  function emitStateChange() {
    stateNotifyTimer = null;
    if (!started || !controller || typeof controller.notifyStateChanged !== "function") return null;
    return controller.notifyStateChanged();
  }

  function cleanupStartedParts({ keepConfig = false } = {}) {
    clearAutoConnectTimer();
    clearRestartTimer();
    clearStateNotifyTimer();
    if (!keepConfig) retryAttempt = 0;
    started = false;
    if (controller && typeof controller.stop === "function") {
      try {
        controller.stop();
      } catch (err) {
        log(`controller stop failed: ${err && err.message ? err.message : err}`);
      }
    }
    if (sidecar && typeof sidecar.stop === "function") {
      try {
        sidecar.stop();
      } catch (err) {
        log(`sidecar stop failed: ${err && err.message ? err.message : err}`);
      }
    }
    controller = null;
    sidecar = null;
    publishStatus();
  }

  function connectFirstMatchingDevice(items) {
    if (!started || !sidecar || isSidecarConnected() || activeConfig.address || !activeConfig.autoConnectByNamePrefix) return false;
    const prefix = activeConfig.namePrefix || "";
    const match = (Array.isArray(items) ? items : []).find((item) => {
      if (!prefix) return true;
      return typeof item.name === "string" && item.name.startsWith(prefix);
    });
    if (!match) {
      if (!autoConnectTimer) {
        handleIssue({ code: "NO_DEVICE", message: "device not found" });
      }
      return false;
    }
    retryAttempt = 0;
    lastError = null;
    clearAutoConnectTimer();
    if (match.address) return sidecar.connect({ address: match.address });
    if (match.id) return sidecar.connect({ id: match.id });
    return sidecar.connect({ name: match.name });
  }

  function createSidecar(SidecarClient) {
    return new SidecarClient({
      command: options.command || env.CLAWD_HARDWARE_BUDDY_PYTHON || "python",
      args: options.args || buildSidecarArgs({ env, coreRoot, config: activeConfig }),
      log: (level, message, meta) => {
        if (/^sidecar exited\b/.test(String(message || ""))) {
          handleIssue({ code: "SIDECAR_EXIT", message }, { restart: true });
          return;
        }
        throttledLog(`log:${level}:${message}`, `sidecar ${level}: ${message}`, meta);
      },
      onStatus: (status) => {
        lastStatus = status;
        if (status && status.connected === true) retryAttempt = 0;
        publishStatus();
      },
      onDevices: (items) => {
        lastDevices = Array.isArray(items) ? items.slice() : [];
        publishStatus();
        connectFirstMatchingDevice(lastDevices);
      },
      onError: (err) => {
        handleIssue(err);
      },
      onTransportStateChanged: (state) => {
        if (state && state.connected === true) {
          retryAttempt = 0;
          clearAutoConnectTimer();
          lastError = null;
        } else if (!restartTimer && state && state.previous && state.previous.connected === true) {
          handleIssue({ code: "DISCONNECTED", message: "transport disconnected" });
        }
        publishStatus();
        // Link security/connectivity changes must retract or restore prompt fields immediately.
        if (controller && typeof controller.notifyStateChanged === "function") {
          controller.notifyStateChanged();
        }
      },
    });
  }

  function createController(HardwareBuddyController) {
    return new HardwareBuddyController({
      transport: sidecar && sidecar.transport,
      getSessionSnapshot: () => callSafely(options.getSessionSnapshot || (() => ({ sessions: [] })), log) || { sessions: [] },
      getPendingPermissions,
      getDoNotDisturb: () => !!callSafely(options.getDoNotDisturb || (() => false), log),
      isAgentEnabled: options.isAgentEnabled,
      isAgentPermissionsEnabled: options.isAgentPermissionsEnabled,
      resolvePermissionEntry: activeConfig.permissionsEnabled && typeof options.resolvePermissionEntry === "function"
        ? options.resolvePermissionEntry
        : null,
      statePriority: options.statePriority,
      keepaliveMs,
      log: (message) => log(`controller: ${message}`),
    });
  }

  function stopController() {
    if (controller && typeof controller.stop === "function") {
      try {
        controller.stop();
      } catch (err) {
        log(`controller stop failed: ${err && err.message ? err.message : err}`);
      }
    }
    controller = null;
  }

  function rebuildControllerForCurrentTransport(HardwareBuddyController) {
    stopController();
    controller = createController(HardwareBuddyController);
    controller.start();
    publishStatus();
    return true;
  }

  function start() {
    if (started) return true;
    activeConfig = readRuntimeConfig(options, env);
    syncQuickCommandSink();
    if (!activeConfig.enabled) {
      publishStatus();
      return false;
    }

    try {
      const modules = options.coreModules || loadCoreModules(coreRoot);
      const HardwareBuddyController = options.HardwareBuddyController || modules.HardwareBuddyController;
      const SidecarClient = options.SidecarClient || modules.SidecarClient;
      if (typeof HardwareBuddyController !== "function" || typeof SidecarClient !== "function") {
        throw new Error("Hardware Buddy core modules are unavailable");
      }
      if (activeConfig.permissionsEnabled && typeof options.resolvePermissionEntry !== "function") {
        log("permissions requested but resolvePermissionEntry is unavailable; hardware permission replies will be ignored");
      }

      sidecar = createSidecar(SidecarClient);
      controller = createController(HardwareBuddyController);

      sidecar.start();
      controller.start();
      started = true;
    } catch (err) {
      cleanupStartedParts({ keepConfig: true });
      handleIssue(err, { restart: true });
      throw err;
    }
    log(`started backend=${activeConfig.backend} permissions=${activeConfig.permissionsEnabled ? "on" : "off"}`);
    publishStatus();

    if (activeConfig.address || activeConfig.autoConnectByNamePrefix) {
      scheduleAutoConnect(autoConnectDelayMs);
    }
    return true;
  }

  function stop() {
    cleanupStartedParts();
    stopQuickCommandSink();
    publishStatus();
  }

  function applySettingsChange(nextSettings) {
    const previous = activeConfig;
    if (nextSettings !== undefined) {
      options.settings = nextSettings;
      options.getSettings = null;
    }
    const nextOptions = nextSettings === undefined ? options : { ...options, settings: nextSettings, getSettings: null };
    const next = readRuntimeConfig(nextOptions, env);
    const connectionChanged = previous.backend !== next.backend
      || previous.address !== next.address
      || previous.namePrefix !== next.namePrefix;
    const permissionChanged = previous.permissionsEnabled !== next.permissionsEnabled;
    const quickCommandChanged = previous.quickCommandsEnabled !== next.quickCommandsEnabled;
    activeConfig = next;
    if (quickCommandChanged) syncQuickCommandSink();

    if (!next.enabled) {
      if (started) cleanupStartedParts({ keepConfig: true });
      publishStatus();
      return next.quickCommandsEnabled === true;
    }
    if (!started) return start();
    if (connectionChanged) {
      cleanupStartedParts({ keepConfig: true });
      return start();
    }
    if (permissionChanged) {
      // The bridge-core controller captures resolvePermissionEntry at construction
      // time, so permission opt-in changes need a fresh controller. Keep the
      // sidecar and BLE link alive; only the approval plumbing changes.
      const modules = options.coreModules || loadCoreModules(coreRoot);
      const HardwareBuddyController = options.HardwareBuddyController || modules.HardwareBuddyController;
      if (activeConfig.permissionsEnabled && typeof options.resolvePermissionEntry !== "function") {
        log("permissions requested but resolvePermissionEntry is unavailable; hardware permission replies will be ignored");
      }
      return rebuildControllerForCurrentTransport(HardwareBuddyController);
    }
    publishStatus();
    return true;
  }

  function notifyStateChanged() {
    // Session-state broadcasts are debounced; transport security/connectivity
    // changes use onTransportStateChanged above so prompt fields retract fast.
    if (!started || !controller || typeof controller.notifyStateChanged !== "function") return null;
    if (notifyDebounceMs <= 0) return emitStateChange();
    if (stateNotifyTimer) return true;
    stateNotifyTimer = setTimer(() => {
      emitStateChange();
    }, notifyDebounceMs);
    return true;
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
    createQuickCommand,
    getQuickCommandPresets,
    listQuickCommands,
    isEnabled: () => activeConfig.enabled === true,
    isStarted: () => started,
    getLastStatus: () => lastStatus,
    getLastDevices: () => lastDevices.slice(),
    getStatus: () => publishStatus(),
    getController: () => controller,
    getSidecar: () => sidecar,
  };
}

module.exports = {
  createHardwareBuddyAdapter,
  isEnabledFromEnv,
  classifyHardwareBuddyIssue,
  readRuntimeConfig,
  hardwareBuddySettingsEqual,
};
