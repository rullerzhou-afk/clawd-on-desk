"use strict";

const nodeFs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_QUOTA_ALERT_THRESHOLDS = Object.freeze([20, 10]);
const QUOTA_ALERT_MAX_AGE_MS = 10 * 60 * 1000;
const HISTORY_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_RESET_AHEAD_MS = 45 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_RECORDS = 256;
const MAX_HISTORY_BYTES = 256 * 1024;
const PERSIST_DEBOUNCE_MS = 2000;
const PROVIDER_WINDOWS = {
  antigravityQuota: ["geminiFiveHour", "geminiWeekly", "thirdPartyFiveHour", "thirdPartyWeekly"],
  claudeQuota: ["claudeFiveHour", "claudeWeekly"],
  codexQuota: ["codexFiveHour", "codexWeekly"],
  codexSparkQuota: ["codexFiveHour", "codexWeekly"],
  kimiQuota: ["kimiFiveHour", "kimiWeekly"],
};

function normalizeQuotaAlertThresholds(value) {
  if (!Array.isArray(value)) return [...DEFAULT_QUOTA_ALERT_THRESHOLDS];
  const normalized = [...new Set(value.filter((entry) => Number.isInteger(entry) && entry > 0 && entry < 100))]
    .sort((a, b) => b - a).slice(0, 5);
  return normalized.length ? normalized : [...DEFAULT_QUOTA_ALERT_THRESHOLDS];
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isCached(value) {
  return value.cached === true || value.fromCache === true || value.stale === true || value.fresh === false;
}

function historyKey(sourceKey, providerKey, windowKey, windowMinutes) {
  // Persist only a digest, not host/profile labels or any account/session IDs.
  return crypto.createHash("sha256")
    .update(JSON.stringify([sourceKey, providerKey, windowKey, windowMinutes])).digest("hex");
}

// Consume the UNMERGED account-quota store snapshot, never a session's quota:
// [{ sourceKey: "" | "remote:<profile>", host: null | string,
//    codexQuota: { group: { codexWeekly: { usedPercent, resetAt,
//      windowMinutes?, lastSeenAt, expired? } }, updatedAt, lastSeenAt } }].
// All timestamps are epoch-ms. Bucket lastSeenAt is minute-quantized. A
// provider's timestamps cannot confirm an untouched sibling window. Because
// snapshots have no cache provenance, require a bucket confirmation strictly
// AFTER this instance started. The first real confirmation may therefore wait
// until the next whole minute (at most about 60 seconds).
function createQuotaAlerts(options = {}) {
  const fs = options.fs || nodeFs;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const notify = typeof options.notify === "function" ? options.notify : () => false;
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : () => {};
  const historyPath = typeof options.historyPath === "string" && options.historyPath ? options.historyPath : null;
  const startedAt = now();
  const records = new Map();
  const pending = new Map();
  let dirty = false;
  let persistTimer = null;
  let disposed = false;
  let observing = false;

  function warn(message, error) {
    // Do not relay filesystem paths, source labels, or raw payloads to logs.
    try { logWarn(message, error && typeof error.code === "string" ? error.code : undefined); } catch {}
  }

  function prune(nowMs) {
    for (const [key, record] of records) {
      if (record.observedAt + HISTORY_RETENTION_MS <= nowMs) {
        records.delete(key);
        dirty = true;
      }
    }
    if (records.size <= MAX_HISTORY_RECORDS) return;
    const oldest = [...records].sort((a, b) => a[1].observedAt - b[1].observedAt);
    for (const [key] of oldest.slice(0, records.size - MAX_HISTORY_RECORDS)) records.delete(key);
    dirty = true;
  }

  function load() {
    if (!historyPath) return;
    try {
      if (fs.statSync(historyPath).size > MAX_HISTORY_BYTES) return;
      const text = fs.readFileSync(historyPath, "utf8");
      const raw = JSON.parse(text.replace(/^\uFEFF/, ""));
      if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.records)) return;
      const nowMs = now();
      for (const record of raw.records.slice(0, MAX_HISTORY_RECORDS)) {
        if (!isObject(record) || !/^[a-f0-9]{64}$/.test(record.key || "")) continue;
        if (!finiteNumber(record.resetAt) || record.resetAt <= 0 || record.resetAt > nowMs + MAX_RESET_AHEAD_MS) continue;
        if (!finiteNumber(record.observedAt) || record.observedAt <= 0 || record.observedAt > nowMs
          || record.observedAt + HISTORY_RETENTION_MS <= nowMs) continue;
        if (!finiteNumber(record.remainingPercent) || record.remainingPercent < 0 || record.remainingPercent > 100) continue;
        const lowObservedAt = finiteNumber(record.lowObservedAt) && record.lowObservedAt > 0
          && record.lowObservedAt <= record.observedAt ? record.lowObservedAt : 0;
        const notified = Array.isArray(record.notified)
          ? [...new Set(record.notified.filter((value) => Number.isInteger(value) && value > 0 && value <= 100))] : [];
        records.set(record.key, {
          key: record.key,
          resetAt: record.resetAt,
          observedAt: record.observedAt,
          remainingPercent: record.remainingPercent,
          notified,
          lowObservedAt,
          recoveryPending: record.recoveryPending === true && lowObservedAt > 0,
          recovered: record.recovered === true,
        });
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") warn("Clawd: quota alert history could not be read", error);
    }
  }

  function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    prune(now());
    if (!dirty || !historyPath) {
      dirty = false;
      return true;
    }
    const tmpPath = `${historyPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(path.dirname(historyPath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, records: [...records.values()] }),
        { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(tmpPath, historyPath);
      dirty = false;
      return true;
    } catch (error) {
      try { fs.unlinkSync(tmpPath); } catch {}
      warn("Clawd: quota alert history could not be saved", error);
      return false;
    }
  }

  function schedulePersist() {
    if (!dirty || !historyPath || persistTimer || disposed) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      flush();
    }, PERSIST_DEBOUNCE_MS);
    if (typeof persistTimer.unref === "function") persistTimer.unref();
  }

  function deliver(event, config, record, acknowledge) {
    if (config.suppressed === true || pending.has(record.key)) return false;
    try {
      const result = notify(event);
      if (!result || typeof result.then !== "function") return result === true;
      const token = {};
      pending.set(record.key, token);
      Promise.resolve(result).then((shown) => {
        // Never apply an old window's acknowledgement to its replacement, or
        // persist a late callback after shutdown. One in-flight send per key.
        if (shown === true && !disposed && pending.get(record.key) === token
          && records.get(record.key) === record) {
          acknowledge();
          dirty = true;
          flush();
        }
      }, (error) => warn("Clawd: quota alert notification could not be shown", error))
        .finally(() => { if (pending.get(record.key) === token) pending.delete(record.key); });
      return false;
    } catch (error) {
      warn("Clawd: quota alert notification could not be shown", error);
      return false;
    }
  }

  function observeWindow(source, providerKey, windowKey, bucket, config, thresholds, nowMs, delivered) {
    if (!isObject(bucket) || isCached(bucket) || bucket.expired === true) return;
    if (!finiteNumber(bucket.usedPercent) || bucket.usedPercent < 0 || bucket.usedPercent > 100) return;
    if (!finiteNumber(bucket.resetAt) || bucket.resetAt <= nowMs || bucket.resetAt > nowMs + MAX_RESET_AHEAD_MS) return;
    const observedAt = bucket.lastSeenAt;
    if (!finiteNumber(observedAt) || observedAt <= startedAt || observedAt > nowMs
      || observedAt + QUOTA_ALERT_MAX_AGE_MS < nowMs) return;
    const windowMinutes = finiteNumber(bucket.windowMinutes) && bucket.windowMinutes > 0 ? bucket.windowMinutes : null;
    const key = historyKey(source.sourceKey, providerKey, windowKey, windowMinutes);
    const prior = records.get(key);
    if (prior && (observedAt < prior.observedAt || bucket.resetAt < prior.resetAt)) return;
    const remainingPercent = 100 - bucket.usedPercent;
    let record = prior;
    if (!record || record.resetAt !== bucket.resetAt) {
      // A later absolute reset identifies a new window. Only an actually
      // observed low predecessor whose window has ended may arm recovery.
      const followsLowWindow = prior && prior.recoveryPending && prior.resetAt <= nowMs;
      record = {
        key, resetAt: bucket.resetAt, observedAt, remainingPercent, notified: [],
        lowObservedAt: followsLowWindow ? prior.lowObservedAt : 0,
        recoveryPending: Boolean(followsLowWindow), recovered: false,
      };
      records.set(key, record);
      dirty = true;
    } else if (record.observedAt !== observedAt || record.remainingPercent !== remainingPercent) {
      record.observedAt = observedAt;
      record.remainingPercent = remainingPercent;
      dirty = true;
    }
    const highestThreshold = thresholds[0];
    if (highestThreshold === undefined) return;
    const common = {
      sourceKey: source.sourceKey,
      host: typeof source.host === "string" ? source.host.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 64) : null,
      providerKey, windowKey, windowMinutes, resetAt: bucket.resetAt, remainingPercent, observedAt,
    };
    if (remainingPercent <= highestThreshold) {
      if (!record.recovered && (!record.recoveryPending || record.lowObservedAt < observedAt)) {
        record.recoveryPending = true;
        record.lowObservedAt = observedAt;
        dirty = true;
      }
      const eligible = thresholds.filter((threshold) => remainingPercent <= threshold && !record.notified.includes(threshold));
      const threshold = eligible.at(-1);
      if (threshold === undefined) return;
      const event = { type: "low", ...common, threshold };
      // A jump straight to 9% emits only the most urgent 10% notification and
      // also consumes the less urgent 20% candidate for this window.
      const acknowledge = () => {
        record.notified = [...new Set([...record.notified, ...thresholds.filter((value) => value >= threshold)])];
      };
      if (!deliver(event, config, record, acknowledge)) return;
      acknowledge();
      delivered.push(event);
      dirty = true;
      return;
    }
    if (config.recoveryEnabled === true && record.recoveryPending && !record.recovered
      && observedAt > record.lowObservedAt) {
      const event = { type: "recovered", ...common };
      const acknowledge = () => { record.recoveryPending = false; record.recovered = true; };
      if (!deliver(event, config, record, acknowledge)) return;
      acknowledge();
      delivered.push(event);
      dirty = true;
    }
  }

  function observe(accountQuotaSnapshot, config = {}) {
    if (disposed || observing || !isObject(config) || config.enabled !== true || !Array.isArray(accountQuotaSnapshot)) return [];
    const nowMs = now();
    if (!finiteNumber(nowMs)) return [];
    const thresholds = normalizeQuotaAlertThresholds(config.thresholds);
    const delivered = [];
    observing = true;
    try {
      for (const source of accountQuotaSnapshot.slice(0, 12)) {
        if (!isObject(source) || isCached(source) || typeof source.sourceKey !== "string"
          || source.sourceKey.length > 64 || /[\x00-\x1f\x7f]/.test(source.sourceKey)) continue;
        for (const [providerKey, windows] of Object.entries(PROVIDER_WINDOWS)) {
          const provider = source[providerKey];
          if (!isObject(provider) || isCached(provider) || !isObject(provider.group)) continue;
          for (const windowKey of windows) {
            observeWindow(source, providerKey, windowKey, provider.group[windowKey], config, thresholds, nowMs, delivered);
          }
        }
      }
      prune(nowMs);
      // Persist acknowledged notifications immediately. Quiet observation
      // updates are debounced, matching account-quota persistence cadence.
      if (delivered.length) flush();
      else schedulePersist();
      return delivered;
    } finally {
      observing = false;
    }
  }

  function dispose() {
    if (disposed) return;
    flush();
    disposed = true;
    pending.clear();
  }

  load();
  return { observe, flush, dispose };
}

module.exports = {
  createQuotaAlerts,
  normalizeQuotaAlertThresholds,
  DEFAULT_QUOTA_ALERT_THRESHOLDS,
  QUOTA_ALERT_MAX_AGE_MS,
  MAX_HISTORY_RECORDS,
};
