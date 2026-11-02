"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const qrcode = require("qrcode-generator");
const { buildPairQrSvg } = require("../src/mobile-pair-qr");

const PAIR_URL = "http://192.168.1.5:23334/mobile/?pair=ABCD1234";

function countDarkModules(svg) {
  return (svg.match(/M\d+ \d+h1v1h-1z/g) || []).length;
}

describe("buildPairQrSvg", () => {
  it("renders a self-contained crisp SVG with its own background", () => {
    const svg = buildPairQrSvg(PAIR_URL);
    assert.ok(typeof svg === "string" && svg.startsWith("<svg"));
    assert.ok(svg.includes(`xmlns="http://www.w3.org/2000/svg"`));
    assert.ok(svg.includes(`shape-rendering="crispEdges"`));
    assert.ok(svg.includes(`aria-hidden="true"`));
    assert.ok(svg.includes(`<rect width="41" height="41" fill="#ffffff"/>`));
    assert.ok(svg.includes(`<path d="`));
    assert.ok(svg.endsWith(`</svg>`));
  });

  it("matches the dark module count of the underlying QR matrix", () => {
    const qr = qrcode(0, "M");
    qr.addData(PAIR_URL);
    qr.make();
    const count = qr.getModuleCount();
    let expected = 0;
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) expected += 1;
      }
    }
    const svg = buildPairQrSvg(PAIR_URL);
    assert.strictEqual(countDarkModules(svg), expected);
  });

  it("offsets modules by the default quiet zone inside the viewBox", () => {
    const svg = buildPairQrSvg(PAIR_URL);
    assert.ok(svg.includes(`viewBox="0 0 41 41"`));
    // First dark module must sit at least 4 modules from the edge.
    assert.doesNotMatch(svg, /M[0-3] \d+h1v1h-1z/);
    assert.doesNotMatch(svg, /M\d+ [0-3]h1v1h-1z/);
    assert.match(svg, /M4 4h1v1h-1z/);
  });

  it("produces a different SVG when the URL changes and a stable one on repeat", () => {
    const first = buildPairQrSvg(PAIR_URL);
    const repeat = buildPairQrSvg(PAIR_URL);
    assert.strictEqual(first, repeat); // memoized: same url, same svg

    const other = buildPairQrSvg("http://10.0.0.2:23336/mobile/?pair=ZZZZ9999");
    assert.notStrictEqual(other, first);
    assert.ok(other.startsWith("<svg"));
  });

  it("honors quiet zone and color overrides", () => {
    const svg = buildPairQrSvg(PAIR_URL, { quietZone: 2, dark: "#123456", light: "#fedcba" });
    assert.ok(svg.includes(`viewBox="0 0 37 37"`));
    assert.ok(svg.includes(`<rect width="37" height="37" fill="#fedcba"/>`));
    assert.ok(svg.includes(`fill="#123456"`));
    assert.match(svg, /M2 2h1v1h-1z/);
  });

  it("falls back to default colors for malformed color options", () => {
    const svg = buildPairQrSvg(PAIR_URL, { dark: 'black"><script>alert(1)</script>', light: "not-a-color" });
    assert.ok(!svg.includes("<script"));
    assert.ok(svg.includes(`fill="#000000"`));
    assert.ok(svg.includes(`fill="#ffffff"`));
  });

  it("returns null for empty, non-string, or oversized URLs", () => {
    assert.strictEqual(buildPairQrSvg(""), null);
    assert.strictEqual(buildPairQrSvg(null), null);
    assert.strictEqual(buildPairQrSvg(undefined), null);
    assert.strictEqual(buildPairQrSvg(12345), null);
    assert.strictEqual(buildPairQrSvg("x".repeat(513)), null);
  });

  it("never emits script tags or inline event handlers", () => {
    for (const url of [PAIR_URL, "http://[::1]:23334/mobile/?pair=K7Q29MXA", "http://10.0.0.9:80/mobile/"]) {
      const svg = buildPairQrSvg(url);
      if (!svg) continue;
      assert.ok(!svg.includes("<script"));
      assert.ok(!/<[a-z-]+\s[^>]*\son\w+=/i.test(svg));
    }
  });
});
