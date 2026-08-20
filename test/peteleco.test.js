"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");

const initPeteleco = require("../src/peteleco");
const { PETELECO_FRAME_MS } = require("../src/peteleco-geometry");

const PET_START = { x: 500, y: 400, width: 100, height: 100 };

function makeCtx(overrides = {}) {
  const bounds = { ...PET_START };
  const calls = [];
  const applied = [];
  const projections = [];
  let cursor = { x: 550, y: 450 };

  const ctx = {
    win: { isDestroyed: () => false },
    getPetWindowBounds: () => ({ ...bounds }),
    getEffectiveCurrentPixelSize: () => ({ width: bounds.width, height: bounds.height }),
    getCursorScreenPoint: () => ({ ...cursor }),
    // No clamp by default: these tests are about the runtime, and the clamp
    // itself is covered in peteleco-geometry.test.js.
    clampPosition: null,
    applyPetWindowBounds: (next) => {
      applied.push({ ...next });
      bounds.x = next.x;
      bounds.y = next.y;
      bounds.width = next.width;
      bounds.height = next.height;
    },
    syncHitWin: () => calls.push("syncHitWin"),
    repositionAnchoredSurfaces: () => calls.push("repositionAnchoredSurfaces"),
    repositionBubbles: () => calls.push("repositionBubbles"),
    releaseReconcileProtection: () => calls.push("releaseReconcileProtection"),
    isDragLocked: () => false,
    getMiniMode: () => false,
    isMiniTransitioning: () => false,
    isDndEnabled: () => false,
    startFlickReaction: (direction) => calls.push(`startFlickReaction:${direction}`),
    endFlickReaction: () => calls.push("endFlickReaction"),
    showProjection: (shot) => { projections.push(shot); calls.push("showProjection"); },
    hideProjection: () => calls.push("hideProjection"),
    fadeProjection: () => calls.push("fadeProjection"),
    getPetVisualCenter: (bounds) => ({
      // Stands in for the real anchor: horizontally the window's middle,
      // vertically well below it — the actual shape of clawd's offset.
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height * 0.66,
    }),
    finalizeFlick: () => calls.push("finalizeFlick"),
    bubbleFollowPet: false,
    pendingPermissions: [],
    ...overrides,
  };

  return {
    ctx,
    calls,
    applied,
    projections,
    bounds,
    setCursor(next) { cursor = next; },
  };
}

// Pull the cursor 100px to the RIGHT of the press point: the shot goes LEFT.
function pullRight(harness, amount = 100) {
  harness.setCursor({ x: 550 + amount, y: 450 });
}

describe("peteleco runtime", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("does nothing at all while disabled", () => {
    const h = makeCtx();
    const peteleco = initPeteleco(h.ctx);

    assert.strictEqual(peteleco.beginAim(), false);
    pullRight(h);
    assert.strictEqual(peteleco.updateAim(), null);
    assert.strictEqual(peteleco.releaseAim(), false);
    assert.deepStrictEqual(h.applied, []);
    assert.deepStrictEqual(h.projections, []);
  });

  it("draws no projection until the pull passes the click threshold", () => {
    const h = makeCtx();
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);

    assert.strictEqual(peteleco.beginAim(), true);
    assert.strictEqual(peteleco.isAiming(), true);
    // Cursor has not moved: a modifier-click must look exactly like a click.
    assert.strictEqual(peteleco.updateAim(), null);
    assert.deepStrictEqual(h.projections, []);

    pullRight(h, 3);
    assert.strictEqual(peteleco.updateAim(), null);
    assert.deepStrictEqual(h.projections, []);
  });

  it("projects on the opposite side of the pull and never moves the pet while aiming", () => {
    const h = makeCtx();
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h);

    const shot = peteleco.updateAim();
    assert.ok(shot);
    assert.ok(shot.to.x < shot.from.x, "shot must head left when the pull went right");
    assert.strictEqual(h.projections.length, 1);
    // The pet is the cue ball: aiming writes no bounds.
    assert.deepStrictEqual(h.applied, []);
    assert.deepStrictEqual(h.bounds, { ...PET_START });
  });

  it("draws from the avatar's middle, not the window's", () => {
    const h = makeCtx();
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h);
    const shot = peteleco.updateAim();

    const windowCenterY = PET_START.y + PET_START.height / 2;
    assert.strictEqual(shot.from.x, PET_START.x + PET_START.width / 2);
    assert.strictEqual(shot.from.y, Math.round(PET_START.y + PET_START.height * 0.66));
    assert.ok(shot.from.y > windowCenterY, "the sprite sits below the window's middle");
  });

  it("keeps the anchor honest when the pose changes mid-aim", () => {
    // The pet keeps animating while you aim; a pose swap can move the art
    // inside an unchanged launch rect, so the anchor is resolved per update
    // rather than frozen at beginAim.
    let ratio = 0.66;
    const h = makeCtx({
      getPetVisualCenter: (bounds) => ({
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height * ratio,
      }),
    });
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h);
    const before = peteleco.updateAim();

    ratio = 0.5;
    const after = peteleco.updateAim();
    assert.ok(after.from.y < before.from.y);
  });

  it("lets a shot cross onto another display — the clamp is not pinned to one", () => {
    // The clamp resolves the work area from the TARGET's centre, so a hard shot
    // near a seam carries the pet onto the neighbouring monitor. The runtime
    // must not narrow that: it hands the clamp the raw target and animates to
    // whatever comes back.
    const NEIGHBOUR = { x: -1920, y: 0 };
    const h = makeCtx({
      // Mimics a monitor to the LEFT accepting the landing point unchanged.
      clampPosition: (x, y) => ({ x, y }),
    });
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.setIntensity(100);
    peteleco.beginAim();
    // Pull far right → the shot heads far left, past x=0 into the neighbour.
    pullRight(h, 4000);
    const shot = peteleco.updateAim();

    assert.ok(shot.target.x < NEIGHBOUR.x + 1920, "the target must land on the neighbour");
    peteleco.releaseAim();
    mock.timers.tick(3000);

    const landed = h.applied[h.applied.length - 1];
    assert.strictEqual(landed.x, shot.target.x);
    assert.ok(h.calls.includes("finalizeFlick"));
  });

  it("passes the clamp exactly four arguments, with no display pinned", () => {
    // A fifth argument used to force the launch display's work area; nothing
    // may reintroduce that silently.
    const seen = [];
    const h = makeCtx({
      clampPosition: (...args) => {
        seen.push(args);
        return { x: args[0], y: args[1] };
      },
    });
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h);
    peteleco.updateAim();

    assert.ok(seen.length > 0, "the clamp must actually run");
    for (const args of seen) {
      assert.strictEqual(args.length, 4, `clamp got ${args.length} args: ${JSON.stringify(args)}`);
    }
  });

  it("a live intensity change repaints an open projection", () => {
    const h = makeCtx();
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.setIntensity(100);
    peteleco.beginAim();
    pullRight(h, 400);
    const strong = peteleco.updateAim();

    peteleco.setIntensity(5);
    const weak = h.projections[h.projections.length - 1];
    assert.ok(weak.distance < strong.distance);
  });

  it("launches on release, lands on the aimed target, and finalizes once", () => {
    const h = makeCtx();
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h);
    const shot = peteleco.updateAim();

    assert.strictEqual(peteleco.releaseAim(), true);
    assert.strictEqual(peteleco.isAiming(), false);
    assert.strictEqual(peteleco.isFlicking(), true);
    // The projection dissolves over the launch rather than popping out on
    // mouse-up — that is the fade, and it is NOT the cancel path.
    assert.ok(h.calls.includes("fadeProjection"));
    assert.ok(h.calls.includes("startFlickReaction:left"));

    mock.timers.tick(2000);

    assert.strictEqual(peteleco.isFlicking(), false);
    assert.ok(h.applied.length > 1, "the flick must animate, not teleport");
    const landed = h.applied[h.applied.length - 1];
    assert.strictEqual(landed.x, shot.target.x);
    assert.strictEqual(landed.y, shot.target.y);
    // #569: every frame carries the launch size.
    assert.ok(h.applied.every((b) => b.width === PET_START.width && b.height === PET_START.height));
    assert.strictEqual(h.calls.filter((c) => c === "finalizeFlick").length, 1);
    assert.strictEqual(h.calls.filter((c) => c === "endFlickReaction").length, 1);
    assert.strictEqual(h.calls.filter((c) => c === "releaseReconcileProtection").length, 1);
  });

  it("keeps the pet still and finalizes nothing when the gesture is cancelled", () => {
    const h = makeCtx();
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h);
    peteleco.updateAim();

    assert.strictEqual(peteleco.cancelAim(), true);
    mock.timers.tick(2000);

    assert.strictEqual(peteleco.isAiming(), false);
    assert.strictEqual(peteleco.isFlicking(), false);
    assert.deepStrictEqual(h.applied, []);
    assert.ok(!h.calls.includes("finalizeFlick"));
    // Cancel clears at once: a projection must not linger describing a shot
    // nobody fired.
    assert.ok(h.calls.includes("hideProjection"));
    assert.ok(!h.calls.includes("fadeProjection"));
  });

  it("a release with no pull fires nothing", () => {
    const h = makeCtx();
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();

    assert.strictEqual(peteleco.releaseAim(), false);
    mock.timers.tick(2000);
    assert.deepStrictEqual(h.applied, []);
    assert.ok(!h.calls.includes("finalizeFlick"));
    // Nothing was launched, so there is nothing to dissolve over.
    assert.ok(!h.calls.includes("fadeProjection"));
  });

  it("holds the reconcile protection for the whole flight and releases it exactly once", () => {
    const h = makeCtx();
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h);
    peteleco.updateAim();
    peteleco.releaseAim();

    mock.timers.tick(PETELECO_FRAME_MS);
    assert.strictEqual(peteleco.isFlicking(), true);
    assert.strictEqual(h.calls.filter((c) => c === "releaseReconcileProtection").length, 0);

    mock.timers.tick(2000);
    assert.strictEqual(h.calls.filter((c) => c === "releaseReconcileProtection").length, 1);
  });

  it("treats a drag lock at launch as a real grab and refuses to fly", () => {
    // The gesture's own lock is released by the aim-end IPC handler BEFORE the
    // shot is fired (test/pet-interaction-ipc.test.js pins that), so a lock
    // still held here can only be someone else owning the pet's position.
    // Nothing about the launch depends on message ordering any more.
    const h = makeCtx({ isDragLocked: () => true });
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h);
    peteleco.updateAim();

    peteleco.releaseAim();
    mock.timers.tick(2000);

    assert.strictEqual(peteleco.isFlicking(), false);
    assert.ok(!h.calls.includes("finalizeFlick"));
    assert.deepStrictEqual(h.applied, []);
  });

  it("a grab mid-flight aborts the flick without finalizing", () => {
    let dragLocked = false;
    const h = makeCtx({ isDragLocked: () => dragLocked });
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h, 400);
    peteleco.updateAim();
    peteleco.releaseAim();

    mock.timers.tick(PETELECO_FRAME_MS * 2);
    const framesBefore = h.applied.length;
    dragLocked = true;
    mock.timers.tick(2000);

    assert.strictEqual(peteleco.isFlicking(), false);
    assert.strictEqual(h.applied.length, framesBefore, "no frame may land after the grab");
    assert.ok(!h.calls.includes("finalizeFlick"));
    // The protection period still has to be handed back.
    assert.strictEqual(h.calls.filter((c) => c === "releaseReconcileProtection").length, 1);
  });

  it("entering mini mode mid-flight aborts the flick", () => {
    let mini = false;
    const h = makeCtx({ getMiniMode: () => mini });
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h, 400);
    peteleco.updateAim();
    peteleco.releaseAim();

    mock.timers.tick(PETELECO_FRAME_MS);
    mini = true;
    mock.timers.tick(2000);

    assert.strictEqual(peteleco.isFlicking(), false);
    assert.ok(!h.calls.includes("finalizeFlick"));
  });

  it("refuses to start in mini mode or mid mini transition", () => {
    const mini = makeCtx({ getMiniMode: () => true });
    const petelecoMini = initPeteleco(mini.ctx);
    petelecoMini.setEnabled(true);
    assert.strictEqual(petelecoMini.beginAim(), false);

    const transitioning = makeCtx({ isMiniTransitioning: () => true });
    const petelecoTransition = initPeteleco(transitioning.ctx);
    petelecoTransition.setEnabled(true);
    assert.strictEqual(petelecoTransition.beginAim(), false);
  });

  it("suppresses the in-flight reaction under Do Not Disturb but still flies", () => {
    const h = makeCtx({ isDndEnabled: () => true });
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h);
    peteleco.updateAim();
    peteleco.releaseAim();
    mock.timers.tick(2000);

    assert.ok(!h.calls.some((c) => c.startsWith("startFlickReaction")));
    assert.ok(h.applied.length > 1);
    assert.ok(h.calls.includes("finalizeFlick"));
  });

  it("a second gesture supersedes an in-flight shot instead of racing it", () => {
    const h = makeCtx();
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h, 400);
    peteleco.updateAim();
    peteleco.releaseAim();
    mock.timers.tick(PETELECO_FRAME_MS);
    assert.strictEqual(peteleco.isFlicking(), true);

    assert.strictEqual(peteleco.beginAim(), true);
    assert.strictEqual(peteleco.isFlicking(), false);
    const framesBefore = h.applied.length;
    mock.timers.tick(2000);
    assert.strictEqual(h.applied.length, framesBefore);
  });

  it("disabling the feature tears down an aim and an in-flight shot", () => {
    const h = makeCtx();
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h, 400);
    peteleco.updateAim();
    peteleco.releaseAim();
    mock.timers.tick(PETELECO_FRAME_MS);

    peteleco.setEnabled(false);
    const framesBefore = h.applied.length;
    mock.timers.tick(2000);

    assert.strictEqual(peteleco.isActive(), false);
    assert.strictEqual(h.applied.length, framesBefore);
    assert.ok(!h.calls.includes("finalizeFlick"));
  });

  it("isActive covers both phases so roam can stand down for the whole gesture", () => {
    const h = makeCtx();
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    assert.strictEqual(peteleco.isActive(), false);

    peteleco.beginAim();
    assert.strictEqual(peteleco.isActive(), true, "aiming counts");

    pullRight(h);
    peteleco.updateAim();
    peteleco.releaseAim();
    mock.timers.tick(PETELECO_FRAME_MS);
    assert.strictEqual(peteleco.isAiming(), false);
    assert.strictEqual(peteleco.isActive(), true, "flying counts too");

    mock.timers.tick(2000);
    assert.strictEqual(peteleco.isActive(), false);
  });

  it("a destroyed pet window ends the flight without finalizing", () => {
    let destroyed = false;
    const h = makeCtx();
    h.ctx.win = { isDestroyed: () => destroyed };
    const peteleco = initPeteleco(h.ctx);
    peteleco.setEnabled(true);
    peteleco.beginAim();
    pullRight(h, 400);
    peteleco.updateAim();
    peteleco.releaseAim();

    mock.timers.tick(PETELECO_FRAME_MS);
    destroyed = true;
    mock.timers.tick(2000);

    assert.strictEqual(peteleco.isFlicking(), false);
    assert.ok(!h.calls.includes("finalizeFlick"));
    assert.strictEqual(h.calls.filter((c) => c === "releaseReconcileProtection").length, 1);
  });
});
