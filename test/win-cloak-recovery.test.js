"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  createCloakInspector,
  classifyCloakState,
  CLOAK_NONE,
  CLOAK_APP,
  CLOAK_SHELL,
  CLOAK_INHERITED,
} = require("../src/win-cloak-recovery");

describe("win-cloak-recovery classifyCloakState", () => {
  it("treats flag 0 and malformed flags as clean", () => {
    assert.equal(classifyCloakState(CLOAK_NONE, true), "clean");
    assert.equal(classifyCloakState(CLOAK_NONE, null), "clean");
    assert.equal(classifyCloakState(undefined, true), "clean");
    assert.equal(classifyCloakState(NaN, true), "clean");
    assert.equal(classifyCloakState("2", true), "clean");
  });

  it("never touches a window parked on another virtual desktop", () => {
    assert.equal(classifyCloakState(CLOAK_APP, false), "other-desktop");
    assert.equal(classifyCloakState(CLOAK_SHELL, false), "other-desktop");
    assert.equal(classifyCloakState(CLOAK_INHERITED, false), "other-desktop");
  });

  it("recovers any cloak kind confirmed on the current desktop", () => {
    assert.equal(classifyCloakState(CLOAK_APP, true), "recover");
    assert.equal(classifyCloakState(CLOAK_SHELL, true), "recover");
    assert.equal(classifyCloakState(CLOAK_INHERITED, true), "recover");
  });

  it("degrades to APP-only when the desktop answer is unknown (COM down)", () => {
    assert.equal(classifyCloakState(CLOAK_APP, null), "recover");
    assert.equal(classifyCloakState(CLOAK_SHELL, null), "skip");
    assert.equal(classifyCloakState(CLOAK_INHERITED, null), "skip");
    // Combined flags containing the APP bit still recover.
    assert.equal(classifyCloakState(CLOAK_APP | CLOAK_SHELL, null), "recover");
  });
});

describe("win-cloak-recovery createCloakInspector off Windows", () => {
  it("returns the unavailable inspector whose methods are safe no-ops", () => {
    const inspector = createCloakInspector({ isWin: false });
    assert.equal(inspector.available, false);
    assert.equal(inspector.readCloakState({}), CLOAK_NONE);
    assert.equal(inspector.isOnCurrentVirtualDesktop({}), null);
    assert.equal(inspector.uncloak({}), false);
    assert.doesNotThrow(() => inspector.dispose());
  });
});
