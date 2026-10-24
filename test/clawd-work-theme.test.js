"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { FLAT_FILES, generate } = require("../tools/generate-clawd-work-theme");

const THEME_DIR = path.join(__dirname, "..", "themes", "clawd-work");

test("committed Clawd Work theme matches the generator", () => {
  for (const [rel, content] of generate()) {
    const committed = fs.readFileSync(path.join(THEME_DIR, rel), "utf8");
    assert.strictEqual(committed, content, `themes/clawd-work/${rel} is stale; run node tools/generate-clawd-work-theme.js`);
  }
});

test("every Clawd frame is dressed and none keeps the bare body fill", () => {
  const sourceNames = fs.readdirSync(path.join(__dirname, "..", "assets", "svg"))
    .filter((name) => /^clawd-.*\.svg$/.test(name));
  const outputs = generate();
  for (const name of sourceNames) {
    const svg = outputs.get(path.join("assets", name));
    assert.ok(svg, `${name} missing from clawd-work`);
    const patternId = FLAT_FILES.has(name) ? "clawd-work-suit-flat" : "clawd-work-suit";
    assert.ok(svg.includes(`fill="url(#${patternId})"`), `${name} not dressed`);
    // The only remaining body-colour fill is the pattern's own skin layer.
    assert.strictEqual(svg.split('fill="#DE886D"').length - 1, 1, `${name} has a bare body fill`);
  }
});

test("Clawd Work keeps Clawd's states and disables the pet tint", () => {
  const work = JSON.parse(fs.readFileSync(path.join(THEME_DIR, "theme.json"), "utf8"));
  const clawd = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "themes", "clawd", "theme.json"), "utf8"));
  assert.strictEqual(work.name, "Clawd Work");
  assert.deepStrictEqual(work.states, clawd.states);
  assert.strictEqual(work.customization.petTint, false);
});
