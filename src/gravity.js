"use strict";

// src/gravity.js — a drag released in mid-air makes the pet fall to the floor
// instead of hanging there. Off unless the `gravity` pref is on (Settings →
// Pet → Movement & position).
//
// Same frame loop as roam.js: applyPetWindowBounds every 16 ms with the size
// frozen at the start (#569), hit window and anchored surfaces synced per frame.
//
// The floor is the display's lowest resting spot, from the rest clamp the pet
// already obeys.

const GRAVITY_PX_PER_S2 = 2800;
const MAX_FALL_SPEED_PX_PER_S = 2400;
const FRAME_MS = 16;
// A late frame advances the fall by at most this much.
const MAX_FRAME_MS = 32;
const MIN_DROP_PX = 2;
// Landing squash intensity (0..1) follows the impact speed: no squash up to a
// ~40 px drop, full squash from ~500 px (v = sqrt(2 * g * h)).
const SQUASH_MIN_SPEED = Math.sqrt(2 * GRAVITY_PX_PER_S2 * 40);
const SQUASH_FULL_SPEED = Math.sqrt(2 * GRAVITY_PX_PER_S2 * 500);

function landingIntensity(speed) {
  const k = (speed - SQUASH_MIN_SPEED) / (SQUASH_FULL_SPEED - SQUASH_MIN_SPEED);
  return Math.round(Math.min(1, Math.max(0, k)) * 100) / 100;
}

// One fall step: gravity up to the maximum fall speed, exact over the frame
// (accelerating, then steady), so the impact speed matches the drop height.
function advanceFall(motion, elapsedMs) {
  const duration = Math.max(0, elapsedMs) / 1000;
  const accelerating = Math.min(
    duration,
    Math.max(0, (MAX_FALL_SPEED_PX_PER_S - motion.vy) / GRAVITY_PX_PER_S2),
  );
  const vy = Math.min(motion.vy + GRAVITY_PX_PER_S2 * accelerating, MAX_FALL_SPEED_PX_PER_S);
  const y = motion.y
    + ((motion.vy + vy) / 2) * accelerating
    + MAX_FALL_SPEED_PX_PER_S * (duration - accelerating);
  return { y, vy };
}

module.exports = function initGravity(ctx, options = {}) {
  const now = options.now || (() => performance.now());
  // Starts from the `gravity` pref; main.js passes later changes to setEnabled.
  let enabled = options.enabled === true;
  let falling = false;
  let fallTimer = null;
  let onFallEnd = null;
  let defaultFallEnd = null;
  // The current press (drag-lock) caught the pet while it was falling.
  let caughtMidAir = false;

  function isWindowAlive() {
    return !!(ctx.win && !ctx.win.isDestroyed());
  }

  function isMiniBusy() {
    return !!((ctx.getMiniMode && ctx.getMiniMode()) || ctx.miniTransitioning);
  }

  function frozenSize(bounds) {
    const size = typeof ctx.getEffectiveCurrentPixelSize === "function"
      ? ctx.getEffectiveCurrentPixelSize()
      : null;
    return {
      width: size && Number.isFinite(size.width) && size.width > 0 ? size.width : bounds.width,
      height: size && Number.isFinite(size.height) && size.height > 0 ? size.height : bounds.height,
    };
  }

  // Floor of the display where the pet is: where a drag to the bottom would
  // rest, from the rest clamp it already obeys, edge pinning included.
  function resolveArea(bounds) {
    const { width, height } = frozenSize(bounds);
    const cx = bounds.x + width / 2;
    const cy = bounds.y + height / 2;
    const wa = ctx.getNearestWorkArea(cx, cy);
    if (!wa) return null;
    const lowest = ctx.clampToScreenVisual(bounds.x, wa.y + wa.height, width, height, { workArea: wa });
    if (!lowest || !Number.isFinite(lowest.y)) return null;
    return { width, height, floorY: Math.round(lowest.y) };
  }

  function finish(landed, landing) {
    if (fallTimer) {
      clearTimeout(fallTimer);
      fallTimer = null;
    }
    if (!falling) return;
    falling = false;
    // Same release point as roam: a reconcile marked dirty mid-fall runs now.
    if (typeof ctx.releaseReconcileProtection === "function") ctx.releaseReconcileProtection();
    const callback = onFallEnd;
    onFallEnd = null;
    if (typeof callback === "function") callback(landed, landing || null);
  }

  // Drops the pet onto the floor below it. Returns true when it left the
  // ground. onEnd(landed, landing) runs once at the end (defaults to the
  // setFallEndHandler one); landed is false (landing null) when the pet was
  // caught mid-air or the fall was interrupted, otherwise landing = { intensity }.
  function startFall(onEnd) {
    if (!enabled || !isWindowAlive() || isMiniBusy()) return false;
    // A new placement (Send to Display, Bring to Primary, a drag-end) takes
    // over a running fall: the old one ends here, so its next frame cannot
    // put the pet back on the old path.
    if (falling) finish(false);
    const start = ctx.getPetWindowBounds();
    if (!start) return false;
    const area = resolveArea(start);
    if (!area) return false;
    const { width, height, floorY } = area;
    if (floorY - start.y < MIN_DROP_PX) return false;

    falling = true;
    onFallEnd = onEnd || defaultFallEnd;
    let motion = { y: start.y, vy: 0 };
    let lastTick = now();
    let frameCount = 0;

    function place(x, y, final) {
      ctx.applyPetWindowBounds({ x: Math.round(x), y: Math.round(y), width, height });
      if (typeof ctx.syncHitWin === "function") ctx.syncHitWin();
      if (typeof ctx.repositionAnchoredSurfaces === "function") ctx.repositionAnchoredSurfaces();
      if (
        typeof ctx.repositionBubbles === "function"
        && ctx.bubbleFollowPet
        && ctx.pendingPermissions
        && ctx.pendingPermissions.length
        && (++frameCount % 3 === 0 || final)
      ) {
        ctx.repositionBubbles();
      }
    }

    function step() {
      fallTimer = null;
      if (!falling) return;
      // Caught mid-air (the new drag owns the window), mini mode or shutdown.
      if (!isWindowAlive() || ctx.dragLocked || isMiniBusy()) {
        finish(false);
        return;
      }
      const t = now();
      const elapsed = Math.min(MAX_FRAME_MS, Math.max(0, t - lastTick));
      lastTick = t;
      const previousY = motion.y;
      const next = advanceFall(motion, elapsed);
      if (next.y >= floorY) {
        // Speed when touching down (v² = v0² + 2gh), not at the end of the
        // frame, which already overshot the floor by up to 32 ms.
        const impact = Math.min(
          MAX_FALL_SPEED_PX_PER_S,
          Math.sqrt(Math.max(0, motion.vy * motion.vy + 2 * GRAVITY_PX_PER_S2 * (floorY - previousY))),
        );
        place(start.x, floorY, true);
        finish(true, { intensity: landingIntensity(impact) });
        return;
      }
      motion = next;
      place(start.x, motion.y, false);
      fallTimer = setTimeout(step, FRAME_MS);
    }

    // Deferred first frame: drag-end may still hold the drag lock until its finally block.
    fallTimer = setTimeout(step, FRAME_MS);
    return true;
  }

  // A new drag catches a falling pet at once, so the held end of the old drag
  // reaction goes out before the new drag starts its own.
  function beginDrag() {
    caughtMidAir = falling;
    cancel();
  }

  // The press is over (drag-lock released). A pet caught mid-air by a click
  // gets no drag-end, so it falls again from where it is; after a real drag
  // the drag-end fall takes over this one.
  function endPress() {
    if (!caughtMidAir) return false;
    caughtMidAir = false;
    return startFall();
  }

  // End of a drag: the pet drops onto the floor below it.
  function release(onEnd) {
    return startFall(onEnd);
  }

  // Off: stops a fall where it is. On: a pet left in mid-air drops right away.
  function setEnabled(value) {
    const next = !!value;
    if (next === enabled) return;
    enabled = next;
    if (enabled) startFall();
    else cancel();
  }

  function isEnabled() {
    return enabled;
  }

  function setFallEndHandler(handler) {
    defaultFallEnd = typeof handler === "function" ? handler : null;
  }

  function cancel() {
    finish(false);
  }

  function isFalling() {
    return falling;
  }

  return {
    startFall,
    release,
    beginDrag,
    endPress,
    cancel,
    isFalling,
    setEnabled,
    isEnabled,
    setFallEndHandler,
  };
};
