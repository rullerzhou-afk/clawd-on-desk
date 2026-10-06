"use strict";

const { rotatedAppend } = require("./log-rotate");

const DEFAULT_SAMPLE_LIMIT = 200;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const SAFE_TEXT = /^[A-Za-z0-9_.:-]{1,80}$/;

function safeText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return SAFE_TEXT.test(text) ? text : null;
}

function safeCount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function safePid(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff ? value : null;
}

function safePidChain(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return null;
  const chain = value.map(safePid);
  return chain.every((pid) => pid !== null) ? chain : null;
}

function safeProcessMetadata(value) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    sourcePid: safePid(metadata.sourcePid),
    agentPid: safePid(metadata.agentPid),
    pidChain: safePidChain(metadata.pidChain),
    editor: safeText(metadata.editor),
  };
}

function sanitizeShadowRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const channel = safeText(record.channel);
  const agentId = safeText(record.agentId);
  const event = safeText(record.event);
  if (!channel || !agentId || !event) return null;
  const out = {
    at: new Date().toISOString(),
    channel,
    agentId,
    event,
    kind: safeText(record.kind) || "process-chain",
  };
  for (const key of [
    "status",
    "reason",
    "comparisonClass",
    "failureStage",
    "errorKind",
    "cacheSource",
    "rawEditor",
    "effectiveEditor",
  ]) {
    const value = safeText(record[key]);
    if (value) out[key] = value;
  }
  out.depth = safeCount(record.depth);
  out.durationMs = safeCount(record.durationMs);
  if (typeof record.agentSeenBeforeFailure === "boolean") {
    out.agentSeenBeforeFailure = record.agentSeenBeforeFailure;
  }
  if (record.legacyMetadata) out.legacyMetadata = safeProcessMetadata(record.legacyMetadata);
  if (record.candidateMetadata) out.candidateMetadata = safeProcessMetadata(record.candidateMetadata);
  if (record.comparison && typeof record.comparison === "object") {
    out.comparison = {};
    for (const key of ["sourcePid", "agentPid", "pidChain", "editor", "all"]) {
      if (typeof record.comparison[key] === "boolean") out.comparison[key] = record.comparison[key];
    }
  }
  for (const key of ["hookPresent", "serverPresent", "equal", "timingSensitive"]) {
    if (typeof record[key] === "boolean") out[key] = record[key];
  }
  return out;
}

function createWindowsProcessChainShadowLogger(options = {}) {
  const filePath = options.filePath;
  const append = typeof options.append === "function" ? options.append : rotatedAppend;
  const sampleLimit = Number.isInteger(options.sampleLimit) && options.sampleLimit > 0
    ? options.sampleLimit
    : DEFAULT_SAMPLE_LIMIT;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : DEFAULT_MAX_BYTES;
  const counts = new Map();

  return (record) => {
    if (!filePath) return false;
    const safe = sanitizeShadowRecord(record);
    if (!safe) return false;
    const key = `${safe.channel}|${safe.agentId}|${safe.event}|${safe.kind}`;
    const count = counts.get(key) || 0;
    if (count >= sampleLimit) return false;
    counts.set(key, count + 1);
    try {
      append(filePath, `${JSON.stringify(safe)}\n`, maxBytes);
      return true;
    } catch {
      return false;
    }
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_SAMPLE_LIMIT,
  createWindowsProcessChainShadowLogger,
  safeProcessMetadata,
  sanitizeShadowRecord,
};
