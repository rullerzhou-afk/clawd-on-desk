"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");

const { createMacDockVisibilityCoordinator } = require("../src/mac-dock-visibility");

describe("macOS Dock visibility coordinator", () => {
  it("shows Dock synchronously through activation policy without DockShow", async () => {
    const calls = [];
    const coordinator = createMacDockVisibilityCoordinator({
      dockIconPath: "/app/assets/dock-icon.png",
      app: {
        setActivationPolicy: (policy) => calls.push(["policy", policy]),
      },
      dock: {
        setIcon: (icon) => calls.push(["setIcon", icon]),
        show: () => calls.push(["show"]),
        hide: () => calls.push(["hide"]),
      },
      reapplyMacVisibility: () => calls.push(["reapply"]),
    });

    await coordinator.apply(true);

    assert.deepStrictEqual(calls, [
      ["setIcon", "/app/assets/dock-icon.png"],
      ["policy", "regular"],
      ["setIcon", "/app/assets/dock-icon.png"],
      ["reapply"],
    ]);
  });

  it("promotes Dock without runtime icon writes when the shared policy disables them", async () => {
    const calls = [];
    const coordinator = createMacDockVisibilityCoordinator({
      dockIconPath: "/app/assets/dock-icon.png",
      shouldInstallDockIcon: () => false,
      app: {
        setActivationPolicy: (policy) => calls.push(["policy", policy]),
      },
      dock: {
        setIcon: (icon) => calls.push(["setIcon", icon]),
      },
      reapplyMacVisibility: () => calls.push(["reapply"]),
    });

    await coordinator.apply(true);

    assert.deepStrictEqual(calls, [
      ["policy", "regular"],
      ["reapply"],
    ]);
  });

  it("contains an icon-policy callback failure without blocking Dock promotion", async () => {
    const calls = [];
    const warnings = [];
    const coordinator = createMacDockVisibilityCoordinator({
      dockIconPath: "/app/assets/dock-icon.png",
      shouldInstallDockIcon: () => { throw new Error("version failure"); },
      app: {
        setActivationPolicy: (policy) => calls.push(["policy", policy]),
      },
      dock: {
        setIcon: (icon) => calls.push(["setIcon", icon]),
      },
      reapplyMacVisibility: () => calls.push(["reapply"]),
      logWarn: (...args) => warnings.push(args),
    });

    await coordinator.apply(true);

    assert.deepStrictEqual(calls, [
      ["policy", "regular"],
      ["reapply"],
    ]);
    assert.deepStrictEqual(warnings, [[
      "Clawd: failed to resolve macOS Dock icon policy:",
      "version failure",
    ]]);
  });

  it("hides Dock immediately through accessory policy without DockHide", async () => {
    const calls = [];
    const coordinator = createMacDockVisibilityCoordinator({
      dockIconPath: "/app/assets/dock-icon.png",
      app: {
        setActivationPolicy: (policy) => calls.push(["policy", policy]),
      },
      dock: {
        setIcon: () => calls.push(["setIcon"]),
        show: () => calls.push(["show"]),
        hide: () => calls.push(["hide"]),
      },
      reapplyMacVisibility: () => calls.push(["reapply"]),
    });

    await coordinator.apply(false);

    assert.deepStrictEqual(calls, [
      ["policy", "accessory"],
      ["reapply"],
    ]);
  });

  it("preserves a focused Settings window while switching to accessory policy", async () => {
    const calls = [];
    const settingsWindow = {
      isDestroyed: () => false,
      isVisible: () => true,
      isFocused: () => true,
      focus: () => calls.push(["settingsFocus"]),
    };
    const coordinator = createMacDockVisibilityCoordinator({
      app: {
        setActivationPolicy: (policy) => calls.push(["policy", policy]),
        focus: (options) => calls.push(["appFocus", options]),
      },
      getSettingsWindow: () => settingsWindow,
      reapplyMacVisibility: () => calls.push(["reapply"]),
    });

    await coordinator.apply(false);

    assert.deepStrictEqual(calls, [
      ["policy", "accessory"],
      ["appFocus", { steal: true }],
      ["settingsFocus"],
      ["reapply"],
    ]);
  });

  it("does not steal focus when Settings was not focused", async () => {
    const calls = [];
    const coordinator = createMacDockVisibilityCoordinator({
      app: {
        setActivationPolicy: (policy) => calls.push(["policy", policy]),
        focus: () => calls.push(["appFocus"]),
      },
      getSettingsWindow: () => ({
        isDestroyed: () => false,
        isVisible: () => true,
        isFocused: () => false,
        focus: () => calls.push(["settingsFocus"]),
      }),
      reapplyMacVisibility: () => calls.push(["reapply"]),
    });

    await coordinator.apply(false);

    assert.deepStrictEqual(calls, [
      ["policy", "accessory"],
      ["reapply"],
    ]);
  });

  it("collapses a same-turn show-hide-show burst to the final visible state", async () => {
    const calls = [];
    const coordinator = createMacDockVisibilityCoordinator({
      dockIconPath: "/dock.png",
      app: {
        setActivationPolicy: (policy) => calls.push(policy),
      },
      dock: {
        setIcon: () => calls.push("icon"),
      },
      reapplyMacVisibility: () => calls.push("reapply"),
    });

    const first = coordinator.apply(true);
    coordinator.apply(false);
    coordinator.apply(true);
    await first;

    assert.deepStrictEqual(calls, ["icon", "regular", "icon", "reapply"]);
  });

  it("applies separate user transitions immediately in order", async () => {
    const calls = [];
    const coordinator = createMacDockVisibilityCoordinator({
      dockIconPath: "/dock.png",
      app: {
        setActivationPolicy: (policy) => calls.push(policy),
      },
      dock: {
        setIcon: () => {},
      },
      reapplyMacVisibility: () => {},
    });

    await coordinator.apply(true);
    await coordinator.apply(false);

    assert.deepStrictEqual(calls, ["regular", "accessory"]);
  });

  it("contains an activation-policy failure and reports it", async () => {
    const warnings = [];
    const coordinator = createMacDockVisibilityCoordinator({
      app: {
        setActivationPolicy: () => { throw new Error("native failure"); },
      },
      logWarn: (...args) => warnings.push(args),
    });

    await coordinator.apply(false);

    assert.strictEqual(warnings.length, 1);
    assert.deepStrictEqual(warnings[0], [
      "Clawd: macOS Dock transition failed:",
      "native failure",
    ]);
  });
});
