"use strict";

// Production plugins use a 64-character hex token. Keep the wire validator
// format-compatible with older/future URL-safe opaque tokens while rejecting
// control characters, header delimiters, and unbounded input.
const BRIDGE_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

function normalizeOpencodeFamilyBridgeUrl(value) {
  if (typeof value !== "string" || value.length > 256) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !parsed.port
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    return null;
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://127.0.0.1:${port}`;
}

function isValidOpencodeFamilyBridgeToken(value) {
  return typeof value === "string" && BRIDGE_TOKEN_RE.test(value);
}

module.exports = {
  normalizeOpencodeFamilyBridgeUrl,
  isValidOpencodeFamilyBridgeToken,
};
