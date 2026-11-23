"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const {
  sanitizeSvg,
  collectSafeRasterRefs,
} = require("../src/theme-sanitizer");

test("sanitizeSvg keeps the XML declaration well formed", () => {
  const sanitized = sanitizeSvg(
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
  );

  assert.ok(
    sanitized.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<svg'),
    sanitized
  );
});

test("sanitizeSvg keeps only a leading XML declaration among top-level directives", () => {
  const sanitized = sanitizeSvg([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?xml-stylesheet type="text/css" href="https://bad.example/theme.css"?>',
    '<?xml-foo value="should be removed"?>',
    '<?xml version="1.1"?>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
  ].join("\n"));

  assert.ok(sanitized.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), sanitized);
  assert.ok(sanitized.includes("<svg"), sanitized);
  assert.strictEqual((sanitized.match(/<\?xml/g) || []).length, 1, sanitized);
  assert.ok(!sanitized.includes("xml-stylesheet"), sanitized);
  assert.ok(!sanitized.includes("bad.example"), sanitized);
  assert.ok(!sanitized.includes("xml-foo"), sanitized);
  assert.ok(!sanitized.includes('version="1.1"'), sanitized);
});

test("sanitizeSvg removes a leading xml-stylesheet without an XML declaration", () => {
  const sanitized = sanitizeSvg([
    '<?xml-stylesheet type="text/css" href="https://bad.example/theme.css"?>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
  ].join("\n"));

  assert.ok(!sanitized.includes("xml-stylesheet"), sanitized);
  assert.ok(!sanitized.includes("bad.example"), sanitized);
  assert.ok(sanitized.includes("<svg"), sanitized);
});

test("sanitizeSvg removes a leading non-XML processing instruction", () => {
  const sanitized = sanitizeSvg([
    '<?xml-foo value="should be removed"?>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
  ].join("\n"));

  assert.ok(!sanitized.includes("xml-foo"), sanitized);
  assert.ok(sanitized.includes("<svg"), sanitized);
});

test("sanitizeSvg strips unsafe script, href, and CSS URL surfaces", () => {
  const svg = [
    "<svg xmlns=\"http://www.w3.org/2000/svg\">",
    "  <script>alert(1)</script>",
    "  <g onclick=\"steal()\" style=\"fill:url(https://bad.example/a.png);stroke:url(#allowed);filter:url(pattern.svg#filter)\">",
    "    <a href=\"javascript:alert(1)\"><rect width=\"1\" height=\"1\"/></a>",
    "    <use href=\"pattern.svg#shape\"/>",
    "    <rect fill=\"url(//bad.example/filter)\" stroke=\"url(pattern.svg#stroke)\"/>",
    "  </g>",
    "  <style>@import url(\"https://bad.example/style.css\"); .ok{background:url(nested/sheet.png)} .bad{background:url(../../secret.png)}</style>",
    "</svg>",
  ].join("");

  const sanitized = sanitizeSvg(svg);

  assert.ok(!sanitized.includes("<script"));
  assert.ok(!sanitized.includes("onclick"));
  assert.ok(!sanitized.includes("javascript:"));
  assert.ok(!sanitized.includes("https://bad.example"));
  assert.ok(!sanitized.includes("//bad.example"));
  assert.ok(!sanitized.includes("../../secret.png"));
  assert.ok(sanitized.includes("stroke:url(#allowed)"));
  assert.ok(sanitized.includes("filter:url(pattern.svg#filter)"));
  assert.ok(sanitized.includes("href=\"pattern.svg#shape\""));
  assert.ok(sanitized.includes("background:url(nested/sheet.png)"));
});

test("sanitizeSvg removes SMIL that mutates dynamic URL, event, or style surfaces", () => {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg">',
    '  <a id="target"><rect width="1" height="1"/></a>',
    '  <set href="#target" attributeName="href" to="javascript:alert(1)"/>',
    '  <animate attributeName="fill" values="#fff;url(https://bad.example/fill)"/>',
    '  <set attributeName="onload" to="steal()"/>',
    '  <animate attributeName="opacity" values="0;1" dur="1s"/>',
    '</svg>',
  ].join("");

  const sanitized = sanitizeSvg(svg);
  assert.ok(!sanitized.includes('attributeName="href"'));
  assert.ok(!sanitized.includes("bad.example"));
  assert.ok(!sanitized.includes('attributeName="onload"'));
  assert.ok(sanitized.includes('attributeName="opacity"'));
});

test("sanitizeSvg rejects namespace-prefixed SMIL and obfuscated dynamic URLs", () => {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink">',
    '  <a id="target"><rect width="1" height="1"/></a>',
    '  <image x:href="https://bad.example/static.png"/>',
    '  <s:animate attributeName="href" values="#target;javascript:alert(1)"/>',
    '  <s:animate attributeName="x:href" values="#target;https://bad.example/aliased"/>',
    '  <animate attributeName="fill" values="#fff;url(h\\74tps://bad.example/escaped)"/>',
    '  <animate attributeName="fill" values="#fff;url(h/**/ttps://bad.example/commented)"/>',
    '  <animate attributeName="fill" values="#fff;url(h\\9 ttps://bad.example/tab)"/>',
    '  <animate attributeName="fill" values="#fff;url(h\\a ttps://bad.example/newline)"/>',
    '  <animate attributeName="fill" values="#fff;url(h\\d ttps://bad.example/carriage-return)"/>',
    '  <s:set attributeName="fill" to="url(javascr\\9 ipt:alert(1))"/>',
    '  <s:animate attributeName="opacity" values="0;1" dur="1s"/>',
    '</svg>',
  ].join("");

  const sanitized = sanitizeSvg(svg);
  assert.ok(!sanitized.includes('attributeName="href"'));
  assert.ok(!sanitized.includes('attributeName="x:href"'));
  assert.ok(!sanitized.includes('x:href="https:'));
  assert.ok(!sanitized.includes("bad.example"));
  assert.ok(sanitized.includes('s:animate attributeName="opacity"'));
});

test("collectSafeRasterRefs collects only safe relative png and webp dependencies", () => {
  const sourceAssetsDir = path.join(__dirname, "fixtures", "theme-assets");
  const svg = [
    "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\">",
    "  <image href=\"spritesheet.webp?cache=1#frame\"/>",
    "  <image xlink:href=\"nested/sheet.png\"/>",
    "  <rect style=\"fill:url('icons/cursor.webp')\"/>",
    "  <style>",
    "    .ok{background:url(\"nested/other.png#v\")}",
    "    .remote{background:url(https://bad.example/remote.png)}",
    "    .encoded{background:url(%2e%2e/outside.png)}",
    "    .svg{background:url(pattern.svg)}",
    "  </style>",
    "  <image href=\"data:image/png;base64,AAAA\"/>",
    "</svg>",
  ].join("");

  const refs = collectSafeRasterRefs(svg, sourceAssetsDir);

  assert.deepStrictEqual([...refs.keys()].sort(), [
    "icons/cursor.webp",
    "nested/other.png",
    "nested/sheet.png",
    "spritesheet.webp",
  ]);
  assert.strictEqual(refs.get("spritesheet.webp").sourceAbs, path.resolve(sourceAssetsDir, "spritesheet.webp"));
  assert.strictEqual(refs.get("nested/other.png").sourceRel, "nested/other.png");
  assert.ok(!refs.has("../outside.png"));
  assert.ok(!refs.has("pattern.svg"));
});
