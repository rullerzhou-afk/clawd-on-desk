const { describe, it } = require("node:test");
const assert = require("node:assert");

const updateBubble = require("../src/update-bubble");

describe("update bubble follow-pet positioning", () => {
  it("anchors a short bubble below the follow rect with a fixed gap when there is room", () => {
    const bounds = updateBubble.__test.computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 150,
      reservedHeight: 0,
      workArea: { x: 0, y: 0, width: 800, height: 900 },
      petBounds: { x: 300, y: 60, width: 120, height: 120 },
      anchorRect: { left: 320, top: 88, right: 400, bottom: 168 },
    });

    assert.deepStrictEqual(bounds, { x: 190, y: 174, width: 340, height: 150 });
  });

  it("stacks below visible permission bubbles when following the pet", () => {
    const bounds = updateBubble.__test.computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 150,
      reservedHeight: 206,
      workArea: { x: 0, y: 0, width: 800, height: 900 },
      petBounds: { x: 300, y: 60, width: 120, height: 120 },
      hitRect: { left: 320, top: 88, right: 400, bottom: 168 },
    });

    assert.deepStrictEqual(bounds, { x: 190, y: 380, width: 340, height: 150 });
  });

  it("falls back when the permission stack reserve consumes the below-pet lane", () => {
    const bounds = updateBubble.__test.computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 150,
      reservedHeight: 600,
      workArea: { x: 0, y: 0, width: 800, height: 900 },
      petBounds: { x: 300, y: 60, width: 120, height: 120 },
      anchorRect: { left: 320, top: 88, right: 400, bottom: 168 },
    });

    assert.deepStrictEqual(bounds, { x: 406, y: 53, width: 340, height: 150 });
  });

  it("keeps an error bubble below the pet with the same fixed gap", () => {
    const bounds = updateBubble.__test.computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 300,
      reservedHeight: 0,
      workArea: { x: 0, y: 0, width: 800, height: 800 },
      petBounds: { x: 300, y: 120, width: 120, height: 120 },
      anchorRect: { left: 320, top: 140, right: 400, bottom: 220 },
    });

    assert.deepStrictEqual(bounds, { x: 190, y: 226, width: 340, height: 300 });
  });

  it("uses above-pet placement with the same fixed gap before side fallback", () => {
    assert.ok(updateBubble.__test && typeof updateBubble.__test.computeUpdateBubbleBounds === "function");

    const bounds = updateBubble.__test.computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 220,
      reservedHeight: 0,
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      petBounds: { x: 300, y: 420, width: 120, height: 120 },
      anchorRect: { left: 320, top: 440, right: 400, bottom: 520 },
    });

    assert.deepStrictEqual(bounds, { x: 190, y: 214, width: 340, height: 220 });
  });

  it("keeps a tall error bubble vertically attached to the pet instead of dropping to the workspace corner", () => {
    const bounds = updateBubble.__test.computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 300,
      reservedHeight: 0,
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      petBounds: { x: 300, y: 260, width: 120, height: 120 },
      anchorRect: { left: 320, top: 280, right: 400, bottom: 360 },
    });

    assert.deepStrictEqual(bounds, { x: 406, y: 170, width: 340, height: 300 });
  });

  it("offsets side fallback by the follow gap so the bubble still reads as attached to the pet", () => {
    const bounds = updateBubble.__test.computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 520,
      reservedHeight: 0,
      workArea: { x: 0, y: 0, width: 800, height: 600 },
      petBounds: { x: 300, y: 200, width: 120, height: 120 },
      anchorRect: { left: 320, top: 220, right: 400, bottom: 300 },
    });

    assert.deepStrictEqual(bounds, { x: 406, y: 8, width: 340, height: 520 });
  });

  it("prefers a stable anchorRect over a dynamic hitRect when both are provided", () => {
    const bounds = updateBubble.__test.computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 150,
      reservedHeight: 0,
      workArea: { x: 0, y: 0, width: 800, height: 900 },
      petBounds: { x: 300, y: 60, width: 120, height: 120 },
      anchorRect: { left: 320, top: 88, right: 400, bottom: 168 },
      hitRect: { left: 320, top: 100, right: 400, bottom: 220 },
    });

    assert.deepStrictEqual(bounds, { x: 190, y: 174, width: 340, height: 150 });
  });

  it("starts below the HUD reserve when no permission stack is present", () => {
    const bounds = updateBubble.__test.computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 150,
      reservedHeight: 0,
      hudReservedOffset: 38,
      workArea: { x: 0, y: 0, width: 800, height: 900 },
      petBounds: { x: 300, y: 60, width: 120, height: 120 },
      anchorRect: { left: 320, top: 88, right: 400, bottom: 168 },
      hitRect: { left: 320, top: 100, right: 400, bottom: 220 },
    });

    assert.deepStrictEqual(bounds, { x: 190, y: 212, width: 340, height: 150 });
  });

  it("places update bubbles after both HUD and permission stack offsets", () => {
    const bounds = updateBubble.__test.computeUpdateBubbleBounds({
      bubbleFollowPet: true,
      width: 340,
      edgeMargin: 8,
      gap: 6,
      height: 150,
      reservedHeight: 206,
      hudReservedOffset: 38,
      workArea: { x: 0, y: 0, width: 800, height: 900 },
      petBounds: { x: 300, y: 60, width: 120, height: 120 },
      anchorRect: { left: 320, top: 88, right: 400, bottom: 168 },
      hitRect: { left: 320, top: 100, right: 400, bottom: 220 },
    });

    assert.deepStrictEqual(bounds, { x: 190, y: 418, width: 340, height: 150 });
  });
});
