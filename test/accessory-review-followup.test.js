"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const createPetGeometryMain = require("../src/pet-geometry-main");
const { resolveAccessoryAwareHitBox } = require("../src/pet-accessory-hitbox");
const { createHolidayAccessoryRuntime } = require("../src/holiday-accessory");
const schema = require("../src/theme-schema");
const {
  commitPetAccessoryPayload,
  describeGeometrySync,
  getPetAccessoryPayloadSnapshot,
  resetPetAccessoryStateForTests,
} = require("../src/pet-accessory-state");

const PARTY = {
  id: "party-hat",
  assetFile: "party-hat.svg",
  aspect: 1,
  widthScale: 1,
  offsetY: 0,
};

function accessoryTheme(overrides = {}) {
  return {
    _id: "test-theme",
    _builtin: false,
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states: { idle: ["idle.svg"] },
    customization: {
      accessories: {
        default: {
          staticFrame: { cx: 20, baseY: 40, width: 10 },
          hitBoxPadding: { left: 100, top: 100, right: 100, bottom: 100 },
        },
      },
    },
    ...overrides,
  };
}

test.afterEach(() => resetPetAccessoryStateForTests());

test("maximum-valid external accessory metadata cannot expand native input past rendered bounds", () => {
  const raw = {
    schemaVersion: 1,
    name: "Max external accessory fixture",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    sleepSequence: { mode: "direct" },
    states: {
      idle: ["idle.svg"],
      thinking: ["thinking.svg"],
      working: ["working.svg"],
      sleeping: ["sleeping.svg"],
    },
    customization: {
      accessories: {
        default: {
          // staticFrame keeps the pre-existing broad compatibility range; the
          // new public padding is capped to one effective viewBox per side.
          staticFrame: { cx: 200, baseY: 200, width: 400 },
          hitBoxPadding: { left: 100, top: 100, right: 100, bottom: 100 },
        },
      },
    },
  };
  assert.deepStrictEqual(schema.validateTheme(raw), []);
  const theme = schema.mergeDefaults(raw, "max-external", false);
  const base = { x: 45, y: 45, w: 10, h: 10 };
  const hit = resolveAccessoryAwareHitBox(theme, "idle", "idle.svg", base, PARTY);
  assert.ok(hit.x >= 0 && hit.y >= 0);
  assert.ok(hit.x + hit.w <= 100 && hit.y + hit.h <= 100);
});

test("containment preserves an existing base hitbox outside the viewBox", () => {
  const theme = accessoryTheme();
  const base = { x: -20, y: -10, w: 140, h: 125 };
  const hit = resolveAccessoryAwareHitBox(theme, "idle", "idle.svg", base, PARTY);
  assert.deepStrictEqual(hit, base);
});

test("accessory mirroring follows the facing the renderer reported", () => {
  function resolve(mirrored) {
    const theme = accessoryTheme({
      miniMode: { viewBox: { x: 0, y: 0, width: 100, height: 100 }, flipAssets: false },
      customization: {
        accessories: {
          mini: { staticFrame: { cx: 20, baseY: 40, width: 10 } },
          default: { staticFrame: { cx: 20, baseY: 40, width: 10 } },
        },
      },
    });
    commitPetAccessoryPayload(PARTY, theme);
    const hitGeometry = {
      resolveViewBox: () => theme.miniMode.viewBox,
      getHitRectScreen: (_theme, _bounds, _state, _file, box) => ({
        left: box.x,
        top: box.y,
        right: box.x + box.w,
        bottom: box.y + box.h,
      }),
      getAssetRectScreen: () => null,
      getAssetPointerPayload: () => null,
    };
    const geometry = createPetGeometryMain({
      hitGeometry,
      getActiveTheme: () => theme,
      getCurrentState: () => "mini-idle",
      getCurrentSvg: () => "idle.svg",
      getCurrentHitBox: () => ({ x: 45, y: 45, w: 10, h: 10 }),
      getCurrentAccessoryPayload: () => PARTY,
      getMiniMode: () => true,
      getAccessoryMirrored: () => mirrored,
      getMiniPeekOffset: () => 0,
    });
    return geometry.getHitRectScreen({ x: 0, y: 0, width: 6000, height: 6000 });
  }

  // Geometry no longer predicts the facing from mini edge + theme flags; it
  // consumes what the renderer actually applied. The composition rule itself
  // is covered behaviourally in test/pet-accessory-mirror.test.js.
  const upright = resolve(false);
  const mirrored = resolve(true);

  assert.ok(upright.left < 45 && upright.right === 55);
  assert.ok(mirrored.left === 45 && mirrored.right > 55);
  assert.notDeepStrictEqual(upright, mirrored);
});

test("screen hit rectangles use outward integer rounding", () => {
  const theme = accessoryTheme({ customization: { accessories: null } });
  const geometry = createPetGeometryMain({
    hitGeometry: {
      resolveViewBox: () => theme.viewBox,
      getHitRectScreen: () => ({ left: 1.8, top: 2.2, right: 9.1, bottom: 10.01 }),
      getAssetRectScreen: () => null,
      getAssetPointerPayload: () => null,
    },
    getActiveTheme: () => theme,
    getCurrentState: () => "idle",
    getCurrentSvg: () => "idle.svg",
    getCurrentHitBox: () => ({ x: 1, y: 2, w: 8, h: 8 }),
  });
  assert.deepStrictEqual(
    geometry.getHitRectScreen({ x: 0, y: 0, width: 100, height: 100 }),
    { left: 1, top: 2, right: 10, bottom: 11 }
  );
});

test("geometry consumes the delivered canonical payload instead of re-resolving it", () => {
  const theme = accessoryTheme();
  commitPetAccessoryPayload(PARTY, theme);
  let fallbackResolves = 0;
  const geometry = createPetGeometryMain({
    hitGeometry: {
      resolveViewBox: () => theme.viewBox,
      getHitRectScreen: (_theme, _bounds, _state, _file, box) => ({
        left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.h,
      }),
      getAssetRectScreen: () => null,
      getAssetPointerPayload: () => null,
    },
    getActiveTheme: () => theme,
    getCurrentState: () => "idle",
    getCurrentSvg: () => "idle.svg",
    getCurrentHitBox: () => ({ x: 45, y: 45, w: 10, h: 10 }),
    getCurrentAccessoryPayload: () => {
      fallbackResolves += 1;
      return { ...PARTY, id: "wrong-after-midnight" };
    },
  });
  geometry.getHitRectScreen({ x: 0, y: 0, width: 100, height: 100 });
  assert.strictEqual(fallbackResolves, 0);
  assert.strictEqual(getPetAccessoryPayloadSnapshot(theme).payload.id, "party-hat");
});

test("holiday geometry rejection retries without resending an unchanged renderer payload", () => {
  const theme = { _id: "clawd", _builtin: true, _capabilities: { accessories: true } };
  let sends = 0;
  let applies = 0;
  const runtime = createHolidayAccessoryRuntime({
    getSettingsSnapshot: () => ({
      petAccessory: { clawd: "wizard-hat" },
      holidayAccessoryEnabled: { clawd: true },
    }),
    getActiveTheme: () => theme,
    sendToRenderer: () => { sends += 1; },
    onAccessoryChange: () => {
      applies += 1;
      return applies > 1;
    },
    now: () => new Date(2026, 11, 24, 12, 0, 0),
    logWarn: () => {},
  });

  assert.strictEqual(runtime.refresh(), false);
  assert.strictEqual(sends, 1);
  assert.strictEqual(applies, 1);
  assert.strictEqual(runtime.refresh(), true);
  assert.strictEqual(sends, 1);
  assert.strictEqual(applies, 2);
});

test("a deferred hit-window sync retries silently instead of reporting failure", () => {
  const theme = { _id: "clawd", _builtin: true, _capabilities: { accessories: true } };
  let sends = 0;
  let applies = 0;
  const warnings = [];
  const runtime = createHolidayAccessoryRuntime({
    getSettingsSnapshot: () => ({
      petAccessory: { clawd: "wizard-hat" },
      holidayAccessoryEnabled: { clawd: true },
    }),
    getActiveTheme: () => theme,
    sendToRenderer: () => { sends += 1; },
    // A drag is holding the pointer on the first pass, so the hit window is
    // deliberately left alone; the second pass lands normally.
    onAccessoryChange: () => {
      applies += 1;
      return applies > 1 ? { applied: true, deferred: false } : { applied: false, deferred: true };
    },
    now: () => new Date(2026, 11, 24, 12, 0, 0),
    logWarn: (...args) => warnings.push(args),
  });

  assert.strictEqual(runtime.refresh(), true, "the renderer payload was still delivered");
  assert.strictEqual(sends, 1);
  assert.strictEqual(applies, 1);
  assert.deepStrictEqual(warnings, [], "a deferral is not a failure");

  // lastAppliedKey stayed put, so geometry is retried without resending.
  runtime.refresh();
  assert.strictEqual(sends, 1);
  assert.strictEqual(applies, 2);
  assert.deepStrictEqual(warnings, []);

  // Now settled: no further geometry work for an unchanged accessory.
  runtime.refresh();
  assert.strictEqual(applies, 2);
});

test("describeGeometrySync only calls it a failure when something says so", () => {
  assert.deepStrictEqual(describeGeometrySync({ applied: true, deferred: false }), { applied: true, deferred: false });
  assert.deepStrictEqual(describeGeometrySync({ applied: false, deferred: true }), { applied: false, deferred: true });
  assert.deepStrictEqual(describeGeometrySync(false), { applied: false, deferred: false });
  // Callers and test doubles predating the contract return undefined.
  assert.deepStrictEqual(describeGeometrySync(undefined), { applied: true, deferred: false });
  assert.deepStrictEqual(describeGeometrySync(true), { applied: true, deferred: false });
});
