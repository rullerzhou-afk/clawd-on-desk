"use strict";

const FORMATTERS = new Map();
const DAY_SHAPES = new Map();
const TIME_ZONE_VALIDITY = new Map();

function isValidTimeZone(value) {
  if (typeof value !== "string" || !value || value.length > 128) return false;
  if (TIME_ZONE_VALIDITY.has(value)) return TIME_ZONE_VALIDITY.get(value);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    TIME_ZONE_VALIDITY.set(value, true);
    return true;
  } catch {
    TIME_ZONE_VALIDITY.set(value, false);
    return false;
  }
}

function getSystemTimeZone() {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(detected) ? detected : "UTC";
}

function getFormatter(timeZone) {
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  let formatter = FORMATTERS.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    FORMATTERS.set(zone, formatter);
  }
  return formatter;
}

function zonedParts(epochMs, timeZone) {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new TypeError("recap epoch must be a non-negative safe integer");
  }
  const values = {};
  for (const part of getFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const year = values.year;
  const month = values.month;
  const day = values.day;
  const hour = values.hour === 24 ? 0 : values.hour;
  const minute = values.minute;
  const second = values.second;
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) {
    throw new Error("recap local time could not be resolved");
  }
  return { year, month, day, hour, minute, second };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function localDateFromParts(parts) {
  return `${String(parts.year).padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function getZonedDateTimeParts(epochMs, timeZone = getSystemTimeZone()) {
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const parts = zonedParts(epochMs, zone);
  return Object.freeze({
    timeZoneId: zone,
    localDate: localDateFromParts(parts),
    localHour: parts.hour,
    localMinute: parts.minute,
    localSecond: parts.second,
  });
}

function freezeLocalTime(epochMs, timeZone = getSystemTimeZone()) {
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const parts = zonedParts(epochMs, zone);
  const epochSecond = Math.floor(epochMs / 1000) * 1000;
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return Object.freeze({
    occurredAt: epochMs,
    timeZoneId: zone,
    utcOffsetMinutes: Math.round((localAsUtc - epochSecond) / 60000),
    localDate: localDateFromParts(parts),
    localHour: parts.hour,
  });
}

function parseLocalDate(localDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate || "");
  if (!match) throw new TypeError("invalid recap local date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) throw new TypeError("invalid recap local date");
  return { year, month, day };
}

function addLocalDays(localDate, amount) {
  const parts = parseLocalDate(localDate);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function compareLocalDates(left, right) {
  parseLocalDate(left);
  parseLocalDate(right);
  return left < right ? -1 : left > right ? 1 : 0;
}

function describeLocalDay(localDate, timeZone = getSystemTimeZone()) {
  parseLocalDate(localDate);
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const key = `${zone}\0${localDate}`;
  const cached = DAY_SHAPES.get(key);
  if (cached) return cached.map((cell) => ({ ...cell, offsets: cell.offsets.slice() }));

  const parts = parseLocalDate(localDate);
  const center = Date.UTC(parts.year, parts.month - 1, parts.day, 12);
  const sampleOffsetsByHour = Array.from(
    { length: 24 },
    () => Array.from({ length: 4 }, () => new Set())
  );
  // Count quarter-hour wall-clock slots. Current IANA civil offsets and DST
  // transitions are aligned to this grid: normal=4, whole-hour gap/fold=0/8,
  // Lord Howe half-hour gap/fold=2/6. This keeps startup bounded while still
  // representing partial-hour transitions honestly.
  for (let epoch = center - 36 * 3600000; epoch <= center + 36 * 3600000; epoch += 15 * 60000) {
    const partsAtEpoch = zonedParts(epoch, zone);
    if (localDateFromParts(partsAtEpoch) !== localDate) continue;
    const localAsUtc = Date.UTC(
      partsAtEpoch.year,
      partsAtEpoch.month - 1,
      partsAtEpoch.day,
      partsAtEpoch.hour,
      partsAtEpoch.minute,
      partsAtEpoch.second
    );
    const offset = Math.round((localAsUtc - epoch) / 60000);
    const quarter = Math.floor(partsAtEpoch.minute / 15);
    sampleOffsetsByHour[partsAtEpoch.hour][quarter].add(offset);
  }
  const shape = sampleOffsetsByHour.map((samples, hour) => {
    const allOffsets = new Set();
    let occurrences = 0;
    for (const offsets of samples) {
      occurrences += offsets.size;
      for (const offset of offsets) allOffsets.add(offset);
    }
    const values = [...allOffsets].sort((a, b) => a - b);
    return Object.freeze({
      hour,
      kind: occurrences < 4 ? "gap" : occurrences > 4 ? "fold" : "normal",
      minutes: occurrences * 15,
      offsets: Object.freeze(values),
    });
  });
  DAY_SHAPES.set(key, shape);
  return shape.map((cell) => ({ ...cell, offsets: cell.offsets.slice() }));
}

module.exports = {
  addLocalDays,
  compareLocalDates,
  describeLocalDay,
  freezeLocalTime,
  getZonedDateTimeParts,
  getSystemTimeZone,
  isValidTimeZone,
  parseLocalDate,
};
