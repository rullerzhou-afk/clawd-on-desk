"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

test("startup exposes prefs read failure and legacy Feishu approval after a window exists", () => {
  const readyStart = mainSource.indexOf("app.whenReady().then(async () => {");
  const beforeQuit = mainSource.indexOf('app.on("before-quit"', readyStart);
  assert.notStrictEqual(readyStart, -1);
  assert.notStrictEqual(beforeQuit, -1);
  const startup = mainSource.slice(readyStart, beforeQuit);

  const createWindowIndex = startup.indexOf("createWindow();");
  const prefsNudgeIndex = startup.indexOf("notifyPrefsAuthorityFailure();");
  const feishuNudgeIndex = startup.indexOf("feishuApprovalMigrationNudge.sync({ allowNotify: true })");
  assert.ok(createWindowIndex >= 0, "startup must create the main window");
  assert.ok(prefsNudgeIndex > createWindowIndex, "prefs failure should be visible after notification UI is ready");
  assert.ok(feishuNudgeIndex > createWindowIndex, "legacy Feishu/Lark setup should be visible after notification UI is ready");
});

test("prefs read-failure startup notice keeps the fail-closed condition and opens Settings", () => {
  const functionStart = mainSource.indexOf("function notifyPrefsAuthorityFailure()");
  const readyStart = mainSource.indexOf("app.whenReady().then(async () => {", functionStart);
  assert.notStrictEqual(functionStart, -1);
  assert.notStrictEqual(readyStart, -1);
  const body = mainSource.slice(functionStart, readyStart);

  assert.match(body, /if \(!readFailure && !_initialPrefsRecovered\) return false;/);
  assert.match(body, /"prefsReadFailureNudgeTitle"/);
  assert.match(body, /"prefsReadFailureNudgeBody"/);
  assert.match(body, /"prefsRecoveredNudgeTitle"/);
  assert.match(body, /"prefsRecoveredNudgeBody"/);
  assert.match(body, /"prefsRecoveryBackupFailedNudgeTitle"/);
  assert.match(body, /"prefsRecoveryBackupFailedNudgeBody"/);
  assert.match(body, /settingsWindowRuntime\.open\(\)/);
});

test("Kimi quota reconciliation starts only after visible UI and stays non-blocking", () => {
  const readyStart = mainSource.indexOf("app.whenReady().then(async () => {");
  const beforeQuit = mainSource.indexOf('app.on("before-quit"', readyStart);
  const startup = mainSource.slice(readyStart, beforeQuit);
  const createIndex = startup.indexOf("createWindow();");
  const initializeIndex = startup.indexOf("void _kimiQuotaRuntime.initialize().catch");
  assert.ok(createIndex >= 0, "startup should create its visible window");
  assert.ok(initializeIndex > createIndex, "Kimi reconciliation must start after createWindow");
  assert.doesNotMatch(startup.slice(0, createIndex), /await _kimiQuotaRuntime\.initialize\(\)/);
});
