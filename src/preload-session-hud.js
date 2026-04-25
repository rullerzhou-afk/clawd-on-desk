"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const snapshotListeners = new Set();
const langListeners = new Set();

ipcRenderer.on("session-hud:session-snapshot", (_event, snapshot) => {
  for (const cb of snapshotListeners) {
    try { cb(snapshot); } catch (err) { console.warn("session hud snapshot listener threw:", err); }
  }
});

ipcRenderer.on("session-hud:lang-change", (_event, payload) => {
  for (const cb of langListeners) {
    try { cb(payload); } catch (err) { console.warn("session hud lang listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("sessionHudAPI", {
  getI18n: () => ipcRenderer.invoke("session-hud:get-i18n"),
  focusSession: (sessionId) => ipcRenderer.send("session-hud:focus-session", sessionId),
  openDashboard: () => ipcRenderer.send("session-hud:open-dashboard"),
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
