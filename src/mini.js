// src/mini.js — Mini mode (edge snap, crabwalk, peek, window animations)
// Extracted from main.js L315-331, L2700-2911

const { screen } = require("electron");

module.exports = function initMini(ctx) {

const MINI_OFFSET_RATIO = 0.486;
const PEEK_OFFSET = 25;
const SNAP_TOLERANCE = 30;
const JUMP_PEAK_HEIGHT = 40;
const JUMP_DURATION = 350;
const CRABWALK_SPEED = 0.12;  // px/ms

let miniMode = false;
let miniTransitioning = false;
let miniSleepPeeked = false;
let preMiniX = 0, preMiniY = 0;
let currentMiniX = 0;
let miniSnap = null;  // { y, width, height } — canonical rect to prevent DPI drift
let miniTransitionTimer = null;
let peekAnimTimer = null;
let isAnimating = false;

// ── Window animation ──
function animateWindowX(targetX, durationMs) {
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  const bounds = ctx.win.getBounds();
  const startX = bounds.x;
  if (startX === targetX) { isAnimating = false; return; }
  isAnimating = true;
  const startTime = Date.now();
  const snapY = miniSnap ? miniSnap.y : bounds.y;
  const snapW = miniSnap ? miniSnap.width : bounds.width;
  const snapH = miniSnap ? miniSnap.height : bounds.height;
  let frameCount = 0;
  const step = () => {
    if (!ctx.win || ctx.win.isDestroyed()) { peekAnimTimer = null; isAnimating = false; return; }
    const t = Math.min(1, (Date.now() - startTime) / durationMs);
    const eased = t * (2 - t);
    const x = Math.round(startX + (targetX - startX) * eased);
    if (!Number.isFinite(x) || !Number.isFinite(snapY)) { peekAnimTimer = null; isAnimating = false; return; }
    ctx.win.setBounds({ x, y: snapY, width: snapW, height: snapH });
    ctx.syncHitWin();
    // Throttle bubble reposition to every 3rd frame (~20fps) — visually identical, less overhead
    if (ctx.bubbleFollowPet && ctx.pendingPermissions.length && (++frameCount % 3 === 0 || t >= 1)) ctx.repositionBubbles();
    if (t < 1) {
      peekAnimTimer = setTimeout(step, 16);
    } else {
      peekAnimTimer = null;
      isAnimating = false;
    }
  };
  step();
}

function animateWindowParabola(targetX, targetY, durationMs, onDone) {
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  const bounds = ctx.win.getBounds();
  const startX = bounds.x, startY = bounds.y;
  if (startX === targetX && startY === targetY) {
    isAnimating = false;
    if (onDone) onDone();
    return;
  }
  isAnimating = true;
  const startTime = Date.now();
  let frameCount = 0;
  const step = () => {
    if (!ctx.win || ctx.win.isDestroyed()) { peekAnimTimer = null; isAnimating = false; return; }
    const t = Math.min(1, (Date.now() - startTime) / durationMs);
    const eased = t * (2 - t);
    const x = Math.round(startX + (targetX - startX) * eased);
    const arc = -4 * JUMP_PEAK_HEIGHT * t * (t - 1);
    const y = Math.round(startY + (targetY - startY) * eased - arc);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { peekAnimTimer = null; isAnimating = false; if (onDone) onDone(); return; }
    ctx.win.setPosition(x, y);
    ctx.syncHitWin();
    // Throttle bubble reposition to every 3rd frame (~20fps) — visually identical, less overhead
    if (ctx.bubbleFollowPet && ctx.pendingPermissions.length && (++frameCount % 3 === 0 || t >= 1)) ctx.repositionBubbles();
    if (t < 1) {
      peekAnimTimer = setTimeout(step, 16);
    } else {
      peekAnimTimer = null;
      isAnimating = false;
      if (onDone) onDone();
    }
  };
  step();
}

function miniPeekIn() {
  animateWindowX(currentMiniX - PEEK_OFFSET, 200);
}

function miniPeekOut() {
  animateWindowX(currentMiniX, 200);
}

function cancelMiniTransition() {
  miniTransitioning = false;
  if (miniTransitionTimer) { clearTimeout(miniTransitionTimer); miniTransitionTimer = null; }
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
  isAnimating = false;
}

function checkMiniModeSnap() {
  if (miniMode) return;
  const bounds = ctx.win.getBounds();
  const size = ctx.SIZES[ctx.currentSize];
  const mRight = Math.round(size.width * 0.25);
  const centerX = bounds.x + size.width / 2;
  const displays = screen.getAllDisplays();
  for (const d of displays) {
    const wa = d.workArea;
    const centerY = bounds.y + size.height / 2;
    if (centerX < wa.x || centerX > wa.x + wa.width) continue;
    if (centerY < wa.y || centerY > wa.y + wa.height) continue;
    const rightLimit = wa.x + wa.width - size.width + mRight;
    if (bounds.x >= rightLimit - SNAP_TOLERANCE) {
      enterMiniMode(wa);
      return;
    }
  }
}

function enterMiniMode(wa, viaMenu) {
  if (miniMode && !viaMenu) return;
  const bounds = ctx.win.getBounds();
  if (!viaMenu) {
    preMiniX = bounds.x;
    preMiniY = bounds.y;
  }
  miniMode = true;
  const size = ctx.SIZES[ctx.currentSize];
  currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
  miniSnap = { y: bounds.y, width: size.width, height: size.height };

  ctx.stopWakePoll();

  ctx.sendToRenderer("mini-mode-change", true);
  ctx.sendToHitWin("hit-state-sync", { miniMode: true });
  miniTransitioning = true;
  ctx.buildContextMenu();
  ctx.buildTrayMenu();

  const enterSvgState = ctx.doNotDisturb ? "mini-enter-sleep" : "mini-enter";

  if (viaMenu) {
    const displays = screen.getAllDisplays();
    let maxRight = 0;
    for (const d of displays) maxRight = Math.max(maxRight, d.bounds.x + d.bounds.width);
    const jumpTarget = maxRight;
    animateWindowParabola(jumpTarget, bounds.y, JUMP_DURATION, () => {
      ctx.applyState(enterSvgState);
      miniTransitionTimer = setTimeout(() => {
        miniSnap = { y: bounds.y, width: size.width, height: size.height };
        ctx.win.setBounds({ x: currentMiniX, y: miniSnap.y, width: miniSnap.width, height: miniSnap.height });
        miniTransitionTimer = setTimeout(() => {
          miniTransitioning = false;
          ctx.applyState(ctx.doNotDisturb ? "mini-sleep" : "mini-idle");
        }, 3200);
      }, 300);
    });
  } else {
    animateWindowX(currentMiniX, 100);
    ctx.applyState(enterSvgState);
    miniTransitionTimer = setTimeout(() => {
      miniTransitioning = false;
      ctx.applyState(ctx.doNotDisturb ? "mini-sleep" : "mini-idle");
    }, 3200);
  }
}

function exitMiniMode() {
  if (!miniMode) return;
  cancelMiniTransition();
  // Keep miniMode = true and miniTransitioning = true during exit parabola.
  // This blocks ALL paths that check miniMode (always-on-top-changed,
  // display-metrics-changed, move-window-by, checkMiniModeSnap, etc.)
  // from interfering with the animation. Both flags clear in onDone.
  miniTransitioning = true;
  miniSnap = null;
  miniSleepPeeked = false;

  const size = ctx.SIZES[ctx.currentSize];
  const clamped = ctx.clampToScreen(preMiniX, preMiniY, size.width, size.height);
  const wa = ctx.getNearestWorkArea(clamped.x + size.width / 2, clamped.y + size.height / 2);
  const mRight = Math.round(size.width * 0.25);
  if (clamped.x >= wa.x + wa.width - size.width + mRight - SNAP_TOLERANCE) {
    clamped.x = wa.x + wa.width - size.width + mRight - 100;
  }

  animateWindowParabola(clamped.x, clamped.y, JUMP_DURATION, () => {
    miniMode = false;
    miniTransitioning = false;
    ctx.sendToRenderer("mini-mode-change", false);
    ctx.sendToHitWin("hit-state-sync", { miniMode: false });
    ctx.buildContextMenu();
    ctx.buildTrayMenu();
    if (ctx.doNotDisturb) {
      ctx.doNotDisturb = false;
      ctx.sendToRenderer("dnd-change", false);
      ctx.sendToHitWin("hit-state-sync", { dndEnabled: false });
      ctx.buildContextMenu();
      ctx.buildTrayMenu();
      ctx.applyState("waking");
    } else {
      const resolved = ctx.resolveDisplayState();
      ctx.applyState(resolved, ctx.getSvgOverride(resolved));
    }
  });
}

function enterMiniViaMenu() {
  const bounds = ctx.win.getBounds();
  const size = ctx.SIZES[ctx.currentSize];
  const wa = ctx.getNearestWorkArea(bounds.x + size.width / 2, bounds.y + size.height / 2);

  preMiniX = bounds.x;
  preMiniY = bounds.y;
  miniTransitioning = true;

  ctx.sendToRenderer("mini-mode-change", true);
  ctx.sendToHitWin("hit-state-sync", { miniMode: true });

  ctx.applyState("mini-crabwalk");

  const edgeX = wa.x + wa.width - size.width + Math.round(size.width * 0.25);
  const walkDist = Math.abs(bounds.x - edgeX);
  const walkDuration = walkDist / CRABWALK_SPEED;
  animateWindowX(edgeX, walkDuration);

  miniTransitionTimer = setTimeout(() => {
    enterMiniMode(wa, true);
  }, walkDuration + 50);
}

function handleDisplayChange() {
  if (!ctx.win || ctx.win.isDestroyed()) return;
  if (!miniMode) return;
  const size = ctx.SIZES[ctx.currentSize];
  const snapY = miniSnap ? miniSnap.y : ctx.win.getBounds().y;
  const wa = ctx.getNearestWorkArea(currentMiniX + size.width / 2, snapY + size.height / 2);
  currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
  const clampedY = Math.max(wa.y, Math.min(snapY, wa.y + wa.height - size.height));
  miniSnap = { y: clampedY, width: size.width, height: size.height };
  ctx.win.setBounds({ x: currentMiniX, y: clampedY, width: size.width, height: size.height });
}

function handleResize(sizeKey) {
  const size = ctx.SIZES[sizeKey];
  if (!miniMode) return false;
  const { y } = ctx.win.getBounds();
  const wa = ctx.getNearestWorkArea(currentMiniX + size.width / 2, y + size.height / 2);
  currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
  const clampedY = Math.max(wa.y, Math.min(y, wa.y + wa.height - size.height));
  miniSnap = { y: clampedY, width: size.width, height: size.height };
  ctx.win.setBounds({ x: currentMiniX, y: clampedY, width: size.width, height: size.height });
  return true;
}

function restoreFromPrefs(prefs, size) {
  preMiniX = prefs.preMiniX || 0;
  preMiniY = prefs.preMiniY || 0;
  const wa = ctx.getNearestWorkArea(prefs.x + size.width / 2, prefs.y + size.height / 2);
  currentMiniX = wa.x + wa.width - Math.round(size.width * (1 - MINI_OFFSET_RATIO));
  const startY = Math.max(wa.y, Math.min(prefs.y, wa.y + wa.height - size.height));
  miniSnap = { y: startY, width: size.width, height: size.height };
  miniMode = true;
  return { x: currentMiniX, y: startY };
}

function getMiniMode() { return miniMode; }
function getMiniTransitioning() { return miniTransitioning; }
function getMiniSleepPeeked() { return miniSleepPeeked; }
function setMiniSleepPeeked(v) { miniSleepPeeked = v; }
function getIsAnimating() { return isAnimating; }
function getPreMiniX() { return preMiniX; }
function getPreMiniY() { return preMiniY; }
function getCurrentMiniX() { return currentMiniX; }
function getMiniSnap() { return miniSnap; }

function cleanup() {
  if (miniTransitionTimer) { clearTimeout(miniTransitionTimer); miniTransitionTimer = null; }
  if (peekAnimTimer) { clearTimeout(peekAnimTimer); peekAnimTimer = null; }
}

return {
  enterMiniMode, exitMiniMode, enterMiniViaMenu,
  miniPeekIn, miniPeekOut, checkMiniModeSnap, cancelMiniTransition,
  animateWindowX, animateWindowParabola,
  handleDisplayChange, handleResize, restoreFromPrefs,
  getMiniMode, getMiniTransitioning, getMiniSleepPeeked, setMiniSleepPeeked,
  getIsAnimating, getPreMiniX, getPreMiniY, getCurrentMiniX, getMiniSnap,
  MINI_OFFSET_RATIO,
  cleanup,
};

};
