"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { commandRegistry, updateRegistry, buildThemeScopedPrefsCommit } = require("../src/settings-actions");
const { createSettingsController } = require("../src/settings-controller");

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-official-lock-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("theme domain lock", () => {
  it("keeps selection, removal and official commit/uninstall in one lock domain", () => {
    for (const name of ["setThemeSelection", "removeTheme", "officialTheme.commitInstall", "officialTheme.uninstall"]) {
      assert.strictEqual(commandRegistry[name] && commandRegistry[name].lockKey, "theme", `${name} lockKey`);
    }
    assert.strictEqual(updateRegistry.theme.lockKey, "theme");
  });

  it("serializes commands that share the theme lock", async () => {
    const order = [];
    const commands = {
      first: Object.assign(async () => {
        order.push("first-start");
        await sleep(25);
        order.push("first-end");
        return { status: "ok" };
      }, { lockKey: "theme" }),
      second: Object.assign(async () => {
        order.push("second");
        return { status: "ok" };
      }, { lockKey: "theme" }),
    };
    const controller = createSettingsController({
      prefsPath: path.join(tmp, "prefs.json"),
      commands,
      updates: {},
    });
    await Promise.all([controller.applyCommand("first"), controller.applyCommand("second")]);
    assert.deepStrictEqual(order, ["first-start", "first-end", "second"]);
  });

  it("clears exactly the removed theme's scoped preferences", () => {
    const snapshot = {
      themeOverrides: { alpha: { disabled: [] }, beta: {} },
      themeVariant: { alpha: "cozy", beta: "default" },
      idleVisual: { alpha: "a.svg", beta: "b.svg" },
      petTint: { alpha: "red", beta: "blue" },
      petAccessory: { alpha: "hat", beta: "none" },
      petMouthAccessory: { alpha: "pipe", beta: "none" },
      holidayAccessoryEnabled: { alpha: true, beta: false },
    };
    const patch = buildThemeScopedPrefsCommit("alpha", snapshot);
    assert.deepStrictEqual(Object.keys(patch).sort(), [
      "holidayAccessoryEnabled",
      "idleVisual",
      "petAccessory",
      "petMouthAccessory",
      "petTint",
      "themeOverrides",
      "themeVariant",
    ]);
    assert.deepStrictEqual(patch.themeOverrides, { beta: {} });
    assert.deepStrictEqual(patch.themeVariant, { beta: "default" });
    assert.deepStrictEqual(patch.idleVisual, { beta: "b.svg" });
  });
});
