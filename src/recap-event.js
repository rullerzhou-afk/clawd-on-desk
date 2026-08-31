"use strict";

const METRIC_ORDER = Object.freeze([
  "activity",
  "session-start",
  "turn-complete",
  "tool-call",
]);
const METRICS = new Set(METRIC_ORDER);
const SCOPES = new Set(["local", "wsl", "remote"]);
const MAX_CANONICAL_EVENT_BYTES = 512;

function normalizeMetrics(value) {
  if (!Array.isArray(value)) throw new TypeError("recap metrics must be an array");
  const seen = new Set();
  for (const metric of value) {
    if (!METRICS.has(metric)) throw new TypeError(`unsupported recap metric: ${metric}`);
    seen.add(metric);
  }
  if (!seen.has("activity")) throw new TypeError("recap event must include activity");
  return METRIC_ORDER.filter((metric) => seen.has(metric));
}

function createCanonicalRecapEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("recap event must be an object");
  }
  const occurredAt = input.occurredAt;
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
    throw new TypeError("recap occurredAt must be a non-negative epoch millisecond");
  }
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
  if (!agentId || agentId.length > 80 || /[\0\r\n]/.test(agentId)) {
    throw new TypeError("recap agentId is invalid");
  }
  const scope = SCOPES.has(input.scope) ? input.scope : null;
  if (!scope) throw new TypeError("recap scope is invalid");

  // Deliberately copy only the public allowlist. Raw event names, session ids,
  // paths, prompts, titles and tool names must stay in the ephemeral identity
  // side-channel consumed by the future local ledger.
  const event = Object.freeze({
    occurredAt,
    agentId,
    scope,
    metrics: Object.freeze(normalizeMetrics(input.metrics)),
  });
  if (Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_CANONICAL_EVENT_BYTES) {
    throw new TypeError("recap event exceeds size limit");
  }
  return event;
}

module.exports = {
  MAX_CANONICAL_EVENT_BYTES,
  METRIC_ORDER,
  createCanonicalRecapEvent,
};
