"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { buildPermissionUrl } = require("../hooks/server-config");

const HOOK_MARKER = "clawd-hook.js";
const SETTINGS_FILENAME = "settings.json";
const MANAGED_COMMAND_MARKERS = Object.freeze([
  HOOK_MARKER,
  "auto-start.js",
  "auto-start.sh",
]);

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

function createClaudeSettingsWatcher(ctx = {}) {
  const fsApi = ctx.fs || fs;
  const pathApi = ctx.path || path;
  const osApi = ctx.os || os;
  const setTimeoutFn = ctx.setTimeout || setTimeout;
  const clearTimeoutFn = ctx.clearTimeout || clearTimeout;
  const nowFn = typeof ctx.now === "function" ? ctx.now : Date.now;
  const settingsWatchDebounceMs = Number.isFinite(ctx.settingsWatchDebounceMs) ? ctx.settingsWatchDebounceMs : 1000;
  const settingsWatchRateLimitMs = Number.isFinite(ctx.settingsWatchRateLimitMs) ? ctx.settingsWatchRateLimitMs : 5000;
  const suspiciousShrinkRatio = Number.isFinite(ctx.suspiciousShrinkRatio) ? ctx.suspiciousShrinkRatio : 0.5;
  const suspiciousKeyLossThreshold = Number.isFinite(ctx.suspiciousKeyLossThreshold) ? ctx.suspiciousKeyLossThreshold : 3;

  let settingsWatcher = null;
  let settingsWatchDebounceTimer = null;
  let settingsWatchLastSyncTime = 0;
  let lastTrustedSnapshot = null;

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

  function stop() {
    if (settingsWatchDebounceTimer) {
      clearTimeoutFn(settingsWatchDebounceTimer);
      settingsWatchDebounceTimer = null;
    }
    settingsWatchLastSyncTime = 0;
    lastTrustedSnapshot = null;
    if (!settingsWatcher) return false;
    try {
      settingsWatcher.close();
    } catch {}
    settingsWatcher = null;
    return true;
  }

  function start() {
    if (settingsWatcher) return false;
    const settingsDir = getClaudeSettingsDir();
    const settingsPath = getClaudeSettingsPath();
    // Seed the trusted baseline from the current settings.json before the watcher starts,
    // so the very first watcher event after Clawd boots (e.g. an external CLI minimize
    // landing right after syncClawdHooks() ran) can be compared against a real snapshot
    // instead of null. Wrapped in its own try/catch so a missing or unreadable file
    // (fresh install, permission error) cannot prevent the watcher from starting.
    // The settingsNeedClaudeHookResync guard inside this block also prevents seeding
    // from a polluted state if an external CLI raced ahead of this read.
    try {
      const seedRaw = fsApi.readFileSync(settingsPath, "utf-8");
      const seedPort = typeof ctx.getHookServerPort === "function" ? ctx.getHookServerPort() : null;
      const seedExpectedPermissionUrl = buildPermissionUrl(seedPort);
      if (!settingsNeedClaudeHookResync(seedRaw, seedExpectedPermissionUrl)) {
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
          if (typeof ctx.shouldManageClaudeHooks === "function" && !ctx.shouldManageClaudeHooks()) return;
          if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled("claude-code")) return;
          // Rate-limit: don't re-sync within 5s to avoid write wars with CC-Switch
          if (nowFn() - settingsWatchLastSyncTime < settingsWatchRateLimitMs) return;
          try {
            const raw = fsApi.readFileSync(settingsPath, "utf-8");
            const port = typeof ctx.getHookServerPort === "function" ? ctx.getHookServerPort() : null;
            const expectedPermissionUrl = buildPermissionUrl(port);
            const currentSnapshot = takeSnapshot(raw);
            if (settingsNeedClaudeHookResync(raw, expectedPermissionUrl)) {
              // Snapshot guard — refuse to resync when settings.json shrank too much,
              // since an external CLI may have minimized it and re-registering would
              // drop third-party hooks. See PR description for the production race.
              if (isSuspiciousShrink(lastTrustedSnapshot, currentSnapshot, suspiciousShrinkRatio, suspiciousKeyLossThreshold)) {
                console.warn("Clawd: settings.json shrank suspiciously — skipping auto-resync to preserve third-party hooks");
                if (typeof ctx.notifySuspiciousShrink === "function") {
                  ctx.notifySuspiciousShrink(lastTrustedSnapshot, currentSnapshot);
                }
                return;
              }
              console.log("Clawd: hooks missing from settings.json — re-registering");
              settingsWatchLastSyncTime = nowFn();
              if (typeof ctx.syncClawdHooks === "function") ctx.syncClawdHooks();
            } else if (currentSnapshot) {
              // Trust this state — refresh the baseline only when the file looks healthy.
              lastTrustedSnapshot = currentSnapshot;
            }
          } catch {}
        }, settingsWatchDebounceMs);
      });
      if (settingsWatcher && typeof settingsWatcher.on === "function") settingsWatcher.on("error", (err) => {
        console.warn("Clawd: settings watcher error:", err.message);
      });
      return true;
    } catch (err) {
      console.warn("Clawd: failed to watch settings directory:", err.message);
      settingsWatcher = null;
      return false;
    }
  }

  return {
    start,
    stop,
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
