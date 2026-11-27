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

it("gravity: the menu can cancel a fall before resizing the pet", () => {
  const start = source.indexOf("const _menuCtx = {");
  assert.ok(start >= 0, "missing menu context");
  const menuCtx = source.slice(start, source.indexOf("\n};", start));
  assert.ok(menuCtx.includes("cancelGravityFall: () => _gravity.cancel(),"));
});

it("gravity: bringing the pet to the primary display drops it after centering it", () => {
  const start = source.indexOf("function bringPetToPrimaryDisplay() {");
  assert.ok(start >= 0, "missing bringPetToPrimaryDisplay");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.match(body, /petWindowRuntime\.bringPetToPrimaryDisplay\(\);[\s\S]*_gravity\.startFall\(\);/);
});

for (const [event, handler] of [
  ["display-removed", "handleDisplayRemoved"],
  ["display-added", "handleDisplayAdded"],
]) {
  it(`gravity: ${event} suspends before reflow and resumes after size notification`, () => {
    const start = source.indexOf(`screen.on("${event}", () => {`);
    assert.ok(start >= 0, `missing ${event} listener`);
    const body = source.slice(start, source.indexOf("\n  });", start));
    assert.match(body, new RegExp(
      String.raw`_gravity\.suspend\(\);\s*petWindowRuntime\.${handler}\(\);\s*`
      + String.raw`settingsWindowRuntime\.notifySizeContextChanged\(\);\s*_gravity\.resumeSuspended\(\);`,
    ));
  });
}

it("gravity: a separate display metrics listener suspends the fall immediately", () => {
  assert.ok(source.includes('screen.on("display-metrics-changed", () => _gravity.suspend());'));
});

it("gravity: debounced display metrics suspend before reflow and resume after size notification", () => {
  const debounce = source.match(/displayMetricsGeometryTimer = setTimeout\(\(\) => \{([\s\S]*?)\n    \}, 400\);/);
  assert.ok(debounce, "missing debounced display metrics handler");
  assert.match(debounce[1], /_gravity\.suspend\(\);\s*petWindowRuntime\.handleDisplayMetricsChanged\(\);/);
  assert.match(debounce[1], /settingsWindowRuntime\.notifySizeContextChanged\(\);\s*_gravity\.resumeSuspended\(\);/);
});
