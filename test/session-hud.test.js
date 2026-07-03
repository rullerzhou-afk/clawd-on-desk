const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const sessionHud = require("../src/session-hud");
const {
  computeSessionHudBounds,
  computeHudLayout,
  computeHudHeight,
  getHudWidth,
  getHudWidthScale,
  computeHudOuterWidth,
  evaluateBaseEligible,
  evaluateShouldShow,
  pointInExpandedRect,
  computeAutoHideHotZone,
  pointInHotZone,
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
  it("uses wider HUD widths when state labels are enabled", () => {
    assert.strictEqual(
      getHudWidth(true, true),
      constants.HUD_WIDTH_LABELS - constants.HUD_LABELS_ONLY_WIDTH_TRIM
    );
    assert.strictEqual(
      getHudWidth(false, true),
      constants.HUD_WIDTH_LABELS_COMPACT - constants.HUD_LABELS_ONLY_WIDTH_TRIM
    );
    assert.strictEqual(getHudWidth(true, false), constants.HUD_WIDTH);
    assert.strictEqual(getHudWidth(false, false), constants.HUD_WIDTH_COMPACT);
    assert.strictEqual(
      getHudWidth(true, true, true),
      constants.HUD_WIDTH_LABELS + constants.HUD_CONTEXT_USAGE_WIDTH_BUMP
    );

    const result = computeSessionHudBounds({
      hitRect: { left: 10, top: 80, right: 90, bottom: 160 },
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      width: constants.HUD_WIDTH_COMPACT,
    });

    assert.strictEqual(result.contentBounds.width, constants.HUD_WIDTH_COMPACT);
    assert.strictEqual(
      result.bounds.width,
      constants.HUD_WIDTH_COMPACT + constants.HUD_WINDOW_SHELL.left + constants.HUD_WINDOW_SHELL.right
    );
  });

  it("positions the visible HUD card below the pet hitbox with a fixed gap", () => {
    const result = computeSessionHudBounds({
      hitRect: { left: 10, top: 80, right: 90, bottom: 160 },
      workArea: { x: 0, y: 0, width: 800, height: 600 },
    });

    assert.deepStrictEqual(result.contentBounds, {
      x: 0,
      y: 160 + constants.HUD_PET_GAP,
      width: constants.HUD_WIDTH,
      height: constants.HUD_HEIGHT,
    });
    assert.deepStrictEqual(result.bounds, {
      x: -constants.HUD_WINDOW_SHELL.left,
      y: 160 + constants.HUD_PET_GAP - constants.HUD_WINDOW_SHELL.top,
      width: constants.HUD_WIDTH + constants.HUD_WINDOW_SHELL.left + constants.HUD_WINDOW_SHELL.right,
      height: constants.HUD_HEIGHT + constants.HUD_WINDOW_SHELL.top + constants.HUD_WINDOW_SHELL.bottom,
    });
    assert.strictEqual(result.flippedAbove, false);
  });

  it("keeps the visible HUD card above the pet hitbox with a fixed gap when flipped", () => {
    const result = computeSessionHudBounds({
      hitRect: { left: 320, top: 520, right: 400, bottom: 590 },
      workArea: { x: 0, y: 0, width: 800, height: 620 },
    });

    assert.strictEqual(result.flippedAbove, true);
    assert.deepStrictEqual(result.contentBounds, {
      x: 240,
      y: 520 - constants.HUD_HEIGHT - constants.HUD_PET_GAP,
      width: constants.HUD_WIDTH,
      height: constants.HUD_HEIGHT,
    });
    assert.deepStrictEqual(result.bounds, {
      x: 240 - constants.HUD_WINDOW_SHELL.left,
      y: 520 - constants.HUD_HEIGHT - constants.HUD_PET_GAP - constants.HUD_WINDOW_SHELL.top,
      width: constants.HUD_WIDTH + constants.HUD_WINDOW_SHELL.left + constants.HUD_WINDOW_SHELL.right,
      height: constants.HUD_HEIGHT + constants.HUD_WINDOW_SHELL.top + constants.HUD_WINDOW_SHELL.bottom,
    });
  });

  it("uses a stable anchor rect instead of the dynamic hitbox when available", () => {
    const result = computeSessionHudBounds({
      hitRect: { left: 260, top: 50, right: 460, bottom: 220 },
      anchorRect: { left: 100, top: 80, right: 200, bottom: 160 },
      workArea: { x: 0, y: 0, width: 800, height: 600 },
    });

    assert.deepStrictEqual(result.contentBounds, {
      x: 150 - Math.round(constants.HUD_WIDTH / 2),
      y: 160 + constants.HUD_PET_GAP,
      width: constants.HUD_WIDTH,
      height: constants.HUD_HEIGHT,
    });
  });

  it("keeps the reserved offset aligned to the visible card height plus the bottom shell only", () => {
    const expected = constants.HUD_PET_GAP
      + constants.HUD_HEIGHT
      + constants.HUD_WINDOW_SHELL.bottom
      + constants.BUBBLE_GAP;
    assert.strictEqual(sessionHud.__test.computeHudReservedOffset(constants.HUD_HEIGHT), expected);
  });

  it("uses a bottom-heavier outer shell than the top and side edges", () => {
    assert.ok(constants.HUD_WINDOW_SHELL.bottom > constants.HUD_WINDOW_SHELL.top);
    assert.ok(constants.HUD_WINDOW_SHELL.bottom > constants.HUD_WINDOW_SHELL.left);
    assert.ok(constants.HUD_WINDOW_SHELL.bottom > constants.HUD_WINDOW_SHELL.right);
  });

  it("converts CSS px inputs to scaled DIP bounds when textScale is set", () => {
    const scale = 1.5;
    const result = computeSessionHudBounds({
      hitRect: { left: 10, top: 80, right: 90, bottom: 160 },
      workArea: { x: 0, y: 0, width: 1200, height: 900 },
      scale,
    });

    const dipWidth = Math.round(constants.HUD_WIDTH * scale);
    const dipHeight = Math.ceil(constants.HUD_HEIGHT * scale);
    const shellLeft = Math.round(constants.HUD_WINDOW_SHELL.left * scale);
    const shellRight = Math.round(constants.HUD_WINDOW_SHELL.right * scale);
    const shellTop = Math.round(constants.HUD_WINDOW_SHELL.top * scale);
    const shellBottom = Math.round(constants.HUD_WINDOW_SHELL.bottom * scale);
    const petGap = Math.round(constants.HUD_PET_GAP * scale);

    assert.deepStrictEqual(result.contentBounds, {
      x: 0,
      y: 160 + petGap,
      width: dipWidth,
      height: dipHeight,
    });
    assert.deepStrictEqual(result.bounds, {
      x: -shellLeft,
      y: 160 + petGap - shellTop,
      width: dipWidth + shellLeft + shellRight,
      height: dipHeight + shellTop + shellBottom,
    });
    assert.strictEqual(result.flippedAbove, false);
  });

  it("dampens large-text HUD width while keeping height and gaps at full scale", () => {
    const scale = 1.5;
    const widthScale = getHudWidthScale(scale);
    const width = constants.HUD_WIDTH_LABELS + constants.HUD_CONTEXT_USAGE_WIDTH_BUMP;
    const result = computeSessionHudBounds({
      hitRect: { left: 10, top: 80, right: 90, bottom: 160 },
      workArea: { x: 0, y: 0, width: 1200, height: 900 },
      width,
      scale,
      widthScale,
    });

    assert.strictEqual(widthScale, 1 + (scale - 1) * constants.HUD_WIDTH_GROWTH_RATIO);
    assert.strictEqual(result.contentBounds.width, Math.round(width * 1.2));
    assert.strictEqual(result.contentBounds.height, Math.ceil(constants.HUD_HEIGHT * scale));
    assert.strictEqual(result.contentBounds.y, 160 + Math.round(constants.HUD_PET_GAP * scale));
    assert.strictEqual(
      result.bounds.width,
      computeHudOuterWidth(width, scale, widthScale)
    );
    assert.ok(result.bounds.width < computeHudOuterWidth(width, scale, scale));
  });

  it("treats scale 1 (and an omitted scale) as the identity", () => {
    const args = {
      hitRect: { left: 10, top: 80, right: 90, bottom: 160 },
      workArea: { x: 0, y: 0, width: 800, height: 600 },
    };
    assert.deepStrictEqual(
      computeSessionHudBounds({ ...args, scale: 1 }),
      computeSessionHudBounds(args),
    );
  });

  it("clamps a garbage scale to the supported range before converting", () => {
    const result = computeSessionHudBounds({
      hitRect: { left: 10, top: 80, right: 90, bottom: 160 },
      workArea: { x: 0, y: 0, width: 1200, height: 900 },
      scale: 99,
    });
    assert.strictEqual(result.contentBounds.width, Math.round(constants.HUD_WIDTH * 1.6));
  });

  it("keeps the scaled pin corner inside the auto-hide hot zone at 150%", () => {
    // Regression: the hot zone used to be computed from UNSCALED expected
    // bounds, so at 150% the cursor "left" the zone while still visually over
    // the HUD — making the pin unreachable (HUD hid before you could click).
    const scale = 1.5;
    const widthScale = getHudWidthScale(scale);
    const hitRect = { left: 100, top: 80, right: 260, bottom: 240 };
    const workArea = { x: 0, y: 0, width: 2000, height: 1200 };
    const width = constants.HUD_WIDTH_LABELS + constants.HUD_CONTEXT_USAGE_WIDTH_BUMP; // 356

    const scaled = computeSessionHudBounds({ hitRect, workArea, width, scale, widthScale });
    const pad = Math.round(constants.HOT_ZONE_PAD * scale);
    const hotZone = computeAutoHideHotZone({
      petHitRect: hitRect,
      expectedHudContentBounds: scaled.contentBounds,
      pad,
    });

    // The pin lives near the top-right corner of the visible (scaled) HUD.
    const pinPoint = {
      x: scaled.contentBounds.x + scaled.contentBounds.width - 10,
      y: scaled.contentBounds.y + 10,
    };
    assert.strictEqual(pointInHotZone(pinPoint, hotZone), true);

    // Sanity: the OLD bug (unscaled expectation) excludes that same point.
    const unscaled = computeSessionHudBounds({ hitRect, workArea, width });
    const buggyZone = computeAutoHideHotZone({
      petHitRect: hitRect,
      expectedHudContentBounds: unscaled.contentBounds,
      pad: constants.HOT_ZONE_PAD,
    });
    assert.strictEqual(pointInHotZone(pinPoint, buggyZone), false);
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

  it("folds sessions beyond the 5-row label cap", () => {
    const sessions = [];
    const orderedIds = [];
    for (let i = 0; i < 7; i++) {
      sessions.push(mkSession(`s${i}`));
      orderedIds.push(`s${i}`);
    }
    const { expanded, folded, rowCount } = computeHudLayout({ sessions, orderedIds });
    assert.strictEqual(expanded.length, constants.HUD_MAX_EXPANDED_ROWS_LABELS);
    assert.strictEqual(folded.length, 7 - constants.HUD_MAX_EXPANDED_ROWS_LABELS);
    assert.strictEqual(rowCount, constants.HUD_MAX_EXPANDED_ROWS_LABELS + 1);
  });

  it("folds sessions beyond the 3-row cap when state labels are hidden", () => {
    const sessions = [];
    const orderedIds = [];
    for (let i = 0; i < 5; i++) {
      sessions.push(mkSession(`s${i}`));
      orderedIds.push(`s${i}`);
    }
    const { expanded, folded, rowCount } = computeHudLayout(
      { sessions, orderedIds },
      { showStateLabels: false }
    );
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
    const { expanded, folded } = computeHudLayout({ sessions, orderedIds }, { showStateLabels: false });
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

  it("excludes hidden sessions from both expanded and folded counts", () => {
    const sessions = [
      mkSession("visible"),
      mkSession("hidden", { hiddenFromHud: true }),
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

describe("session HUD auto-hide helpers", () => {
  const baseSnapshot = { sessions: [mkSession("a")] };
  const baseFlags = {
    snapshot: baseSnapshot,
    sessionHudEnabled: true,
    sessionHudPinned: false,
    clickRevealed: true,
    inHotZone: false,
    now: 1000,
    visibleHoldUntil: 0,
    hideGraceMs: 500,
    petHidden: false,
    miniMode: false,
    miniTransitioning: false,
  };

  it("evaluateBaseEligible returns false for guard branches", () => {
    assert.strictEqual(evaluateBaseEligible({ ...baseFlags, snapshot: null }), false);
    assert.strictEqual(evaluateBaseEligible({ ...baseFlags, sessionHudEnabled: false }), false);
    assert.strictEqual(evaluateBaseEligible({ ...baseFlags, petHidden: true }), false);
    assert.strictEqual(evaluateBaseEligible({ ...baseFlags, miniMode: true }), false);
    assert.strictEqual(evaluateBaseEligible({ ...baseFlags, miniTransitioning: true }), false);
    assert.strictEqual(evaluateBaseEligible({ ...baseFlags, snapshot: { sessions: [] } }), false);
    assert.strictEqual(evaluateBaseEligible(baseFlags), true);
  });

  it("evaluateShouldShow hides when clickRevealed is false (default hidden state)", () => {
    const r = evaluateShouldShow({ ...baseFlags, clickRevealed: false, inHotZone: true });
    assert.strictEqual(r.show, false);
    assert.strictEqual(r.nextHoldUntil, 0);
  });

  it("evaluateShouldShow hides when revealed + unpinned + outside zone + hold expired", () => {
    const r = evaluateShouldShow({
      ...baseFlags,
      clickRevealed: true,
      sessionHudPinned: false,
      inHotZone: false,
      visibleHoldUntil: 500,
      now: 1000,
    });
    assert.strictEqual(r.show, false);
    assert.strictEqual(r.nextHoldUntil, 500);
  });

  it("evaluateShouldShow shows when pinned regardless of clickRevealed or zone", () => {
    const r = evaluateShouldShow({
      ...baseFlags,
      clickRevealed: false,
      sessionHudPinned: true,
      inHotZone: false,
    });
    assert.strictEqual(r.show, true);
  });

  it("evaluateShouldShow advances visibleHoldUntil when revealed and in hot zone", () => {
    const r = evaluateShouldShow({
      ...baseFlags,
      clickRevealed: true,
      inHotZone: true,
      now: 1000,
      visibleHoldUntil: 0,
      hideGraceMs: 500,
    });
    assert.strictEqual(r.show, true);
    assert.strictEqual(r.nextHoldUntil, 1500);
  });

  it("evaluateShouldShow keeps HUD visible during hold-grace window after revealed", () => {
    const r = evaluateShouldShow({
      ...baseFlags,
      clickRevealed: true,
      inHotZone: false,
      now: 1200,
      visibleHoldUntil: 1500,
    });
    assert.strictEqual(r.show, true);
  });

  it("evaluateShouldShow hides once now >= visibleHoldUntil in revealed state", () => {
    const r = evaluateShouldShow({
      ...baseFlags,
      clickRevealed: true,
      inHotZone: false,
      now: 1500,
      visibleHoldUntil: 1500,
    });
    assert.strictEqual(r.show, false);
  });

  it("evaluateShouldShow honors base guards even when revealed", () => {
    const r = evaluateShouldShow({
      ...baseFlags,
      clickRevealed: true,
      petHidden: true,
      inHotZone: true,
    });
    assert.strictEqual(r.show, false);
  });

  it("pointInExpandedRect respects pad on all sides", () => {
    const rect = { left: 10, top: 10, right: 30, bottom: 30 };
    assert.strictEqual(pointInExpandedRect({ x: 20, y: 20 }, rect, 0), true);
    assert.strictEqual(pointInExpandedRect({ x: 5, y: 20 }, rect, 0), false);
    assert.strictEqual(pointInExpandedRect({ x: 5, y: 20 }, rect, 8), true);
    assert.strictEqual(pointInExpandedRect({ x: -5, y: 20 }, rect, 8), false);
    assert.strictEqual(pointInExpandedRect(null, rect, 0), false);
    assert.strictEqual(pointInExpandedRect({ x: 0, y: 0 }, null, 0), false);
  });

  it("computeAutoHideHotZone collects pet + expected HUD bounds, skips invalid", () => {
    const z1 = computeAutoHideHotZone({
      petHitRect: { left: 0, top: 0, right: 80, bottom: 80 },
      expectedHudContentBounds: { x: 0, y: 90, width: 240, height: 28 },
      pad: 24,
    });
    assert.strictEqual(z1.rects.length, 2);
    assert.strictEqual(z1.pad, 24);

    const z2 = computeAutoHideHotZone({
      petHitRect: { left: 0, top: 0, right: 80, bottom: 80 },
      expectedHudContentBounds: null,
      pad: 24,
    });
    assert.strictEqual(z2.rects.length, 1);

    const z3 = computeAutoHideHotZone({
      petHitRect: null,
      expectedHudContentBounds: null,
      pad: 24,
    });
    assert.strictEqual(z3.rects.length, 0);
  });

  it("pointInHotZone treats union of expanded rects", () => {
    const zone = computeAutoHideHotZone({
      petHitRect: { left: 0, top: 0, right: 80, bottom: 80 },
      expectedHudContentBounds: { x: 0, y: 100, width: 240, height: 28 },
      pad: 24,
    });
    assert.strictEqual(pointInHotZone({ x: 40, y: 40 }, zone), true); // pet
    assert.strictEqual(pointInHotZone({ x: 100, y: 110 }, zone), true); // hud
    assert.strictEqual(pointInHotZone({ x: 40, y: 90 }, zone), true); // gap covered by pad expansion
    assert.strictEqual(pointInHotZone({ x: 500, y: 500 }, zone), false);
  });
});

describe("session HUD v5 three-state runtime contracts (source-level)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "src", "session-hud.js"),
    "utf8"
  );

  it("revealFromPet seeds visibleHoldUntil with HIDE_GRACE_MS (HIGH 3 fix)", () => {
    // Inside revealFromPet, after setting clickRevealed, must seed hold.
    const revealFn = src.match(/function revealFromPet\(\)\s*\{[\s\S]*?\n  \}/);
    assert.ok(revealFn, "revealFromPet function missing");
    assert.ok(
      /visibleHoldUntil\s*=\s*Date\.now\(\)\s*\+\s*HIDE_GRACE_MS/.test(revealFn[0]),
      "revealFromPet must seed visibleHoldUntil = Date.now() + HIDE_GRACE_MS"
    );
    assert.ok(
      /clickRevealed\s*=\s*true/.test(revealFn[0]),
      "revealFromPet must set clickRevealed=true"
    );
  });

  it("handlePinnedChanged(false) reads real hudWindow.isVisible(), NOT shouldShow() (HIGH 2 fix)", () => {
    const pinFn = src.match(/function handlePinnedChanged\([\s\S]*?\n  \}/);
    assert.ok(pinFn, "handlePinnedChanged function missing");
    // Must read real window visibility — router has already mirrored
    // sessionHudPinned=false, so calling shouldShow() would return false.
    assert.ok(
      /hudWindow\.isVisible\(\)/.test(pinFn[0]),
      "handlePinnedChanged must read hudWindow.isVisible() for unpin transition"
    );
    assert.ok(
      !/wasVisible\s*=\s*shouldShow\(/.test(pinFn[0]),
      "handlePinnedChanged must NOT rely on shouldShow() to detect visibility"
    );
  });

  it("syncSessionHud entry clears clickRevealed when baseEligible drops (HIGH 1 stale defense)", () => {
    const syncFn = src.match(/function syncSessionHud\([\s\S]*?\n  \}/);
    assert.ok(syncFn, "syncSessionHud function missing");
    assert.ok(
      /if\s*\(!baseEligible\(snapshot\)\)\s*\{[\s\S]{0,80}clearReveal\(\)/.test(syncFn[0]),
      "syncSessionHud must clearReveal() when !baseEligible(snapshot)"
    );
  });

  it("isAutoHidePollingNeeded gates on clickRevealed only (no hover-mode regression)", () => {
    const pollFn = src.match(/function isAutoHidePollingNeeded\(\)\s*\{[\s\S]*?\n  \}/);
    assert.ok(pollFn, "isAutoHidePollingNeeded function missing");
    assert.ok(
      /return\s+clickRevealed\s*===\s*true/.test(pollFn[0]),
      "polling must require clickRevealed (not autoHide)"
    );
    assert.ok(
      !/sessionHudAutoHide/.test(pollFn[0]),
      "polling must NOT reference removed sessionHudAutoHide"
    );
  });

  it("exposes v5 three-state API surface", () => {
    assert.ok(/revealFromPet,\s*\n\s*handlePinnedChanged,\s*\n\s*clearReveal/.test(src),
      "module return must expose revealFromPet/handlePinnedChanged/clearReveal");
  });

  it("snapshot to renderer no longer includes hudAutoHide", () => {
    assert.ok(!/hudAutoHide:/.test(src),
      "session-hud must not send hudAutoHide in snapshot");
  });

  it("destroys hidden HUD windows (low power idle mode) to release renderer memory", () => {
    assert.ok(
      /const\s+HIDDEN_WINDOW_DESTROY_MS\s*=\s*30000/.test(src),
      "session-hud should define a hidden-window destroy delay"
    );
    assert.ok(
      /function scheduleHiddenDestroy\(\)\s*\{[\s\S]*?if\s*\(!ctx\.lowPowerIdleMode\)\s*return;/.test(src),
      "hidden-window destroy must be gated behind low power idle mode"
    );
    assert.ok(
      /function scheduleHiddenDestroy\(\)\s*\{[\s\S]*?hudWindow\.destroy\(\)/.test(src),
      "hidden HUD cleanup must eventually destroy the BrowserWindow"
    );
    assert.ok(
      /function hideSessionHud\(\)\s*\{[\s\S]*?scheduleHiddenDestroy\(\)/.test(src),
      "hiding the HUD should schedule hidden-window cleanup"
    );
    assert.ok(
      /function showSessionHud\(win\)\s*\{[\s\S]*?cancelHiddenDestroy\(\)/.test(src),
      "showing the HUD should cancel hidden-window cleanup"
    );
  });
});
