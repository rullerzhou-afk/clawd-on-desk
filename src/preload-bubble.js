const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bubbleAPI", {
  onPermissionShow: (cb) => ipcRenderer.on("permission-show", (_, data) => cb(data)),
  onPresentation: (cb) => ipcRenderer.on("permission-presentation", (_, data) => cb(data)),
  onRestoreActiveControl: (cb) => ipcRenderer.on("permission-restore-active-control", () => cb()),
  decide: (behavior) => ipcRenderer.send("permission-decide", behavior),
  setExpanded: (expanded) => ipcRenderer.send("permission-set-expanded", !!expanded),
  onPermissionHide: (cb) => ipcRenderer.on("permission-hide", () => cb()),
  reportHeight: (h) => ipcRenderer.send("bubble-height", h),
  setImeEditing: (editing) => ipcRenderer.send("bubble-ime-editing", !!editing),
  setCompositionActive: (active) => ipcRenderer.send("bubble-composition-active", !!active),
});
