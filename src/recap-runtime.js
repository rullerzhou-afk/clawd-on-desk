"use strict";

const { createRecapAggregate } = require("./recap-aggregate");
const { createRecapCoverage } = require("./recap-coverage");
const { createCanonicalRecapEvent } = require("./recap-event");
const { createRecapJournal } = require("./recap-journal");
const { isTransientRecapPrivateAclError } = require("./recap-private-permissions");
const { createRecapStore, DEFAULT_ROOT } = require("./recap-store");
const {
  addLocalDays,
  compareLocalDates,
  describeLocalDay,
  freezeLocalTime,
  getZonedDateTimeParts,
  getSystemTimeZone,
  parseLocalDate,
} = require("./recap-time");

const PERIODS = new Set(["today", "week", "month", "year"]);
const MAX_FUTURE_SKEW_MS = 5 * 60000;
const MAX_HYDRATION_BUFFER = 4096;
const HYDRATION_APPLY_BATCH_SIZE = 250;
const STORAGE_RETRY_DELAYS_MS = Object.freeze([100, 250, 500, 1000, 2000, 5000, 10000, 30000]);

function rangeForPeriod(period, anchorDate) {
  if (!PERIODS.has(period)) throw new TypeError("unsupported recap period");
  const parts = parseLocalDate(anchorDate);
  if (period === "today") return { startDate: anchorDate, endDate: anchorDate };
  if (period === "week") {
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    const daysSinceMonday = (weekday + 6) % 7;
    return { startDate: addLocalDays(anchorDate, -daysSinceMonday), endDate: anchorDate };
  }
  if (period === "month") {
    return {
      startDate: `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-01`,
      endDate: anchorDate,
    };
  }
  return { startDate: `${String(parts.year).padStart(4, "0")}-01-01`, endDate: anchorDate };
}

function nextLocalMidnightDelay(nowMs, timeZone) {
  const current = freezeLocalTime(nowMs, timeZone).localDate;
  // Search forward coarsely, then binary-search the first epoch assigned to a
  // later civil date in this zone. This works for DST and non-hour offsets.
  let low = nowMs;
  let high = nowMs + 36 * 3600000;
  while (freezeLocalTime(high, timeZone).localDate === current) high += 12 * 3600000;
  while (high - low > 1000) {
    const mid = Math.floor((low + high) / 2);
    if (freezeLocalTime(mid, timeZone).localDate === current) low = mid;
    else high = mid;
  }
  return Math.max(1000, high - nowMs + 1000);
}

function elapsedMinutesInCurrentLocalHour(epochMs, timeZoneId, current, capacityMinutes) {
  // Walk the real timeline backwards, not the wall-clock label. During a fold
  // 01:59 can be followed by 01:00, and Lord Howe repeats only 30 minutes;
  // multiplying an offset occurrence by 60 gets both cases wrong. The largest
  // supported civil-hour capacity is already bounded by describeLocalDay().
  let start = epochMs - current.localSecond * 1000 - (epochMs % 1000);
  for (let elapsed = 0; elapsed < capacityMinutes; elapsed += 1) {
    const candidate = start - 60000;
    const parts = getZonedDateTimeParts(candidate, timeZoneId);
    if (parts.localDate !== current.localDate || parts.localHour !== current.localHour) break;
    start = candidate;
  }
  return Math.min(capacityMinutes, Math.max(0, Math.floor((epochMs - start) / 60000)));
}

function createRecapRuntime(options = {}) {
  const now = options.now || Date.now;
  const getEnabled = options.getEnabled || (() => true);
  const getTimeZone = options.getTimeZone || getSystemTimeZone;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const logWarn = options.logWarn || console.warn;
  const onChanged = typeof options.onRecorded === "function" ? options.onRecorded : null;
  const store = options.store || createRecapStore({
    root: options.root || DEFAULT_ROOT,
    now,
    getTimeZone,
    logWarn,
  });
  const journal = options.journal || createRecapJournal({ store, now, getTimeZone, logWarn });
  const aggregate = options.aggregate || createRecapAggregate({ store, logWarn });
  const coverage = options.coverage || createRecapCoverage({
    store,
    now,
    getTimeZone,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    logWarn,
  });
  const powerMonitor = options.powerMonitor || null;
  const hydrationApplyBatchSize = Number.isSafeInteger(options.hydrationApplyBatchSize)
    && options.hydrationApplyBatchSize > 0
    ? options.hydrationApplyBatchSize
    : HYDRATION_APPLY_BATCH_SIZE;
  const yieldHydrationApply = options.yieldHydrationApply
    || (() => new Promise((resolve) => setImmediate(resolve)));
  let initialized = false;
  let started = false;
  let enabled = false;
  let explicitEnabledIntent = null;
  let suspended = false;
  let midnightTimer = null;
  let unavailable = false;
  let unavailableCode = null;
  let hydrating = false;
  let hydrationPromise = Promise.resolve();
  let hydrationBuffer = [];
  let hydrationOverflow = false;
  let hydrationRebuilding = false;
  let hydrationLiveDedupeKeys = new Set();
  let hydrationToken = 0;
  let lifecycleWired = false;
  let storageRetryTimer = null;
  let storageRetryAttempt = 0;
  let storageRetryGeneration = 0;

  function warn(message, err) {
    try {
      const detail = err && err.message ? err.message : err;
      if (detail === undefined) logWarn(message);
      else logWarn(message, detail);
    } catch {}
  }

  function notifyChanged() {
    if (!onChanged) return;
    try { onChanged(); }
    catch (err) { warn("Clawd: recap change notification failed", err); }
  }

  function currentLocalDate() {
    return freezeLocalTime(now(), getTimeZone()).localDate;
  }

  function resolveEnabledIntent() {
    return explicitEnabledIntent === null
      ? getEnabled() !== false
      : explicitEnabledIntent;
  }

  function prune() {
    const date = currentLocalDate();
    journal.prune(date);
    aggregate.prune(date);
    coverage.prune(date);
  }

  function cancelStorageRetry() {
    storageRetryGeneration += 1;
    if (storageRetryTimer) clearTimer(storageRetryTimer);
    storageRetryTimer = null;
    storageRetryAttempt = 0;
  }

  function activateAfterStorageRecovery() {
    unavailable = false;
    unavailableCode = null;
    storageRetryAttempt = 0;
    enabled = started || explicitEnabledIntent !== null ? resolveEnabledIntent() : false;
    if (started && enabled && !suspended) coverage.start(now());
    if (started) {
      scheduleMidnight();
      beginHydration();
    }
    notifyChanged();
  }

  function scheduleStorageRetry(error) {
    if (!isTransientRecapPrivateAclError(error) || storageRetryTimer) return;
    const delay = STORAGE_RETRY_DELAYS_MS[Math.min(
      storageRetryAttempt,
      STORAGE_RETRY_DELAYS_MS.length - 1
    )];
    storageRetryAttempt += 1;
    const generation = storageRetryGeneration;
    storageRetryTimer = setTimer(() => {
      if (generation !== storageRetryGeneration) return;
      storageRetryTimer = null;
      unavailable = false;
      unavailableCode = null;
      if (!initialize()) return;
      activateAfterStorageRecovery();
    }, delay);
    if (storageRetryTimer && typeof storageRetryTimer.unref === "function") storageRetryTimer.unref();
  }

  function initialize() {
    if (initialized) return true;
    if (unavailable) return false;
    try {
      store.initialize();
      aggregate.load();
      coverage.load();
      prune();
      initialized = true;
      return true;
    } catch (err) {
      unavailable = true;
      unavailableCode = err && typeof err.code === "string" ? err.code : "storage-error";
      enabled = false;
      try { aggregate.resetMemory(); } catch {}
      try { coverage.resetMemory(); } catch {}
      if (!isTransientRecapPrivateAclError(err) || storageRetryAttempt === 0) {
        warn("Clawd: local recap storage is unavailable; recording is paused", unavailableCode);
      }
      scheduleStorageRetry(err);
      return false;
    }
  }

  function beginHydration() {
    if (!initialized || unavailable || hydrating) return hydrationPromise;
    hydrating = true;
    hydrationBuffer = [];
    hydrationOverflow = false;
    hydrationLiveDedupeKeys = new Set();
    const token = ++hydrationToken;
    const anchorDate = currentLocalDate();
    // loadRetainedAsync snapshots retained file sizes before its first await.
    // Call it directly so events accepted after start() are always beyond that
    // snapshot and can be replayed exactly once from hydrationBuffer.
    hydrationPromise = journal.loadRetainedAsync(anchorDate)
      .then(async ({ dates, records, truncated }) => {
        if (token !== hydrationToken || !initialized || unavailable) return;
        if (hydrationOverflow) {
          hydrating = false;
          return beginHydration();
        }
        if (truncated) {
          hydrating = false;
          hydrationBuffer = [];
          hydrationLiveDedupeKeys = new Set();
          try { aggregate.flush(); } catch (err) {
            warn("Clawd: recap aggregate privacy migration flush failed", err && err.code ? err.code : "storage-error");
          }
          warn("Clawd: recap journal reconciliation skipped because retained history exceeded its safety bound");
          return;
        }

        // Events accepted before this replacement were applied to the old
        // monthly cache and are about to be wiped. Replay that exact prefix;
        // events accepted after replacement apply directly to the new cache.
        const bufferedBeforeReplace = hydrationBuffer;
        hydrationBuffer = [];
        hydrationRebuilding = true;
        aggregate.beginBatch();
        aggregate.replaceDates(dates, []);

        const applyBatched = async (recordValues, skipLiveDedupe) => {
          for (let index = 0; index < recordValues.length; index += 1) {
            if (token !== hydrationToken || !initialized || unavailable || hydrationOverflow) return false;
            const recordValue = recordValues[index];
            if (!(
              skipLiveDedupe
              && recordValue.dedupeKeyHash
              && hydrationLiveDedupeKeys.has(recordValue.dedupeKeyHash)
            )) aggregate.apply(recordValue);
            if ((index + 1) % hydrationApplyBatchSize === 0 && index + 1 < recordValues.length) {
              await yieldHydrationApply();
            }
          }
          return token === hydrationToken && initialized && !unavailable && !hydrationOverflow;
        };

        if (!await applyBatched(records, true) || !await applyBatched(bufferedBeforeReplace, false)) {
          if (token !== hydrationToken || !initialized || unavailable) return;
          aggregate.endBatch({ schedule: false });
          // Never leave the first attempt's partial reconstruction publishable
          // while the retry is reading. Restore the last complete monthly cache;
          // every live event remains durable in the journal and the retry will
          // project it again.
          aggregate.resetMemory();
          aggregate.load();
          hydrationRebuilding = false;
          hydrating = false;
          hydrationBuffer = [];
          hydrationLiveDedupeKeys = new Set();
          return beginHydration();
        }

        hydrationBuffer = [];
        hydrationLiveDedupeKeys = new Set();
        hydrating = false;
        try {
          aggregate.endBatch({ flush: true });
        } catch (err) {
          // Reconstruction is complete in memory. Keep dirty months intact so
          // a later lifecycle flush can retry instead of discarding the journal
          // projection and serving an empty/stale cache until restart.
          warn("Clawd: recap aggregate reconciliation flush failed", err && err.code ? err.code : "storage-error");
        }
        hydrationRebuilding = false;
      })
      .catch((err) => {
        if (token !== hydrationToken) return;
        if (hydrationRebuilding) {
          try { aggregate.endBatch({ schedule: false }); } catch {}
          hydrationRebuilding = false;
          try {
            aggregate.resetMemory();
            aggregate.load();
          } catch {}
        }
        hydrating = false;
        hydrationBuffer = [];
        hydrationOverflow = false;
        hydrationLiveDedupeKeys = new Set();
        try { aggregate.flush(); } catch (flushErr) {
          warn("Clawd: recap aggregate privacy migration flush failed", flushErr && flushErr.code ? flushErr.code : "storage-error");
        }
        warn("Clawd: recap journal reconciliation failed", err && err.code ? err.code : "storage-error");
      });
    return hydrationPromise;
  }

  function wireLifecycle() {
    if (lifecycleWired) return;
    lifecycleWired = true;
    if (powerMonitor && typeof powerMonitor.on === "function") {
      powerMonitor.on("suspend", handleSuspend);
      powerMonitor.on("resume", handleResume);
      powerMonitor.on("unlock-screen", handleResume);
    }
  }

  function scheduleMidnight() {
    if (!started) return;
    if (midnightTimer) clearTimer(midnightTimer);
    midnightTimer = setTimer(() => {
      midnightTimer = null;
      try {
        if (enabled && !suspended) coverage.tick(now());
        prune();
      } catch (err) {
        warn("Clawd: recap midnight rollover failed", err);
      }
      scheduleMidnight();
    }, nextLocalMidnightDelay(now(), getTimeZone()));
    if (midnightTimer && typeof midnightTimer.unref === "function") midnightTimer.unref();
  }

  function start() {
    if (started) return false;
    started = true;
    wireLifecycle();
    if (!initialize()) return false;
    enabled = resolveEnabledIntent();
    if (enabled && !suspended) coverage.start(now());
    scheduleMidnight();
    beginHydration();
    return true;
  }

  function handleSuspend() {
    if (!initialized || unavailable || suspended) return;
    suspended = true;
    try {
      if (enabled) coverage.stop(now());
    } catch (err) {
      warn("Clawd: recap suspend checkpoint failed", err && err.code ? err.code : "storage-error");
    }
  }

  function handleResume() {
    if (!initialized || unavailable) return;
    const wasSuspended = suspended;
    suspended = false;
    try {
      if (enabled && wasSuspended) coverage.start(now());
      if (enabled) coverage.tick(now());
      prune();
      scheduleMidnight();
    } catch (err) {
      warn("Clawd: recap resume checkpoint failed", err && err.code ? err.code : "storage-error");
    }
  }

  function setEnabled(next) {
    const value = next !== false;
    // A controller-accepted toggle is authoritative for the rest of this
    // process, even when startup prefs were recovered or storage is currently
    // unavailable. Clear must not silently revert that explicit user intent.
    explicitEnabledIntent = value;
    if (!initialize()) return false;
    if (value === enabled) return false;
    enabled = value;
    if (started && !suspended) {
      if (enabled) coverage.start(now());
      else coverage.stop(now());
    }
    return true;
  }

  function record(event, identity = {}) {
    if (!started || !enabled || !initialize()) return false;
    const canonical = createCanonicalRecapEvent(event);
    if (canonical.occurredAt > now() + MAX_FUTURE_SKEW_MS) return false;
    const recordValue = journal.buildRecord(canonical, identity);
    const anchorDate = currentLocalDate();
    const oldestAcceptedDate = addLocalDays(anchorDate, -13);
    if (
      compareLocalDates(recordValue.localDate, oldestAcceptedDate) < 0
      || compareLocalDates(recordValue.localDate, anchorDate) > 0
    ) return false;
    // Journal first: a process loss can be rebuilt. Updating the monthly cache
    // without a durable event would permanently overcount after restart.
    if (!journal.append(recordValue)) return false;
    aggregate.apply(recordValue);
    if (hydrating) {
      if (hydrationBuffer.length < MAX_HYDRATION_BUFFER) hydrationBuffer.push(recordValue);
      else hydrationOverflow = true;
      if (recordValue.dedupeKeyHash) hydrationLiveDedupeKeys.add(recordValue.dedupeKeyHash);
    }
    notifyChanged();
    return true;
  }

  function query(period = "today", optionsValue = {}) {
    const queryNow = now();
    const queryTime = freezeLocalTime(queryNow, getTimeZone());
    const queryParts = getZonedDateTimeParts(queryNow, queryTime.timeZoneId);
    const currentHourShape = describeLocalDay(queryTime.localDate, queryTime.timeZoneId)[queryTime.localHour];
    const currentHourElapsedMinutes = elapsedMinutesInCurrentLocalHour(
      queryNow,
      queryTime.timeZoneId,
      queryParts,
      currentHourShape.minutes
    );
    const anchorDate = optionsValue.anchorDate || queryTime.localDate;
    const { startDate, endDate } = rangeForPeriod(period, anchorDate);
    if (compareLocalDates(startDate, endDate) > 0) throw new RangeError("invalid recap range");
    if (!initialize()) {
      return {
        schemaVersion: 1,
        status: "unavailable",
        reason: unavailableCode || "storage-error",
        period,
        anchorDate,
        startDate,
        endDate,
        recordingEnabled: false,
        days: [],
      };
    }
    const aggregateDays = aggregate.query(startDate, endDate);
    const coverageDays = coverage.query(startDate, endDate, queryNow);
    const coverageByDate = new Map(coverageDays.map((day) => [day.localDate, day]));
    const meta = store.getMeta();
    const recordingStarted = meta.createdLocalTime || null;
    const days = aggregateDays.map((day) => {
      const coverageValue = coverageByDate.get(day.localDate);
      const hasPersistedShape = day.hourCapacities.some(Boolean)
        || Boolean(coverageValue && coverageValue.hourCapacities.some(Boolean));
      // A closed day that has no recorded activity or coverage carries no
      // timezone provenance by design. Treat it as an ordinary civil day
      // instead of doing 400 expensive timezone scans (or inventing history
      // from today's zone). Any observed day already persisted its real
      // 0/60/120-minute capacities; the live day is resolved exactly here.
      const defaultCapacities = day.localDate === queryTime.localDate
        ? describeLocalDay(day.localDate, queryTime.timeZoneId).map((cell) => cell.minutes)
        : hasPersistedShape
          ? Array(24).fill(0)
          : Array(24).fill(60);
      const hourCapacities = defaultCapacities.map((minutes, hour) =>
        Math.max(
          minutes,
          day.hourCapacities[hour] || 0,
          coverageValue ? coverageValue.hourCapacities[hour] || 0 : 0
        ));
      const normalizedCoverage = coverageValue || {
        localDate: day.localDate,
        coverageMinutes: Array(24).fill(0),
        hourCapacities: hourCapacities.slice(),
      };
      normalizedCoverage.hourCapacities = hourCapacities.slice();
      return {
        localDate: day.localDate,
        coverage: normalizedCoverage,
        hourCapacities,
        rows: day.rows.map((row) => ({
          agentId: row.agentId,
          scope: row.scope,
          scopeInstance: row.scope,
          metrics: row.metrics,
          sessionsStartedPartial: row.sessionsStartedPartial,
          hours: row.hours,
        })),
      };
    });
    const startedParts = recordingStarted
      ? getZonedDateTimeParts(meta.createdAt, recordingStarted.timeZoneId)
      : null;
    const startedHourShape = recordingStarted && startedParts
      ? describeLocalDay(recordingStarted.localDate, recordingStarted.timeZoneId)[recordingStarted.localHour]
      : null;
    const recordingStartedHourElapsedMinutes = startedHourShape
      ? elapsedMinutesInCurrentLocalHour(
        meta.createdAt,
        recordingStarted.timeZoneId,
        startedParts,
        startedHourShape.minutes
      )
      : null;
    return {
      schemaVersion: 1,
      status: "ready",
      period,
      anchorDate,
      startDate,
      endDate,
      currentLocalHour: queryTime.localHour,
      currentLocalMinute: queryParts.localMinute,
      currentHourElapsedMinutes,
      recordingStartedAt: meta.createdAt,
      recordingStartedDate: recordingStarted ? recordingStarted.localDate : null,
      recordingStartedLocalHour: recordingStarted ? recordingStarted.localHour : null,
      recordingStartedLocalMinute: startedParts ? startedParts.localMinute : null,
      recordingStartedHourElapsedMinutes,
      recordingEnabled: enabled,
      days,
    };
  }

  function clear() {
    // Clear is an explicit user recovery action and is allowed to reset an
    // unavailable/corrupt recap generation. No other path rotates its salt.
    // Invalidate async hydration before touching memory. The generation is
    // about to be deleted, so writing coverage or an aggregate first has no
    // value and could publish a partially rebuilt cache if deletion then fails.
    hydrationToken += 1;
    cancelStorageRetry();
    hydrating = false;
    hydrationBuffer = [];
    hydrationOverflow = false;
    hydrationLiveDedupeKeys = new Set();
    if (hydrationRebuilding) {
      try { aggregate.endBatch({ schedule: false }); } catch {}
      hydrationRebuilding = false;
    }
    try { coverage.resetMemory(); } catch {}
    try { aggregate.resetMemory(); } catch {}
    try { journal.resetMemory(); } catch {}
    initialized = false;
    unavailable = false;
    unavailableCode = null;
    try { store.clear(); } catch (err) {
      unavailable = true;
      unavailableCode = err && err.code ? err.code : "storage-error";
      enabled = false;
      warn("Clawd: local recap clear failed", unavailableCode);
      scheduleStorageRetry(err);
      return false;
    }
    if (!initialize()) return false;
    enabled = resolveEnabledIntent();
    if (started && enabled && !suspended) coverage.start(now());
    if (started) {
      scheduleMidnight();
      beginHydration();
    }
    return true;
  }

  function flush() {
    if (!initialized || unavailable) return;
    if (started && enabled && !suspended) coverage.tick(now());
    if (!hydrationRebuilding) aggregate.flush();
  }

  function dispose() {
    const discardHydrationRebuild = hydrationRebuilding;
    cancelStorageRetry();
    if (midnightTimer) clearTimer(midnightTimer);
    midnightTimer = null;
    if (lifecycleWired && powerMonitor && typeof powerMonitor.removeListener === "function") {
      powerMonitor.removeListener("suspend", handleSuspend);
      powerMonitor.removeListener("resume", handleResume);
      powerMonitor.removeListener("unlock-screen", handleResume);
    }
    lifecycleWired = false;
    hydrationToken += 1;
    hydrating = false;
    hydrationBuffer = [];
    hydrationOverflow = false;
    hydrationLiveDedupeKeys = new Set();
    if (hydrationRebuilding) {
      try { aggregate.endBatch({ schedule: false }); } catch {}
      hydrationRebuilding = false;
    }
    try { journal.resetMemory(); } catch {}
    if (initialized) {
      try {
        if (started && enabled && !suspended) coverage.stop(now());
        if (discardHydrationRebuild) aggregate.resetMemory();
        else aggregate.flush();
      } catch (err) {
        warn("Clawd: local recap shutdown flush failed", err && err.code ? err.code : "storage-error");
      }
      try { coverage.resetMemory(); } catch {}
    }
    started = false;
  }

  return Object.freeze({
    clear,
    dispose,
    flush,
    query,
    record,
    setEnabled,
    start,
    whenReady: () => hydrationPromise,
  });
}

module.exports = {
  HYDRATION_APPLY_BATCH_SIZE,
  MAX_FUTURE_SKEW_MS,
  MAX_HYDRATION_BUFFER,
  PERIODS,
  createRecapRuntime,
  elapsedMinutesInCurrentLocalHour,
  nextLocalMidnightDelay,
  rangeForPeriod,
};
