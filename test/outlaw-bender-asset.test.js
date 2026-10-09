"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SOURCE = path.join(ROOT, "assets", "source", "outlaw-pr811", "clawd-outlaw-bender.svg");
const RUNTIME = path.join(ROOT, "assets", "svg", "clawd-outlaw-bender.svg");
const FORBIDDEN = [
  /<script\b/i,
  /<foreignObject\b/i,
  /<image\b/i,
  /<use\b/i,
  /\bhref\s*=/i,
  /url\s*\(/i,
  /\bdata\s*:/i,
  /\bon\w+\s*=/i,
  /<!DOCTYPE\b/i,
  /<!ENTITY\b/i,
];

test("builtin outlaw bender preserves the reviewed art with only the declared viewBox delta", () => {
  const source = `${fs.readFileSync(SOURCE, "utf8").trimEnd()}\n`;
  const expectedRuntime = source.replace(
    'viewBox="-15 -25 45 45"',
    'viewBox="-15 -25 45 46"'
  );
  assert.notStrictEqual(expectedRuntime, source, "reviewed source viewBox marker must stay recognizable");
  assert.strictEqual(`${fs.readFileSync(RUNTIME, "utf8").trimEnd()}\n`, expectedRuntime);
});

test("builtin outlaw bender has no active, linked, or externally loaded SVG content", () => {
  const markup = fs.readFileSync(RUNTIME, "utf8");
  assert.match(markup, /<style\b/i, "local CSS keyframes are intentionally retained");
  for (const pattern of FORBIDDEN) {
    assert.doesNotMatch(markup, pattern, String(pattern));
  }
});

test("the generated full outlaw theme is not shipped", () => {
  const themeDir = path.join(ROOT, "themes", "clawd-outlaw");
  assert.strictEqual(fs.existsSync(path.join(themeDir, "theme.json")), false);
  const assetsDir = path.join(themeDir, "assets");
  const shippedAssets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
  assert.deepStrictEqual(shippedAssets, []);
});
