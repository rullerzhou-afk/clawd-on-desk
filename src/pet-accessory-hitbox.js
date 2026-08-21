"use strict";

const { resolveViewBox } = require("./hit-geometry");

function basenameOnly(value) {
  return typeof value === "string" ? value.replace(/^.*[\/\\]/, "") : value;
}

// Measured from the real built-in SVG transforms by
// test/fixtures/accessory-motion-electron.js. Values are rounded outward to a
// practical tenth of a theme unit; authored hitBoxPadding can only widen them.
// Unknown/external themes never inherit these built-in measurements.
const BUILTIN_ACCESSORY_MOTION_PADDING = Object.freeze({
  clawd: Object.freeze({
    "clawd-idle-follow.svg": Object.freeze({ left: 0.2, right: 0.2, bottom: 0.7 }),
    "clawd-dizzy.svg": Object.freeze({ left: 2, top: 0.5, right: 2, bottom: 0.6 }),
    "clawd-happy.svg": Object.freeze({ top: 12, bottom: 1.5 }),
    "clawd-idle-look.svg": Object.freeze({ left: 1.2, right: 1.2, bottom: 0.7 }),
    "clawd-idle-yawn.svg": Object.freeze({ left: 0.8, top: 4.5, right: 0.8, bottom: 2 }),
    "clawd-mini-idle.svg": Object.freeze({ left: 3.2, top: 1.6, right: 0.2, bottom: 2.4 }),
    "clawd-mini-alert.svg": Object.freeze({ left: 3.2, top: 1.6, right: 0.2, bottom: 2.4 }),
    "clawd-mini-happy.svg": Object.freeze({ left: 3.2, top: 1.6, right: 0.2, bottom: 2.4 }),
    "clawd-mini-peek.svg": Object.freeze({ left: 3.2, top: 1.6, right: 0.2, bottom: 2.4 }),
    "clawd-mini-typing.svg": Object.freeze({ left: 3.2, top: 1.6, right: 0.2, bottom: 2.4 }),
    "clawd-mini-crabwalk.svg": Object.freeze({ left: 1.8, right: 3.9, bottom: 1.3 }),
    "clawd-mini-enter.svg": Object.freeze({ left: 6.2, top: 2.4, right: 25, bottom: 2.1 }),
    "clawd-working-thinking.svg": Object.freeze({ left: 1.6, top: 0.2, right: 1.6, bottom: 0.8 }),
    "clawd-working-typing.svg": Object.freeze({ bottom: 1.5 }),
    "clawd-notification.svg": Object.freeze({ left: 1.7, top: 0.5, bottom: 0.6 }),
    "clawd-working-building.svg": Object.freeze({ bottom: 5 }),
    "clawd-headphones-groove.svg": Object.freeze({ left: 2.3, top: 1.5, right: 2.3, bottom: 1.5 }),
    "clawd-working-juggling.svg": Object.freeze({ left: 1.4, top: 0.1, right: 1.4, bottom: 1.4 }),
    "clawd-idle-bubble.svg": Object.freeze({ top: 1.2, bottom: 0.7 }),
    "clawd-idle-reading.svg": Object.freeze({ left: 0.2, right: 0.2, bottom: 1.1 }),
    "clawd-idle-doze.svg": Object.freeze({ left: 0.7, right: 0.7, bottom: 2.3 }),
    "clawd-react-drag.svg": Object.freeze({ left: 1.8, top: 0.4, right: 1.8, bottom: 0.5 }),
    "clawd-react-left.svg": Object.freeze({ left: 2.9, top: 0.3, bottom: 0.3 }),
    "clawd-react-right.svg": Object.freeze({ top: 0.3, right: 2.9, bottom: 0.3 }),
    "clawd-react-annoyed.svg": Object.freeze({ top: 0.8, right: 2, bottom: 1.5 }),
    "clawd-react-double.svg": Object.freeze({ left: 1, top: 1, right: 1 }),
    "clawd-react-double-jump.svg": Object.freeze({ left: 0.8, top: 3.5, right: 0.8, bottom: 1.8 }),
    "clawd-working-sweeping.svg": Object.freeze({ left: 3.6, top: 0.8, right: 0.1, bottom: 1.6 }),
    "clawd-working-carrying.svg": Object.freeze({ left: 0.9, top: 0.3, bottom: 1.3 }),
    "clawd-working-debugger.svg": Object.freeze({ left: 1.8, right: 4, bottom: 2 }),
    "clawd-sleeping.svg": Object.freeze({ left: 0.2, top: 5.3, right: 0.2 }),
  }),
  cloudling: Object.freeze({
    // Idle is script-driven, so this one is derived rather than sampled: the
    // cloud group is transformed about (12,12) by rotate(θ)·scale(s) with
    // |θ| <= MAX_ROT_DEG (20°, since targetRot = eyeOffset.x/EYE_MAX * maxRot
    // and |eyeOffset.x| <= EYE_MAX) and s in [SCALE_LOW, DIST_MAX_SCALE] =
    // [0.96, 1.15]. Both ends of the scale matter: the horizontal peak is at
    // s=1.15, but the bottom peak is at s=0.96 — the halo sits above the pivot,
    // so shrinking pushes its lower edge down. Sweeping that closed range over
    // all seven accessories peaks at 10.019/4.942/10.019/3.941 (wizard-hat
    // horizontally, halo at the bottom). An upper bound cannot be undershot by
    // a slow or fast machine, which a sampled figure demonstrably was.
    "cloudling-idle.svg": Object.freeze({ left: 10.1, top: 5, right: 10.1, bottom: 4 }),
    "cloudling-typing.svg": Object.freeze({ left: 0.5, top: 1.2, right: 0.5, bottom: 0.6 }),
    // Same pointer-driven transform as idle (maxRotDeg 13, scale in
    // [0.96, 1.15] about (12,12)), so this is derived, not sampled: a headless
    // window never engages the pointer, and the sampled figure was the
    // breath-only subspace. tick.js's POINTER_BRIDGE_STATES includes mini-idle
    // and pins inside:true, so the full rotation is ordinary runtime, not an
    // edge case. Seven-accessory peak is 6.205/4.238/6.205/2.281 (wizard-hat
    // horizontally, halo at the bottom).
    "cloudling-mini-idle.svg": Object.freeze({ left: 6.3, top: 4.3, right: 6.3, bottom: 2.4 }),
    // Swept deterministically through the walk's own frameFor() via its seek
    // hook, over the 127.6s where the 1.16s step cycle and the 4.4s breath
    // return to phase together, at a step coprime with both so every 1ms phase
    // is visited — bottom's true peak sits on the contact pulse at q=0.72,
    // which a period-dividing step steps straight over.
    "cloudling-mini-crabwalk.svg": Object.freeze({ left: 6.4, top: 3, right: 8, bottom: 3.7 }),
  }),
});

function resolveAccessoryDescriptor(theme, state, file) {
  const attachments = theme && theme.customization && theme.customization.accessories;
  if (!attachments || !file) return null;

  const safeFile = basenameOnly(file);
  if (attachments.files && Object.prototype.hasOwnProperty.call(attachments.files, safeFile)) {
    return attachments.files[safeFile];
  }
  if (state && state.startsWith("mini-") && attachments.mini) return attachments.mini;
  return attachments.default || null;
}

function isFiniteHitBox(value) {
  return !!(
    value
    && [value.x, value.y, value.w, value.h].every(Number.isFinite)
    && value.w > 0
    && value.h > 0
  );
}

function normalizedPadding(value) {
  const padding = value || {};
  return {
    left: Number.isFinite(padding.left) && padding.left >= 0 ? padding.left : 0,
    top: Number.isFinite(padding.top) && padding.top >= 0 ? padding.top : 0,
    right: Number.isFinite(padding.right) && padding.right >= 0 ? padding.right : 0,
    bottom: Number.isFinite(padding.bottom) && padding.bottom >= 0 ? padding.bottom : 0,
  };
}

function getPadding(theme, file, descriptor) {
  const authored = normalizedPadding(descriptor && descriptor.hitBoxPadding);
  const themeId = theme && theme._builtin === true && typeof theme._id === "string" ? theme._id : null;
  const measured = normalizedPadding(
    themeId
    && BUILTIN_ACCESSORY_MOTION_PADDING[themeId]
    && BUILTIN_ACCESSORY_MOTION_PADDING[themeId][basenameOnly(file)]
  );
  return {
    left: Math.max(authored.left, measured.left),
    top: Math.max(authored.top, measured.top),
    right: Math.max(authored.right, measured.right),
    bottom: Math.max(authored.bottom, measured.bottom),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mirrorHorizontal(left, right, viewBox) {
  const axis2 = 2 * viewBox.x + viewBox.width;
  return { left: axis2 - right, right: axis2 - left };
}

/**
 * Expand the current animation's authored hit box by the exact selected
 * accessory envelope. Accessory-only geometry is clamped to the render-visible
 * effective viewBox before unioning, so an external theme cannot turn a broad
 * staticFrame/padding declaration into a giant transparent native input window.
 * The base hitbox is deliberately never clamped or rewritten.
 */
function resolveAccessoryAwareHitBox(theme, state, file, baseHitBox, accessory, options = {}) {
  if (!isFiniteHitBox(baseHitBox)) return baseHitBox;
  if (
    !accessory
    || accessory.id === "none"
    || !accessory.assetFile
    || !Number.isFinite(accessory.aspect)
    || accessory.aspect <= 0
    || !Number.isFinite(accessory.widthScale)
    || accessory.widthScale <= 0
    || !Number.isFinite(accessory.offsetY)
  ) return baseHitBox;

  const descriptor = resolveAccessoryDescriptor(theme, state, file);
  const frame = descriptor && descriptor.staticFrame;
  if (
    !descriptor
    || descriptor.visibility === "hidden"
    || !frame
    || ![frame.cx, frame.baseY, frame.width].every(Number.isFinite)
    || frame.width <= 0
  ) return baseHitBox;

  const width = frame.width * accessory.widthScale;
  const height = width / accessory.aspect;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return baseHitBox;

  const padding = getPadding(theme, file, descriptor);
  let accessoryLeft = frame.cx - width / 2 - padding.left;
  let accessoryTop = frame.baseY + accessory.offsetY - height - padding.top;
  let accessoryRight = frame.cx + width / 2 + padding.right;
  let accessoryBottom = frame.baseY + accessory.offsetY + padding.bottom;

  const viewBox = options.viewBox || resolveViewBox(theme, state, file);
  if (
    viewBox
    && [viewBox.x, viewBox.y, viewBox.width, viewBox.height].every(Number.isFinite)
    && viewBox.width > 0
    && viewBox.height > 0
  ) {
    if (options.mirrorX === true) {
      ({ left: accessoryLeft, right: accessoryRight } = mirrorHorizontal(accessoryLeft, accessoryRight, viewBox));
    }
    const maxX = viewBox.x + viewBox.width;
    const maxY = viewBox.y + viewBox.height;
    accessoryLeft = clamp(accessoryLeft, viewBox.x, maxX);
    accessoryRight = clamp(accessoryRight, viewBox.x, maxX);
    accessoryTop = clamp(accessoryTop, viewBox.y, maxY);
    accessoryBottom = clamp(accessoryBottom, viewBox.y, maxY);
  }

  if (accessoryRight <= accessoryLeft || accessoryBottom <= accessoryTop) return baseHitBox;

  const left = Math.min(baseHitBox.x, accessoryLeft);
  const top = Math.min(baseHitBox.y, accessoryTop);
  const right = Math.max(baseHitBox.x + baseHitBox.w, accessoryRight);
  const bottom = Math.max(baseHitBox.y + baseHitBox.h, accessoryBottom);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

module.exports = {
  BUILTIN_ACCESSORY_MOTION_PADDING,
  resolveAccessoryDescriptor,
  resolveAccessoryAwareHitBox,
};
