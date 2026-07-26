const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Parse theme config from additionalArguments (synchronous, available on first load)
const themeArg = process.argv.find(a => a.startsWith("--theme-config="));
const themeConfig = themeArg ? JSON.parse(themeArg.slice("--theme-config=".length)) : null;

contextBridge.exposeInMainWorld("themeConfig", themeConfig);

contextBridge.exposeInMainWorld("electronAPI", {
  // Theme config push (for hot-switch; additionalArguments won't update on reload)
  onThemeConfig: (cb) => ipcRenderer.on("theme-config", (_, cfg) => cb(cfg)),
  onViewportOffset: (cb) => ipcRenderer.on("viewport-offset", (_, offsetY) => cb(offsetY)),
  // State sync from main
  onStateChange: (callback) => ipcRenderer.on("state-change", (_, state, svg) => callback(state, svg)),
  onKimiPermissionPulse: (callback) => ipcRenderer.on("kimi-permission-pulse", () => callback()),
  onEyeMove: (callback) => ipcRenderer.on("eye-move", (_, dx, dy) => callback(dx, dy)),
  onCloudlingPointer: (callback) => ipcRenderer.on("cloudling-pointer", (_, payload) => callback(payload)),
  onRoamHeading: (callback) => ipcRenderer.on("roam-heading", (_, headingLeft) => callback(headingLeft)),
  onWakeFromDoze: (callback) => ipcRenderer.on("wake-from-doze", () => callback()),
  onDndChange: (callback) => ipcRenderer.on("dnd-change", (_, enabled) => callback(enabled)),
  onMiniModeChange: (cb) => ipcRenderer.on("mini-mode-change", (_, enabled, edge, options) => cb(enabled, edge, options)),
  onMiniClip: (cb) => ipcRenderer.on("mini-clip", (_, info) => cb(info)),
  onLowPowerIdleModeChange: (cb) => ipcRenderer.on("low-power-idle-mode-change", (_, enabled) => cb(enabled)),
  onSystemWake: (cb) => ipcRenderer.on("system-wake", (_, payload) => cb(payload)),
  // Reaction control (from main, relayed from hit window)
  onStartDragReaction: (cb) => ipcRenderer.on("start-drag-reaction", (_, direction) => cb(direction)),
  onEndDragReaction: (cb) => ipcRenderer.on("end-drag-reaction", () => cb()),
  onPlayClickReaction: (cb) => ipcRenderer.on("play-click-reaction", (_, svg, duration) => cb(svg, duration)),
  // Hit state sync / cancel (redirected from sendToHitWin in merged build)
  onHitStateSync: (cb) => ipcRenderer.on("hit-state-sync", (_, data) => cb(data)),
  onCancelReaction: (cb) => ipcRenderer.on("hit-cancel-reaction", () => cb()),
  onDropAccepted: (cb) => ipcRenderer.on("pet-drop-accepted", () => cb()),
  // Sound playback (from main)
  onPreloadSounds: (cb) => ipcRenderer.on("preload-sounds", (_, payload) => cb(payload)),
  onPlaySound: (cb) => ipcRenderer.on("play-sound", (_, payload) => cb(payload)),
  onInvalidateSoundCache: (cb) => ipcRenderer.on("invalidate-sound-cache", (_, url) => cb(url)),
  reportSoundPlaybackError: (payload) => ipcRenderer.send("sound-playback-error", payload),
  // Input sends → main (formerly from hit window)
  dragLock: (locked) => ipcRenderer.send("drag-lock", locked),
  dragMove: () => ipcRenderer.send("drag-move"),
  dragEnd: () => ipcRenderer.send("drag-end"),
  showContextMenu: () => ipcRenderer.send("show-context-menu"),
  focusTerminal: () => ipcRenderer.send("focus-terminal"),
  // OS file drop (#459): webUtils.getPathForFile resolves File → absolute path
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ""; } catch (_) { return ""; }
  },
  dropPaths: (paths) => ipcRenderer.send("pet-drop-paths", paths),
  exitMiniMode: () => ipcRenderer.send("exit-mini-mode"),
  showDashboard: () => ipcRenderer.send("show-dashboard"),
  revealSessionHud: () => ipcRenderer.send("pet-interaction:reveal-session-hud"),
  // Reaction triggers → main → renderWin
  startDragReaction: (direction) => ipcRenderer.send("start-drag-reaction", direction),
  endDragReaction: () => ipcRenderer.send("end-drag-reaction"),
  playClickReaction: (svg, duration) => ipcRenderer.send("play-click-reaction", svg, duration),
  // Render window → main (cursor polling control during reactions)
  pauseCursorPolling: () => ipcRenderer.send("pause-cursor-polling"),
  resumeFromReaction: () => ipcRenderer.send("resume-from-reaction"),
  notifyPetVisualReady: () => ipcRenderer.send("pet-visual-ready"),
  setLowPowerIdlePaused: (paused) => ipcRenderer.send("low-power-idle-paused", !!paused),
  reportSystemWakeStatus: (payload) => ipcRenderer.send("system-wake-status", payload),
});
