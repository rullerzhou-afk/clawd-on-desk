"use strict";

const fs = require("fs");
const {
  addLocalDays,
  compareLocalDates,
  describeLocalDay,
  freezeLocalTime,
  getZonedDateTimeParts,
  getSystemTimeZone,
  isValidTimeZone,
  parseLocalDate,
} = require("./recap-time");
const { DAILY_RETENTION_DAYS } = require("./recap-store");

const HEARTBEAT_MS = 60000;
const COVERAGE_SCHEMA_VERSION = 2;
const MAX_OPEN_FUTURE_SKEW_MS = 5 * 60000;
const MAX_COVERAGE_DAYS_PER_MONTH = 31;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasSafeCoverageFanout(parsed) {
  if (!isPlainObject(parsed.days)) return false;
  const dayKeys = Object.keys(parsed.days);
  if (dayKeys.length > MAX_COVERAGE_DAYS_PER_MONTH) return false;
  for (const localDate of dayKeys) {
    const day = parsed.days[localDate];
    if (!isPlainObject(day)) return false;
  }
  return true;
}

function monthOf(localDate) {
  parseLocalDate(localDate);
  return localDate.slice(0, 7);
}

function emptyDay() {
  return { coverageMinutes: Array(24).fill(0), hourCapacities: Array(24).fill(0) };
}

function validMinuteArray(value, max) {
  return Array.isArray(value) && value.length === 24
    && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= max);
}

function normalizeBucketDay(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!validMinuteArray(value.coverageMinutes, 24 * 60)) return null;
  if (!validMinuteArray(value.hourCapacities, 24 * 60)) return null;
  if (value.coverageMinutes.some((minutes, hour) => minutes > value.hourCapacities[hour])) return null;
  return {
    coverageMinutes: value.coverageMinutes.slice(),
    hourCapacities: value.hourCapacities.slice(),
  };
}

function capacityForDate(localDate, timeZoneId) {
  return describeLocalDay(localDate, timeZoneId).map((cell) => cell.minutes);
}

function mergeCapacities(target, source) {
  for (let hour = 0; hour < 24; hour += 1) {
    target[hour] = Math.max(target[hour] || 0, source[hour] || 0);
  }
}

function quantizeDay(day) {
  for (let hour = 0; hour < 24; hour += 1) {
    day.hourCapacities[hour] = Math.max(0, Math.round(day.hourCapacities[hour] || 0));
    day.coverageMinutes[hour] = Math.min(
      day.hourCapacities[hour],
      Math.max(0, Math.round(day.coverageMinutes[hour] || 0))
    );
  }
}

function createRecapCoverage(options = {}) {
  if (!options.store) throw new Error("createRecapCoverage requires store");
  const store = options.store;
  const now = options.now || Date.now;
  const getTimeZone = options.getTimeZone || getSystemTimeZone;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const heartbeatMs = Number.isFinite(options.heartbeatMs) ? options.heartbeatMs : HEARTBEAT_MS;
  const logWarn = options.logWarn || console.warn;
  const months = new Map();
  let open = null;
  let heartbeatTimer = null;

  function warn(message, err) {
    try {
      const detail = err && err.message ? err.message : err;
      if (detail === undefined) logWarn(message);
      else logWarn(message, detail);
    } catch {}
  }

  function monthPath(month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new TypeError("invalid coverage month");
    return store.childPath(`coverage-${month}.json`);
  }

  function openPath() { return store.childPath("coverage-open.json"); }

  function ensureMonth(month) {
    if (!months.has(month)) months.set(month, { schemaVersion: COVERAGE_SCHEMA_VERSION, month, days: {} });
    return months.get(month);
  }

  function ensureDay(targetMonths, localDate) {
    const monthName = monthOf(localDate);
    let month = targetMonths.get(monthName);
    if (!month) {
      month = { schemaVersion: COVERAGE_SCHEMA_VERSION, month: monthName, days: {} };
      targetMonths.set(monthName, month);
    }
    if (!month.days[localDate]) month.days[localDate] = emptyDay();
    return month.days[localDate];
  }

  function persistMonth(monthName) {
    const month = ensureMonth(monthName);
    if (Object.keys(month.days).length === 0) {
      try { fs.unlinkSync(monthPath(monthName)); } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
      return;
    }
    for (const day of Object.values(month.days)) quantizeDay(day);
    store.writeJsonAtomic(monthPath(monthName), month);
  }

  function persistOpen() {
    if (!open) {
      try { fs.unlinkSync(openPath()); } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
      return;
    }
    store.writeJsonAtomic(openPath(), {
      // Open heartbeats are recovery-only: clean close deletes this file before
      // committing a coarse bucket, so recovery can safely add the crash tail.
      schemaVersion: COVERAGE_SCHEMA_VERSION,
      startedAt: open.startedAt,
      lastHeartbeatAt: open.lastHeartbeatAt,
      timeZoneId: open.timeZoneId,
    });
  }

  function accumulateInterval(targetMonths, startedAt, endedAt, timeZoneId) {
    if (endedAt <= startedAt) return new Set();
    const touched = new Set();
    const capacityCache = new Map();
    let cursor = startedAt;
    while (cursor < endedAt) {
      const local = getZonedDateTimeParts(cursor, timeZoneId);
      const elapsedInWallHourMs = local.localMinute * 60000 + local.localSecond * 1000 + (cursor % 1000);
      const next = Math.min(endedAt, cursor + Math.max(1, 3600000 - elapsedInWallHourMs));
      const day = ensureDay(targetMonths, local.localDate);
      let capacities = capacityCache.get(local.localDate);
      if (!capacities) {
        capacities = capacityForDate(local.localDate, timeZoneId);
        capacityCache.set(local.localDate, capacities);
      }
      mergeCapacities(day.hourCapacities, capacities);
      day.coverageMinutes[local.localHour] = Math.min(
        day.hourCapacities[local.localHour],
        day.coverageMinutes[local.localHour] + (next - cursor) / 60000
      );
      touched.add(monthOf(local.localDate));
      cursor = next;
    }
    return touched;
  }

  function addClosedInterval(startedAt, endedAt, timeZoneId) {
    const touched = accumulateInterval(months, startedAt, endedAt, timeZoneId);
    for (const monthName of touched) persistMonth(monthName);
    return touched.size > 0;
  }

  function readOpenHeartbeat() {
    const filePath = openPath();
    let stat;
    try { stat = fs.lstatSync(filePath); } catch (err) {
      if (err && err.code === "ENOENT") return null;
      throw err;
    }
    const saved = stat.isFile() ? store.readJson(filePath) : null;
    if (!saved || saved.schemaVersion !== COVERAGE_SCHEMA_VERSION) {
      try { store.quarantine(filePath, "invalid-open"); } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
      warn("Clawd: discarded invalid recap coverage heartbeat");
      return null;
    }
    const duration = saved.lastHeartbeatAt - saved.startedAt;
    if (
      !Number.isSafeInteger(saved.startedAt) || !Number.isSafeInteger(saved.lastHeartbeatAt)
      || saved.startedAt < 0 || saved.lastHeartbeatAt < saved.startedAt
      || !isValidTimeZone(saved.timeZoneId)
      || duration > HEARTBEAT_MS
      || saved.lastHeartbeatAt > now() + MAX_OPEN_FUTURE_SKEW_MS
    ) {
      warn("Clawd: discarded invalid recap coverage heartbeat");
      try { fs.unlinkSync(filePath); } catch {}
      return null;
    }
    return saved;
  }

  function recoverOpenInterval(saved) {
    if (!saved) return false;
    fs.unlinkSync(openPath());
    addClosedInterval(saved.startedAt, saved.lastHeartbeatAt, saved.timeZoneId);
    return true;
  }

  function load() {
    months.clear();
    const savedOpen = readOpenHeartbeat();
    let names = [];
    try { names = store.listDirectory(); } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    for (const name of names) {
      const match = /^coverage-(\d{4}-\d{2})\.json$/.exec(name);
      if (!match) continue;
      const filePath = store.childPath(name);
      const parsed = store.readJson(filePath);
      if (
        !parsed
        || parsed.schemaVersion !== COVERAGE_SCHEMA_VERSION
        || parsed.month !== match[1]
        || !hasSafeCoverageFanout(parsed)
      ) {
        store.quarantine(filePath, "invalid-coverage");
        warn("Clawd: quarantined invalid recap coverage file");
        continue;
      }
      const month = { schemaVersion: COVERAGE_SCHEMA_VERSION, month: match[1], days: {} };
      for (const [localDate, candidate] of Object.entries(parsed.days || {})) {
        try { parseLocalDate(localDate); } catch { continue; }
        if (!localDate.startsWith(`${match[1]}-`)) continue;
        const day = normalizeBucketDay(candidate);
        if (day) month.days[localDate] = day;
      }
      months.set(match[1], month);
    }
    if (savedOpen) recoverOpenInterval(savedOpen);
  }

  function scheduleHeartbeat() {
    if (!open || heartbeatTimer) return;
    heartbeatTimer = setTimer(() => {
      heartbeatTimer = null;
      try { tick(now()); } catch (err) { warn("Clawd: recap coverage heartbeat failed", err); }
      scheduleHeartbeat();
    }, heartbeatMs);
    if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  }

  function start(at = now()) {
    if (open) return false;
    const requestedTimeZone = getTimeZone();
    const timeZoneId = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : "UTC";
    open = { startedAt: at, lastHeartbeatAt: at, timeZoneId };
    persistOpen();
    scheduleHeartbeat();
    return true;
  }

  function stop(at = now()) {
    if (!open) return false;
    if (heartbeatTimer) clearTimer(heartbeatTimer);
    heartbeatTimer = null;
    const closed = { ...open };
    open = null;
    // Delete the precise heartbeat before writing coarse history. This makes a
    // crash lose at most one heartbeat window instead of double-counting it.
    persistOpen();
    addClosedInterval(closed.startedAt, Math.max(closed.startedAt, at), closed.timeZoneId);
    return true;
  }

  function tick(at = now()) {
    if (!open) return false;
    const requestedTimeZone = getTimeZone();
    const zone = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : "UTC";
    const oldLocal = freezeLocalTime(open.lastHeartbeatAt, open.timeZoneId);
    const newLocal = freezeLocalTime(at, zone);
    if (zone !== open.timeZoneId || oldLocal.localDate !== newLocal.localDate) {
      const previous = { ...open };
      // Commit the new precise marker first. If the following coarse write is
      // interrupted, recovery loses only the remainder since the previous
      // minute checkpoint and can never replay the whole run twice.
      open = { startedAt: at, lastHeartbeatAt: at, timeZoneId: zone };
      persistOpen();
      addClosedInterval(previous.startedAt, at, previous.timeZoneId);
      return true;
    } else {
      const heartbeatAt = Math.max(open.lastHeartbeatAt, at);
      const wholeMinutes = Math.floor((heartbeatAt - open.startedAt) / 60000);
      if (wholeMinutes > 0) {
        const previousStartedAt = open.startedAt;
        const checkpointAt = previousStartedAt + wholeMinutes * 60000;
        open.startedAt = checkpointAt;
        open.lastHeartbeatAt = heartbeatAt;
        persistOpen();
        addClosedInterval(previousStartedAt, checkpointAt, open.timeZoneId);
        return true;
      }
      open.lastHeartbeatAt = heartbeatAt;
    }
    persistOpen();
    return true;
  }

  function prune(anchorDate) {
    const oldest = addLocalDays(anchorDate, -(DAILY_RETENTION_DAYS - 1));
    for (const [monthName, month] of months) {
      let changed = false;
      for (const localDate of Object.keys(month.days)) {
        if (compareLocalDates(localDate, oldest) < 0) {
          delete month.days[localDate];
          changed = true;
        }
      }
      if (changed) persistMonth(monthName);
    }
  }

  function query(startDate, endDate, queryNow = now()) {
    parseLocalDate(startDate);
    parseLocalDate(endDate);
    const projected = new Map();
    if (open) {
      const projectionMonths = new Map();
      accumulateInterval(projectionMonths, open.startedAt, Math.max(open.startedAt, queryNow), open.timeZoneId);
      for (const month of projectionMonths.values()) {
        for (const [date, day] of Object.entries(month.days)) projected.set(date, day);
      }
    }
    const result = [];
    for (let date = startDate; compareLocalDates(date, endDate) <= 0; date = addLocalDays(date, 1)) {
      const storedMonth = months.get(monthOf(date));
      const stored = storedMonth && storedMonth.days[date];
      const day = stored ? {
        coverageMinutes: stored.coverageMinutes.slice(),
        hourCapacities: stored.hourCapacities.slice(),
      } : emptyDay();
      const current = projected.get(date);
      if (current) {
        mergeCapacities(day.hourCapacities, current.hourCapacities);
        for (let hour = 0; hour < 24; hour += 1) {
          day.coverageMinutes[hour] = Math.min(
            day.hourCapacities[hour],
            day.coverageMinutes[hour] + current.coverageMinutes[hour]
          );
        }
      }
      quantizeDay(day);
      result.push({ localDate: date, ...day });
    }
    return result;
  }

  function resetMemory() {
    if (heartbeatTimer) clearTimer(heartbeatTimer);
    heartbeatTimer = null;
    open = null;
    months.clear();
  }

  return Object.freeze({ load, prune, query, resetMemory, start, stop, tick });
}

module.exports = {
  COVERAGE_SCHEMA_VERSION,
  HEARTBEAT_MS,
  MAX_COVERAGE_DAYS_PER_MONTH,
  createRecapCoverage,
  hasSafeCoverageFanout,
  normalizeBucketDay,
};
