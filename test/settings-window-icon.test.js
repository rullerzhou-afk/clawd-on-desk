"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const {
  WINDOWS_APP_USER_MODEL_ID,
  getSettingsWindowIconPath,
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
