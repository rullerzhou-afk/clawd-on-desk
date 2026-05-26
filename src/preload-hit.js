const { contextBridge, ipcRenderer } = require("electron");

// Parse hit-renderer theme config from additionalArguments (synchronous, available on first load)
const hitThemeArg = process.argv.find(a => a.startsWith("--hit-theme-config="));
const hitThemeConfig = hitThemeArg ? JSON.parse(hitThemeArg.slice("--hit-theme-config=".length)) : null;

// Parse platform from additionalArguments so hit-renderer can branch on
// macOS-specific input semantics (Cmd vs Ctrl, Ctrl-click = right-click, etc.).
const platformArg = process.argv.find(a => a.startsWith("--hit-platform="));
const platform = platformArg ? platformArg.slice("--hit-platform=".length) : process.platform;

contextBridge.exposeInMainWorld("hitThemeConfig", hitThemeConfig);
contextBridge.exposeInMainWorld("hitPlatform", {
  isMac: platform === "darwin",
  platform,
});

contextBridge.exposeInMainWorld("hitAPI", {
  // Theme config push (for hot-switch; additionalArguments won't update on reload)
  onThemeConfig: (cb) => ipcRenderer.on("theme-config", (_, cfg) => cb(cfg)),
  // Sends → main
  dragLock: (locked) => ipcRenderer.send("drag-lock", locked),
  dragMove: () => ipcRenderer.send("drag-move"),
  dragEnd: () => ipcRenderer.send("drag-end"),
  showContextMenu: () => ipcRenderer.send("show-context-menu"),
  focusTerminal: () => ipcRenderer.send("focus-terminal"),
  exitMiniMode: () => ipcRenderer.send("exit-mini-mode"),
  showDashboard: () => ipcRenderer.send("show-dashboard"),
  revealSessionHud: () => ipcRenderer.send("pet-interaction:reveal-session-hud"),
  // Reaction triggers → main → renderWin
  startDragReaction: () => ipcRenderer.send("start-drag-reaction"),
  endDragReaction: () => ipcRenderer.send("end-drag-reaction"),
  playClickReaction: (svg, duration) => ipcRenderer.send("play-click-reaction", svg, duration),
  // State sync ← main
  onStateSync: (cb) => ipcRenderer.on("hit-state-sync", (_, data) => cb(data)),
  onCancelReaction: (cb) => ipcRenderer.on("hit-cancel-reaction", () => cb()),
});
