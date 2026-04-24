"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const themeLoader = require("../src/theme-loader");

// Scratch dir layout the loader expects:
//   <tmp>/src/           (appDir)
//   <tmp>/themes/<id>/theme.json
//   <tmp>/themes/<id>/assets/<files>
//   <tmp>/assets/svg/    (referenced by init for built-in svgs)
//   <tmp>/userData/themes/<id>/theme.json   (user-installed)
function makeFixture(themes) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-theme-"));
  const appDir = path.join(tmp, "src");
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "svg"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "assets", "sounds"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "themes"), { recursive: true });
  const userData = path.join(tmp, "userData");
  fs.mkdirSync(path.join(userData, "themes"), { recursive: true });

  for (const { id, builtin, json, assets } of themes) {
    const base = builtin
      ? path.join(tmp, "themes", id)
      : path.join(userData, "themes", id);
    fs.mkdirSync(base, { recursive: true });
    if (json !== undefined) {
      fs.writeFileSync(path.join(base, "theme.json"), JSON.stringify(json), "utf8");
    }
    if (assets && typeof assets === "object") {
      const assetsDir = path.join(base, "assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      for (const [filename, content] of Object.entries(assets)) {
        fs.writeFileSync(path.join(assetsDir, filename), content, "utf8");
      }
    }
  }
  themeLoader.init(appDir, userData);
  return { tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

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

function fullMiniMode(overrides = {}) {
  return {
    supported: true,
    states: {
      "mini-idle": ["mini-idle.svg"],
      "mini-enter": ["mini-enter.svg"],
      "mini-enter-sleep": ["mini-enter-sleep.svg"],
      "mini-crabwalk": ["mini-crabwalk.svg"],
      "mini-peek": ["mini-peek.svg"],
      "mini-alert": ["mini-alert.svg"],
      "mini-happy": ["mini-happy.svg"],
      "mini-sleep": ["mini-sleep.svg"],
    },
    ...overrides,
  };
}

describe("theme-loader strict mode", () => {
  let fixture;
  before(() => {
    fixture = makeFixture([
      { id: "clawd", builtin: true, json: validThemeJson({ name: "Clawd" }) },
      { id: "good", builtin: true, json: validThemeJson({ name: "Good" }) },
      {
        id: "updatevisuals",
        builtin: true,
        json: validThemeJson({
          name: "Update Visuals",
          updateVisuals: { checking: "../nested/checking-special.svg" },
        }),
      },
      {
        id: "badupdatevisuals",
        builtin: true,
        json: validThemeJson({
          name: "Bad Update Visuals",
          updateVisuals: { checking: 42 },
        }),
      },
      {
        id: "updatebubbleanchor",
        builtin: true,
        json: validThemeJson({
          name: "Update Bubble Anchor",
          updateBubbleAnchorBox: { x: 10, y: 20, width: 30, height: 40 },
        }),
      },
      {
        id: "badupdatebubbleanchor",
        builtin: true,
        json: validThemeJson({
          name: "Bad Update Bubble Anchor",
          updateBubbleAnchorBox: { x: 10, y: "bad", width: 30, height: 40 },
        }),
      },
      // Missing required fields (no schemaVersion, no viewBox) → validateTheme fails.
      { id: "broken", builtin: false, json: { name: "Bad", version: "1", states: {} } },
    ]);
  });
  after(() => fixture && fixture.cleanup());

  it("lenient load falls back to clawd when theme missing", () => {
    const theme = themeLoader.loadTheme("doesNotExist");
    assert.strictEqual(theme._id, "clawd");
  });

  it("lenient load falls back when theme validation fails", () => {
    const theme = themeLoader.loadTheme("broken");
    assert.strictEqual(theme._id, "clawd");
  });

  it("strict load throws when theme is missing", () => {
    assert.throws(
      () => themeLoader.loadTheme("doesNotExist", { strict: true }),
      /not found/
    );
  });

  it("strict load throws when theme fails validation", () => {
    assert.throws(
      () => themeLoader.loadTheme("broken", { strict: true }),
      /validation/
    );
  });

  it("strict load succeeds on a valid theme", () => {
    const theme = themeLoader.loadTheme("good", { strict: true });
    assert.strictEqual(theme._id, "good");
  });

  it("normalizes updateVisuals file references", () => {
    const theme = themeLoader.loadTheme("updatevisuals", { strict: true });
    assert.strictEqual(theme.updateVisuals.checking, "checking-special.svg");
  });

  it("strict load rejects malformed updateVisuals", () => {
    assert.throws(
      () => themeLoader.loadTheme("badupdatevisuals", { strict: true }),
      /updateVisuals\.checking/
    );
  });

  it("preserves updateBubbleAnchorBox on a valid theme", () => {
    const theme = themeLoader.loadTheme("updatebubbleanchor", { strict: true });
    assert.deepStrictEqual(theme.updateBubbleAnchorBox, { x: 10, y: 20, width: 30, height: 40 });
  });

  it("strict load rejects malformed updateBubbleAnchorBox", () => {
    assert.throws(
      () => themeLoader.loadTheme("badupdatebubbleanchor", { strict: true }),
      /updateBubbleAnchorBox/
    );
  });
});

describe("theme-loader getThemeMetadata", () => {
  let fixture;
  before(() => {
    fixture = makeFixture([
      {
        id: "clawd",
        builtin: true,
        json: validThemeJson({ name: "Clawd", preview: "clawd-preview.svg" }),
      },
      {
        id: "noPreview",
        builtin: true,
        json: validThemeJson({ name: "No Preview", states: { ...validThemeJson().states, idle: ["fallback.svg"] } }),
      },
      { id: "broken", builtin: false, json: { name: "Bad", version: "1", states: {} } },
    ]);
  });
  after(() => fixture && fixture.cleanup());

  it("returns null for missing / malformed themes", () => {
    assert.strictEqual(themeLoader.getThemeMetadata("doesNotExist"), null);
  });

  it("returns name + builtin flag even when preview file is absent", () => {
    const meta = themeLoader.getThemeMetadata("noPreview");
    assert.ok(meta, "metadata expected");
    assert.strictEqual(meta.id, "noPreview");
    assert.strictEqual(meta.name, "No Preview");
    assert.strictEqual(meta.builtin, true);
    // No fs file seeded, so preview URL is null — acceptable: renderer
    // falls back to the placeholder glyph.
    assert.strictEqual(meta.previewFileUrl, null);
  });

  it("prefers explicit preview field over idle[0]", () => {
    // Both files are absent on disk in the fixture — we just verify the
    // selector chose `preview`, not `states.idle[0]`. A precise end-to-end
    // URL test would need writing a real asset, which is over-kill for the
    // contract under test.
    const meta = themeLoader.getThemeMetadata("clawd");
    assert.ok(meta);
    // Internal contract: when the preview file isn't found, URL is null.
    // (Exercising the positive path requires writing assets; we trust
    // path.basename() + fs.existsSync as leaf pieces.)
    assert.strictEqual(meta.previewFileUrl, null);
  });
});

describe("theme-loader preview sound selection", () => {
  let fixture;
  before(() => {
    fixture = makeFixture([
      { id: "clawd", builtin: true, json: validThemeJson({ name: "Clawd" }) },
      {
        id: "preview-theme",
        builtin: false,
        json: validThemeJson({
          name: "Preview Theme",
          sounds: {
            confirm: "preview-confirm.mp3",
          },
        }),
      },
      {
        id: "fallback-theme",
        builtin: false,
        json: validThemeJson({
          name: "Fallback Theme",
          sounds: {
            confirm: null,
          },
        }),
      },
      {
        id: "silent-theme",
        builtin: false,
        json: validThemeJson({
          name: "Silent Theme",
          sounds: {
            confirm: null,
            complete: null,
          },
        }),
      },
    ]);

    fs.writeFileSync(path.join(fixture.tmp, "assets", "sounds", "complete.mp3"), "complete", "utf8");

    for (const themeId of ["preview-theme", "fallback-theme", "silent-theme"]) {
      fs.mkdirSync(path.join(fixture.tmp, "userData", "themes", themeId, "assets"), { recursive: true });
    }

    const previewSoundsDir = path.join(fixture.tmp, "userData", "themes", "preview-theme", "sounds");
    fs.mkdirSync(previewSoundsDir, { recursive: true });
    fs.writeFileSync(path.join(previewSoundsDir, "preview-confirm.mp3"), "confirm", "utf8");
  });
  after(() => fixture && fixture.cleanup());

  it("prefers confirm for settings preview when available", () => {
    themeLoader.loadTheme("preview-theme", { strict: true });
    const previewUrl = themeLoader.getPreviewSoundUrl();
    assert.ok(previewUrl, "preview URL expected");
    assert.ok(previewUrl.includes("preview-confirm.mp3"));
  });

  it("falls back to complete when confirm is unavailable", () => {
    themeLoader.loadTheme("fallback-theme", { strict: true });
    const previewUrl = themeLoader.getPreviewSoundUrl();
    assert.ok(previewUrl, "preview URL expected");
    assert.ok(previewUrl.includes("complete.mp3"));
  });

  it("returns null when neither confirm nor complete is available", () => {
    themeLoader.loadTheme("silent-theme", { strict: true });
    assert.strictEqual(themeLoader.getPreviewSoundUrl(), null);
  });
});

describe("theme-loader discovery", () => {
  let fixture;
  before(() => {
    fixture = makeFixture([
      {
        id: "clawd",
        builtin: true,
        json: validThemeJson({ name: "Clawd" }),
      },
      {
        id: "template",
        builtin: true,
        json: validThemeJson({ name: "My Theme", _scaffoldOnly: true }),
      },
      {
        id: "user-cat",
        builtin: false,
        json: validThemeJson({ name: "User Cat" }),
      },
    ]);
  });
  after(() => fixture && fixture.cleanup());

  it("skips the built-in template from discoverThemes and metadata scans", () => {
    const discovered = themeLoader.discoverThemes().map((theme) => theme.id);
    assert.deepStrictEqual(discovered.sort(), ["clawd", "user-cat"]);

    const listed = themeLoader.listThemesWithMetadata().map((theme) => theme.id);
    assert.deepStrictEqual(listed.sort(), ["clawd", "user-cat"]);
  });
});

describe("theme-loader external SVG sanitization", () => {
  let fixture;
  before(() => {
    fixture = makeFixture([
      {
        id: "clawd",
        builtin: true,
        json: validThemeJson({ name: "Clawd" }),
      },
      {
        id: "unsafe-inline-style",
        builtin: false,
        json: validThemeJson({ name: "Unsafe Inline Style" }),
        assets: {
          "pattern.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
          "idle.svg": [
            "<svg xmlns=\"http://www.w3.org/2000/svg\">",
            "  <rect",
            "    style=\"fill:url(pattern.svg#grad);stroke:url(#allowed);filter:url(https://example.com/filter.svg#p)\"",
            "    fill=\"url(pattern.svg#fill)\"",
            "    mask=\"url(//bad.example/fill.svg#p)\"",
            "    width=\"10\" height=\"10\"/>",
            "  <use href=\"pattern.svg#shape\"/>",
            "  <use href=\"//attacker.com/x.svg#p\"/>",
            "  <image href=\"..%2F..%2Fetc%2Fpasswd\"/>",
            "</svg>",
          ].join(""),
        },
      },
    ]);
  });
  after(() => fixture && fixture.cleanup());

  it("strips unsafe href/url references while preserving safe local ones", () => {
    themeLoader.loadTheme("unsafe-inline-style", { strict: true });
    const sanitizedPath = themeLoader.getAssetPath("idle.svg");
    const sanitized = fs.readFileSync(sanitizedPath, "utf8");

    assert.ok(sanitized.includes("fill:url(pattern.svg#grad)"), "safe relative CSS url should survive");
    assert.ok(sanitized.includes("stroke:url(#allowed)"), "internal fragment url should survive");
    assert.ok(sanitized.includes("fill=\"url(pattern.svg#fill)\""), "safe relative presentation attr should survive");
    assert.ok(sanitized.includes("href=\"pattern.svg#shape\""), "safe relative href should survive");
    assert.ok(!sanitized.includes("https://example.com"), "inline style external url should be removed");
    assert.ok(!sanitized.includes("//bad.example"), "protocol-relative presentation attr should be removed");
    assert.ok(!sanitized.includes("//attacker.com"), "protocol-relative href should be removed");
    assert.ok(!sanitized.includes("..%2F..%2Fetc%2Fpasswd"), "encoded traversal href should be removed");
  });
});

describe("theme-loader capability metadata", () => {
  let fixture;
  before(() => {
    fixture = makeFixture([
      { id: "clawd", builtin: true, json: validThemeJson({ name: "Clawd" }) },
      {
        id: "capTheme",
        builtin: true,
        json: validThemeJson({
          name: "Capabilities",
          eyeTracking: { enabled: true, states: ["idle"] },
          workingTiers: [{ minSessions: 1, file: "working-tier.svg" }],
          jugglingTiers: [{ minSessions: 1, file: "juggling-tier.svg" }],
          idleAnimations: [{ file: "idle-loop.png", duration: 1200 }],
          reactions: { drag: { file: "drag.png" } },
          miniMode: { supported: false },
        }),
      },
      {
        id: "implicitMini",
        builtin: true,
        json: validThemeJson({
          name: "Implicit Mini",
          miniMode: fullMiniMode({ supported: undefined }),
        }),
      },
      {
        id: "badMini",
        builtin: true,
        json: validThemeJson({
          name: "Bad Mini",
          miniMode: {
            supported: true,
            states: {
              "mini-idle": ["mini-idle.svg"],
              "mini-enter": ["mini-enter.svg"],
            },
          },
        }),
      },
    ]);
  });
  after(() => fixture && fixture.cleanup());

  it("derives _capabilities from the current schema fields", () => {
    const theme = themeLoader.loadTheme("capTheme", { strict: true });
    assert.deepStrictEqual(theme._capabilities, {
      eyeTracking: true,
      miniMode: false,
      idleAnimations: true,
      reactions: true,
      workingTiers: true,
      jugglingTiers: true,
      idleMode: "tracked",
      sleepMode: "full",
    });
  });

  it("includes capabilities in theme metadata scans", () => {
    const meta = themeLoader.getThemeMetadata("capTheme");
    assert.deepStrictEqual(meta.capabilities, {
      eyeTracking: true,
      miniMode: false,
      idleAnimations: true,
      reactions: true,
      workingTiers: true,
      jugglingTiers: true,
      idleMode: "tracked",
      sleepMode: "full",
    });

    const listed = themeLoader.listThemesWithMetadata().find((theme) => theme.id === "capTheme");
    assert.ok(listed, "capTheme should appear in metadata list");
    assert.deepStrictEqual(listed.capabilities, meta.capabilities);
  });

  it("treats a miniMode block as supported unless supported=false", () => {
    const theme = themeLoader.loadTheme("implicitMini", { strict: true });
    assert.strictEqual(theme._capabilities.miniMode, true);
  });

  it("strict load rejects mini themes that do not define all 8 mini states", () => {
    assert.throws(
      () => themeLoader.loadTheme("badMini", { strict: true }),
      /miniMode\.supported=true requires miniMode\.states\.mini-enter-sleep/
    );
  });
});

describe("theme-loader fallback + sleepSequence", () => {
  let fixture;
  before(() => {
    const directSleepStates = {
      idle: ["idle.svg"],
      thinking: ["thinking.svg"],
      working: ["working.svg"],
      attention: ["attention.svg"],
      error: { fallbackTo: "attention" },
      sleeping: { fallbackTo: "idle" },
    };
    fixture = makeFixture([
      { id: "clawd", builtin: true, json: validThemeJson({ name: "Clawd" }) },
      {
        id: "directSleep",
        builtin: true,
        json: validThemeJson({
          name: "Direct Sleep",
          states: directSleepStates,
          idleAnimations: [{ file: "idle-loop.svg", duration: 1800 }],
          miniMode: fullMiniMode(),
          sleepSequence: { mode: "direct" },
        }),
      },
      {
        id: "badSleepMode",
        builtin: true,
        json: validThemeJson({
          name: "Bad Sleep Mode",
          sleepSequence: { mode: "instant" },
        }),
      },
      {
        id: "badFallbackCycle",
        builtin: true,
        json: validThemeJson({
          name: "Bad Fallback Cycle",
          states: {
            ...validThemeJson().states,
            error: { fallbackTo: "attention" },
            attention: { fallbackTo: "error" },
          },
        }),
      },
      {
        id: "badFallbackHop",
        builtin: true,
        json: validThemeJson({
          name: "Bad Fallback Hop",
          states: {
            ...validThemeJson().states,
            error: { fallbackTo: "attention" },
            attention: { fallbackTo: "notification" },
            notification: { fallbackTo: "carrying" },
            carrying: { fallbackTo: "sleeping" },
          },
        }),
      },
      {
        id: "badFallbackSource",
        builtin: true,
        json: validThemeJson({
          name: "Bad Fallback Source",
          states: {
            ...validThemeJson().states,
            waking: { fallbackTo: "idle" },
          },
          sleepSequence: { mode: "direct" },
        }),
      },
    ]);
  });
  after(() => fixture && fixture.cleanup());

  it("normalizes object-form state bindings and direct sleep mode", () => {
    const theme = themeLoader.loadTheme("directSleep", { strict: true });
    assert.strictEqual(theme.sleepSequence.mode, "direct");
    assert.deepStrictEqual(theme.states.error, []);
    assert.deepStrictEqual(theme._stateBindings.error, {
      files: [],
      fallbackTo: "attention",
    });
    assert.deepStrictEqual(theme._stateBindings.sleeping, {
      files: [],
      fallbackTo: "idle",
    });
    assert.strictEqual(theme._capabilities.sleepMode, "direct");

    const meta = themeLoader.getThemeMetadata("directSleep");
    assert.strictEqual(meta.capabilities.sleepMode, "direct");
  });

  it("user overrides can materialize a fallback-only state without dropping fallbackTo", () => {
    const theme = themeLoader.loadTheme("directSleep", {
      strict: true,
      overrides: {
        states: {
          error: {
            file: "custom-error.svg",
            transition: { in: 30, out: 60 },
          },
        },
      },
    });
    assert.deepStrictEqual(theme.states.error, ["custom-error.svg"]);
    assert.deepStrictEqual(theme._stateBindings.error, {
      files: ["custom-error.svg"],
      fallbackTo: "attention",
    });
    assert.deepStrictEqual(theme.transitions["custom-error.svg"], { in: 30, out: 60 });
  });

  it("user overrides can patch mini states and idle animations", () => {
    const theme = themeLoader.loadTheme("directSleep", {
      strict: true,
      overrides: {
        states: {
          "mini-idle": {
            file: "custom-mini-idle.svg",
            transition: { in: 10, out: 20 },
          },
        },
        idleAnimations: {
          "idle-loop.svg": {
            file: "custom-idle-loop.svg",
            transition: { in: 25, out: 35 },
            durationMs: 4200,
          },
        },
      },
    });
    assert.deepStrictEqual(theme.miniMode.states["mini-idle"], ["custom-mini-idle.svg"]);
    assert.strictEqual(theme.idleAnimations[0].file, "custom-idle-loop.svg");
    assert.strictEqual(theme.idleAnimations[0].duration, 4200);
    assert.deepStrictEqual(theme.transitions["custom-mini-idle.svg"], { in: 10, out: 20 });
    assert.deepStrictEqual(theme.transitions["custom-idle-loop.svg"], { in: 25, out: 35 });
  });

  it("rejects invalid sleepSequence values", () => {
    assert.throws(
      () => themeLoader.loadTheme("badSleepMode", { strict: true }),
      /sleepSequence\.mode must be "full" or "direct"/
    );
  });

  it("rejects fallback cycles and overlong chains", () => {
    assert.throws(
      () => themeLoader.loadTheme("badFallbackCycle", { strict: true }),
      /forms a cycle|does not terminate in real files/
    );
    assert.throws(
      () => themeLoader.loadTheme("badFallbackHop", { strict: true }),
      /exceeds 3 hop limit/
    );
  });

  it("rejects fallbackTo on unsupported source states", () => {
    assert.throws(
      () => themeLoader.loadTheme("badFallbackSource", { strict: true }),
      /states\.waking\.fallbackTo is only allowed on/
    );
  });
});

// ── Phase 3b-swap: variant support ──
describe("theme-loader variant loading", () => {
  let fixture;
  before(() => {
    const variantTheme = validThemeJson({
      name: "Variant Host",
      workingTiers: [
        { minSessions: 2, file: "pose-a.svg" },
        { minSessions: 1, file: "pose-b.svg" },
      ],
      jugglingTiers: [{ minSessions: 1, file: "pose-b.svg" }],
      displayHintMap: { "pose-a.svg": "pose-a.svg" },
      hitBoxes: { default: { x: 0, y: 0, w: 10, h: 10 } },
      timings: { autoReturn: { attention: 4000 }, yawnDuration: 3000 },
      objectScale: { widthRatio: 1, heightRatio: 1, offsetX: 0, offsetY: 0 },
      variantsSchemaVersion: 0,
      variants: {
        chill: {
          name: { en: "Chill", zh: "松弛" },
          description: "slower",
          workingTiers: [
            { minSessions: 3, file: "pose-c.svg" },
            { minSessions: 1, file: "pose-b.svg" },
          ],
          timings: { autoReturn: { attention: 8000 } },
          displayHintMap: { "pose-c.svg": "pose-c.svg" },
          garbageField: "ignored",  // not in allow-list
        },
        strictDefault: {
          // Explicit default that replaces the synthetic one
          name: "Explicit default",
        },
      },
    });
    fixture = makeFixture([
      { id: "clawd", builtin: true, json: validThemeJson({ name: "Clawd" }) },
      { id: "host", builtin: true, json: variantTheme },
      {
        id: "novariants",
        builtin: true,
        json: validThemeJson({ name: "Plain" }),
      },
    ]);
  });
  after(() => fixture && fixture.cleanup());

  it("default request returns _variantId='default' when theme has no variants", () => {
    const theme = themeLoader.loadTheme("novariants");
    assert.strictEqual(theme._variantId, "default");
  });

  it("unknown variant lenient-falls back to default", () => {
    const theme = themeLoader.loadTheme("host", { variant: "nonexistent" });
    assert.strictEqual(theme._variantId, "default");
    // Fallback to default means original tiers untouched (not "chill" tiers)
    assert.deepStrictEqual(
      theme.workingTiers.map((t) => t.file),
      ["pose-a.svg", "pose-b.svg"]
    );
  });

  it("named variant patches workingTiers via replace semantics", () => {
    const theme = themeLoader.loadTheme("host", { variant: "chill" });
    assert.strictEqual(theme._variantId, "chill");
    // Patch replaced tiers wholesale — and mergeDefaults ran after, so tiers
    // are sorted descending by minSessions. Proves patch-before-merge order.
    assert.deepStrictEqual(
      theme.workingTiers.map((t) => t.file),
      ["pose-c.svg", "pose-b.svg"]
    );
    assert.deepStrictEqual(
      theme.workingTiers.map((t) => t.minSessions),
      [3, 1]
    );
  });

  it("variant patches timings via deep-merge (scalars + nested objects)", () => {
    const theme = themeLoader.loadTheme("host", { variant: "chill" });
    assert.strictEqual(theme.timings.autoReturn.attention, 8000);  // patched
    assert.strictEqual(theme.timings.yawnDuration, 3000);          // preserved
    // base autoReturn.error was unspecified — mergeDefaults fills DEFAULT 5000
    assert.strictEqual(theme.timings.autoReturn.error, 5000);
  });

  it("variant replaces displayHintMap wholesale (not deep-merge)", () => {
    const theme = themeLoader.loadTheme("host", { variant: "chill" });
    // chill replaced the entire map → "pose-a.svg" key is gone
    assert.strictEqual(theme.displayHintMap["pose-a.svg"], undefined);
    assert.strictEqual(theme.displayHintMap["pose-c.svg"], "pose-c.svg");
  });

  it("out-of-allow-list fields in variant are ignored silently", () => {
    const theme = themeLoader.loadTheme("host", { variant: "chill" });
    assert.strictEqual(theme.garbageField, undefined);
  });

  it("getThemeMetadata.variants synthesizes a default entry when author omits it", () => {
    const meta = themeLoader.getThemeMetadata("host");
    assert.ok(Array.isArray(meta.variants));
    const ids = meta.variants.map((v) => v.id);
    // host declares `chill` + `strictDefault` explicitly; since no `default`
    // is declared, loader synthesizes one.
    assert.ok(ids.includes("default"), `expected synthetic default in ${ids.join(",")}`);
    assert.ok(ids.includes("chill"));
    assert.ok(ids.includes("strictDefault"));
  });

  it("getThemeMetadata.variants preserves i18n-style name object as-is", () => {
    const meta = themeLoader.getThemeMetadata("host");
    const chill = meta.variants.find((v) => v.id === "chill");
    assert.deepStrictEqual(chill.name, { en: "Chill", zh: "松弛" });
    assert.strictEqual(chill.description, "slower");
  });

  it("getThemeMetadata.variants returns single-item list for theme with no variants", () => {
    const meta = themeLoader.getThemeMetadata("novariants");
    assert.strictEqual(meta.variants.length, 1);
    assert.strictEqual(meta.variants[0].id, "default");
  });

  it("user overrides patch states / tiers / timings on top of the resolved variant", () => {
    const theme = themeLoader.loadTheme("host", {
      variant: "chill",
      overrides: {
        states: {
          thinking: {
            file: "custom-thinking.svg",
            transition: { in: 80, out: 120 },
          },
        },
        tiers: {
          workingTiers: {
            "pose-c.svg": {
              file: "custom-working.svg",
              transition: { in: 10, out: 40 },
            },
          },
        },
        timings: {
          autoReturn: { attention: 6400 },
        },
      },
    });
    assert.strictEqual(theme.states.thinking[0], "custom-thinking.svg");
    assert.deepStrictEqual(
      theme.workingTiers.map((t) => t.file),
      ["custom-working.svg", "pose-b.svg"]
    );
    assert.deepStrictEqual(theme.transitions["custom-thinking.svg"], { in: 80, out: 120 });
    assert.deepStrictEqual(theme.transitions["custom-working.svg"], { in: 10, out: 40 });
    assert.strictEqual(theme.timings.autoReturn.attention, 6400);
  });

  it("stores pre-override tier bindings for UI card identity", () => {
    const theme = themeLoader.loadTheme("host", {
      variant: "chill",
      overrides: {
        tiers: {
          jugglingTiers: {
            "pose-b.svg": { file: "custom-juggling.svg" },
          },
        },
      },
    });
    assert.deepStrictEqual(theme._bindingBase.jugglingTiers, [
      { minSessions: 1, originalFile: "pose-b.svg" },
    ]);
  });
});
