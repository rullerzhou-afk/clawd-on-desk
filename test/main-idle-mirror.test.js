"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const mirror = require("../src/mirrored-files");
const { createDisplayedVisualProjection } = require("../src/displayed-visual-projection");

// Run the actual main request/refresh path with a real projection. Electron's
// window and screen are the only geometry boundaries replaced here.
function createHarness() {
  const source = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const start = source.indexOf("let roamHeadingLeft = false;");
  const end = source.indexOf("function resetDisplayedVisualProjection(", start);
  assert.ok(start >= 0 && end > start);
  const messages = [];
  const state = { name: "idle", file: "bubble.svg" };
  const theme = {
    _id: "mirror-test",
    states: { idle: ["follow.svg"] },
    idleAnimations: [{ file: "bubble.svg", duration: 5000, mirrorOnRightSide: true }],
    mirroredFiles: { "bubble.svg": "bubble-left.svg" },
    reactions: {},
  };
  let bounds = { x: 50, y: 50, width: 100, height: 100 };
  let workArea = { x: 0, y: 0, width: 1000, height: 800 };
  const hitBox = { x: 1, y: 2, width: 20, height: 30 };
  const resolvedHitBoxes = [];
  const projection = createDisplayedVisualProjection({ setTimeout: () => 1, clearTimeout() {} });
  const context = vm.createContext({
    ...mirror,
    displayedVisualProjection: projection,
    getActiveTheme: () => theme,
    getPetWindowBounds: () => bounds,
    getNearestWorkArea: () => workArea,
    sendRawToRenderer: (...args) => { messages.push(args); return true; },
    inferVisualSource: () => "state",
    _mini: { getMiniMode: () => false, getMiniEdge: () => "right" },
    _state: {
      getCurrentState: () => state.name,
      getCurrentSvg: () => state.file,
      resolveHitBoxForSvg: (file) => { resolvedHitBoxes.push(file); return hitBox; },
    },
  });
  vm.runInContext(source.slice(start, end), context);
  const settle = (request) => assert.equal(projection.settle({
    themeId: theme._id,
    visualGeneration: request.visualGeneration,
    displayState: request.displayState,
    requestedFile: request.file,
    outcome: "swapped",
    actualFile: request.file,
    channel: "img",
    verified: true,
  }).accepted, true);
  return { context, messages, state, theme, projection, hitBox, resolvedHitBoxes, settle,
    move: (x, wa = workArea) => { bounds = { ...bounds, x }; workArea = wa; } };
}

test("fixed idle without a drag reaction selects the correct variant after dragging both ways", () => {
  const h = createHarness();
  h.settle(h.context.requestDisplayedVisual("idle", "bubble.svg"));
  assert.equal(h.projection.getSnapshot().committed.file, "bubble.svg");
  h.messages.length = 0;
  h.move(900);
  const right = h.context.refreshIdleVisualAfterDrag();
  assert.equal(right.file, "bubble-left.svg");
  assert.deepEqual(h.messages.map(([channel]) => channel), ["pet-screen-side", "state-change"]);
  assert.equal(h.messages[0][1], true);
  assert.deepEqual(h.projection.getSnapshot().requested.hitBox, h.hitBox);
  h.settle(right);
  assert.equal(h.projection.getSnapshot().committed.file, "bubble-left.svg");
  h.move(-900, { x: -1000, y: 0, width: 1000, height: 800 });
  const left = h.context.refreshIdleVisualAfterDrag();
  assert.equal(left.file, "bubble.svg");
  assert.equal(h.messages.at(-2)[1], false, "side uses the current display's work area");
  h.settle(left);
  assert.deepEqual(h.resolvedHitBoxes, ["bubble.svg", "bubble.svg", "bubble.svg"]);
});

test("a pending idle request is superseded when drag release changes the side", () => {
  const h = createHarness();
  const old = h.context.requestDisplayedVisual("idle", "bubble.svg");
  h.move(900);
  const latest = h.context.refreshIdleVisualAfterDrag();
  assert.equal(latest.file, "bubble-left.svg");
  assert.equal(h.projection.getTerminal(old.visualGeneration).status, "superseded");
  h.settle(latest);
});

test("drag refresh preserves reactions, non-idle states and non-opted-in resting files", () => {
  const h = createHarness();
  h.context.requestDisplayedVisual("idle", "click.svg", { source: "reaction" });
  h.messages.length = 0;
  h.move(900);
  assert.equal(h.context.refreshIdleVisualAfterDrag(), null);
  assert.equal(h.messages.length, 0);
  h.context.requestDisplayedVisual("working", "working.svg");
  assert.equal(h.context.refreshIdleVisualAfterDrag(), null);
  h.state.name = "working";
  assert.equal(h.context.refreshIdleVisualAfterDrag(), null);
  h.state.name = "idle";
  h.state.file = "follow.svg";
  h.context.requestDisplayedVisual("idle", "follow.svg");
  h.messages.length = 0;
  assert.equal(h.context.refreshIdleVisualAfterDrag(), null);
  assert.equal(h.messages.length, 0);
});
