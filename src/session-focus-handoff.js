"use strict";

function sanitizeFocusError(err) {
  return err && err.message ? err.message.replace(/[\r\n\t]+/g, " ") : "unknown";
}

function focusCodexThreadTarget({
  shell,
  focusEntry,
  sessionId,
  requestSource = "dashboard",
  url,
  focusLog = () => {},
  focusTerminalSession = () => false,
}) {
  if (!url || !shell || typeof shell.openExternal !== "function") return null;
  const id = String(sessionId || (focusEntry && focusEntry.id) || "");
  focusLog(`focus request source=${requestSource} sid=${id} agent=${(focusEntry && focusEntry.agentId) || "-"} target=codex-thread`);
  return Promise.resolve()
    .then(() => shell.openExternal(url))
    .then(() => {
      focusLog(`focus result branch=codex-thread reason=opened source=${requestSource} sid=${id}`);
    })
    .catch((err) => {
      focusLog(`focus result branch=codex-thread reason=open-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(err)}`);
      return Promise.resolve()
        .then(() => focusTerminalSession(focusEntry, id, requestSource))
        .then((focused) => {
          if (!focused) {
            focusLog(`focus result branch=none reason=codex-thread-fallback-no-source-pid source=${requestSource} sid=${id}`);
          }
        })
        .catch((fallbackErr) => {
          focusLog(`focus result branch=none reason=codex-thread-fallback-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(fallbackErr)}`);
        });
    });
}

module.exports = {
  focusCodexThreadTarget,
  sanitizeFocusError,
};
