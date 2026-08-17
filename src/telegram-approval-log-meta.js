"use strict";

const SAFE_OUTCOMES = new Set(["failed", "timeout", "native-start-failed"]);
const SAFE_PROXY_MODES = new Set(["system", "direct", "fixed_servers"]);
const SAFE_PROXY_TYPES = new Set([
  "DIRECT",
  "PROXY",
  "HTTPS",
  "SOCKS",
  "SOCKS4",
  "SOCKS5",
  "QUIC",
  "UNKNOWN",
]);

function allowlistedString(value, allowed) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return allowed.has(candidate) ? candidate : "";
}

function sanitizeProxyTypeSummary(value) {
  const candidate = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!candidate) return "";
  const parts = candidate.split("+").map((part) => part.trim());
  if (parts.some((part) => !part || !SAFE_PROXY_TYPES.has(part))) return "";
  return Array.from(new Set(parts)).join("+");
}

function sanitizeTelegramApprovalLogMeta(meta) {
  const source = meta && typeof meta === "object" ? meta : {};
  return {
    outcome: allowlistedString(source.outcome, SAFE_OUTCOMES),
    mode: allowlistedString(source.mode, SAFE_PROXY_MODES),
    proxy: sanitizeProxyTypeSummary(source.proxy),
  };
}

module.exports = {
  sanitizeTelegramApprovalLogMeta,
};
