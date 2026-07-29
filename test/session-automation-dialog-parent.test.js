"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
