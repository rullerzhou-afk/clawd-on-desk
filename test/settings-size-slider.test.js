"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createSizeSliderController,
  getSizeSliderAnchorPx,
  SIZE_SLIDER_THUMB_DIAMETER,
} = require("../src/settings-size-slider");

describe("settings size slider controller", () => {
  it("previews during drag and commits only once when drag-end signals race", async () => {
    const calls = [];
    const localValues = [];
    const dragStates = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 10,
      settingsAPI: {
        beginSizePreview: async () => { calls.push(["begin"]); },
        previewSize: async (value) => { calls.push(["preview", value]); },
        endSizePreview: async (value) => { calls.push(["end", value]); return { status: "ok" }; },
      },
      onLocalValue: (value) => localValues.push(value),
      onDraggingChange: (dragging, pending) => dragStates.push([dragging, pending]),
      onError: (message) => { throw new Error(`unexpected error: ${message}`); },
    });

    await controller.pointerDown();
    await controller.input(40);
    await Promise.all([
      controller.pointerUp(),
      controller.change(40),
    ]);

    assert.deepStrictEqual(calls, [
      ["begin"],
      ["preview", "P:12"],
      ["end", "P:12"],
    ]);
    assert.deepStrictEqual(localValues, [40, 40]);
    assert.deepStrictEqual(dragStates, [
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  it("finalizes the latest draft on blur if dragging is interrupted", async () => {
    const calls = [];
    const controller = createSizeSliderController({
      readSnapshotUi: () => 20,
      settingsAPI: {
        beginSizePreview: async () => { calls.push(["begin"]); },
        previewSize: async (value) => { calls.push(["preview", value]); },
        endSizePreview: async (value) => { calls.push(["end", value]); return { status: "ok" }; },
      },
      onLocalValue: () => {},
      onDraggingChange: () => {},
      onError: (message) => { throw new Error(`unexpected error: ${message}`); },
    });

    await controller.pointerDown();
    await controller.input(55);
    await controller.blur();

    assert.deepStrictEqual(calls, [
      ["begin"],
      ["preview", "P:16.5"],
      ["end", "P:16.5"],
    ]);
  });
});

describe("settings size slider geometry", () => {
  it("anchors bubble/ticks to the actual thumb center instead of raw percent width", () => {
    assert.strictEqual(
      getSizeSliderAnchorPx({
        value: 1,
        min: 1,
        max: 100,
        sliderWidth: 200,
        thumbDiameter: SIZE_SLIDER_THUMB_DIAMETER,
      }),
      SIZE_SLIDER_THUMB_DIAMETER / 2
    );

    assert.strictEqual(
      getSizeSliderAnchorPx({
        value: 100,
        min: 1,
        max: 100,
        sliderWidth: 200,
        thumbDiameter: SIZE_SLIDER_THUMB_DIAMETER,
      }),
      200 - (SIZE_SLIDER_THUMB_DIAMETER / 2)
    );

    assert.strictEqual(
      getSizeSliderAnchorPx({
        value: 50.5,
        min: 1,
        max: 100,
        sliderWidth: 200,
        thumbDiameter: SIZE_SLIDER_THUMB_DIAMETER,
      }),
      100
    );
  });

  it("recomputes the same value against a new slider width", () => {
    assert.strictEqual(
      getSizeSliderAnchorPx({
        value: 75,
        min: 1,
        max: 100,
        sliderWidth: 240,
        thumbDiameter: SIZE_SLIDER_THUMB_DIAMETER,
      }),
      174.93939393939394
    );

    assert.strictEqual(
      getSizeSliderAnchorPx({
        value: 75,
        min: 1,
        max: 100,
        sliderWidth: 320,
        thumbDiameter: SIZE_SLIDER_THUMB_DIAMETER,
      }),
      234.73737373737376
    );
  });
});
