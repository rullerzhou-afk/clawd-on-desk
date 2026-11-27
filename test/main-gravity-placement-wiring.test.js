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
  it(`gravity: ${event} cancels before reflow and resumes only an active fall`, () => {
    const start = source.indexOf(`screen.on("${event}", () => {`);
    assert.ok(start >= 0, `missing ${event} listener`);
    const body = source.slice(start, source.indexOf("\n  });", start));
    assert.match(body, new RegExp(
      String.raw`const wasFalling = _gravity\.isFalling\(\);\s*_gravity\.cancel\(\);\s*`
      + String.raw`petWindowRuntime\.${handler}\(\);[\s\S]*if \(wasFalling\) _gravity\.startFall\(\);`,
    ));
  });
}

it("gravity: display metrics cancel immediately and resume an active fall only after debounced reflow", () => {
  const start = source.indexOf('screen.on("display-metrics-changed", () => {');
  assert.ok(start >= 0, "missing display-metrics-changed listener");
  const body = source.slice(start, source.indexOf("\n  });", start));
  assert.match(body, /if \(_gravity\.isFalling\(\)\) resumeGravityAfterMetricsChange = true;\s*_gravity\.cancel\(\);/);
  assert.match(body, /_gravity\.cancel\(\);[\s\S]*reapplyDisplayGeometryAfterMetricsChange\(\);/);
  assert.doesNotMatch(body, /_gravity\.startFall\(/);

  const debounce = source.match(/displayMetricsGeometryTimer = setTimeout\(\(\) => \{([\s\S]*?)\n    \}, 400\);/);
  assert.ok(debounce, "missing debounced display metrics handler");
  assert.match(debounce[1], /petWindowRuntime\.handleDisplayMetricsChanged\(\);[\s\S]*if \(resumeGravityAfterMetricsChange\) \{/);
  assert.match(debounce[1], /if \(resumeGravityAfterMetricsChange\) \{\s*_gravity\.startFall\(\);\s*resumeGravityAfterMetricsChange = false;/);
});
