"use strict";

const { MAX_REJECTED_AGENT_ID_LENGTH } = require("./server-agent-id");

const HOOK_EVENT_RING_SIZE_PER_AGENT = 50;
const REJECTED_CUSTOM_AGENT_ID = "rejected-custom";
const HOOK_EVENT_OUTCOMES = new Set([
  "accepted",
  "dropped-by-disabled",
  "dropped-by-dnd",
  "dropped-invalid-agent",
  "dropped-unsupported",
]);
const HOOK_EVENT_ROUTES = new Set(["state", "permission"]);

function normalizeHookEventIdentity(identity) {
  if (identity && identity.rejected === true) {
    return {
      agentId: REJECTED_CUSTOM_AGENT_ID,
      rawAgentId: typeof identity.rawAgentId === "string"
        ? identity.rawAgentId.slice(0, MAX_REJECTED_AGENT_ID_LENGTH)
        : undefined,
    };
  }
  if (!identity || typeof identity.agentId !== "string" || !identity.agentId) return null;
  return { agentId: identity.agentId };
}

function normalizeHookEventType(data, route) {
  if (route === "permission") return "PermissionRequest";
  return data && typeof data.event === "string" && data.event
    ? data.event
    : null;
}

function recordHookEventInBuffer(buffer, identity, data, route, outcome, options = {}) {
  try {
    if (!buffer || !HOOK_EVENT_ROUTES.has(route) || !HOOK_EVENT_OUTCOMES.has(outcome)) return null;
    const normalizedIdentity = normalizeHookEventIdentity(identity);
    if (!normalizedIdentity) return null;
    const { agentId, rawAgentId } = normalizedIdentity;
    const timestamp = typeof options.now === "function" ? options.now() : Date.now();
    const event = {
      timestamp,
      agentId,
      eventType: normalizeHookEventType(data, route),
      route,
      outcome,
      ...(rawAgentId ? { rawAgentId } : {}),
    };
    const ringSize = Number.isInteger(options.ringSize) && options.ringSize > 0
      ? options.ringSize
      : HOOK_EVENT_RING_SIZE_PER_AGENT;
    const list = buffer.get(agentId) || [];
    list.push(event);
    while (list.length > ringSize) list.shift();
    buffer.set(agentId, list);
    return event;
  } catch {
    return null;
  }
}

function getRecentHookEventsFromBuffer(buffer, options = {}) {
  if (!buffer) return [];
  const since = Number.isFinite(options.since) ? options.since : null;
  const agentId = typeof options.agentId === "string" && options.agentId ? options.agentId : null;
  const source = agentId ? [buffer.get(agentId) || []] : [...buffer.values()];
  return source
    .flatMap((events) => Array.isArray(events) ? events : [])
    .filter((event) => !since || event.timestamp >= since)
    .map((event) => ({ ...event }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

function createSingleRequestHookEventRecorder(recordFn, identity, data, defaultRoute) {
  let recorded = false;
  function record(route, outcome) {
    const routeToUse = route || defaultRoute;
    if (
      recorded
      || typeof recordFn !== "function"
      || !HOOK_EVENT_ROUTES.has(routeToUse)
      || !HOOK_EVENT_OUTCOMES.has(outcome)
    ) {
      // Invalid route/outcome values stay no-op without consuming the single-flight slot.
      return null;
    }
    recorded = true;
    return recordFn(identity, data, routeToUse, outcome);
  }
  return {
    record,
    accepted: (route) => record(route, "accepted"),
    droppedByDisabled: (route) => record(route, "dropped-by-disabled"),
    droppedByDnd: (route) => record(route, "dropped-by-dnd"),
    droppedInvalidAgent: (route) => record(route, "dropped-invalid-agent"),
    droppedUnsupported: (route) => record(route, "dropped-unsupported"),
    acceptedUnlessDnd: (dropForDnd, route) => (
      dropForDnd ? record(route, "dropped-by-dnd") : record(route, "accepted")
    ),
  };
}

module.exports = {
  HOOK_EVENT_RING_SIZE_PER_AGENT,
  REJECTED_CUSTOM_AGENT_ID,
  createSingleRequestHookEventRecorder,
  recordHookEventInBuffer,
  getRecentHookEventsFromBuffer,
};
