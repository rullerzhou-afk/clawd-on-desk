"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const accessoryLayout = require("../src/pet-accessory-layout");

const ROOT = path.join(__dirname, "..");
themeLoader.init(path.join(ROOT, "src"));

const VISIBLE_MOUTH_FILES = Object.freeze([
  "clawd-idle-follow.svg",
  "clawd-idle-yawn.svg",
  "clawd-idle-doze.svg",
  "clawd-working-thinking.svg",
  "clawd-working-typing.svg",
  "clawd-headphones-groove.svg",
  "clawd-notification.svg",
  "clawd-working-carrying.svg",
  "clawd-wake.svg",
  "clawd-dizzy.svg",
  "clawd-working-juggling.svg",
  "clawd-idle-look.svg",
  "clawd-idle-reading.svg",
  "clawd-react-left.svg",
  "clawd-react-right.svg",
  "clawd-react-annoyed.svg",
  "clawd-react-double.svg",
  "clawd-react-double-jump.svg",
]);

const HIDDEN_MOUTH_FILES = Object.freeze([
  "clawd-mini-crabwalk.svg",
  "clawd-collapse-sleep.svg",
  "clawd-working-sweeping.svg",
  "clawd-error.svg",
  "clawd-happy.svg",
  "clawd-designing.svg",
  "clawd-heart-eyes.svg",
  "clawd-working-building.svg",
  "clawd-idle-bubble.svg",
  "clawd-working-debugger.svg",
  "clawd-react-drag.svg",
  "clawd-sleeping.svg",
  "clawd-mini-idle.svg",
  "clawd-mini-alert.svg",
  "clawd-mini-happy.svg",
  "clawd-mini-enter.svg",
  "clawd-mini-peek.svg",
  "clawd-mini-typing.svg",
  "clawd-mini-enter-sleep.svg",
  "clawd-mini-sleep.svg",
]);

const OPTIONAL_LIBRARY_FILES = Object.freeze([
  "clawd-about-hero.svg",
  "clawd-aegyo-shy.svg",
  "clawd-coffee-hand.svg",
  "clawd-coffee-head-flip.svg",
  "clawd-idle-collapse.svg",
  "clawd-idle-living.svg",
  "clawd-idle-low-battery.svg",
  "clawd-static-base.svg",
  "clawd-working-typing-boss.svg",
  "clawd-working-ultrathink.svg",
  "clawd-working-wizard.svg",
]);

test("mouth policy covers the approved 38 stock sprites exactly", () => {
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const files = theme.customization.mouthAccessories.files;
  const stockFiles = Object.fromEntries(
    Object.entries(files).filter(([file]) => (
      file !== "clawd-outlaw-bender.svg" && !OPTIONAL_LIBRARY_FILES.includes(file)
    ))
  );

  assert.strictEqual(theme._capabilities.mouthAccessories, true);
  assert.deepStrictEqual(
    new Set(Object.keys(stockFiles)),
    new Set([...VISIBLE_MOUTH_FILES, ...HIDDEN_MOUTH_FILES])
  );
  assert.strictEqual(Object.keys(stockFiles).length, 38);
  assert.deepStrictEqual(files["clawd-outlaw-bender.svg"], { visibility: "hidden" });
  assert.deepStrictEqual(
    files["clawd-working-typing-boss.svg"],
    { visibility: "hidden" },
    "the boss sprite already draws its own cigar and code smoke"
  );
  assert.deepStrictEqual(
    theme.customization.accessories.files["clawd-outlaw-bender.svg"],
    { visibility: "hidden" }
  );

  for (const file of VISIBLE_MOUTH_FILES) {
    assert.ok(files[file].staticFrame, `${file} must keep a static fallback`);
    assert.ok(files[file].followTarget, `${file} must follow its rendered animation anchor`);
    assert.notStrictEqual(files[file].visibility, "hidden", file);
  }
  for (const file of HIDDEN_MOUTH_FILES) {
    assert.deepStrictEqual(files[file], { visibility: "hidden" }, file);
  }
});

test("the boss extra keeps its authored cigar and never receives a second cigarette", () => {
  const boss = fs.readFileSync(
    path.join(ROOT, "assets", "svg", "clawd-working-typing-boss.svg"),
    "utf8"
  );
  const theme = themeLoader.loadTheme("clawd", { strict: true });

  assert.match(boss, /id="cigarette-rotor"/);
  assert.match(boss, /id="codesmoke"/);
  assert.match(boss, /<g id="accessory-anchor" class="body-walk">/);
  assert.deepStrictEqual(
    theme.customization.mouthAccessories.files["clawd-working-typing-boss.svg"],
    { visibility: "hidden" }
  );
  assert.strictEqual(
    theme.customization.accessories.files["clawd-working-typing-boss.svg"]
      .followTarget.id,
    "accessory-anchor"
  );
});

test("optional animation-library SVGs never fall back to static moving accessories", () => {
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const head = theme.customization.accessories.files;
  const mouth = theme.customization.mouthAccessories.files;

  for (const [file, target] of Object.entries({
    "clawd-about-hero.svg": "master-group",
    "clawd-aegyo-shy.svg": "accessory-anchor",
    "clawd-coffee-hand.svg": "character-motion",
    "clawd-idle-living.svg": "torso",
    "clawd-idle-low-battery.svg": "accessory-anchor",
    "clawd-working-typing-boss.svg": "accessory-anchor",
    "clawd-working-ultrathink.svg": "accessory-anchor",
  })) {
    assert.strictEqual(head[file].followTarget.id, target, `${file} head target`);
  }
  for (const file of [
    "clawd-coffee-head-flip.svg",
    "clawd-idle-collapse.svg",
    "clawd-working-wizard.svg",
  ]) {
    assert.deepStrictEqual(head[file], { visibility: "hidden" }, `${file} head policy`);
  }
  assert.ok(head["clawd-static-base.svg"].staticFrame);
  assert.strictEqual(head["clawd-static-base.svg"].followTarget, undefined);

  for (const [file, target] of Object.entries({
    "clawd-about-hero.svg": "master-group",
    "clawd-coffee-hand.svg": "character-motion",
    "clawd-coffee-head-flip.svg": "body-color-group",
    "clawd-idle-living.svg": "torso",
    "clawd-idle-low-battery.svg": "accessory-anchor",
    "clawd-working-ultrathink.svg": "accessory-anchor",
    "clawd-working-wizard.svg": "body-color-group",
  })) {
    assert.strictEqual(mouth[file].followTarget.id, target, `${file} mouth target`);
  }
  assert.deepStrictEqual(mouth["clawd-aegyo-shy.svg"], { visibility: "hidden" });
  assert.deepStrictEqual(mouth["clawd-idle-collapse.svg"], { visibility: "hidden" });
  assert.deepStrictEqual(mouth["clawd-working-typing-boss.svg"], { visibility: "hidden" });
  assert.ok(mouth["clawd-static-base.svg"].staticFrame);
  assert.strictEqual(mouth["clawd-static-base.svg"].followTarget, undefined);
});

test("head pose policy keeps headphones hatless and limits western-hat-only overrides", () => {
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const base = theme.customization.accessories.files;
  const overrides = theme.customization.accessories.itemOverrides;
  const western = overrides["western-cowboy-hat"].files;

  assert.strictEqual(overrides["cowboy-hat"], undefined);
  assert.deepStrictEqual(base["clawd-error.svg"], { visibility: "hidden" });
  assert.deepStrictEqual(base["clawd-wake.svg"], { visibility: "hidden" });
  assert.ok(western["clawd-error.svg"].staticFrame);
  assert.ok(western["clawd-wake.svg"].staticFrame);
  assert.strictEqual(western["clawd-error.svg"].staticFrame.baseY, 10.5);
  assert.deepStrictEqual(
    base["clawd-headphones-groove.svg"],
    { visibility: "hidden" }
  );
  assert.strictEqual(western["clawd-headphones-groove.svg"], undefined);
  assert.ok(
    theme.customization.mouthAccessories.files["clawd-headphones-groove.svg"].followTarget,
    "hiding hats on the headphones sprite must not hide its cigarette slot"
  );

  for (const file of [
    "clawd-collapse-sleep.svg",
    "clawd-working-carrying.svg",
    "clawd-sleeping.svg",
    "clawd-working-building.svg",
  ]) {
    assert.deepStrictEqual(western[file], { visibility: "hidden" }, file);
  }
});

test("notification and wake anchors are named on the elements that own their motion", () => {
  const notification = fs.readFileSync(
    path.join(ROOT, "assets", "svg", "clawd-notification.svg"),
    "utf8"
  );
  const wake = fs.readFileSync(
    path.join(ROOT, "assets", "svg", "clawd-wake.svg"),
    "utf8"
  );
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const notificationDescriptor =
    theme.customization.mouthAccessories.files["clawd-notification.svg"];

  assert.match(
    notification,
    /<rect id="mouth-anchor-right" class="arm-l-balance" x="0" y="9" width="2" height="2"/
  );
  assert.deepStrictEqual(notificationDescriptor.followTarget, {
    id: "mouth-anchor-right",
    frame: { cx: 1, baseY: 11, width: 5 },
    normalizeReflection: "x",
  });
  assert.deepStrictEqual(notificationDescriptor.staticFrame, {
    cx: 13.5,
    baseY: 11,
    width: 5,
  });
  assert.match(
    wake,
    /<g id="accessory-anchor" class="once torso-shift">/
  );
});

test("the canonical cigarette frame reproduces the pinned standard-pose coordinates", () => {
  const layout = accessoryLayout.computeDynamicAccessoryLayout({
    matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    mediaOffset: { x: 0, y: 0 },
    frame: { cx: 14, baseY: 13, width: 5 },
    accessory: { aspect: 5 / 9, widthScale: 1, offsetY: 0 },
    stageSize: { width: 100, height: 100 },
  });

  // The canonical SVG's paper begins at local (0.5, 7). After this frame it
  // lands at (12, 11), exactly matching PR #811's generated CIG fragment.
  assert.deepStrictEqual(layout.matrix, { a: 1, b: 0, c: 0, d: 1, e: 11.5, f: 4 });
  assert.strictEqual(layout.width, 5);
  assert.strictEqual(layout.height, 9);
});

test("every visible animated cigarette has a measured or authored hit envelope", () => {
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  const files = theme.customization.mouthAccessories.files;
  const measured = require("../src/pet-accessory-hitbox")
    .BUILTIN_MOUTH_ACCESSORY_MOTION_PADDING.clawd;

  for (const file of VISIBLE_MOUTH_FILES) {
    assert.ok(
      measured[file] || files[file].hitBoxPadding,
      `${file} needs a native hit-window motion envelope`
    );
  }
  assert.ok(
    theme.customization.accessories.itemOverrides["western-cowboy-hat"].files["clawd-wake.svg"]
      .hitBoxPadding,
    "the newly visible wake western hat needs its own one-shot motion envelope"
  );
});

test("bender uses the one-unit anti-crop viewBox and its measured face-plant hitbox", () => {
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  assert.deepStrictEqual(theme.idleEasterEggs, [{
    file: "clawd-outlaw-bender.svg",
    duration: 15000,
    chance: 0.5,
    cooldownMs: 1800000,
    requiresAccessories: { head: "western-cowboy-hat", mouth: "cigarette" },
  }]);
  assert.deepStrictEqual(theme.rendering.objectChannelFiles, ["clawd-outlaw-bender.svg"]);
  assert.deepStrictEqual(theme.fileViewBoxes["clawd-outlaw-bender.svg"], {
    x: -15,
    y: -25,
    width: 45,
    height: 46,
  });
  assert.deepStrictEqual(theme.fileHitBoxes["clawd-outlaw-bender.svg"], {
    x: -1,
    y: 1,
    w: 27,
    h: 20,
  });
});
