"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktopSettings", {
  invoke: (action, value, kind) =>
    ipcRenderer.invoke("desktop-integrations:settings", {
      action,
      value,
      kind,
    }),
});
