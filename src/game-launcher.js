"use strict";

// Game launcher window — a tiny floating panel anchored to the right of the
// pet's hit-rect with one button per supported mini-game. Show on hover,
// hide when the cursor leaves both the pet and the launcher itself.
//
// Lifecycle is owned by the main process. The renderer just emits hover /
// launch events via IPC; positioning + show/hide decisions all live here.

const { BrowserWindow, ipcMain } = require("electron");
const path = require("path");

const WIDTH = 132;
const HEIGHT = 88;
// Distance between the pet's hit-rect and the launcher panel. A few pixels
// is enough to keep them visually separate without creating a "dead zone"
// where the cursor leaves the pet but hasn't entered the launcher yet —
// every pixel here is time the user has to cross before the hide grace
// runs out.
const PET_GAP = 2;
// How long to keep the launcher visible after the cursor leaves both the
// pet and the launcher. Long enough that a casual diagonal mouse path from
// pet → launcher doesn't lose it, even with mid-motion pauses.
const HIDE_GRACE_MS = 1000;
// Once the launcher pops up, keep it visible for at least this long even if
// the cursor moves off immediately. Prevents the "showed up, vanished
// before I could click" flicker when the user grazes the pet.
const MIN_VISIBLE_MS = 450;

function clamp(v, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(v, min), max);
}

module.exports = function initGameLauncher(ctx) {
  let launcherWindow = null;
  let hoverOverLauncher = false;
  let hoverOverPet = false;
  let hideTimer = null;
  let shownAt = 0; // ms since epoch the launcher last became visible

  function shouldSuppress() {
    if (typeof ctx.isSuppressed === "function" && ctx.isSuppressed()) return true;
    return false;
  }

  function computeBounds() {
    const petBounds = typeof ctx.getPetWindowBounds === "function"
      ? ctx.getPetWindowBounds()
      : null;
    if (!petBounds) return null;
    const hitRect = typeof ctx.getHitRectScreen === "function"
      ? ctx.getHitRectScreen(petBounds)
      : null;
    const left = hitRect ? hitRect.right : petBounds.x + petBounds.width;
    const top = hitRect ? hitRect.top : petBounds.y;
    const bottom = hitRect ? hitRect.bottom : petBounds.y + petBounds.height;
    const cy = Math.round((top + bottom) / 2);
    let x = Math.round(left + PET_GAP);
    let y = Math.round(cy - HEIGHT / 2);

    const wa = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(x + WIDTH / 2, y + HEIGHT / 2)
      : null;
    if (wa) {
      // If the pet is too close to the right edge, flip the launcher to the
      // pet's left side so it stays on-screen.
      if (x + WIDTH > wa.x + wa.width) {
        const altLeft = (hitRect ? hitRect.left : petBounds.x) - PET_GAP - WIDTH;
        if (altLeft >= wa.x) x = altLeft;
        else x = wa.x + wa.width - WIDTH;
      }
      x = clamp(x, wa.x, wa.x + wa.width - WIDTH);
      y = clamp(y, wa.y, wa.y + wa.height - HEIGHT);
    }
    return { x, y, width: WIDTH, height: HEIGHT };
  }

  function ensureWindow() {
    if (launcherWindow && !launcherWindow.isDestroyed()) return launcherWindow;
    const bounds = computeBounds();
    launcherWindow = new BrowserWindow({
      x: bounds ? bounds.x : 0,
      y: bounds ? bounds.y : 0,
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      // Must be focusable=true: a non-focusable transparent BrowserWindow on
      // macOS routes clicks to the window underneath instead of the launcher
      // renderer, so the click handler never fires. We still call
      // showInactive() below so opening the launcher doesn't steal keyboard
      // focus from the user's editor.
      focusable: true,
      hasShadow: false,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "preload-game-launcher.js"),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
      },
    });
    launcherWindow.setMenuBarVisibility(false);
    launcherWindow.setAlwaysOnTop(true, "pop-up-menu");
    launcherWindow.loadFile(path.join(__dirname, "game-launcher.html"));
    launcherWindow.webContents.once("did-finish-load", () => {
      sendLang();
    });
    launcherWindow.on("closed", () => {
      launcherWindow = null;
      hoverOverLauncher = false;
      shownAt = 0;
    });
    return launcherWindow;
  }

  function sendLang() {
    if (!launcherWindow || launcherWindow.isDestroyed()) return;
    if (!launcherWindow.webContents || launcherWindow.webContents.isDestroyed()) return;
    const payload = typeof ctx.getI18n === "function" ? ctx.getI18n() : null;
    launcherWindow.webContents.send("game-launcher:lang-change", payload || {});
  }

  function reposition() {
    if (!launcherWindow || launcherWindow.isDestroyed()) return;
    const bounds = computeBounds();
    if (!bounds) return;
    launcherWindow.setBounds(bounds);
  }

  function actuallyShow() {
    const win = ensureWindow();
    if (!win || win.isDestroyed()) return;
    reposition();
    if (!win.isVisible()) {
      // showInactive avoids stealing keyboard focus from whatever the user is
      // working in. The launcher does not need keyboard input; clicks still
      // work without focus.
      win.showInactive();
      shownAt = Date.now();
    }
  }

  function actuallyHide() {
    if (!launcherWindow || launcherWindow.isDestroyed()) return;
    if (launcherWindow.isVisible()) launcherWindow.hide();
    hoverOverLauncher = false;
    shownAt = 0;
  }

  function clearHideTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function scheduleHide(extraDelayMs = 0) {
    clearHideTimer();
    const delay = Math.max(HIDE_GRACE_MS, extraDelayMs);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      // Re-check just before hiding — state may have flipped during the grace
      // window (cursor re-entered pet, hovered launcher, etc.).
      if (!hoverOverPet && !hoverOverLauncher) actuallyHide();
    }, delay);
  }

  function evaluate() {
    if (shouldSuppress()) {
      clearHideTimer();
      actuallyHide();
      return;
    }
    if (hoverOverPet || hoverOverLauncher) {
      clearHideTimer();
      actuallyShow();
      return;
    }
    // Apply the minimum-visible floor: if the launcher just popped up and the
    // user immediately moved off, defer hiding until the floor expires so
    // they have time to land on a button.
    const sinceShown = shownAt ? Date.now() - shownAt : Infinity;
    const remaining = MIN_VISIBLE_MS - sinceShown;
    scheduleHide(remaining > 0 ? remaining : 0);
  }

  function setMouseOverPet(value) {
    const next = !!value;
    if (hoverOverPet === next) return;
    hoverOverPet = next;
    evaluate();
  }

  function syncSuppression() {
    evaluate();
  }

  function destroy() {
    clearHideTimer();
    if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.destroy();
    launcherWindow = null;
  }

  ipcMain.on("game-launcher:hover", (event, hovered) => {
    if (!launcherWindow || launcherWindow.isDestroyed()) return;
    if (event.sender !== launcherWindow.webContents) return;
    hoverOverLauncher = !!hovered;
    evaluate();
  });

  ipcMain.on("game-launcher:launch", (event, gameId) => {
    if (!launcherWindow || launcherWindow.isDestroyed()) return;
    if (event.sender !== launcherWindow.webContents) return;
    const id = String(gameId || "");
    // Hide ourselves while the game window is open — when the user closes
    // the game and hovers the pet again, evaluate() shows us back.
    actuallyHide();
    if (typeof ctx.openGame === "function") ctx.openGame(id);
  });

  return {
    setMouseOverPet,
    syncSuppression,
    sendLang,
    reposition,
    destroy,
    getWindow: () => launcherWindow,
  };
};
