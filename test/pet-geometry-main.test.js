"use strict";

const test = require("node:test");
const assert = require("node:assert");

const createPetGeometryMain = require("../src/pet-geometry-main");

const BOUNDS = { x: 10, y: 20, width: 120, height: 90 };
const THEME = {
  _id: "theme-a",
  states: {
    idle: ["idle.svg"],
  },
};

function createHarness(overrides = {}) {
  const calls = [];
  const hitGeometry = {
    getAssetRectScreen: (...args) => {
      calls.push(["getAssetRectScreen", ...args]);
      return overrides.assetRect === undefined ? { x: 11, y: 22, w: 33, h: 44 } : overrides.assetRect;
    },
    getAssetPointerPayload: (...args) => {
      calls.push(["getAssetPointerPayload", ...args]);
      return overrides.pointerPayload === undefined ? { x: 0.4, y: 0.6 } : overrides.pointerPayload;
    },
    getHitRectScreen: (...args) => {
      calls.push(["getHitRectScreen", ...args]);
      return overrides.hitRect === undefined
        ? { left: 12, top: 24, right: 88, bottom: 96 }
        : overrides.hitRect;
    },
  };
  const getThemeMarginBox = (theme) => {
    calls.push(["getThemeMarginBox", theme]);
    return overrides.marginBox === undefined ? { x: 1, y: 2, width: 3, height: 4 } : overrides.marginBox;
  };
  const computeThemeAnchorRect = (...args) => {
    calls.push(["computeThemeAnchorRect", ...args]);
    if (overrides.anchorResults && overrides.anchorResults.length) {
      return overrides.anchorResults.shift();
    }
    return overrides.anchorResult === undefined
      ? { left: 20, top: 30, right: 80, bottom: 90 }
      : overrides.anchorResult;
  };
  const runtime = createPetGeometryMain({
    hitGeometry,
    getThemeMarginBox,
    computeThemeAnchorRect,
    getActiveTheme: () => overrides.theme === undefined ? THEME : overrides.theme,
    getCurrentState: () => overrides.state || "thinking",
    getCurrentSvg: () => overrides.svg === undefined ? "thinking.svg" : overrides.svg,
    getCurrentHitBox: () => overrides.hitBox || { left: 1, top: 2, right: 3, bottom: 4 },
    getCurrentAccessoryPayload: () => overrides.accessoryPayload || null,
    getMiniMode: () => !!overrides.miniMode,
    getMiniPeekOffset: () => overrides.miniPeekOffset || 18,
  });
  return { calls, runtime };
}

test("getObjRect delegates asset rect calculation and falls back to the full window", () => {
  const delegated = createHarness();
  assert.deepStrictEqual(delegated.runtime.getObjRect(BOUNDS), { x: 11, y: 22, w: 33, h: 44 });
  assert.deepStrictEqual(delegated.calls[0], [
    "getAssetRectScreen",
    THEME,
    BOUNDS,
    "thinking",
    "thinking.svg",
  ]);

  const fallback = createHarness({ assetRect: null });
  assert.deepStrictEqual(fallback.runtime.getObjRect(BOUNDS), {
    x: 10,
    y: 20,
    w: 120,
    h: 90,
  });
});

test("getObjRect falls back from missing current SVG to idle and tolerates malformed idle state", () => {
  const idleFallback = createHarness({ svg: null });
  assert.deepStrictEqual(idleFallback.runtime.getObjRect(BOUNDS), { x: 11, y: 22, w: 33, h: 44 });
  assert.deepStrictEqual(idleFallback.calls[0], [
    "getAssetRectScreen",
    THEME,
    BOUNDS,
    "thinking",
    "idle.svg",
  ]);

  const malformedIdle = createHarness({ theme: { _id: "broken", states: {} }, svg: null, assetRect: null });
  assert.deepStrictEqual(malformedIdle.runtime.getObjRect(BOUNDS), {
    x: 10,
    y: 20,
    w: 120,
    h: 90,
  });
  assert.strictEqual(malformedIdle.calls[0][4], null);
});

test("getAssetPointerPayload delegates with current file and returns null without a theme", () => {
  const point = { x: 50, y: 60 };
  const delegated = createHarness();
  assert.deepStrictEqual(delegated.runtime.getAssetPointerPayload(BOUNDS, point), { x: 0.4, y: 0.6 });
  assert.deepStrictEqual(delegated.calls[0], [
    "getAssetPointerPayload",
    THEME,
    BOUNDS,
    "thinking",
    "thinking.svg",
    point,
  ]);

  const missingTheme = createHarness({ theme: null });
  assert.strictEqual(missingTheme.runtime.getAssetPointerPayload(BOUNDS, point), null);
  assert.deepStrictEqual(missingTheme.calls, []);

  const missingPoint = createHarness();
  assert.strictEqual(missingPoint.runtime.getAssetPointerPayload(BOUNDS, null), null);
  assert.deepStrictEqual(missingPoint.calls, []);
});

test("getHitRectScreen passes hitbox and mini padding, with a full-window fallback", () => {
  const mini = createHarness({ miniMode: true, miniPeekOffset: 24 });
  assert.deepStrictEqual(mini.runtime.getHitRectScreen(BOUNDS), {
    left: 12,
    top: 24,
    right: 88,
    bottom: 96,
  });
  assert.deepStrictEqual(mini.calls[0], [
    "getHitRectScreen",
    THEME,
    BOUNDS,
    "thinking",
    "thinking.svg",
    { left: 1, top: 2, right: 3, bottom: 4 },
    { padX: 24, padY: 8 },
  ]);

  const fallback = createHarness({ hitRect: null });
  assert.deepStrictEqual(fallback.runtime.getHitRectScreen(BOUNDS), {
    left: 10,
    top: 20,
    right: 130,
    bottom: 110,
  });

  const normal = createHarness({ miniMode: false });
  normal.runtime.getHitRectScreen(BOUNDS);
  assert.deepStrictEqual(normal.calls[0][6], { padX: 0, padY: 0 });
  assert.strictEqual(normal.runtime.getHitRectScreen(null), null);
});

test("getHitRectScreen expands only for the currently selected accessory", () => {
  const theme = {
    ...THEME,
    customization: {
      accessories: {
        files: {
          "thinking.svg": {
            staticFrame: { cx: 8, baseY: 4, width: 16 },
            hitBoxPadding: { left: 1, top: 2, right: 1, bottom: 1 },
          },
        },
      },
    },
  };
  const selected = createHarness({
    theme,
    hitBox: { x: 0, y: 5, w: 16, h: 12 },
    accessoryPayload: {
      id: "party-hat",
      assetFile: "party-hat.svg",
      aspect: 11 / 14,
      widthScale: 0.7,
      offsetY: 0.3,
    },
  });
  selected.runtime.getHitRectScreen(BOUNDS);
  assert.deepStrictEqual(selected.calls[0][5], {
    x: 0,
    y: -11.954545454545453,
    w: 16,
    h: 28.954545454545453,
  });

  const none = createHarness({
    theme,
    hitBox: { x: 0, y: 5, w: 16, h: 12 },
    accessoryPayload: {
      id: "none", assetFile: null, aspect: 1, widthScale: 1, offsetY: 0,
    },
  });
  none.runtime.getHitRectScreen(BOUNDS);
  assert.deepStrictEqual(none.calls[0][5], { x: 0, y: 5, w: 16, h: 12 });
});

test("getUpdateBubbleAnchorRect prefers stable anchors, then current-file anchors, then hit rect", () => {
  const stable = createHarness();
  assert.deepStrictEqual(stable.runtime.getUpdateBubbleAnchorRect(BOUNDS), {
    left: 20,
    top: 30,
    right: 80,
    bottom: 90,
  });
  assert.deepStrictEqual(stable.calls, [
    ["computeThemeAnchorRect", THEME, BOUNDS],
  ]);

  const currentFile = createHarness({
    anchorResults: [
      null,
      { left: 30, top: 40, right: 90, bottom: 100 },
    ],
  });
  assert.deepStrictEqual(currentFile.runtime.getUpdateBubbleAnchorRect(BOUNDS), {
    left: 30,
    top: 40,
    right: 90,
    bottom: 100,
  });
  assert.deepStrictEqual(currentFile.calls, [
    ["computeThemeAnchorRect", THEME, BOUNDS],
    ["getThemeMarginBox", THEME],
    [
      "computeThemeAnchorRect",
      THEME,
      BOUNDS,
      { box: { x: 1, y: 2, width: 3, height: 4 }, state: "thinking", file: "thinking.svg" },
    ],
  ]);

  const fallback = createHarness({ anchorResults: [null, null] });
  assert.deepStrictEqual(fallback.runtime.getUpdateBubbleAnchorRect(BOUNDS), {
    left: 12,
    top: 24,
    right: 88,
    bottom: 96,
  });
  assert.strictEqual(fallback.calls[fallback.calls.length - 1][0], "getHitRectScreen");

  const noBounds = createHarness();
  assert.strictEqual(noBounds.runtime.getUpdateBubbleAnchorRect(null), null);
  assert.deepStrictEqual(noBounds.calls, []);
});

test("getSessionHudAnchorRect uses the theme margin box and returns null when unavailable", () => {
  const anchored = createHarness();
  assert.deepStrictEqual(anchored.runtime.getSessionHudAnchorRect(BOUNDS), {
    left: 20,
    top: 30,
    right: 80,
    bottom: 90,
  });
  assert.deepStrictEqual(anchored.calls, [
    ["getThemeMarginBox", THEME],
    ["computeThemeAnchorRect", THEME, BOUNDS, { box: { x: 1, y: 2, width: 3, height: 4 } }],
  ]);

  const noBox = createHarness({ marginBox: null });
  assert.strictEqual(noBox.runtime.getSessionHudAnchorRect(BOUNDS), null);

  const noBounds = createHarness();
  assert.strictEqual(noBounds.runtime.getSessionHudAnchorRect(null), null);
  assert.deepStrictEqual(noBounds.calls, []);
});
