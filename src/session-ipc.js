"use strict";

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerSessionIpc requires ${name}`);
  return value;
}

function registerSessionIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const getSessionSnapshot = requiredDependency(options.getSessionSnapshot, "getSessionSnapshot");
  const getI18n = requiredDependency(options.getI18n, "getI18n");
  const focusSession = requiredDependency(options.focusSession, "focusSession");
  const hideSession = requiredDependency(options.hideSession, "hideSession");
  const setSessionAlias = requiredDependency(options.setSessionAlias, "setSessionAlias");
  const showDashboard = requiredDependency(options.showDashboard, "showDashboard");
  const setSessionHudPinned = requiredDependency(options.setSessionHudPinned, "setSessionHudPinned");
  const ackSessionCompletion = requiredDependency(options.ackSessionCompletion, "ackSessionCompletion");
  const openSessionFolder = requiredDependency(options.openSessionFolder, "openSessionFolder");
  const setSessionAutomationOverride = requiredDependency(
    options.setSessionAutomationOverride,
    "setSessionAutomationOverride"
  );
  const clearSessionAutomationGrant = requiredDependency(
    options.clearSessionAutomationGrant,
    "clearSessionAutomationGrant"
  );
  const disposers = [];

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  handle("dashboard:get-snapshot", () => getSessionSnapshot());
  handle("dashboard:get-i18n", () => getI18n());
  on("dashboard:focus-session", (_event, sessionId) =>
    focusSession(sessionId, { requestSource: "dashboard" })
  );
  handle("dashboard:hide-session", (_event, sessionId) => hideSession(sessionId));
  handle("dashboard:open-session-folder", (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: "error", message: "dashboard:open-session-folder requires a sessionId string" };
    }
    return openSessionFolder(sessionId);
  });
  handle("dashboard:set-session-alias", (_event, payload) => setSessionAlias(payload));
  handle("dashboard:set-session-automation", (event, payload) => {
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 2
      || keys[0] !== "mode"
      || keys[1] !== "sessionId"
      || typeof payload.sessionId !== "string"
      || !payload.sessionId
      || (payload.mode !== "off" && payload.mode !== "auto-tools")
    ) {
      return { status: "invalid" };
    }
    return setSessionAutomationOverride(
      {
        sessionId: payload.sessionId,
        mode: payload.mode,
      },
      { sender: event && event.sender }
    );
  });
  handle("dashboard:clear-session-automation-grant", (_event, payload) => {
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload)
      : [];
    if (
      keys.length !== 1
      || keys[0] !== "grantId"
      || typeof payload.grantId !== "string"
      || !payload.grantId
    ) {
      return { status: "invalid" };
    }
    return clearSessionAutomationGrant({ grantId: payload.grantId });
  });

  handle("session-hud:get-i18n", () => getI18n());
  handle("session-hud:open-session-folder", (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: "error", message: "session-hud:open-session-folder requires a sessionId string" };
    }
    return openSessionFolder(sessionId);
  });
  on("session-hud:focus-session", (_event, sessionId) =>
    focusSession(sessionId, { requestSource: "hud" })
  );
  on("session-hud:open-dashboard", () => showDashboard({ source: "hud" }));
  on("session-hud:set-pinned", (_event, value) => setSessionHudPinned(!!value));

  on("settings:open-dashboard", () => showDashboard({ source: "settings" }));
  on("show-dashboard", () => showDashboard());

  // Both HUD and Dashboard call into this — invoke/handle (not send) so the
  // click handlers can re-enable the Mark-read button if the ack failed.
  handle("session:ack-completion", (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: "error", message: "session:ack-completion requires a sessionId string" };
    }
    try {
      const acked = ackSessionCompletion(sessionId);
      if (!acked) return { status: "noop", reason: "not-pending-or-missing" };
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: err && err.message };
    }
  });

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

module.exports = {
  registerSessionIpc,
};
