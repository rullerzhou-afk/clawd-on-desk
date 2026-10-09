"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  selectSessionAutomationDialogParent,
} = require("../src/session-automation-dialog-parent");

function windowStub(destroyed = false) {
  return { isDestroyed: () => destroyed };
}

test("session automation warning prefers permission bubble, then invoking Dashboard window", () => {
  const bubble = windowStub();
  const dashboard = windowStub();
  const pet = windowStub();

  assert.equal(selectSessionAutomationDialogParent({
    entry: { bubble, warningParent: dashboard },
    petWindow: pet,
  }), bubble);
  assert.equal(selectSessionAutomationDialogParent({
    entry: { warningParent: dashboard },
    petWindow: pet,
  }), dashboard);
});

test("session automation warning falls back safely when candidate windows are gone", () => {
  const pet = windowStub();
  assert.equal(selectSessionAutomationDialogParent({
    entry: {
      bubble: windowStub(true),
      warningParent: windowStub(true),
    },
    petWindow: pet,
  }), pet);
  assert.equal(selectSessionAutomationDialogParent({
    entry: { warningParent: windowStub(true) },
    petWindow: windowStub(true),
  }), null);
});

test("main routes the session automation warning through the shared styled runtime", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const start = mainSource.indexOf("async function showSessionAutomationWarning(entry)");
  const end = mainSource.indexOf("sessionAutomationStore = createSessionAutomationStore", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const functionSource = mainSource.slice(start, end);
  assert.match(
    functionSource,
    /permissionAutomationConfirmationRuntime\.confirmPermissionAutomation\(\{/
  );
  assert.match(functionSource, /\bparent,/);
  assert.match(functionSource, /message:\s*translate\("sessionAutomationConfirmMessage"\)/);
  assert.doesNotMatch(functionSource, /showMessageBox/);
});
