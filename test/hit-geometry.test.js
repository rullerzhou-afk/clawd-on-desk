const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const themeLoader = require("../src/theme-loader");
const hitGeometry = require("../src/hit-geometry");

themeLoader.init(path.join(__dirname, "..", "src"));
const calico = themeLoader.loadTheme("calico");
const clawd = themeLoader.loadTheme("clawd");

function approx(actual, expected, epsilon = 0.01) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function visibleContentRect(theme, artRect) {
  const box = theme.layout.contentBox;
  const sx = artRect.w / theme.viewBox.width;
  const sy = artRect.h / theme.viewBox.height;
  return {
    x: artRect.x + (box.x - theme.viewBox.x) * sx,
    y: artRect.y + (box.y - theme.viewBox.y) * sy,
    w: box.width * sx,
    h: box.height * sy,
    bottom: artRect.y + (box.y - theme.viewBox.y + box.height) * sy,
  };
}

describe("hit geometry", () => {
  const bounds = { x: 0, y: 0, width: 200, height: 200 };

  it("matches bottom-anchored SVG layout for calico idle", () => {
    const rect = hitGeometry.getAssetRectScreen(calico, bounds, "idle", "calico-idle-follow.svg");
    approx(rect.x, 35.94);
    approx(rect.y, 119.51);
    approx(rect.w, 118.12);
    approx(rect.h, 88.81);
  });

  it("applies calico idle-follow file offsets on top of normalized layout without changing body scale", () => {
    const shiftedTheme = structuredClone(calico);
    delete shiftedTheme.objectScale.fileOffsets["calico-idle-follow.svg"];

    const baselineArt = hitGeometry.getAssetRectScreen(
      shiftedTheme,
      bounds,
      "idle",
      "calico-idle-follow.svg"
    );
    const calicoArt = hitGeometry.getAssetRectScreen(calico, bounds, "idle", "calico-idle-follow.svg");
    const baselineVisible = visibleContentRect(shiftedTheme, baselineArt);
    const calicoVisible = visibleContentRect(calico, calicoArt);

    approx(calicoArt.x, baselineArt.x - 5, 0.01);
    approx(calicoArt.y, baselineArt.y + 5, 0.01);
    approx(calicoVisible.bottom, baselineVisible.bottom + 5, 0.01);
    approx(calicoVisible.h, baselineVisible.h, 0.01);
  });

  it("keeps critical calico non-loop animations inside the window bottom edge", () => {
    const files = [
      "calico-react-drag.apng",
      "calico-working-carrying.apng",
      "calico-error.apng",
    ];

    for (const file of files) {
      const rect = hitGeometry.getAssetRectScreen(calico, bounds, null, file);
      assert.ok(
        rect.y + rect.h <= bounds.height,
        `${file} bottom overflowed: ${rect.y + rect.h}`
      );
    }
  });

  it("matches APNG layout with file scale and offsets for calico mini idle", () => {
    const rect = hitGeometry.getAssetRectScreen(calico, bounds, "mini-idle", "calico-mini-idle.apng");
    approx(rect.x, 42);
    approx(rect.y, 21.24);
    approx(rect.w, 138);
    approx(rect.h, 103.76);
  });

  it("expands mini hit rect with sticky hover padding", () => {
    const hitBox = calico.hitBoxes.default;
    const base = hitGeometry.getHitRectScreen(calico, bounds, "mini-idle", "calico-mini-idle.apng", hitBox);
    const padded = hitGeometry.getHitRectScreen(
      calico,
      bounds,
      "mini-idle",
      "calico-mini-idle.apng",
      hitBox,
      { padX: 25, padY: 8 }
    );

    approx(padded.left, base.left - 25);
    approx(padded.right, base.right + 25);
    approx(padded.top, base.top - 8);
    approx(padded.bottom, base.bottom + 8);
  });

  it("derives image sizing from object fit for clawd drag svg", () => {
    const rect = hitGeometry.getAssetRectScreen(clawd, bounds, null, "clawd-react-drag.svg");
    approx(rect.x, -30.5);
    approx(rect.y, -53.6);
    approx(rect.w, 261);
    approx(rect.h, 261);
  });

  it("derives the visible content rect from contentBox geometry", () => {
    const artRect = hitGeometry.getAssetRectScreen(clawd, bounds, "idle", "clawd-idle-follow.svg");
    const expected = visibleContentRect(clawd, artRect);
    const actual = hitGeometry.getContentRectScreen(clawd, bounds, "idle", "clawd-idle-follow.svg");

    approx(actual.left, expected.x);
    approx(actual.top, expected.y);
    approx(actual.right, expected.x + expected.w);
    approx(actual.bottom, expected.bottom);
  });

  it("resolves root, mini, and per-file viewBoxes in priority order", () => {
    const rootViewBox = { x: -32, y: -24, width: 88, height: 72 };
    const miniViewBox = { x: -12, y: -12, width: 48, height: 48 };
    const theme = {
      viewBox: rootViewBox,
      miniMode: { viewBox: miniViewBox },
      fileViewBoxes: {
        "cloudling-mini-crabwalk.svg": rootViewBox,
      },
    };

    assert.deepStrictEqual(
      hitGeometry.resolveViewBox(theme, "working", "cloudling-building.svg"),
      rootViewBox
    );
    assert.deepStrictEqual(
      hitGeometry.resolveViewBox(theme, "mini-idle", "cloudling-mini-idle.svg"),
      miniViewBox
    );
    assert.deepStrictEqual(
      hitGeometry.resolveViewBox(theme, "mini-crabwalk", "cloudling-mini-crabwalk.svg"),
      rootViewBox
    );
  });

  it("uses normal layout for mini-named files that explicitly override to the root viewBox", () => {
    const rootViewBox = { x: -32, y: -24, width: 88, height: 72 };
    const theme = {
      viewBox: rootViewBox,
      miniMode: { viewBox: { x: -12, y: -12, width: 48, height: 48 } },
      fileViewBoxes: {
        "cloudling-mini-crabwalk.svg": rootViewBox,
      },
      layout: {
        contentBox: { x: 0, y: 0, width: 24, height: 24 },
        centerX: 12,
        baselineY: 24,
        centerXRatio: 0.5,
        baselineBottomRatio: 0.05,
        visibleHeightRatio: 0.58,
      },
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0, objBottom: 0.05 },
      eyeTracking: { enabled: false, states: [] },
      trustedRuntime: { scriptedSvgFiles: ["cloudling-mini-crabwalk.svg"] },
      _builtin: true,
    };

    assert.strictEqual(
      hitGeometry.usesNormalizedLayout(theme, "mini-crabwalk", "cloudling-mini-crabwalk.svg"),
      true
    );
    assert.strictEqual(
      hitGeometry.usesNormalizedLayout(theme, "mini-idle", "cloudling-mini-idle.svg"),
      false
    );

    const rect = hitGeometry.getAssetRectScreen(
      theme,
      bounds,
      "mini-crabwalk",
      "cloudling-mini-crabwalk.svg"
    );

    approx(rect.w, 425.33);
    approx(rect.h, 348);
  });

  it("uses trusted built-in scripted SVGs as object-channel geometry without treating external data as trusted", () => {
    const trustedTheme = {
      _builtin: true,
      viewBox: { x: -32, y: -24, width: 88, height: 72 },
      miniMode: { viewBox: { x: -12, y: -12, width: 48, height: 48 } },
      fileViewBoxes: {},
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0, objBottom: 0 },
      eyeTracking: { enabled: false, states: [] },
      trustedRuntime: { scriptedSvgFiles: ["cloudling-building.svg"] },
    };
    const externalTheme = {
      ...trustedTheme,
      _builtin: false,
      trustedRuntime: { scriptedSvgFiles: ["cloudling-building.svg"] },
    };

    assert.strictEqual(
      hitGeometry.usesObjectChannel(trustedTheme, "working", "cloudling-building.svg"),
      true
    );
    assert.strictEqual(
      hitGeometry.usesObjectChannel(externalTheme, "working", "cloudling-building.svg"),
      false
    );

    const rect = hitGeometry.getAssetRectScreen(
      trustedTheme,
      bounds,
      "working",
      "cloudling-building.svg"
    );

    approx(rect.x, 0);
    approx(rect.y, 18.18);
    approx(rect.w, 200);
    approx(rect.h, 163.64);
  });

  it("keeps ordinary external SVG themes on the legacy non-object path by default", () => {
    const theme = {
      _builtin: false,
      viewBox: { x: 0, y: 0, width: 192, height: 208 },
      fileViewBoxes: {},
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0, objBottom: 0 },
      eyeTracking: { enabled: false, states: [] },
      trustedRuntime: { scriptedSvgFiles: [] },
      rendering: { svgChannel: "auto" },
    };

    assert.strictEqual(
      hitGeometry.usesObjectChannel(theme, "idle", "ordinary-idle.svg"),
      false
    );
  });

  it("uses object-channel geometry for an explicitly listed SVG basename only", () => {
    const theme = {
      _builtin: false,
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      fileViewBoxes: {},
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0, objBottom: 0 },
      eyeTracking: { enabled: false, states: [] },
      trustedRuntime: { scriptedSvgFiles: [] },
      rendering: {
        svgChannel: "auto",
        objectChannelFiles: ["animated.svg"],
      },
    };

    assert.strictEqual(hitGeometry.usesObjectChannel(theme, "idle", "animated.svg"), true);
    assert.strictEqual(hitGeometry.usesObjectChannel(theme, "idle", "nested/animated.svg"), true);
    assert.strictEqual(hitGeometry.usesObjectChannel(theme, "idle", "ordinary.svg"), false);
  });

  it("uses object-channel geometry when the selected accessory follows an SVG target", () => {
    const theme = {
      _builtin: false,
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      eyeTracking: { enabled: false, states: [] },
      rendering: { svgChannel: "auto" },
      customization: {
        mouthAccessories: {
          files: {
            "animated.svg": {
              staticFrame: { cx: 10, baseY: 10, width: 5 },
              followTarget: {
                id: "mouth-anchor",
                frame: { cx: 2, baseY: 2, width: 1 },
              },
            },
          },
        },
      },
    };

    assert.strictEqual(hitGeometry.usesObjectChannel(theme, "idle", "animated.svg"), false);
    assert.strictEqual(hitGeometry.usesObjectChannel(theme, "idle", "animated.svg", {
      accessoryPayloads: { mouth: { id: "cigarette" } },
    }), true);
  });

  it("uses object-channel geometry when a theme forces SVG object rendering", () => {
    const theme = {
      _builtin: false,
      viewBox: { x: 0, y: 0, width: 192, height: 208 },
      fileViewBoxes: {},
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0, objBottom: 0 },
      eyeTracking: { enabled: false, states: [] },
      trustedRuntime: { scriptedSvgFiles: [] },
      rendering: { svgChannel: "object" },
    };

    assert.strictEqual(
      hitGeometry.usesObjectChannel(theme, "idle", "codex-pet-idle-loop.svg"),
      true
    );

    const rect = hitGeometry.getAssetRectScreen(
      theme,
      bounds,
      "idle",
      "codex-pet-idle-loop.svg"
    );

    approx(rect.x, 7.69);
    approx(rect.y, 0);
    approx(rect.w, 184.62);
    approx(rect.h, 200);
  });

  it("maps screen cursor points into the active asset viewBox for pointer bridge payloads", () => {
    const theme = {
      _builtin: true,
      viewBox: { x: -32, y: -24, width: 88, height: 72 },
      miniMode: { viewBox: { x: -12, y: -12, width: 48, height: 48 } },
      fileViewBoxes: {},
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0, objBottom: 0 },
      eyeTracking: { enabled: false, states: [] },
      trustedRuntime: { scriptedSvgFiles: ["cloudling-mini-idle.svg"] },
    };
    const rect = hitGeometry.getAssetRectScreen(
      theme,
      bounds,
      "mini-idle",
      "cloudling-mini-idle.svg"
    );
    const payload = hitGeometry.getAssetPointerPayload(
      theme,
      bounds,
      "mini-idle",
      "cloudling-mini-idle.svg",
      { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
    );
    const outside = hitGeometry.getAssetPointerPayload(
      theme,
      bounds,
      "mini-idle",
      "cloudling-mini-idle.svg",
      { x: rect.x - 1, y: rect.y + rect.h / 2 }
    );

    approx(payload.x, 12);
    approx(payload.y, 12);
    assert.strictEqual(payload.inside, true);
    assert.strictEqual(outside.inside, false);
  });
});
