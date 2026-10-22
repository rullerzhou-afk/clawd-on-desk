"use strict";

// Only catalog values cross into CSS; model names and hook payloads never do.
(function (root) {
  const FAMILIES = Object.freeze(["opus", "sonnet", "haiku", "gpt"]);
  const EFFORTS = Object.freeze({ none: 0, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4, ultra: 4 });
  const ACTIVE_STATES = new Set(["thinking", "working", "juggling"]);

  function normalizeEffort(value) {
    return typeof value === "string" && Object.hasOwn(EFFORTS, value.toLowerCase())
      ? value.toLowerCase() : null;
  }

  function modelFamily(model) {
    if (typeof model !== "string") return null;
    return FAMILIES.find((family) =>
      new RegExp(`(?:^|[-_/])${family}(?:$|[-_/.0-9])`, "i").test(model)) || null;
  }

  function selectPowerUpSession(snapshot, displayedState, preferredId, sourceAgentId = "auto") {
    const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
    const active = sessions.filter((session) => session && !session.headless
      && !session.hiddenFromHud && ACTIVE_STATES.has(session.state)
      && (sourceAgentId === "auto" || session.agentId === sourceAgentId)
      && (!displayedState || session.state === displayedState));
    const preferred = active.find((session) => session.id === preferredId);
    if (preferred) return preferred;
    active.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
      || String(a.id).localeCompare(String(b.id)));
    return active[0] || null;
  }

  function resolvePowerUp(snapshot, enabled, displayedState, preferredId, sourceAgentId = "auto", auraEnabled = true) {
    const neutral = { family: null, tier: 0 };
    if (enabled !== true) return neutral;
    const session = selectPowerUpSession(snapshot, displayedState, preferredId, sourceAgentId);
    if (!session) return neutral;
    const effort = normalizeEffort(session.effort);
    return { family: modelFamily(session.model), tier: auraEnabled && effort !== null ? EFFORTS[effort] : 0 };
  }

  function appearance(payload) {
    const family = payload && FAMILIES.includes(payload.family) ? payload.family : null;
    const tier = payload && Number.isInteger(payload.tier) && payload.tier >= 0 && payload.tier <= 4 ? payload.tier : 0;
    return { family, tier, color: "", tint: "" };
  }

  const api = { normalizeEffort, modelFamily, selectPowerUpSession, resolvePowerUp, appearance };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ClawdPowerUp = api;
})(globalThis);
