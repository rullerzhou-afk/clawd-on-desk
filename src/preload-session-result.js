"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("sessionResults", {
  ready: () => ipcRenderer.invoke("session-result:ready"),
  dismiss: (id, generation) => ipcRenderer.invoke("session-result:dismiss", { id, generation }),
  open: (id, generation) => ipcRenderer.invoke("session-result:open", { id, generation }),
  measure: height => ipcRenderer.send("session-result:height", height),
  onChange: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("session-result:change", listener);
    return () => ipcRenderer.removeListener("session-result:change", listener);
  },
});
