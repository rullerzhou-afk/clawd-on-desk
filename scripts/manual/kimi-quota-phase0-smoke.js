#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const packageJson = require("../../package.json");

const ENDPOINT = "https://api.kimi.com/coding/v1/usages";
const USER_AGENT = `Clawd/${packageJson.version} KimiQuota/phase0-manual`;
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const SAFE_ERROR_CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_TIME_UNITS = new Set([
  "MINUTE",
  "HOUR",
  "TIME_UNIT_MINUTE",
  "TIME_UNIT_HOUR",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sanitizeDecimal(value) {
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { type: "number", value }
      : { type: "number", validDecimal: false };
  }
  if (typeof value === "string") {
    return value.length <= 64 && DECIMAL_RE.test(value)
      ? { type: "string", value }
      : { type: "string", validDecimal: false, length: value.length };
  }
  return { type: valueType(value), validDecimal: false };
}

function sanitizeResetTime(value) {
  if (typeof value !== "string") {
    return { type: valueType(value), validTimestamp: false };
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs) || value.length > 80) {
    return { type: "string", validTimestamp: false, length: value.length };
  }
  return { type: "string", value, epochMs };
}

function sanitizeQuotaCandidate(value) {
  if (!isPlainObject(value)) return { type: valueType(value) };

  const result = {
    type: "object",
    fields: {},
    unknownFieldCount: 0,
  };
  const knownFields = new Set(["used", "remaining", "limit", "resetTime"]);
  for (const field of ["used", "remaining", "limit"]) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      result.fields[field] = sanitizeDecimal(value[field]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "resetTime")) {
    result.fields.resetTime = sanitizeResetTime(value.resetTime);
  }
  result.unknownFieldCount = Object.keys(value)
    .filter((field) => !knownFields.has(field)).length;
  return result;
}

function sanitizeWindow(value) {
  if (!isPlainObject(value)) return { type: valueType(value) };
  const result = {
    type: "object",
    unknownFieldCount: Object.keys(value)
      .filter((field) => field !== "duration" && field !== "timeUnit").length,
  };
  if (Object.prototype.hasOwnProperty.call(value, "duration")) {
    result.duration = sanitizeDecimal(value.duration);
  }
  if (Object.prototype.hasOwnProperty.call(value, "timeUnit")) {
    const timeUnit = value.timeUnit;
    result.timeUnit = typeof timeUnit === "string" && SAFE_TIME_UNITS.has(timeUnit)
      ? { type: "string", value: timeUnit }
      : { type: valueType(timeUnit), recognized: false };
  }
  return result;
}

function sanitizeLimitItem(value) {
  if (!isPlainObject(value)) return { type: valueType(value) };
  const knownFields = new Set(["window", "detail"]);
  const result = {
    type: "object",
    unknownFieldCount: Object.keys(value)
      .filter((field) => !knownFields.has(field)).length,
  };
  if (Object.prototype.hasOwnProperty.call(value, "window")) {
    result.window = sanitizeWindow(value.window);
  }
  if (Object.prototype.hasOwnProperty.call(value, "detail")) {
    result.detail = sanitizeQuotaCandidate(value.detail);
  }
  return result;
}

function sanitizeSuccessBody(value) {
  if (!isPlainObject(value)) return { rootType: valueType(value) };
  const knownFields = new Set(["usage", "limits", "boosterWallet", "totalQuota"]);
  const result = {
    rootType: "object",
    unknownTopLevelFieldCount: Object.keys(value)
      .filter((field) => !knownFields.has(field)).length,
  };

  if (Object.prototype.hasOwnProperty.call(value, "usage")) {
    result.usage = sanitizeQuotaCandidate(value.usage);
  }
  if (Object.prototype.hasOwnProperty.call(value, "limits")) {
    result.limits = Array.isArray(value.limits)
      ? {
          type: "array",
          length: value.limits.length,
          items: value.limits.slice(0, 16).map(sanitizeLimitItem),
          truncated: value.limits.length > 16,
        }
      : { type: valueType(value.limits) };
  }
  if (Object.prototype.hasOwnProperty.call(value, "boosterWallet")) {
    result.boosterWallet = { present: true, type: valueType(value.boosterWallet) };
  }
  if (Object.prototype.hasOwnProperty.call(value, "totalQuota")) {
    result.totalQuota = { present: true, type: valueType(value.totalQuota) };
  }
  return result;
}

function sanitizeErrorBody(value, forbiddenValues = []) {
  if (!isPlainObject(value)) return null;
  const candidates = [
    value.code,
    isPlainObject(value.error) ? value.error.code : undefined,
  ];
  const code = candidates.find((candidate) => (
    typeof candidate === "string"
      && SAFE_ERROR_CODE_RE.test(candidate)
      && !forbiddenValues.some((forbidden) => (
        typeof forbidden === "string" && forbidden && candidate.includes(forbidden)
      ))
  ));
  return code ? { code } : null;
}

function sanitizeRetryAfter(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d{1,10}$/.test(trimmed)) return { present: true, value: trimmed, kind: "delta-seconds" };
  const epochMs = Date.parse(trimmed);
  if (trimmed.length <= 80 && Number.isFinite(epochMs)) {
    return { present: true, value: trimmed, kind: "http-date", epochMs };
  }
  return { present: true, valid: false, length: value.length };
}

function sanitizeContentType(value) {
  if (typeof value !== "string") return null;
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return ["application/json", "application/problem+json", "text/plain"].includes(mediaType)
    ? mediaType
    : "other";
}

function parseJson(body) {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

function classifyNetworkError(error) {
  const safeCodes = new Set([
    "ABORT_ERR",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
    "ERR_BODY_TOO_LARGE",
    "ERR_INVALID_PROTOCOL",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
  ]);
  return error && safeCodes.has(error.code) ? error.code : "NETWORK_ERROR";
}

function requestUsage({
  apiKey,
  request = https.request,
  endpoint = ENDPOINT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBodyBytes = MAX_BODY_BYTES,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey) {
    return Promise.reject(Object.assign(new Error("missing credential"), { code: "MISSING_CREDENTIAL" }));
  }
  if (endpoint !== ENDPOINT) {
    return Promise.reject(Object.assign(new Error("endpoint override rejected"), { code: "FIXED_ENDPOINT_REQUIRED" }));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = request(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
      },
      agent: false,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBodyBytes) {
          const error = Object.assign(new Error("response body too large"), {
            code: "ERR_BODY_TOO_LARGE",
          });
          finishReject(error);
          req.destroy(error);
          return;
        }
        chunks.push(buffer);
      });
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const parsed = parseJson(body);
        const statusCode = Number(res.statusCode) || 0;
        const retryAfter = sanitizeRetryAfter(res.headers["retry-after"]);
        const contentType = sanitizeContentType(res.headers["content-type"]);
        finishResolve({
          statusCode,
          bodyByteLength: size,
          contentType,
          retryAfter,
          parsed,
        });
      });
      res.on("error", finishReject);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }));
    });
    req.on("error", finishReject);
    req.end();
  });
}

function sanitizeResponse(response, forbiddenValues = []) {
  const sample = {
    capturedAt: new Date().toISOString(),
    statusCode: response.statusCode,
    bodyByteLength: response.bodyByteLength,
    contentType: response.contentType,
    retryAfter: response.retryAfter,
    jsonParsed: response.parsed.ok,
  };
  if (!response.parsed.ok) return sample;
  if (response.statusCode >= 200 && response.statusCode < 300) {
    sample.schema = sanitizeSuccessBody(response.parsed.value);
  } else {
    sample.error = sanitizeErrorBody(response.parsed.value, forbiddenValues);
  }
  return sample;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSmoke({ apiKey, samples, intervalMs, request, sleepFn = sleep } = {}) {
  const report = {
    version: 1,
    purpose: "kimi-code-quota-phase0-manual-smoke",
    endpoint: ENDPOINT,
    method: "GET",
    userAgent: USER_AGENT,
    startedAt: new Date().toISOString(),
    sampleCountRequested: samples,
    intervalMs,
    quietWindowConfirmedByOperator: true,
    samples: [],
  };

  for (let index = 0; index < samples; index += 1) {
    if (index > 0) await sleepFn(intervalMs);
    try {
      const response = await requestUsage({ apiKey, request });
      report.samples.push(sanitizeResponse(response, [apiKey]));
    } catch (error) {
      report.samples.push({
        capturedAt: new Date().toISOString(),
        networkError: classifyNetworkError(error),
      });
    }
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

function parseArgs(argv) {
  const options = {
    keyStdin: false,
    quietWindowConfirmed: false,
    samples: 3,
    intervalSeconds: 60,
    outputPath: "",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--key-stdin") options.keyStdin = true;
    else if (arg === "--quiet-window-confirmed") options.quietWindowConfirmed = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--samples") options.samples = Number(argv[++index]);
    else if (arg === "--interval-seconds") options.intervalSeconds = Number(argv[++index]);
    else if (arg === "--output") options.outputPath = String(argv[++index] || "");
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 3) {
    throw new Error("--samples must be an integer from 1 to 3");
  }
  if (!Number.isInteger(options.intervalSeconds)
      || options.intervalSeconds < 5
      || options.intervalSeconds > 600) {
    throw new Error("--interval-seconds must be an integer from 5 to 600");
  }
  return options;
}

function readKeyFromStdin(input = process.stdin) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    input.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 4096) {
        reject(new Error("credential input is too long"));
        input.destroy();
        return;
      }
      chunks.push(buffer);
    });
    input.on("error", reject);
    input.on("end", () => {
      const key = Buffer.concat(chunks).toString("utf8").trim();
      if (!key || key.length > 2048 || /[\r\n\0]/.test(key)) {
        reject(new Error("credential input is invalid"));
        return;
      }
      resolve(key);
    });
  });
}

function usage() {
  return [
    "Run through the PowerShell wrapper so the key is entered with hidden input:",
    "  pwsh -NoProfile -File scripts/manual/kimi-quota-phase0-smoke.ps1 -QuietWindowConfirmed",
    "",
    "The Node helper accepts the credential only on stdin. It never accepts a key argument,",
    "endpoint override, or environment variable.",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!options.keyStdin || !options.quietWindowConfirmed) {
    process.stderr.write(`Both --key-stdin and --quiet-window-confirmed are required.\n${usage()}\n`);
    return 2;
  }

  let apiKey;
  try {
    apiKey = await readKeyFromStdin();
    const report = await runSmoke({
      apiKey,
      samples: options.samples,
      intervalMs: options.intervalSeconds * 1000,
    });
    const outputPath = path.resolve(options.outputPath || path.join(
      os.tmpdir(),
      `clawd-kimi-quota-phase0-${Date.now()}.json`,
    ));
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Sanitized evidence: ${outputPath}\n`);
    return report.samples.some((sample) => sample.statusCode >= 200 && sample.statusCode < 300)
      ? 0
      : 1;
  } catch (error) {
    process.stderr.write(`Smoke failed: ${classifyNetworkError(error)}\n`);
    return 1;
  } finally {
    apiKey = null;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  ENDPOINT,
  MAX_BODY_BYTES,
  USER_AGENT,
  classifyNetworkError,
  parseArgs,
  requestUsage,
  runSmoke,
  sanitizeErrorBody,
  sanitizeQuotaCandidate,
  sanitizeResponse,
  sanitizeSuccessBody,
};
