"use strict";

const fs = require("fs");
const { AGENT_METRIC_POLICIES } = require("./recap-metrics");
const {
  addLocalDays,
  compareLocalDates,
  describeLocalDay,
  parseLocalDate,
} = require("./recap-time");
const { DAILY_RETENTION_DAYS } = require("./recap-store");
const MAX_DAYS_PER_MONTH = 31;
const MAX_AGGREGATE_ROWS_PER_DAY = Object.keys(AGENT_METRIC_POLICIES).length * 3;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasSafeAggregateFanout(parsed) {
  if (!isPlainObject(parsed.days)) return false;
  const dayKeys = Object.keys(parsed.days);
  if (dayKeys.length > MAX_DAYS_PER_MONTH) return false;
  for (const localDate of dayKeys) {
    const day = parsed.days[localDate];
    if (!isPlainObject(day)) return false;
    if (day.rows !== undefined) {
      if (!isPlainObject(day.rows) || Object.keys(day.rows).length > MAX_AGGREGATE_ROWS_PER_DAY) return false;
    }
  }
  return true;
}

function monthOf(localDate) {
  parseLocalDate(localDate);
  return localDate.slice(0, 7);
}

function rowKey(record) {
  // Long-lived summaries intentionally merge machine/profile instances. The
  // 14-day journal may use HMACs for dedupe, but 400-day files retain only the
  // broad local / WSL / remote class.
  return `${record.agentId}\0${record.scope}`;
}

function emptyCount(supported) {
  return supported ? 0 : null;
}

function createRow(record) {
  const support = { ...record.support };
  return {
    agentId: record.agentId,
    scope: record.scope,
    metrics: {
      sessionsStarted: emptyCount(support.sessionsStarted),
      turnsCompleted: emptyCount(support.turnsCompleted),
      toolCalls: emptyCount(support.toolCalls),
      activityEvents: 0,
    },
    support,
    sessionsStartedPartial: !support.sessionsStarted,
    hours: Array(24).fill(0),
  };
}

function validCount(value, nullable = false) {
  return (nullable && value === null) || (Number.isSafeInteger(value) && value >= 0);
}

function normalizeRow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!AGENT_METRIC_POLICIES[value.agentId]) return null;
  if (!["local", "wsl", "remote"].includes(value.scope)) return null;
  const metrics = value.metrics || {};
  const support = value.support;
  if (
    !support
    || typeof support !== "object"
    || typeof support.sessionsStarted !== "boolean"
    || typeof support.turnsCompleted !== "boolean"
    || typeof support.toolCalls !== "boolean"
  ) return null;
  const sessionsSupported = support.sessionsStarted;
  const turnsSupported = support.turnsCompleted;
  const toolsSupported = support.toolCalls;
  if (
    !validCount(metrics.sessionsStarted, !sessionsSupported)
    || (sessionsSupported && metrics.sessionsStarted === null)
    || (!sessionsSupported && metrics.sessionsStarted !== null)
    || !validCount(metrics.turnsCompleted, !turnsSupported)
    || (turnsSupported && metrics.turnsCompleted === null)
    || (!turnsSupported && metrics.turnsCompleted !== null)
    || !validCount(metrics.toolCalls, !toolsSupported)
    || (toolsSupported && metrics.toolCalls === null)
    || (!toolsSupported && metrics.toolCalls !== null)
    || !validCount(metrics.activityEvents)
    || !Array.isArray(value.hours)
    || value.hours.length !== 24
    || !value.hours.every((count) => validCount(count))
  ) return null;
  return {
    agentId: value.agentId,
    scope: value.scope,
    metrics: {
      sessionsStarted: metrics.sessionsStarted,
      turnsCompleted: metrics.turnsCompleted,
      toolCalls: metrics.toolCalls,
      activityEvents: metrics.activityEvents,
    },
    support: { ...support },
    sessionsStartedPartial: !sessionsSupported || value.sessionsStartedPartial === true,
    hours: value.hours.slice(),
  };
}

function normalizeDay(localDate, value) {
  try { parseLocalDate(localDate); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rows = {};
  for (const candidate of Object.values(value.rows || {})) {
    const row = normalizeRow(candidate);
    if (!row) continue;
    const key = rowKey(row);
    const existing = rows[key];
    if (!existing) {
      rows[key] = row;
      continue;
    }
    for (const metric of ["sessionsStarted", "turnsCompleted", "toolCalls"]) {
      if (existing.support[metric] !== true || row.support[metric] !== true) {
        existing.support[metric] = false;
        existing.metrics[metric] = null;
      } else {
        existing.metrics[metric] += row.metrics[metric];
      }
    }
    existing.metrics.activityEvents += row.metrics.activityEvents;
    existing.sessionsStartedPartial ||= row.sessionsStartedPartial;
    for (let hour = 0; hour < 24; hour += 1) existing.hours[hour] += row.hours[hour];
  }
  const hourCapacities = Array.isArray(value.hourCapacities)
    && value.hourCapacities.length === 24
    && value.hourCapacities.every((minutes) => Number.isInteger(minutes) && minutes >= 0 && minutes <= 24 * 60)
    ? value.hourCapacities.slice()
    : null;
  if (!hourCapacities) return null;
  return { rows, hourCapacities };
}

function createRecapAggregate(options = {}) {
  if (!options.store) throw new Error("createRecapAggregate requires store");
  const store = options.store;
  const flushDelayMs = Number.isFinite(options.flushDelayMs) ? options.flushDelayMs : 2000;
  const logWarn = options.logWarn || console.warn;
  const months = new Map();
  const dirtyMonths = new Set();
  let flushTimer = null;
  let batchDepth = 0;

  function warn(message, err) {
    try {
      const detail = err && err.message ? err.message : err;
      if (detail === undefined) logWarn(message);
      else logWarn(message, detail);
    } catch {}
  }

  function filePath(month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new TypeError("invalid recap month");
    return store.childPath(`daily-${month}.json`);
  }

  function ensureMonth(month) {
    if (!months.has(month)) months.set(month, { schemaVersion: 2, month, days: {} });
    return months.get(month);
  }

  function load() {
    months.clear();
    let names = [];
    try { names = store.listDirectory(); } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    for (const name of names) {
      const match = /^daily-(\d{4}-\d{2})\.json$/.exec(name);
      if (!match) continue;
      const parsed = store.readJson(store.childPath(name));
      if (
        !parsed
        || parsed.schemaVersion !== 2
        || parsed.month !== match[1]
        || !hasSafeAggregateFanout(parsed)
      ) {
        try {
          store.quarantine(store.childPath(name), "invalid-daily");
          warn("Clawd: quarantined invalid recap daily aggregate");
        } catch (err) {
          throw new Error(`recap daily aggregate could not be quarantined: ${err && err.message}`);
        }
        continue;
      }
      const month = { schemaVersion: 2, month: match[1], days: {} };
      for (const [localDate, candidate] of Object.entries(parsed.days || {})) {
        if (!localDate.startsWith(`${match[1]}-`)) continue;
        const day = normalizeDay(localDate, candidate);
        if (day) month.days[localDate] = day;
      }
      months.set(match[1], month);
      // Rewrite through the allowlist on the normal initialize flush. This
      // strips invalid rows/fields rather than carrying them indefinitely.
      dirtyMonths.add(match[1]);
    }
    if (dirtyMonths.size > 0) scheduleFlush();
  }

  function scheduleFlush() {
    if (batchDepth > 0) return;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try { flush(); } catch (err) { warn("Clawd: recap aggregate flush failed", err); }
    }, flushDelayMs);
    if (flushTimer && typeof flushTimer.unref === "function") flushTimer.unref();
  }

  function markDirty(month) {
    dirtyMonths.add(month);
    scheduleFlush();
  }

  function beginBatch() {
    batchDepth += 1;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  }

  function endBatch(options = {}) {
    if (batchDepth > 0) batchDepth -= 1;
    if (batchDepth > 0 || dirtyMonths.size === 0) return;
    if (options.flush === true) flush();
    else if (options.schedule !== false) scheduleFlush();
  }

  function ensureDay(record) {
    const month = ensureMonth(monthOf(record.localDate));
    let day = month.days[record.localDate];
    if (!day) day = month.days[record.localDate] = {
      rows: {},
      hourCapacities: Array(24).fill(0),
    };
    const capacities = describeLocalDay(record.localDate, record.timeZoneId).map((cell) => cell.minutes);
    for (let hour = 0; hour < 24; hour += 1) {
      day.hourCapacities[hour] = Math.max(day.hourCapacities[hour] || 0, capacities[hour] || 0);
    }
    return { month, day };
  }

  function apply(record, options = {}) {
    const { month, day } = ensureDay(record);
    const key = rowKey(record);
    const row = day.rows[key] || (day.rows[key] = createRow(record));
    for (const metric of ["sessionsStarted", "turnsCompleted", "toolCalls"]) {
      if (row.support[metric] !== true || record.support[metric] !== true) {
        row.support[metric] = false;
        row.metrics[metric] = null;
      }
    }
    if (!row.support.sessionsStarted) row.sessionsStartedPartial = true;
    row.metrics.activityEvents += 1;
    row.hours[record.localHour] += 1;
    if (record.metrics.includes("session-start") && row.metrics.sessionsStarted !== null) {
      row.metrics.sessionsStarted += 1;
    }
    if (record.metrics.includes("turn-complete") && row.metrics.turnsCompleted !== null) {
      row.metrics.turnsCompleted += 1;
    }
    if (record.metrics.includes("tool-call") && row.metrics.toolCalls !== null) {
      row.metrics.toolCalls += 1;
    }
    if (record.sessionStartPartial === true) row.sessionsStartedPartial = true;
    markDirty(month.month);
    if (options.flush === true) flush();
    return row;
  }

  function replaceDates(localDates, records) {
    const changed = new Set();
    for (const localDate of localDates) {
      const monthName = monthOf(localDate);
      const month = ensureMonth(monthName);
      if (month.days[localDate]) delete month.days[localDate];
      changed.add(monthName);
    }
    for (const record of records) apply(record);
    for (const month of changed) markDirty(month);
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
      if (changed) markDirty(monthName);
    }
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    for (const monthName of [...dirtyMonths]) {
      const month = ensureMonth(monthName);
      if (Object.keys(month.days).length === 0) {
        try { fs.unlinkSync(filePath(monthName)); } catch (err) {
          if (!err || err.code !== "ENOENT") throw err;
        }
      } else {
        store.writeJsonAtomic(filePath(monthName), month);
      }
      dirtyMonths.delete(monthName);
    }
  }

  function query(startDate, endDate) {
    parseLocalDate(startDate);
    parseLocalDate(endDate);
    if (compareLocalDates(startDate, endDate) > 0) throw new RangeError("recap query range is reversed");
    const days = [];
    for (let date = startDate; compareLocalDates(date, endDate) <= 0; date = addLocalDays(date, 1)) {
      const day = months.get(monthOf(date));
      const value = day && day.days[date];
      days.push({
        localDate: date,
        hourCapacities: value ? value.hourCapacities.slice() : Array(24).fill(0),
        rows: value ? Object.values(value.rows).map((row) => ({
          ...row,
          metrics: { ...row.metrics },
          support: { ...row.support },
          hours: row.hours.slice(),
        })) : [],
      });
    }
    return days;
  }

  function resetMemory() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    batchDepth = 0;
    months.clear();
    dirtyMonths.clear();
  }

  return Object.freeze({ apply, beginBatch, endBatch, flush, load, prune, query, replaceDates, resetMemory });
}

module.exports = {
  MAX_AGGREGATE_ROWS_PER_DAY,
  MAX_DAYS_PER_MONTH,
  createRecapAggregate,
  hasSafeAggregateFanout,
  normalizeDay,
};
