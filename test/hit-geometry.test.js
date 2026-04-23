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
});
