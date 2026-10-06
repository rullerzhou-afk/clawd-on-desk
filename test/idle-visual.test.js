"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const {
  listIdleVisualOptions,
  resolveIdleVisualChoice,
  humanizeIdleVisualLabel,
} = require("../src/idle-visual");

function makeTheme(overrides = {}) {
  return {
    _id: "clawd",
    states: { idle: ["clawd-idle-follow.svg"] },
    idleAnimations: [
      { file: "clawd-idle-look.svg", duration: 6500 },
      { file: "clawd-idle-bubble.svg", duration: 13500 },
      { file: "clawd-idle-reading.svg", duration: 14000 },
    ],
    ...overrides,
  };
}

describe("listIdleVisualOptions", () => {
  it("keeps every shipped theme's candidate list unchanged without the new field", () => {
    const expected = {
      calico: ["calico-idle-follow.svg", "calico-idle.apng"],
      clawd: ["clawd-idle-follow.svg", "clawd-idle-look.svg", "clawd-idle-bubble.svg", "clawd-idle-reading.svg"],
      cloudling: ["cloudling-idle.svg", "cloudling-idle-reading.svg"],
      template: ["idle-follow.svg", "idle-look.gif"],
    };
    const themesDir = path.join(__dirname, "..", "themes");
    assert.deepStrictEqual(fs.readdirSync(themesDir).filter((id) =>
      fs.existsSync(path.join(themesDir, id, "theme.json"))).sort(), Object.keys(expected).sort());
    for (const [id, files] of Object.entries(expected)) {
      const theme = JSON.parse(fs.readFileSync(path.join(themesDir, id, "theme.json"), "utf8"));
      assert.strictEqual(Object.hasOwn(theme, "idleVisualOptions"), false, id);
      assert.deepStrictEqual(listIdleVisualOptions(theme).map((entry) => entry.file), files, id);
    }
  });

  it("lists the theme default first, then idle pool entries", () => {
    const options = listIdleVisualOptions(makeTheme());
    assert.deepStrictEqual(options, [
      { file: "clawd-idle-follow.svg", isThemeDefault: true },
      { file: "clawd-idle-look.svg", isThemeDefault: false },
      { file: "clawd-idle-bubble.svg", isThemeDefault: false },
      { file: "clawd-idle-reading.svg", isThemeDefault: false },
    ]);
  });

  it("includes extra states.idle files and dedupes pool repeats", () => {
    const options = listIdleVisualOptions(makeTheme({
      states: { idle: ["a.svg", "b.svg"] },
      idleAnimations: [{ file: "b.svg", duration: 1000 }, { file: "c.svg", duration: 1000 }],
    }));
    assert.deepStrictEqual(options.map((o) => o.file), ["a.svg", "b.svg", "c.svg"]);
    assert.deepStrictEqual(options.map((o) => o.isThemeDefault), [true, false, false]);
  });

  it("appends selectable-only files after idle animations and dedupes all sources", () => {
    const theme = makeTheme({
      states: { idle: ["a.svg", "b.svg"] },
      idleAnimations: [{ file: "b.svg" }, { file: "c.svg" }],
      idleVisualOptions: [{ file: "c.svg" }, { file: "pool.apng" }, { file: "a.svg" }],
    });
    assert.deepStrictEqual(listIdleVisualOptions(theme), [
      { file: "a.svg", isThemeDefault: true },
      { file: "b.svg", isThemeDefault: false },
      { file: "c.svg", isThemeDefault: false },
      { file: "pool.apng", isThemeDefault: false },
    ]);
    assert.strictEqual(resolveIdleVisualChoice(theme, { clawd: "pool.apng" }), "pool.apng");
  });

  it("skips malformed entries and tolerates missing collections", () => {
    assert.deepStrictEqual(listIdleVisualOptions(null), []);
    assert.deepStrictEqual(listIdleVisualOptions({}), []);
    const options = listIdleVisualOptions(makeTheme({
      idleAnimations: [null, { file: "" }, { duration: 5 }, { file: "ok.svg" }],
    }));
    assert.deepStrictEqual(options.map((o) => o.file), ["clawd-idle-follow.svg", "ok.svg"]);
  });

  it("does not expose conditional easter eggs as persistent idle choices", () => {
    const options = listIdleVisualOptions(makeTheme({
      idleEasterEggs: [{
        file: "clawd-outlaw-bender.svg",
        duration: 15000,
        chance: 0.05,
        cooldownMs: 1800000,
        requiresAccessories: { head: "cowboy-hat", mouth: "cigarette" },
      }],
    }));
    assert.ok(!options.some((option) => option.file === "clawd-outlaw-bender.svg"));
  });
});

describe("resolveIdleVisualChoice", () => {
  const theme = makeTheme();

  it("returns the stored file when it is a valid non-default option", () => {
    assert.strictEqual(
      resolveIdleVisualChoice(theme, { clawd: "clawd-idle-reading.svg" }),
      "clawd-idle-reading.svg"
    );
  });

  it("returns null when unset, for other themes, or for unknown files", () => {
    assert.strictEqual(resolveIdleVisualChoice(theme, {}), null);
    assert.strictEqual(resolveIdleVisualChoice(theme, null), null);
    assert.strictEqual(resolveIdleVisualChoice(theme, { calico: "calico-idle.svg" }), null);
    assert.strictEqual(resolveIdleVisualChoice(theme, { clawd: "gone.svg" }), null);
    assert.strictEqual(resolveIdleVisualChoice(theme, { clawd: 42 }), null);
    assert.strictEqual(resolveIdleVisualChoice(null, { clawd: "clawd-idle-look.svg" }), null);
  });

  it("treats a stored theme default as unset", () => {
    assert.strictEqual(resolveIdleVisualChoice(theme, { clawd: "clawd-idle-follow.svg" }), null);
  });

  it("ignores prototype keys", () => {
    const map = Object.create({ clawd: "clawd-idle-look.svg" });
    assert.strictEqual(resolveIdleVisualChoice(theme, map), null);
  });
});

describe("humanizeIdleVisualLabel", () => {
  it("strips theme prefix and extension, title-cases the rest", () => {
    assert.strictEqual(humanizeIdleVisualLabel("clawd-idle-reading.svg", "clawd"), "Idle Reading");
    assert.strictEqual(humanizeIdleVisualLabel("calico-idle-stretch.svg", "calico"), "Idle Stretch");
  });

  it("handles files without the theme prefix and odd separators", () => {
    assert.strictEqual(humanizeIdleVisualLabel("look_around.svg", "clawd"), "Look Around");
    assert.strictEqual(humanizeIdleVisualLabel("assets/deep/idle-wave.svg", "other"), "Idle Wave");
  });

  it("returns empty string for invalid input", () => {
    assert.strictEqual(humanizeIdleVisualLabel(null, "clawd"), "");
    assert.strictEqual(humanizeIdleVisualLabel("", "clawd"), "");
  });
});
