"use strict";
const { getSessionFocusTarget } = require("./session-focus");

function createSessionResultFocus({ getSession, openExternal, focusTerminalSession,
  platform = process.platform, processKill = process.kill }) {
  function resolve(card) {
    const session = getSession(card.sessionId);
    const entry = session && session.agentId === card.agentId
      ? { ...session, id: card.sessionId } : card.desktopIdentity;
    if (!entry || entry.host || entry.wslDistro || entry.headless
      || (entry.profileId && entry.profileId !== "local")) return null;
    const target = getSessionFocusTarget(entry, { osPlatform: platform });
    if (target.type === "codex-thread") return { target, entry };
    if (target.type !== "terminal" || !session || !Number.isSafeInteger(session.sourcePid)
      || session.sourcePid <= 0 || session.pidReachable === false) return null;
    try { processKill(session.sourcePid, 0); } catch { return null; }
    return { target, entry };
  }
  async function open(card) {
    const resolved = resolve(card);
    if (!resolved) return "unavailable";
    try {
      if (resolved.target.type === "codex-thread") {
        await openExternal(resolved.target.url);
        return "opened";
      }
      const result = await focusTerminalSession(resolved.entry, card.sessionId, "session-result");
      if (!result) return "failed";
      return platform === "win32" && result && result.confirmed === true ? "opened" : "unconfirmed";
    } catch { return "failed"; }
  }
  return { canOpen: card => !!resolve(card), open };
}
module.exports = { createSessionResultFocus };
