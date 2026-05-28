"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("windowControls", {
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  close: () => ipcRenderer.send("window:close"),
});

const snapshotListeners = new Set();
const usageListeners = new Set();
const langListeners = new Set();

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

ipcRenderer.on("dashboard:usage-snapshot", (_event, payload) => {
  for (const cb of usageListeners) {
    try { cb(payload); } catch (err) { console.warn("dashboard usage listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("dashboardAPI", {
  getSnapshot: () => ipcRenderer.invoke("dashboard:get-snapshot"),
  getUsageSnapshot: () => ipcRenderer.invoke("dashboard:get-usage-snapshot"),
  getI18n: () => ipcRenderer.invoke("dashboard:get-i18n"),
  focusSession: (sessionId) => ipcRenderer.send("dashboard:focus-session", sessionId),
  hideSession: (sessionId) => ipcRenderer.invoke("dashboard:hide-session", sessionId),
  setSessionAlias: (payload) => ipcRenderer.invoke("dashboard:set-session-alias", payload),
  ackCompletion: (sessionId) => ipcRenderer.invoke("session:ack-completion", sessionId),
  onSessionSnapshot: (cb) => {
    if (typeof cb !== "function") return () => {};
    snapshotListeners.add(cb);
    return () => snapshotListeners.delete(cb);
  },
  onUsageSnapshot: (cb) => {
    if (typeof cb !== "function") return () => {};
    usageListeners.add(cb);
    return () => usageListeners.delete(cb);
  },
  onLangChange: (cb) => {
    if (typeof cb !== "function") return () => {};
    langListeners.add(cb);
    return () => langListeners.delete(cb);
  },
});
