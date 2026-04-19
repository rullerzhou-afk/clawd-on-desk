"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createSizeSliderController,
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
