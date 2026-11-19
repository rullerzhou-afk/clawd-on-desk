"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

it("hidden pet page: resends effective visibility after load before any early return", () => {
  const start = source.indexOf("function syncRendererStateAfterLoad(");
  const end = source.indexOf("return;", start);
  assert.ok(start >= 0 && end > start, "missing renderer load synchronization");
  const syncBeforeReturn = source.slice(start, end);
  assert.ok(syncBeforeReturn.includes(
    'sendToRenderer("pet-hidden-change", petWindowRuntime.isPetEffectivelyHidden());'
  ));
});
