"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("clawdQuestion", {
  get: () => ipcRenderer.invoke("desktop-question:get"),
  answer: (answers) => ipcRenderer.invoke("desktop-question:answer", answers),
  cancel: () => ipcRenderer.invoke("desktop-question:cancel"),
});
