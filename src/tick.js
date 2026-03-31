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

const MOUSE_IDLE_TIMEOUT = 20000;   // 20s → idle-look
const MOUSE_SLEEP_TIMEOUT = 60000;  // 60s → yawning → dozing
const SVG_IDLE_FOLLOW = "clawd-idle-follow.svg";
const SVG_IDLE_LOOK = "clawd-idle-look.svg";

// Random idle animations: picked when mouse is still for 20s
const IDLE_ANIMS = [
  { svg: SVG_IDLE_LOOK, duration: 6500 },
  { svg: "clawd-working-debugger.svg", duration: 14000 },
  { svg: "clawd-idle-reading.svg", duration: 14000 },
];

// ── Unified main tick (cursor polling for eye tracking + sleep + mini peek) ──
// Input routing is handled by hitWin — no setIgnoreMouseEvents toggling here.
function startMainTick() {
  if (mainTickTimer) return;
  // Render window: permanently click-through (set once, never toggle)
  ctx.win.setIgnoreMouseEvents(true);
  ctx.mouseOverPet = false;

  mainTickTimer = setInterval(() => {
    if (!ctx.win || ctx.win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();

    // ── Cursor-over-pet tracking (for mini peek + eye tracking, NOT for input routing) ──
    const bounds = ctx.win.getBounds();
    if (!ctx.dragLocked) {
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
        } else if (ctx.mouseOverPet && ctx.currentState !== "mini-peek" && ctx.currentState !== "mini-sleep") {
          ctx.miniPeekIn();
          ctx.applyState("mini-peek");
        } else if (!ctx.mouseOverPet && ctx.currentState === "mini-peek") {
          ctx.miniPeekOut();
          ctx.applyState("mini-idle");
        }
      }
    }

    // ── Eye tracking + sleep detection (idle only, not during reactions) ──
    const idleNow = ctx.currentState === "idle" && !ctx.idlePaused;
    const miniIdleNow = ctx.currentState === "mini-idle" && !ctx.idlePaused && !ctx.miniTransitioning;

    // Edge detection: idle entry → reset state variables
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

    // Edge detection: idle exit → clear pending timers
    // (variable resets not needed here — idle entry will overwrite them all)
    if (!idleNow && idleWasActive) {
      if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
      if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
    }
    idleWasActive = idleNow;

    if (!idleNow && !miniIdleNow) return;

    // ── Below: idle or mini-idle logic ──
    const moved = lastCursorX !== null && (cursor.x !== lastCursorX || cursor.y !== lastCursorY);
    lastCursorX = cursor.x;
    lastCursorY = cursor.y;

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
        yawnDelayTimer = setTimeout(() => {
          yawnDelayTimer = null;
          if (ctx.currentState === "idle") ctx.setState("yawning");
        }, isMouseIdle ? 50 : 250);
        return;
      }

      // 20s no mouse movement → random idle animation (play once, then return to idle-follow)
      if (!isMouseIdle && !hasTriggeredYawn && !idleLookPlayed && elapsed >= MOUSE_IDLE_TIMEOUT) {
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
        return;
      }
    }

    const trackEyesNow = (idleNow && ctx.currentSvg === SVG_IDLE_FOLLOW && !isMouseIdle) || miniIdleNow;
    if (!trackEyesNow) return;
    if (ctx.eyePauseUntil) {
      if (Date.now() < ctx.eyePauseUntil) return;
      ctx.eyePauseUntil = null;
    }
    if (!moved && !ctx.forceEyeResend) return;

    // ── Eye position calculation (shared by idle and mini-idle) ──
    const skipDedup = ctx.forceEyeResend;
    ctx.forceEyeResend = false;

    const obj = ctx.getObjRect(bounds);
    const eyeScreenX = obj.x + obj.w * (22 / 45);
    const eyeScreenY = obj.y + obj.h * (34 / 45);

    const relX = cursor.x - eyeScreenX;
    const relY = cursor.y - eyeScreenY;

    const MAX_OFFSET = 3;
    const dist = Math.sqrt(relX * relX + relY * relY);
    let eyeDx = 0, eyeDy = 0;
    if (dist > 1) {
      const scale = Math.min(1, dist / 300);
      eyeDx = (relX / dist) * MAX_OFFSET * scale;
      eyeDy = (relY / dist) * MAX_OFFSET * scale;
    }

    eyeDx = Math.round(eyeDx * 2) / 2;
    eyeDy = Math.round(eyeDy * 2) / 2;
    eyeDy = Math.max(-1.5, Math.min(1.5, eyeDy));

    if (skipDedup || eyeDx !== lastEyeDx || eyeDy !== lastEyeDy) {
      lastEyeDx = eyeDx;
      lastEyeDy = eyeDy;
      ctx.sendToRenderer("eye-move", eyeDx, eyeDy);
    }
  }, 50); // ~20fps — hit-test needs faster response than 67ms eye tracking
}

function resetIdleTimer() {
  mouseStillSince = Date.now();
}

function cleanup() {
  if (mainTickTimer) { clearInterval(mainTickTimer); mainTickTimer = null; }
  if (idleLookReturnTimer) { clearTimeout(idleLookReturnTimer); idleLookReturnTimer = null; }
  if (yawnDelayTimer) { clearTimeout(yawnDelayTimer); yawnDelayTimer = null; }
}

// Expose mouseStillSince for wake poll (state.js deep sleep timeout)
Object.defineProperty(startMainTick, '_mouseStillSince', {
  get() { return mouseStillSince; },
});

return { startMainTick, resetIdleTimer, cleanup, get _mouseStillSince() { return mouseStillSince; } };

};
