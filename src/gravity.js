"use strict";

// src/gravity.js — a drag released in mid-air makes the pet fall to the floor
// instead of hanging there; a fast release throws it spinning, and it bumps
// off the screen sides and top before landing. Off unless the `gravity` pref
// is on (Settings → Pet → Movement & position).
//
// Same frame loop as roam.js: applyPetWindowBounds every 16 ms with the size
// frozen at the start (#569), hit window and anchored surfaces synced per frame.
//
// The floor is the display's lowest resting spot, and the walls and top of a
// throw its outermost ones, all from the rest clamp the pet already obeys.
//
// advanceThrow, the wall pose and the release rules of measureReleaseVelocity
// are adapted from VS Code's chat pet (src/vs/workbench/contrib/chat/browser/widget/
// chatPetWidget.ts @ 968fb17), Copyright (c) 2015 - present Microsoft
// Corporation, MIT License (text at the end of this file). Gravity, the peak
// measurement, the throw response curve and the one-turn spin are Clawd's own.

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

// Throw values from VS Code's chat pet.
const THROW_RELEASE_GRACE_MS = 80;
const THROW_MIN_VELOCITY = 650;
const THROW_MAX_DURATION_MS = 4000;
const THROW_WALL_RESTITUTION = 0.2;
const THROW_CEILING_RESTITUTION = 0.2;
const WALL_IMPACT_MS = 48;
const THROW_SELF_RIGHTING_SPEED = 720;
// VS Code rolls 0.65° per sideways pixel, about one turn in its panel but two
// to four across a whole screen. Here every throw makes exactly one turn, and
// its pace follows the angle, as VS Code's spin follows the sideways speed:
// straight up (or down) takes 1.1 s, 45° ~0.75 s, sideways 0.6 s. A shorter
// flight shortens it so that 90% of it (all but the last ~4°) is done by the
// landing; a turn under 450 ms would be too fast, so that flight gets none.
const SPIN_UPRIGHT_TURN_MS = 1100;
const SPIN_SIDEWAYS_TURN_MS = 600;
const SPIN_MIN_TURN_MS = 450;
const SPIN_DONE_AT_LANDING = 0.9;
// Safety stop: whatever happens in the air, the pet ends on the floor.
const HARD_STOP_MS = 2 * THROW_MAX_DURATION_MS;
// Clawd's throw tuning. VS Code averages the last 100 ms and caps at
// 2400 px/s, which felt weak on a whole screen: here the fastest ~30 ms of
// the last 120 ms counts (a flick that slows right before the release keeps
// its force). Measured flicks go from ~700 to over 8000 px/s, so a soft cap
// (tanh) follows the hand up to ~1500 px/s and squeezes faster ones below 3200.
const THROW_PEAK_WINDOW_MS = 120;
const THROW_PEAK_SPAN_MS = 30;
const THROW_SOFT_MAX_VELOCITY = 3200;
const DRAG_SAMPLE_LIMIT = 16;

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

// Cursor velocity at the release, from the drag samples ({ x, y, t }): the
// fastest span of at least ~30 ms in the last 120 ms. null when the cursor
// rested for more than 80 ms before the release (VS Code's rule).
function measureReleaseVelocity(samples, releaseTime) {
  if (samples.length < 2) return null;
  const latest = samples[samples.length - 1];
  if (releaseTime - latest.t > THROW_RELEASE_GRACE_MS) return null;
  let best = null;
  for (let i = samples.length - 1; i > 0; i -= 1) {
    const end = samples[i];
    if (latest.t - end.t > THROW_PEAK_WINDOW_MS) break;
    let j = i - 1;
    while (j > 0 && end.t - samples[j].t < THROW_PEAK_SPAN_MS) j -= 1;
    const begin = samples[j];
    const elapsed = Math.max(16, end.t - begin.t);
    const x = ((end.x - begin.x) / elapsed) * 1000;
    const y = ((end.y - begin.y) / elapsed) * 1000;
    const speed = Math.hypot(x, y);
    if (!best || speed > best.speed) best = { x, y, speed };
  }
  return best;
}

// The throw: under 650 px/s there is none (VS Code's threshold); above it the
// speed goes through the soft cap, in the direction of the gesture.
function getThrowVelocity(samples, releaseTime) {
  const measured = measureReleaseVelocity(samples, releaseTime);
  if (!measured || measured.speed < THROW_MIN_VELOCITY) return null;
  const speed = THROW_SOFT_MAX_VELOCITY * Math.tanh(measured.speed / THROW_SOFT_MAX_VELOCITY);
  const scale = speed / measured.speed;
  return { x: measured.x * scale, y: measured.y * scale };
}

// One flight step: constant horizontal speed, the vertical one as in
// advanceFall. A side wall ends the step at the wall and reports it; the top
// reflects the vertical speed at 20%.
function advanceThrow(motion, elapsedMs, walls) {
  const hasRange = walls.maxX > walls.minX;
  const startX = Math.max(walls.minX, Math.min(Math.max(walls.minX, walls.maxX), motion.x));
  const projectedX = startX + (motion.vx * Math.max(0, elapsedMs)) / 1000;
  let wall = null;
  let motionMs = Math.max(0, elapsedMs);
  let x = hasRange ? projectedX : walls.minX;
  if (hasRange && projectedX < walls.minX) {
    wall = "left";
    motionMs *= (walls.minX - startX) / (projectedX - startX);
    x = walls.minX;
  } else if (hasRange && projectedX > walls.maxX) {
    wall = "right";
    motionMs *= (walls.maxX - startX) / (projectedX - startX);
    x = walls.maxX;
  }
  let { y, vy } = advanceFall(motion, motionMs);
  if (y < walls.minY) {
    y = walls.minY;
    vy = Math.abs(vy) * THROW_CEILING_RESTITUTION;
  }
  return { x, y, vx: hasRange ? motion.vx : 0, vy, wall };
}

// How long the turn takes for a throw in this direction: the more sideways
// (sine of the angle to the vertical), the faster. Strength doesn't count.
function getSpinTurnMs(velocity) {
  const speed = Math.hypot(velocity.x, velocity.y);
  const sideways = speed > 0 ? Math.abs(velocity.x) / speed : 0;
  return SPIN_UPRIGHT_TURN_MS - (SPIN_UPRIGHT_TURN_MS - SPIN_SIDEWAYS_TURN_MS) * sideways;
}

// The one turn, in degrees, at progress 0..1: fastest at the release (1.6x
// the average speed) and slowing down into upright (ease-out sine).
// direction is +1 (clockwise) or -1.
function getSpinRotation(direction, progress) {
  const p = Math.min(1, Math.max(0, progress));
  return direction * 360 * Math.sin((p * Math.PI) / 2);
}

// The cursor, not the pet window: near a screen edge the drag clamp stops the
// window while the hand keeps moving.
function electronCursorPoint() {
  try {
    return require("electron").screen.getCursorScreenPoint();
  } catch {
    return null;
  }
}

module.exports = function initGravity(ctx, options = {}) {
  const now = options.now || (() => performance.now());
  const getCursorPoint = options.getCursorPoint || electronCursorPoint;
  // Spin in degrees to the pet window, which rotates the drawing.
  const setRotation = options.setRotation || (() => {});
  // Starts from the `gravity` pref; main.js passes later changes to setEnabled.
  let enabled = options.enabled === true;
  let falling = false;
  let suspended = false;
  let fallTimer = null;
  let onFallEnd = null;
  let defaultFallEnd = null;
  // The current press (drag-lock) caught the pet during an active or suspended fall.
  let caughtMidAir = false;
  let dragSamples = [];
  let shownRotation = 0;

  // Only changes go to the renderer (one IPC per frame at most, none at rest).
  function showRotation(degrees) {
    const rounded = Math.round(degrees * 10) / 10;
    if (rounded === shownRotation) return;
    shownRotation = rounded;
    setRotation(rounded);
  }

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
  // rest, from the rest clamp it already obeys, edge pinning included. A
  // throw also gets the walls and top, where a drag against each would rest.
  function resolveArea(bounds, thrown) {
    const { width, height } = frozenSize(bounds);
    const cx = bounds.x + width / 2;
    const cy = bounds.y + height / 2;
    const wa = ctx.getNearestWorkArea(cx, cy);
    if (!wa) return null;
    const rest = (x, y) => ctx.clampToScreenVisual(x, y, width, height, { workArea: wa });
    const valid = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
    // Probe well past each edge so the rest clamp returns the outermost
    // resting spot, which edge pinning can put outside the work area.
    const lowest = rest(bounds.x, wa.y + wa.height * 2 + height);
    if (!valid(lowest)) return null;
    const area = { width, height, floorY: Math.round(lowest.y), walls: null };
    if (!thrown) return area;
    const leftmost = rest(wa.x - wa.width - width, bounds.y);
    const rightmost = rest(wa.x + wa.width * 2 + width, bounds.y);
    const highest = rest(bounds.x, wa.y - wa.height - height);
    if ([leftmost, rightmost, highest].every(valid)) {
      area.walls = {
        minX: Math.round(leftmost.x),
        maxX: Math.round(rightmost.x),
        minY: Math.round(highest.y),
      };
    }
    return area;
  }

  function finish(landed, landing) {
    if (fallTimer) {
      clearTimeout(fallTimer);
      fallTimer = null;
    }
    if (!falling) return;
    falling = false;
    // Upright before the landing squash (or the drag that caught it) starts.
    showRotation(0);
    // Same release point as roam: a reconcile marked dirty mid-fall runs now.
    if (typeof ctx.releaseReconcileProtection === "function") ctx.releaseReconcileProtection();
    const callback = onFallEnd;
    onFallEnd = null;
    if (typeof callback === "function") callback(landed, landing || null);
  }

  // Drops the pet onto the floor below it, or throws it when a velocity comes
  // in. Returns true when it left the ground. onEnd(landed, landing) runs once
  // at the end (defaults to the setFallEndHandler one); landed is false
  // (landing null) when the pet was caught mid-air or the flight was
  // interrupted, otherwise landing = { intensity }.
  function startFall(onEnd, velocity) {
    suspended = false;
    if (!enabled || !isWindowAlive() || isMiniBusy()) return false;
    // A new placement (Send to Display, Bring to Primary, a drag-end) takes
    // over a running fall: the old one ends here, so its next frame cannot
    // put the pet back on the old path.
    if (falling) finish(false);
    const start = ctx.getPetWindowBounds();
    if (!start) return false;
    const wantsThrow = !!velocity && (velocity.x !== 0 || velocity.y !== 0);
    const area = resolveArea(start, wantsThrow);
    if (!area) return false;
    const { width, height, floorY, walls } = area;
    // Without walls the throw degrades to a plain drop, which needs room below;
    // a throw can also leave the floor upward.
    const thrown = wantsThrow && !!walls;
    if (!thrown && floorY - start.y < MIN_DROP_PX) return false;

    falling = true;
    onFallEnd = onEnd || defaultFallEnd;
    let motion = { x: start.x, y: start.y, vx: thrown ? velocity.x : 0, vy: thrown ? velocity.y : 0 };
    const startedAt = now();
    let lastTick = startedAt;
    let wallHoldUntil = 0;
    let frameCount = 0;
    let rotation = 0;
    let righting = false;

    // Coming down onto the floor (a throw on its way up passes it).
    const lands = (next) => next.vy >= 0 && next.y >= floorY;

    // Flight time ahead, to fit the turn in it (wall pauses skipped).
    function predictFlightMs() {
      let m = motion;
      for (let ms = FRAME_MS; ms < HARD_STOP_MS; ms += FRAME_MS) {
        const n = advanceThrow(m, FRAME_MS, walls);
        if (lands(n)) return ms;
        m = n.wall ? { ...n, vx: -n.vx * THROW_WALL_RESTITUTION } : n;
      }
      return HARD_STOP_MS;
    }

    let spin = null;
    if (thrown) {
      const turnMs = Math.min(getSpinTurnMs(velocity), predictFlightMs() / SPIN_DONE_AT_LANDING);
      if (turnMs >= SPIN_MIN_TURN_MS) spin = { direction: motion.vx < 0 ? -1 : 1, turnMs };
    }

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
      // A new drag or size preview takes over the window.
      if (
        !isWindowAlive() || ctx.dragLocked || isMiniBusy()
        || (typeof ctx.isSizePreviewActive === "function" && ctx.isSizePreviewActive())
      ) {
        finish(false);
        return;
      }
      const t = now();
      const flying = t - startedAt;
      if (thrown) {
        // Against a wall: hold still, then come back at 20% of the speed.
        if (wallHoldUntil) {
          if (t < wallHoldUntil) {
            fallTimer = setTimeout(step, FRAME_MS);
            return;
          }
          wallHoldUntil = 0;
          lastTick = t;
          motion = { ...motion, vx: -motion.vx * THROW_WALL_RESTITUTION };
        }
        // Like VS Code: after 4 s in the air the pet stops drifting and drops.
        if (flying >= THROW_MAX_DURATION_MS && motion.vx !== 0) {
          motion = { ...motion, vx: 0, vy: Math.max(0, motion.vy) };
        }
      }
      const elapsed = Math.min(MAX_FRAME_MS, Math.max(0, t - lastTick));
      lastTick = t;
      const previousY = motion.y;
      const next = thrown
        ? advanceThrow(motion, elapsed, walls)
        : { x: start.x, vx: 0, wall: null, ...advanceFall(motion, elapsed) };
      if (lands(next) || (thrown && flying >= HARD_STOP_MS)) {
        // Speed when touching down (v² = v0² + 2gh), not at the end of the
        // frame, which already overshot the floor by up to 32 ms.
        const impact = Math.min(
          MAX_FALL_SPEED_PX_PER_S,
          Math.sqrt(Math.max(0, motion.vy * motion.vy + 2 * GRAVITY_PX_PER_S2 * (floorY - previousY))),
        );
        place(next.x, floorY, true);
        finish(true, { intensity: landingIntensity(impact) });
        return;
      }
      motion = next;
      if (next.wall) {
        // Like VS Code: the impact stops the turn, the pet faces the wall at
        // 90° and then rights itself at 720°/s while it falls.
        spin = null;
        righting = true;
        rotation = next.wall === "left" ? -90 : 90;
        wallHoldUntil = t + WALL_IMPACT_MS;
      } else if (spin) {
        const progress = flying / spin.turnMs;
        rotation = progress >= 1 ? 0 : getSpinRotation(spin.direction, progress);
        if (progress >= 1) spin = null;
      } else if (righting) {
        const correction = (THROW_SELF_RIGHTING_SPEED * elapsed) / 1000;
        rotation = Math.abs(rotation) <= correction ? 0 : rotation - Math.sign(rotation) * correction;
        righting = rotation !== 0;
      }
      place(motion.x, motion.y, false);
      showRotation(rotation);
      fallTimer = setTimeout(step, FRAME_MS);
    }

    // The first step uses the regular frame interval too.
    fallTimer = setTimeout(step, FRAME_MS);
    return true;
  }

  // A new drag catches a falling pet at once, so the held end of the old drag
  // reaction goes out before the new drag starts its own. It also starts a
  // fresh throw measurement.
  function beginDrag() {
    caughtMidAir = falling || suspended;
    suspended = false;
    cancel();
    dragSamples = [];
  }

  // Cursor positions during the drag, to measure the throw on release.
  function recordDragSample() {
    if (!enabled) return;
    const point = getCursorPoint();
    if (!point) return;
    dragSamples.push({ x: point.x, y: point.y, t: now() });
    if (dragSamples.length > DRAG_SAMPLE_LIMIT) dragSamples.shift();
  }

  // The press is over (drag-lock released). A pet caught mid-air by a click
  // gets no drag-end, so it falls again from where it is; after a real drag
  // the drag-end fall takes over this one.
  function endPress() {
    if (!caughtMidAir) return false;
    caughtMidAir = false;
    return startFall();
  }

  // End of a drag: a fast release throws the pet, a slow one just drops it.
  // The cursor at the release joins the samples while the hand was still moving.
  function release(onEnd) {
    const t = now();
    const lastMove = dragSamples[dragSamples.length - 1];
    let samples = dragSamples;
    if (lastMove && t - lastMove.t <= THROW_RELEASE_GRACE_MS) {
      const point = getCursorPoint();
      if (point) samples = [...dragSamples, { x: point.x, y: point.y, t }];
    }
    const velocity = getThrowVelocity(samples, t);
    dragSamples = [];
    return startFall(onEnd, velocity);
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
    suspended = false;
    finish(false);
  }

  // A throw paused by a display change resumes as a plain drop.
  function suspend() {
    if (!falling) return;
    finish(false);
    suspended = true;
  }

  function resumeSuspended() {
    if (!suspended) return false;
    suspended = false;
    return startFall();
  }

  function isFalling() {
    return falling;
  }

  return {
    startFall,
    release,
    beginDrag,
    recordDragSample,
    endPress,
    cancel,
    suspend,
    resumeSuspended,
    isFalling,
    setEnabled,
    isEnabled,
    setFallEndHandler,
  };
};

module.exports.measureReleaseVelocity = measureReleaseVelocity;
module.exports.getThrowVelocity = getThrowVelocity;
module.exports.advanceThrow = advanceThrow;
module.exports.getSpinTurnMs = getSpinTurnMs;
module.exports.getSpinRotation = getSpinRotation;

/*
 * License of the parts adapted from VS Code (release rules, advanceThrow, wall pose):
 *
 * MIT License
 *
 * Copyright (c) 2015 - present Microsoft Corporation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
