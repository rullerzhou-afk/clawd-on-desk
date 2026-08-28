"use strict";

// src/peteleco.js — Peteleco: aim-and-flick the pet across the desk
//
// Gesture (input decisions live in src/hit-renderer.js, this module owns the
// consequences):
//   pointerdown + modifier  → beginAim()   pet freezes, overlay opens
//   pointermove             → updateAim()  projection follows the cursor
//   pointerup               → releaseAim() pet launches along the projection
//   cancel / blur / etc.    → cancelAim()  nothing moves
//
// Design notes, mirroring roam.js where the two solve the same problem:
//   • The pet does NOT follow the cursor while aiming. hit-renderer suppresses
//     drag-move for the whole gesture, so `aim.bounds` — captured once at
//     beginAim — stays the launch rect and the projection cannot drift.
//   • Movement goes through ctx.applyPetWindowBounds every frame, anchored to
//     the size captured at launch (the #569 ratchet: re-reading live bounds
//     per frame lets mixed-DPI Windows round the pet larger mid-flight).
//   • Every frame re-checks the cancel gates, so entering mini mode or
//     grabbing the pet mid-flight stops it immediately instead of fighting
//     the user for the window position.
//   • isFlicking() is a reconcile protection period, exactly like roam's
//     isRoamAnimating() — pet-window-runtime must not reconcile against its
//     own in-flight writes. Every exit path from the animation therefore
//     releases that protection, including the error exits.
//   • Landing is finalized through ctx.finalizeFlick(), which main.js wires to
//     the same clamp / persist / re-sync work a drag-end does. Mini-mode snap
//     is deliberately NOT part of it: a shot is always clamped to the work
//     area, so it routinely lands exactly on an edge, and snapping there would
//     turn most hard flicks into an accidental mini mode.

const {
  PETELECO_INTENSITY_DEFAULT,
  PETELECO_FRAME_MS,
  clampPetelecoIntensity,
  computeAim,
  petelecoDurationMs,
  petelecoBoundsAt,
} = require("./peteleco-geometry");

function isLiveWindow(win) {
  return !!(win && (typeof win.isDestroyed !== "function" || !win.isDestroyed()));
}

module.exports = function initPeteleco(ctx = {}) {
  const now = typeof ctx.now === "function" ? ctx.now : () => Date.now();
  const schedule =
    typeof ctx.setTimeout === "function" ? ctx.setTimeout : setTimeout;
  const unschedule =
    typeof ctx.clearTimeout === "function" ? ctx.clearTimeout : clearTimeout;

  let enabled = false;
  let intensity = PETELECO_INTENSITY_DEFAULT;

  // Aim state: null when no gesture is in flight.
  let aim = null; // { origin, bounds }
  let lastShot = null; // last computeAim() result, or null while below threshold

  // Flick state.
  let flickActive = false;
  let flickTimer = null;

  function call(name, ...args) {
    const fn = ctx[name];
    if (typeof fn !== "function") return undefined;
    return fn(...args);
  }

  function clearFlickTimer() {
    if (flickTimer === null) return;
    unschedule(flickTimer);
    flickTimer = null;
  }

  // Mirrors roam's notifyRoamProtectionReleased(): every exit from the
  // per-frame write period must hand the runtime its one terminal reconcile
  // pass, or a reconcile marked dirty mid-flight never runs.
  function releaseProtection() {
    call("releaseReconcileProtection");
  }

  function getLaunchSize(bounds) {
    const size = call("getEffectiveCurrentPixelSize");
    const width =
      size && Number.isFinite(size.width) && size.width > 0
        ? size.width
        : bounds.width;
    const height =
      size && Number.isFinite(size.height) && size.height > 0
        ? size.height
        : bounds.height;
    return { width, height };
  }

  // Gates shared by "may a gesture start" and "may the flick continue". Mini
  // mode owns the window position outright, and a mini transition is a
  // competing animation.
  function isPetelecoAllowed() {
    if (!enabled) return false;
    if (call("getMiniMode") === true) return false;
    if (call("isMiniTransitioning") === true) return false;
    return true;
  }

  function hideProjection() {
    call("hideProjection");
  }

  // Release teardown: the line dissolves over the launch instead of popping.
  // Cancelled gestures still use hideProjection() — a projection that outlives
  // a shot nobody fired describes something that is not happening.
  function fadeProjection() {
    if (typeof ctx.fadeProjection === "function") ctx.fadeProjection();
    else call("hideProjection");
  }

  function beginAim() {
    if (!isPetelecoAllowed()) return false;
    // A second gesture supersedes an in-flight shot rather than racing it for
    // the window position.
    cancelFlick();
    const bounds = call("getPetWindowBounds");
    const origin = call("getCursorScreenPoint");
    if (!bounds || !origin) return false;
    const { width, height } = getLaunchSize(bounds);
    aim = {
      origin: { x: origin.x, y: origin.y },
      bounds: { x: bounds.x, y: bounds.y, width, height },
    };
    lastShot = null;
    // Nothing is drawn until the pull passes the threshold — a modifier-click
    // that never moves must look exactly like a plain click.
    hideProjection();
    return true;
  }

  function computeShot() {
    return computeAim({
      origin: aim.origin,
      cursor: call("getCursorScreenPoint"),
      bounds: aim.bounds,
      // Drawn from the AVATAR's middle, not the window's — the sprite is not
      // centered in its rectangle. Resolved per update rather than frozen at
      // beginAim: the pet keeps animating while you aim, and a pose change can
      // move the art inside the (unchanged) launch rect.
      center: call("getPetVisualCenter", aim.bounds),
      intensity,
      // Not pinned to the launch display: the clamp resolves the work area from
      // the TARGET's centre, so a hard shot near a seam carries the pet onto the
      // neighbouring monitor. That crossing is the intended behavior — the
      // projection follows it (see resolveOverlayBounds).
      clampPosition: ctx.clampPosition,
    });
  }

  // Recomputes the shot from the live cursor and pushes it to the overlay.
  // Returns the shot (or null while the pull is below threshold).
  function updateAim() {
    if (!aim) return null;
    if (!isPetelecoAllowed()) {
      cancelAim();
      return null;
    }
    const shot = computeShot();
    lastShot = shot;
    if (!shot) hideProjection();
    else call("showProjection", shot);
    return shot;
  }

  function cancelAim() {
    if (!aim) return false;
    aim = null;
    lastShot = null;
    hideProjection();
    return true;
  }

  // pointerup. Recomputes once from the live cursor so the shot matches where
  // the pointer actually ended, not the last throttled move frame.
  function releaseAim() {
    if (!aim) return false;
    // Deliberately computeShot(), not updateAim(): the overlay is about to be
    // torn down, and repainting it one last time is a wasted round trip that
    // can flash a line the user already released.
    const shot = isPetelecoAllowed() ? computeShot() || lastShot : null;
    const launchBounds = aim.bounds;
    aim = null;
    lastShot = null;
    if (!shot) {
      hideProjection();
      return false;
    }
    const launched = startFlick(launchBounds, shot);
    if (launched) fadeProjection();
    else hideProjection();
    return launched;
  }

  function startFlick(startBounds, shot) {
    if (!isPetelecoAllowed()) return false;
    const win = ctx.win;
    if (!isLiveWindow(win)) return false;
    const target = shot.target;
    const duration = petelecoDurationMs(shot.distance);
    const startTime = now();
    let frameCount = 0;

    // Reuse the theme's drag reaction as the in-flight pose: the pet is being
    // flung, which is exactly what that reaction depicts. No new theme
    // capability is invented, and themes without one simply keep their current
    // visual. Suppressed under Do Not Disturb, matching hit-renderer's own
    // gate on drag reactions.
    const headingLeft = shot.direction.x < 0;
    const reactionStarted = call("isDndEnabled") !== true;
    if (reactionStarted) {
      call("startFlickReaction", headingLeft ? "left" : "right");
    }

    flickActive = true;
    clearFlickTimer();

    function finish(landed) {
      flickActive = false;
      clearFlickTimer();
      releaseProtection();
      // Only close a reaction that was actually opened — under Do Not Disturb
      // none was, and an unpaired end would clear whatever the pet is showing.
      if (reactionStarted) call("endFlickReaction");
      if (landed) call("finalizeFlick");
    }

    function step() {
      flickTimer = null;
      if (!flickActive) return;
      if (!isLiveWindow(ctx.win)) {
        finish(false);
        return;
      }
      // Per-frame gates: mini mode / a mini transition / a fresh grab all take
      // the window position away from the flick.
      if (!isPetelecoAllowed()) {
        finish(false);
        return;
      }
      // The gesture released its own lock before firing (see the
      // peteleco:aim-end handler in src/pet-interaction-ipc.js), so a lock here
      // can only mean a fresh grab — the user catching the pet mid-air.
      if (call("isDragLocked") === true) {
        finish(false);
        return;
      }

      const elapsed = now() - startTime;
      const t = duration > 0 ? Math.min(1, elapsed / duration) : 1;
      const next = petelecoBoundsAt(startBounds, target, t);
      if (!next) {
        finish(false);
        return;
      }

      call("applyPetWindowBounds", next);
      call("syncHitWin");
      call("repositionAnchoredSurfaces");
      // Same 3rd-frame throttle roam and mini use for bubble follow.
      if (
        ctx.bubbleFollowPet
        && Array.isArray(ctx.pendingPermissions)
        && ctx.pendingPermissions.length
        && (++frameCount % 3 === 0 || t >= 1)
      ) {
        call("repositionBubbles");
      }

      if (t < 1) {
        flickTimer = schedule(step, PETELECO_FRAME_MS);
        return;
      }
      finish(true);
    }

    step();
    return true;
  }

  function cancelFlick() {
    if (!flickActive) return false;
    flickActive = false;
    clearFlickTimer();
    releaseProtection();
    call("endFlickReaction");
    return true;
  }

  function setEnabled(value) {
    const next = !!value;
    if (next === enabled) return;
    enabled = next;
    if (!enabled) {
      cancelAim();
      cancelFlick();
    }
  }

  function setIntensity(value) {
    const next = clampPetelecoIntensity(value);
    if (next === intensity) return;
    intensity = next;
    // Live-repaint an open projection so a slider change is visible while the
    // user is still holding the gesture.
    if (aim) updateAim();
  }

  function isEnabled() {
    return enabled;
  }

  function getIntensity() {
    return intensity;
  }

  function isAiming() {
    return !!aim;
  }

  // Reconcile protection predicate (pet-window-runtime) AND roam's "someone
  // else owns the pet right now" gate.
  function isFlicking() {
    return flickActive;
  }

  function isActive() {
    return !!aim || flickActive;
  }

  return {
    setEnabled,
    setIntensity,
    isEnabled,
    getIntensity,
    beginAim,
    updateAim,
    cancelAim,
    releaseAim,
    cancelFlick,
    isAiming,
    isFlicking,
    isActive,
  };
};
