"use strict";

function normalizeSessionsIterable(sessions) {
  if (!sessions) return [];
  if (sessions instanceof Map) return sessions.entries();
  if (typeof sessions[Symbol.iterator] === "function") return sessions;
  return [];
}

function normalizePositiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

const LOCAL_AGENT_PROCESS_DEDUPE_IDS = new Set(["codex", "workbuddy"]);

function getLocalAgentProcessKey(session) {
  if (
    !session
    || !LOCAL_AGENT_PROCESS_DEDUPE_IDS.has(session.agentId)
    || session.host
    || session.headless
  ) return null;
  const agentPid = normalizePositiveInteger(session.agentPid);
  if (agentPid) return `${session.agentId}:agent:${agentPid}`;
  if (session.agentId === "workbuddy") {
    const sourcePid = normalizePositiveInteger(session.sourcePid);
    if (sourcePid) return `${session.agentId}:source:${sourcePid}`;
  }
  return null;
}

function getLocalCodexProcessKey(session) {
  if (!session || session.agentId !== "codex") return null;
  return getLocalAgentProcessKey(session);
}

function sessionUpdatedAt(session) {
  const n = Number(session && session.updatedAt);
  return Number.isFinite(n) ? n : 0;
}

function buildLatestLocalAgentProcessIds(sessions) {
  const latestByKey = new Map();
  for (const [id, session] of normalizeSessionsIterable(sessions)) {
    const key = getLocalAgentProcessKey(session);
    if (!key) continue;
    const updatedAt = sessionUpdatedAt(session);
    const current = latestByKey.get(key);
    if (
      !current
      || updatedAt > current.updatedAt
      || (updatedAt === current.updatedAt && String(id) > String(current.id))
    ) {
      latestByKey.set(key, { id, updatedAt });
    }
  }
  return new Set(Array.from(latestByKey.values(), (entry) => entry.id));
}

function buildLatestLocalCodexProcessIds(sessions) {
  return buildLatestLocalAgentProcessIds(
    Array.from(normalizeSessionsIterable(sessions)).filter(([, session]) =>
      session && session.agentId === "codex"
    )
  );
}

function isSupersededLocalAgentProcessSession(id, session, latestIds) {
  if (!getLocalAgentProcessKey(session)) return false;
  return latestIds instanceof Set && !latestIds.has(id);
}

function isSupersededLocalCodexProcessSession(id, session, latestIds) {
  if (!getLocalCodexProcessKey(session)) return false;
  return isSupersededLocalAgentProcessSession(id, session, latestIds);
}

module.exports = {
  buildLatestLocalAgentProcessIds,
  buildLatestLocalCodexProcessIds,
  getLocalAgentProcessKey,
  getLocalCodexProcessKey,
  isSupersededLocalAgentProcessSession,
  isSupersededLocalCodexProcessSession,
};
