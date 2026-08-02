"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("permissionAutomationConfirmation", {
  ready() {
    ipcRenderer.send("permission-automation-confirmation:ready");
  },
  stateApplied() {
    ipcRenderer.send("permission-automation-confirmation:state-applied");
  },
  onState(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("permission-automation-confirmation:state", listener);
    return () => ipcRenderer.removeListener("permission-automation-confirmation:state", listener);
  },
  submit(payload) {
    const action = payload && typeof payload.action === "string" ? payload.action : "cancel";
    ipcRenderer.send("permission-automation-confirmation:result", {
      action,
      suppressFutureConfirmation: payload && payload.suppressFutureConfirmation === true,
    });
  },
});
