const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("askAPI", {
  onInit: (cb) => ipcRenderer.on("ask-init", (_, d) => cb(d)),
  sendPrompt: (prompt, messages) => ipcRenderer.send("ask-claude", { prompt, messages }),
  onStreamChunk: (cb) => ipcRenderer.on("ask-stream-chunk", (_, c) => cb(c)),
  onStreamDone: (cb) => ipcRenderer.on("ask-stream-done", (_, code) => cb(code)),
  onStreamError: (cb) => ipcRenderer.on("ask-stream-error", (_, e) => cb(e)),
  cancelRequest: () => ipcRenderer.send("cancel-ask-request"),
  close: () => ipcRenderer.send("close-ask-panel"),
  // Session management
  switchWorkspace: (cwd) => ipcRenderer.invoke("switch-workspace", cwd),
  saveSession: (cwd, messages) => ipcRenderer.send("save-session", { cwd, messages }),
  selectFolder: () => ipcRenderer.invoke("select-folder"),
});
