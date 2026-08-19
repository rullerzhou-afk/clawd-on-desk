"use strict";

const defaultHitGeometry = require("./hit-geometry");
const {
  getThemeMarginBox: defaultGetThemeMarginBox,
  computeThemeAnchorRect: defaultComputeThemeAnchorRect,
} = require("./visible-margins");

function createPetGeometryMain(options = {}) {
  const hitGeometry = options.hitGeometry || defaultHitGeometry;
  const getThemeMarginBox = options.getThemeMarginBox || defaultGetThemeMarginBox;
  const computeThemeAnchorRect = options.computeThemeAnchorRect || defaultComputeThemeAnchorRect;
  const getActiveTheme = options.getActiveTheme || (() => null);
  const getCurrentState = options.getCurrentState || (() => null);
  const getCurrentSvg = options.getCurrentSvg || (() => null);
  const getCurrentHitBox = options.getCurrentHitBox || (() => null);
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

  function getObjRect(bounds) {
    if (!bounds) return null;
    const theme = getActiveTheme();
    const state = getCurrentState();
    const file = getCurrentFile(theme);
    return hitGeometry.getAssetRectScreen(theme, bounds, state, file)
      || getFullAssetRect(bounds);
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
    const hit = hitGeometry.getHitRectScreen(
      theme,
      bounds,
      state,
      file,
      getCurrentHitBox(),
      {
        padX: miniMode ? getMiniPeekOffset() : 0,
        padY: miniMode ? 8 : 0,
      }
    );
    return hit || getFullHitRect(bounds);
  }

  // Where the AVATAR's middle is on screen — not the window's.
  //
  // The pet window is a rectangle sized for the widest pose the theme has; the
  // sprite inside it is neither centered nor full-bleed (clawd's art sits at
  // centerX 7.5 in a viewBox that spans -15..30). Anything that has to point AT
  // the pet — the peteleco aim projection — must start from the art, or the
  // line visibly misses the character.
  //
  // The mapping already exists and is the same one the accessory system uses:
  // `layout.centerX` is the theme's declared horizontal center (identical to
  // each accessory staticFrame's `cx` in every built-in theme). There is no
  // declared vertical center — `layout.baselineY` is the ground line, i.e. the
  // feet — so the visible contentBox's own middle supplies Y.
  //
  // Falls back to the hit rect and then the raw window, so a theme with no
  // layout block still gets a usable point instead of null.
  function getPetVisualCenter(bounds) {
    if (!bounds) return null;
    const theme = getActiveTheme();
    const layout = theme && theme.layout;
    const box = layout && layout.contentBox;
    if (box && typeof hitGeometry.getViewBoxPointScreen === "function") {
      const centerX = Number.isFinite(layout.centerX)
        ? layout.centerX
        : box.x + box.width / 2;
      const point = hitGeometry.getViewBoxPointScreen(
        theme,
        bounds,
        getCurrentState(),
        getCurrentFile(theme),
        { x: centerX, y: box.y + box.height / 2 }
      );
      if (point) return point;
    }
    const hit = getHitRectScreen(bounds);
    if (hit) {
      return {
        x: (hit.left + hit.right) / 2,
        y: (hit.top + hit.bottom) / 2,
      };
    }
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
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
    getPetVisualCenter,
    getUpdateBubbleAnchorRect,
    getSessionHudAnchorRect,
  };
}

module.exports = createPetGeometryMain;
