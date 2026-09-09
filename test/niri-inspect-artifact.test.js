"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  MARKER_COLORS,
  assertPathAbsent,
  cleanupCaptureTarget,
  createCaptureTarget,
  findRenderMarkerRect,
  isCompletePng,
  scanNativeImage,
  waitForCompletePng,
} = require("../src/niri-inspect-artifact");

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function minimalPng() {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IEND")]);
}

function makeNativeImage(regions, options = {}) {
  const width = options.width || 32;
  const height = options.height || 32;
  const alpha = options.alpha || 255;
  const bitmap = Buffer.alloc(width * height * 4);
  for (const region of regions) {
    const color = region.rgb || MARKER_COLORS[region.color];
    for (let y = region.y; y < region.y + region.height; y += 1) {
      for (let x = region.x; x < region.x + region.width; x += 1) {
        const offset = (y * width + x) * 4;
        bitmap[offset] = Math.round(color[2] * alpha / 255);
        bitmap[offset + 1] = Math.round(color[1] * alpha / 255);
        bitmap[offset + 2] = Math.round(color[0] * alpha / 255);
        bitmap[offset + 3] = alpha;
      }
    }
  }
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => bitmap,
  };
}

function cssRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

function cssPx(block, property) {
  const match = block.match(new RegExp(`(?:^|;)\\s*${property}:\\s*(-?\\d+(?:\\.\\d+)?)(px)?\\s*;`, "s"));
  assert.ok(match, `missing CSS pixel property: ${property}`);
  const value = Number(match[1]);
  assert.ok(value === 0 || match[2] === "px", `non-zero CSS length must use px: ${property}`);
  return value;
}

function cssValue(block, property) {
  const match = block.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+?)\\s*;`, "s"));
  assert.ok(match, `missing CSS property: ${property}`);
  return match[1].trim();
}

function cssRgb(block, property) {
  const match = block.match(new RegExp(
    `(?:^|;)\\s*${property}:\\s*rgb\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)\\s*;`,
    "s",
  ));
  assert.ok(match, `missing CSS RGB property: ${property}`);
  return match.slice(1).map(Number);
}

function cssBorder(block) {
  const match = block.match(/(?:^|;)\s*border:\s*(-?\d+(?:\.\d+)?)px\s+solid\s+rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*;/s);
  assert.ok(match, "missing CSS solid RGB border");
  return { width: Number(match[1]), color: match.slice(2).map(Number) };
}

function parseProductionMarkerStyle(css) {
  const base = cssRule(css, ".niri-inspect-marker");
  const render = cssRule(css, ".niri-inspect-marker--render");
  const renderAfter = cssRule(css, ".niri-inspect-marker--render::after");
  const hit = cssRule(css, ".niri-inspect-marker--hit");
  const hitAfter = cssRule(css, ".niri-inspect-marker--hit::after");
  const renderBorder = cssBorder(render);
  const hitBorder = cssBorder(hit);
  const width = cssPx(base, "width");
  const height = cssPx(base, "height");
  const renderCornerWidth = cssPx(renderAfter, "width");
  const renderCornerHeight = cssPx(renderAfter, "height");
  const hitCornerWidth = cssPx(hitAfter, "width");
  const hitCornerHeight = cssPx(hitAfter, "height");

  assert.equal(cssValue(base, "position"), "fixed");
  assert.equal(cssValue(base, "box-sizing"), "border-box");
  assert.equal(cssValue(renderAfter, "content"), '""');
  assert.equal(cssValue(renderAfter, "position"), "absolute");
  assert.equal(cssValue(hitAfter, "content"), '""');
  assert.equal(cssValue(hitAfter, "position"), "absolute");
  assert.ok(width > 0 && height > 0, "marker dimensions must be positive");
  assert.ok(renderCornerWidth > 0 && renderCornerHeight > 0, "render corner dimensions must be positive");
  assert.ok(hitCornerWidth > 0 && hitCornerHeight > 0, "hit corner dimensions must be positive");
  assert.ok(
    renderBorder.width > 0
      && renderBorder.width * 2 < width
      && renderBorder.width * 2 < height,
    "render border must be positive and leave a visible interior",
  );
  assert.ok(
    hitBorder.width > 0
      && hitBorder.width * 2 < width
      && hitBorder.width * 2 < height,
    "hit border must be positive and leave a visible interior",
  );
  return {
    width,
    height,
    render: {
      border: renderBorder.width,
      primary: cssRgb(render, "background"),
      corner: cssRgb(renderAfter, "background"),
      cornerWidth: renderCornerWidth,
      cornerHeight: renderCornerHeight,
      right: cssPx(renderAfter, "right"),
      bottom: cssPx(renderAfter, "bottom"),
    },
    hit: {
      border: hitBorder.width,
      primary: hitBorder.color,
      corner: cssRgb(hitAfter, "background"),
      cornerWidth: hitCornerWidth,
      cornerHeight: hitCornerHeight,
      left: cssPx(hitAfter, "left"),
      top: cssPx(hitAfter, "top"),
    },
  };
}

const MARKER_CSS = fs.readFileSync(path.join(__dirname, "../src/niri-inspect-marker.css"), "utf8");
const PRODUCTION_MARKER_STYLE = parseProductionMarkerStyle(MARKER_CSS);

function makeProductionMarkerImage(role, scale, cornerShift = 0, style = PRODUCTION_MARKER_STYLE) {
  const px = (value) => Math.max(1, Math.round(value * scale));
  const offsetPx = (value) => Math.round(value * scale);
  const origin = 6;
  const outerWidth = px(style.width);
  const outerHeight = px(style.height);
  const regions = [];
  if (role === "render") {
    const border = px(style.render.border);
    const innerWidth = outerWidth - border * 2;
    const innerHeight = outerHeight - border * 2;
    const cornerWidth = px(style.render.cornerWidth);
    const cornerHeight = px(style.render.cornerHeight);
    regions.push({
      rgb: style.render.primary,
      x: origin + border,
      y: origin + border,
      width: innerWidth,
      height: innerHeight,
    });
    regions.push({
      rgb: style.render.corner,
      x: origin + outerWidth - border - cornerWidth - offsetPx(style.render.right) + cornerShift,
      y: origin + outerHeight - border - cornerHeight - offsetPx(style.render.bottom) + cornerShift,
      width: cornerWidth,
      height: cornerHeight,
    });
  } else {
    const border = px(style.hit.border);
    const cornerWidth = px(style.hit.cornerWidth);
    const cornerHeight = px(style.hit.cornerHeight);
    regions.push(
      { rgb: style.hit.primary, x: origin, y: origin, width: outerWidth, height: border },
      { rgb: style.hit.primary, x: origin, y: origin + outerHeight - border, width: outerWidth, height: border },
      { rgb: style.hit.primary, x: origin, y: origin, width: border, height: outerHeight },
      { rgb: style.hit.primary, x: origin + outerWidth - border, y: origin, width: border, height: outerHeight },
      {
        rgb: style.hit.corner,
        x: origin + border + offsetPx(style.hit.left) + cornerShift,
        y: origin + border + offsetPx(style.hit.top) + cornerShift,
        width: cornerWidth,
        height: cornerHeight,
      },
    );
  }
  return makeNativeImage(regions, { width: 48, height: 48 });
}

describe("niri inspect artifacts", () => {
  it("requires a structurally complete PNG with valid CRCs and terminal IEND", () => {
    const png = minimalPng();
    assert.equal(isCompletePng(png), true);
    assert.equal(isCompletePng(png.subarray(0, png.length - 1)), false);
    assert.equal(isCompletePng(Buffer.concat([png, Buffer.from([0])])), false);
    const corrupt = Buffer.from(png);
    corrupt[corrupt.length - 1] ^= 0xFF;
    assert.equal(isCompletePng(corrupt), false);
  });

  it("creates a private absent capture path, waits for stable PNG, and cleans it up", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-niri-artifact-test-"));
    let target = null;
    try {
      target = createCaptureTarget({ tempRoot: root, token: "unit" });
      assert.equal(fs.statSync(target.dir).mode & 0o777, 0o700);
      assert.equal(assertPathAbsent(target.filePath), true);
      fs.writeFileSync(target.filePath, minimalPng());
      assert.throws(
        () => assertPathAbsent(target.filePath),
        (err) => err && err.code === "capture-path-exists",
      );

      let reads = 0;
      const stable = await waitForCompletePng(target.filePath, {
        fs: {
          readFileSync: () => {
            reads += 1;
            return reads === 1
              ? minimalPng().subarray(0, minimalPng().length - 1)
              : minimalPng();
          },
        },
        timeoutMs: 100,
        pollMs: 1,
        stableCount: 2,
        delay: async () => {},
      });
      assert.equal(isCompletePng(stable), true);
      assert.equal(reads, 3);

      cleanupCaptureTarget(target);
      assert.equal(fs.existsSync(target.filePath), false);
      assert.equal(fs.existsSync(target.dir), false);
      target = null;
    } finally {
      if (target) cleanupCaptureTarget(target);
      fs.rmdirSync(root);
    }
  });

  it("selects a render marker corner outside the hit rectangle", () => {
    const render = { x: 100, y: 100, width: 120, height: 120 };
    const hit = { x: 100, y: 100, width: 60, height: 60 };
    const marker = findRenderMarkerRect(render, hit);
    assert.equal(marker.corner, "top-right");
    assert.ok(marker.x >= 100 - 20);
  });

  it("returns null when every marker corner intersects the hit rectangle", () => {
    assert.equal(findRenderMarkerRect(
      { x: 0, y: 0, width: 40, height: 40 },
      { x: 0, y: 0, width: 40, height: 40 },
    ), null);
  });

  it("recognizes both asymmetric markers after alpha un-premultiplication", () => {
    const image = makeNativeImage([
      { color: "renderPrimary", x: 0, y: 0, width: 8, height: 8 },
      { color: "renderCorner", x: 4, y: 4, width: 4, height: 4 },
      { color: "hitPrimary", x: 12, y: 0, width: 10, height: 3 },
      { color: "hitPrimary", x: 19, y: 0, width: 3, height: 10 },
      { color: "hitPrimary", x: 12, y: 7, width: 10, height: 3 },
      { color: "hitPrimary", x: 12, y: 0, width: 3, height: 10 },
      { color: "hitCorner", x: 12, y: 0, width: 4, height: 4 },
    ], { alpha: 160 });
    const result = scanNativeImage(image);
    assert.equal(result.render, true);
    assert.equal(result.hit, true);
  });

  it("matches the shipped marker geometry with two physical pixels of snap margin", () => {
    assert.deepStrictEqual(PRODUCTION_MARKER_STYLE.render.primary, MARKER_COLORS.renderPrimary);
    assert.deepStrictEqual(PRODUCTION_MARKER_STYLE.render.corner, MARKER_COLORS.renderCorner);
    assert.deepStrictEqual(PRODUCTION_MARKER_STYLE.hit.primary, MARKER_COLORS.hitPrimary);
    assert.deepStrictEqual(PRODUCTION_MARKER_STYLE.hit.corner, MARKER_COLORS.hitCorner);

    for (const scale of [1, 1.25, 1.5, 2]) {
      for (const shift of [-2, -1, 0, 1, 2]) {
        const render = scanNativeImage(makeProductionMarkerImage("render", scale, shift));
        const hit = scanNativeImage(makeProductionMarkerImage("hit", scale, shift));
        assert.equal(render.render, true, `render marker failed at scale=${scale}, shift=${shift}`);
        assert.equal(render.hit, false);
        assert.equal(hit.hit, true, `hit marker failed at scale=${scale}, shift=${shift}`);
        assert.equal(hit.render, false);
      }
    }
  });

  it("fails closed when bitmap storage is not exactly tightly packed", () => {
    const image = makeProductionMarkerImage("render", 1);
    const bitmap = image.toBitmap();
    const padded = {
      isEmpty: () => false,
      getSize: image.getSize,
      toBitmap: () => Buffer.concat([bitmap, Buffer.alloc(16)]),
    };
    assert.deepStrictEqual(scanNativeImage(padded), {
      valid: false,
      render: false,
      hit: false,
      counts: {},
    });
  });

  it("does not accept marker colors below the alpha floor", () => {
    const image = makeNativeImage([
      { color: "renderPrimary", x: 0, y: 0, width: 8, height: 8 },
      { color: "renderCorner", x: 4, y: 4, width: 4, height: 4 },
    ], { alpha: 80 });
    assert.equal(scanNativeImage(image).render, false);
  });

  it("rejects theme-like color totals that do not form the asymmetric fiducials", () => {
    const image = makeNativeImage([
      { color: "renderPrimary", x: 0, y: 0, width: 6, height: 6 },
      { color: "renderCorner", x: 20, y: 20, width: 3, height: 3 },
      { color: "hitPrimary", x: 0, y: 20, width: 5, height: 5 },
      { color: "hitCorner", x: 20, y: 0, width: 3, height: 3 },
    ]);
    const result = scanNativeImage(image);
    assert.equal(result.render, false);
    assert.equal(result.hit, false);
  });

  it("rejects an aligned corner component that occupies the wrong half", () => {
    const image = makeNativeImage([
      { color: "renderPrimary", x: 0, y: 0, width: 10, height: 10 },
      { color: "renderCorner", x: 9, y: 0, width: 1, height: 10 },
    ]);
    assert.equal(scanNativeImage(image).render, false);
  });

  it("does not let broadly similar colors satisfy the fiducial", () => {
    const image = makeNativeImage([
      { rgb: [60, 195, 136], x: 0, y: 0, width: 8, height: 8 },
      { rgb: [195, 195, 195], x: 4, y: 4, width: 4, height: 4 },
    ]);
    assert.equal(scanNativeImage(image).render, false);
  });
});
