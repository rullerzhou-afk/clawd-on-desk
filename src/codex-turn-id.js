"use strict";

const crypto = require("node:crypto");

const MAX_CODEX_TURN_ID_LENGTH = 256;

function normalizeCodexTurnId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_CODEX_TURN_ID_LENGTH) return null;
  return normalized;
}

function digestCodexTurnId(value) {
  const normalized = normalizeCodexTurnId(value);
  if (!normalized) return null;
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}

module.exports = {
  MAX_CODEX_TURN_ID_LENGTH,
  normalizeCodexTurnId,
  digestCodexTurnId,
};
