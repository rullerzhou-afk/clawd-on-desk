const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sessionPanelAPI", {
  getData: () => ipcRenderer.invoke("session-panel:get-data"),
  resize: (height) => ipcRenderer.send("session-panel:resize", height),
  focusSession: (sessionId) => ipcRenderer.send("session-panel:focus-session", sessionId),
});
