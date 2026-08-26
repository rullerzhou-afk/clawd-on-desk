"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const createFloatingWindowRuntime = require("../src/floating-window-runtime");

const SRC_DIR = path.join(__dirname, "..", "src");

function makeWindow(label, calls, destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    showInactive: () => calls.push(["show", label]),
    hide: () => calls.push(["hide", label]),
  };
}

describe("floating-window-runtime", () => {
  it("keeps floating bubble coordination out of main", () => {
    const mainSource = fs.readFileSync(path.join(SRC_DIR, "main.js"), "utf8");

    assert.match(mainSource, /createFloatingWindowRuntime/);
    assert.ok(!mainSource.includes("if (pendingPermissions.length) repositionBubbles();"));
  });

  it("repositions permission bubbles only when pending entries exist and always repositions update bubble", () => {
    const calls = [];
    const pending = [];
    const runtime = createFloatingWindowRuntime({
      getPendingPermissions: () => pending,
      repositionPermissionBubbles: () => calls.push("permission"),
      repositionUpdateBubble: () => calls.push("update"),
      repositionQuotaRing: () => calls.push("ring"),
    });

    runtime.repositionFloatingBubbles();
    pending.push({ bubble: {} });
    runtime.repositionFloatingBubbles();

    assert.deepStrictEqual(calls, ["update", "ring", "permission", "update", "ring"]);
  });

  it("keeps anchored surface ordering as HUD first, then permission/update bubbles", () => {
    const calls = [];
    const runtime = createFloatingWindowRuntime({
      getPendingPermissions: () => [{ bubble: {} }],
      repositionSessionHud: () => calls.push("hud"),
      repositionPermissionBubbles: () => calls.push("permission"),
      repositionUpdateBubble: () => calls.push("update"),
      repositionQuotaRing: () => calls.push("ring"),
    });

    runtime.repositionAnchoredSurfaces();

    assert.deepStrictEqual(calls, ["hud", "permission", "update", "ring"]);
  });

  it("syncs Session HUD visibility before repositioning dependent bubbles", () => {
    const calls = [];
    const runtime = createFloatingWindowRuntime({
      getPendingPermissions: () => [{ bubble: {} }],
      syncSessionHudVisibility: () => calls.push("syncHud"),
      repositionPermissionBubbles: () => calls.push("permission"),
      repositionUpdateBubble: () => calls.push("update"),
      repositionQuotaRing: () => calls.push("ring"),
    });

    runtime.syncSessionHudVisibilityAndBubbles();

    assert.deepStrictEqual(calls, ["syncHud", "permission", "update", "ring"]);
  });

  it("restores live permission bubbles and update bubble visibility when the pet is shown", () => {
    const calls = [];
    const live = makeWindow("live", calls);
    const destroyed = makeWindow("destroyed", calls, true);
    const runtime = createFloatingWindowRuntime({
      getPendingPermissions: () => [{ bubble: live }, { bubble: destroyed }, { bubble: null }],
      keepOutOfTaskbar: (win) => calls.push(["taskbar", win === live ? "live" : "other"]),
      syncUpdateBubbleVisibility: (hidden) => calls.push(["syncUpdate", hidden]),
    });

    runtime.showFloatingSurfacesForPet();

    assert.deepStrictEqual(calls, [
      ["show", "live"],
      ["taskbar", "live"],
      ["syncUpdate", false],
    ]);
  });

  it("hides live permission bubbles and the update bubble when the pet is hidden", () => {
    const calls = [];
    const live = makeWindow("live", calls);
    const destroyed = makeWindow("destroyed", calls, true);
    const runtime = createFloatingWindowRuntime({
      getPendingPermissions: () => [{ bubble: live }, { bubble: destroyed }, { bubble: null }],
      hideUpdateBubble: () => calls.push(["hideUpdate"]),
    });

    runtime.hideFloatingSurfacesForPet();

    assert.deepStrictEqual(calls, [
      ["hide", "live"],
      ["hideUpdate"],
    ]);
  });

  it("delegates pet hide/show to the permission presentation owner when provided", () => {
    const calls = [];
    const live = makeWindow("legacy", calls);
    const runtime = createFloatingWindowRuntime({
      getPendingPermissions: () => [{ bubble: live }],
      showPermissionSurfacesForPet: () => calls.push(["permission", "show"]),
      hidePermissionSurfacesForPet: () => calls.push(["permission", "hide"]),
      syncUpdateBubbleVisibility: (hidden) => calls.push(["syncUpdate", hidden]),
      hideUpdateBubble: () => calls.push(["hideUpdate"]),
    });

    runtime.hideFloatingSurfacesForPet();
    runtime.showFloatingSurfacesForPet();

    assert.deepStrictEqual(calls, [
      ["permission", "hide"],
      ["hideUpdate"],
      ["permission", "show"],
      ["syncUpdate", false],
    ]);
  });
});
