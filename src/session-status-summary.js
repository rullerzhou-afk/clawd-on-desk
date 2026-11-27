"use strict";

(function exposeSessionStatusSummary(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ClawdSessionStatusSummary = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildSessionStatusSummary() {
  function isHudSession(session) {
    return !!session
      && typeof session === "object"
      && typeof session.id === "string"
      && session.id.length > 0
      && !session.headless
      && session.state !== "sleeping"
      && !session.hiddenFromHud
      && !session.hudHiddenByPreference;
  }

  function orderedHudSessions(snapshot) {
    const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
    const byId = new Map(sessions.map((session) => [session && session.id, session]));
    const ids = Array.isArray(snapshot && snapshot.orderedIds)
      ? snapshot.orderedIds
      : sessions.map((session) => session && session.id);
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    const included = new Set(ordered.map((session) => session.id));
    const missing = sessions.filter((session) => session && !included.has(session.id));
    return ordered.concat(missing).filter(isHudSession);
  }

  function statusForSession(session) {
    if (!session) return "idle";
    if (session.pendingAttention === true || session.badge === "interrupted") return "attention";
    const rawEvent = session.lastEvent && session.lastEvent.rawEvent;
    if (
      rawEvent === "PermissionRequest"
      || rawEvent === "Elicitation"
      || rawEvent === "Notification"
    ) {
      return "attention";
    }
    if (session.badge === "running") return "working";
    if (
      Number.isSafeInteger(session.activeSubagentCount)
      && session.activeSubagentCount > 0
    ) {
      return "working";
    }
    if (session.badge === "done") return "done";
    return "idle";
  }

  function summarizeSessions(snapshot) {
    const sessions = orderedHudSessions(snapshot);
    const counts = { attention: 0, working: 0, done: 0, idle: 0 };
    for (const session of sessions) counts[statusForSession(session)] += 1;
    return {
      total: sessions.length,
      counts,
      sessions,
    };
  }

  return {
    isHudSession,
    orderedHudSessions,
    statusForSession,
    summarizeSessions,
  };
});
