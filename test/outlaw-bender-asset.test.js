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

function readLf(file) {
  return `${fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").trimEnd()}\n`;
}

test("builtin outlaw bender preserves the reviewed art with only the declared compositing deltas", () => {
  const source = readLf(SOURCE);
  const deltas = [
    ['viewBox="-15 -25 45 45"', 'viewBox="-15 -25 45 46"'],
    [
      "      .bd-ember { animation: bd-ember 1.6s infinite ease-in-out; }\n",
      "      .bd-ember { animation: bd-ember 1.6s infinite ease-in-out; }\n"
        + "      .bd-ember-hot { animation: bd-ember-hot 1.6s infinite ease-in-out; }\n",
    ],
    [
      "      @keyframes bd-ember { 0%, 100% { fill: #E03A00; opacity: .85; } 50% { fill: #FF7A1A; opacity: 1; } }\n",
      "      @keyframes bd-ember { 0%, 100% { opacity: .85; } 50% { opacity: 1; } }\n"
        + "      @keyframes bd-ember-hot { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }\n",
    ],
    [
      '        <rect x="15" y="11" width="1" height="1" fill="#FF5A00" class="bd-ember"/>\n',
      '        <g class="bd-ember">\n'
        + '          <rect x="15" y="11" width="1" height="1" fill="#E03A00"/>\n'
        + '          <rect x="15" y="11" width="1" height="1" fill="#FF7A1A" class="bd-ember-hot"/>\n'
        + '        </g>\n',
    ],
  ];
  let expectedRuntime = source;
  for (const [from, to] of deltas) {
    assert.ok(expectedRuntime.includes(from), `reviewed source marker must stay recognizable: ${from}`);
    expectedRuntime = expectedRuntime.replace(from, to);
  }
  assert.strictEqual(readLf(RUNTIME), expectedRuntime);
});

test("builtin outlaw bender has no active, linked, or externally loaded SVG content", () => {
  const markup = readLf(RUNTIME);
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
