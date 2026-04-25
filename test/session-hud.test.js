const { describe, it } = require("node:test");
const assert = require("node:assert");

const sessionHud = require("../src/session-hud");
const {
  computeSessionHudBounds,
  computeHudLayout,
  computeHudHeight,
  constants,
} = sessionHud.__test;

function mkSession(id, overrides = {}) {
  return {
    id,
    state: "working",
    headless: false,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("session HUD geometry", () => {
  it("positions below the pet hitbox and clamps horizontally", () => {
    const result = computeSessionHudBounds({
      hitRect: { left: 10, top: 80, right: 90, bottom: 160 },
      workArea: { x: 0, y: 0, width: 800, height: 600 },
    });

    assert.deepStrictEqual(result, {
      bounds: {
        x: 0,
        y: 160 + constants.HUD_PET_GAP,
        width: constants.HUD_WIDTH,
        height: constants.HUD_HEIGHT,
      },
      flippedAbove: false,
    });
  });

  it("flips above the hitbox when there is no room below", () => {
    const result = computeSessionHudBounds({
      hitRect: { left: 320, top: 520, right: 400, bottom: 590 },
      workArea: { x: 0, y: 0, width: 800, height: 620 },
    });

    assert.strictEqual(result.flippedAbove, true);
    assert.deepStrictEqual(result.bounds, {
      x: 240,
      y: 520 - constants.HUD_HEIGHT - constants.HUD_PET_GAP,
      width: constants.HUD_WIDTH,
      height: constants.HUD_HEIGHT,
    });
  });
});

describe("session HUD layout", () => {
  it("expands sessions up to the cap without folding", () => {
    const sessions = [
      mkSession("a"),
      mkSession("b"),
      mkSession("c"),
    ];
    const snapshot = { sessions, orderedIds: ["a", "b", "c"] };
    const { expanded, folded, rowCount } = computeHudLayout(snapshot);
    assert.deepStrictEqual(expanded.map((s) => s.id), ["a", "b", "c"]);
    assert.strictEqual(folded.length, 0);
    assert.strictEqual(rowCount, 3);
  });

  it("folds sessions beyond the 3-row cap", () => {
    const sessions = [];
    const orderedIds = [];
    for (let i = 0; i < 5; i++) {
      sessions.push(mkSession(`s${i}`));
      orderedIds.push(`s${i}`);
    }
    const { expanded, folded, rowCount } = computeHudLayout({ sessions, orderedIds });
    assert.strictEqual(expanded.length, constants.HUD_MAX_EXPANDED_ROWS);
    assert.strictEqual(folded.length, 5 - constants.HUD_MAX_EXPANDED_ROWS);
    assert.strictEqual(rowCount, constants.HUD_MAX_EXPANDED_ROWS + 1);
  });

  it("respects orderedIds for picking the expanded set (most recent first)", () => {
    const sessions = [
      mkSession("old"),
      mkSession("newest"),
      mkSession("middle"),
      mkSession("oldest"),
    ];
    const orderedIds = ["newest", "middle", "old", "oldest"];
    const { expanded, folded } = computeHudLayout({ sessions, orderedIds });
    assert.deepStrictEqual(expanded.map((s) => s.id), ["newest", "middle", "old"]);
    assert.deepStrictEqual(folded.map((s) => s.id), ["oldest"]);
  });

  it("excludes headless sessions from both expanded and folded counts", () => {
    const sessions = [
      mkSession("visible"),
      mkSession("hidden", { headless: true }),
    ];
    const { expanded, folded, rowCount } = computeHudLayout({
      sessions,
      orderedIds: ["visible", "hidden"],
    });
    assert.deepStrictEqual(expanded.map((s) => s.id), ["visible"]);
    assert.strictEqual(folded.length, 0);
    assert.strictEqual(rowCount, 1);
  });

  it("includes done idle sessions but excludes sleeping sessions", () => {
    const sessions = [
      mkSession("working", { state: "working" }),
      mkSession("done", { state: "idle", badge: "done" }),
      mkSession("sleeping", { state: "sleeping" }),
    ];
    const { expanded, folded, rowCount } = computeHudLayout({
      sessions,
      orderedIds: ["done", "working", "sleeping"],
    });
    assert.deepStrictEqual(expanded.map((s) => s.id), ["done", "working"]);
    assert.strictEqual(folded.length, 0);
    assert.strictEqual(rowCount, 2);
  });

  it("returns 0 rows for empty snapshot", () => {
    const { expanded, folded, rowCount } = computeHudLayout({ sessions: [] });
    assert.strictEqual(expanded.length, 0);
    assert.strictEqual(folded.length, 0);
    assert.strictEqual(rowCount, 0);
  });

  it("computeHudHeight multiplies row count by row height", () => {
    assert.strictEqual(
      computeHudHeight(3),
      constants.HUD_ROW_HEIGHT * 3
        + constants.HUD_BORDER_Y
    );
    assert.strictEqual(computeHudHeight(0), constants.HUD_ROW_HEIGHT);
    assert.strictEqual(computeHudHeight(-1), constants.HUD_ROW_HEIGHT);
  });
});
