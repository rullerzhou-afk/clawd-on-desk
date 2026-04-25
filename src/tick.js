// src/tick.js — Main tick loop (cursor polling, eye tracking, idle/sleep detection, mini peek)
// Extracted from main.js L527-689

const { screen } = require("electron");

module.exports = function initTick(ctx) {

// ── Mouse idle tracking ──
let lastCursorX = null, lastCursorY = null;
let mouseStillSince = Date.now();
let isMouseIdle = false;       // showing idle-look
let hasTriggeredYawn = false;  // 60s threshold already fired
let idleLookPlayed = false;    // idle-look already played once since last movement
let idleLookReturnTimer = null;
let yawnDelayTimer = null;     // tracked setTimeout for yawn/idle-look transitions
let idleWasActive = false;
let lastEyeDx = 0, lastEyeDy = 0;
let mainTickTimer = null;
let mainTickActive = false;
let nextMainTickAt = 0;

const FAST_TICK_MS = 50;
const BOOST_TICK_MS = 100;
const IDLE_TICK_MS = 250;
const REACTION_TICK_MS = 500;
const BACKGROUND_TICK_MS = 750;
const RECENT_MOUSE_MS = 2000;

// ── Theme-driven state (refreshed on hot theme switch) ──
let theme = null;
let MOUSE_IDLE_TIMEOUT = 0;
let MOUSE_SLEEP_TIMEOUT = 0;
let SVG_IDLE_FOLLOW = null;
let IDLE_ANIMS = [];
let SLEEP_MODE = "full";

function refreshTheme() {
  theme = ctx.theme;
  MOUSE_IDLE_TIMEOUT = theme.timings.mouseIdleTimeout;
  MOUSE_SLEEP_TIMEOUT = theme.timings.mouseSleepTimeout;
  SVG_IDLE_FOLLOW = theme.states.idle[0];
  IDLE_ANIMS = (theme.idleAnimations || []).map(a => ({ svg: a.file, duration: a.duration }));
  SLEEP_MODE = theme.sleepSequence && theme.sleepSequence.mode === "direct" ? "direct" : "full";
}

refreshTheme();

// ── Unified main tick (cursor polling for eye tracking + sleep + mini peek) ──
// Input routing is handled by hitWin — no setIgnoreMouseEvents toggling here.
function startMainTick() {
  if (mainTickActive) return;
  // Render window: permanently click-through (set once, never toggle)
  ctx.win.setIgnoreMouseEvents(true);
  ctx.mouseOverPet = false;

  mainTickActive = true;
  scheduleNextTick(0);
}

function getBaseTickDelay(idleNow, miniIdleNow) {
  if (ctx.miniMode || miniIdleNow || ctx.dragLocked) return FAST_TICK_MS;
  if (idleNow) {
    if (Date.now() - mouseStillSince <= RECENT_MOUSE_MS) return BOOST_TICK_MS;
    return IDLE_TICK_MS;
  }
  if (ctx.idlePaused) return REACTION_TICK_MS;
  return BACKGROUND_TICK_MS;
}

function applyBoost(delay) {
  const boostUntil = Number(ctx.forceEyeResendBoostUntil) || 0;
  if (boostUntil > Date.now()) return Math.min(delay, BOOST_TICK_MS);
  return delay;
}

function getNextTickDelay(idleNow, miniIdleNow) {
  return applyBoost(getBaseTickDelay(idleNow, miniIdleNow));
}

function scheduleNextTick(delay) {
  if (!mainTickActive) return;
  if (mainTickTimer) clearTimeout(mainTickTimer);
  const safeDelay = Math.max(0, Number.isFinite(delay) ? delay : BACKGROUND_TICK_MS);
  nextMainTickAt = Date.now() + safeDelay;
  mainTickTimer = setTimeout(runMainTick, safeDelay);
}

function scheduleSoon(maxDelay = BOOST_TICK_MS) {
  if (!mainTickActive) return;
  const safeDelay = Math.max(0, Number.isFinite(maxDelay) ? maxDelay : BOOST_TICK_MS);
  if (!mainTickTimer || nextMainTickAt - Date.now() > safeDelay) {
    scheduleNextTick(safeDelay);
  }
}

function runMainTick() {
  mainTickTimer = null;
  nextMainTickAt = 0;
  const delay = runMainTickOnce();
  if (mainTickActive && !mainTickTimer) scheduleNextTick(delay);
}

function runMainTickOnce() {
    if (!ctx.win || ctx.win.isDestroyed()) return BACKGROUND_TICK_MS;

    // ── Idle state edge detection (must run every tick for timer cleanup) ──
    const idleNow = ctx.currentState === "idle" && !ctx.idlePaused;
    const miniIdleNow = ctx.currentState === "mini-idle" && !ctx.idlePaused && !ctx.miniTransitioning;
    const nextDelay = () => getNextTickDelay(idleNow, miniIdleNow);

    if (idleNow && !idleWasActive) {
      isMouseIdle = false;
      hasTriggeredYawn = false;
      idleLookPlayed = false;
      lastCursorX = null;
      lastCursorY = null;
      mouseStillSince = Date.now();
      lastEyeDx = 0;
      lastEyeDy = 0;
      if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
      if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
    }

    if (!idleNow && idleWasActive) {
      if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
      if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
    }
    idleWasActive = idleNow;

    // Skip expensive native IPC calls (getCursorScreenPoint, getBounds) when
    // cursor tracking is not needed — saves ~20 calls/sec to the OS layer.
    const needsCursorPoll = idleNow || miniIdleNow || ctx.miniMode;
    if (!needsCursorPoll) return nextDelay();

    const cursor = screen.getCursorScreenPoint();
    const moved = lastCursorX !== null && (cursor.x !== lastCursorX || cursor.y !== lastCursorY);
    lastCursorX = cursor.x;
    lastCursorY = cursor.y;

    // ── Cursor-over-pet tracking (for mini peek + eye tracking, NOT for input routing) ──
    const needsBounds = ctx.miniMode || moved || ctx.forceEyeResend || miniIdleNow;
    let bounds = null;
    if (needsBounds) {
      bounds = typeof ctx.getPetWindowBounds === "function"
        ? ctx.getPetWindowBounds()
        : ctx.win.getBounds();
    }
    if (bounds && !ctx.dragLocked) {
      const hit = ctx.getHitRectScreen(bounds);
      const over = cursor.x >= hit.left && cursor.x <= hit.right
                && cursor.y >= hit.top  && cursor.y <= hit.bottom;
      ctx.mouseOverPet = over;
    }

    // ── Mini mode peek hover ──
    if (ctx.miniMode && !ctx.miniTransitioning && !ctx.dragLocked && !ctx.menuOpen) {
      const canPeek = ctx.currentState === "mini-idle" || ctx.currentState === "mini-peek"
        || ctx.currentState === "mini-sleep";
      if (!ctx.isAnimating && canPeek) {
        if (ctx.mouseOverPet && ctx.currentState === "mini-sleep" && !ctx.miniSleepPeeked) {
          ctx.miniPeekIn();
          ctx.miniSleepPeeked = true;
        } else if (!ctx.mouseOverPet && ctx.currentState === "mini-sleep" && ctx.miniSleepPeeked) {
          ctx.miniPeekOut();
          ctx.miniSleepPeeked = false;
        } else if (ctx.mouseOverPet && ctx.currentState !== "mini-peek" && ctx.currentState !== "mini-sleep" && !ctx.miniPeeked) {
          ctx.miniPeekIn();
          ctx.applyState("mini-peek");
        } else if (!ctx.mouseOverPet && (ctx.currentState === "mini-peek" || ctx.miniPeeked)) {
          ctx.miniPeekOut();
          ctx.miniPeeked = false;
          if (ctx.currentState !== "mini-idle") ctx.applyState("mini-idle");
        }
      }
    }

    if (!idleNow && !miniIdleNow) return nextDelay();

    // ── Below: idle or mini-idle logic ──
    // Normal idle: mouse idle detection + sleep sequence
    if (idleNow) {
      if (moved) {
        mouseStillSince = Date.now();
        hasTriggeredYawn = false;
        idleLookPlayed = false;
        if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
        if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
        if (isMouseIdle) {
          isMouseIdle = false;
          ctx.sendToRenderer("state-change", "idle", SVG_IDLE_FOLLOW);
        }
      }

      const elapsed = Date.now() - mouseStillSince;

      // Startup recovery: Claude Code is running but no hook yet — stay awake
      // Only suppress sleep sequence, don't skip eye tracking below
      if (ctx.startupRecoveryActive) {
        mouseStillSince = Date.now();
      }

      // 60s no mouse movement → yawning → dozing
      if (!hasTriggeredYawn && elapsed >= MOUSE_SLEEP_TIMEOUT) {
        hasTriggeredYawn = true;
        if (!isMouseIdle) ctx.sendToRenderer("eye-move", 0, 0);
        if (SLEEP_MODE === "direct") {
          if (ctx.currentState === "idle") ctx.setState("sleeping");
        } else {
          yawnDelayTimer = setTimeout(() => {
            yawnDelayTimer = null;
            if (ctx.currentState === "idle") ctx.setState("yawning");
          }, isMouseIdle ? 50 : 250);
        }
        return nextDelay();
      }

      // 20s no mouse movement → random idle animation (play once, then return to idle-follow)
      if (IDLE_ANIMS.length > 0 && !isMouseIdle && !hasTriggeredYawn && !idleLookPlayed && elapsed >= MOUSE_IDLE_TIMEOUT) {
        isMouseIdle = true;
        idleLookPlayed = true;
        const pick = IDLE_ANIMS[Math.floor(Math.random() * IDLE_ANIMS.length)];
        ctx.sendToRenderer("eye-move", 0, 0);
        setTimeout(() => {
          if (isMouseIdle && ctx.currentState === "idle") {
            ctx.sendToRenderer("state-change", "idle", pick.svg);
            ctx.sendToHitWin("hit-state-sync", { currentSvg: pick.svg });
          }
        }, 250);
        idleLookReturnTimer = setTimeout(() => {
          idleLookReturnTimer = null;
          if (isMouseIdle && ctx.currentState === "idle") {
            isMouseIdle = false;
            ctx.sendToRenderer("state-change", "idle", SVG_IDLE_FOLLOW);
            ctx.sendToHitWin("hit-state-sync", { currentSvg: SVG_IDLE_FOLLOW });
            setTimeout(() => { ctx.forceEyeResend = true; }, 200);
          }
        }, 250 + pick.duration);
        return nextDelay();
      }
    }

    const trackEyesNow = (idleNow && ctx.currentSvg === SVG_IDLE_FOLLOW && !isMouseIdle) || miniIdleNow;
    if (!trackEyesNow) return nextDelay();
    if (ctx.eyePauseUntil) {
      if (Date.now() < ctx.eyePauseUntil) return nextDelay();
      ctx.eyePauseUntil = null;
    }
    if (!moved && !ctx.forceEyeResend) return nextDelay();

    // ── Eye position calculation (shared by idle and mini-idle) ──
    const skipDedup = ctx.forceEyeResend;
    ctx.forceEyeResend = false;

    if (!bounds) {
      bounds = typeof ctx.getPetWindowBounds === "function"
        ? ctx.getPetWindowBounds()
        : ctx.win.getBounds();
    }

    const obj = ctx.getObjRect(bounds);
    const eyeScreenX = obj.x + obj.w * theme.eyeTracking.eyeRatioX;
    const eyeScreenY = obj.y + obj.h * theme.eyeTracking.eyeRatioY;

    const relX = cursor.x - eyeScreenX;
    const relY = cursor.y - eyeScreenY;

    const MAX_OFFSET = theme.eyeTracking.maxOffset;
    const dist = Math.sqrt(relX * relX + relY * relY);
    let eyeDx = 0, eyeDy = 0;
    if (dist > 1) {
      const scale = Math.min(1, dist / 300);
      eyeDx = (relX / dist) * MAX_OFFSET * scale;
      eyeDy = (relY / dist) * MAX_OFFSET * scale;
    }

    eyeDx = Math.round(eyeDx * 2) / 2;
    eyeDy = Math.round(eyeDy * 2) / 2;
    const yClamp = MAX_OFFSET * 0.5;
    eyeDy = Math.max(-yClamp, Math.min(yClamp, eyeDy));

    if (skipDedup || eyeDx !== lastEyeDx || eyeDy !== lastEyeDy) {
      lastEyeDx = eyeDx;
      lastEyeDy = eyeDy;
      ctx.sendToRenderer("eye-move", eyeDx, eyeDy);
    }

    return nextDelay();
}

function resetIdleTimer() {
  mouseStillSince = Date.now();
}

function cleanup() {
  mainTickActive = false;
  if (mainTickTimer) { clearTimeout(mainTickTimer); mainTickTimer = null; }
  nextMainTickAt = 0;
  if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
  if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
  lastCursorX = null;
  lastCursorY = null;
  isMouseIdle = false;
  hasTriggeredYawn = false;
  idleLookPlayed = false;
  idleWasActive = false;
  lastEyeDx = 0;
  lastEyeDy = 0;
}

// Expose mouseStillSince for wake poll (state.js deep sleep timeout)
Object.defineProperty(startMainTick, '_mouseStillSince', {
  get() { return mouseStillSince; },
});

return { startMainTick, resetIdleTimer, cleanup, refreshTheme, scheduleSoon, get _mouseStillSince() { return mouseStillSince; } };

};
