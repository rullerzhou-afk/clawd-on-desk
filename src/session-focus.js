"use strict";

const { isCodexDesktopOriginator } = require("../hooks/codex-originator");

const CODEX_THREAD_SESSION_ID_RE = /^codex:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOsPlatform(options) {
  if (!options || typeof options !== "object") return "";
  return normalizeString(options.osPlatform || options.focusHostPlatform).toLowerCase();
}

function getCodexThreadId(entry) {
  if (!entry || entry.agentId !== "codex") return null;
  if (!isCodexDesktopOriginator(entry.codexOriginator || entry.originator)) return null;
  const sessionId =
    normalizeString(entry.rawSessionId) || normalizeString(entry.id);
  const match = sessionId.match(CODEX_THREAD_SESSION_ID_RE);
  return match ? match[1] : null;
}

function getCodexThreadUrl(entry) {
  const threadId = getCodexThreadId(entry);
  return threadId ? `codex://threads/${threadId}` : null;
}

function hasSupportedOrcaPaneTarget(entry, options = {}) {
  const paneKey = normalizeString(entry && entry.orcaPaneKey);
  if (!paneKey || paneKey.length > 256) return false;
  if (!/^[\w-]+:[\w-]+$/.test(paneKey)) return false;
  const osPlatform = normalizeOsPlatform(options);
  return osPlatform === "darwin" || osPlatform === "win32";
}

function getSessionFocusTarget(entry, options = {}) {
  if (!entry || !entry.id) return { canFocus: false, type: null, url: null };
  if (entry.platform === "webui") return { canFocus: false, type: null, url: null };

  // Orca forwards its local pane identity into managed SSH PTYs. That key can
  // target the local Orca UI without treating the remote process PID as local.
  // Keep the exception narrow: supported host OS, strict pane-key shape, and
  // terminal focus only. Every other remote session remains unfocusable.
  const hasOrcaPaneTarget = hasSupportedOrcaPaneTarget(entry, options);
  if (entry.host && !hasOrcaPaneTarget) return { canFocus: false, type: null, url: null };
  if (hasOrcaPaneTarget) return { canFocus: true, type: "terminal", url: null };

  const codexThreadUrl = getCodexThreadUrl(entry);
  if (codexThreadUrl) {
    if (normalizeOsPlatform(options) === "win32") {
      return entry.sourcePid
        ? { canFocus: true, type: "terminal", url: null }
        : { canFocus: false, type: null, url: null };
    }
    return { canFocus: true, type: "codex-thread", url: codexThreadUrl };
  }

  if (entry.sourcePid) {
    return { canFocus: true, type: "terminal", url: null };
  }

  return { canFocus: false, type: null, url: null };
}

function isFocusableLocalHudSession(entry, options = {}) {
  return !!entry
    && getSessionFocusTarget(entry, options).canFocus
    && !entry.headless
    && entry.state !== "sleeping"
    && !entry.hiddenFromHud
    && !entry.host;
}

function getFocusableLocalHudSessionIds(snapshot, options = {}) {
  const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
  return sessions
    .filter((entry) => isFocusableLocalHudSession(entry, options))
    .map((entry) => entry.id);
}

module.exports = {
  getCodexThreadId,
  getCodexThreadUrl,
  getFocusableLocalHudSessionIds,
  getSessionFocusTarget,
  isFocusableLocalHudSession,
};
