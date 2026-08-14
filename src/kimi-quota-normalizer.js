"use strict";

const { normalizeQuotaBucket } = require("../hooks/quota-bucket");

const KIMI_QUOTA_FIELDS = ["kimiFiveHour", "kimiWeekly"];
const FIVE_HOUR_MINUTES = 300;
const WEEK_MINUTES = 7 * 24 * 60;
const DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const DECIMAL_MAX_LENGTH = 64;
const CONSISTENCY_RELATIVE_TOLERANCE = 1e-6;

class KimiQuotaSchemaError extends Error {
  constructor(reason) {
    super(`Invalid Kimi quota response: ${reason}`);
    this.name = "KimiQuotaSchemaError";
    this.code = "KIMI_QUOTA_SCHEMA_ERROR";
    this.reason = reason;
  }
}

function schemaError(reason) {
  throw new KimiQuotaSchemaError(reason);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function parseDecimal(value, field) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) schemaError(`${field}-not-finite`);
    return value;
  }
  if (typeof value !== "string"
      || value.length > DECIMAL_MAX_LENGTH
      || !DECIMAL_RE.test(value)) {
    schemaError(`${field}-not-decimal`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) schemaError(`${field}-not-finite`);
  return parsed;
}

function parseResetTime(value) {
  if (typeof value !== "string" || value.length > 80) schemaError("resetTime-not-string");
  const resetAt = Date.parse(value);
  if (!Number.isFinite(resetAt)) schemaError("resetTime-invalid");
  return resetAt;
}

function parseCandidate(value, capturedAt, windowMinutes) {
  if (!isPlainObject(value)) schemaError("candidate-not-object");
  if (!hasOwn(value, "limit")) schemaError("candidate-limit-missing");
  if (!hasOwn(value, "resetTime")) schemaError("candidate-resetTime-missing");

  const hasUsed = hasOwn(value, "used");
  const hasRemaining = hasOwn(value, "remaining");
  if (!hasUsed && !hasRemaining) schemaError("candidate-usage-missing");

  const limit = parseDecimal(value.limit, "limit");
  if (!(limit > 0)) schemaError("limit-not-positive");

  let used = null;
  let remaining = null;
  if (hasUsed) {
    used = parseDecimal(value.used, "used");
    if (used < 0) schemaError("used-negative");
  }
  if (hasRemaining) {
    remaining = parseDecimal(value.remaining, "remaining");
    if (remaining < 0 || remaining > limit) schemaError("remaining-out-of-range");
  }
  if (hasUsed && hasRemaining) {
    const tolerance = CONSISTENCY_RELATIVE_TOLERANCE * Math.max(1, Math.abs(limit));
    if (Math.abs((used + remaining) - limit) > tolerance) {
      schemaError("used-remaining-conflict");
    }
  }
  if (!hasUsed) used = limit - remaining;

  const resetAt = parseResetTime(value.resetTime);
  const exactUsedPercent = (used / limit) * 100;
  const bucket = normalizeQuotaBucket({
    usedPercent: exactUsedPercent,
    windowMinutes,
    resetAt,
    capturedAt,
  });
  if (!bucket) schemaError("candidate-normalization-failed");
  return { bucket, exactUsedPercent };
}

function normalizeTimeUnit(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "MINUTE" || normalized === "TIME_UNIT_MINUTE") return "minute";
  if (normalized === "HOUR" || normalized === "TIME_UNIT_HOUR") return "hour";
  return null;
}

function recognizedWindowMinutes(value) {
  if (!isPlainObject(value) || !hasOwn(value, "duration") || !hasOwn(value, "timeUnit")) {
    return null;
  }
  let duration;
  try {
    duration = parseDecimal(value.duration, "window-duration");
  } catch (error) {
    if (error instanceof KimiQuotaSchemaError) return null;
    throw error;
  }
  if (!(duration > 0)) return null;
  const unit = normalizeTimeUnit(value.timeUnit);
  if (!unit) return null;
  const minutes = unit === "hour" ? duration * 60 : duration;
  return Math.abs(minutes - FIVE_HOUR_MINUTES) <= 1e-9 ? FIVE_HOUR_MINUTES : null;
}

function equivalentCandidate(left, right) {
  return left.bucket.resetAt === right.bucket.resetAt
    && Math.abs(left.exactUsedPercent - right.exactUsedPercent) <= 1e-9;
}

function normalizeKimiQuotaResponse(value, options = {}) {
  if (!isPlainObject(value)) schemaError("root-not-object");
  const capturedAt = Number.isFinite(options.capturedAt)
    ? Number(options.capturedAt)
    : Date.now();
  const out = {};

  if (hasOwn(value, "usage")) {
    out.kimiWeekly = parseCandidate(value.usage, capturedAt, WEEK_MINUTES).bucket;
  }

  if (hasOwn(value, "limits")) {
    if (!Array.isArray(value.limits)) schemaError("limits-not-array");
    let fiveHourCandidate = null;
    for (const item of value.limits) {
      if (!isPlainObject(item)) continue;
      const windowMinutes = recognizedWindowMinutes(item.window);
      if (windowMinutes !== FIVE_HOUR_MINUTES) continue;
      if (!hasOwn(item, "detail")) schemaError("five-hour-detail-missing");
      const candidate = parseCandidate(item.detail, capturedAt, FIVE_HOUR_MINUTES);
      if (fiveHourCandidate && !equivalentCandidate(fiveHourCandidate, candidate)) {
        schemaError("five-hour-duplicate-conflict");
      }
      fiveHourCandidate = candidate;
    }
    if (fiveHourCandidate) out.kimiFiveHour = fiveHourCandidate.bucket;
  }

  if (!Object.keys(out).length) schemaError("no-supported-buckets");
  return out;
}

module.exports = {
  CONSISTENCY_RELATIVE_TOLERANCE,
  FIVE_HOUR_MINUTES,
  KIMI_QUOTA_FIELDS,
  KimiQuotaSchemaError,
  WEEK_MINUTES,
  normalizeKimiQuotaResponse,
};
