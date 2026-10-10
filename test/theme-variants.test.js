"use strict";

const { describe, it, afterEach, mock } = require("node:test");
const assert = require("node:assert");

const {
  resolveVariant,
  applyVariantPatch,
  buildBaseBindingMetadata,
  applyUserOverridesPatch,
  normalizeTransitionOverride,
} = require("../src/theme-variants");

afterEach(() => {
  mock.restoreAll();
});

function baseTheme(overrides = {}) {
  return {
    name: "Base",
    states: {
      idle: ["idle.svg"],
      working: ["working.svg"],
      thinking: ["thinking.svg"],
      sleeping: { files: ["sleep.svg"], fallbackTo: null },
    },
    miniMode: {
      states: {
        "mini-idle": ["../mini-idle.svg"],
      },
    },
    timings: {
      minDisplay: { working: 1000 },
      autoReturn: { attention: 4000 },
    },
    workingTiers: [
      { minSessions: 1, file: "typing.svg" },
      { minSessions: 3, file: "building.svg" },
    ],
    jugglingTiers: [{ minSessions: 2, file: "juggle.svg" }],
    idleAnimations: [{ file: "../look.svg", duration: 1200 }],
    reactions: {
      drag: { file: "drag.svg", duration: 300 },
      double: { files: ["a.svg", "b.svg"], duration: 200 },
    },
    displayHintMap: { "../tool.svg": "../hint.svg" },
    wideHitboxFiles: ["wide.svg"],
    ...overrides,
  };
}

describe("theme variant resolution", () => {
  it("resolves requested, explicit default, and synthetic default variants", () => {
    const raw = {
      variants: {
        default: { timings: { minDisplay: { working: 2 } } },
        chill: { objectScale: { widthRatio: 1.2 } },
      },
    };

    assert.deepStrictEqual(resolveVariant(raw, "chill"), {
      resolvedId: "chill",
      spec: raw.variants.chill,
    });
    assert.deepStrictEqual(resolveVariant(raw, "missing"), {
      resolvedId: "default",
      spec: raw.variants.default,
    });
    assert.deepStrictEqual(resolveVariant({ variants: {} }, "missing"), {
      resolvedId: "default",
      spec: null,
    });
  });
});

describe("theme variant patching", () => {
  it("replaces selectable-only idle options for a variant", () => {
    const raw = baseTheme({ idleVisualOptions: [{ file: "base.apng" }] });
    const patched = applyVariantPatch(raw, {
      idleVisualOptions: [{ file: "variant.apng" }],
    }, "demo", "chill");
    assert.deepStrictEqual(patched.idleVisualOptions, [{ file: "variant.apng" }]);
    assert.deepStrictEqual(raw.idleVisualOptions, [{ file: "base.apng" }]);
  });

  it("applies allow-listed variant fields with replace and deep-merge semantics", () => {
    const warn = mock.method(console, "warn", () => {});
    const raw = baseTheme({
      fileHitBoxes: {
        "idle.svg": { x: 1, y: 2, w: 3, h: 4 },
      },
      displayHintMap: { old: "old.svg" },
    });

    const patched = applyVariantPatch(raw, {
      name: "Chill",
      garbageField: true,
      timings: { minDisplay: { thinking: 222 } },
      objectScale: { widthRatio: 1.4 },
      workingTiers: [{ minSessions: 5, file: "solo.svg" }],
      displayHintMap: { new: "new.svg" },
      fileHitBoxes: {
        "../idle.svg": { x: 9, y: 8, w: 7, h: 6 },
        "bad.svg": { x: 1, y: 1, w: 0, h: 1 },
      },
    }, "demo", "chill");

    assert.deepStrictEqual(patched.timings, {
      minDisplay: { working: 1000, thinking: 222 },
      autoReturn: { attention: 4000 },
    });
    assert.deepStrictEqual(patched.objectScale, { widthRatio: 1.4 });
    assert.deepStrictEqual(patched.workingTiers, [{ minSessions: 5, file: "solo.svg" }]);
    assert.deepStrictEqual(patched.displayHintMap, { new: "new.svg" });
    assert.deepStrictEqual(patched.fileHitBoxes, {
      "idle.svg": { x: 9, y: 8, w: 7, h: 6 },
    });
    assert.strictEqual(patched.name, "Base");
    assert.strictEqual(warn.mock.calls.length, 2);
    assert.ok(warn.mock.calls[0].arguments[0].includes("garbageField"));
  });

  it("normalizes transition overrides", () => {
    assert.deepStrictEqual(normalizeTransitionOverride({ in: 100, out: 200, junk: 1 }), {
      in: 100,
      out: 200,
    });
    assert.strictEqual(normalizeTransitionOverride({ in: "bad" }), null);
    assert.strictEqual(normalizeTransitionOverride(null), null);
  });
});

describe("theme user override patching", () => {
  it("patches state, tier, timing, hitbox, reaction, and idle animation overrides", () => {
    const raw = baseTheme();
    const patched = applyUserOverridesPatch(raw, {
      states: {
        idle: { file: "../idle-custom.svg", transition: { in: 50 } },
        "mini-idle": { file: "../mini-custom.svg" },
      },
      tiers: {
        workingTiers: {
          "typing.svg": { file: "../typing-custom.svg", transition: { out: 70 } },
        },
      },
      timings: {
        autoReturn: { attention: 9000, invalid: "bad" },
      },
      hitbox: {
        wide: { "wide.svg": false, "../new-wide.svg": true },
      },
      reactions: {
        drag: { file: "../drag-custom.svg", durationMs: 777, transition: { in: 1, out: 2 } },
        double: { file: "../first-double.svg" },
      },
      idleAnimations: {
        "look.svg": { file: "../look-custom.svg", durationMs: 333, transition: { in: 9 } },
      },
    });

    assert.deepStrictEqual(patched.states.idle, ["../idle-custom.svg"]);
    assert.deepStrictEqual(patched.miniMode.states["mini-idle"], ["../mini-custom.svg"]);
    assert.strictEqual(patched.workingTiers[0].file, "../typing-custom.svg");
    assert.deepStrictEqual(patched.timings.autoReturn, { attention: 9000 });
    assert.deepStrictEqual(patched.wideHitboxFiles.sort(), ["new-wide.svg"]);
    assert.deepStrictEqual(patched.reactions.drag, {
      file: "../drag-custom.svg",
      duration: 777,
    });
    assert.deepStrictEqual(patched.reactions.double.files, ["../first-double.svg", "b.svg"]);
    assert.deepStrictEqual(patched.idleAnimations[0], {
      file: "../look-custom.svg",
      duration: 333,
    });
    assert.deepStrictEqual(patched.transitions, {
      "idle-custom.svg": { in: 50 },
      "typing-custom.svg": { out: 70 },
      "drag-custom.svg": { in: 1, out: 2 },
      "look-custom.svg": { in: 9 },
    });
    assert.notStrictEqual(patched.states, raw.states);
    assert.notStrictEqual(patched.workingTiers, raw.workingTiers);
  });

  it("replaces the first file of a multi-file tier and keeps the rest of its pool", () => {
    const raw = baseTheme({
      workingTiers: [
        { minSessions: 2, files: ["pool-a.svg", "pool-b.svg"] },
        { minSessions: 1, file: "typing.svg", files: ["typing.svg", "typing-b.svg"] },
      ],
    });
    const patched = applyUserOverridesPatch(raw, {
      tiers: {
        workingTiers: {
          "pool-a.svg": { file: "custom-pool.svg", transition: { in: 10 } },
          "typing.svg": { file: "custom-typing.svg" },
        },
      },
    });

    assert.deepStrictEqual(patched.workingTiers, [
      { minSessions: 2, file: "custom-pool.svg", files: ["custom-pool.svg", "pool-b.svg"] },
      { minSessions: 1, file: "custom-typing.svg", files: ["custom-typing.svg", "typing-b.svg"] },
    ]);
    assert.deepStrictEqual(patched.transitions, { "custom-pool.svg": { in: 10 } });
    assert.deepStrictEqual(raw.workingTiers[0], { minSessions: 2, files: ["pool-a.svg", "pool-b.svg"] });
  });

  it("returns the raw object for invalid override payloads", () => {
    const raw = baseTheme();
    assert.strictEqual(applyUserOverridesPatch(raw, null), raw);
    assert.strictEqual(applyUserOverridesPatch(raw, []), raw);
  });
});

describe("theme binding metadata for multi-file tiers", () => {
  it("keys a tier by file when declared, else by the first file of its pool", () => {
    const metadata = buildBaseBindingMetadata(baseTheme({
      workingTiers: [
        { minSessions: 2, files: ["../pool-a.svg", "pool-b.svg"] },
        { minSessions: 1, file: "typing.svg", files: ["typing-b.svg", "typing.svg"] },
      ],
    }));
    assert.deepStrictEqual(metadata.workingTiers, [
      { minSessions: 2, originalFile: "pool-a.svg" },
      { minSessions: 1, originalFile: "typing.svg" },
    ]);
  });
});

describe("theme binding metadata", () => {
  it("captures basename-only binding identities and sorted tier metadata", () => {
    const metadata = buildBaseBindingMetadata(baseTheme());

    assert.deepStrictEqual(metadata.states, {
      idle: "idle.svg",
      working: "working.svg",
      thinking: "thinking.svg",
      sleeping: "sleep.svg",
    });
    assert.deepStrictEqual(metadata.miniStates, {
      "mini-idle": "mini-idle.svg",
    });
    assert.deepStrictEqual(metadata.workingTiers, [
      { minSessions: 3, originalFile: "building.svg" },
      { minSessions: 1, originalFile: "typing.svg" },
    ]);
    assert.deepStrictEqual(metadata.jugglingTiers, [
      { minSessions: 2, originalFile: "juggle.svg" },
    ]);
    assert.deepStrictEqual(metadata.idleAnimations, [
      { index: 0, originalFile: "look.svg", duration: 1200 },
    ]);
    assert.deepStrictEqual(metadata.displayHintMap, {
      "tool.svg": "hint.svg",
    });
  });
});
