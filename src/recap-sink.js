"use strict";

const { createCanonicalRecapEvent } = require("./recap-event");

const NOOP_RECAP_SINK = Object.freeze({
  record() { return false; },
});

function normalizeEphemeralIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const out = {};
  for (const key of ["scopeId", "sessionId", "dedupeId"]) {
    const raw = value[key];
    if (typeof raw === "string" && raw && raw.length <= 512 && !/[\0\r\n]/.test(raw)) out[key] = raw;
  }
  if (value.sessionStartPartial === true) out.sessionStartPartial = true;
  return Object.freeze(out);
}

function recordCanonicalRecapEvent(sink, input, ephemeralIdentity = null) {
  if (!sink || sink === NOOP_RECAP_SINK || typeof sink.record !== "function") return false;
  const event = createCanonicalRecapEvent(input);
  // dedupeId belongs to the whole canonical record, not to one metric inside
  // its metrics set. When no stable upstream id exists it stays absent and
  // at-most-once behavior depends on the already-accepted hook/fence path;
  // PR-2 must document that residual boundary rather than invent an ID.
  return sink.record(event, normalizeEphemeralIdentity(ephemeralIdentity)) !== false;
}

function createMemoryRecapSink(options = {}) {
  const events = [];
  const identities = options.captureEphemeralIdentity === true ? [] : null;
  return {
    record(event, identity) {
      events.push(createCanonicalRecapEvent(event));
      if (identities) identities.push(normalizeEphemeralIdentity(identity));
      return true;
    },
    snapshot() { return events.slice(); },
    identitySnapshot() { return identities ? identities.slice() : []; },
    clear() {
      events.length = 0;
      if (identities) identities.length = 0;
    },
  };
}

module.exports = {
  NOOP_RECAP_SINK,
  createMemoryRecapSink,
  recordCanonicalRecapEvent,
};
