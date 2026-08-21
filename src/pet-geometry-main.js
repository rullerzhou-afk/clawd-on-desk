"use strict";

const defaultHitGeometry = require("./hit-geometry");
const {
  getThemeMarginBox: defaultGetThemeMarginBox,
  computeThemeAnchorRect: defaultComputeThemeAnchorRect,
} = require("./visible-margins");
const { resolveAccessoryAwareHitBox } = require("./pet-accessory-hitbox");
const { getPetAccessoryPayloadSnapshot } = require("./pet-accessory-state");

function createPetGeometryMain(options = {}) {
  const hitGeometry = options.hitGeometry || defaultHitGeometry;
  const getThemeMarginBox = options.getThemeMarginBox || defaultGetThemeMarginBox;
  const computeThemeAnchorRect = options.computeThemeAnchorRect || defaultComputeThemeAnchorRect;
  const getActiveTheme = options.getActiveTheme || (() => null);
  const getCurrentState = options.getCurrentState || (() => null);
  const getCurrentSvg = options.getCurrentSvg || (() => null);
  const getCurrentHitBox = options.getCurrentHitBox || (() => null);
  const getCurrentAccessoryPayload = options.getCurrentAccessoryPayload || (() => null);
  const getAccessoryMirrored = options.getAccessoryMirrored || (() => false);
  const getMiniMode = options.getMiniMode || (() => false);
  const getMiniPeekOffset = options.getMiniPeekOffset || (() => 0);

  function getCurrentFile(theme) {
    return getCurrentSvg()
      || (theme && theme.states && theme.states.idle && theme.states.idle[0])
      || null;
  }

  function getFullAssetRect(bounds) {
    return { x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height };
  }

  function getFullHitRect(bounds) {
    return {
      left: bounds.x,
      top: bounds.y,
      right: bounds.x + bounds.width,
      bottom: bounds.y + bounds.height,
    };
  }

  function outwardRound(rect) {
    if (!rect || ![rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)) return rect;
    return {
      left: Math.floor(rect.left),
      top: Math.floor(rect.top),
      right: Math.ceil(rect.right),
      bottom: Math.ceil(rect.bottom),
    };
  }

  function getCanonicalAccessoryPayload(theme) {
    const current = getPetAccessoryPayloadSnapshot(theme);
    // Renderer config/theme reload normally commits before geometry runs. The
    // fallback is read-only for startup/theme-swap resilience — see main.js's
    // getEffectivePetAccessoryPayload, which must stay on the non-committing
    // builder so a hit-window sync can never install a payload of its own.
    return current ? current.payload : getCurrentAccessoryPayload();
  }

  function getObjRect(bounds) {
    if (!bounds) return null;
    const theme = getActiveTheme();
    const state = getCurrentState();
    const file = getCurrentFile(theme);
    return hitGeometry.getAssetRectScreen(theme, bounds, state, file) || getFullAssetRect(bounds);
  }

  function getAssetPointerPayload(bounds, point) {
    if (!bounds || !point) return null;
    const theme = getActiveTheme();
    if (!theme) return null;
    const state = getCurrentState();
    const file = getCurrentFile(theme);
    return hitGeometry.getAssetPointerPayload(theme, bounds, state, file, point);
  }

  function getHitRectScreen(bounds) {
    if (!bounds) return null;
    const theme = getActiveTheme();
    const state = getCurrentState();
    const file = getCurrentFile(theme);
    const miniMode = !!getMiniMode();
    // Reported by the renderer (see applyMiniFlip). Deriving it here from mini
    // edge + theme flags missed free roam and the mini walk-in, neither of
    // which is gated on miniMode.
    const mirrorX = !!getAccessoryMirrored();
    const resolveViewBox = typeof hitGeometry.resolveViewBox === "function"
      ? hitGeometry.resolveViewBox
      : defaultHitGeometry.resolveViewBox;
    const viewBox = resolveViewBox(theme, state, file);
    const hitBox = resolveAccessoryAwareHitBox(
      theme,
      state,
      file,
      getCurrentHitBox(),
      getCanonicalAccessoryPayload(theme),
      { viewBox, mirrorX }
    );
    const hit = hitGeometry.getHitRectScreen(
      theme,
      bounds,
      state,
      file,
      hitBox,
      {
        padX: miniMode ? getMiniPeekOffset() : 0,
        padY: miniMode ? 8 : 0,
      }
    );
    return outwardRound(hit) || getFullHitRect(bounds);
  }

  function getUpdateBubbleAnchorRect(bounds) {
    if (!bounds) return getHitRectScreen(bounds);
    const theme = getActiveTheme();
    if (!theme) return getHitRectScreen(bounds);

    const stableAnchor = computeThemeAnchorRect(theme, bounds);
    if (stableAnchor) return stableAnchor;

    const box = getThemeMarginBox(theme);
    const currentFile = getCurrentSvg();
    if (box && currentFile) {
      const currentAnchor = computeThemeAnchorRect(theme, bounds, {
        box,
        state: getCurrentState(),
        file: currentFile,
      });
      if (currentAnchor) return currentAnchor;
    }

    return getHitRectScreen(bounds);
  }

  function getSessionHudAnchorRect(bounds) {
    if (!bounds) return null;
    const theme = getActiveTheme();
    if (!theme) return null;
    const box = getThemeMarginBox(theme);
    if (!box) return null;
    return computeThemeAnchorRect(theme, bounds, { box });
  }

  return {
    getObjRect,
    getAssetPointerPayload,
    getHitRectScreen,
    getUpdateBubbleAnchorRect,
    getSessionHudAnchorRect,
  };
}

module.exports = createPetGeometryMain;
