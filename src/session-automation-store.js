"use strict";

const crypto = require("crypto");
const { normalizeTitle } = require("./state-session-snapshot");

const VALID_MODES = new Set(["off", "auto-tools"]);
const DEFAULT_MAX_RECORDS = 64;

function freezeRecord(record) {
  return record ? Object.freeze({ ...record }) : null;
}

function normalizeIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  const agentId = typeof identity.agentId === "string" ? identity.agentId.trim() : "";
  const sessionId = typeof identity.sessionId === "string" ? identity.sessionId.trim() : "";
  if (!agentId || !sessionId) return null;
  return { agentId, sessionId };
}

function sanitizeDisplayLabel(value) {
  return normalizeTitle(value) || "";
}

function createSessionAutomationStore(options = {}) {
  const recordsByAgent = new Map();
  const onChange = typeof options.onChange === "function" ? options.onChange : null;
  const maxRecords = Number.isInteger(options.maxRecords) && options.maxRecords > 0
    ? options.maxRecords
    : DEFAULT_MAX_RECORDS;
  const makeGrantId = typeof options.makeGrantId === "function"
    ? options.makeGrantId
    : () => crypto.randomUUID();
  let recordCount = 0;

  function lookup(identity) {
    const normalized = normalizeIdentity(identity);
    if (!normalized) return { normalized: null, record: null };
    const bySession = recordsByAgent.get(normalized.agentId);
    return {
      normalized,
      record: bySession ? (bySession.get(normalized.sessionId) || null) : null,
    };
  }

  function publish(changes) {
    if (!onChange || !changes.length) return;
    const frozen = Object.freeze(changes.map((change) => Object.freeze({
      previous: freezeRecord(change.previous),
      next: freezeRecord(change.next),
      reason: change.reason,
    })));
    onChange(frozen);
  }

  function setRecord(record) {
    let bySession = recordsByAgent.get(record.agentId);
    if (!bySession) {
      bySession = new Map();
      recordsByAgent.set(record.agentId, bySession);
    }
    const existed = bySession.has(record.sessionId);
    bySession.set(record.sessionId, record);
    if (!existed) recordCount += 1;
  }

  function deleteRecord(record) {
    const bySession = recordsByAgent.get(record.agentId);
    if (!bySession || !bySession.delete(record.sessionId)) return false;
    recordCount -= 1;
    if (bySession.size === 0) recordsByAgent.delete(record.agentId);
    return true;
  }

  function get(identity) {
    return freezeRecord(lookup(identity).record);
  }

  function list() {
    const records = [];
    for (const bySession of recordsByAgent.values()) {
      for (const record of bySession.values()) records.push(freezeRecord(record));
    }
    return Object.freeze(records);
  }

  function compareAndSet(identity, mode, cas = {}) {
    const { normalized, record: previous } = lookup(identity);
    const expectedGrantId = cas.expectedGrantId == null ? null : cas.expectedGrantId;
    const nextGrantId = typeof cas.nextGrantId === "string" ? cas.nextGrantId.trim() : "";
    if (
      !normalized
      || !VALID_MODES.has(mode)
      || (expectedGrantId !== null && typeof expectedGrantId !== "string")
      || !nextGrantId
    ) {
      return Object.freeze({ status: "invalid", record: freezeRecord(previous) });
    }
    if (previous && previous.mode === mode) {
      return Object.freeze({ status: "equivalent", record: freezeRecord(previous) });
    }
    const currentGrantId = previous ? previous.grantId : null;
    if (currentGrantId !== expectedGrantId) {
      return Object.freeze({ status: "stale", record: freezeRecord(previous) });
    }
    if (!previous && recordCount >= maxRecords) {
      return Object.freeze({ status: "full", record: null });
    }
    const next = {
      agentId: normalized.agentId,
      sessionId: normalized.sessionId,
      mode,
      grantId: nextGrantId,
      displayLabel: sanitizeDisplayLabel(cas.displayLabel),
      createdAt: Number.isFinite(cas.createdAt) ? cas.createdAt : Date.now(),
    };
    setRecord(next);
    publish([{ previous, next, reason: "compare-and-set" }]);
    return Object.freeze({ status: "applied", record: freezeRecord(next) });
  }

  function findByGrantId(grantId) {
    if (typeof grantId !== "string" || !grantId) return null;
    for (const bySession of recordsByAgent.values()) {
      for (const record of bySession.values()) {
        if (record.grantId === grantId) return record;
      }
    }
    return null;
  }

  function transitionGrant(grantId, target) {
    const previous = findByGrantId(grantId);
    if (!previous || (target !== "clear" && target !== "remote-revoke")) {
      return Object.freeze({ status: previous ? "invalid" : "stale", record: freezeRecord(previous) });
    }
    if (target === "clear") {
      deleteRecord(previous);
      publish([{ previous, next: null, reason: "clear" }]);
      return Object.freeze({ status: "applied", record: null });
    }
    if (previous.mode !== "auto-tools") {
      return Object.freeze({ status: "stale", record: freezeRecord(previous) });
    }
    const nextGrantId = String(makeGrantId() || "").trim();
    if (!nextGrantId) {
      return Object.freeze({ status: "invalid", record: freezeRecord(previous) });
    }
    const next = {
      ...previous,
      mode: "off",
      grantId: nextGrantId,
      createdAt: Date.now(),
    };
    setRecord(next);
    publish([{ previous, next, reason: "remote-revoke" }]);
    return Object.freeze({ status: "applied", record: freezeRecord(next) });
  }

  function clearIdentity(identity) {
    const { record: previous } = lookup(identity);
    if (!previous) return Object.freeze({ status: "stale", record: null });
    deleteRecord(previous);
    publish([{ previous, next: null, reason: "clear-identity" }]);
    return Object.freeze({ status: "applied", record: null });
  }

  function clearAgent(agentId) {
    const normalizedAgentId = typeof agentId === "string" ? agentId.trim() : "";
    const bySession = normalizedAgentId ? recordsByAgent.get(normalizedAgentId) : null;
    if (!bySession) return Object.freeze([]);
    const changes = [];
    for (const previous of bySession.values()) {
      changes.push({ previous, next: null, reason: "clear-agent" });
    }
    recordsByAgent.delete(normalizedAgentId);
    recordCount -= changes.length;
    publish(changes);
    return Object.freeze(changes.map((change) => freezeRecord(change.previous)));
  }

  return Object.freeze({
    get,
    list,
    compareAndSet,
    transitionGrant,
    clearIdentity,
    clearAgent,
  });
}

module.exports = {
  createSessionAutomationStore,
  sanitizeDisplayLabel,
};
