"use strict";

const { isCodexDesktopOriginator } = require("../hooks/codex-originator");

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

function getLocalCodexProcessKey(session) {
  if (!session || session.agentId !== "codex" || session.host || session.headless) return null;
  // Codex Desktop multiplexes independent threads through one process, so its
  // stable session IDs must remain distinct in the HUD (#581).
  if (isCodexDesktopOriginator(session.codexOriginator)) return null;
  const agentPid = normalizePositiveInteger(session.agentPid);
  return agentPid ? `codex-agent:${agentPid}` : null;
}

function sessionUpdatedAt(session) {
  const n = Number(session && session.updatedAt);
  return Number.isFinite(n) ? n : 0;
}

function buildLatestLocalCodexProcessIds(sessions) {
  const latestByKey = new Map();
  for (const [id, session] of normalizeSessionsIterable(sessions)) {
    const key = getLocalCodexProcessKey(session);
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

function isSupersededLocalCodexProcessSession(id, session, latestIds) {
  if (!getLocalCodexProcessKey(session)) return false;
  return latestIds instanceof Set && !latestIds.has(id);
}

module.exports = {
  buildLatestLocalCodexProcessIds,
  getLocalCodexProcessKey,
  isSupersededLocalCodexProcessSession,
};
