"use strict";

const CODEX_THREAD_SESSION_ID_RE = /^codex:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getCodexThreadId(entry) {
  if (!entry || entry.agentId !== "codex") return null;
  const originator = normalizeString(entry.codexOriginator || entry.originator).toLowerCase();
  if (originator !== "codex desktop") return null;
  const match = normalizeString(entry.id).match(CODEX_THREAD_SESSION_ID_RE);
  return match ? match[1] : null;
}

function getCodexThreadUrl(entry) {
  const threadId = getCodexThreadId(entry);
  return threadId ? `codex://threads/${threadId}` : null;
}

function getSessionFocusTarget(entry) {
  if (!entry || !entry.id) return { canFocus: false, type: null, url: null };
  if (entry.host || entry.platform === "webui") return { canFocus: false, type: null, url: null };

  const codexThreadUrl = getCodexThreadUrl(entry);
  if (codexThreadUrl) {
    return { canFocus: true, type: "codex-thread", url: codexThreadUrl };
  }

  if (entry.sourcePid) {
    return { canFocus: true, type: "terminal", url: null };
  }

  return { canFocus: false, type: null, url: null };
}

function isFocusableLocalHudSession(entry) {
  return !!entry
    && getSessionFocusTarget(entry).canFocus
    && !entry.headless
    && entry.state !== "sleeping"
    && !entry.hiddenFromHud
    && !entry.host;
}

function getFocusableLocalHudSessionIds(snapshot) {
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  return sessions
    .filter(isFocusableLocalHudSession)
    .map((entry) => entry.id);
}

module.exports = {
  getCodexThreadId,
  getCodexThreadUrl,
  getFocusableLocalHudSessionIds,
  getSessionFocusTarget,
  isFocusableLocalHudSession,
};
