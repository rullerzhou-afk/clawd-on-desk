"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const hitGeometry = require("../src/hit-geometry");
const {
  PET_ACCESSORY_IDS,
  resolvePetAccessoryPayload,
} = require("../src/pet-customization-catalog");
const {
  BUILTIN_ACCESSORY_MOTION_PADDING,
  resolveAccessoryAwareHitBox,
} = require("../src/pet-accessory-hitbox");

const ROOT = path.join(__dirname, "..");
const EPSILON = 1e-9;
themeLoader.init(path.join(ROOT, "src"));

function baseHitBox(theme, file) {
  return theme.fileHitBoxes[file] || theme.hitBoxes.default;
}

describe("accessory-aware hit boxes", () => {
  it("does not add a transparent hat region when no accessory is worn", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    for (const file of [
      "clawd-working-typing.svg",
      "clawd-headphones-groove.svg",
      "clawd-working-building.svg",
    ]) {
      const base = baseHitBox(theme, file);
      assert.strictEqual(
        resolveAccessoryAwareHitBox(
          theme,
          "working",
          file,
          base,
          resolvePetAccessoryPayload("none", theme)
        ),
        base,
        file
      );
    }
  });

  it("keeps selected-accessory geometry size-aware without a one-size-fits-all envelope", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    for (const file of ["clawd-working-typing.svg", "clawd-working-building.svg"]) {
      const base = baseHitBox(theme, file);
      const tops = new Set();
      const heights = new Set();
      for (const id of PET_ACCESSORY_IDS.filter((value) => value !== "none")) {
        const resolved = resolveAccessoryAwareHitBox(
          theme,
          "working",
          file,
          base,
          resolvePetAccessoryPayload(id, theme)
        );
        assert.ok(resolved.x <= base.x + EPSILON, `${file}/${id} must preserve the base left edge`);
        assert.ok(resolved.y <= base.y + EPSILON, `${file}/${id} must preserve the base top edge`);
        assert.ok(resolved.x + resolved.w + EPSILON >= base.x + base.w, `${file}/${id} must preserve the base right edge`);
        assert.ok(resolved.y + resolved.h + EPSILON >= base.y + base.h, `${file}/${id} must preserve the base bottom edge`);
        tops.add(resolved.y);
        heights.add(resolved.h);
      }
      assert.ok(tops.size >= 3, `${file} should react to the selected accessory's dimensions`);
      assert.ok(heights.size >= 3, `${file} should not use a single tall transparent envelope`);
    }
  });

  it("reaches the built-in safety helmet in the 3+ session building pose", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    const box = theme.fileHitBoxes["clawd-working-building.svg"];
    const shared = theme.hitBoxes.default;

    // assets/svg/clawd-working-building.svg puts the helmet at
    // translate(0.5 1) scale(0.7) over local y 0..10, so it rests at y 1..8;
    // body-bounce's translateY(-2px) at 30% plus body-squash's scale(0.95,1.05)
    // lift its top to about -1.8. This override exists for that, and it applies
    // whether or not an accessory is worn — the helmet is the pet's own art.
    const helmetTop = -1.8;
    assert.ok(
      shared.y > helmetTop,
      "guard: the shared default box is expected to miss the helmet, which is why this entry exists"
    );
    assert.ok(box.y <= helmetTop, `building hit box top ${box.y} must reach the helmet at ${helmetTop}`);

    // And it buys only that: same sides, same floor, taller by the helmet alone.
    assert.strictEqual(box.x, shared.x, "building hit box must not widen the shared default");
    assert.strictEqual(box.w, shared.w, "building hit box must not widen the shared default");
    assert.strictEqual(box.y + box.h, shared.y + shared.h, "building hit box must not lower the floor");
  });

  it("keeps a motion envelope for every animated built-in descriptor, and none spare", () => {
    // The envelope table's individual numbers are the Electron CTM audit's job.
    // This is the structural half: a followTarget accessory rides the animation
    // and needs an envelope, a static one does not, and an envelope for a file
    // that no longer animates is dead weight nobody would notice.
    for (const themeId of ["clawd", "cloudling"]) {
      const theme = themeLoader.loadTheme(themeId, { strict: true });
      const files = (theme.customization.accessories || {}).files || {};
      const animated = Object.keys(files).filter((file) => files[file] && files[file].followTarget);
      const measured = BUILTIN_ACCESSORY_MOTION_PADDING[themeId] || {};

      assert.deepStrictEqual(
        animated.filter((file) => !measured[file]),
        [],
        `${themeId}: animated accessory descriptors with no motion envelope`
      );
      assert.deepStrictEqual(
        Object.keys(measured).filter((file) => !animated.includes(file)),
        [],
        `${themeId}: motion envelopes with no animated descriptor`
      );

      for (const [file, padding] of Object.entries(measured)) {
        const viewBox = hitGeometry.resolveViewBox(theme, "idle", file);
        assert.ok(viewBox, `${themeId}/${file}: no effective viewBox`);
        for (const [side, value] of Object.entries(padding)) {
          assert.ok(
            Number.isFinite(value) && value >= 0,
            `${themeId}/${file}.${side} must be a non-negative number`
          );
          // Runtime clamps the accessory contribution to the viewBox, so a
          // value past it does not widen anything — it just hides a typo.
          const limit = side === "left" || side === "right" ? viewBox.width : viewBox.height;
          assert.ok(
            value <= limit,
            `${themeId}/${file}.${side}=${value} exceeds its ${limit}-unit viewBox`
          );
        }
      }
    }
  });

  it("keeps measured animated motion envelopes separate from authored theme padding", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    const file = "clawd-headphones-groove.svg";
    const authored = theme.customization.accessories.files[file].hitBoxPadding;
    const measured = BUILTIN_ACCESSORY_MOTION_PADDING.clawd[file];

    // The original authored 1.5-unit padding is intentionally retained in the
    // theme. Chromium sampling showed it misses horizontally, so the built-in
    // runtime envelope supplies the measured correction instead of mutating
    // public theme metadata or teaching this unit test the production union formula.
    assert.strictEqual(authored.left, 1.5);
    assert.strictEqual(authored.right, 1.5);
    assert.ok(measured.left > authored.left);
    assert.ok(measured.right > authored.right);
  });

  it("keeps hidden accessories from changing the animation hitbox", () => {
    const theme = themeLoader.loadTheme("clawd", { strict: true });
    const file = "clawd-collapse-sleep.svg";
    const base = baseHitBox(theme, file);
    assert.strictEqual(
      resolveAccessoryAwareHitBox(
        theme,
        "collapsing",
        file,
        base,
        resolvePetAccessoryPayload("wizard-hat", theme)
      ),
      base
    );
  });
});
