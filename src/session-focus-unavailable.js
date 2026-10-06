"use strict";

(function exposeSessionFocusUnavailable(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ClawdSessionFocusUnavailable = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function buildSessionFocusUnavailable() {
  function focusUnavailableReasonKey(session) {
    if (session && session.platform === "webui") return "sessionFocusUnavailableWebui";
    if (session && (
      (session.sourceType && session.sourceType !== "local")
      || (session.host && session.host !== "local")
    )) {
      return "sessionFocusUnavailableRemote";
    }
    return "sessionFocusUnavailableMissingTerminalInfo";
  }

  function canOfferLocalFolder(session) {
    return !!session
      && session.sourceType === "local"
      && (!session.host || session.host === "local")
      && session.platform !== "webui"
      && typeof session.cwd === "string"
      && session.cwd.length > 0;
  }

  return { canOfferLocalFolder, focusUnavailableReasonKey };
});
