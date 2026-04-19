"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const {
  WINDOWS_APP_USER_MODEL_ID,
  SETTINGS_WINDOW_TITLE,
  getSettingsWindowIconPath,
  getWindowsShellIconPath,
  getSettingsWindowTaskbarDetails,
  applyWindowsAppUserModelId,
} = require("../src/settings-window-icon");

describe("settings window icon path", () => {
  it("prefers the 256px project icon for unpackaged Windows runs", () => {
    const appDir = "D:\\clawd-on-desk";
    const expected = path.join(appDir, "assets", "icons", "256x256.png");
    const actual = getSettingsWindowIconPath({
      platform: "win32",
      isPackaged: false,
      appDir,
      existsSync: (candidate) => candidate === expected,
    });
    assert.strictEqual(actual, expected);
  });

  it("falls back to icon.ico when the 256px icon is unavailable", () => {
    const appDir = "D:\\clawd-on-desk";
    const expected = path.join(appDir, "assets", "icon.ico");
    const actual = getSettingsWindowIconPath({
      platform: "win32",
      isPackaged: false,
      appDir,
      existsSync: (candidate) => candidate === expected,
    });
    assert.strictEqual(actual, expected);
  });

  it("prefers unpacked packaged assets before falling back to icon.ico", () => {
    const resourcesPath = "C:\\Program Files\\Clawd on Desk\\resources";
    const expected = path.join(resourcesPath, "app.asar.unpacked", "assets", "icons", "256x256.png");
    const actual = getSettingsWindowIconPath({
      platform: "win32",
      isPackaged: true,
      resourcesPath,
      existsSync: (candidate) => candidate === expected,
    });
    assert.strictEqual(actual, expected);
  });

  it("returns undefined on non-Windows platforms", () => {
    assert.strictEqual(getSettingsWindowIconPath({ platform: "darwin" }), undefined);
    assert.strictEqual(getSettingsWindowIconPath({ platform: "linux" }), undefined);
  });
});

describe("windows app user model id", () => {
  it("applies the project app id on Windows", () => {
    let appId = null;
    applyWindowsAppUserModelId({
      setAppUserModelId(value) { appId = value; },
    }, "win32");
    assert.strictEqual(appId, WINDOWS_APP_USER_MODEL_ID);
  });

  it("does nothing on non-Windows platforms", () => {
    let called = false;
    applyWindowsAppUserModelId({
      setAppUserModelId() { called = true; },
    }, "darwin");
    assert.strictEqual(called, false);
  });
});

describe("windows shell icon path", () => {
  it("prefers icon.ico for unpackaged Windows shell surfaces", () => {
    const appDir = "D:\\clawd-on-desk";
    const expected = path.join(appDir, "assets", "icon.ico");
    const actual = getWindowsShellIconPath({
      isPackaged: false,
      appDir,
      existsSync: (candidate) => candidate === expected,
    });
    assert.strictEqual(actual, expected);
  });

  it("prefers the extra resource icon for packaged Windows shell surfaces", () => {
    const resourcesPath = "C:\\Program Files\\Clawd on Desk\\resources";
    const expected = path.join(resourcesPath, "icon.ico");
    const actual = getWindowsShellIconPath({
      isPackaged: true,
      resourcesPath,
      existsSync: (candidate) => candidate === expected,
    });
    assert.strictEqual(actual, expected);
  });
});

describe("settings window taskbar details", () => {
  it("builds Windows taskbar metadata for unpackaged runs", () => {
    const appDir = "D:\\clawd-on-desk";
    const execPath = "D:\\clawd-on-desk\\node_modules\\electron\\dist\\electron.exe";
    const appPath = "D:\\clawd-on-desk";
    const iconPath = path.join(appDir, "assets", "icon.ico");
    const actual = getSettingsWindowTaskbarDetails({
      platform: "win32",
      isPackaged: false,
      appDir,
      execPath,
      appPath,
      existsSync: (candidate) => candidate === iconPath,
    });
    assert.deepStrictEqual(actual, {
      appId: WINDOWS_APP_USER_MODEL_ID,
      appIconPath: iconPath,
      appIconIndex: 0,
      relaunchCommand: `"${execPath}" "${appPath}"`,
      relaunchDisplayName: SETTINGS_WINDOW_TITLE,
    });
  });

  it("returns null on non-Windows platforms", () => {
    assert.strictEqual(getSettingsWindowTaskbarDetails({ platform: "darwin" }), null);
  });
});
