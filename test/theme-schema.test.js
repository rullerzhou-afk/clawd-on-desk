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

  it("strictly validates per-file object-channel SVG basenames", () => {
    assert.deepStrictEqual(schema.validateTheme(validThemeJson({
      rendering: { objectChannelFiles: ["animated.svg"] },
    })), []);

    for (const objectChannelFiles of [
      "animated.svg",
      ["../animated.svg"],
      ["animated.png"],
      ["UPPER.SVG"],
      [42],
    ]) {
      const errors = schema.validateTheme(validThemeJson({
        rendering: { objectChannelFiles },
      }));
      assert.ok(errors.some((error) => error.includes("rendering.objectChannelFiles")));
    }
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

  it("rejects non-boolean roamFlipAssets (truthy strings would silently invert the roam mirror)", () => {
    assert.deepStrictEqual(schema.validateTheme(validThemeJson({ roamFlipAssets: true })), []);
    assert.deepStrictEqual(schema.validateTheme(validThemeJson({ roamFlipAssets: false })), []);

    for (const bad of ["false", "0", 1, {}]) {
      const errors = schema.validateTheme(validThemeJson({ roamFlipAssets: bad }));
      assert.ok(
        errors.some((error) => error.includes("roamFlipAssets must be a boolean")),
        `expected a roamFlipAssets error for ${JSON.stringify(bad)}`
      );
    }
  });

  it("validates mirroredFiles as a map to distinct file names", () => {
    const withMap = (mirroredFiles) => validThemeJson({ mirroredFiles });
    assert.deepStrictEqual(schema.validateTheme(withMap({ "mini-happy.apng": "mini-happy-left.apng" })), []);

    for (const bad of ["mini-happy-left.apng", ["mini-happy-left.apng"], 1, null]) {
      const errors = schema.validateTheme(withMap(bad));
      assert.ok(
        errors.some((error) => error.includes("mirroredFiles must be an object")),
        `expected a mirroredFiles shape error for ${JSON.stringify(bad)}`
      );
    }
    for (const bad of [{ "mini-happy.apng": "" }, { "mini-happy.apng": 3 }, { "mini-happy.apng": "../mini-happy.apng" }]) {
      const errors = schema.validateTheme(withMap(bad));
      assert.ok(
        errors.some((error) => error.includes('mirroredFiles["mini-happy.apng"]')),
        `expected a mirroredFiles entry error for ${JSON.stringify(bad)}`
      );
    }
  });

  it("mergeDefaults normalizes mirroredFiles to basenames and defaults it to {}", () => {
    assert.deepStrictEqual(schema.mergeDefaults(validThemeJson()).mirroredFiles, {});
    const theme = schema.mergeDefaults(validThemeJson({
      mirroredFiles: {
        "../mini-happy.apng": "nested/mini-happy-left.apng",
        "bad.apng": 7,
        "same.apng": "same.apng",
      },
    }));
    assert.deepStrictEqual(theme.mirroredFiles, { "mini-happy.apng": "mini-happy-left.apng" });
  });

  it("collectRequiredAssetFiles includes mirrored-display variants", () => {
    const files = schema.collectRequiredAssetFiles({
      states: { idle: ["idle.svg"], roam: ["walk.apng"] },
      mirroredFiles: { "walk.apng": "../walk-left.apng", "odd.apng": 4 },
    });
    assert.ok(files.includes("walk.apng"));
    assert.ok(files.includes("walk-left.apng"));
    assert.ok(!files.includes("4"));
  });

  it("validates and derives the explicit pet tint capability", () => {
    assert.deepStrictEqual(
      schema.validateTheme(validThemeJson({ customization: { petTint: true } })),
      []
    );
    for (const customization of ["yes", { petTint: "yes" }]) {
      const errors = schema.validateTheme(validThemeJson({ customization }));
      assert.ok(
        errors.some((error) => error.includes("customization")),
        `expected a customization error for ${JSON.stringify(customization)}`
      );
    }

    assert.strictEqual(schema.buildCapabilities(validThemeJson()).petTint, false);
    assert.strictEqual(
      schema.buildCapabilities(validThemeJson({ customization: { petTint: true } })).petTint,
      true
    );
    assert.deepStrictEqual(
      schema.mergeDefaults(validThemeJson()).customization,
      { petTint: false, accessories: null, mouthAccessories: null }
    );
  });

  it("derives accessory capability from complete raw and normalized coverage", () => {
    const raw = validThemeJson({
      customization: {
        petTint: true,
        accessories: {
          default: {
            staticFrame: { cx: 50, baseY: 20, width: 30 },
          },
          files: {
            "idle.svg": {
              staticFrame: { cx: 50, baseY: 20, width: 30 },
              hitBoxPadding: { left: 1, top: 2, right: 1, bottom: 0 },
              followTarget: {
                id: "body-js",
                frame: { cx: 12, baseY: 4, width: 16 },
              },
            },
            "sleeping.svg": {
              visibility: "hidden",
            },
          },
        },
      },
    });
    const normalized = schema.mergeDefaults(raw, "demo", true);

    assert.deepStrictEqual(schema.validateTheme(raw), []);
    assert.strictEqual(schema.deriveAccessoryCapability(raw), true);
    assert.strictEqual(schema.deriveAccessoryCapability(normalized), true);
    assert.strictEqual(schema.buildCapabilities(raw).accessories, true);
    assert.strictEqual(schema.buildCapabilities(normalized).accessories, true);
    assert.deepStrictEqual(
      normalized.customization.accessories.files["idle.svg"].hitBoxPadding,
      { left: 1, top: 2, right: 1, bottom: 0 }
    );
    assert.deepStrictEqual(
      normalized.customization.accessories.files["sleeping.svg"],
      { visibility: "hidden" }
    );
  });

  it("validates bounded conditional idle easter eggs", () => {
    const egg = {
      file: "clawd-outlaw-bender.svg",
      duration: 15000,
      chance: 0.05,
      cooldownMs: 1800000,
      requiresAccessories: { head: "cowboy-hat", mouth: "cigarette" },
    };
    assert.deepStrictEqual(schema.validateTheme(validThemeJson({ idleEasterEggs: [egg] })), []);

    const cases = [
      [{ ...egg, file: "../bender.svg" }, ".file must be a safe basename"],
      [{ ...egg, duration: 0 }, ".duration must be between"],
      [{ ...egg, chance: 0 }, ".chance must be greater than 0"],
      [{ ...egg, cooldownMs: Infinity }, ".cooldownMs must be between"],
      [{ ...egg, requiresAccessories: { head: "cowboy-hat" } }, ".mouth must be a safe accessory item id"],
      [{ ...egg, requiresAccessories: { ...egg.requiresAccessories, tail: "cape" } }, ".tail is not supported"],
    ];
    for (const [badEgg, expected] of cases) {
      const errors = schema.validateTheme(validThemeJson({ idleEasterEggs: [badEgg] }));
      assert.ok(errors.some((error) => error.includes(expected)), JSON.stringify(errors));
    }

    const errors = schema.validateTheme(validThemeJson({
      idleEasterEggs: [{ ...egg, chance: 0.6 }, { ...egg, file: "second.svg", chance: 0.5 }],
    }));
    assert.ok(errors.includes("idleEasterEggs total chance must be at most 1"));
  });

  it("derives the mouth slot independently and preserves reflection normalization", () => {
    const raw = validThemeJson({
      customization: {
        mouthAccessories: {
          default: { staticFrame: { cx: 70, baseY: 58, width: 12 } },
          files: {
            "idle.svg": {
              staticFrame: { cx: 68, baseY: 57, width: 12 },
              followTarget: {
                id: "mouth-anchor-right",
                frame: { cx: 2.5, baseY: 8, width: 5 },
                normalizeReflection: "x",
              },
            },
            "sleeping.svg": { visibility: "hidden" },
          },
        },
      },
    });
    const normalized = schema.mergeDefaults(raw, "demo", true);
    assert.deepStrictEqual(schema.validateTheme(raw), []);
    assert.strictEqual(schema.deriveMouthAccessoryCapability(raw), true);
    assert.strictEqual(schema.buildCapabilities(raw).mouthAccessories, true);
    assert.strictEqual(schema.buildCapabilities(raw).accessories, false);
    assert.strictEqual(
      normalized.customization.mouthAccessories.files["idle.svg"].followTarget.normalizeReflection,
      "x"
    );

    const invalidMouth = validThemeJson({
      customization: {
        accessories: { default: { staticFrame: { cx: 50, baseY: 20, width: 30 } } },
        mouthAccessories: {
          default: { staticFrame: { cx: 70, baseY: 58, width: 12 } },
          files: {
            "idle.svg": {
              staticFrame: { cx: 68, baseY: 57, width: 12 },
              followTarget: {
                id: "mouth-anchor-right",
                frame: { cx: 2.5, baseY: 8, width: 5 },
                normalizeReflection: "both",
              },
            },
          },
        },
      },
    });
    assert.ok(schema.validateTheme(invalidMouth).some((error) => (
      error.includes("customization.mouthAccessories")
      && error.includes("normalizeReflection")
    )));
    assert.strictEqual(schema.deriveAccessoryCapability(invalidMouth), true);
    assert.strictEqual(schema.deriveMouthAccessoryCapability(invalidMouth), false);
  });

  it("materializes sparse head item overrides without adding a third fallback path", () => {
    const raw = validThemeJson({
      customization: {
        accessories: {
          default: { staticFrame: { cx: 50, baseY: 20, width: 30 } },
          itemOverrides: {
            "cowboy-hat": {
              files: {
                "sleeping.svg": { visibility: "hidden" },
                "idle.svg": { staticFrame: { cx: 48, baseY: 19, width: 31 } },
              },
            },
          },
        },
      },
    });
    assert.deepStrictEqual(schema.validateTheme(raw), []);
    const effective = schema.resolveEffectiveAccessoryAttachments(raw, raw);
    assert.deepStrictEqual(effective.itemOverrides["cowboy-hat"].files["sleeping.svg"], {
      visibility: "hidden",
    });
    assert.deepStrictEqual(effective.itemOverrides["cowboy-hat"].files["idle.svg"], {
      staticFrame: { cx: 48, baseY: 19, width: 31 },
    });

    const stale = validThemeJson({
      customization: {
        accessories: {
          default: { staticFrame: { cx: 50, baseY: 20, width: 30 } },
          itemOverrides: {
            "cowboy-hat": {
              files: { "missing.svg": { visibility: "hidden" } },
            },
          },
        },
      },
    });
    assert.ok(schema.validateTheme(stale).some((error) => (
      error.includes("itemOverrides") && error.includes("reachable")
    )));
  });

  it("projects mini low-power overrides through the mini viewBox", () => {
    const miniStates = Object.fromEntries(
      schema.MINI_REQUIRED_STATES.map((state) => [state, [`${state}.svg`]])
    );
    const raw = validThemeJson({
      miniMode: {
        supported: true,
        viewBox: { x: 0, y: 0, width: 20, height: 20 },
        states: miniStates,
      },
      rendering: {
        lowPowerStaticImageOverrides: {
          "mini-idle": {
            from: "mini-idle.svg",
            to: "mini-idle-static.png",
          },
        },
      },
      customization: {
        accessories: {
          default: { staticFrame: { cx: 50, baseY: 20, width: 30 } },
          mini: { staticFrame: { cx: 10, baseY: 4, width: 6 } },
        },
      },
    });

    assert.deepStrictEqual(schema.validateTheme(raw), []);
    assert.strictEqual(schema.deriveAccessoryCapability(raw), true);
    const lowPowerUsages = schema.projectThemeVisualUsages(raw)
      .filter((usage) => usage.source.startsWith(
        "rendering.lowPowerStaticImageOverrides.mini-idle"
      ));
    assert.strictEqual(lowPowerUsages.length, 2);
    assert.ok(lowPowerUsages.every((usage) => usage.stateFamily.startsWith("mini:")));
    assert.ok(lowPowerUsages.every((usage) => usage.viewBoxSource === "mini"));
    assert.ok(lowPowerUsages.every((usage) => usage.effectiveViewBox.width === 20));
  });

  it("fails accessory capability closed on incomplete viewBox coverage but permits exact library descriptors", () => {
    const miniStates = Object.fromEntries(
      schema.MINI_REQUIRED_STATES.map((state) => [state, [`${state}.svg`]])
    );
    const missingMini = validThemeJson({
      miniMode: {
        supported: true,
        viewBox: { x: -10, y: -10, width: 40, height: 40 },
        states: miniStates,
      },
      customization: {
        accessories: {
          default: { staticFrame: { cx: 50, baseY: 20, width: 30 } },
        },
      },
    });
    assert.strictEqual(schema.deriveAccessoryCapability(missingMini), false);

    const missingFileOverride = validThemeJson({
      fileViewBoxes: {
        "thinking.svg": { x: -20, y: -20, width: 50, height: 50 },
      },
      customization: {
        accessories: {
          default: { staticFrame: { cx: 50, baseY: 20, width: 30 } },
        },
      },
    });
    assert.strictEqual(schema.deriveAccessoryCapability(missingFileOverride), false);

    const staleDescriptor = validThemeJson({
      customization: {
        accessories: {
          default: { staticFrame: { cx: 50, baseY: 20, width: 30 } },
          files: {
            "not-reachable.svg": {
              staticFrame: { cx: 50, baseY: 20, width: 30 },
            },
          },
        },
      },
    });
    assert.strictEqual(schema.deriveAccessoryCapability(staleDescriptor), true);
    assert.deepStrictEqual(
      schema.resolveEffectiveAccessoryAttachments(staleDescriptor, staleDescriptor)
        .files["not-reachable.svg"],
      { staticFrame: { cx: 50, baseY: 20, width: 30 } },
      "an optional picker descriptor must survive until a later override selects it"
    );
    assert.ok(
      schema.collectRequiredAssetFiles(staleDescriptor).includes("not-reachable.svg"),
      "an exact animation-library descriptor must make its asset required"
    );
  });

  it("does not require unreachable mini attachments when mini mode is disabled", () => {
    const raw = validThemeJson({
      miniMode: {
        supported: false,
        viewBox: { x: -10, y: -10, width: 40, height: 40 },
        states: {
          "mini-idle": ["legacy-mini-idle.svg"],
        },
      },
      customization: {
        accessories: {
          default: { staticFrame: { cx: 50, baseY: 20, width: 30 } },
        },
      },
    });
    const normalized = schema.mergeDefaults(raw, "external-demo", false);

    assert.strictEqual(schema.buildCapabilities(raw).miniMode, false);
    assert.strictEqual(schema.deriveAccessoryCapability(raw), true);
    assert.strictEqual(schema.deriveAccessoryCapability(normalized), true);
    assert.strictEqual(
      schema.projectThemeVisualUsages(raw).some((usage) => usage.stateFamily.startsWith("mini:")),
      false
    );
  });

  it("rejects malformed accessory metadata instead of guessing targets or coordinates", () => {
    for (const accessories of [
      "yes",
      {
        default: { staticFrame: { cx: 50, baseY: 20, width: 1000 } },
      },
      {
        default: { staticFrame: { cx: 50, baseY: 20, width: 30 } },
        files: {
          "../idle.svg": { staticFrame: { cx: 50, baseY: 20, width: 30 } },
        },
      },
      {
        default: { staticFrame: { cx: 50, baseY: 20, width: 30 } },
        files: {
          "idle.svg": {
            staticFrame: { cx: 50, baseY: 20, width: 30 },
            followTarget: {
              id: "[id^=eye]",
              frame: { cx: 12, baseY: 4, width: 16 },
            },
          },
        },
      },
      {
        default: { staticFrame: { cx: 50, baseY: 20, width: 30 } },
        files: {
          "idle.svg": {
            staticFrame: { cx: 50, baseY: 20, width: 30 },
            hitBoxPadding: { top: -1 },
          },
        },
      },
      {
        default: { staticFrame: { cx: 50, baseY: 20, width: 30 } },
        files: {
          "sleeping.svg": {
            visibility: "hidden",
            staticFrame: { cx: 50, baseY: 20, width: 30 },
          },
        },
      },
    ]) {
      const errors = schema.validateTheme(validThemeJson({
        customization: { accessories },
      }));
      assert.ok(
        errors.some((error) => error.includes("customization.accessories")),
        JSON.stringify(accessories)
      );
    }
  });

  it("rejects one basename resolving through multiple effective viewBoxes", () => {
    const miniStates = Object.fromEntries(
      schema.MINI_REQUIRED_STATES.map((state) => [state, ["idle.svg"]])
    );
    const raw = validThemeJson({
      miniMode: {
        supported: true,
        viewBox: { x: -10, y: -10, width: 40, height: 40 },
        states: miniStates,
      },
      customization: {
        accessories: {
          default: { staticFrame: { cx: 50, baseY: 20, width: 30 } },
          mini: { staticFrame: { cx: 10, baseY: 4, width: 15 } },
        },
      },
    });
    assert.strictEqual(schema.deriveAccessoryCapability(raw), false);
  });

  it("mergeDefaults carries roamFlipAssets and defaults it to false", () => {
    assert.strictEqual(schema.mergeDefaults(validThemeJson()).roamFlipAssets, false);
    assert.strictEqual(
      schema.mergeDefaults(validThemeJson({ roamFlipAssets: true })).roamFlipAssets,
      true
    );
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
      idleEasterEggs: [{
        file: "bender.svg",
        duration: 15000,
        chance: 0.05,
        cooldownMs: 1800000,
        requiresAccessories: { head: "cowboy-hat", mouth: "cigarette" },
      }],
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
    assert.deepStrictEqual(theme.idleEasterEggs, [{
      file: "bender.svg",
      duration: 15000,
      chance: 0.05,
      cooldownMs: 1800000,
      requiresAccessories: { head: "cowboy-hat", mouth: "cigarette" },
    }]);
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
        objectChannelFiles: ["../animated.svg", "animated.svg", "still.png"],
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
      objectChannelFiles: ["animated.svg"],
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

  it("drops non-string object-channel entries instead of throwing during normalization", () => {
    const input = validThemeJson({
      rendering: { objectChannelFiles: [{}, 42, true, ["nested.svg"], "valid.svg"] },
    });
    assert.doesNotThrow(() => schema.mergeDefaults(input, "external", false));
    const normalized = schema.mergeDefaults(input, "external", false);
    assert.deepStrictEqual(normalized.rendering.objectChannelFiles, ["valid.svg"]);
  });

  it("collectRequiredAssetFiles returns unique basename-only references", () => {
    const files = schema.collectRequiredAssetFiles({
      states: { idle: ["../idle.svg"], working: ["working.svg"] },
      miniMode: { states: { "mini-idle": ["mini/idle.svg"] } },
      workingTiers: [{ file: "../tier.svg" }],
      jugglingTiers: [{ file: "juggling.svg" }],
      idleAnimations: [{ file: "idle-look.svg" }],
      idleEasterEggs: [{ file: "bender.svg" }],
      rendering: {
        objectChannelFiles: ["../bender.svg", "bender.svg"],
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
      timings: { dndSleepTransitionSvg: "../dnd-sleep.svg" },
    });

    assert.deepStrictEqual(files.sort(), [
      "bender.svg",
      "checking.svg",
      "dnd-sleep.svg",
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
    assert.deepStrictEqual(
      schema.projectThemeVisualUsages({ rendering: { objectChannelFiles: ["bender.svg"] } }),
      [],
      "a channel override is an asset reference, not an independent visual/viewBox usage"
    );
  });

  it("collectRequiredAssetFiles ignores malformed raw object-channel entries", () => {
    assert.deepStrictEqual(schema.collectRequiredAssetFiles({
      rendering: { objectChannelFiles: [42, {}, ["nested.svg"], "valid.svg"] },
    }), ["valid.svg"]);
    assert.deepStrictEqual(schema.collectRequiredAssetFiles({
      rendering: { objectChannelFiles: 42 },
    }), []);
    assert.deepStrictEqual(schema.collectRequiredAssetFiles({
      rendering: { objectChannelFiles: {} },
    }), []);
  });

  it("does not invent a root-viewBox usage for mini object-channel files", () => {
    const theme = validThemeJson({
      viewBox: { x: 0, y: 0, width: 100, height: 100 },
      miniMode: {
        supported: true,
        viewBox: { x: 0, y: 0, width: 32, height: 32 },
        states: { "mini-idle": ["mini-idle.svg"] },
      },
      rendering: { objectChannelFiles: ["mini-idle.svg"] },
    });
    const usages = schema.projectThemeVisualUsages(theme)
      .filter((usage) => usage.file === "mini-idle.svg");

    assert.strictEqual(usages.length, 1);
    assert.strictEqual(usages[0].stateFamily, "mini:mini-idle");
    assert.deepStrictEqual(usages[0].effectiveViewBox, { x: 0, y: 0, width: 32, height: 32 });
    assert.ok(schema.collectRequiredAssetFiles(theme).includes("mini-idle.svg"));
  });
});
