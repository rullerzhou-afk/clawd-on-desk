"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { it } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing bounded wiring block: ${startMarker}`);
  return source.slice(start, end);
}

function assertBefore(block, first, second) {
  const a = block.indexOf(first);
  const b = block.indexOf(second);
  assert.ok(a >= 0 && b > a, `expected ${first} before ${second}`);
}

it("T13: explicit show ends meeting before the pet visibility write", () => {
  const block = between("function setPetVisibility(visible)", "function bringPetToPrimaryDisplay()");
  assert.ok(block.includes('if (visible) meetingMode.noteUserOverride("pet-shown");'));
  assertBefore(block, 'meetingMode.noteUserOverride("pet-shown")', "petWindowRuntime.setPetHidden(!visible)");
});

it("T14: toggle unconditionally applies user show after ending meeting", () => {
  const block = between("function togglePetVisibility()", "function setPetVisibility(visible)");
  const match = block.match(/if \(meetingMode\.noteUserOverride\("pet-shown"\)\) \{([\s\S]*?)\n  \}/);
  assert.ok(match, "missing meeting override branch");
  const branch = match[1];
  assert.equal(branch.trim(), "return petWindowRuntime.setPetHidden(false);");
  assert.ok(!branch.includes("isPetHidden()"), "user show must also clear the fullscreen layer");
  assertBefore(block, "petWindowRuntime.setPetHidden(false)", "petWindowRuntime.togglePetVisibility()");
});

it("T15: Wake ends meeting before disabling DND through the raw wrapper", () => {
  const block = between("function disableDoNotDisturb()", "\n}");
  assertBefore(block, 'meetingMode.noteUserOverride("wake")', "disableDoNotDisturbAndObserveQuota()");
});

it("T16: resume and unlock-screen each check meeting expiry", () => {
  for (const event of ["resume", "unlock-screen"]) {
    const handlers = source.split("\n").filter((line) => line.includes(`powerMonitor.on("${event}",`));
    assert.equal(handlers.filter((line) => line.includes("() => meetingMode.checkExpiry()")).length, 1, event);
  }
});

it("T17: second-instance hidden branch ends meeting before prep and show", () => {
  const block = between('app.on("second-instance",', "    } else {");
  assert.ok(block.includes("if (petWindowRuntime.isPetEffectivelyHidden()) {"));
  assertBefore(block, 'meetingMode.noteUserOverride("pet-shown")', "prepManualPetVisibility()");
  assertBefore(block, 'meetingMode.noteUserOverride("pet-shown")', "petWindowRuntime.setPetHidden(false)");
});

it("T18: bring to primary ends meeting only for an effective show outside mini transitions", () => {
  const block = between("function bringPetToPrimaryDisplay()", "function sendRawToRenderer(");
  assert.match(block, /if \(petWindowRuntime\.isPetEffectivelyHidden\(\) && !_mini\.getMiniMode\(\) && !_mini\.getMiniTransitioning\(\)\) \{\s*meetingMode\.noteUserOverride\("pet-shown"\);\s*\}/);
  assertBefore(block, 'meetingMode.noteUserOverride("pet-shown")', "petWindowRuntime.bringPetToPrimaryDisplay()");
});

it("T19: mac-hide passes a beforeManualShow callback that ends meeting", () => {
  const block = between("macHideController = createMacHideController({", "      });");
  assert.ok(block.includes('beforeManualShow: () => meetingMode.noteUserOverride("pet-shown"),'));
});

it("T20: menu start releases OS hide ownership before starting without unhiding the app", () => {
  const block = between("  startMeetingMode: (minutes) =>", "  endMeetingMode:");
  assert.ok(block.includes("if (macHideController) macHideController.noteManualChange();"));
  assertBefore(block, "macHideController.noteManualChange()", "meetingMode.start(minutes)");
  assert.ok(!block.includes("prepManualPetVisibility()"));
});

it("T21: controller restore preserves fullscreen auto-hide and busy reads mini transitioning", () => {
  const controller = between("const meetingMode = createMeetingModeController({", "\n});");
  const show = controller.slice(controller.indexOf("  showPet: () => {"), controller.indexOf("  isPetHidden:"));
  assert.ok(show.includes("petWindowRuntime.setPetHidden(false, { keepFullscreenAutoHide: true });"));
  assert.ok(controller.includes("isBusy: () => _mini.getMiniTransitioning(),"));
});

it("T22: mini context reads meeting activity and delegates DND sleep to state", () => {
  const block = between("const _miniCtx = {", 'const _mini = require("./mini")(_miniCtx);');
  assert.ok(block.includes("isMeetingModeActive: () => meetingMode.isActive(),"));
  assert.ok(block.includes("applyDndSleepState: () => _state.applyDndSleepState(),"));
});
