"use strict";

const https = require("node:https");

const KIMI_USAGE_ENDPOINT = "https://api.kimi.com/coding/v1/usages";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const MAX_API_KEY_LENGTH = 2048;
const MAX_RETRY_AFTER_SECONDS = 10 * 365 * 24 * 60 * 60;
const SAFE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRetryAfter(value, nowMs) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d{1,10}$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds > MAX_RETRY_AFTER_SECONDS) return null;
    return { kind: "delta-seconds", retryAt: nowMs + seconds * 1000 };
  }
  if (trimmed.length > 80) return null;
  const retryAt = Date.parse(trimmed);
  return Number.isFinite(retryAt) ? { kind: "http-date", retryAt } : null;
}

function parseJsonObject(buffer) {
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function hasAccessTerminatedCode(value) {
  if (!isPlainObject(value)) return false;
  return value.code === "access_terminated"
    || (isPlainObject(value.error) && value.error.code === "access_terminated");
}

function classifyHttpResponse(statusCode, headers, body, nowMs) {
  const retryAfter = parseRetryAfter(headers && headers["retry-after"], nowMs);
  if (statusCode >= 200 && statusCode < 300) {
    const value = parseJsonObject(body);
    return value
      ? { kind: "success", statusCode, value }
      : { kind: "malformed-response", statusCode };
  }
  if (statusCode === 400) return { kind: "incompatible-response", statusCode, terminal: true };
  if (statusCode === 401) return { kind: "usage-credential-rejected", statusCode, terminal: true };
  if (statusCode === 402) return { kind: "membership-unavailable", statusCode, retryAfter };
  if (statusCode === 403) {
    const value = parseJsonObject(body);
    return hasAccessTerminatedCode(value)
      ? { kind: "access-terminated", statusCode, terminal: true }
      : { kind: "forbidden", statusCode, retryAfter };
  }
  if (statusCode === 404) return { kind: "unsupported-or-moved", statusCode, terminal: true };
  if (statusCode === 429) return { kind: "rate-limited", statusCode, retryAfter };
  if (statusCode >= 500) return { kind: "server-error", statusCode, retryAfter };
  return { kind: "http-error", statusCode, retryAfter };
}

function createKimiQuotaClient(options = {}) {
  const request = options.request || https.request;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Number(options.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = Number.isFinite(options.maxBodyBytes)
    ? Math.max(1, Number(options.maxBodyBytes))
    : DEFAULT_MAX_BODY_BYTES;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const requestedVersion = typeof options.appVersion === "string" ? options.appVersion.trim() : "";
  const appVersion = /^[0-9A-Za-z._+-]{1,64}$/.test(requestedVersion)
    ? requestedVersion
    : "unknown";
  const userAgent = `Clawd/${appVersion} KimiQuota/experimental`;

  function fetchUsage(apiKey, fetchOptions = {}) {
    if (typeof apiKey !== "string"
        || !apiKey
        || apiKey.length > MAX_API_KEY_LENGTH
        || apiKey.trim() !== apiKey
        || /[\r\n\0]/.test(apiKey)) {
      return Promise.resolve({ kind: "invalid-credential-input", terminal: true });
    }
    const signal = fetchOptions.signal;
    if (signal && signal.aborted) return Promise.resolve({ kind: "aborted" });

    return new Promise((resolve) => {
      let settled = false;
      let terminationKind = null;
      let req = null;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", abortRequest);
        }
        resolve(result);
      };
      const abortRequest = () => {
        terminationKind = "aborted";
        if (req) req.destroy();
        settle({ kind: "aborted" });
      };

      try {
        req = request(KIMI_USAGE_ENDPOINT, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
            "User-Agent": userAgent,
          },
          agent: false,
        }, (res) => {
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            if (settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > maxBodyBytes) {
              terminationKind = "response-too-large";
              settle({ kind: "response-too-large", statusCode: Number(res.statusCode) || 0 });
              req.destroy();
              return;
            }
            chunks.push(buffer);
          });
          res.on("end", () => {
            if (settled) return;
            const statusCode = Number(res.statusCode) || 0;
            settle(classifyHttpResponse(
              statusCode,
              res.headers || {},
              Buffer.concat(chunks),
              now(),
            ));
          });
          res.on("error", () => {
            settle({ kind: terminationKind || "network-error", code: "RESPONSE_ERROR" });
          });
        });
        req.setTimeout(timeoutMs, () => {
          terminationKind = "timeout";
          req.destroy();
          settle({ kind: "timeout" });
        });
        req.on("error", (error) => {
          if (settled) return;
          const code = error && SAFE_NETWORK_CODES.has(error.code) ? error.code : "NETWORK_ERROR";
          settle({ kind: terminationKind || "network-error", code });
        });
        if (signal && typeof signal.addEventListener === "function") {
          signal.addEventListener("abort", abortRequest, { once: true });
        }
        req.end();
      } catch {
        settle({ kind: "network-error", code: "NETWORK_ERROR" });
      }
    });
  }

  return { fetchUsage, userAgent };
}

module.exports = {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_TIMEOUT_MS,
  KIMI_USAGE_ENDPOINT,
  MAX_API_KEY_LENGTH,
  classifyHttpResponse,
  createKimiQuotaClient,
  parseRetryAfter,
};
