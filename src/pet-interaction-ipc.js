"use strict";

const path = require("path");

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerPetInteractionIpc requires ${name}`);
  return value;
}

function registerPetInteractionIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const showContextMenu = requiredDependency(options.showContextMenu, "showContextMenu");
  const moveWindowForDrag = requiredDependency(options.moveWindowForDrag, "moveWindowForDrag");
  const setIdlePaused = requiredDependency(options.setIdlePaused, "setIdlePaused");
  const isMiniTransitioning = requiredDependency(options.isMiniTransitioning, "isMiniTransitioning");
  const getCurrentState = requiredDependency(options.getCurrentState, "getCurrentState");
  const getCurrentSvg = requiredDependency(options.getCurrentSvg, "getCurrentSvg");
  const sendToRenderer = requiredDependency(options.sendToRenderer, "sendToRenderer");
  const setDragLocked = requiredDependency(options.setDragLocked, "setDragLocked");
  const setMouseOverPet = requiredDependency(options.setMouseOverPet, "setMouseOverPet");
  const beginDragSnapshot = requiredDependency(options.beginDragSnapshot, "beginDragSnapshot");
  const clearDragSnapshot = requiredDependency(options.clearDragSnapshot, "clearDragSnapshot");
  const syncHitWin = requiredDependency(options.syncHitWin, "syncHitWin");
  const isMiniMode = requiredDependency(options.isMiniMode, "isMiniMode");
  const checkMiniModeSnap = requiredDependency(options.checkMiniModeSnap, "checkMiniModeSnap");
  const hasPetWindow = requiredDependency(options.hasPetWindow, "hasPetWindow");
  const getPetWindowBounds = requiredDependency(options.getPetWindowBounds, "getPetWindowBounds");
  const getCurrentPixelSize = requiredDependency(options.getCurrentPixelSize, "getCurrentPixelSize");
  // #408: prefer the effective (frozen, when keepSizeAcrossDisplays) size over
  // re-reading live bounds; falls back to proportional when not provided.
  const getEffectiveCurrentPixelSize = options.getEffectiveCurrentPixelSize || getCurrentPixelSize;
  const computeDragEndBounds = requiredDependency(options.computeDragEndBounds, "computeDragEndBounds");
  const applyPetWindowBounds = requiredDependency(options.applyPetWindowBounds, "applyPetWindowBounds");
  const flushRuntimeStateToPrefs = requiredDependency(
    options.flushRuntimeStateToPrefs,
    "flushRuntimeStateToPrefs"
  );
  const reassertWinTopmost = requiredDependency(options.reassertWinTopmost, "reassertWinTopmost");
  const scheduleHwndRecovery = requiredDependency(options.scheduleHwndRecovery, "scheduleHwndRecovery");
  const repositionFloatingBubbles = requiredDependency(
    options.repositionFloatingBubbles,
    "repositionFloatingBubbles"
  );
  const exitMiniMode = requiredDependency(options.exitMiniMode, "exitMiniMode");
  const getDisableMiniMode = options.getDisableMiniMode || (() => false);
  const getFocusableLocalHudSessionIds = requiredDependency(
    options.getFocusableLocalHudSessionIds,
    "getFocusableLocalHudSessionIds"
  );
  const focusLog = requiredDependency(options.focusLog, "focusLog");
  const showDashboard = requiredDependency(options.showDashboard, "showDashboard");
  const focusSession = requiredDependency(options.focusSession, "focusSession");
  const revealSessionHud = requiredDependency(options.revealSessionHud, "revealSessionHud");
  const setLowPowerIdlePaused = requiredDependency(
    options.setLowPowerIdlePaused,
    "setLowPowerIdlePaused"
  );
  const statPath = requiredDependency(options.statPath, "statPath");
  const openTerminalAt = requiredDependency(options.openTerminalAt, "openTerminalAt");
  const dropLog = options.dropLog || (() => {});
  const isMacPlatform = options.isMacPlatform != null
    ? !!options.isMacPlatform
    : process.platform === "darwin";
  const disposers = [];

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  on("show-context-menu", showContextMenu);
  on("drag-move", () => moveWindowForDrag());

  on("pause-cursor-polling", () => {
    setIdlePaused(true);
  });
  on("resume-from-reaction", () => {
    setIdlePaused(false);
    if (isMiniTransitioning()) return;
    sendToRenderer("state-change", getCurrentState(), getCurrentSvg());
  });
  on("low-power-idle-paused", (_event, paused) => {
    setLowPowerIdlePaused(!!paused);
  });

  on("drag-lock", (_event, locked) => {
    setDragLocked(!!locked);
    if (locked) {
      setMouseOverPet(true);
      beginDragSnapshot();
    } else {
      clearDragSnapshot();
      syncHitWin();
    }
  });

  on("start-drag-reaction", (_event, direction) => {
    sendToRenderer("start-drag-reaction", direction === "left" || direction === "right" ? direction : null);
  });
  on("end-drag-reaction", () => sendToRenderer("end-drag-reaction"));
  on("play-click-reaction", (_event, svg, duration) => {
    sendToRenderer("play-click-reaction", svg, duration);
  });

  on("drag-end", () => {
    try {
      if (!isMiniMode() && !isMiniTransitioning()) {
        if (!getDisableMiniMode()) checkMiniModeSnap();
        if (isMiniMode() || isMiniTransitioning()) return;
        if (hasPetWindow()) {
          const virtualBounds = getPetWindowBounds();
          const size = getEffectiveCurrentPixelSize();
          const clamped = computeDragEndBounds(virtualBounds, size);
          if (clamped) {
            applyPetWindowBounds(clamped);
            flushRuntimeStateToPrefs();
          }
          reassertWinTopmost();
          scheduleHwndRecovery();
          syncHitWin();
          repositionFloatingBubbles();
        }
      }
    } finally {
      setDragLocked(false);
      clearDragSnapshot();
    }
  });

  on("exit-mini-mode", () => {
    if (isMiniMode()) exitMiniMode();
  });

  on("pet-interaction:reveal-session-hud", () => {
    revealSessionHud();
  });

  // OS file drop from the hit window (#459, Windows/Linux only): first path
  // wins, files resolve to their parent directory, then open a plain terminal
  // there (no agent). The accept ping goes back to the SENDING window (hit
  // renderer plays its own reaction so its isReacting gate stays consistent).
  // macOS never registers the renderer-side listeners (screen-saver-level
  // windows are invisible to macOS drag-destination search); this guard is the
  // second layer so a stray IPC can't open terminals there either.
  on("pet-drop-paths", async (event, paths) => {
    try {
      if (isMacPlatform) {
        dropLog("drop ignored: OS file drop is disabled on macOS");
        return;
      }
      if (isMiniMode() || isMiniTransitioning()) return;
      if (!Array.isArray(paths)) return;
      const first = paths.find((p) => typeof p === "string" && p.length > 0);
      if (!first) return;
      let stats;
      try {
        stats = await statPath(first);
      } catch (_) {
        dropLog(`drop ignored: stat failed for ${first}`);
        return;
      }
      const dir = stats.isDirectory() ? first : path.dirname(first);
      const result = await openTerminalAt(dir);
      if (result && result.ok) {
        dropLog(`drop opened terminal=${result.terminal} dir=${dir}`);
        const sender = event && event.sender;
        if (sender && typeof sender.send === "function" && !(typeof sender.isDestroyed === "function" && sender.isDestroyed())) {
          sender.send("pet-drop-accepted");
        }
      } else {
        dropLog(`drop terminal launch failed: ${(result && result.message) || "unknown"}`);
      }
    } catch (err) {
      dropLog(`drop error: ${(err && err.message) || err}`);
    }
  });

  on("focus-terminal", () => {
    const focusableIds = getFocusableLocalHudSessionIds();
    focusLog(`focus request source=pet-body sid=- focusableCount=${focusableIds.length}`);
    if (focusableIds.length > 1) {
      focusLog(`focus result branch=none reason=multi-session-open-dashboard count=${focusableIds.length}`);
      showDashboard();
      return;
    }
    if (focusableIds.length === 1) {
      focusSession(focusableIds[0], { requestSource: "pet-body" });
      return;
    }
    focusLog("focus result branch=none reason=no-focusable-session source=pet-body");
  });

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

module.exports = {
  registerPetInteractionIpc,
};
