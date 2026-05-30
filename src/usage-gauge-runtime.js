"use strict";

const { readCodexUsageLocal, fetchClaudeUsage } = require("./usage-sources");
const { readStatuslineUsage } = require("./usage-statusline");

// Default backoff after a 429 from the Claude usage API. The per-token bucket
// stays locked 30-60 min; re-polling extends the lock. We honor a positive
// Retry-After when present, otherwise wait this long. Capped below.
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;
// A cached last-good value older than this is treated as too stale to show even
// as a fallback (it likely no longer reflects reality). resets_at-based hiding
// happens in the renderer; this is the hard ceiling.
const MAX_STALE_CACHE_MS = 6 * 60 * 60 * 1000;

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
  const readStatusline = options.readStatusline || readStatuslineUsage;
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
  // 429 backoff: until this timestamp the Claude usage API (local + remote) is
  // off-limits. The statusLine snapshot read is unaffected (it's a file read).
  let claudeApiBlockedUntil = 0;
  // Last non-empty Claude result, kept so a transient API failure / 429 doesn't
  // blank the gauge. Capped by MAX_STALE_CACHE_MS.
  let lastClaudeUsage = null;

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

  // Remember a non-empty Claude result as the last-good fallback.
  function rememberClaude(result) {
    if (result && Array.isArray(result.limits) && result.limits.length) {
      lastClaudeUsage = { result, at: now() };
    }
    return result;
  }

  // Return the cached last-good value if it's still within MAX_STALE_CACHE_MS,
  // else null. Used when every live source comes back empty / rate-limited.
  function staleClaudeFallback() {
    if (!lastClaudeUsage) return null;
    if (now() - lastClaudeUsage.at > MAX_STALE_CACHE_MS) return null;
    return lastClaudeUsage.result;
  }

  // Note a 429 and arm the backoff window. Honors a positive Retry-After hint
  // from the API, otherwise uses the default; clamped to MAX_RATE_LIMIT_BACKOFF_MS.
  function noteClaudeRateLimited(retryAfterMs) {
    const wait = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.min(retryAfterMs, MAX_RATE_LIMIT_BACKOFF_MS)
      : DEFAULT_RATE_LIMIT_BACKOFF_MS;
    claudeApiBlockedUntil = now() + wait;
    logWarn("Clawd: Claude usage API rate-limited (429); backing off for", Math.round(wait / 1000), "s");
  }

  async function fetchClaude(settings) {
    if (settings.providers && settings.providers.claude === false) {
      return { provider: "claude", limits: [] };
    }

    // 1. statusLine stdin tap (primary). When Claude Code is running this is
    //    fresh every prompt and costs zero API calls — the whole point of the
    //    hybrid. If it's fresh we return immediately and NEVER touch the API.
    let snapshot = null;
    try {
      snapshot = readStatusline();
    } catch (err) {
      logWarn("Clawd: Claude statusline snapshot read failed:", err && err.message);
    }
    if (snapshot && Array.isArray(snapshot.limits) && snapshot.limits.length) {
      return rememberClaude(snapshot);
    }

    // 2. Fallback: the rate-limited usage API (local token + remote SSH). Skip
    //    entirely while the 429 backoff window is open — re-polling a locked
    //    bucket only extends the lock.
    if (now() < claudeApiBlockedUntil) {
      const cached = staleClaudeFallback();
      return cached || { provider: "claude", limits: [] };
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

    // Any source reporting a 429 arms the backoff (skip the API next cycle).
    const limited = results.find((r) => r && r.rateLimited);
    if (limited) noteClaudeRateLimited(limited.retryAfterMs);

    const freshest = pickFreshestUsage(results, "claude");
    if (freshest && Array.isArray(freshest.limits) && freshest.limits.length) {
      return rememberClaude(freshest);
    }
    // Everything came back empty (expired token / 429 / SSH down). Keep the last
    // good value visible rather than blanking the gauge, until it ages out.
    const cached = staleClaudeFallback();
    return cached || freshest;
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
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  MAX_RATE_LIMIT_BACKOFF_MS,
  MAX_STALE_CACHE_MS,
  byLimitId,
  projectLimits,
  pickFreshestUsage,
  pickFreshestCodexUsage,
  createUsageGaugeRuntime,
};
