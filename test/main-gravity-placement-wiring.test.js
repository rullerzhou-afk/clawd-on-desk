"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

it("gravity: the menu can drop the pet after sending it to another display", () => {
  const start = source.indexOf("const _menuCtx = {");
  assert.ok(start >= 0, "missing menu context");
  const menuCtx = source.slice(start, source.indexOf("\n};", start));
  assert.ok(menuCtx.includes("startGravityFall: () => _gravity.startFall(),"));
});

it("gravity: bringing the pet to the primary display drops it after centering it", () => {
  const start = source.indexOf("function bringPetToPrimaryDisplay() {");
  assert.ok(start >= 0, "missing bringPetToPrimaryDisplay");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.match(body, /petWindowRuntime\.bringPetToPrimaryDisplay\(\);[\s\S]*_gravity\.startFall\(\);/);
});
