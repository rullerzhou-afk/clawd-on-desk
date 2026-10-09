"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section: ${start}`);
  return source.slice(from, to);
}

it("wires menu resize and roaming to the shared size preview state", () => {
  const menu = section("const _menuCtx = {", 'const _menu = require("./menu")');
  const roam = section("const _roamCtx = {", 'const _roam = require("./roam")');
  assert.ok(menu.includes("cancelRoam: () => _roam.cancelRoam(),"));
  assert.ok(menu.includes("resetKeepSizeFrozen: () => resetKeepSizeFrozen(),"));
  assert.ok(roam.includes("isSizePreviewActive: () => petWindowRuntime.isSettingsSizePreviewActive(),"));
});

it("cleans up the size preview when the Settings renderer is reset", () => {
  const settings = section(
    "const settingsWindowRuntime = createSettingsWindowRuntime({",
    "  onBeforeClosed: () => {"
  );
  assert.ok(settings.includes(
    "onRendererReset: () => { void settingsSizePreviewSession.cleanup(); },"
  ));
});

it("passes the effective pet size to Settings and notifies after display reflow", () => {
  const ipc = section("const settingsIpcRuntime = registerSettingsIpc({", "sendToRenderer,");
  assert.match(ipc, /getSizeContext: getSizeSliderContext,/);
  const context = section("function getSizeSliderContext() {", "function getCurrentPixelSize(");
  assert.match(context, /getEffectiveCurrentPixelSize\(\)/);
  assert.match(context, /getNearestWorkArea\(x \+ width \/ 2, y \+ height \/ 2\)/);
  assert.match(context, /keepSizeAcrossDisplaysCached && isProportionalMode\(\)/);
  const events = section("const reapplyDisplayGeometryAfterMetricsChange = () => {", "// Read primary display safely");
  assert.match(events, /petWindowRuntime\.handleDisplayMetricsChanged\(\);\s*settingsWindowRuntime\.notifySizeContextChanged\(\);/);
  assert.match(events, /petWindowRuntime\.handleDisplayRemoved\(\);\s*settingsWindowRuntime\.notifySizeContextChanged\(\);/);
  assert.match(events, /petWindowRuntime\.handleDisplayAdded\(\);\s*settingsWindowRuntime\.notifySizeContextChanged\(\);/);
});

it("rebases the size from the current slider context before disabling keep-size", () => {
  const rebase = section("function rebaseSizeToRealizedPixels() {", "function getCurrentPixelSize(");
  assert.match(rebase, /const context = getSizeSliderContext\(\);/);
  assert.match(rebase, /if \(!context \|\| context\.synced\) return;/);
  assert.match(rebase, /_deferredResizePet\(formatSizeKey\(context\.ui\)\);/);
  const injectedDeps = section("injectedDeps: {", "_settingsController.subscribeKey(");
  assert.match(injectedDeps, /rebaseSizeToRealizedPixels:\s*\(\)\s*=>\s*rebaseSizeToRealizedPixels\(\),/);
});
