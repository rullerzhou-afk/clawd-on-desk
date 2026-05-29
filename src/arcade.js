"use strict";

// Arcade window manager. Each call to showArcade(gameId) opens a separate
// BrowserWindow dedicated to ONE mini-game (Snake or Plane). The two games
// no longer share a host with Tab switching — they run independently and
// you can have both windows open at the same time.

const { BrowserWindow } = require("electron");
const path = require("path");

// Compact frameless window — just a bit larger than the pet itself. The
// game canvas inside is 640×320 and gets CSS-scaled to fit, so changing
// these dimensions is purely a visual decision.
const DEFAULT_WIDTH = 440;
const DEFAULT_HEIGHT = 290;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 240;
const BACKGROUND = "#0a0a0a";

const SUPPORTED_GAMES = new Set(["snake", "plane"]);

function isUsableBounds(bounds) {
  return !!bounds
    && Number.isFinite(bounds.x)
    && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
    && bounds.width > 0
    && bounds.height > 0;
}

module.exports = function initArcade(ctx) {
  // One window per game id. Re-opening an already-open game just brings the
  // existing window forward instead of stacking duplicates.
  const windows = new Map();

  function computeInitialBounds(offsetIndex = 0) {
    const petBounds = typeof ctx.getPetWindowBounds === "function"
      ? ctx.getPetWindowBounds()
      : null;
    const hitRect = (petBounds && typeof ctx.getHitRectScreen === "function")
      ? ctx.getHitRectScreen(petBounds)
      : null;
    const cx = petBounds ? petBounds.x + petBounds.width / 2 : 0;
    const cy = petBounds ? petBounds.y + petBounds.height / 2 : 0;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    const width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, workArea.width));
    const height = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, workArea.height));
    // Cascade subsequent windows so the second game doesn't sit exactly on
    // top of the first when the user opens both.
    const offset = offsetIndex * 36;

    // Anchor the arcade window to the right of the pet's visible body.
    // 52px keeps the window close to the pet without quite touching it; the
    // launcher panel itself disappears as soon as the user clicks a button,
    // so we don't need to reserve space for it.
    const PET_TO_ARCADE_GAP = 52;
    const FALLBACK_GAP = 12;       // when flipping to the left side
    const petLeft = hitRect ? hitRect.left : (petBounds ? petBounds.x : workArea.x);
    const petRight = hitRect ? hitRect.right : (petBounds ? petBounds.x + petBounds.width : workArea.x + width);
    const petCenterY = hitRect
      ? Math.round((hitRect.top + hitRect.bottom) / 2)
      : (petBounds ? Math.round(petBounds.y + petBounds.height / 2) : workArea.y + height / 2);

    let x = Math.round(petRight + PET_TO_ARCADE_GAP + offset);
    if (x + width > workArea.x + workArea.width) {
      // Not enough room on the right — try the left side.
      const leftX = Math.round(petLeft - FALLBACK_GAP - width - offset);
      if (leftX >= workArea.x) {
        x = leftX;
      } else {
        // Pet sits in the middle of a narrow display — clamp to the right
        // edge of the work area; the window may overlap the pet, but at
        // least it stays on-screen.
        x = workArea.x + workArea.width - width;
      }
    }
    let y = Math.round(petCenterY - height / 2 + offset);
    x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width);
    y = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height);
    return { x, y, width, height };
  }

  function getTitle(gameId) {
    const key = gameId === "plane" ? "arcadePlaneWindowTitle" : "arcadeSnakeWindowTitle";
    if (typeof ctx.t === "function") {
      const v = ctx.t(key);
      if (v && v !== key) return v;
    }
    return gameId === "plane" ? "Plane Shooter" : "Snake";
  }

  function createGameWindow(gameId) {
    const bounds = computeInitialBounds(windows.size);
    const opts = {
      ...(isUsableBounds(bounds) ? bounds : { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      // Frameless to match the pet's chrome-less feel. The arcade.html title
      // bar is set as the drag region so the user can still move the window
      // around; the close button is rendered by the HUD.
      frame: false,
      transparent: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      hasShadow: true,
      skipTaskbar: false,
      alwaysOnTop: false,
      title: getTitle(gameId),
      backgroundColor: BACKGROUND,
      webPreferences: {
        // Fully local content; arcade-renderer.js uses CommonJS require()
        // to load the game modules just like upstream vibe-arcade.
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
      },
    };
    if (ctx.iconPath) opts.icon = ctx.iconPath;

    const win = new BrowserWindow(opts);
    win.setMenuBarVisibility(false);
    // Pass the game id via the URL hash — the renderer reads location.hash
    // to decide which game module to mount.
    win.loadFile(path.join(__dirname, "arcade.html"), { hash: gameId });
    win.once("ready-to-show", () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    });
    win.on("closed", () => {
      windows.delete(gameId);
    });
    windows.set(gameId, win);
    return win;
  }

  function showArcade(gameId) {
    const id = SUPPORTED_GAMES.has(gameId) ? gameId : "snake";
    const existing = windows.get(id);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }
    return createGameWindow(id);
  }

  function closeAll() {
    for (const win of windows.values()) {
      if (win && !win.isDestroyed()) win.close();
    }
    windows.clear();
  }

  return {
    showArcade,
    closeAll,
    getWindows: () => Array.from(windows.values()),
    SUPPORTED_GAMES: Array.from(SUPPORTED_GAMES),
  };
};
