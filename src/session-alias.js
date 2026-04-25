"use strict";

const LOCAL_SESSION_HOST = "local";
const UNKNOWN_SESSION_AGENT = "unknown";
const MAX_SESSION_ALIAS_LENGTH = 80;
const SESSION_ALIAS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSessionHost(host) {
  if (typeof host !== "string") return LOCAL_SESSION_HOST;
  const trimmed = host.trim();
  if (!trimmed || trimmed.toLowerCase() === LOCAL_SESSION_HOST) {
    return LOCAL_SESSION_HOST;
  }
  return trimmed;
}

function normalizeSessionAgent(agentId) {
  if (typeof agentId !== "string") return UNKNOWN_SESSION_AGENT;
  const trimmed = agentId.trim();
  return trimmed || UNKNOWN_SESSION_AGENT;
}

function normalizeSessionId(sessionId) {
  if (sessionId === null || sessionId === undefined) return "";
  const normalized = String(sessionId).trim();
  return normalized;
}

function normalizeSessionScope(agentId, sessionId, options = {}) {
  const normalizedAgent = normalizeSessionAgent(agentId);
  const normalizedSessionId = normalizeSessionId(sessionId);
  const cwd = options && typeof options.cwd === "string" ? options.cwd.trim() : "";
  if (normalizedAgent === "kiro-cli" && normalizedSessionId === "default" && cwd) {
    return `cwd:${encodeURIComponent(cwd)}`;
  }
  return "";
}

function sessionAliasKey(host, agentId, sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) return null;
  const parts = [
    normalizeSessionHost(host),
    normalizeSessionAgent(agentId),
    normalizedSessionId,
  ];
  const scope = normalizeSessionScope(agentId, normalizedSessionId, options);
  if (scope) parts.push(scope);
  return parts.join("|");
}

function sanitizeSessionAlias(value) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > MAX_SESSION_ALIAS_LENGTH
    ? cleaned.slice(0, MAX_SESSION_ALIAS_LENGTH)
    : cleaned;
}

function normalizeTimestamp(value, fallbackNow) {
  if (value === undefined || value === null) {
    const now = Number(fallbackNow);
    return Number.isFinite(now) && now > 0 ? now : Date.now();
  }
  const updatedAt = Number(value);
  return Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null;
}

function normalizeSessionAliases(value, options = {}) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== "string" || !key.trim()) continue;
    if (!isPlainObject(entry)) continue;
    const title = sanitizeSessionAlias(entry.title);
    if (!title) continue;
    const updatedAt = normalizeTimestamp(entry.updatedAt, options.now);
    if (updatedAt === null) continue;
    out[key.trim()] = { title, updatedAt };
  }
  return out;
}

function normalizeActiveKeys(activeKeys) {
  if (!activeKeys) return new Set();
  if (activeKeys instanceof Set) return activeKeys;
  if (Array.isArray(activeKeys)) return new Set(activeKeys);
  if (typeof activeKeys[Symbol.iterator] === "function") return new Set(activeKeys);
  return new Set();
}

function pruneExpiredSessionAliases(value, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const activeKeys = normalizeActiveKeys(options.activeKeys);
  const aliases = normalizeSessionAliases(value, { now });
  const cutoff = now - SESSION_ALIAS_TTL_MS;
  const out = {};
  for (const [key, entry] of Object.entries(aliases)) {
    if (activeKeys.has(key) || entry.updatedAt >= cutoff) {
      out[key] = entry;
    }
  }
  return out;
}

module.exports = {
  LOCAL_SESSION_HOST,
  UNKNOWN_SESSION_AGENT,
  MAX_SESSION_ALIAS_LENGTH,
  SESSION_ALIAS_TTL_MS,
  normalizeSessionHost,
  normalizeSessionAgent,
  normalizeSessionScope,
  sessionAliasKey,
  sanitizeSessionAlias,
  normalizeSessionAliases,
  pruneExpiredSessionAliases,
};
