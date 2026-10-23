"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("workbuddyCheckin", {
  command: (action, scope) =>
    ipcRenderer.invoke("workbuddy-checkin-action", { action, scope }),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("workbuddy-checkin-state", listener);
    return () =>
      ipcRenderer.removeListener("workbuddy-checkin-state", listener);
  },
});
