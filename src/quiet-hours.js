"use strict";

const DEFAULT_QUIET_HOURS = Object.freeze({
  enabled: false, days: Object.freeze([1, 2, 3, 4, 5]),
  start: "22:00", end: "08:00", hidePet: false,
});
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function validateQuietHours(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.enabled !== "boolean" || typeof value.hidePet !== "boolean"
    || !Array.isArray(value.days) || !value.days.length || value.days.length > 7
    || value.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
    || new Set(value.days).size !== value.days.length
    || !TIME.test(value.start) || !TIME.test(value.end) || value.start === value.end) {
    return { ok: false, message: "Choose weekdays and different start/end times (HH:mm)." };
  }
  return { ok: true, value: { enabled: value.enabled, days: [...value.days].sort(),
    start: value.start, end: value.end, hidePet: value.hidePet } };
}

function normalizeQuietHours(value) {
  const result = validateQuietHours(value);
  return result.ok ? result.value : { ...DEFAULT_QUIET_HOURS, days: [...DEFAULT_QUIET_HOURS.days] };
}

function minutes(time) {
  const [hours, mins] = time.split(":").map(Number);
  return hours * 60 + mins;
}

// Overnight schedules belong to the day on which they START. Use local
// calendar dates, rather than 24-hour millisecond arithmetic, across DST.
function getQuietHoursInterval(config, date = new Date()) {
  const result = validateQuietHours(config);
  if (!result.ok || !config.enabled || !Number.isFinite(date.getTime())) return null;
  const start = minutes(config.start), end = minutes(config.end);
  const current = date.getHours() * 60 + date.getMinutes();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (start < end) {
    if (current < start || current >= end) return null;
  } else if (current >= start) {
    // Today's overnight interval.
  } else if (current < end) {
    startDate.setDate(startDate.getDate() - 1);
  } else return null;
  if (!config.days.includes(startDate.getDay())) return null;
  return `${startDate.getFullYear()}-${startDate.getMonth() + 1}-${startDate.getDate()}:${config.start}`;
}

function createQuietHoursScheduler(options) {
  const getConfig = options.getConfig;
  const getState = options.getState;
  const applyState = options.applyState;
  const now = options.now || (() => new Date());
  const setTimer = options.setInterval || setInterval;
  const clearTimer = options.clearInterval || clearInterval;
  let timer = null, disposed = false, signature = null, interval = null, pausedInterval = null;
  const owned = new Map();

  function report(error) { try { options.onError?.(error); } catch {} }
  function restore(except) {
    let state;
    try { state = getState(); } catch (error) { report(error); return; }
    for (const [field, original] of owned) {
      // An outside owner changed it: relinquish it without overriding them.
      if (field !== except && state[field] === true) {
        try {
          applyState({ [field]: original });
          // A mini-mode transition can defer visibility without throwing.
          if (getState()[field] !== original) continue;
        } catch (error) { report(error); continue; }
      }
      owned.delete(field);
    }
  }

  function poll() {
    if (disposed) return;
    try {
      const config = normalizeQuietHours(getConfig());
      const nextSignature = JSON.stringify(config);
      if (signature !== nextSignature) {
        restore();
        // Do not acquire a new interval until failed restoration is retried.
        if (owned.size) return;
        signature = nextSignature; interval = null; pausedInterval = null;
      }
      const date = now();
      const nextInterval = getQuietHoursInterval(config, date instanceof Date ? date : new Date(date));
      if (nextInterval !== interval) {
        restore();
        if (owned.size) return;
        interval = nextInterval; pausedInterval = null;
      }
      if (!interval || pausedInterval === interval) {
        restore(); // Retry a failed restoration even while manual override pauses acquisition.
        return;
      }
      const state = getState();
      for (const field of config.hidePet ? ["dnd", "hidden"] : ["dnd"]) {
        if (owned.has(field)) {
          if (state[field] !== true) { noteManualChange(field); return; }
        } else if (state[field] === false) {
          try { applyState({ [field]: true }); }
          finally {
            // State can change before a renderer side effect throws. Retain
            // ownership of the actual transition, including partial success.
            if (getState()[field] === true) owned.set(field, false);
          }
        }
      }
    } catch (error) { report(error); }
  }

  function noteManualChange(field) {
    if (disposed || !interval) return;
    pausedInterval = interval;
    restore(field);
  }

  function start() {
    if (disposed || timer) return;
    poll();
    timer = setTimer(poll, 30_000);
    timer?.unref?.();
  }
  function dispose({ restore: shouldRestore = true } = {}) {
    if (timer) clearTimer(timer);
    timer = null;
    if (shouldRestore) restore();
    owned.clear(); disposed = true;
  }
  return { start, poll, noteManualChange, dispose };
}

module.exports = { DEFAULT_QUIET_HOURS, validateQuietHours, normalizeQuietHours,
  getQuietHoursInterval, createQuietHoursScheduler };
