const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("qqMusic", {
  command: (action, value) =>
    ipcRenderer.invoke("qqmusic-command", { action, value }),
  close: () => ipcRenderer.send("qqmusic-close"),
  onResult: (callback) =>
    ipcRenderer.on("qqmusic-result", (_event, result) => callback(result)),
  onView: (callback) =>
    ipcRenderer.on("qqmusic-view", (_event, view) => callback(view)),
});
