"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

it("gravity: wires roam to the falling and on/off predicates", () => {
  const start = source.indexOf("const _roamCtx = {");
  const end = source.indexOf('const _roam = require("./roam")', start);
  assert.ok(start >= 0 && end > start, "missing roam context");
  const roam = source.slice(start, end);
  assert.ok(roam.includes("isGravityFalling: () => _gravity.isFalling(),"));
  assert.ok(roam.includes("isGravityEnabled: () => _gravity.isEnabled(),"));
});
