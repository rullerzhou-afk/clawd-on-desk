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
    });

    runtime.repositionFloatingBubbles();
    pending.push({ bubble: {} });
    runtime.repositionFloatingBubbles();

    assert.deepStrictEqual(calls, ["update", "permission", "update"]);
  });

  it("keeps anchored surface ordering as HUD, usage hover, then permission/update bubbles", () => {
    const calls = [];
    const runtime = createFloatingWindowRuntime({
      getPendingPermissions: () => [{ bubble: {} }],
      repositionSessionHud: () => calls.push("hud"),
      repositionUsageHover: () => calls.push("usageHover"),
      repositionPermissionBubbles: () => calls.push("permission"),
      repositionUpdateBubble: () => calls.push("update"),
    });

    runtime.repositionAnchoredSurfaces();

    assert.deepStrictEqual(calls, ["hud", "usageHover", "permission", "update"]);
  });

  it("syncs HUD and usage hover visibility before repositioning dependent bubbles", () => {
    const calls = [];
    const runtime = createFloatingWindowRuntime({
      getPendingPermissions: () => [{ bubble: {} }],
      syncSessionHudVisibility: () => calls.push("syncHud"),
      syncUsageHoverVisibility: () => calls.push("syncUsageHover"),
      repositionPermissionBubbles: () => calls.push("permission"),
      repositionUpdateBubble: () => calls.push("update"),
    });

    runtime.syncSessionHudVisibilityAndBubbles();

    assert.deepStrictEqual(calls, ["syncHud", "syncUsageHover", "permission", "update"]);
  });

  it("restores live permission bubbles and update bubble visibility when the pet is shown", () => {
    const calls = [];
    const live = makeWindow("live", calls);
    const destroyed = makeWindow("destroyed", calls, true);
    const runtime = createFloatingWindowRuntime({
      getPendingPermissions: () => [{ bubble: live }, { bubble: destroyed }, { bubble: null }],
      keepOutOfTaskbar: (win) => calls.push(["taskbar", win === live ? "live" : "other"]),
      syncUpdateBubbleVisibility: () => calls.push(["syncUpdate"]),
      syncUsageHoverVisibility: () => calls.push(["syncUsageHover"]),
    });

    runtime.showFloatingSurfacesForPet();

    assert.deepStrictEqual(calls, [
      ["show", "live"],
      ["taskbar", "live"],
      ["syncUsageHover"],
      ["syncUpdate"],
    ]);
  });

  it("hides live permission bubbles and the update bubble when the pet is hidden", () => {
    const calls = [];
    const live = makeWindow("live", calls);
    const destroyed = makeWindow("destroyed", calls, true);
    const runtime = createFloatingWindowRuntime({
      getPendingPermissions: () => [{ bubble: live }, { bubble: destroyed }, { bubble: null }],
      hideUpdateBubble: () => calls.push(["hideUpdate"]),
      hideUsageHover: () => calls.push(["hideUsageHover"]),
    });

    runtime.hideFloatingSurfacesForPet();

    assert.deepStrictEqual(calls, [
      ["hide", "live"],
      ["hideUsageHover"],
      ["hideUpdate"],
    ]);
  });
});
