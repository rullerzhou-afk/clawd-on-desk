"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const snapshotListeners = new Set();
const langListeners = new Set();

ipcRenderer.on("session-status-badge:snapshot", (_event, payload) => {
  for (const cb of snapshotListeners) {
    try { cb(payload); } catch (err) { console.warn("status badge snapshot listener threw:", err); }
  }
});

ipcRenderer.on("session-hud:lang-change", (_event, payload) => {
  for (const cb of langListeners) {
    try { cb(payload); } catch (err) { console.warn("status badge language listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("sessionStatusBadgeAPI", {
  getI18n: () => ipcRenderer.invoke("session-hud:get-i18n"),
  toggleCollapsed: () => ipcRenderer.invoke("session-status-badge:toggle-collapsed"),
  onSnapshot: (cb) => {
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
