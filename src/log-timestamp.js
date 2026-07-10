"use strict";

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

// offsetMinutes is minutes east of UTC, matching an ISO-8601 suffix.
function formatLocalTimestamp(value = new Date(), offsetMinutes) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid date");

  const offset = offsetMinutes == null
    ? -date.getTimezoneOffset()
    : Math.trunc(Number(offsetMinutes));
  if (!Number.isFinite(offset)) throw new TypeError("Invalid timezone offset");

  const shifted = new Date(date.getTime() + offset * 60 * 1000);
  const sign = offset >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offset);
  const offsetHours = Math.floor(absoluteOffset / 60);
  const offsetRemainder = absoluteOffset % 60;

  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `.${pad(shifted.getUTCMilliseconds(), 3)}${sign}${pad(offsetHours)}:${pad(offsetRemainder)}`
  );
}

module.exports = { formatLocalTimestamp };
