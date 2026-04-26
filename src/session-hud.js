"use strict";

const { BrowserWindow } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

const HUD_BORDER_Y = 2;
const HUD_WIDTH = 240;
const HUD_ROW_HEIGHT = 28;
const HUD_MAX_EXPANDED_ROWS = 3;
const HUD_HEIGHT = HUD_ROW_HEIGHT + HUD_BORDER_Y;
const HUD_WINDOW_SHELL = Object.freeze({
  top: 2,
  right: 3,
  bottom: 8,
  left: 3,
});
const HUD_PET_GAP = 4;
const BUBBLE_GAP = 6;
const EDGE_MARGIN = 8;
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";
const MAC_FLOATING_TOPMOST_DELAY_MS = 120;

function clampToWorkArea(value, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(value, max));
}

function isHudSession(session) {
  return !!session && !session.headless && session.state !== "sleeping";
}

function computeHudLayout(snapshot) {
  const sessions = (snapshot && Array.isArray(snapshot.sessions)) ? snapshot.sessions : [];
  if (sessions.length === 0) return { expanded: [], folded: [], rowCount: 0 };
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const orderedIds = (snapshot && Array.isArray(snapshot.orderedIds))
    ? snapshot.orderedIds
    : sessions.map((s) => s.id);
  const ordered = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  const orderedSet = new Set(ordered.map((s) => s.id));
  const missing = sessions.filter((s) => !orderedSet.has(s.id));
  const visible = ordered.concat(missing).filter(isHudSession);
  const expanded = visible.slice(0, HUD_MAX_EXPANDED_ROWS);
  const folded = visible.slice(HUD_MAX_EXPANDED_ROWS);
  const rowCount = expanded.length + (folded.length > 0 ? 1 : 0);
  return { expanded, folded, rowCount };
}

function computeHudHeight(rowCount) {
  if (!Number.isFinite(rowCount) || rowCount <= 0) return HUD_ROW_HEIGHT;
  return rowCount * HUD_ROW_HEIGHT + HUD_BORDER_Y;
}

function computeHudReservedOffset(cardHeight) {
  const h = Number.isFinite(cardHeight) && cardHeight > 0 ? cardHeight : HUD_ROW_HEIGHT;
  return HUD_PET_GAP + h + HUD_WINDOW_SHELL.bottom + BUBBLE_GAP;
}

function computeSessionHudBounds({ hitRect, workArea, width = HUD_WIDTH, height = HUD_HEIGHT }) {
  if (!hitRect || !workArea) return null;
  const hitTop = Math.round(hitRect.top);
  const hitBottom = Math.round(hitRect.bottom);
  const hitCx = Math.round((hitRect.left + hitRect.right) / 2);

  const outerWidth = width + HUD_WINDOW_SHELL.left + HUD_WINDOW_SHELL.right;
  const outerHeight = height + HUD_WINDOW_SHELL.top + HUD_WINDOW_SHELL.bottom;
  const minX = Math.round(workArea.x);
  const maxX = Math.round(workArea.x + workArea.width - width);
  const x = clampToWorkArea(hitCx - Math.round(width / 2), minX, maxX);

  const belowY = hitBottom + HUD_PET_GAP;
  const belowMax = workArea.y + workArea.height - EDGE_MARGIN;
  if (belowY + height <= belowMax) {
    const contentBounds = { x, y: belowY, width, height };
    return {
      bounds: {
        x: contentBounds.x - HUD_WINDOW_SHELL.left,
        y: contentBounds.y - HUD_WINDOW_SHELL.top,
        width: outerWidth,
        height: outerHeight,
      },
      contentBounds,
      flippedAbove: false,
    };
  }

  const minY = Math.round(workArea.y + EDGE_MARGIN);
  const maxY = Math.round(workArea.y + workArea.height - EDGE_MARGIN - height);
  const aboveY = hitTop - height - HUD_PET_GAP;
  const contentBounds = {
    x,
    y: clampToWorkArea(aboveY, minY, maxY),
    width,
    height,
  };
  return {
    bounds: {
      x: contentBounds.x - HUD_WINDOW_SHELL.left,
      y: contentBounds.y - HUD_WINDOW_SHELL.top,
      width: outerWidth,
      height: outerHeight,
    },
    contentBounds,
    flippedAbove: true,
  };
}

function deferMacFloatingVisibility(ctx, win) {
  if (!isMac || !win || win.isDestroyed()) return;
  const deferUntil = Date.now() + MAC_FLOATING_TOPMOST_DELAY_MS;
  win.__clawdMacDeferredVisibilityUntil = deferUntil;
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    if (win.__clawdMacDeferredVisibilityUntil === deferUntil) {
      delete win.__clawdMacDeferredVisibilityUntil;
    }
    if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
  }, MAC_FLOATING_TOPMOST_DELAY_MS);
}

module.exports = function initSessionHud(ctx) {
  let hudWindow = null;
  let didFinishLoad = false;
  let latestSnapshot = null;
  let hudFlippedAbove = false;
  let lastReservedOffset = 0;
  let lastHudHeight = HUD_ROW_HEIGHT;

  function getCurrentSnapshot() {
    return typeof ctx.getSessionSnapshot === "function"
      ? ctx.getSessionSnapshot()
      : { sessions: [], groups: [], orderedIds: [], menuOrderedIds: [] };
  }

  function hasVisibleSessions(snapshot) {
    const sessions = Array.isArray(snapshot && snapshot.sessions) ? snapshot.sessions : [];
    return sessions.some(isHudSession);
  }

  function shouldShow(snapshot = latestSnapshot) {
    if (!snapshot) return false;
    if (ctx.sessionHudEnabled === false) return false;
    if (ctx.petHidden) return false;
    if (typeof ctx.getMiniMode === "function" && ctx.getMiniMode()) return false;
    if (typeof ctx.getMiniTransitioning === "function" && ctx.getMiniTransitioning()) return false;
    return hasVisibleSessions(snapshot);
  }

  function sendSnapshot(snapshot = latestSnapshot) {
    if (!snapshot || !hudWindow || hudWindow.isDestroyed() || !didFinishLoad) return;
    if (!hudWindow.webContents || hudWindow.webContents.isDestroyed()) return;
    hudWindow.webContents.send("session-hud:session-snapshot", snapshot);
  }

  function sendI18n() {
    if (!hudWindow || hudWindow.isDestroyed() || !didFinishLoad) return;
    if (!hudWindow.webContents || hudWindow.webContents.isDestroyed()) return;
    if (typeof ctx.getI18n !== "function") return;
    hudWindow.webContents.send("session-hud:lang-change", ctx.getI18n());
  }

  function ensureSessionHud() {
    if (hudWindow && !hudWindow.isDestroyed()) return hudWindow;
    if (!ctx.win || ctx.win.isDestroyed()) return null;

    didFinishLoad = false;
    hudFlippedAbove = false;
    hudWindow = new BrowserWindow({
      parent: ctx.win,
      width: HUD_WIDTH + HUD_WINDOW_SHELL.left + HUD_WINDOW_SHELL.right,
      height: HUD_HEIGHT + HUD_WINDOW_SHELL.top + HUD_WINDOW_SHELL.bottom,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: !isMac,
      focusable: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-session-hud.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (isWin) hudWindow.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(hudWindow);

    hudWindow.loadFile(path.join(__dirname, "session-hud.html"));
    hudWindow.webContents.once("did-finish-load", () => {
      didFinishLoad = true;
      sendI18n();
      syncSessionHud();
    });
    hudWindow.on("closed", () => {
      hudWindow = null;
      didFinishLoad = false;
      hudFlippedAbove = false;
      notifyReservedOffsetIfChanged();
    });

    return hudWindow;
  }

  function hideSessionHud() {
    hudFlippedAbove = false;
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.hide();
    notifyReservedOffsetIfChanged();
  }

  function computeBounds(snapshot) {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = typeof ctx.getPetWindowBounds === "function" ? ctx.getPetWindowBounds() : null;
    if (!petBounds) return null;
    const hitRect = typeof ctx.getHitRectScreen === "function"
      ? ctx.getHitRectScreen(petBounds)
      : null;
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    const layout = computeHudLayout(snapshot);
    const height = computeHudHeight(layout.rowCount);
    lastHudHeight = height;
    return computeSessionHudBounds({ hitRect, workArea, height });
  }

  function showSessionHud(win) {
    if (!win || win.isDestroyed() || !didFinishLoad) return;
    if (!win.isVisible()) {
      win.showInactive();
      keepOutOfTaskbar(win);
      if (isMac) deferMacFloatingVisibility(ctx, win);
      else if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
    }
    notifyReservedOffsetIfChanged();
  }

  function syncSessionHud(snapshot = latestSnapshot || getCurrentSnapshot(), options = {}) {
    latestSnapshot = snapshot;
    if (!shouldShow(snapshot)) {
      hideSessionHud();
      return;
    }

    const win = ensureSessionHud();
    if (!win || win.isDestroyed()) return;

    const computed = computeBounds(snapshot);
    if (!computed) {
      hideSessionHud();
      return;
    }
    hudFlippedAbove = !!computed.flippedAbove;
    win.setBounds(computed.bounds);
    if (options.sendSnapshot !== false) sendSnapshot(snapshot);
    showSessionHud(win);
  }

  function broadcastSessionSnapshot(snapshot) {
    syncSessionHud(snapshot);
  }

  function repositionSessionHud() {
    syncSessionHud(latestSnapshot || getCurrentSnapshot(), { sendSnapshot: false });
  }

  function getHudReservedOffset() {
    return readHudReservedOffset();
  }

  function readHudReservedOffset() {
    if (!hudWindow || hudWindow.isDestroyed() || !hudWindow.isVisible()) return 0;
    if (hudFlippedAbove) return 0;
    return computeHudReservedOffset(lastHudHeight);
  }

  function notifyReservedOffsetIfChanged() {
    const next = readHudReservedOffset();
    if (next === lastReservedOffset) return;
    lastReservedOffset = next;
    if (typeof ctx.onReservedOffsetChange === "function") ctx.onReservedOffsetChange(next);
  }

  function cleanup() {
    if (hudWindow && !hudWindow.isDestroyed()) hudWindow.destroy();
    hudWindow = null;
    didFinishLoad = false;
    hudFlippedAbove = false;
    lastHudHeight = HUD_ROW_HEIGHT;
    notifyReservedOffsetIfChanged();
  }

  return {
    ensureSessionHud,
    broadcastSessionSnapshot,
    repositionSessionHud,
    syncSessionHud,
    sendI18n,
    getHudReservedOffset,
    cleanup,
    getWindow: () => hudWindow,
  };
};

module.exports.__test = {
  computeSessionHudBounds,
  computeHudLayout,
  computeHudHeight,
  computeHudReservedOffset,
  isHudSession,
  constants: {
    HUD_WIDTH,
    HUD_HEIGHT,
    HUD_ROW_HEIGHT,
    HUD_MAX_EXPANDED_ROWS,
    HUD_WINDOW_SHELL,
    HUD_PET_GAP,
    BUBBLE_GAP,
    EDGE_MARGIN,
    HUD_BORDER_Y,
  },
};
