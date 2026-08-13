"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const snapshotListeners = new Set();
const langListeners = new Set();
const visibilityListeners = new Set();

ipcRenderer.on("quota-ring:snapshot", (_event, payload) => {
  for (const cb of snapshotListeners) {
    try { cb(payload); } catch (err) { console.warn("quota ring snapshot listener threw:", err); }
  }
});

ipcRenderer.on("quota-ring:lang-change", (_event, payload) => {
  for (const cb of langListeners) {
    try { cb(payload); } catch (err) { console.warn("quota ring lang listener threw:", err); }
  }
});

// The renderer cannot detect this itself: an Electron window that is hidden
// does not reliably flip document.visibilityState, and a pinned cluster never
// hides at all.
ipcRenderer.on("quota-ring:visibility", (_event, visible) => {
  for (const cb of visibilityListeners) {
    try { cb(visible); } catch (err) { console.warn("quota ring visibility listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("quotaRingAPI", {
  getI18n: () => ipcRenderer.invoke("session-hud:get-i18n"),
  // Clicking a coin (or the "+N" overflow) opens the Dashboard, which owns the
  // full per-source detail. Reuses the HUD's existing channel/handler.
  openDashboard: () => ipcRenderer.send("session-hud:open-dashboard"),
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
  onVisibility: (cb) => {
    if (typeof cb !== "function") return () => {};
    visibilityListeners.add(cb);
    return () => visibilityListeners.delete(cb);
  },
});
