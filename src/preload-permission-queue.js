"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("permissionQueueAPI", {
  onShow: (callback) => ipcRenderer.on("permission-queue-show", (_event, payload) => callback(payload)),
  open: () => ipcRenderer.send("permission-queue-open"),
  close: () => ipcRenderer.send("permission-queue-close"),
  select: (selection) => ipcRenderer.send("permission-queue-select", selection),
  acknowledge: (acknowledgement) => ipcRenderer.send("permission-queue-ack", acknowledgement),
});
