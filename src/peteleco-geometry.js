"use strict";

// src/peteleco-geometry.js — Peteleco (flick) math, pure and Electron-free.
//
// User-facing contract: docs/guides/peteleco.md (keep both in sync).
//
// Peteleco is a billiards-style gesture: hold the modifier, press on the pet
// and pull AWAY from where you want it to go. While the button is held the pet
// stays put (it is the cue ball, not the cue) and an aim projection is drawn
// from the pet toward the OPPOSITE side of the pull. Releasing launches the
// pet along that projection.
//
// Everything here is screen-coordinate arithmetic on plain numbers so the
// runtime (src/peteleco.js), the overlay renderer, and the tests all share one
// definition of "where does the shot land".
//
// Two rules the rest of the feature depends on:
//   • The projection is never longer than the shot. `to` is computed AFTER the
//     caller's clamp runs, so the line always points at the real landing spot
//     — an aim into the edge of the work area visibly shortens instead of
//     promising travel the pet cannot make.
//   • Reach is capped by intensity, not by the pull. Dragging the cursor to
//     the far side of the desk cannot throw the pet further than the user's
//     configured flick-intensity setting allows, which is what keeps the
//     projection short (the feature request's "não deve ser muito longa").

const PETELECO_INTENSITY_MIN = 1;
const PETELECO_INTENSITY_MAX = 100;
const PETELECO_INTENSITY_DEFAULT = 50;

// Pull-to-travel conversion. A 100px pull asks for 220px of travel, which the
// intensity cap below then limits.
const PETELECO_PULL_GAIN = 2.2;
// Reach band, in screen px, mapped linearly from intensity 1 → 100. The low
// end is a nudge (the pet barely leaves its spot); the high end still lands
// well inside a 1080p work area, so even "max power" reads as a flick rather
// than a teleport.
const PETELECO_MIN_REACH_PX = 60;
const PETELECO_MAX_REACH_PX = 520;
// Below this pull the gesture is still a click (the modifier + click shortcuts
// keep working) and no projection is drawn.
const PETELECO_MIN_PULL_PX = 6;

// Launch speed and its duration envelope. Deliberately unhurried: the shot
// should read as the pet gliding to a stop, not snapping to a new position.
// Roam strolls at 0.08 px/ms, so 0.7 is still an order of magnitude faster —
// it just no longer outruns the eye.
const PETELECO_SPEED_PX_PER_MS = 0.7;
const PETELECO_MIN_DURATION_MS = 260;
const PETELECO_MAX_DURATION_MS = 1400;
const PETELECO_FRAME_MS = 16;
// How long the aim projection takes to fade away after the shot is fired. The
// line lingers over the launch and dissolves while the pet is still travelling,
// instead of popping out of existence on mouse-up. Mirrored by the
// `#stage.is-fading` transition in peteleco-overlay.html — the two are one
// decision written twice, and test/peteleco-overlay-window.test.js pins them.
const PETELECO_FADE_OUT_MS = 320;

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Accepts anything (prefs, IPC, a settings slider mid-drag) and returns a
// usable integer intensity. Non-numbers fall back to the default rather than
// to a silent 0 — an unreadable intensity must not disable the shot.
function clampPetelecoIntensity(value) {
  // Deliberately not a bare Number(): null and "" coerce to 0, which would
  // clamp to minimum reach — "the weakest possible flick" is a different lie
  // from "no value was given".
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric)) return PETELECO_INTENSITY_DEFAULT;
  return Math.round(
    clampNumber(numeric, PETELECO_INTENSITY_MIN, PETELECO_INTENSITY_MAX)
  );
}

// Maximum travel, in px, the configured intensity allows.
function petelecoReachPx(intensity) {
  const clamped = clampPetelecoIntensity(intensity);
  const ratio =
    (clamped - PETELECO_INTENSITY_MIN) /
    (PETELECO_INTENSITY_MAX - PETELECO_INTENSITY_MIN);
  return Math.round(
    PETELECO_MIN_REACH_PX + ratio * (PETELECO_MAX_REACH_PX - PETELECO_MIN_REACH_PX)
  );
}

function computePull(origin, cursor) {
  if (!origin || !cursor) return null;
  const dx = Number(cursor.x) - Number(origin.x);
  const dy = Number(cursor.y) - Number(origin.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  return { dx, dy, distance: Math.sqrt(dx * dx + dy * dy) };
}

// computeAim({ origin, cursor, bounds, intensity, clampPosition })
//
//   origin  — cursor position (screen px) when the gesture started
//   cursor  — cursor position now
//   bounds  — pet window rect at gesture start (x, y, width, height); the pet
//             does NOT move while aiming, so this stays the launch rect
//   center  — optional screen point the projection should be drawn FROM: the
//             avatar's visual middle (pet-geometry-main's getPetVisualCenter),
//             which is not the window's middle. Only the drawn line moves with
//             it; the window rect the pet flies to is unaffected. Defaults to
//             the window center when absent.
//   clampPosition(x, y, w, h) → { x, y } — optional; the runtime passes the
//             same visual clamp a drag-end uses, so a shot can never park the
//             pet somewhere a drag could not
//
// Returns null when there is nothing to draw yet (no pull, degenerate input,
// or the clamp swallowed the whole shot), otherwise:
//   {
//     pull:      { dx, dy, distance },   // cursor displacement
//     direction: { x, y },               // unit vector, OPPOSITE the pull
//     reach, requested, distance,        // px: cap, uncapped ask, real travel
//     power,                             // 0..1, distance / reach
//     from: { x, y },                    // draw anchor at launch
//     to:   { x, y },                    // the same anchor on landing
//     target: { x, y, width, height },   // landing window rect
//   }
function computeAim({
  origin,
  cursor,
  bounds,
  center = null,
  intensity = PETELECO_INTENSITY_DEFAULT,
  clampPosition = null,
} = {}) {
  if (!bounds) return null;
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  const startX = Number(bounds.x);
  const startY = Number(bounds.y);
  if (
    !Number.isFinite(width) || !Number.isFinite(height)
    || !Number.isFinite(startX) || !Number.isFinite(startY)
    || width <= 0 || height <= 0
  ) return null;

  const pull = computePull(origin, cursor);
  if (!pull || pull.distance < PETELECO_MIN_PULL_PX) return null;

  // Opposite side of the pull — the whole point of the gesture.
  const direction = { x: -pull.dx / pull.distance, y: -pull.dy / pull.distance };
  const reach = petelecoReachPx(intensity);
  const requested = pull.distance * PETELECO_PULL_GAIN;
  const travel = Math.min(requested, reach);

  let targetX = startX + direction.x * travel;
  let targetY = startY + direction.y * travel;
  if (typeof clampPosition === "function") {
    const clamped = clampPosition(targetX, targetY, width, height);
    if (clamped && Number.isFinite(clamped.x) && Number.isFinite(clamped.y)) {
      targetX = clamped.x;
      targetY = clamped.y;
    }
  }
  targetX = Math.round(targetX);
  targetY = Math.round(targetY);

  const movedX = targetX - startX;
  const movedY = targetY - startY;
  const distance = Math.sqrt(movedX * movedX + movedY * movedY);
  // The clamp can eat the entire shot (pet already pinned against that edge).
  // Nothing to draw and nothing to animate.
  if (distance < 1) return null;

  // Both ends of the drawn line hang off ONE anchor translated by the shot, so
  // the line always starts and ends on the same spot of the sprite. Taking the
  // landing end from the window rect instead would tilt every projection by the
  // art's own offset inside its window.
  const anchor =
    center && Number.isFinite(center.x) && Number.isFinite(center.y)
      ? { x: center.x, y: center.y }
      : { x: startX + width / 2, y: startY + height / 2 };

  return {
    pull,
    direction,
    reach,
    requested: Math.round(requested),
    distance: Math.round(distance),
    power: clampNumber(distance / reach, 0, 1),
    from: { x: Math.round(anchor.x), y: Math.round(anchor.y) },
    to: { x: Math.round(anchor.x + movedX), y: Math.round(anchor.y + movedY) },
    target: { x: targetX, y: targetY, width, height },
  };
}

// Duration of the launch animation for a given travel distance.
function petelecoDurationMs(distance) {
  const numeric = Number(distance);
  if (!Number.isFinite(numeric) || numeric <= 0) return PETELECO_MIN_DURATION_MS;
  return Math.round(
    clampNumber(
      numeric / PETELECO_SPEED_PX_PER_MS,
      PETELECO_MIN_DURATION_MS,
      PETELECO_MAX_DURATION_MS
    )
  );
}

// Ease-out quartic: leaves fast and spends the back half of the animation
// bleeding off the last few pixels — the motion equivalent of a fade-out, and
// the reason the shot reads as settling rather than stopping. (Cubic, the
// previous curve, still lands with visible speed on the final frames.)
function petelecoEase(t) {
  const clamped = clampNumber(Number(t), 0, 1);
  const inverse = 1 - clamped;
  return 1 - inverse * inverse * inverse * inverse;
}

// Window rect at progress t (0..1) of a flick from `start` to `target`.
function petelecoBoundsAt(start, target, t) {
  if (!start || !target) return null;
  const eased = petelecoEase(t);
  const x = Math.round(start.x + (target.x - start.x) * eased);
  const y = Math.round(start.y + (target.y - start.y) * eased);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, width: start.width, height: start.height };
}

module.exports = {
  PETELECO_INTENSITY_MIN,
  PETELECO_INTENSITY_MAX,
  PETELECO_INTENSITY_DEFAULT,
  PETELECO_MIN_PULL_PX,
  PETELECO_MIN_REACH_PX,
  PETELECO_MAX_REACH_PX,
  PETELECO_PULL_GAIN,
  PETELECO_FRAME_MS,
  PETELECO_MIN_DURATION_MS,
  PETELECO_MAX_DURATION_MS,
  PETELECO_FADE_OUT_MS,
  clampPetelecoIntensity,
  petelecoReachPx,
  computePull,
  computeAim,
  petelecoDurationMs,
  petelecoEase,
  petelecoBoundsAt,
};
