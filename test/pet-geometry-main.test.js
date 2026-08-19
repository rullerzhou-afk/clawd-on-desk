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
    ...(overrides.omitViewBoxPointScreen ? {} : {
      getViewBoxPointScreen: (...args) => {
        calls.push(["getViewBoxPointScreen", ...args]);
        return overrides.viewBoxPoint === undefined ? { x: 55, y: 66 } : overrides.viewBoxPoint;
      },
    }),
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

test("getPetVisualCenter asks the theme where the avatar's middle is, not the window's", () => {
  const layoutTheme = {
    ...THEME,
    layout: { contentBox: { x: -4, y: -3, width: 23, height: 20 }, centerX: 7.5 },
  };
  const h = createHarness({ theme: layoutTheme });
  assert.deepStrictEqual(h.runtime.getPetVisualCenter(BOUNDS), { x: 55, y: 66 });

  const call = h.calls.find((c) => c[0] === "getViewBoxPointScreen");
  assert.ok(call, "the visual center must go through the viewBox mapping");
  // centerX wins over the contentBox's own midpoint: it is the value the theme
  // declares as the center, and the same one the accessory frames use.
  assert.deepStrictEqual(call[5], { x: 7.5, y: 7 });
});

test("getPetVisualCenter uses the contentBox midpoint when the theme declares no centerX", () => {
  const layoutTheme = {
    ...THEME,
    layout: { contentBox: { x: 0, y: 0, width: 24, height: 24 } },
  };
  const h = createHarness({ theme: layoutTheme });
  h.runtime.getPetVisualCenter(BOUNDS);
  const call = h.calls.find((c) => c[0] === "getViewBoxPointScreen");
  assert.deepStrictEqual(call[5], { x: 12, y: 12 });
});

test("getPetVisualCenter falls back to the hit rect, then to the window", () => {
  // No layout block at all — a minimal user theme.
  const noLayout = createHarness();
  assert.deepStrictEqual(noLayout.runtime.getPetVisualCenter(BOUNDS), { x: 50, y: 60 });

  // Layout present but the mapping cannot resolve (no asset rect / viewBox).
  const unresolvable = createHarness({
    theme: { ...THEME, layout: { contentBox: { x: 0, y: 0, width: 10, height: 10 } } },
    viewBoxPoint: null,
  });
  assert.deepStrictEqual(unresolvable.runtime.getPetVisualCenter(BOUNDS), { x: 50, y: 60 });

  // Neither layout nor a hit rect: the raw window is the last resort.
  const bare = createHarness({ hitRect: null, theme: null });
  assert.deepStrictEqual(bare.runtime.getPetVisualCenter(BOUNDS), { x: 70, y: 65 });

  assert.strictEqual(noLayout.runtime.getPetVisualCenter(null), null);
});

test("getPetVisualCenter survives a hitGeometry without the viewBox mapping", () => {
  const h = createHarness({
    omitViewBoxPointScreen: true,
    theme: { ...THEME, layout: { contentBox: { x: 0, y: 0, width: 10, height: 10 }, centerX: 5 } },
  });
  assert.deepStrictEqual(h.runtime.getPetVisualCenter(BOUNDS), { x: 50, y: 60 });
});

test("getPetVisualCenter lands on clawd's real sprite, which is NOT the window center", () => {
  // The regression this exists for, measured rather than assumed. Horizontally
  // the two already agree: layout.centerXRatio is 0.5, so a theme's declared
  // centerX is placed at the window's middle by construction. VERTICALLY they
  // do not — baselineBottomRatio 0.05 and visibleHeightRatio 0.58 put the
  // visible art between 37% and 95% of the window height, so its middle sits at
  // 66%, and the window's own center lands in the upper quarter of the sprite,
  // above the character's body.
  const { mergeDefaults } = require("../src/theme-schema");
  const realHitGeometry = require("../src/hit-geometry");
  const theme = mergeDefaults(JSON.parse(
    require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "themes", "clawd", "theme.json"),
      "utf8"
    )
  ));
  const runtime = createPetGeometryMain({
    hitGeometry: realHitGeometry,
    getActiveTheme: () => theme,
    getCurrentState: () => "idle",
    getCurrentSvg: () => "clawd-idle-follow.svg",
    getMiniMode: () => false,
  });

  const bounds = { x: 0, y: 0, width: 200, height: 200 };
  const center = runtime.getPetVisualCenter(bounds);
  assert.ok(center);
  assert.strictEqual(center.x, 100, "centerX already maps to the window's middle");
  assert.strictEqual(center.y, 132, "the sprite's middle is 32px below the window's");

  // And it really is the middle of the visible art, not an arbitrary offset.
  const content = realHitGeometry.getContentRectScreen(
    theme, bounds, "idle", "clawd-idle-follow.svg", {}
  );
  assert.strictEqual(center.y, (content.top + content.bottom) / 2);
  assert.ok(center.y > bounds.y && center.y < bounds.y + bounds.height);
});
