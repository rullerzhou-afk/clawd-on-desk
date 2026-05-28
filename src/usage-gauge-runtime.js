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

function createUsageGaugeRuntime(options = {}) {
  const getSettings = options.getSettings || (() => ({ enabled: false }));
  const showSnapshot = options.showSnapshot || (() => {});
  const hide = options.hide || (() => {});
  const readCodex = options.readCodex || readCodexUsageLocal;
  const readRemoteCodex = options.readRemoteCodex || null;
  const readClaude = options.readClaude || fetchClaudeUsage;
  const getRemoteCodexProfile = options.getRemoteCodexProfile || (() => null);
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
    const remoteProfile = getRemoteCodexProfile();
    if (remoteProfile && readRemoteCodex) {
      try {
        const remote = await readRemoteCodex(remoteProfile);
        if (remote && Array.isArray(remote.limits) && remote.limits.length) return remote;
      } catch (err) {
        logWarn("Clawd: remote Codex usage failed:", err && err.message);
      }
    }
    try {
      return readCodex();
    } catch (err) {
      logWarn("Clawd: local Codex usage failed:", err && err.message);
      return { provider: "codex", limits: [] };
    }
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
        settings.providers && settings.providers.claude === false
          ? Promise.resolve({ provider: "claude", limits: [] })
          : readClaude(),
      ]);
      const snapshot = projectLimits({
        updatedAt: now(),
        providers: providers.filter(Boolean),
      }, settings);
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
    if (settings.pollIntervalMs !== lastPollIntervalMs) {
      refresh();
      return;
    }
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
  createUsageGaugeRuntime,
};
