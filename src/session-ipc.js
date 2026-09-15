"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DASHBOARD_PAGE_URL = pathToFileURL(path.join(__dirname, "dashboard.html")).toString();

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
  const getDashboardWebContents = requiredDependency(
    options.getDashboardWebContents,
    "getDashboardWebContents"
  );
  const getKimiQuotaStatus = requiredDependency(options.getKimiQuotaStatus, "getKimiQuotaStatus");
  const refreshKimiQuota = requiredDependency(options.refreshKimiQuota, "refreshKimiQuota");
  const getSessionHistory = requiredDependency(options.getSessionHistory, "getSessionHistory");
  const resumeSessionFromHistory = requiredDependency(
    options.resumeSessionFromHistory,
    "resumeSessionFromHistory"
  );
  const quickMode = options.quickMode || null;
  const disposers = [];

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  // The one owned Dashboard WebContents, its current real main frame, and the
  // exact local page URL. Resolving through a window would break once the page
  // lives in a WebContentsView, and loosening any of the three would widen the
  // Kimi manual-quota capability — neither is acceptable.
  function isTrustedDashboardEvent(event) {
    const contents = getDashboardWebContents();
    if (!contents) return false;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
    const frame = event && event.senderFrame;
    return event.sender === contents
      && !!frame
      && frame === contents.mainFrame
      && frame.url === DASHBOARD_PAGE_URL;
  }

  function rejectUntrustedDashboardEvent(event) {
    return isTrustedDashboardEvent(event)
      ? null
      : { status: "error", reason: "untrusted-dashboard-sender" };
  }

  handle("dashboard:get-snapshot", () => getSessionSnapshot());
  handle("dashboard:get-i18n", () => getI18n());
  // Dashboard gets a narrow, secret-free manual refresh capability. The API
  // key remains inside kimiQuotaRuntime, and only the real local Dashboard
  // main frame may ask for status or trigger the existing refresh path.
  handle("dashboard:get-kimi-quota-status", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || getKimiQuotaStatus();
  });
  handle("dashboard:refresh-kimi-quota", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || refreshKimiQuota();
  });
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
  // Session history is the resume index for conversations that are no longer
  // running. Rows carry working-directory paths, and resuming spawns a real
  // agent process, so both channels are restricted to the trusted Dashboard
  // frame the same way the Kimi quota capability is.
  handle("dashboard:get-session-history", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || getSessionHistory();
  });
  handle("dashboard:resume-session", (event, payload) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 2
      || keys[0] !== "agentId"
      || keys[1] !== "sessionId"
      || typeof payload.agentId !== "string"
      || !payload.agentId
      || typeof payload.sessionId !== "string"
      || !payload.sessionId
    ) {
      return { status: "invalid" };
    }
    // No mode field on purpose: the Dashboard can only resume with normal
    // permissions. --dangerously-skip-permissions stays behind the pet menu
    // flow, which confirms it explicitly.
    return resumeSessionFromHistory({
      agentId: payload.agentId,
      sessionId: payload.sessionId,
    });
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

  // Dashboard keyboard mode. Every call is restricted to the trusted page and
  // carries the exact round it belongs to; a stale round can neither activate
  // a jump nor cancel the current one.
  //
  // On a platform where the mode is not offered the channels are never
  // registered at all — there is no capability to reach, not merely a handler
  // that answers "unsupported".
  const quickSupported = !!(quickMode
    && typeof quickMode.isSupported === "function"
    && quickMode.isSupported());

  if (quickSupported) {
    const quickResult = (handlerName, event, payload) => {
      const rejected = rejectUntrustedDashboardEvent(event);
      if (rejected) return rejected;
      if (typeof quickMode[handlerName] !== "function") return { status: "unsupported" };
      return quickMode[handlerName](payload);
    };

    handle("dashboard:quick-pending", (event) => {
      const rejected = rejectUntrustedDashboardEvent(event);
      if (rejected) return rejected;
      return { status: "ok", revision: quickMode.getPendingRevision() };
    });
    handle("dashboard:quick-enter", (event, payload) => quickResult("enter", event, payload));
    handle("dashboard:quick-ready", (event, payload) => quickResult("ready", event, payload));
    handle("dashboard:quick-activate", (event, payload) =>
      quickResult("activate", event, payload));
    handle("dashboard:quick-dismiss", (event, payload) =>
      quickResult("dismissFromRenderer", event, payload));
  }

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
