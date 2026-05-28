"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const usageHover = require("../src/usage-hover");
const {
  computeUsageHoverBounds,
  formatCompactNumber,
  formatDuration,
  constants,
} = usageHover.__test;

describe("usage hover geometry", () => {
  it("positions the card above the pet and clamps to the work area", () => {
    const result = computeUsageHoverBounds({
      hitRect: { left: 40, top: 120, right: 160, bottom: 240 },
      workArea: { x: 0, y: 0, width: 300, height: 400 },
      width: constants.HOVER_WIDTH,
      height: constants.HOVER_HEIGHT,
    });

    assert.deepStrictEqual(result.bounds, {
      x: constants.EDGE_MARGIN,
      y: 120 - constants.HOVER_GAP - constants.HOVER_HEIGHT,
      width: constants.HOVER_WIDTH,
      height: constants.HOVER_HEIGHT,
    });
    assert.equal(result.flippedBelow, false);
  });

  it("flips below the pet when there is not enough room above", () => {
    const result = computeUsageHoverBounds({
      hitRect: { left: 200, top: 10, right: 300, bottom: 90 },
      workArea: { x: 0, y: 0, width: 480, height: 360 },
      width: constants.HOVER_WIDTH,
      height: constants.HOVER_HEIGHT,
    });

    assert.equal(result.bounds.y, 90 + constants.HOVER_GAP);
    assert.equal(result.flippedBelow, true);
  });
});

describe("usage hover formatting and copy", () => {
  it("keeps hover values compact", () => {
    assert.equal(formatCompactNumber(0), "0");
    assert.equal(formatCompactNumber(1200), "1.2K");
    assert.equal(formatCompactNumber(1520000), "1.5M");
    assert.equal(formatDuration(0), "0m");
    assert.equal(formatDuration(62 * 60 * 1000), "1h 2m");
    assert.equal(formatDuration(42 * 1000), "1m");
  });

  it("keeps labels minimal and omits redundant section text", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "src", "usage-hover.html"), "utf8");
    const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "usage-hover-renderer.js"), "utf8");

    assert.match(html, /Tokens/);
    assert.match(html, /Session/);
    assert.doesNotMatch(`${html}\n${renderer}`, /Tokens \+ Time/);
    assert.doesNotMatch(`${html}\n${renderer}`, /reported tokens/i);
  });
});
