"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("usageHoverAPI", {
  getSnapshot: () => ipcRenderer.invoke("usage-hover:get-snapshot"),
  onSnapshot: (cb) => {
    ipcRenderer.on("usage-hover:snapshot", (_event, snapshot) => cb(snapshot));
  },
});
