"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  getLaunchPixelSize,
  getLaunchSizingWorkArea,
  getProportionalBasePx,
  getProportionalPixelSize,
  getSavedPixelSize,
  resolveSizeSliderContext,
} = require("../src/size-utils");
const { uiSizeToPrefs, prefsSizeToUi, clampSizeUi } = require("../src/settings-size-slider");

describe("size utils", () => {
  it("uses the saved slider value when keep size is off or proportional pixels are already synchronized", () => {
    const workArea = { width: 1710, height: 991 };
    const actual = getProportionalPixelSize(10.4, workArea);
    const expectedUi = clampSizeUi(prefsSizeToUi(10.4));
    assert.deepStrictEqual(resolveSizeSliderContext("P:10.4", actual, workArea, false),
      { ui: expectedUi, overMax: false, synced: true });
    assert.deepStrictEqual(resolveSizeSliderContext("P:10.4", actual, workArea, true),
      { ui: expectedUi, overMax: false, synced: true });
    assert.notStrictEqual(getProportionalPixelSize(uiSizeToPrefs(expectedUi), workArea).width, actual.width);
  });

  it("uses the saved tick with keep size off even when effective pixels differ", () => {
    assert.deepStrictEqual(resolveSizeSliderContext("P:10.5", { width: 361, height: 361 },
      { width: 1710, height: 991 }, false), { ui: 35, overMax: false, synced: true });
  });

  it("places a frozen 361 pixel pet at the nearest current-display slider tick", () => {
    assert.deepStrictEqual(resolveSizeSliderContext("P:10.5", { width: 361, height: 361 },
      { width: 1710, height: 991 }, true), { ui: 70, overMax: false, synced: false });
  });

  it("marks a frozen pet above the slider limit", () => {
    assert.deepStrictEqual(resolveSizeSliderContext("P:10.5", { width: 722, height: 722 },
      { width: 1710, height: 991 }, true), { ui: 100, overMax: true, synced: false });
  });

  it("marks only pixel widths above the maximum tick as over limit", () => {
    const workArea = { width: 1710, height: 991 };
    const maximum = getProportionalPixelSize(uiSizeToPrefs(100), workArea).width;
    assert.deepStrictEqual(resolveSizeSliderContext("P:10.5", { width: maximum, height: maximum },
      workArea, true), { ui: 100, overMax: false, synced: false });
    assert.deepStrictEqual(resolveSizeSliderContext("P:10.5", { width: maximum + 1, height: maximum + 1 },
      workArea, true), { ui: 100, overMax: true, synced: false });
  });

  it("chooses the lower tick when two ticks are equally close in pixels", () => {
    const workArea = { width: 1710, height: 991 };
    let tied = null;
    for (let ui = 1; ui < 100; ui++) {
      const lower = getProportionalPixelSize(uiSizeToPrefs(ui), workArea).width;
      const upper = getProportionalPixelSize(uiSizeToPrefs(ui + 1), workArea).width;
      if (upper > lower && (upper - lower) % 2 === 0) {
        tied = { ui, midpoint: (lower + upper) / 2 };
        break;
      }
    }
    assert.ok(tied, "the work area must contain an even pixel gap between adjacent ticks");
    assert.deepStrictEqual(resolveSizeSliderContext("P:10.5",
      { width: tied.midpoint, height: tied.midpoint }, workArea, true),
    { ui: tied.ui, overMax: false, synced: false });
  });

  it("finds portrait ticks using the boosted and capped pixel sizing path", () => {
    const workArea = { width: 1080, height: 1920 };
    const actual = getProportionalPixelSize(uiSizeToPrefs(55), workArea);
    assert.deepStrictEqual(resolveSizeSliderContext("P:9", actual, workArea, true),
      { ui: 55, overMax: false, synced: false });
  });

  it("falls back without throwing for malformed size inputs", () => {
    const workArea = { width: 1710, height: 991 };
    const actual = { width: 361, height: 361 };
    assert.deepStrictEqual(resolveSizeSliderContext("invalid", actual, workArea, true),
      { ui: 30, overMax: false, synced: true });
    assert.deepStrictEqual(resolveSizeSliderContext("P:10.5", null, workArea, true),
      { ui: 35, overMax: false, synced: true });
    assert.deepStrictEqual(resolveSizeSliderContext("P:10.5", actual, { width: 0, height: 991 }, true),
      { ui: 35, overMax: false, synced: true });
  });
  it("uses display width on landscape screens", () => {
    assert.strictEqual(getProportionalBasePx({ width: 2560, height: 1440 }), 2560);
    assert.deepStrictEqual(
      getProportionalPixelSize(10, { width: 2560, height: 1440 }),
      { width: 256, height: 256 },
    );
  });

  it("uses display height on portrait screens before boost", () => {
    assert.strictEqual(getProportionalBasePx({ width: 1440, height: 2560 }), 2560);
  });

  it("boosts portrait screens so the pet stays readable", () => {
    assert.deepStrictEqual(
      getProportionalPixelSize(10, { width: 1080, height: 1920 }),
      { width: 307, height: 307 },
    );
    assert.deepStrictEqual(
      getProportionalPixelSize(15, { width: 834, height: 1194 }),
      { width: 286, height: 286 },
    );
  });

  it("caps portrait growth before it gets absurdly wide", () => {
    assert.deepStrictEqual(
      getProportionalPixelSize(50, { width: 834, height: 1194 }),
      { width: 500, height: 500 },
    );
  });

  it("picks the saved display before the first window size is computed", () => {
    const calls = [];
    const portrait = { x: 2560, y: 123, width: 834, height: 1194 };
    const fallback = { x: 0, y: 0, width: 2560, height: 1410 };
    const picked = getLaunchSizingWorkArea(
      { positionSaved: true, x: 2820, y: 760, miniMode: false },
      fallback,
      (x, y) => {
        calls.push([x, y]);
        return portrait;
      },
    );
    assert.deepStrictEqual(calls, [[2821, 761]]);
    assert.deepStrictEqual(picked, portrait);
    assert.deepStrictEqual(getProportionalPixelSize(15, picked), { width: 286, height: 286 });
  });

  it("restores the last realized pixel size when keep-size-across-displays is enabled", () => {
    assert.deepStrictEqual(
      getSavedPixelSize({ savedPixelWidth: 286, savedPixelHeight: 286 }),
      { width: 286, height: 286 },
    );
    assert.deepStrictEqual(
      getLaunchPixelSize(
        { keepSizeAcrossDisplays: true, size: "P:15", savedPixelWidth: 286, savedPixelHeight: 286 },
        { width: 500, height: 500 },
      ),
      { width: 286, height: 286 },
    );
  });

  it("falls back to proportional launch sizing when no saved pixel size should apply", () => {
    const fallback = { width: 500, height: 500 };
    assert.strictEqual(
      getLaunchPixelSize(
        { keepSizeAcrossDisplays: false, size: "P:15", savedPixelWidth: 286, savedPixelHeight: 286 },
        fallback,
      ),
      fallback,
    );
    assert.strictEqual(
      getLaunchPixelSize(
        { keepSizeAcrossDisplays: true, size: "P:15", savedPixelWidth: 0, savedPixelHeight: 286 },
        fallback,
      ),
      fallback,
    );
  });

  it("clamps a saved keep-size bigger than its ORIGIN display back to proportional (#408)", () => {
    const fallback = { width: 384, height: 384 };
    // Corrupted: saved is taller than the display it was realized on
    // (savedPixelWorkArea snapshot) — DPI round-trip growth, not a slider value.
    assert.strictEqual(
      getLaunchPixelSize(
        {
          keepSizeAcrossDisplays: true, size: "P:10",
          savedPixelWidth: 2000, savedPixelHeight: 2000,
          savedPixelWorkArea: { width: 1920, height: 1080 },
        },
        fallback,
      ),
      fallback,
    );
    // Legit cross-display: a size set on a 4K display is kept even though it
    // exceeds a smaller launch display — that's the whole point of keep-size.
    assert.deepStrictEqual(
      getLaunchPixelSize(
        {
          keepSizeAcrossDisplays: true, size: "P:10",
          savedPixelWidth: 1152, savedPixelHeight: 1152,
          savedPixelWorkArea: { width: 3840, height: 2160 },
        },
        fallback,
      ),
      { width: 1152, height: 1152 },
    );
    // No origin snapshot → skip the clamp rather than risk healing a valid size.
    assert.deepStrictEqual(
      getLaunchPixelSize(
        { keepSizeAcrossDisplays: true, size: "P:10", savedPixelWidth: 2000, savedPixelHeight: 2000 },
        fallback,
      ),
      { width: 2000, height: 2000 },
    );
  });

  it("does not mis-clamp when positionDisplay diverges from frozen origin after a Send-to-Display (#408 round-2)", () => {
    const fallback = { width: 384, height: 384 };
    // Scenario: pet frozen at 1152 on a 4K display, then "Send to display"
    // moves it onto a 1080p screen. flushRuntimeStateToPrefs writes the
    // frozen 1152 into savedPixelWidth/Height AND captures positionDisplay
    // off the new (smaller) display. Without the dedicated savedPixelWorkArea
    // field we'd compare 1152 against 1080 and wrongly self-heal a valid size.
    assert.deepStrictEqual(
      getLaunchPixelSize(
        {
          keepSizeAcrossDisplays: true, size: "P:10",
          savedPixelWidth: 1152, savedPixelHeight: 1152,
          savedPixelWorkArea: { width: 3840, height: 2160 }, // true frozen origin
          positionDisplay: { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }, // last-flush
        },
        fallback,
      ),
      { width: 1152, height: 1152 },
    );
  });

  it("falls back to positionDisplay for legacy prefs without savedPixelWorkArea (#408 round-2)", () => {
    const fallback = { width: 384, height: 384 };
    // Pre-fix prefs only carried positionDisplay; honour it so existing users
    // still get the corruption clamp until the next flush rewrites the new
    // field. Both directions (clamp + keep) work via the legacy fallback.
    assert.strictEqual(
      getLaunchPixelSize(
        {
          keepSizeAcrossDisplays: true, size: "P:10",
          savedPixelWidth: 2000, savedPixelHeight: 2000,
          positionDisplay: { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
        },
        fallback,
      ),
      fallback,
    );
    assert.deepStrictEqual(
      getLaunchPixelSize(
        {
          keepSizeAcrossDisplays: true, size: "P:10",
          savedPixelWidth: 1152, savedPixelHeight: 1152,
          positionDisplay: { workArea: { x: 0, y: 0, width: 3840, height: 2160 } },
        },
        fallback,
      ),
      { width: 1152, height: 1152 },
    );
  });
});
