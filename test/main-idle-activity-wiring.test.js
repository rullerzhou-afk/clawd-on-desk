"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { it } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8").replace(/\r\n/g, "\n");

it("wires tick to the idle activity controller", () => {
  const start = source.indexOf("const _tickCtx = {");
  const end = source.indexOf('const _tick = require("./tick")', start);
  assert.ok(start >= 0 && end > start, "missing tick context");
  assert.ok(source.slice(start, end).includes(
    "get idleActivity() { return _idleActivity; }"
  ));
});

const idleActivityStart = source.indexOf('const _idleActivity = require("./idle-activity")');
const idleActivityEnd = source.indexOf("// Convenience getters for mini state", idleActivityStart);
assert.ok(idleActivityStart >= 0 && idleActivityEnd > idleActivityStart, "missing idle activity initialization");
const idleActivitySource = source.slice(idleActivityStart, idleActivityEnd);

for (const [key, setter, argument] of [
  ["idleActivities", "setEnabled", '_settingsController.get("idleActivities") === true'],
  ["idleActivityFrequency", "setFrequency", '_settingsController.get("idleActivityFrequency")'],
]) {
  it(`initializes idle activities from the stored ${key} preference`, () => {
    assert.ok(idleActivitySource.includes(`_idleActivity.${setter}(${argument});`));
  });
}

for (const [key, call] of [
  ["idleActivities", "setEnabled(value === true)"],
  ["idleActivityFrequency", "setFrequency(value)"],
]) {
  it(`subscribes the idle activity controller to ${key} changes`, () => {
    assert.ok(idleActivitySource.includes(
      `_settingsController.subscribeKey("${key}", (value) => {\n    _idleActivity.${call};\n  });`
    ));
  });
}

it("wires roam to the idle activity's current visual ownership", () => {
  const start = source.indexOf("const _roamCtx = {");
  const end = source.indexOf('const _roam = require("./roam")', start);
  assert.ok(start >= 0 && end > start, "missing roam context");
  assert.ok(source.slice(start, end).includes(
    "isIdleActivityPlaying: () => _idleActivity.isAnimating(),"
  ));
});

it("wires idle activities to tick restoration, generation ownership and eligibility", () => {
  const start = source.indexOf('const _idleActivity = require("./idle-activity")');
  const end = source.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start, "missing idle activity controller");
  const controller = source.slice(start, end);
  assert.ok(controller.includes("restoreIdleVisual: () => _tick.restoreIdleVisual(),"));
  assert.match(controller, /\n\s+isVisualGenerationCurrent,/);
  assert.ok(controller.includes("canPlay: canPlayIdleActivity,"));
  assert.ok(controller.includes("getCurrentState: () => _state.getCurrentState(),"));
  assert.match(controller, /\n\s+sendToRenderer,/);
});

const gateStart = source.indexOf("function canPlayIdleActivity() {");
const gateEnd = source.indexOf('\nconst _idleActivity = require("./idle-activity")', gateStart);
assert.ok(gateStart >= 0 && gateEnd > gateStart, "missing idle activity gate");
const gateSource = source.slice(gateStart, gateEnd);

function gateHarness() {
  const ctx = {
    win: { isDestroyed: () => false, isVisible: () => true },
    doNotDisturb: false,
    lowPowerIdlePaused: false,
    idlePaused: false,
    menuOpen: false,
    petWindowRuntime: {
      isDragLocked: () => false,
      isSettingsSizePreviewActive: () => false,
      isPetEffectivelyHidden: () => false,
    },
    _mini: { getMiniMode: () => false, getMiniTransitioning: () => false },
    anySessionInProgress: () => false,
    _perm: { hasVisiblePermissionBubbles: () => false },
    _state: { isSettingsPreviewVisual: () => false },
    pendingPermissions: [],
    getActiveTheme: () => ({ timings: { mouseSleepTimeout: 60000 } }),
    _tick: { _mouseStillSince: 1000 },
    Date: { now: () => 1000 },
  };
  const canPlay = vm.runInNewContext(`${gateSource}\ncanPlayIdleActivity;`, ctx);
  return { ctx, canPlay };
}

for (const [name, block] of [
  ["missing window", (c) => { c.win = null; }],
  ["destroyed window", (c) => { c.win.isDestroyed = () => true; }],
  ...["doNotDisturb", "lowPowerIdlePaused", "idlePaused", "menuOpen"].map(
    (key) => [key, (c) => { c[key] = true; }]
  ),
  ...["isDragLocked", "isSettingsSizePreviewActive", "isPetEffectivelyHidden"].map(
    (key) => [key, (c) => { c.petWindowRuntime[key] = () => true; }]
  ),
  ...["getMiniMode", "getMiniTransitioning"].map(
    (key) => [key, (c) => { c._mini[key] = () => true; }]
  ),
  ["active session", (c) => { c.anySessionInProgress = () => true; }],
  ["permission bubble", (c) => { c._perm.hasVisiblePermissionBubbles = () => true; }],
  ["invisible window", (c) => { c.win.isVisible = () => false; }],
  ["settings visual preview", (c) => { c._state.isSettingsPreviewVisual = () => true; }],
  ["IME editing", (c) => {
    c.pendingPermissions = [{ bubble: {
      isDestroyed: () => false,
      isVisible: () => true,
      __clawdMacImeEditing: true,
    } }];
  }],
  ["sleep deadline", (c) => { c.Date.now = () => 61000; }],
]) {
  it(`idle activity eligibility holds for ${name}`, () => {
    const { ctx, canPlay } = gateHarness();
    assert.equal(canPlay(), true);
    block(ctx);
    assert.equal(canPlay(), false);
  });
}
