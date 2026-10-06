"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  installStartupDockIcon,
  parseMacOSMajorVersion,
  resolveRuntimeDockIconPolicy,
  shouldInstallRuntimeDockIcon,
} = require("../src/mac-dock-icon-runtime");

describe("macOS runtime Dock icon policy", () => {
  it("parses numeric macOS major versions without string ordering", () => {
    assert.strictEqual(parseMacOSMajorVersion("26"), 26);
    assert.strictEqual(parseMacOSMajorVersion("26.0"), 26);
    assert.strictEqual(parseMacOSMajorVersion(" 26.5.2 "), 26);
    assert.strictEqual(parseMacOSMajorVersion("100.1"), 100);
    for (const value of ["", "Tahoe", "26beta", ".26", "26.", null, undefined]) {
      assert.strictEqual(parseMacOSMajorVersion(value), null, String(value));
    }
  });

  it("leaves packaged Tahoe and later bundle icons to macOS", () => {
    for (const systemVersion of ["26", "26.0", "26.5.2", "27.0"]) {
      assert.strictEqual(shouldInstallRuntimeDockIcon({
        platform: "darwin",
        isPackaged: true,
        systemVersion,
      }), false, systemVersion);
    }
  });

  it("retains the padded runtime icon on older macOS and in development", () => {
    assert.strictEqual(shouldInstallRuntimeDockIcon({
      platform: "darwin",
      isPackaged: true,
      systemVersion: "25.9",
    }), true);
    assert.strictEqual(shouldInstallRuntimeDockIcon({
      platform: "darwin",
      isPackaged: false,
      systemVersion: "26.5.2",
    }), true);
  });

  it("fails compatibly on an unreadable version and never writes cross-platform", () => {
    for (const systemVersion of ["", "bad", null, undefined]) {
      assert.strictEqual(shouldInstallRuntimeDockIcon({
        platform: "darwin",
        isPackaged: true,
        systemVersion,
      }), true, String(systemVersion));
    }
    for (const platform of ["win32", "linux"]) {
      assert.strictEqual(shouldInstallRuntimeDockIcon({
        platform,
        isPackaged: true,
        systemVersion: "25.0",
      }), false, platform);
    }
  });

  it("contains version API failures and skips the API when it is irrelevant", () => {
    assert.strictEqual(resolveRuntimeDockIconPolicy({
      platform: "darwin",
      isPackaged: true,
      getSystemVersion: () => { throw new Error("native failure"); },
    }), true);

    let calls = 0;
    assert.strictEqual(resolveRuntimeDockIconPolicy({
      platform: "darwin",
      isPackaged: false,
      getSystemVersion: () => { calls += 1; return "26.5.2"; },
    }), true);
    assert.strictEqual(resolveRuntimeDockIconPolicy({
      platform: "win32",
      isPackaged: true,
      getSystemVersion: () => { calls += 1; return "25.0"; },
    }), false);
    assert.strictEqual(calls, 0);
  });
});

describe("macOS startup Dock icon installer", () => {
  it("writes exactly once when every startup gate allows it", () => {
    const calls = [];
    const installed = installStartupDockIcon({
      dock: { setIcon: (iconPath) => calls.push(iconPath) },
      showDock: true,
      dockIconPath: "/assets/dock-icon.png",
      installRuntimeIcon: true,
    });
    assert.strictEqual(installed, true);
    assert.deepStrictEqual(calls, ["/assets/dock-icon.png"]);
  });

  it("performs zero writes when Dock, preference, path, or policy gates fail", () => {
    const calls = [];
    const base = {
      dock: { setIcon: (iconPath) => calls.push(iconPath) },
      showDock: true,
      dockIconPath: "/assets/dock-icon.png",
      installRuntimeIcon: true,
    };
    assert.strictEqual(installStartupDockIcon({ ...base, showDock: false }), false);
    assert.strictEqual(installStartupDockIcon({ ...base, dock: null }), false);
    assert.strictEqual(installStartupDockIcon({ ...base, dockIconPath: "" }), false);
    assert.strictEqual(installStartupDockIcon({ ...base, installRuntimeIcon: false }), false);
    assert.deepStrictEqual(calls, []);
  });

  it("contains setIcon and logger failures", () => {
    const warnings = [];
    assert.doesNotThrow(() => installStartupDockIcon({
      dock: { setIcon: () => { throw new Error("icon failure"); } },
      showDock: true,
      dockIconPath: "/assets/dock-icon.png",
      installRuntimeIcon: true,
      logWarn: (...args) => warnings.push(args),
    }));
    assert.deepStrictEqual(warnings, [[
      "Clawd: failed to install startup macOS Dock icon:",
      "icon failure",
    ]]);

    assert.doesNotThrow(() => installStartupDockIcon({
      dock: { setIcon: () => { throw new Error("icon failure"); } },
      showDock: true,
      dockIconPath: "/assets/dock-icon.png",
      installRuntimeIcon: true,
      logWarn: () => { throw new Error("logger failure"); },
    }));
  });
});
