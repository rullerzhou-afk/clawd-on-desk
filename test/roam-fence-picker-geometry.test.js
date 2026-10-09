"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cursorForMode,
  hitTestSelection,
  updateSelection,
} = require("../src/roam-fence-picker-geometry");

const area = { width: 1000, height: 800 };
const selection = { x: 200, y: 150, width: 400, height: 300 };

test("picker hit testing distinguishes inside, edges, corners, and outside", () => {
  assert.strictEqual(hitTestSelection(selection, { x: 350, y: 250 }), "move");
  assert.strictEqual(hitTestSelection(selection, { x: 200, y: 250 }), "w");
  assert.strictEqual(hitTestSelection(selection, { x: 600, y: 250 }), "e");
  assert.strictEqual(hitTestSelection(selection, { x: 350, y: 150 }), "n");
  assert.strictEqual(hitTestSelection(selection, { x: 350, y: 450 }), "s");
  assert.strictEqual(hitTestSelection(selection, { x: 200, y: 150 }), "nw");
  assert.strictEqual(hitTestSelection(selection, { x: 600, y: 450 }), "se");
  assert.strictEqual(hitTestSelection(selection, { x: 100, y: 100 }), "draw");
});

test("overlapping hit slop chooses the nearest visible edge on a tiny selection", () => {
  const tiny = { x: 0, y: 100, width: 1, height: 200 };
  assert.strictEqual(hitTestSelection(tiny, { x: 0, y: 200 }), "w");
  assert.strictEqual(hitTestSelection(tiny, { x: 1, y: 200 }), "e");
  assert.deepStrictEqual(updateSelection(
    "e", { x: 1, y: 200 }, { x: 200, y: 200 }, tiny, area,
  ), { x: 0, y: 100, width: 200, height: 200 });
});

test("picker modes expose crop-style cursors", () => {
  assert.strictEqual(cursorForMode("move"), "move");
  assert.strictEqual(cursorForMode("n"), "ns-resize");
  assert.strictEqual(cursorForMode("e"), "ew-resize");
  assert.strictEqual(cursorForMode("nw"), "nwse-resize");
  assert.strictEqual(cursorForMode("ne"), "nesw-resize");
  assert.strictEqual(cursorForMode("draw"), "crosshair");
});

test("dragging inside moves the rectangle and clamps it inside the work area", () => {
  assert.deepStrictEqual(updateSelection(
    "move", { x: 350, y: 250 }, { x: 500, y: 400 }, selection, area,
  ), { x: 350, y: 300, width: 400, height: 300 });
  assert.deepStrictEqual(updateSelection(
    "move", { x: 350, y: 250 }, { x: 1000, y: 800 }, selection, area,
  ), { x: 600, y: 500, width: 400, height: 300 });
});

test("dragging edges and corners resizes without leaving the work area", () => {
  assert.deepStrictEqual(updateSelection(
    "w", { x: 200, y: 250 }, { x: 100, y: 250 }, selection, area,
  ), { x: 100, y: 150, width: 500, height: 300 });
  assert.deepStrictEqual(updateSelection(
    "se", { x: 600, y: 450 }, { x: 1200, y: 900 }, selection, area,
  ), { x: 200, y: 150, width: 800, height: 650 });
  assert.deepStrictEqual(updateSelection(
    "nw", { x: 200, y: 150 }, { x: 700, y: 600 }, selection, area,
  ), { x: 599, y: 449, width: 1, height: 1 });
});

test("drawing a new rectangle works in every direction and stays in bounds", () => {
  assert.deepStrictEqual(updateSelection(
    "draw", { x: 800, y: 700 }, { x: 300, y: 200 }, null, area,
  ), { x: 300, y: 200, width: 500, height: 500 });
  assert.deepStrictEqual(updateSelection(
    "draw", { x: 1000, y: 800 }, { x: 1000, y: 800 }, null, area,
  ), { x: 999, y: 799, width: 1, height: 1 });
});
