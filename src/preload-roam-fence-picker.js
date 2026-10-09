"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("roamFencePickerAPI", {
  ready: () => ipcRenderer.send("roam-fence-picker:ready"),
  applied: () => ipcRenderer.send("roam-fence-picker:state-applied"),
  onState: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("roam-fence-picker:state", listener);
    return () => ipcRenderer.removeListener("roam-fence-picker:state", listener);
  },
  confirm: (selection) => ipcRenderer.send("roam-fence-picker:result", {
    action: "confirm",
    selection,
  }),
  cancel: () => ipcRenderer.send("roam-fence-picker:result", { action: "cancel" }),
});
