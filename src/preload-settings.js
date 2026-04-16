"use strict";

// ── Settings panel preload ──
//
// Surface: window.settingsAPI
//
//   getSnapshot()                       Promise<snapshot>
//   update(key, value)                  Promise<{ status, message? }>
//   command(action, payload)            Promise<{ status, message? }>
//   listAgents()                        Promise<Array<{id, name, ...}>>
//   onChanged(cb)                       cb({ changes, snapshot? }) — fires for
//                                       every settings-changed broadcast
//
// All writes go through ipcMain.handle("settings:update") in main.js, which
// routes through the controller. The renderer never owns state — it always
// re-renders from the snapshot delivered via onChanged broadcasts (or the
// initial getSnapshot() call). This is the unidirectional flow contract from
// plan-settings-panel.md §4.2.

const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Set();
ipcRenderer.on("settings-changed", (_event, payload) => {
  for (const cb of listeners) {
    try { cb(payload); } catch (err) { console.warn("settings onChanged listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("settingsAPI", {
  getSnapshot: () => ipcRenderer.invoke("settings:get-snapshot"),
  update: (key, value) => ipcRenderer.invoke("settings:update", { key, value }),
  command: (action, payload) => ipcRenderer.invoke("settings:command", { action, payload }),
  listAgents: () => ipcRenderer.invoke("settings:list-agents"),
  onChanged: (cb) => {
    if (typeof cb === "function") listeners.add(cb);
  },
});
