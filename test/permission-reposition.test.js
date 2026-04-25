const { describe, it } = require("node:test");
const assert = require("node:assert");

const permission = require("../src/permission");
const { computeBubbleStackLayout } = permission.__test;

// Common defaults so each test only spells out what's interesting.
const BW = 340;
const MARGIN = 8;
const GAP = 6;
const FHD = { x: 0, y: 0, width: 1920, height: 1080 };

function layout(opts) {
  return computeBubbleStackLayout({
    bubbleWidth: BW,
    margin: MARGIN,
    gap: GAP,
    ...opts,
  });
}

describe("permission bubble stack layout", () => {
  it("hangs the stack from the pet hitbox when there is room below", () => {
    // 3 short bubbles, pet in upper-middle of a 1080p screen → below branch.
    const bounds = layout({
      followPet: true,
      bubbleHeights: [150, 150, 150],
      workArea: FHD,
      hitRect: { left: 800, top: 400, right: 920, bottom: 500 },
    });

    assert.deepStrictEqual(bounds, [
      { x: 690, y: 500, width: 340, height: 150 },
      { x: 690, y: 656, width: 340, height: 150 },
      { x: 690, y: 812, width: 340, height: 150 },
    ]);
  });

  it("falls to the right of the pet when below is too tight", () => {
    // Pet near bottom edge → no room below, right side has more room.
    const bounds = layout({
      followPet: true,
      bubbleHeights: [200, 200, 200],
      workArea: FHD,
      hitRect: { left: 800, top: 900, right: 920, bottom: 1000 },
    });

    // x = hitRight = 920, vertically centered then clamped to maxBottom (1072).
    assert.deepStrictEqual(bounds, [
      { x: 920, y: 460, width: 340, height: 200 },
      { x: 920, y: 666, width: 340, height: 200 },
      { x: 920, y: 872, width: 340, height: 200 },
    ]);
  });

  it("falls to the left of the pet when right is too tight", () => {
    // Pet hugging right edge → spaceRight < bw, must place left.
    const bounds = layout({
      followPet: true,
      bubbleHeights: [200, 200, 200],
      workArea: FHD,
      hitRect: { left: 1700, top: 900, right: 1820, bottom: 1000 },
    });

    // x = hitLeft - bw = 1700 - 340 = 1360.
    assert.deepStrictEqual(bounds, [
      { x: 1360, y: 460, width: 340, height: 200 },
      { x: 1360, y: 666, width: 340, height: 200 },
      { x: 1360, y: 872, width: 340, height: 200 },
    ]);
  });

  it("falls to the work area corner only when neither side has bw of clearance", () => {
    // Pet centered on a narrow display where neither side fits a 340-wide bubble.
    const bounds = layout({
      followPet: true,
      bubbleHeights: [200, 200, 200],
      workArea: { x: 0, y: 0, width: 600, height: 1080 },
      hitRect: { left: 250, top: 900, right: 350, bottom: 1000 },
    });

    // Corner fallback: x = 600 - 340 - 8 = 252, anchored to wa bottom.
    assert.deepStrictEqual(bounds, [
      { x: 252, y: 460, width: 340, height: 200 },
      { x: 252, y: 666, width: 340, height: 200 },
      { x: 252, y: 872, width: 340, height: 200 },
    ]);
  });

  it("anchors stack top when totalH overflows the work area (oldest stays visible)", () => {
    // 8 bubbles × 200 + 7 × 6 = 1642 px total — taller than the 1080p screen.
    // The clamp order intentionally pins the stack to the TOP of the work
    // area so the OLDEST bubble stays on screen and newer bubbles overflow
    // off the bottom. Rationale: oldest is the longest-waiting request and
    // Claude Code re-sends newest on timeout. Don't flip this without
    // updating the header comment in src/permission.js.
    const bounds = layout({
      followPet: true,
      bubbleHeights: Array(8).fill(200),
      workArea: FHD,
      hitRect: { left: 800, top: 400, right: 920, bottom: 500 },
    });

    // Oldest at margin (8), in the upper-left of the visible area.
    assert.strictEqual(bounds[0].y, 8);
    assert.strictEqual(bounds[0].y + bounds[0].height, 208);
    // Newest top at 1450, bottom at 1650 — overflows the 1080 work area.
    assert.strictEqual(bounds[7].y, 1450);
    assert.ok(
      bounds[7].y + bounds[7].height > FHD.y + FHD.height,
      "newest must overflow when stack is taller than the screen"
    );
    // All bubbles share the same x (side branch, no horizontal jitter).
    for (const b of bounds) assert.strictEqual(b.x, 920);
    // Visual order: oldest above newest at every adjacent pair.
    for (let i = 0; i < bounds.length - 1; i++) {
      assert.ok(bounds[i].y < bounds[i + 1].y, `bounds[${i}] must be above bounds[${i + 1}]`);
    }
  });

  it("keeps the stack on the pet's display on a multi-monitor setup (PR #89 regression)", () => {
    // Pet on the LEFT of a secondary display (work area starts at x=1920).
    // Pre-PR #89 the degraded branch would yank x to wa.x + wa.width - bw - margin
    // = 1920 + 1920 - 348 = 3492, putting the stack at the right edge of the
    // SECOND screen — over a thousand pixels away from the pet. The fix
    // anchors x to the right side of the pet hitbox instead.
    const secondScreen = { x: 1920, y: 0, width: 1920, height: 1080 };
    const bounds = layout({
      followPet: true,
      bubbleHeights: Array(4).fill(180),
      workArea: secondScreen,
      hitRect: { left: 2000, top: 400, right: 2120, bottom: 500 },
    });

    // x must hug the pet right edge, not flee to the corner.
    for (const b of bounds) {
      assert.strictEqual(b.x, 2120, "x must equal hitRight (right side of pet)");
      assert.ok(
        b.x >= secondScreen.x && b.x + b.width <= secondScreen.x + secondScreen.width,
        "bubble must stay on the pet's display"
      );
    }
    // Oldest above newest invariant still holds.
    for (let i = 0; i < bounds.length - 1; i++) {
      assert.ok(bounds[i].y < bounds[i + 1].y);
    }
  });

  it("never reverses the visual order when crossing layout branches", () => {
    // Same screen, same pet, same N — only the bubble heights differ such
    // that one fits below and the other forces side placement. Both must
    // satisfy oldest-above-newest. PR #89 fixed an order flip here that
    // happened when the previous totalH > wa.height/2 degradation kicked in.
    const common = {
      followPet: true,
      workArea: FHD,
      hitRect: { left: 800, top: 400, right: 920, bottom: 500 },
    };
    const belowBounds = layout({ ...common, bubbleHeights: [150, 150, 150] });
    const sideBounds = layout({ ...common, bubbleHeights: [300, 300, 300] });

    // Sanity: the two cases really do go through different branches
    // (below centers x on hitCx, side anchors on hitRight, so x must differ).
    assert.notStrictEqual(belowBounds[0].x, sideBounds[0].x);
    // Visual invariant must hold in BOTH branches.
    for (const bounds of [belowBounds, sideBounds]) {
      for (let i = 0; i < bounds.length - 1; i++) {
        assert.ok(
          bounds[i].y < bounds[i + 1].y,
          "oldest must always be visually above newest"
        );
      }
    }
  });

  it("falls back to bottom-right of the work area when followPet is off", () => {
    const bounds = layout({
      followPet: false,
      bubbleHeights: [200, 200, 200],
      workArea: FHD,
      hitRect: null,
    });

    // x = 1920 - 340 - 8 = 1572, anchored to wa bottom (1072).
    assert.deepStrictEqual(bounds, [
      { x: 1572, y: 460, width: 340, height: 200 },
      { x: 1572, y: 666, width: 340, height: 200 },
      { x: 1572, y: 872, width: 340, height: 200 },
    ]);
  });

  it("returns an empty array when there are no pending bubbles", () => {
    const bounds = layout({
      followPet: true,
      bubbleHeights: [],
      workArea: FHD,
      hitRect: { left: 800, top: 400, right: 920, bottom: 500 },
    });
    assert.deepStrictEqual(bounds, []);
  });

  it("uses (N-1) gaps in totalH, not N (off-by-one fix)", () => {
    // Hand-pick a case where the old N-gap formula and the new (N-1)-gap
    // formula straddle the below/side cutoff. With 3 bubbles of height 190
    // and gap 6 on a 1080p screen with hitBottom=500:
    //   below room = 580
    //   old totalH = 3 * (190 + 6) = 588  → 580 < 588 → side branch
    //   new totalH = 190*3 + 6*2 = 582    → 580 < 582 → still side
    // …pick 188 instead:
    //   old totalH = 3 * (188 + 6) = 582  → 580 < 582 → side
    //   new totalH = 188*3 + 6*2 = 576    → 580 ≥ 576 → below branch ✓
    const bounds = layout({
      followPet: true,
      bubbleHeights: [188, 188, 188],
      workArea: FHD,
      hitRect: { left: 800, top: 400, right: 920, bottom: 500 },
    });

    // Below branch: first bubble's y must equal hitBottom (500).
    assert.strictEqual(bounds[0].y, 500);
    assert.strictEqual(bounds[1].y, 500 + 188 + 6);
    assert.strictEqual(bounds[2].y, 500 + (188 + 6) * 2);
  });

  it("reserves the HUD lane before placing bubbles below the pet", () => {
    const bounds = layout({
      followPet: true,
      bubbleHeights: [150, 150],
      workArea: FHD,
      hitRect: { left: 800, top: 400, right: 920, bottom: 500 },
      hudReservedOffset: 38,
    });

    assert.deepStrictEqual(bounds, [
      { x: 690, y: 538, width: 340, height: 150 },
      { x: 690, y: 694, width: 340, height: 150 },
    ]);
  });

  it("includes the HUD reserve in the below-pet fit check", () => {
    const common = {
      followPet: true,
      bubbleHeights: [190],
      workArea: { x: 0, y: 0, width: 1920, height: 700 },
      hitRect: { left: 800, top: 400, right: 920, bottom: 500 },
    };

    const withoutHud = layout(common);
    const withHud = layout({ ...common, hudReservedOffset: 38 });

    assert.strictEqual(withoutHud[0].y, 500, "without HUD it still fits below");
    assert.strictEqual(withHud[0].x, 920, "with HUD reserve it falls to the side");
    assert.notStrictEqual(withHud[0].y, 538);
  });
});
