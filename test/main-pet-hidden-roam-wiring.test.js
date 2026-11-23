"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

it("hidden pet: wires roam to the effective pet visibility predicate", () => {
  const start = source.indexOf("const _roamCtx = {");
  const end = source.indexOf('const _roam = require("./roam")', start);
  assert.ok(start >= 0 && end > start, "missing roam context");
  const roam = source.slice(start, end);
  assert.ok(roam.includes(
    "isPetHidden: () => petWindowRuntime.isPetEffectivelyHidden(),"
  ));
});
