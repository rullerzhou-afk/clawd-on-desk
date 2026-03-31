const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hitAPI", {
  // Sends → main
  dragLock: (locked) => ipcRenderer.send("drag-lock", locked),
  moveWindowBy: (dx, dy) => ipcRenderer.send("move-window-by", dx, dy),
  dragEnd: () => ipcRenderer.send("drag-end"),
  showContextMenu: () => ipcRenderer.send("show-context-menu"),
  focusTerminal: () => ipcRenderer.send("focus-terminal"),
  exitMiniMode: () => ipcRenderer.send("exit-mini-mode"),
  showSessionMenu: () => ipcRenderer.send("show-session-menu"),
  openAskPanel: () => ipcRenderer.send("open-ask-panel"),
  // Reaction triggers → main → renderWin
  startDragReaction: () => ipcRenderer.send("start-drag-reaction"),
  endDragReaction: () => ipcRenderer.send("end-drag-reaction"),
  playClickReaction: (svg, duration) => ipcRenderer.send("play-click-reaction", svg, duration),
  // State sync ← main
  onStateSync: (cb) => ipcRenderer.on("hit-state-sync", (_, data) => cb(data)),
  onCancelReaction: (cb) => ipcRenderer.on("hit-cancel-reaction", () => cb()),
});
