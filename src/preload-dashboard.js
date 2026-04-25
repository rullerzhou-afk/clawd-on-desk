"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const snapshotListeners = new Set();
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

contextBridge.exposeInMainWorld("dashboardAPI", {
  getSnapshot: () => ipcRenderer.invoke("dashboard:get-snapshot"),
  getI18n: () => ipcRenderer.invoke("dashboard:get-i18n"),
  focusSession: (sessionId) => ipcRenderer.send("dashboard:focus-session", sessionId),
  setSessionAlias: (payload) => ipcRenderer.invoke("dashboard:set-session-alias", payload),
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
});
