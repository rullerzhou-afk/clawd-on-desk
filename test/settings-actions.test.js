"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  updateRegistry,
  requireBoolean,
  requireFiniteNumber,
  requireEnum,
} = require("../src/settings-actions");
const prefs = require("../src/prefs");

describe("validator helpers", () => {
  it("requireBoolean accepts only booleans", () => {
    const v = requireBoolean("foo");
    assert.strictEqual(v(true).status, "ok");
    assert.strictEqual(v(false).status, "ok");
    assert.strictEqual(v("true").status, "error");
    assert.strictEqual(v(1).status, "error");
    assert.strictEqual(v(null).status, "error");
  });

  it("requireFiniteNumber rejects NaN/Infinity", () => {
    const v = requireFiniteNumber("x");
    assert.strictEqual(v(0).status, "ok");
    assert.strictEqual(v(-1).status, "ok");
    assert.strictEqual(v(NaN).status, "error");
    assert.strictEqual(v(Infinity).status, "error");
    assert.strictEqual(v("0").status, "error");
  });

  it("requireEnum rejects values outside the allowlist", () => {
    const v = requireEnum("k", ["a", "b"]);
    assert.strictEqual(v("a").status, "ok");
    assert.strictEqual(v("c").status, "error");
  });
});

describe("updateRegistry pure-data validators", () => {
  const baseSnapshot = prefs.getDefaults();

  it("lang validates against the enum", () => {
    assert.strictEqual(updateRegistry.lang("en", { snapshot: baseSnapshot }).status, "ok");
    assert.strictEqual(updateRegistry.lang("zh", { snapshot: baseSnapshot }).status, "ok");
    assert.strictEqual(updateRegistry.lang("klingon", { snapshot: baseSnapshot }).status, "error");
  });

  it("size accepts S/M/L and P:<num>", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.size("S", deps).status, "ok");
    assert.strictEqual(updateRegistry.size("M", deps).status, "ok");
    assert.strictEqual(updateRegistry.size("L", deps).status, "ok");
    assert.strictEqual(updateRegistry.size("P:10", deps).status, "ok");
    assert.strictEqual(updateRegistry.size("P:12.5", deps).status, "ok");
    assert.strictEqual(updateRegistry.size("XL", deps).status, "error");
    assert.strictEqual(updateRegistry.size("P:abc", deps).status, "error");
  });

  it("miniEdge accepts only left/right", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.miniEdge("left", deps).status, "ok");
    assert.strictEqual(updateRegistry.miniEdge("right", deps).status, "ok");
    assert.strictEqual(updateRegistry.miniEdge("top", deps).status, "error");
  });

  it("x/y/preMiniX/preMiniY require finite numbers", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.x(0, deps).status, "ok");
    assert.strictEqual(updateRegistry.y(-100, deps).status, "ok");
    assert.strictEqual(updateRegistry.preMiniX(NaN, deps).status, "error");
    assert.strictEqual(updateRegistry.preMiniY(Infinity, deps).status, "error");
  });

  it("function-form boolean fields reject non-booleans", () => {
    const deps = { snapshot: baseSnapshot };
    for (const key of [
      "soundMuted", "bubbleFollowPet", "hideBubbles",
      "showSessionId", "miniMode", "openAtLoginHydrated",
    ]) {
      assert.strictEqual(updateRegistry[key](true, deps).status, "ok", `${key}(true)`);
      assert.strictEqual(updateRegistry[key](false, deps).status, "ok", `${key}(false)`);
      assert.strictEqual(updateRegistry[key]("yes", deps).status, "error", `${key}("yes")`);
    }
  });

  it("object-form boolean fields validate via entry.validate", () => {
    const deps = { snapshot: baseSnapshot };
    for (const key of ["autoStartWithClaude", "openAtLogin"]) {
      const entry = updateRegistry[key];
      assert.strictEqual(typeof entry, "object", `${key} should be object-form`);
      assert.strictEqual(typeof entry.validate, "function", `${key} should expose validate`);
      assert.strictEqual(typeof entry.effect, "function", `${key} should expose effect`);
      assert.strictEqual(entry.validate(true, deps).status, "ok", `${key} validate(true)`);
      assert.strictEqual(entry.validate(false, deps).status, "ok", `${key} validate(false)`);
      assert.strictEqual(entry.validate("yes", deps).status, "error", `${key} validate("yes")`);
    }
  });

  it("theme requires a non-empty string", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.theme("clawd", deps).status, "ok");
    assert.strictEqual(updateRegistry.theme("", deps).status, "error");
    assert.strictEqual(updateRegistry.theme(null, deps).status, "error");
  });

  it("agents/themeOverrides require plain objects", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.agents({}, deps).status, "ok");
    assert.strictEqual(updateRegistry.agents([], deps).status, "error");
    assert.strictEqual(updateRegistry.themeOverrides({}, deps).status, "ok");
    assert.strictEqual(updateRegistry.themeOverrides("nope", deps).status, "error");
  });
});

describe("object-form effects (autoStartWithClaude / openAtLogin)", () => {
  it("autoStartWithClaude effect calls installAutoStart on true", () => {
    let installCalls = 0;
    let uninstallCalls = 0;
    const deps = {
      installAutoStart: () => installCalls++,
      uninstallAutoStart: () => uninstallCalls++,
    };
    const r = updateRegistry.autoStartWithClaude.effect(true, deps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(installCalls, 1);
    assert.strictEqual(uninstallCalls, 0);
  });

  it("autoStartWithClaude effect calls uninstallAutoStart on false", () => {
    let installCalls = 0;
    let uninstallCalls = 0;
    const deps = {
      installAutoStart: () => installCalls++,
      uninstallAutoStart: () => uninstallCalls++,
    };
    const r = updateRegistry.autoStartWithClaude.effect(false, deps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(installCalls, 0);
    assert.strictEqual(uninstallCalls, 1);
  });

  it("autoStartWithClaude effect returns error when deps missing", () => {
    const r = updateRegistry.autoStartWithClaude.effect(true, {});
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /requires installAutoStart\/uninstallAutoStart/);
  });

  it("autoStartWithClaude effect catches install throws", () => {
    const deps = {
      installAutoStart: () => { throw new Error("file locked"); },
      uninstallAutoStart: () => {},
    };
    const r = updateRegistry.autoStartWithClaude.effect(true, deps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /file locked/);
  });

  it("openAtLogin effect calls setOpenAtLogin with the value", () => {
    let lastValue = null;
    const deps = { setOpenAtLogin: (v) => { lastValue = v; } };
    const r1 = updateRegistry.openAtLogin.effect(true, deps);
    assert.strictEqual(r1.status, "ok");
    assert.strictEqual(lastValue, true);
    const r2 = updateRegistry.openAtLogin.effect(false, deps);
    assert.strictEqual(r2.status, "ok");
    assert.strictEqual(lastValue, false);
  });

  it("openAtLogin effect returns error when deps missing", () => {
    const r = updateRegistry.openAtLogin.effect(true, {});
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /requires setOpenAtLogin/);
  });

  it("openAtLogin effect catches setter throws", () => {
    const deps = { setOpenAtLogin: () => { throw new Error("permission denied"); } };
    const r = updateRegistry.openAtLogin.effect(true, deps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /permission denied/);
  });
});

describe("updateRegistry cross-field validators (showTray/showDock)", () => {
  it("rejects disabling tray when dock is already off", () => {
    const snap = { ...prefs.getDefaults(), showTray: true, showDock: false };
    const r = updateRegistry.showTray(false, { snapshot: snap });
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /unquittable/);
  });

  it("rejects disabling dock when tray is already off", () => {
    const snap = { ...prefs.getDefaults(), showTray: false, showDock: true };
    const r = updateRegistry.showDock(false, { snapshot: snap });
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /unquittable/);
  });

  it("allows disabling tray when dock is on", () => {
    const snap = { ...prefs.getDefaults(), showTray: true, showDock: true };
    assert.strictEqual(updateRegistry.showTray(false, { snapshot: snap }).status, "ok");
  });

  it("allows enabling either at any time", () => {
    const snap = { ...prefs.getDefaults(), showTray: false, showDock: false };
    assert.strictEqual(updateRegistry.showTray(true, { snapshot: snap }).status, "ok");
    assert.strictEqual(updateRegistry.showDock(true, { snapshot: snap }).status, "ok");
  });
});

describe("version validator", () => {
  it("accepts the current version", () => {
    const r = updateRegistry.version(prefs.CURRENT_VERSION, { snapshot: prefs.getDefaults() });
    assert.strictEqual(r.status, "ok");
  });

  it("rejects future versions", () => {
    const r = updateRegistry.version(prefs.CURRENT_VERSION + 1, { snapshot: prefs.getDefaults() });
    assert.strictEqual(r.status, "error");
  });

  it("rejects non-positive numbers", () => {
    const deps = { snapshot: prefs.getDefaults() };
    assert.strictEqual(updateRegistry.version(0, deps).status, "error");
    assert.strictEqual(updateRegistry.version(-1, deps).status, "error");
    assert.strictEqual(updateRegistry.version("1", deps).status, "error");
  });
});
