"use strict";

// src/roam.js — Free roam mode: pet wanders around the desk when idle
//
// Design notes (from PR #467 review):
//   • Before moving the window, the visual state switches to "roam" (which
//     falls back to idle SVG for themes without a dedicated roam animation).
//     This prevents the "idle pet dragged across the desktop" regression.
//   • Movement goes through applyPetWindowPosition every frame so virtual bounds,
//     hit window, HUD, and anchored surfaces stay in sync with the pet.
//   • Each animation step re-checks isRoamAllowed() so a state change to working /
//     notification / permission cancels the roam immediately — no "pet drifting while
//     working" regression.
//   • The first roam after entering idle uses ROAM_IDLE_DELAY_MS (8s); subsequent
//     roams use ROAM_BETWEEN_DELAY_MS (4s).
//   • When the state changes away from idle/roam (detected in tick or step),
//     firstRoam is reset so the next idle entry waits the full 8s delay.

const ROAM_IDLE_DELAY_MS = 8000;     // first roam after entering idle
const ROAM_BETWEEN_DELAY_MS = 4000;  // delay between consecutive roams
const ROAM_SPEED_PX_PER_MS = 0.08;   // 80px/s — slower than mini crabwalk (120px/s)
const ROAM_MIN_DIST = 100;
const ROAM_MARGIN_RATIO = 0.15;
const ROAM_FRAME_MS = 16;

module.exports = function initRoam(ctx) {
  let enabled = false;
  let roamActive = false;
  let roamAnimTimer = null;
  let roamPauseTimer = null;
  let firstRoam = true;  // true until the first roam fires after idle entry

  function cleanupTimers() {
    if (roamAnimTimer) { clearTimeout(roamAnimTimer); roamAnimTimer = null; }
    if (roamPauseTimer) { clearTimeout(roamPauseTimer); roamPauseTimer = null; }
  }

  function isRoamAllowed() {
    if (!enabled) return false;
    if (ctx.getMiniMode && ctx.getMiniMode()) return false;
    const state = ctx.getCurrentState ? ctx.getCurrentState() : "idle";
    // Allow roaming when idle (about to start) or already roaming (mid-animation)
    if (state !== "idle" && state !== "roam") return false;
    if (ctx.miniTransitioning) return false;
    return true;
  }

  function pickRandomTarget() {
    const bounds = ctx.getPetWindowBounds();
    if (!bounds) return null;
    const wa = ctx.getNearestWorkArea(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2
    );
    if (!wa) return null;
    const marginX = Math.round(wa.width * ROAM_MARGIN_RATIO);
    const marginY = Math.round(wa.height * ROAM_MARGIN_RATIO);
    const xMin = wa.x + marginX;
    const xMax = wa.x + wa.width - bounds.width - marginX;
    const yMin = wa.y + marginY;
    const yMax = wa.y + wa.height - bounds.height - marginY;
    if (xMax <= xMin || yMax <= yMin) return null;
    const targetX = xMin + Math.floor(Math.random() * (xMax - xMin));
    const targetY = yMin + Math.floor(Math.random() * (yMax - yMin));
    const dx = targetX - bounds.x;
    const dy = targetY - bounds.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < ROAM_MIN_DIST) return null;
    return { x: targetX, y: targetY };
  }

  function animateTo(targetX, targetY) {
    if (roamAnimTimer) { clearTimeout(roamAnimTimer); roamAnimTimer = null; }
    const win = ctx.win;
    if (!win || win.isDestroyed()) { roamActive = false; return; }
    const startBounds = ctx.getPetWindowBounds();
    if (!startBounds) { roamActive = false; return; }
    const startX = startBounds.x;
    const startY = startBounds.y;
    let finalX = targetX;
    let finalY = targetY;
    if (ctx.clampToScreenVisual) {
      const clamped = ctx.clampToScreenVisual(finalX, finalY, startBounds.width, startBounds.height);
      finalX = clamped.x;
      finalY = clamped.y;
    }
    // ── Calculate duration based on distance (speed = 80px/s) ──
    const dx = finalX - startX;
    const dy = finalY - startY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const animDurationMs = Math.max(1000, dist / ROAM_SPEED_PX_PER_MS);

    // ── Switch to "roam" visual state before moving ──
    // This ensures the pet shows a walk animation (if the theme provides one)
    // or at least the idle SVG via fallback, instead of being "dragged" in
    // whatever frozen pose the previous state left it in.
    if (typeof ctx.applyState === "function") {
      ctx.applyState("roam");
    }

    roamActive = true;
    const startTime = Date.now();
    let frameCount = 0;

    function step() {
      // ── Per-frame cancellation checks ──
      if (!roamActive) return;
      if (!win || win.isDestroyed()) { roamActive = false; return; }
      // Re-check state on every frame: if the pet is no longer idle/roam (e.g. a
      // working/notification event arrived), stop the animation immediately.
      if (!isRoamAllowed()) {
        roamActive = false;
        cleanupTimers();
        // State changed away from idle/roam — next idle entry should wait full delay
        firstRoam = true;
        return;
      }

      const elapsed = Date.now() - startTime;
      const t = Math.min(1, elapsed / animDurationMs);
      const eased = t * (2 - t);
      const vx = Math.round(startX + (finalX - startX) * eased);
      const vy = Math.round(startY + (finalY - startY) * eased);
      if (!Number.isFinite(vx) || !Number.isFinite(vy)) { roamActive = false; return; }

      // ── Per-frame sync ──
      ctx.applyPetWindowPosition(vx, vy);
      if (typeof ctx.syncHitWin === "function") ctx.syncHitWin();
      if (typeof ctx.repositionAnchoredSurfaces === "function") ctx.repositionAnchoredSurfaces();
      // Throttle bubble reposition to every 3rd frame (~20fps) — same as mini.js
      if (typeof ctx.repositionBubbles === "function" && ctx.bubbleFollowPet && ctx.pendingPermissions.length && (++frameCount % 3 === 0 || t >= 1)) {
        ctx.repositionBubbles();
      }

      if (t < 1 && roamActive) {
        roamAnimTimer = setTimeout(step, ROAM_FRAME_MS);
      } else {
        roamActive = false;
        // ── Return to idle via setState (respects priority) ──
        // If a higher-priority state was set while the last frame was in
        // flight, setState("idle") won't downgrade it.
        if (typeof ctx.setState === "function") {
          ctx.setState("idle");
        }
        scheduleNextRoam();
      }
    }
    step();
  }

  function scheduleNextRoam() {
    if (roamPauseTimer) { clearTimeout(roamPauseTimer); roamPauseTimer = null; }
    if (!enabled) return;
    const delay = firstRoam ? ROAM_IDLE_DELAY_MS : ROAM_BETWEEN_DELAY_MS;
    firstRoam = false;
    roamPauseTimer = setTimeout(() => {
      roamPauseTimer = null;
      if (!isRoamAllowed()) return;
      const target = pickRandomTarget();
      if (!target) { scheduleNextRoam(); return; }
      animateTo(target.x, target.y);
    }, delay);
  }

  function setEnabled(value) {
    const next = !!value;
    if (next === enabled) return;
    enabled = next;
    if (!enabled) {
      cancelRoam();
    } else {
      // Fresh enable — first roam should wait the full idle delay
      firstRoam = true;
    }
  }

  function cancelRoam() {
    const shouldRestoreIdle = roamActive
      && typeof ctx.getCurrentState === "function"
      && ctx.getCurrentState() === "roam"
      && typeof ctx.setState === "function";
    cleanupTimers();
    roamActive = false;
    if (shouldRestoreIdle) ctx.setState("idle");
  }

  function tick() {
    if (!enabled) return;
    if (!isRoamAllowed()) {
      // State changed away from idle/roam — next idle entry should wait full delay
      firstRoam = true;
      cancelRoam();
      return;
    }
    if (roamActive) return;
    if (roamPauseTimer) return;
    scheduleNextRoam();
  }

  return { setEnabled, cancelRoam, tick, get enabled() { return enabled; } };
};
