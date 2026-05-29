"use strict";

const { readCodexUsageLocal, fetchClaudeUsage } = require("./usage-sources");

function byLimitId(snapshot) {
  const out = new Map();
  for (const provider of snapshot.providers || []) {
    for (const limit of provider.limits || []) out.set(limit.id, limit);
  }
  return out;
}

function projectLimits(snapshot, settings) {
  const map = byLimitId(snapshot);
  const alwaysOn = [];
  for (const id of settings.alwaysOnLimitIds || []) {
    const limit = map.get(id);
    if (limit) alwaysOn.push(limit);
  }
  const expanded = [];
  for (const id of settings.expandedLimitIds || []) {
    const limit = map.get(id);
    if (limit) expanded.push(limit);
  }
  return { ...snapshot, alwaysOn, expanded };
}

function pickFreshestUsage(results, provider) {
  const candidates = (Array.isArray(results) ? results : [])
    .filter((result) => result && Array.isArray(result.limits) && result.limits.length > 0);
  if (!candidates.length) return { provider, limits: [] };
  let freshest = candidates[0];
  let freshestCapturedAt = Number.isFinite(freshest.capturedAtMs) ? freshest.capturedAtMs : -Infinity;
  for (const candidate of candidates.slice(1)) {
    const capturedAt = Number.isFinite(candidate.capturedAtMs) ? candidate.capturedAtMs : -Infinity;
    if (capturedAt > freshestCapturedAt) {
      freshest = candidate;
      freshestCapturedAt = capturedAt;
    }
  }
  return freshest;
}

// Retained for backward compat (tests reference it). Delegates to the
// provider-agnostic picker.
function pickFreshestCodexUsage(results) {
  return pickFreshestUsage(results, "codex");
}

function createUsageGaugeRuntime(options = {}) {
  const getSettings = options.getSettings || (() => ({ enabled: false }));
  const showSnapshot = options.showSnapshot || (() => {});
  const hide = options.hide || (() => {});
  const readCodex = options.readCodex || readCodexUsageLocal;
  const readRemoteCodex = options.readRemoteCodex || null;
  const readClaude = options.readClaude || fetchClaudeUsage;
  const readRemoteClaude = options.readRemoteClaude || null;
  const getRemoteCodexProfiles = options.getRemoteCodexProfiles
    || (() => {
      if (typeof options.getRemoteCodexProfile !== "function") return [];
      const profile = options.getRemoteCodexProfile();
      return profile ? [profile] : [];
    });
  // Claude remote reads reuse the same SSH profiles as Codex (same host).
  const getRemoteClaudeProfiles = options.getRemoteClaudeProfiles || getRemoteCodexProfiles;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const now = options.now || Date.now;
  const logWarn = options.logWarn || (() => {});

  let timer = null;
  let running = false;
  let inFlight = false;
  let lastPollIntervalMs = 0;

  function clearTimer() {
    if (timer) clearTimeoutFn(timer);
    timer = null;
  }

  function schedule(delayMs) {
    clearTimer();
    timer = setTimeoutFn(() => {
      timer = null;
      refresh();
    }, delayMs);
  }

  async function fetchCodex(settings) {
    if (!settings.providers || settings.providers.codex === false) {
      return { provider: "codex", limits: [] };
    }
    let profiles = [];
    if (readRemoteCodex) {
      try {
        const remoteProfiles = getRemoteCodexProfiles();
        profiles = Array.isArray(remoteProfiles) ? remoteProfiles : [];
      } catch (err) {
        logWarn("Clawd: remote Codex usage profiles failed:", err && err.message);
      }
    }
    const reads = [
      Promise.resolve()
        .then(() => readCodex())
        .catch((err) => {
          logWarn("Clawd: local Codex usage failed:", err && err.message);
          return { provider: "codex", limits: [] };
        }),
      ...profiles.map((profile) => Promise.resolve()
        .then(() => readRemoteCodex(profile))
        .catch((err) => {
          logWarn("Clawd: remote Codex usage failed:", err && err.message);
          return { provider: "codex", limits: [] };
        })),
    ];
    const results = await Promise.all(reads);
    return pickFreshestUsage(results, "codex");
  }

  async function fetchClaude(settings) {
    if (settings.providers && settings.providers.claude === false) {
      return { provider: "claude", limits: [] };
    }
    let profiles = [];
    if (readRemoteClaude) {
      try {
        const remoteProfiles = getRemoteClaudeProfiles();
        profiles = Array.isArray(remoteProfiles) ? remoteProfiles : [];
      } catch (err) {
        logWarn("Clawd: remote Claude usage profiles failed:", err && err.message);
      }
    }
    const reads = [
      Promise.resolve()
        .then(() => readClaude())
        .catch((err) => {
          logWarn("Clawd: local Claude usage failed:", err && err.message);
          return { provider: "claude", limits: [] };
        }),
      ...profiles.map((profile) => Promise.resolve()
        .then(() => readRemoteClaude(profile))
        .catch((err) => {
          logWarn("Clawd: remote Claude usage failed:", err && err.message);
          return { provider: "claude", limits: [] };
        })),
    ];
    const results = await Promise.all(reads);
    return pickFreshestUsage(results, "claude");
  }

  async function refresh() {
    const settings = getSettings();
    if (!running || !settings || settings.enabled === false) {
      hide();
      return;
    }
    if (inFlight) return;
    inFlight = true;
    try {
      const providers = await Promise.all([
        fetchCodex(settings),
        fetchClaude(settings),
      ]);
      const snapshot = projectLimits({
        updatedAt: now(),
        providers: providers.filter(Boolean),
      }, settings);
      // stop() may have run while we were awaiting the fetches above; don't
      // resurrect the UI after cleanup. The finally block below sees running=false
      // and skips rescheduling.
      if (!running) return;
      if (snapshot.alwaysOn.length || snapshot.expanded.length) showSnapshot(snapshot);
      else hide();
    } catch (err) {
      logWarn("Clawd: usage gauge refresh failed:", err && err.message);
      hide();
    } finally {
      inFlight = false;
      const next = getSettings();
      if (running && next && next.enabled !== false) {
        const intervalMs = next && Number.isInteger(next.pollIntervalMs) ? next.pollIntervalMs : 60000;
        lastPollIntervalMs = intervalMs;
        schedule(intervalMs);
      }
    }
  }

  function start() {
    running = true;
    const settings = getSettings();
    if (!settings || settings.enabled === false) {
      hide();
      return;
    }
    lastPollIntervalMs = settings.pollIntervalMs || 60000;
    refresh();
  }

  function stop() {
    running = false;
    clearTimer();
    hide();
  }

  function handleSettingsChanged() {
    const settings = getSettings();
    if (!settings || settings.enabled === false) {
      stop();
      return;
    }
    if (!running) return;
    // A poll-interval change takes effect on the next reschedule (the finally
    // block in refresh() reads the latest interval), so a single refresh() is
    // enough for both the interval-changed and unchanged cases.
    refresh();
  }

  return {
    start,
    stop,
    refresh,
    handleSettingsChanged,
    isRunning: () => running,
  };
}

module.exports = {
  byLimitId,
  projectLimits,
  pickFreshestUsage,
  pickFreshestCodexUsage,
  createUsageGaugeRuntime,
};
