"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { describe, it } = require("node:test");
const { parseSvgGeometry, renderAlpha } = require("../scripts/generate-mac-tray-icons");

const ROOT = path.join(__dirname, "..");
const pkg = require("../package.json");
const RUNTIME = {
  normal1x: path.join(ROOT, "assets", "tray-iconTemplate.png"),
  normal2x: path.join(ROOT, "assets", "tray-iconTemplate@2x.png"),
  flash1x: path.join(ROOT, "assets", "tray-icon-flashTemplate.png"),
  flash2x: path.join(ROOT, "assets", "tray-icon-flashTemplate@2x.png"),
};
const SOURCE = {
  normal: path.join(ROOT, "assets", "source", "tray-icon-project-mark.svg"),
  flash: path.join(ROOT, "assets", "source", "tray-icon-project-mark-complete.svg"),
  legacyNormal1x: path.join(ROOT, "assets", "source", "legacy-tray-icons", "tray-iconTemplate.png"),
  legacyNormal2x: path.join(ROOT, "assets", "source", "legacy-tray-icons", "tray-iconTemplate@2x.png"),
  legacyFlash: path.join(ROOT, "assets", "source", "legacy-tray-icons", "tray-icon-flash.png"),
};
const LEGACY_RUNTIME_HASHES = new Set([
  "e5f1db1525fcbf5f93ad7850f1c0e3b5bc4e71c051b33da0b4e879bf1fc87383",
  "240bdd4ed812b17fa89b7e856c979082daf1f5f9a3f925108e0ad15554257e12",
]);

function decodeRgbaPng(file) {
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.readUInt32BE(0), 0x89504e47, `${file} should be a PNG`);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  assert.strictEqual(bitDepth, 8, `${file} should be 8-bit`);
  assert.strictEqual(colorType, 6, `${file} should be RGBA`);
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * bytesPerPixel);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor++];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[cursor++];
      const left = x >= bytesPerPixel ? rgba[y * stride + x - bytesPerPixel] : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const upperLeft = x >= bytesPerPixel && y > 0
        ? rgba[(y - 1) * stride + x - bytesPerPixel]
        : 0;
      let reconstructed = value;
      if (filter === 1) reconstructed += left;
      else if (filter === 2) reconstructed += up;
      else if (filter === 3) reconstructed += (left + up) >> 1;
      else if (filter === 4) reconstructed += paeth(left, up, upperLeft);
      else assert.strictEqual(filter, 0, `unsupported PNG filter ${filter}`);
      rgba[y * stride + x] = reconstructed & 0xff;
    }
  }
  const alpha = [];
  for (let index = 3; index < rgba.length; index += 4) alpha.push(rgba[index]);
  return { width, height, alpha };
}

function alphaBounds(image) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  let visible = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.alpha[y * image.width + x] === 0) continue;
      visible += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY, visible };
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("macOS tray Template assets", () => {
  it("keeps reproducible project-mark sources and the legacy runtime evidence", () => {
    for (const file of Object.values(SOURCE)) assert.ok(fs.existsSync(file), `${file} should exist`);
    assert.strictEqual(sha256(SOURCE.legacyNormal1x), "e5f1db1525fcbf5f93ad7850f1c0e3b5bc4e71c051b33da0b4e879bf1fc87383");
    assert.strictEqual(sha256(SOURCE.legacyNormal2x), "240bdd4ed812b17fa89b7e856c979082daf1f5f9a3f925108e0ad15554257e12");
    assert.strictEqual(sha256(SOURCE.legacyFlash), "2e930db0fdceb17c3cf46d569a04461849561cc1749c772119e6f8d379854e6f");
  });

  it("ships normal and completion Template pairs at 18px and 36px", () => {
    const decoded = Object.fromEntries(Object.entries(RUNTIME).map(([key, file]) => [key, decodeRgbaPng(file)]));
    assert.deepStrictEqual([decoded.normal1x.width, decoded.normal1x.height], [18, 18]);
    assert.deepStrictEqual([decoded.flash1x.width, decoded.flash1x.height], [18, 18]);
    assert.deepStrictEqual([decoded.normal2x.width, decoded.normal2x.height], [36, 36]);
    assert.deepStrictEqual([decoded.flash2x.width, decoded.flash2x.height], [36, 36]);
    assert.ok(pkg.build.files.includes("assets/tray-icon*.png"));
    assert.ok(!pkg.build.files.some((entry) => entry.startsWith("assets/source")));
  });

  it("preserves the original logo proportions and a visible center gap", () => {
    const source = fs.readFileSync(SOURCE.normal, "utf8");
    assert.match(source, /510x222 union with a 136px \(26\.7%\) center gap/);
    assert.match(source, /scaled to a near-full 18pt menu-bar canvas/);
    assert.ok(source.includes("M2.78 6.1 L5.77 8 L2.78 9.9"));
    assert.ok(source.includes("M13.22 6.1 L10.23 8 L13.22 9.9"));

    const image = decodeRgbaPng(RUNTIME.normal2x);
    for (let y = 15; y <= 21; y += 1) {
      for (let x = 15; x <= 20; x += 1) {
        assert.strictEqual(image.alpha[y * image.width + x], 0, `center gap should stay empty at ${x},${y}`);
      }
    }
  });

  it("renders from SVG geometry instead of a duplicated generator constant", () => {
    const source = fs.readFileSync(SOURCE.normal, "utf8");
    const original = parseSvgGeometry(source);
    const widenedSource = source.replace('stroke-width="1.28"', 'stroke-width="1.50"');
    const widened = parseSvgGeometry(widenedSource);

    assert.strictEqual(original.frameStrokeRadius, 0.64);
    assert.strictEqual(widened.frameStrokeRadius, 0.75);
    assert.notDeepStrictEqual(renderAlpha(18, original), renderAlpha(18, widened));
  });

  it("uses the near-full canvas without changing the 18pt logical slot", () => {
    for (const [key, file] of Object.entries(RUNTIME)) {
      const image = decodeRgbaPng(file);
      const bounds = alphaBounds(image);
      assert.ok(bounds.visible >= (image.width === 18 ? 38 : 150), `${key} should remain readable`);
      assert.deepStrictEqual(
        [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY],
        [0, 0, image.width - 1, image.height - 1],
        `${key} should consume the canvas edge pixels for visual balance`,
      );
    }
  });

  it("keeps the complete mark geometry and only adds a bounded completion cue", () => {
    for (const [normalKey, flashKey] of [["normal1x", "flash1x"], ["normal2x", "flash2x"]]) {
      const normal = decodeRgbaPng(RUNTIME[normalKey]);
      const flash = decodeRgbaPng(RUNTIME[flashKey]);
      let added = 0;
      const newlyVisible = [];
      for (let index = 0; index < normal.alpha.length; index += 1) {
        assert.ok(flash.alpha[index] >= normal.alpha[index], `${flashKey} must preserve the normal mark`);
        if (flash.alpha[index] > normal.alpha[index]) added += 1;
        if (normal.alpha[index] === 0 && flash.alpha[index] > 0) newlyVisible.push(index);
      }
      assert.ok(added > 0, `${flashKey} should add a completion cue`);
      assert.ok(added < normal.alpha.length * 0.2, `${flashKey} cue should stay bounded`);
      const minimumNewPixels = normal.width === 18 ? 6 : 18;
      assert.ok(
        newlyVisible.length >= minimumNewPixels,
        `${flashKey} should add at least ${minimumNewPixels} newly visible pixels`,
      );
      for (const index of newlyVisible) {
        const x = index % normal.width;
        const y = Math.floor(index / normal.width);
        assert.ok(
          x >= normal.width / 2 && y < normal.height / 2,
          `${flashKey} completion cue should stay in the top-right quadrant at ${x},${y}`,
        );
      }
    }
  });

  it("does not leave the legacy crab bytes in the runtime Template pair", () => {
    assert.ok(!LEGACY_RUNTIME_HASHES.has(sha256(RUNTIME.normal1x)));
    assert.ok(!LEGACY_RUNTIME_HASHES.has(sha256(RUNTIME.normal2x)));
  });
});
