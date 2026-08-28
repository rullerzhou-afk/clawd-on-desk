"use strict";

function basenameOnly(value) {
  return typeof value === "string" ? value.replace(/^.*[\/\\]/, "") : value;
}

function isSvgFile(file) {
  return typeof file === "string" && file.toLowerCase().endsWith(".svg");
}

function resolveViewBox(theme, state, file) {
  if (!theme) return null;
  const key = basenameOnly(file);
  if (key && theme.fileViewBoxes && theme.fileViewBoxes[key]) return theme.fileViewBoxes[key];
  if (state && state.startsWith("mini-") && theme.miniMode && theme.miniMode.viewBox) {
    return theme.miniMode.viewBox;
  }
  return theme.viewBox;
}

function viewBoxEquals(a, b) {
  return !!(a && b
    && a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height);
}

function hasRootViewBoxFileOverride(theme, file) {
  const key = basenameOnly(file);
  return !!(
    theme
    && key
    && theme.fileViewBoxes
    && viewBoxEquals(theme.fileViewBoxes[key], theme.viewBox)
  );
}

function usesObjectChannel(theme, state, file) {
  if (!theme || !isSvgFile(file)) return false;
  if (theme.rendering && theme.rendering.svgChannel === "object") return true;
  const eyeStates = theme.eyeTracking && theme.eyeTracking.enabled
    ? (theme.eyeTracking.states || [])
    : [];
  const trustedFiles = theme._builtin && theme.trustedRuntime && Array.isArray(theme.trustedRuntime.scriptedSvgFiles)
    ? theme.trustedRuntime.scriptedSvgFiles
    : [];
  return eyeStates.includes(state) || trustedFiles.includes(basenameOnly(file));
}

function usesNormalizedLayout(theme, state, file) {
  if (!theme || !theme.layout || !theme.layout.contentBox) return false;
  if (hasRootViewBoxFileOverride(theme, file)) return true;
  if ((state && state.startsWith("mini-")) || (file && file.startsWith("mini-"))) return false;
  return true;
}

function getFileLayout(theme, file) {
  const os = (theme && theme.objectScale) || {};
  const fileOffsets = os.fileOffsets || {};
  const fileScales = os.fileScales || {};
  const offset = fileOffsets[file] || {};
  return {
    widthRatio: os.widthRatio || 1.9,
    heightRatio: os.heightRatio || 1.3,
    imgWidthRatio: os.imgWidthRatio || os.widthRatio || 1.9,
    offsetX: os.offsetX || 0,
    imgOffsetX: os.imgOffsetX != null ? os.imgOffsetX : (os.offsetX || 0),
    objBottom: os.objBottom != null ? os.objBottom : (1 - (os.offsetY || 0) - (os.heightRatio || 1.3)),
    imgBottom: os.imgBottom != null ? os.imgBottom : 0.05,
    fileScale: fileScales[file] || 1,
    offsetPxX: offset.x || 0,
    offsetPxY: offset.y || 0,
  };
}

function getNormalizedLayout(theme, state, file) {
  if (!theme || !theme.layout || !theme.layout.contentBox) return null;
  const viewBox = resolveViewBox(theme, state, file);
  if (!viewBox) return null;
  const layout = theme.layout;
  const os = (theme && theme.objectScale) || {};
  const fileOffsets = os.fileOffsets || {};
  const fileScales = os.fileScales || {};
  const offset = fileOffsets[file] || {};
  const contentBox = layout.contentBox;
  const fileScale = fileScales[file] || 1;
  const unitRatio = (layout.visibleHeightRatio * fileScale) / contentBox.height;

  return {
    leftRatio: layout.centerXRatio - ((layout.centerX - viewBox.x) * unitRatio),
    bottomRatio: layout.baselineBottomRatio - ((viewBox.y + viewBox.height - layout.baselineY) * unitRatio),
    widthRatio: viewBox.width * unitRatio,
    heightRatio: viewBox.height * unitRatio,
    offsetPxX: offset.x || 0,
    offsetPxY: offset.y || 0,
  };
}

function fitViewBoxIntoRect(outerRect, viewBox) {
  const scale = Math.min(outerRect.w / viewBox.width, outerRect.h / viewBox.height);
  const width = viewBox.width * scale;
  const height = viewBox.height * scale;
  return {
    x: outerRect.x + (outerRect.w - width) / 2,
    y: outerRect.y + (outerRect.h - height) / 2,
    w: width,
    h: height,
  };
}

function getAssetRectScreen(theme, bounds, state, file) {
  if (!theme || !bounds) return null;

  const viewBox = resolveViewBox(theme, state, file);
  if (!viewBox) return null;

  if (usesNormalizedLayout(theme, state, file)) {
    const normalized = getNormalizedLayout(theme, state, file);
    if (!normalized) return null;
    return {
      x: bounds.x + bounds.width * normalized.leftRatio + normalized.offsetPxX,
      y: bounds.y + bounds.height
        - bounds.height * normalized.heightRatio
        - bounds.height * normalized.bottomRatio
        - normalized.offsetPxY,
      w: bounds.width * normalized.widthRatio,
      h: bounds.height * normalized.heightRatio,
    };
  }

  const layout = getFileLayout(theme, file);
  const left = bounds.x + bounds.width * layout.offsetX + layout.offsetPxX;

  if (usesObjectChannel(theme, state, file)) {
    const outerRect = {
      x: left,
      y: bounds.y + bounds.height
        - bounds.height * layout.heightRatio
        - bounds.height * layout.objBottom
        - layout.offsetPxY,
      w: bounds.width * layout.widthRatio,
      h: bounds.height * layout.heightRatio,
    };
    return fitViewBoxIntoRect(outerRect, viewBox);
  }

  const width = bounds.width * layout.imgWidthRatio * layout.fileScale;
  const height = width * (viewBox.height / viewBox.width);
  return {
    x: bounds.x + bounds.width * layout.imgOffsetX + layout.offsetPxX,
    y: bounds.y + bounds.height - height - bounds.height * layout.imgBottom - layout.offsetPxY,
    w: width,
    h: height,
  };
}

function getHitRectScreen(theme, bounds, state, file, hitBox, options = {}) {
  if (!theme || !bounds || !hitBox) return null;

  const artRect = getAssetRectScreen(theme, bounds, state, file);
  if (!artRect) return null;

  const vb = resolveViewBox(theme, state, file);
  if (!vb) return null;
  const scaleX = artRect.w / vb.width;
  const scaleY = artRect.h / vb.height;
  const padX = options.padX || 0;
  const padY = options.padY || 0;

  return {
    left: artRect.x + (hitBox.x - vb.x) * scaleX - padX,
    top: artRect.y + (hitBox.y - vb.y) * scaleY - padY,
    right: artRect.x + (hitBox.x - vb.x + hitBox.w) * scaleX + padX,
    bottom: artRect.y + (hitBox.y - vb.y + hitBox.h) * scaleY + padY,
  };
}

function getContentRectScreen(theme, bounds, state, file, options = {}) {
  const box = options.box || (theme && theme.layout && theme.layout.contentBox);
  if (!theme || !bounds || !box) return null;

  const artRect = getAssetRectScreen(theme, bounds, state, file);
  if (!artRect) return null;

  const vb = resolveViewBox(theme, state, file);
  if (!vb) return null;
  const scaleX = artRect.w / vb.width;
  const scaleY = artRect.h / vb.height;

  return {
    left: artRect.x + (box.x - vb.x) * scaleX,
    top: artRect.y + (box.y - vb.y) * scaleY,
    right: artRect.x + (box.x - vb.x + box.width) * scaleX,
    bottom: artRect.y + (box.y - vb.y + box.height) * scaleY,
  };
}

// Screen position of a point given in viewBox units — the exact inverse of
// getAssetPointerPayload() below, which maps a screen point back into the
// viewBox. Lets main-process callers ask "where on screen is the spot the theme
// declared at (cx, cy)?" without duplicating the asset-rect math.
function getViewBoxPointScreen(theme, bounds, state, file, point) {
  if (!theme || !bounds || !point) return null;
  const artRect = getAssetRectScreen(theme, bounds, state, file);
  const vb = resolveViewBox(theme, state, file);
  if (!artRect || !vb || !(vb.width > 0) || !(vb.height > 0)) return null;
  const x = artRect.x + (point.x - vb.x) * (artRect.w / vb.width);
  const y = artRect.y + (point.y - vb.y) * (artRect.h / vb.height);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function getAssetPointerPayload(theme, bounds, state, file, point) {
  if (!theme || !bounds || !point) return null;

  const artRect = getAssetRectScreen(theme, bounds, state, file);
  const vb = resolveViewBox(theme, state, file);
  if (!artRect || !vb || artRect.w <= 0 || artRect.h <= 0) return null;

  return {
    x: vb.x + ((point.x - artRect.x) / artRect.w) * vb.width,
    y: vb.y + ((point.y - artRect.y) / artRect.h) * vb.height,
    inside: point.x >= artRect.x
      && point.x <= artRect.x + artRect.w
      && point.y >= artRect.y
      && point.y <= artRect.y + artRect.h,
  };
}

module.exports = {
  getAssetRectScreen,
  getAssetPointerPayload,
  getViewBoxPointScreen,
  getContentRectScreen,
  getHitRectScreen,
  resolveViewBox,
  usesObjectChannel,
  usesNormalizedLayout,
};
