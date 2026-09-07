"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function") return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("quickSelectAPI", {
  consumeIntent: () => ipcRenderer.invoke("quick-select:consume-intent"),
  activateSession: (payload) => ipcRenderer.invoke("quick-select:activate-session", payload),
  dismiss: () => ipcRenderer.invoke("quick-select:dismiss"),
  onIntent: (callback) => subscribe("quick-select:intent", callback),
  onSnapshot: (callback) => subscribe("quick-select:snapshot", callback),
  onLangChange: (callback) => subscribe("quick-select:lang-change", callback),
  onDismissed: (callback) => subscribe("quick-select:dismissed", callback),
});
