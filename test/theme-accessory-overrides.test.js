"use strict";

const { describe, it, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");
const createThemeContext = require("../src/theme-context");
const { resolvePetAccessoryPayload } = require("../src/pet-customization-catalog");

const ROOT_FRAME = { cx: 50, baseY: 20, width: 30 };
const MINI_FRAME = { cx: 10, baseY: 4, width: 6 };
const MINI_STATE_NAMES = [
  "mini-idle",
  "mini-enter",
  "mini-enter-sleep",
  "mini-crabwalk",
  "mini-peek",
  "mini-alert",
  "mini-happy",
  "mini-sleep",
];

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

function wardrobeTheme() {
  const miniStates = Object.fromEntries(
    MINI_STATE_NAMES.map((state) => [state, [`${state}.svg`]])
  );
  const miniDescriptors = Object.fromEntries(
    MINI_STATE_NAMES.map((state) => [
      `${state}.svg`,
      { staticFrame: { ...MINI_FRAME } },
    ])
  );
  return validThemeJson({
    states: {
      ...validThemeJson().states,
      attention: ["attention.svg"],
    },
    miniMode: {
      supported: true,
      viewBox: { x: 0, y: 0, width: 20, height: 20 },
      states: miniStates,
    },
    reactions: {
      drag: { file: "drag.svg", duration: 400 },
    },
    idleAnimations: [
      { file: "idle-loop.svg", duration: 1200 },
    ],
    // This asset can be selected by an override, but its coordinates are not
    // compatible with the root fallback and it has no authored exact anchor.
    fileViewBoxes: {
      "unsafe-custom.svg": { x: 0, y: 0, width: 10, height: 10 },
    },
    customization: {
      accessories: {
        default: { staticFrame: { ...ROOT_FRAME } },
        files: {
          "attention.svg": {
            staticFrame: { ...ROOT_FRAME },
            followTarget: {
              id: "accessory-anchor",
              frame: { cx: 12, baseY: 4, width: 16 },
            },
          },
          "sleeping.svg": { visibility: "hidden" },
          "drag.svg": { staticFrame: { ...ROOT_FRAME } },
          "idle-loop.svg": { staticFrame: { ...ROOT_FRAME } },
          ...miniDescriptors,
        },
      },
    },
  });
}

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-accessory-overrides-"));
  const appDir = path.join(tmp, "src");
  const builtinDir = path.join(tmp, "themes", "wardrobe");
  const miniFallbackDir = path.join(tmp, "themes", "wardrobe-mini-fallback");
  const userData = path.join(tmp, "userData");
  const externalDir = path.join(userData, "themes", "external-stale");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "svg"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "sounds"), { recursive: true });
  fs.mkdirSync(builtinDir, { recursive: true });
  fs.mkdirSync(miniFallbackDir, { recursive: true });
  fs.mkdirSync(path.join(externalDir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(builtinDir, "theme.json"),
    JSON.stringify(wardrobeTheme()),
    "utf8"
  );
  const miniFallbackTheme = wardrobeTheme();
  miniFallbackTheme.customization.accessories.mini = {
    staticFrame: { ...MINI_FRAME },
  };
  fs.writeFileSync(
    path.join(miniFallbackDir, "theme.json"),
    JSON.stringify(miniFallbackTheme),
    "utf8"
  );

  const external = validThemeJson({
    customization: {
      accessories: {
        default: { staticFrame: { ...ROOT_FRAME } },
        files: {
          "not-reachable.svg": { staticFrame: { ...ROOT_FRAME } },
        },
      },
    },
  });
  fs.writeFileSync(
    path.join(externalDir, "theme.json"),
    JSON.stringify(external),
    "utf8"
  );
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';
  for (const binding of Object.values(external.states)) {
    for (const file of binding) {
      fs.writeFileSync(path.join(externalDir, "assets", file), svg, "utf8");
    }
  }

  themeLoader.init(appDir, userData);
  return {
    cleanup() {
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("theme accessory animation overrides", () => {
  const fixture = makeFixture();
  after(() => fixture.cleanup());

  it("keeps the authored wardrobe across interrupt, sleep, reaction, idle, and mini overrides", () => {
    const theme = themeLoader.loadTheme("wardrobe", {
      strict: true,
      overrides: {
        states: {
          attention: { file: "custom-attention.svg" },
          sleeping: { file: "custom-sleep.svg" },
          "mini-idle": { file: "custom-mini-idle.svg" },
        },
        reactions: {
          drag: { file: "custom-drag.svg" },
        },
        idleAnimations: {
          "idle-loop.svg": { file: "custom-idle-loop.svg" },
        },
      },
    });

    assert.strictEqual(theme._capabilities.accessories, true);
    const attachments = theme.customization.accessories;
    assert.deepStrictEqual(attachments.files["custom-attention.svg"], {
      staticFrame: ROOT_FRAME,
    });
    assert.deepStrictEqual(attachments.files["custom-sleep.svg"], {
      staticFrame: ROOT_FRAME,
    });
    assert.deepStrictEqual(attachments.files["custom-drag.svg"], {
      staticFrame: ROOT_FRAME,
    });
    assert.deepStrictEqual(attachments.files["custom-idle-loop.svg"], {
      staticFrame: ROOT_FRAME,
    });
    assert.deepStrictEqual(attachments.files["custom-mini-idle.svg"], {
      visibility: "hidden",
    });
    assert.deepStrictEqual(attachments.files["attention.svg"], {
      staticFrame: ROOT_FRAME,
      followTarget: {
        id: "accessory-anchor",
        frame: { cx: 12, baseY: 4, width: 16 },
      },
    });
    assert.strictEqual(attachments.default, undefined);
    assert.strictEqual(attachments.mini, undefined);

    const rendererConfig = createThemeContext(theme, {}).getRendererConfig();
    assert.strictEqual(rendererConfig.accessorySupported, true);
    assert.strictEqual(
      rendererConfig.accessoryAttachments.files["custom-mini-idle.svg"].visibility,
      "hidden"
    );
    assert.strictEqual(resolvePetAccessoryPayload("cowboy-hat", theme).id, "cowboy-hat");
  });

  it("prefers exact descriptors and hides only an override with unsafe fallback geometry", () => {
    const exactTheme = themeLoader.loadTheme("wardrobe", {
      strict: true,
      overrides: {
        states: {
          thinking: { file: "attention.svg" },
        },
      },
    });
    assert.strictEqual(exactTheme._capabilities.accessories, true);
    assert.strictEqual(
      exactTheme.customization.accessories.files["attention.svg"].followTarget.id,
      "accessory-anchor"
    );

    const unsafeTheme = themeLoader.loadTheme("wardrobe", {
      strict: true,
      overrides: {
        states: {
          thinking: { file: "unsafe-custom.svg" },
        },
      },
    });
    assert.strictEqual(unsafeTheme._capabilities.accessories, true);
    assert.deepStrictEqual(
      unsafeTheme.customization.accessories.files["unsafe-custom.svg"],
      { visibility: "hidden" }
    );
    assert.deepStrictEqual(
      unsafeTheme.customization.accessories.files["working.svg"],
      { staticFrame: ROOT_FRAME }
    );
  });

  it("uses only the mini fallback for an overridden mini frame", () => {
    const theme = themeLoader.loadTheme("wardrobe-mini-fallback", {
      strict: true,
      overrides: {
        states: {
          "mini-idle": { file: "custom-mini-idle.svg" },
        },
      },
    });

    assert.strictEqual(theme._capabilities.accessories, true);
    assert.deepStrictEqual(
      theme.customization.accessories.files["custom-mini-idle.svg"],
      { staticFrame: MINI_FRAME }
    );
    assert.notDeepStrictEqual(
      theme.customization.accessories.files["custom-mini-idle.svg"],
      { staticFrame: ROOT_FRAME }
    );
  });

  it("keeps an external animation-library descriptor but requires its asset", () => {
    const validation = themeLoader.validateThemeShape("external-stale");
    assert.strictEqual(validation.ok, false);
    assert.ok(
      validation.errors.some((error) => error.includes("missing asset: not-reachable.svg")),
      `expected the optional descriptor asset to be required, got: ${validation.errors.join("; ")}`
    );

    const theme = themeLoader.loadTheme("external-stale", { strict: true });
    assert.strictEqual(theme._id, "external-stale");
    assert.strictEqual(theme._builtin, false);
    assert.strictEqual(theme._capabilities.accessories, true);
    assert.deepStrictEqual(
      theme.customization.accessories.files["not-reachable.svg"],
      { staticFrame: ROOT_FRAME }
    );
    assert.strictEqual(resolvePetAccessoryPayload("cowboy-hat", theme).id, "cowboy-hat");
  });
});
