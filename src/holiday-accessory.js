"use strict";

const {
  getPetAccessoryIdForTheme,
  isPetAccessoryId,
  resolvePetAccessoryPayload,
} = require("./pet-customization-catalog");

const MAX_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const MIN_REFRESH_DELAY_MS = 1000;

function freezeWindow({ id, accessoryId, ranges }) {
  return Object.freeze({
    id,
    accessoryId,
    ranges: Object.freeze(ranges.map((range) => Object.freeze({ ...range }))),
  });
}

const HOLIDAY_ACCESSORY_WINDOWS = Object.freeze([
  freezeWindow({
    id: "halloween",
    accessoryId: "pumpkin-hat",
    ranges: [
      { month: 10, startDay: 28, endDay: 31 },
      { month: 11, startDay: 1, endDay: 1 },
    ],
  }),
  freezeWindow({
    id: "christmas",
    accessoryId: "santa-hat",
    ranges: [
      { month: 12, startDay: 22, endDay: 27 },
    ],
  }),
  freezeWindow({
    id: "new-year",
    accessoryId: "party-hat",
    ranges: [
      { month: 12, startDay: 31, endDay: 31 },
      { month: 1, startDay: 1, endDay: 2 },
    ],
  }),
]);

function isValidDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function getHolidayAccessoryForDate(date = new Date()) {
  if (!isValidDate(date)) return null;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  for (const holiday of HOLIDAY_ACCESSORY_WINDOWS) {
    const matches = holiday.ranges.some((range) => (
      month === range.month
      && day >= range.startDay
      && day <= range.endDay
    ));
    if (matches && isPetAccessoryId(holiday.accessoryId)) {
      return {
        holidayId: holiday.id,
        accessoryId: holiday.accessoryId,
      };
    }
  }
  return null;
}

function isHolidayAccessoryEnabledForTheme(selections, themeId) {
  if (!selections || typeof selections !== "object" || Array.isArray(selections)) return false;
  if (typeof themeId !== "string" || !themeId) return false;
  return selections[themeId] === true;
}

function getEffectivePetAccessoryIdForTheme({
  petAccessory,
  holidayAccessoryEnabled,
  themeId,
  date = new Date(),
} = {}) {
  const manualAccessoryId = getPetAccessoryIdForTheme(petAccessory, themeId);
  if (!isHolidayAccessoryEnabledForTheme(holidayAccessoryEnabled, themeId)) {
    return manualAccessoryId;
  }
  const holiday = getHolidayAccessoryForDate(date);
  return holiday ? holiday.accessoryId : manualAccessoryId;
}

function getNextHolidayRefreshDelay(date = new Date()) {
  if (!isValidDate(date)) return MAX_REFRESH_INTERVAL_MS;
  const nextLocalMidnight = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1,
    0,
    0,
    1,
    0
  );
  const untilMidnight = nextLocalMidnight.getTime() - date.getTime();
  if (!Number.isFinite(untilMidnight)) return MAX_REFRESH_INTERVAL_MS;
  return Math.max(
    MIN_REFRESH_DELAY_MS,
    Math.min(MAX_REFRESH_INTERVAL_MS, untilMidnight)
  );
}

function createHolidayAccessoryRuntime(options = {}) {
  const getSettingsSnapshot = options.getSettingsSnapshot;
  const getActiveTheme = options.getActiveTheme;
  const sendToRenderer = options.sendToRenderer;
  if (typeof getSettingsSnapshot !== "function") {
    throw new Error("createHolidayAccessoryRuntime requires getSettingsSnapshot");
  }
  if (typeof getActiveTheme !== "function") {
    throw new Error("createHolidayAccessoryRuntime requires getActiveTheme");
  }
  if (typeof sendToRenderer !== "function") {
    throw new Error("createHolidayAccessoryRuntime requires sendToRenderer");
  }

  const powerMonitor = options.powerMonitor || null;
  const now = options.now || (() => new Date());
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const logWarn = options.logWarn || console.warn;

  let started = false;
  let refreshTimer = null;
  let lastDisplayKey = null;

  function resolveDisplay() {
    const snapshot = getSettingsSnapshot() || {};
    const theme = getActiveTheme() || null;
    const themeId = theme && theme._id;
    const accessoryId = getEffectivePetAccessoryIdForTheme({
      petAccessory: snapshot.petAccessory,
      holidayAccessoryEnabled: snapshot.holidayAccessoryEnabled,
      themeId,
      date: now(),
    });
    return {
      key: `${themeId || ""}|${accessoryId}`,
      payload: resolvePetAccessoryPayload(accessoryId, theme),
    };
  }

  function refresh({ force = false } = {}) {
    let resolved;
    try {
      resolved = resolveDisplay();
    } catch (err) {
      try { logWarn("Clawd: holiday accessory refresh failed:", err && err.message); } catch {}
      return false;
    }
    if (!force && resolved.key === lastDisplayKey) return false;
    try {
      sendToRenderer("pet-accessory-change", resolved.payload);
      lastDisplayKey = resolved.key;
      return true;
    } catch (err) {
      try { logWarn("Clawd: holiday accessory delivery failed:", err && err.message); } catch {}
      return false;
    }
  }

  function clearScheduledRefresh() {
    if (refreshTimer == null) return;
    clearTimeoutFn(refreshTimer);
    refreshTimer = null;
  }

  function scheduleRefresh() {
    clearScheduledRefresh();
    if (!started) return;
    const delay = getNextHolidayRefreshDelay(now());
    refreshTimer = setTimeoutFn(() => {
      refreshTimer = null;
      refresh();
      scheduleRefresh();
    }, delay);
    if (refreshTimer && typeof refreshTimer.unref === "function") refreshTimer.unref();
  }

  function handleClockContextChange() {
    refresh();
    scheduleRefresh();
  }

  function start() {
    if (started) return;
    started = true;
    if (powerMonitor && typeof powerMonitor.on === "function") {
      powerMonitor.on("resume", handleClockContextChange);
      powerMonitor.on("unlock-screen", handleClockContextChange);
    }
    refresh();
    scheduleRefresh();
  }

  function dispose() {
    if (!started) return;
    started = false;
    clearScheduledRefresh();
    if (powerMonitor && typeof powerMonitor.removeListener === "function") {
      powerMonitor.removeListener("resume", handleClockContextChange);
      powerMonitor.removeListener("unlock-screen", handleClockContextChange);
    }
    lastDisplayKey = null;
  }

  return {
    start,
    refresh,
    dispose,
  };
}

module.exports = {
  HOLIDAY_ACCESSORY_WINDOWS,
  MAX_REFRESH_INTERVAL_MS,
  getHolidayAccessoryForDate,
  isHolidayAccessoryEnabledForTheme,
  getEffectivePetAccessoryIdForTheme,
  getNextHolidayRefreshDelay,
  createHolidayAccessoryRuntime,
};
