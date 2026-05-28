"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const snapshotListeners = new Set();

ipcRenderer.on("usage-gauge:snapshot", (_event, snapshot) => {
  for (const cb of snapshotListeners) {
    try { cb(snapshot); } catch (err) { console.warn("usage gauge listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("usageGaugeAPI", {
  toggleExpanded: () => ipcRenderer.send("usage-gauge:toggle-expanded"),
  onSnapshot: (cb) => {
    if (typeof cb !== "function") return () => {};
    snapshotListeners.add(cb);
    return () => snapshotListeners.delete(cb);
  },
});
