"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { buildPermissionUrl } = require("../hooks/server-config");
const {
  getClaudeHookScriptPath,
  getClaudeAutoStartScriptPath,
  CLAUDE_CORE_HOOK_EVENTS,
} = require("../hooks/install");
const {
  inspectClaudeHookHealth,
  buildClaudeRepairSignature,
  hasNoAutomaticRepairWork,
  reportHasUnparseableCommand,
} = require("./claude-hook-health");

const HOOK_MARKER = "clawd-hook.js";
const SETTINGS_FILENAME = "settings.json";
const MANAGED_COMMAND_MARKERS = Object.freeze([
  HOOK_MARKER,
  "auto-start.js",
  "auto-start.sh",
]);

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_REPAIR_RETRY_DELAYS_MS = Object.freeze([5000, 30000]);
const DEFAULT_UNSTABLE_RECHECK_MS = 2000;
const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
const MAX_EXPOSED_ISSUES = 20;

function entriesContainCommandMarker(entries, marker) {
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.command === "string" && entry.command.includes(marker)) return true;
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || typeof hook !== "object") continue;
      if (typeof hook.command === "string" && hook.command.includes(marker)) return true;
    }
  }
  return false;
}

function entriesContainHttpHookUrl(entries, expectedUrl) {
  if (!Array.isArray(entries) || !expectedUrl) return false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "http" && entry.url === expectedUrl) return true;
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || typeof hook !== "object") continue;
      if (hook.type === "http" && hook.url === expectedUrl) return true;
    }
  }
  return false;
}

function settingsNeedClaudeHookResync(rawSettings, expectedPermissionUrl) {
  if (typeof rawSettings !== "string" || !rawSettings.trim()) return false;

  let parsed;
  try {
    parsed = JSON.parse(rawSettings);
  } catch {
    return false;
  }

  const hooks = parsed && typeof parsed === "object" ? parsed.hooks : null;
  if (!hooks || typeof hooks !== "object") return true;

  const hasManagedCommandHook = Object.values(hooks).some((entries) => (
    entriesContainCommandMarker(entries, HOOK_MARKER)
  ));
  const hasManagedPermissionHook = entriesContainHttpHookUrl(hooks.PermissionRequest, expectedPermissionUrl);
  return !hasManagedCommandHook || !hasManagedPermissionHook;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandContainsMarkerToken(command, marker) {
  if (typeof command !== "string" || typeof marker !== "string" || !marker) return false;
  const pattern = new RegExp(`(^|[^A-Za-z0-9._-])${escapeRegExp(marker)}($|[^A-Za-z0-9._-])`);
  return pattern.test(command);
}

function commandContainsAnyMarker(command, markers) {
  return typeof command === "string"
    && Array.isArray(markers)
    && markers.some((marker) => commandContainsMarkerToken(command, marker));
}

function countCommandHooksInEntries(entries, options = {}) {
  if (!Array.isArray(entries)) return 0;
  const excludeMarkers = Array.isArray(options.excludeMarkers) ? options.excludeMarkers : null;
  let count = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "http") continue;
    if (typeof entry.command === "string" && !commandContainsAnyMarker(entry.command, excludeMarkers)) count += 1;
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (!hook || typeof hook !== "object") continue;
      if (hook.type === "http") continue;
      if (typeof hook.command === "string" && !commandContainsAnyMarker(hook.command, excludeMarkers)) count += 1;
    }
  }
  return count;
}

/**
 * Count total command hooks across every event in the hooks object.
 * Handles both nested format (entry.hooks[].command) and flat format (entry.command).
 * HTTP hooks (type: "http") are excluded because they cannot encode the marker.
 * TODO: Decide whether non-Clawd HTTP hooks should contribute to third-party shrink detection.
 * @param {object|null|undefined} hooks
 * @returns {number}
 */
function countAllHooks(hooks, options = {}) {
  if (!hooks || typeof hooks !== "object") return 0;
  let total = 0;
  for (const entries of Object.values(hooks)) {
    total += countCommandHooksInEntries(entries, options);
  }
  return total;
}

function countThirdPartyHooks(hooks) {
  return countAllHooks(hooks, { excludeMarkers: MANAGED_COMMAND_MARKERS });
}

/**
 * Capture a snapshot of top-level key count and command hook counts from settings.json text.
 * Returns null when the payload is not a parseable JSON object so callers can skip comparisons.
 * @param {string} raw
 * @returns {{keyCount: number, hookCount: number, thirdPartyHookCount: number}|null}
 */
function takeSnapshot(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return {
    keyCount: Object.keys(parsed).length,
    hookCount: countAllHooks(parsed.hooks),
    thirdPartyHookCount: countThirdPartyHooks(parsed.hooks),
  };
}

/**
 * Decide whether the shrink between two snapshots looks suspicious.
 * Two independent OR triggers — third-party hook drop ratio reaches shrinkRatio, or top-level key drop reaches keyLossThreshold.
 * Either snapshot missing returns false because insufficient history cannot prove an attack.
 * @param {{keyCount: number, hookCount: number, thirdPartyHookCount?: number}|null} prev
 * @param {{keyCount: number, hookCount: number, thirdPartyHookCount?: number}|null} curr
 * @param {number} shrinkRatio
 * @param {number} keyLossThreshold
 * @returns {boolean}
 */
function isSuspiciousShrink(prev, curr, shrinkRatio, keyLossThreshold) {
  if (!prev || !curr) return false;
  const keyDrop = prev.keyCount - curr.keyCount;
  if (keyDrop >= keyLossThreshold) return true;
  const prevThirdPartyHookCount = Number.isFinite(prev.thirdPartyHookCount) ? prev.thirdPartyHookCount : 0;
  const currThirdPartyHookCount = Number.isFinite(curr.thirdPartyHookCount) ? curr.thirdPartyHookCount : 0;
  if (prevThirdPartyHookCount <= 0) return false;
  const hookDrop = prevThirdPartyHookCount - currThirdPartyHookCount;
  if (hookDrop <= 0) return false;
  return (hookDrop / prevThirdPartyHookCount) >= shrinkRatio;
}

function initialHealthStatus(nowFn) {
  return {
    status: "stopped",
    degradedReason: null,
    at: nowFn(),
    lastCheckAt: null,
    lastSuccessAt: null,
    source: null,
    attempt: 0,
    issueSignature: null,
    nextCheckAt: null,
    issues: [],
    message: null,
  };
}

/**
 * Extends the directory watcher into a full supervisor: fs.watch stays
 * directory-scoped (atomic replace breaks file-level watches on Windows —
 * see AGENTS.md), and now additionally runs a low-frequency, read-only health
 * audit that does not depend on any settings.json fs event ever firing (#657).
 *
 * runHealthCheck() is the single decision function shared by both the fs
 * watcher's debounced callback and the periodic timer — see §6.6 of the
 * #657 plan. It never writes settings.json itself; repair is delegated to
 * ctx.syncClawdHooks(), which in production routes through the server-owned
 * Claude hook operation queue (src/claude-hook-operations.js).
 */
function createClaudeSettingsWatcher(ctx = {}) {
  const fsApi = ctx.fs || fs;
  const pathApi = ctx.path || path;
  const osApi = ctx.os || os;
  const setTimeoutFn = ctx.setTimeout || setTimeout;
  const clearTimeoutFn = ctx.clearTimeout || clearTimeout;
  const nowFn = typeof ctx.now === "function" ? ctx.now : Date.now;
  const settingsWatchDebounceMs = Number.isFinite(ctx.settingsWatchDebounceMs) ? ctx.settingsWatchDebounceMs : 1000;
  const suspiciousShrinkRatio = Number.isFinite(ctx.suspiciousShrinkRatio) ? ctx.suspiciousShrinkRatio : 0.5;
  const suspiciousKeyLossThreshold = Number.isFinite(ctx.suspiciousKeyLossThreshold) ? ctx.suspiciousKeyLossThreshold : 3;
  const healthCheckIntervalMs = Number.isFinite(ctx.healthCheckIntervalMs) ? ctx.healthCheckIntervalMs : DEFAULT_HEALTH_CHECK_INTERVAL_MS;
  const repairRetryDelaysMs = Array.isArray(ctx.repairRetryDelaysMs) && ctx.repairRetryDelaysMs.length
    ? ctx.repairRetryDelaysMs
    : DEFAULT_REPAIR_RETRY_DELAYS_MS;
  const unstableRecheckMs = Number.isFinite(ctx.unstableRecheckMs) ? ctx.unstableRecheckMs : DEFAULT_UNSTABLE_RECHECK_MS;
  const maxRepairAttempts = Number.isInteger(ctx.maxRepairAttempts) && ctx.maxRepairAttempts > 0
    ? ctx.maxRepairAttempts
    : DEFAULT_MAX_REPAIR_ATTEMPTS;
  const expectedHookScriptPath = typeof ctx.expectedHookScriptPath === "string"
    ? ctx.expectedHookScriptPath
    : getClaudeHookScriptPath();
  const expectedAutoStartScriptPath = typeof ctx.expectedAutoStartScriptPath === "string"
    ? ctx.expectedAutoStartScriptPath
    : getClaudeAutoStartScriptPath();
  const coreEvents = Array.isArray(ctx.coreEvents) ? ctx.coreEvents : CLAUDE_CORE_HOOK_EVENTS;
  const platform = ctx.platform || process.platform;

  let settingsWatcher = null;
  let settingsWatchDebounceTimer = null;
  let healthTimer = null;
  let lastTrustedSnapshot = null;
  let lifecycleToken = 0;
  let checkInFlight = false;
  let unreadableStreak = 0;
  let sourceMissingLogged = false;
  let shrinkNotified = false;
  // { signature, attempts, manualFixRequired } for the currently tracked
  // automatically-repairable issue set, or null when nothing is being retried.
  let repairState = null;
  let healthStatus = initialHealthStatus(nowFn);

  function getClaudeSettingsDir() {
    return typeof ctx.claudeSettingsDir === "string"
      ? ctx.claudeSettingsDir
      : pathApi.join(osApi.homedir(), ".claude");
  }

  function getClaudeSettingsPath() {
    return typeof ctx.claudeSettingsPath === "string"
      ? ctx.claudeSettingsPath
      : pathApi.join(getClaudeSettingsDir(), SETTINGS_FILENAME);
  }

  function updateHealthStatus(patch) {
    healthStatus = { ...healthStatus, ...patch, at: nowFn() };
  }

  function passesGates() {
    if (typeof ctx.shouldManageClaudeHooks === "function" && !ctx.shouldManageClaudeHooks()) return false;
    if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("claude-code")) return false;
    if (typeof ctx.shouldSyncAgentIntegration === "function" && !ctx.shouldSyncAgentIntegration("claude-code")) return false;
    return true;
  }

  function clearHealthTimer() {
    if (healthTimer) {
      clearTimeoutFn(healthTimer);
      healthTimer = null;
    }
  }

  // Self-scheduling setTimeout (never setInterval): the delay depends on the
  // outcome of the check that just ran, and a fresh check must never overlap
  // one that's still in flight (see checkInFlight in runHealthCheck).
  function scheduleHealthCheck(delayMs, reason) {
    clearHealthTimer();
    const tokenAtSchedule = lifecycleToken;
    healthStatus = { ...healthStatus, nextCheckAt: nowFn() + delayMs };
    healthTimer = setTimeoutFn(() => {
      healthTimer = null;
      // stop() bumps the token; a timer that fires after stop() (already
      // queued when stop() ran) must not resurrect any work or state.
      if (tokenAtSchedule !== lifecycleToken) return;
      runHealthCheck(reason).catch(() => {});
    }, delayMs);
  }

  function repairSourceForReason(reason) {
    return reason === "settings-event" ? "settings-watch" : "periodic-health";
  }

  function readSettingsRaw() {
    try {
      return fsApi.readFileSync(getClaudeSettingsPath(), "utf-8");
    } catch {
      return "";
    }
  }

  function buildReport(raw) {
    const port = typeof ctx.getHookServerPort === "function" ? ctx.getHookServerPort() : null;
    return inspectClaudeHookHealth(raw, {
      expectedPermissionUrl: buildPermissionUrl(port),
      expectedHookScriptPath,
      expectedAutoStartScriptPath,
      requireAutoStart: !!ctx.autoStartWithClaude,
      coreEvents,
      platform,
      fs: fsApi,
    });
  }

  async function runHealthCheck(reason) {
    // Only one health check in flight at a time — a settings-event trigger
    // arriving mid-check is dropped; the in-flight check's own reschedule
    // picks up any drift once it completes (§9.3: no duplicate repair on
    // simultaneous fs event + periodic tick).
    if (checkInFlight) return;
    checkInFlight = true;
    const tokenAtStart = lifecycleToken;
    try {
      if (!passesGates()) {
        // Defensive fallback only. Normal gate closure (disable Claude, turn
        // off auto-manage, uninstall) is expected to arrive with an explicit
        // stop() from the caller; this branch exists so a missed stop() can
        // never turn into a silently-immortal, fully-inert timer. No read or
        // write happens here.
        if (tokenAtStart === lifecycleToken) scheduleHealthCheck(healthCheckIntervalMs, "periodic-health");
        return;
      }

      const raw = readSettingsRaw();
      const report = buildReport(raw);
      await handleReport(report, raw, reason, tokenAtStart);
    } finally {
      checkInFlight = false;
    }
  }

  async function handleReport(report, raw, reason, tokenAtStart) {
    if (tokenAtStart !== lifecycleToken) return;

    if (report.status === "unreadable") {
      unreadableStreak += 1;
      // Atomic replace can leave a transient ENOENT/parse-error window; a
      // single observation must not be treated as durable damage.
      if (unreadableStreak < 2) {
        updateHealthStatus({ status: "degraded", degradedReason: "unreadable", lastCheckAt: nowFn(), source: reason, issueSignature: null, issues: [], message: "settings.json temporarily unreadable" });
        scheduleHealthCheck(unstableRecheckMs, "unreadable-recheck");
        return;
      }
      updateHealthStatus({ status: "degraded", degradedReason: "unreadable", lastCheckAt: nowFn(), source: reason, issueSignature: null, issues: [], message: "settings.json is not readable/parseable" });
      scheduleHealthCheck(healthCheckIntervalMs, "periodic-health");
      return;
    }
    unreadableStreak = 0;

    if (report.status === "source-script-missing") {
      // Rewriting settings.json here would only point it at a path that
      // still doesn't exist — reconcile is deliberately never attempted.
      if (!sourceMissingLogged) {
        console.warn("Clawd: the current Claude hook source script is missing — reinstall or re-extract Clawd to restore automatic hook repair");
        sourceMissingLogged = true;
      }
      updateHealthStatus({
        status: "degraded",
        degradedReason: "source-script-missing",
        lastCheckAt: nowFn(),
        source: reason,
        issueSignature: null,
        issues: report.issues,
        message: "Claude hook source script is missing; reinstall or re-extract Clawd",
      });
      scheduleHealthCheck(healthCheckIntervalMs, "periodic-health");
      return;
    }
    sourceMissingLogged = false;

    const signature = buildClaudeRepairSignature(report.issues);

    if (signature === null) {
      // Healthy, or only non-repairable/diagnostic issues remain (e.g. a
      // single missing core event) — those are Doctor-only signals in this
      // PR and never drive automatic repair or mutation.
      repairState = null;
      shrinkNotified = false;
      const snapshot = takeSnapshot(raw);
      if (snapshot) lastTrustedSnapshot = snapshot;
      // A command-unparseable issue is automaticRepairable:false (misclassifying
      // a third-party/unusual command as Clawd's to rewrite is worse than
      // leaving it alone) — it can sit here indefinitely with nothing left
      // for auto-repair to attempt, so it must never be reported as "healthy"
      // or advance lastSuccessAt.
      const unparseable = reportHasUnparseableCommand(report);
      updateHealthStatus({
        status: unparseable ? "degraded" : "healthy",
        degradedReason: unparseable ? "command-unparseable" : null,
        lastCheckAt: nowFn(),
        lastSuccessAt: unparseable ? healthStatus.lastSuccessAt : nowFn(),
        source: reason,
        attempt: 0,
        issueSignature: null,
        issues: report.issues,
        message: unparseable ? "a Clawd-owned hook command could not be parsed; see Doctor for details" : null,
      });
      scheduleHealthCheck(healthCheckIntervalMs, "periodic-health");
      return;
    }

    if (repairState && repairState.manualFixRequired && repairState.signature === signature) {
      // Stuck: same repair class that already exhausted its automatic
      // attempts. Keep patrolling read-only so an external fix (or a
      // restart) is still noticed — see §4.2 point 4.
      updateHealthStatus({ status: "manual-fix-required", degradedReason: null, lastCheckAt: nowFn(), source: reason, issueSignature: signature, issues: report.issues });
      scheduleHealthCheck(healthCheckIntervalMs, "periodic-health");
      return;
    }

    const currentSnapshot = takeSnapshot(raw);
    if (isSuspiciousShrink(lastTrustedSnapshot, currentSnapshot, suspiciousShrinkRatio, suspiciousKeyLossThreshold)) {
      // Notify once per persisting shrink, not every periodic cycle — the
      // condition can stay guarded for many ticks while waiting on an
      // external fix, and re-popping the same notification every 5 minutes
      // would just be noise (#657 plan §4.6: "不得每轮重复弹通知").
      if (!shrinkNotified) {
        console.warn("Clawd: settings.json shrank suspiciously — skipping auto-repair to preserve third-party hooks");
        if (typeof ctx.notifySuspiciousShrink === "function") ctx.notifySuspiciousShrink(lastTrustedSnapshot, currentSnapshot);
        shrinkNotified = true;
      }
      updateHealthStatus({ status: "guarded", degradedReason: null, lastCheckAt: nowFn(), source: reason, issueSignature: signature, issues: report.issues });
      scheduleHealthCheck(healthCheckIntervalMs, "periodic-health");
      return;
    }

    if (!repairState || repairState.signature !== signature) {
      repairState = { signature, attempts: 0, manualFixRequired: false };
    }

    const attemptNumber = repairState.attempts + 1;
    updateHealthStatus({ status: "repairing", degradedReason: null, lastCheckAt: nowFn(), source: reason, attempt: attemptNumber, issueSignature: signature, issues: report.issues });

    let repairResult;
    try {
      if (typeof ctx.syncClawdHooks !== "function") {
        repairResult = { status: "error", message: "syncClawdHooks is not wired" };
      } else {
        repairResult = await ctx.syncClawdHooks({ source: repairSourceForReason(reason), automatic: true });
      }
    } catch (err) {
      repairResult = { status: "error", message: err && err.message };
    }

    // The queue/gate may have flipped closed while the (possibly async)
    // repair was in flight, or stop() may have run — either way, do not
    // touch state or reschedule for a lifecycle that is no longer current.
    if (tokenAtStart !== lifecycleToken) return;

    // Never trust the installer's own success signal alone — re-read and
    // re-run the same inspector to confirm the fix actually landed on disk.
    const verifyRaw = readSettingsRaw();
    const verifyReport = buildReport(verifyRaw);

    if (hasNoAutomaticRepairWork(verifyReport)) {
      repairState = null;
      const nextSnapshot = takeSnapshot(verifyRaw);
      if (nextSnapshot) lastTrustedSnapshot = nextSnapshot;
      // Same command-unparseable carve-out as the initial-detection branch
      // above — repair has nothing left to attempt, but that is not the
      // same thing as "verified healthy."
      const unparseable = reportHasUnparseableCommand(verifyReport);
      updateHealthStatus({
        status: unparseable ? "degraded" : "healthy",
        degradedReason: unparseable ? "command-unparseable" : null,
        lastCheckAt: nowFn(),
        lastSuccessAt: unparseable ? healthStatus.lastSuccessAt : nowFn(),
        source: reason,
        attempt: 0,
        issueSignature: null,
        issues: verifyReport.issues,
        message: unparseable ? "a Clawd-owned hook command could not be parsed; see Doctor for details" : null,
      });
      scheduleHealthCheck(healthCheckIntervalMs, "periodic-health");
      return;
    }

    const verifySignature = buildClaudeRepairSignature(verifyReport.issues);
    const failureSignature = verifySignature || signature;
    if (repairState.signature === failureSignature) {
      repairState.attempts = attemptNumber;
    } else {
      // The repair attempt changed the fault (fixed part of it, or exposed a
      // different one) — track it as its own signature with a FRESH 3-strike
      // budget (attempts: 1, not attemptNumber). Carrying over the old
      // signature's attempt count would let an unrelated new problem inherit
      // however close the old one already was to manual-fix-required — e.g.
      // two failed core-script-path attempts should not hand permission-url
      // a same-attempt-3 death sentence on its very first appearance.
      repairState = { signature: failureSignature, attempts: 1, manualFixRequired: false };
    }

    const message = (repairResult && repairResult.message) || "Claude hook repair did not verify healthy";
    if (repairState.attempts >= maxRepairAttempts) {
      repairState.manualFixRequired = true;
      updateHealthStatus({
        status: "manual-fix-required",
        degradedReason: null,
        lastCheckAt: nowFn(),
        source: reason,
        attempt: repairState.attempts,
        issueSignature: repairState.signature,
        issues: verifyReport.issues,
        message,
      });
      scheduleHealthCheck(healthCheckIntervalMs, "periodic-health");
    } else {
      updateHealthStatus({
        status: "repairing",
        degradedReason: null,
        lastCheckAt: nowFn(),
        source: reason,
        attempt: repairState.attempts,
        issueSignature: repairState.signature,
        issues: verifyReport.issues,
        message,
      });
      const delay = repairRetryDelaysMs[repairState.attempts - 1] ?? repairRetryDelaysMs[repairRetryDelaysMs.length - 1];
      scheduleHealthCheck(delay, "repair-retry");
    }
  }

  function stop() {
    // Bump first: any timer callback already queued (fired before close(),
    // not yet run) compares its captured token and becomes a no-op.
    lifecycleToken++;
    clearHealthTimer();
    if (settingsWatchDebounceTimer) {
      clearTimeoutFn(settingsWatchDebounceTimer);
      settingsWatchDebounceTimer = null;
    }
    lastTrustedSnapshot = null;
    checkInFlight = false;
    unreadableStreak = 0;
    sourceMissingLogged = false;
    shrinkNotified = false;
    repairState = null;
    healthStatus = initialHealthStatus(nowFn);
    if (!settingsWatcher) return false;
    try {
      settingsWatcher.close();
    } catch {}
    settingsWatcher = null;
    return true;
  }

  function start() {
    if (settingsWatcher) return false;
    lifecycleToken++;
    const settingsDir = getClaudeSettingsDir();
    const settingsPath = getClaudeSettingsPath();

    // Seed a trusted baseline before scheduling anything, so the very first
    // watcher event or health tick has a real snapshot to compare against
    // instead of null. Left unseeded on read failure or when the config
    // already looks unhealthy — the first scheduled check picks it up
    // through the normal (guarded) repair path instead.
    try {
      const seedRaw = fsApi.readFileSync(settingsPath, "utf-8");
      const seedReport = buildReport(seedRaw);
      if (hasNoAutomaticRepairWork(seedReport)) {
        lastTrustedSnapshot = takeSnapshot(seedRaw);
      }
    } catch (err) {
      console.warn("Clawd: could not seed settings baseline:", err.message);
    }

    try {
      settingsWatcher = fsApi.watch(settingsDir, (_event, filename) => {
        if (filename && filename !== SETTINGS_FILENAME) return;
        if (settingsWatchDebounceTimer) return;
        settingsWatchDebounceTimer = setTimeoutFn(() => {
          settingsWatchDebounceTimer = null;
          scheduleHealthCheck(0, "settings-event");
        }, settingsWatchDebounceMs);
      });
      if (settingsWatcher && typeof settingsWatcher.on === "function") {
        settingsWatcher.on("error", (err) => {
          console.warn("Clawd: settings watcher error:", err.message);
        });
      }
    } catch (err) {
      console.warn("Clawd: failed to watch settings directory:", err.message);
      settingsWatcher = null;
      return false;
    }

    scheduleHealthCheck(0, "startup");
    return true;
  }

  function checkNow(reason) {
    return runHealthCheck(reason || "manual-check");
  }

  function getHealthStatus() {
    return {
      ...healthStatus,
      issues: Array.isArray(healthStatus.issues) ? healthStatus.issues.slice(0, MAX_EXPOSED_ISSUES) : [],
    };
  }

  return {
    start,
    stop,
    checkNow,
    getHealthStatus,
    getClaudeSettingsDir,
    getClaudeSettingsPath,
  };
}

module.exports = {
  HOOK_MARKER,
  SETTINGS_FILENAME,
  entriesContainCommandMarker,
  entriesContainHttpHookUrl,
  settingsNeedClaudeHookResync,
  countAllHooks,
  countThirdPartyHooks,
  takeSnapshot,
  isSuspiciousShrink,
  createClaudeSettingsWatcher,
};
