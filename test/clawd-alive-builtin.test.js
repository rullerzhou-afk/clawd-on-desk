"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const themeLoader = require("../src/theme-loader");
const { validateTheme, mergeDefaults, getTierFiles } = require("../src/theme-schema");
const {
  selectTieredStateFiles, getWorkingSvg, getJugglingSvg, createStableVisualPicker,
} = require("../src/state-visual-resolver");

const ROOT = path.join(__dirname, "..");
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "themes", "clawd", "theme.json"), "utf8"));
themeLoader.init(path.join(ROOT, "src"));

// Pin the contributed artwork so future edits cannot silently change its source.
const ASSET_HASHES = Object.freeze({
  "clawd-alive-coffee.svg": "37681f92bd7a158b23ee2409345defef5cd01969d21aab758fee10320e3959be",
  "clawd-alive-toy-yoyo.svg": "f7b5801c2dd2f393da87d61e159a0ad2caac2e41fb5071ee03d5e9da54ba8272",
  "clawd-alive-toy-plane.svg": "0c803876917ac7fd5883766447e51a3ab42eb2e7f21e5015f5cf2bef77b5a81e",
  "clawd-alive-sit-edge.svg": "e31f7d2a384648f5c2e2de0e307a5cf121555202a23c686175273d7c833a7fb7",
  "clawd-alive-fake-nap.svg": "f06db55cbebcb48bb6766a1ea99b8dc8804a053cf3b9f57e9352ecfd2487273c",
  "clawd-alive-work-coffee.svg": "d25b742b04fb84da21f772c797e799c2059c91a8f3ed165042984889859edded",
  "clawd-alive-work-dual.svg": "cf03b9eba5deb71021dcb63da06c484ea94cf0e6d2f55dcab141f18b5dc0f02b",
  "clawd-alive-work-trio.svg": "fd2810d1287ce25c1e43d7657348b996e670a49e2e0b2ecf9ca8bd921787ab03",
  "clawd-alive-work-control-room.svg": "512cc9bdb700dfab821e01d5f19dc86017c3e904ad73bc818f0c4a0b1c37a314",
  "clawd-alive-work-swamped.svg": "fdd73dc786ffe3f8b5de237d367b6dc0844624b91ecba7f01187ae4854970534",
  "clawd-alive-work-chaos.svg": "6dbb3c3fd27c7a029dc3b858055534f61c121673d66fbf9feef92018c4559a80",
  "clawd-alive-juggle-laptops.svg": "ccd034a662f5c84eb2319a071b0875ee8dcaf1238f214bf208f2a8270a8065ae",
  "clawd-alive-juggle-chaos.svg": "d9a8a7fd3ffd997f4d0508e5262f2806d416345854eab4d475367bd1373e839d",
  "clawd-alive-boo.svg": "1a2191873cbaae00063a7716a8d38a67b2c99a609a6eb4b5429ade1994b70aa3",
});

test("issue #1351: ships exactly the fourteen selected Alive assets with their original LF content", () => {
  const expected = Object.keys(ASSET_HASHES).sort();
  const referenced = [...new Set(JSON.stringify(raw).match(/clawd-alive-[a-z-]+\.svg/g))].sort();
  const shipped = fs.readdirSync(path.join(ROOT, "assets", "svg"))
    .filter(file => file.startsWith("clawd-alive-")).sort();
  assert.deepEqual(referenced, expected);
  assert.deepEqual(shipped, expected);
  for (const [file, hash] of Object.entries(ASSET_HASHES)) {
    // Git may check SVG text out as CRLF; compare the original LF content.
    const source = fs.readFileSync(path.join(ROOT, "assets", "svg", file), "utf8").replace(/\r\n/g, "\n");
    assert.equal(createHash("sha256").update(source).digest("hex"), hash, file);
  }
});

const WORKING_POOLS = [
  ["clawd-working-typing.svg", "clawd-alive-work-coffee.svg"],
  ["clawd-headphones-groove.svg", "clawd-alive-work-dual.svg"],
  ["clawd-working-building.svg", "clawd-alive-work-trio.svg"],
  ["clawd-alive-work-control-room.svg", "clawd-alive-work-swamped.svg"],
  ["clawd-alive-work-chaos.svg"],
  ["clawd-alive-work-chaos.svg"],
];
const JUGGLING_POOLS = [
  ["clawd-headphones-groove.svg"],
  ["clawd-working-juggling.svg", "clawd-alive-juggle-laptops.svg"],
  ["clawd-alive-juggle-chaos.svg"],
  ["clawd-alive-juggle-chaos.svg"],
];

for (const [group, pools, resolve] of [
  ["workingTiers", WORKING_POOLS, getWorkingSvg],
  ["jugglingTiers", JUGGLING_POOLS, getJugglingSvg],
]) {
  pools.forEach((expected, index) => {
    const count = index + 1;
    test(`issue #1351: ${group} count ${count} resolves its full candidate pool`, () => {
      const theme = themeLoader.loadTheme("clawd", { strict: true });
      assert.deepEqual(selectTieredStateFiles(theme[group], count, []), expected);
      const sessions = group === "workingTiers"
        ? new Map(Array.from({ length: count }, (_, n) => [`session-${n}`, { state: "working" }]))
        : new Map([["parent", { state: "juggling", subagentTracker: {
          confirmedIds: new Set(Array.from({ length: count }, (_, n) => `child-${n}`)),
          legacyFloor: false, recoveredFloor: false,
        } }]]);
      for (const roll of [0, 0.99]) {
        const picker = createStableVisualPicker(() => roll);
        assert.equal(resolve({ theme, sessions, stateSvgs: theme.states, pickVisualFile: picker.pick }),
          expected[roll === 0 ? 0 : expected.length - 1]);
      }
    });
  });
}

test("issue #1351: a saved typing-tier override replaces the first slot and preserves the second", () => {
  const theme = themeLoader.loadTheme("clawd", { strict: true, overrides: {
    tiers: { workingTiers: { "clawd-working-typing.svg": { file: "clawd-idle-reading.svg" } } },
  } });
  const tier = theme.workingTiers.find(tier => tier.minSessions === 1);
  assert.equal(tier.file, "clawd-idle-reading.svg");
  assert.deepEqual(getTierFiles(tier), ["clawd-idle-reading.svg", "clawd-alive-work-coffee.svg"]);
  assert.equal(theme._bindingBase.workingTiers.find(tier => tier.minSessions === 1).originalFile,
    "clawd-working-typing.svg");
});

test("issue #1351: CPU hints accept SVG basenames and survive schema normalization", () => {
  const theme = structuredClone(raw);
  theme.rendering.cpuIntensiveFiles = ["animation.svg", "animation.svg"];
  assert.deepEqual(validateTheme(theme), []);
  assert.deepEqual(mergeDefaults(theme, "external", false).rendering.cpuIntensiveFiles,
    ["animation.svg"]);
  theme.rendering.cpuIntensiveFiles = ["dir/animation.svg", "dir\\animation.svg"];
  assert.deepEqual(mergeDefaults(theme, "external", false).rendering.cpuIntensiveFiles, ["animation.svg"]);
  delete theme.rendering.cpuIntensiveFiles;
  assert.deepEqual(validateTheme(theme), []);
  assert.equal(mergeDefaults(theme, "external", false).rendering.cpuIntensiveFiles, undefined);
  theme.rendering.cpuIntensiveFiles = [];
  assert.deepEqual(validateTheme(theme), []);
  assert.equal(mergeDefaults(theme, "external", false).rendering.cpuIntensiveFiles, undefined);
});

test("issue #1351: loading built-in Clawd preserves exactly its five CPU hints", () => {
  const theme = themeLoader.loadTheme("clawd", { strict: true });
  assert.deepEqual(theme.rendering.cpuIntensiveFiles, [
    "clawd-alive-work-control-room.svg",
    "clawd-alive-work-swamped.svg",
    "clawd-alive-work-chaos.svg",
    "clawd-alive-juggle-laptops.svg",
    "clawd-alive-juggle-chaos.svg",
  ]);
});

for (const value of [
  null, "animation.svg", {}, [7], [""], [" "], ["dir/file.svg"], ["dir\\file.svg"],
  ["x.png"], [" a.svg"], ["a.svg "], [" a.svg "],
]) {
  test(`issue #1351: CPU hints reject ${JSON.stringify(value)}`, () => {
    const theme = structuredClone(raw);
    theme.rendering.cpuIntensiveFiles = value;
    assert.deepEqual(validateTheme(theme), ["rendering.cpuIntensiveFiles must contain SVG basenames only"]);
  });
}
