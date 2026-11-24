"use strict";

const STATUS_BADGE_WIDTH = 112;
const STATUS_BADGE_COLLAPSED_WIDTH = 46;
const STATUS_BADGE_HEIGHT = 28;
const STATUS_BADGE_SHELL = Object.freeze({
  top: 3,
  right: 4,
  bottom: 8,
  left: 4,
});
const STATUS_BADGE_PET_GAP = 7;
const STATUS_BADGE_EDGE_MARGIN = 8;

function isScreenRect(rect) {
  return !!rect
    && Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.right)
    && Number.isFinite(rect.bottom);
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(value, max));
}

function computeStatusBadgeContentSize(collapsed) {
  return {
    width: collapsed ? STATUS_BADGE_COLLAPSED_WIDTH : STATUS_BADGE_WIDTH,
    height: STATUS_BADGE_HEIGHT,
  };
}

function resolveStatusBadgeSide({
  petLeft,
  petRight,
  workArea,
  badgeWidth,
  gap = STATUS_BADGE_PET_GAP,
  margin = STATUS_BADGE_EDGE_MARGIN,
}) {
  if (!workArea) return "right";
  const need = badgeWidth + gap + margin;
  const leftRoom = petLeft - workArea.x;
  const rightRoom = (workArea.x + workArea.width) - petRight;
  if (rightRoom >= need) return "right";
  if (leftRoom >= need) return "left";
  return rightRoom >= leftRoom ? "right" : "left";
}

function computeStatusBadgeBounds({
  hitRect,
  anchorRect,
  workArea,
  collapsed = false,
  scale = 1,
}) {
  const followRect = isScreenRect(anchorRect) ? anchorRect : hitRect;
  if (!isScreenRect(followRect) || !workArea) return null;
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const content = computeStatusBadgeContentSize(collapsed);
  const contentW = Math.round(content.width * s);
  const contentH = Math.round(content.height * s);
  const gap = Math.round(STATUS_BADGE_PET_GAP * s);
  const margin = Math.round(STATUS_BADGE_EDGE_MARGIN * s);
  const shell = {
    top: Math.round(STATUS_BADGE_SHELL.top * s),
    right: Math.round(STATUS_BADGE_SHELL.right * s),
    bottom: Math.round(STATUS_BADGE_SHELL.bottom * s),
    left: Math.round(STATUS_BADGE_SHELL.left * s),
  };
  const petLeft = Math.round(followRect.left);
  const petRight = Math.round(followRect.right);
  const side = resolveStatusBadgeSide({
    petLeft,
    petRight,
    workArea,
    badgeWidth: contentW,
    gap,
    margin,
  });
  const minX = Math.round(workArea.x + margin);
  const maxX = Math.round(workArea.x + workArea.width - margin - contentW);
  const preferredX = side === "right" ? petRight + gap : petLeft - gap - contentW;
  const x = clamp(preferredX, minX, maxX);
  const minY = Math.round(workArea.y + margin);
  const maxY = Math.round(workArea.y + workArea.height - margin - contentH);
  const preferredY = Math.round(followRect.bottom) - contentH;
  const y = clamp(preferredY, minY, maxY);
  const contentBounds = { x, y, width: contentW, height: contentH };
  return {
    side,
    contentBounds,
    bounds: {
      x: contentBounds.x - shell.left,
      y: contentBounds.y - shell.top,
      width: contentW + shell.left + shell.right,
      height: contentH + shell.top + shell.bottom,
    },
  };
}

module.exports = {
  computeStatusBadgeContentSize,
  resolveStatusBadgeSide,
  computeStatusBadgeBounds,
  constants: {
    STATUS_BADGE_WIDTH,
    STATUS_BADGE_COLLAPSED_WIDTH,
    STATUS_BADGE_HEIGHT,
    STATUS_BADGE_SHELL,
    STATUS_BADGE_PET_GAP,
    STATUS_BADGE_EDGE_MARGIN,
  },
};
