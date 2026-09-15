"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const snapshotListeners = new Set();
const langListeners = new Set();
const quickIntentListeners = new Set();
const quickEntriesListeners = new Set();
const quickDismissedListeners = new Set();

// The Dashboard keyboard mode only exists on darwin/win32, where main registers
// its channels. Anywhere else the bridge must not expose methods that would
// invoke an unregistered channel — the renderer feature-detects on this.
const QUICK_MODE_SUPPORTED = process.platform === "darwin" || process.platform === "win32";

function notify(listeners, payload, label) {
  for (const cb of listeners) {
    try { cb(payload); } catch (err) { console.warn(`dashboard ${label} listener threw:`, err); }
  }
}

function subscribe(listeners) {
  return (cb) => {
    if (typeof cb !== "function") return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
}

ipcRenderer.on("dashboard:session-snapshot", (_event, snapshot) => {
  for (const cb of snapshotListeners) {
    try { cb(snapshot); } catch (err) { console.warn("dashboard snapshot listener threw:", err); }
  }
});

ipcRenderer.on("dashboard:lang-change", (_event, payload) => {
  for (const cb of langListeners) {
    try { cb(payload); } catch (err) { console.warn("dashboard lang listener threw:", err); }
  }
});

// Dashboard keyboard mode. Narrow surface: learn about a round, refresh the
// frozen entries, learn a round ended, and the request calls. No generic
// window/IPC access is exposed.
if (QUICK_MODE_SUPPORTED) {
  ipcRenderer.on("dashboard:quick-intent", (_event, payload) =>
    notify(quickIntentListeners, payload, "quick intent"));
  ipcRenderer.on("dashboard:quick-entries", (_event, payload) =>
    notify(quickEntriesListeners, payload, "quick entries"));
  ipcRenderer.on("dashboard:quick-dismissed", (_event, payload) =>
    notify(quickDismissedListeners, payload, "quick dismissed"));
}

const quickModeApi = QUICK_MODE_SUPPORTED ? {
  quickPending: () => ipcRenderer.invoke("dashboard:quick-pending"),
  quickEnter: (payload) => ipcRenderer.invoke("dashboard:quick-enter", payload),
  quickReady: (payload) => ipcRenderer.invoke("dashboard:quick-ready", payload),
  quickActivate: (payload) => ipcRenderer.invoke("dashboard:quick-activate", payload),
  quickDismiss: (payload) => ipcRenderer.invoke("dashboard:quick-dismiss", payload),
  onQuickIntent: subscribe(quickIntentListeners),
  onQuickEntries: subscribe(quickEntriesListeners),
  onQuickDismissed: subscribe(quickDismissedListeners),
} : {};

contextBridge.exposeInMainWorld("dashboardAPI", {
  getSnapshot: () => ipcRenderer.invoke("dashboard:get-snapshot"),
  getI18n: () => ipcRenderer.invoke("dashboard:get-i18n"),
  getKimiQuotaStatus: () => ipcRenderer.invoke("dashboard:get-kimi-quota-status"),
  refreshKimiQuota: () => ipcRenderer.invoke("dashboard:refresh-kimi-quota"),
  focusSession: (sessionId) => ipcRenderer.send("dashboard:focus-session", sessionId),
  hideSession: (sessionId) => ipcRenderer.invoke("dashboard:hide-session", sessionId),
  openSessionFolder: (sessionId) => ipcRenderer.invoke("dashboard:open-session-folder", sessionId),
  setSessionAlias: (payload) => ipcRenderer.invoke("dashboard:set-session-alias", payload),
  setSessionAutomationOverride: (payload) =>
    ipcRenderer.invoke("dashboard:set-session-automation", payload),
  clearSessionAutomationGrant: (payload) =>
    ipcRenderer.invoke("dashboard:clear-session-automation-grant", payload),
  getSessionHistory: () => ipcRenderer.invoke("dashboard:get-session-history"),
  resumeSession: (payload) => ipcRenderer.invoke("dashboard:resume-session", payload),
  ackCompletion: (sessionId) => ipcRenderer.invoke("session:ack-completion", sessionId),
  onSessionSnapshot: (cb) => {
    if (typeof cb !== "function") return () => {};
    snapshotListeners.add(cb);
    return () => snapshotListeners.delete(cb);
  },
  onLangChange: (cb) => {
    if (typeof cb !== "function") return () => {};
    langListeners.add(cb);
    return () => langListeners.delete(cb);
  },
  ...quickModeApi,
});
