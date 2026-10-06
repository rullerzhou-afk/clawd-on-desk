const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updateBubbleAPI", {
  onShow: (cb) => ipcRenderer.on("update-bubble-show", (_, data) => cb(data)),
  onHide: (cb) => ipcRenderer.on("update-bubble-hide", () => cb()),
  onCopyResult: (cb) => ipcRenderer.on("update-bubble-copy-result", (_, data) => cb(data)),
  choose: (actionId) => ipcRenderer.send("update-bubble-action", actionId),
  reportHeight: (height) => ipcRenderer.send("update-bubble-height", height),
});
