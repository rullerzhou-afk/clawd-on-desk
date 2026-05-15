"use strict";

const test = require("node:test");
const assert = require("node:assert");

const themeOverrideCommands = require("../src/settings-actions-theme-overrides");

test("settings theme override actions expose the command surface", () => {
  assert.deepStrictEqual(Object.keys(themeOverrideCommands).sort(), [
    "ANIMATION_OVERRIDES_EXPORT_VERSION",
    "ONESHOT_OVERRIDE_STATES",
    "importAnimationOverrides",
    "resetThemeOverrides",
    "setAnimationOverride",
    "setSoundOverride",
    "setThemeOverrideDisabled",
    "setWideHitboxOverride",
  ]);
  assert.strictEqual(themeOverrideCommands.ANIMATION_OVERRIDES_EXPORT_VERSION, 1);
  assert.ok(themeOverrideCommands.ONESHOT_OVERRIDE_STATES.has("attention"));
});

test("settings theme override actions update an active state slot with explicit reload data", () => {
  const calls = [];
  const snapshot = {
    theme: "clawd",
    themeOverrides: {
      clawd: {
        hitbox: { wide: { "old.svg": true } },
        sounds: { complete: { file: "done.mp3" } },
      },
    },
  };

  const result = themeOverrideCommands.setAnimationOverride(
    {
      themeId: "clawd",
      slotType: "state",
      stateKey: "attention",
      file: "new-attention.svg",
      transition: { in: 80, out: 120 },
      autoReturnMs: 2500,
    },
    {
      snapshot,
      activateTheme: (themeId, variantId, overrideMap) => {
        calls.push({ themeId, variantId, overrideMap });
      },
    }
  );

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.states.attention, {
    file: "new-attention.svg",
    transition: { in: 80, out: 120 },
  });
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.timings, {
    autoReturn: { attention: 2500 },
  });
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.hitbox, snapshot.themeOverrides.clawd.hitbox);
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.sounds, snapshot.themeOverrides.clawd.sounds);
  assert.deepStrictEqual(calls, [
    {
      themeId: "clawd",
      variantId: null,
      overrideMap: result.commit.themeOverrides.clawd,
    },
  ]);
});

test("settings theme override actions clear transition overrides that match the theme default", () => {
  const calls = [];
  const snapshot = {
    theme: "clawd",
    themeOverrides: {
      clawd: {
        states: {
          thinking: {
            transition: { in: 160, out: 150 },
          },
        },
      },
    },
  };

  const result = themeOverrideCommands.setAnimationOverride(
    {
      themeId: "clawd",
      slotType: "state",
      stateKey: "thinking",
      transition: { in: 150, out: 150 },
      transitionThemeDefault: { in: 150, out: 150 },
    },
    {
      snapshot,
      activateTheme: (themeId, variantId, overrideMap) => {
        calls.push({ themeId, variantId, overrideMap });
      },
    }
  );

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.commit.themeOverrides.clawd, undefined);
  assert.deepStrictEqual(calls, [
    {
      themeId: "clawd",
      variantId: null,
      overrideMap: {},
    },
  ]);
});

test("settings theme override actions keep transition overrides that differ from the theme default", () => {
  const result = themeOverrideCommands.setAnimationOverride(
    {
      themeId: "clawd",
      slotType: "state",
      stateKey: "thinking",
      transition: { in: 160, out: 150 },
      transitionThemeDefault: { in: 150, out: 150 },
    },
    {
      snapshot: { theme: "other", themeOverrides: {} },
      activateTheme: () => {
        throw new Error("inactive theme should not reload");
      },
    }
  );

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.states.thinking, {
    transition: { in: 160, out: 150 },
  });
});

test("settings theme override actions preserve animation and hitbox data when changing sound overrides", () => {
  const snapshot = {
    theme: "calico",
    themeOverrides: {
      clawd: {
        states: { attention: { file: "attention.svg" } },
        reactions: { clickLeft: { file: "click.svg" } },
        hitbox: { wide: { "wide.svg": true } },
        sounds: { confirm: { file: "confirm.wav" } },
      },
    },
  };

  const result = themeOverrideCommands.setSoundOverride(
    { themeId: "clawd", soundName: "complete", file: "complete.mp3", originalName: "picked.mp3" },
    {
      snapshot,
      activateTheme: () => {
        throw new Error("inactive theme should not reload");
      },
    }
  );

  assert.strictEqual(result.status, "ok");
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.states, snapshot.themeOverrides.clawd.states);
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.reactions, snapshot.themeOverrides.clawd.reactions);
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.hitbox, snapshot.themeOverrides.clawd.hitbox);
  assert.deepStrictEqual(result.commit.themeOverrides.clawd.sounds, {
    confirm: { file: "confirm.wav" },
    complete: { file: "complete.mp3", originalName: "picked.mp3" },
  });
});

test("settings theme override actions import active theme overrides with the committed map", () => {
  const calls = [];
  const payload = {
    version: 1,
    themes: {
      clawd: {
        states: {
          attention: { disabled: true },
        },
      },
    },
  };
  const snapshot = { theme: "clawd", themeOverrides: {} };

  const result = themeOverrideCommands.importAnimationOverrides(payload, {
    snapshot,
    activateTheme: (themeId, variantId, overrideMap) => {
      calls.push({ themeId, variantId, overrideMap });
    },
  });

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.importedThemeCount, 1);
  assert.deepStrictEqual(calls, [
    {
      themeId: "clawd",
      variantId: null,
      overrideMap: result.commit.themeOverrides.clawd,
    },
  ]);
});

test("settings theme override actions reset an active theme by reloading without overrides", () => {
  const calls = [];
  const snapshot = {
    theme: "clawd",
    themeOverrides: {
      clawd: { states: { attention: { disabled: true } } },
      calico: { states: { error: { disabled: true } } },
    },
  };

  const result = themeOverrideCommands.resetThemeOverrides("clawd", {
    snapshot,
    activateTheme: (themeId, variantId, overrideMap) => {
      calls.push({ themeId, variantId, overrideMap });
    },
  });

  assert.strictEqual(result.status, "ok");
  assert.strictEqual(result.commit.themeOverrides.clawd, undefined);
  assert.ok(result.commit.themeOverrides.calico);
  assert.deepStrictEqual(calls, [
    { themeId: "clawd", variantId: null, overrideMap: null },
  ]);
});
