"use strict";

const { describe, it, afterEach, mock } = require("node:test");
const assert = require("node:assert");

const schema = require("../src/theme-schema");

afterEach(() => {
  mock.restoreAll();
});

function validThemeJson(overrides = {}) {
  return {
    schemaVersion: 1,
    name: "Test",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states: {
      idle: ["idle.svg"],
      yawning: ["yawning.svg"],
      dozing: ["dozing.svg"],
      collapsing: ["collapsing.svg"],
      thinking: ["thinking.svg"],
      working: ["working.svg"],
      sleeping: ["sleeping.svg"],
      waking: ["waking.svg"],
    },
    ...overrides,
  };
}

describe("theme schema validation", () => {
  it("validates schema, rendering, and update bubble anchor shape", () => {
    const errors = schema.validateTheme({
      schemaVersion: 2,
      states: {},
      viewBox: { x: 0, y: 0, width: 0 },
      rendering: { svgChannel: "img" },
      updateBubbleAnchorBox: { x: 0, y: "bad", width: 10, height: 10 },
    });

    assert.ok(errors.some((error) => error.includes("schemaVersion must be 1")));
    assert.ok(errors.some((error) => error.includes("missing required field: name")));
    assert.ok(errors.some((error) => error.includes("missing or incomplete viewBox")));
    assert.ok(errors.some((error) => error.includes('rendering.svgChannel must be "auto" or "object"')));
    assert.ok(errors.some((error) => error.includes("updateBubbleAnchorBox must include finite")));
  });

  it("treats sleepSequence.mode=direct as not requiring full sleep art", () => {
    const errors = schema.validateTheme(validThemeJson({
      sleepSequence: { mode: "direct" },
      states: {
        idle: ["idle.svg"],
        thinking: ["thinking.svg"],
        working: ["working.svg"],
        sleeping: ["sleeping.svg"],
      },
    }));

    assert.deepStrictEqual(errors, []);
  });

  it("rejects invalid fallback chains and mini themes missing required mini states", () => {
    const errors = schema.validateTheme(validThemeJson({
      states: {
        idle: ["idle.svg"],
        yawning: ["yawning.svg"],
        dozing: ["dozing.svg"],
        collapsing: ["collapsing.svg"],
        thinking: ["thinking.svg"],
        working: ["working.svg"],
        sleeping: { fallbackTo: "attention" },
        waking: ["waking.svg"],
        attention: { fallbackTo: "sleeping" },
      },
      miniMode: {
        supported: true,
        states: {
          "mini-idle": ["mini-idle.svg"],
        },
      },
    }));

    assert.ok(errors.some((error) => error.includes("states.sleeping.fallbackTo forms a cycle")));
    assert.ok(errors.some((error) => error.includes("miniMode.supported=true requires miniMode.states.mini-enter")));
  });
});

describe("theme schema defaults and normalization", () => {
  it("mergeDefaults applies defaults and sanitizes runtime file references", () => {
    const theme = schema.mergeDefaults(validThemeJson({
      states: {
        idle: ["../idle.svg"],
        yawning: ["yawning.svg"],
        dozing: ["dozing.svg"],
        collapsing: ["collapsing.svg"],
        thinking: ["nested/thinking.svg"],
        working: ["working.svg"],
        sleeping: { files: ["sleeping.svg"], fallbackTo: null },
        waking: ["waking.svg"],
      },
      sounds: { complete: "../complete.wav" },
      reactions: {
        drag: { file: "../drag.svg", fileLeft: "../drag-left.svg", fileRight: "nested/drag-right.svg" },
        double: { files: ["nested/a.svg", "../b.svg"] },
      },
      workingTiers: [{ minSessions: 2, file: "../tier.svg" }],
      idleAnimations: [{ file: "../look.svg", duration: 100 }],
      displayHintMap: { "../old.svg": "../new.svg" },
      updateVisuals: { checking: "../checking.svg" },
    }), "demo", true);

    assert.strictEqual(theme._id, "demo");
    assert.strictEqual(theme.timings.minDisplay.working, 1000);
    assert.deepStrictEqual(theme.states.idle, ["idle.svg"]);
    assert.deepStrictEqual(theme.states.thinking, ["thinking.svg"]);
    assert.deepStrictEqual(theme._stateBindings.sleeping, { files: ["sleeping.svg"], fallbackTo: null });
    assert.strictEqual(theme.sounds.complete, "complete.wav");
    assert.strictEqual(theme.reactions.drag.file, "drag.svg");
    assert.strictEqual(theme.reactions.drag.fileLeft, "drag-left.svg");
    assert.strictEqual(theme.reactions.drag.fileRight, "drag-right.svg");
    assert.deepStrictEqual(theme.reactions.double.files, ["a.svg", "b.svg"]);
    assert.strictEqual(theme.workingTiers[0].file, "tier.svg");
    assert.strictEqual(theme.idleAnimations[0].file, "look.svg");
    assert.deepStrictEqual(theme.displayHintMap, { "../old.svg": "new.svg" });
    assert.deepStrictEqual(theme.updateVisuals, { checking: "checking.svg" });
  });

  it("normalizes file hitboxes, rendering, and trusted runtime without file system state", () => {
    const warn = mock.method(console, "warn", () => {});
    const builtin = schema.mergeDefaults(validThemeJson({
      fileHitBoxes: {
        "../idle.svg": { x: 1, y: 2, w: 3, h: 4 },
        "bad.svg": { x: 1, y: 2, w: 0, h: 4 },
      },
      rendering: {
        svgChannel: "object",
        lowPowerStaticImageOverrides: {
          sleeping: { from: "../sleep.svg", to: "../sleep.png" },
          bad: { from: "", to: "missing.png" },
        },
      },
      trustedRuntime: {
        scriptedSvgFiles: ["../bridge.svg", "not-png.png", "bridge.svg"],
        scriptedSvgCycleMs: { "../bridge.svg": 120.4, "missing.svg": 20 },
      },
    }), "builtin", true);

    assert.deepStrictEqual(builtin.fileHitBoxes, {
      "idle.svg": { x: 1, y: 2, w: 3, h: 4 },
    });
    assert.deepStrictEqual(builtin.rendering, {
      svgChannel: "object",
      lowPowerStaticImageOverrides: {
        sleeping: { from: "sleep.svg", to: "sleep.png" },
      },
    });
    assert.deepStrictEqual(builtin.trustedRuntime, {
      scriptedSvgFiles: ["bridge.svg"],
      scriptedSvgCycleMs: { "bridge.svg": 120 },
    });
    assert.strictEqual(warn.mock.calls.length, 1);

    const external = schema.mergeDefaults(validThemeJson({
      trustedRuntime: { scriptedSvgFiles: ["bridge.svg"] },
      rendering: { svgChannel: "bad" },
    }), "external", false);

    assert.deepStrictEqual(external.trustedRuntime, { scriptedSvgFiles: [] });
    assert.deepStrictEqual(external.rendering, { svgChannel: "auto" });
  });

  it("collectRequiredAssetFiles returns unique basename-only references", () => {
    const files = schema.collectRequiredAssetFiles({
      states: { idle: ["../idle.svg"], working: ["working.svg"] },
      miniMode: { states: { "mini-idle": ["mini/idle.svg"] } },
      workingTiers: [{ file: "../tier.svg" }],
      jugglingTiers: [{ file: "juggling.svg" }],
      idleAnimations: [{ file: "idle-look.svg" }],
      rendering: {
        lowPowerStaticImageOverrides: {
          sleeping: { from: "../sleep.svg", to: "sleep.png" },
        },
      },
      reactions: {
        drag: { file: "drag.svg", fileLeft: "../drag-left.svg", fileRight: "nested/drag-right.svg" },
        double: { files: ["drag.svg", "../double.svg"] },
      },
      displayHintMap: { old: "../hint.svg" },
      updateVisuals: { checking: "../checking.svg" },
    });

    assert.deepStrictEqual(files.sort(), [
      "checking.svg",
      "double.svg",
      "drag-left.svg",
      "drag-right.svg",
      "drag.svg",
      "hint.svg",
      "idle-look.svg",
      "idle.svg",
      "juggling.svg",
      "sleep.png",
      "sleep.svg",
      "tier.svg",
      "working.svg",
    ]);
  });
});
