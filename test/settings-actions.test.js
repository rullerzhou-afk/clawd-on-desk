"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  updateRegistry,
  commandRegistry,
  MANAGED_CLEANUP_AGENT_IDS,
  saveFeishuApproverByEmail,
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
    assert.strictEqual(updateRegistry.lang("ko", { snapshot: baseSnapshot }).status, "ok");
    assert.strictEqual(updateRegistry.lang("es", { snapshot: baseSnapshot }).status, "ok");
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

  it("petTint accepts only safe per-theme catalog selections", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.petTint({}, deps).status, "ok");
    assert.strictEqual(
      updateRegistry.petTint({ clawd: "gold", cloudling: "matcha" }, deps).status,
      "ok"
    );
    assert.strictEqual(updateRegistry.petTint({ clawd: "none" }, deps).status, "error");
    assert.strictEqual(updateRegistry.petTint({ clawd: "custom" }, deps).status, "error");
    assert.strictEqual(
      updateRegistry.petTint({ "../unsafe": "gold" }, deps).status,
      "error"
    );
    assert.strictEqual(
      updateRegistry.petTint({ clawd: "url(file:///secret)" }, deps).status,
      "error"
    );
    assert.strictEqual(updateRegistry.petTint("gold", deps).status, "error");
    assert.strictEqual(updateRegistry.petTint([], deps).status, "error");
    assert.strictEqual(updateRegistry.petTint(null, deps).status, "error");
  });

  it("petAccessory accepts only safe per-theme catalog selections", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.petAccessory({}, deps).status, "ok");
    assert.strictEqual(
      updateRegistry.petAccessory({ clawd: "wizard-hat", cloudling: "halo" }, deps).status,
      "ok"
    );
    assert.strictEqual(updateRegistry.petAccessory({ clawd: "none" }, deps).status, "error");
    assert.strictEqual(updateRegistry.petAccessory({ clawd: "seasonal" }, deps).status, "error");
    assert.strictEqual(
      updateRegistry.petAccessory({ "../unsafe": "halo" }, deps).status,
      "error"
    );
    assert.strictEqual(
      updateRegistry.petAccessory({ clawd: "file:///secret.svg" }, deps).status,
      "error"
    );
    assert.strictEqual(updateRegistry.petAccessory("wizard-hat", deps).status, "error");
    assert.strictEqual(updateRegistry.petAccessory([], deps).status, "error");
    assert.strictEqual(updateRegistry.petAccessory(null, deps).status, "error");
  });

  it("petMouthAccessory accepts only safe per-theme catalog selections", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.petMouthAccessory({}, deps).status, "ok");
    assert.strictEqual(
      updateRegistry.petMouthAccessory({ clawd: "cigarette" }, deps).status,
      "ok"
    );
    assert.strictEqual(updateRegistry.petMouthAccessory({ clawd: "none" }, deps).status, "error");
    assert.strictEqual(updateRegistry.petMouthAccessory({ clawd: "pipe" }, deps).status, "error");
    assert.strictEqual(
      updateRegistry.petMouthAccessory({ "../unsafe": "cigarette" }, deps).status,
      "error"
    );
    assert.strictEqual(
      updateRegistry.petMouthAccessory({ clawd: "file:///secret.svg" }, deps).status,
      "error"
    );
    assert.strictEqual(updateRegistry.petMouthAccessory("cigarette", deps).status, "error");
    assert.strictEqual(updateRegistry.petMouthAccessory([], deps).status, "error");
    assert.strictEqual(updateRegistry.petMouthAccessory(null, deps).status, "error");
  });

  it("holidayAccessoryEnabled accepts only canonical per-theme true entries", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.holidayAccessoryEnabled({}, deps).status, "ok");
    assert.strictEqual(
      updateRegistry.holidayAccessoryEnabled({ clawd: true, cloudling: true }, deps).status,
      "ok"
    );
    assert.strictEqual(
      updateRegistry.holidayAccessoryEnabled({ clawd: false }, deps).status,
      "error"
    );
    assert.strictEqual(
      updateRegistry.holidayAccessoryEnabled({ "../unsafe": true }, deps).status,
      "error"
    );
    assert.strictEqual(updateRegistry.holidayAccessoryEnabled(true, deps).status, "error");
    assert.strictEqual(updateRegistry.holidayAccessoryEnabled([], deps).status, "error");
    assert.strictEqual(updateRegistry.holidayAccessoryEnabled(null, deps).status, "error");
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
      "sessionHudEnabled", "sessionHudShowElapsed", "sessionHudShowContextUsage", "sessionHudShowQuota", "sessionHudCleanupDetached",
      "sessionHudShowStateLabels", "sessionHudPinned",
      "miniMode", "openAtLoginHydrated", "soundMuted", "bubbleFollowPet",
      "hideBubbles", "permissionBubblesEnabled", "lowPowerIdleMode",
      "testReactionsEnabled",
      "allowEdgePinning", "disableMiniMode", "keepSizeAcrossDisplays", "codexHookHealthNotifyEnabled",
      "quotaMergeSources", "freeRoam", "roamConstrainAxis",
    ]) {
      assert.strictEqual(updateRegistry[key](true, deps).status, "ok", `${key}(true)`);
      assert.strictEqual(updateRegistry[key](false, deps).status, "ok", `${key}(false)`);
      assert.strictEqual(updateRegistry[key]("yes", deps).status, "error", `${key}("yes")`);
    }
  });

  it("accepts only supported quota ring display modes", () => {
    assert.strictEqual(updateRegistry.quotaRingDisplayMode("used").status, "ok");
    assert.strictEqual(updateRegistry.quotaRingDisplayMode("remaining").status, "ok");
    assert.strictEqual(updateRegistry.quotaRingDisplayMode("available").status, "error");
    assert.strictEqual(updateRegistry.quotaRingDisplayMode(true).status, "error");
  });

  it("accepts only supported bubble placement enums", () => {
    for (const value of ["auto", "left", "right"]) {
      assert.strictEqual(updateRegistry.bubbleFollowPreference(value).status, "ok");
    }
    assert.strictEqual(updateRegistry.bubbleFollowPreference("strict-left").status, "error");
    for (const value of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
      assert.strictEqual(updateRegistry.bubbleFixedCorner(value).status, "ok");
    }
    assert.strictEqual(updateRegistry.bubbleFixedCorner("center").status, "error");
  });

  it("codexHookHealthLastNotified accepts strings and empty reset", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.codexHookHealthLastNotified("", deps).status, "ok");
    assert.strictEqual(updateRegistry.codexHookHealthLastNotified("needs-review", deps).status, "ok");
    assert.strictEqual(updateRegistry.codexHookHealthLastNotified(null, deps).status, "error");
    assert.strictEqual(updateRegistry.codexHookHealthLastNotified(42, deps).status, "error");
  });

  it("telegramMigrationLastNotified accepts signatures and empty reset", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.telegramMigrationLastNotified("", deps).status, "ok");
    assert.strictEqual(updateRegistry.telegramMigrationLastNotified("legacy-migration", deps).status, "ok");
    assert.strictEqual(updateRegistry.telegramMigrationLastNotified(null, deps).status, "error");
    assert.strictEqual(updateRegistry.telegramMigrationLastNotified(42, deps).status, "error");
  });

  it("hidden quota providers validate as a bounded list of non-empty strings", () => {
    const entry = updateRegistry.quotaRingHiddenProviders;
    const check = (value) => (typeof entry === "function" ? entry(value) : entry.validate(value));
    assert.strictEqual(check([]).status, "ok");
    assert.strictEqual(check(["codexQuota", "kimiQuota"]).status, "ok");
    // Shape only — an unrecognized key is accepted on purpose, because
    // rejecting it would un-hide the provider behind the user's back.
    assert.strictEqual(check(["notAProviderYet"]).status, "ok");
    assert.strictEqual(check("codexQuota").status, "error", "a bare string is not a list");
    assert.strictEqual(check(null).status, "error");
    assert.strictEqual(check([""]).status, "error");
    assert.strictEqual(check(["  "]).status, "error");
    assert.strictEqual(check([1]).status, "error");
    assert.strictEqual(
      check(Array.from({ length: 200 }, (_v, i) => `p${i}`)).status, "error",
      "an unbounded list must be refused at the command boundary, not silently truncated"
    );
  });

  it("Claude usage collection validates booleans and delegates the opt-in mutation", async () => {
    const entry = updateRegistry.claudeQuotaCollectionEnabled;
    assert.strictEqual(entry.validate(true).status, "ok");
    assert.strictEqual(entry.validate("yes").status, "error");
    const calls = [];
    const enabled = await entry.effect(true, {
      setClaudeQuotaCollectionEnabled: async (value) => {
        calls.push(value);
        return { status: "ok" };
      },
    });
    assert.strictEqual(enabled.status, "ok");
    assert.deepStrictEqual(calls, [true]);
    assert.strictEqual(entry.effect(false, {}).status, "error");
  });

  it("Kimi usage collection is command-only", () => {
    const entry = updateRegistry.kimiQuotaCollectionEnabled;
    assert.strictEqual(entry.validate(true).status, "ok");
    assert.strictEqual(entry.validate("yes").status, "error");
    assert.strictEqual(entry.commandOnly, true);
    assert.deepStrictEqual(
      commandRegistry.setKimiQuotaCollectionEnabled({ enabled: true }),
      { status: "ok", commit: { kimiQuotaCollectionEnabled: true } }
    );
    assert.strictEqual(
      commandRegistry.setKimiQuotaCollectionEnabled({ enabled: "yes" }).status,
      "error"
    );
  });

  it("bubble auto-close seconds require integers in range", () => {
    const deps = { snapshot: baseSnapshot };
    for (const key of [
      "notificationBubbleAutoCloseSeconds",
      "permissionBubbleAutoCloseSeconds",
      "updateBubbleAutoCloseSeconds",
    ]) {
      assert.strictEqual(updateRegistry[key](0, deps).status, "ok", `${key}(0)`);
      assert.strictEqual(updateRegistry[key](30, deps).status, "ok", `${key}(30)`);
      assert.strictEqual(updateRegistry[key](3600, deps).status, "ok", `${key}(3600)`);
      assert.strictEqual(updateRegistry[key](-1, deps).status, "error", `${key}(-1)`);
      assert.strictEqual(updateRegistry[key](1.5, deps).status, "error", `${key}(1.5)`);
      assert.strictEqual(updateRegistry[key](3601, deps).status, "error", `${key}(3601)`);
      assert.strictEqual(updateRegistry[key]("30", deps).status, "error", `${key}("30")`);
    }
  });

  it("saved pixel sizes require non-negative finite numbers", () => {
    const deps = { snapshot: baseSnapshot };
    for (const key of ["savedPixelWidth", "savedPixelHeight"]) {
      assert.strictEqual(updateRegistry[key](0, deps).status, "ok", `${key}(0)`);
      assert.strictEqual(updateRegistry[key](286, deps).status, "ok", `${key}(286)`);
      assert.strictEqual(updateRegistry[key](-1, deps).status, "error", `${key}(-1)`);
      assert.strictEqual(updateRegistry[key](Infinity, deps).status, "error", `${key}(Infinity)`);
    }
  });

  it("Settings window bounds accept normal integer geometry or null", () => {
    const validate = updateRegistry.settingsWindowBounds;
    assert.strictEqual(validate(null).status, "ok");
    assert.strictEqual(
      validate({ x: -1200, y: 80, width: 900, height: 640 }).status,
      "ok",
    );
    for (const value of [
      { x: 0.5, y: 0, width: 800, height: 560 },
      { x: 0, y: 0, width: 0, height: 560 },
      { x: 0, y: 0, width: 800 },
      [],
      "800x560",
    ]) {
      assert.strictEqual(validate(value).status, "error");
    }
  });

  it("Dashboard window bounds accept normal integer geometry or null", () => {
    const validate = updateRegistry.dashboardWindowBounds;
    assert.strictEqual(validate(null).status, "ok");
    assert.strictEqual(
      validate({ x: -1200, y: 80, width: 900, height: 640 }).status,
      "ok",
    );
    for (const value of [
      { x: 0.5, y: 0, width: 800, height: 560 },
      { x: 0, y: 0, width: 0, height: 560 },
      { x: 0, y: 0, width: 800 },
      [],
      "800x560",
    ]) {
      assert.strictEqual(validate(value).status, "error");
    }
  });

  it("object-form boolean fields validate via entry.validate", () => {
    const deps = { snapshot: baseSnapshot };
    for (const key of ["autoStartWithClaude", "autoStartWithCodex", "manageClaudeHooksAutomatically", "openAtLogin"]) {
      const entry = updateRegistry[key];
      assert.strictEqual(typeof entry, "object", `${key} should be object-form`);
      assert.strictEqual(typeof entry.validate, "function", `${key} should expose validate`);
      assert.strictEqual(typeof entry.effect, "function", `${key} should expose effect`);
      assert.strictEqual(entry.validate(true, deps).status, "ok", `${key} validate(true)`);
      assert.strictEqual(entry.validate(false, deps).status, "ok", `${key} validate(false)`);
      assert.strictEqual(entry.validate("yes", deps).status, "error", `${key} validate("yes")`);
    }
  });

  it("theme validator requires a non-empty string", () => {
    // theme is now an object-form entry ({ validate, effect }); access
    // the validator directly — the effect needs an activateTheme dep
    // and is covered separately.
    const entry = updateRegistry.theme;
    assert.strictEqual(typeof entry, "object");
    assert.strictEqual(typeof entry.validate, "function");
    assert.strictEqual(typeof entry.effect, "function");
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(entry.validate("clawd", deps).status, "ok");
    assert.strictEqual(entry.validate("", deps).status, "error");
    assert.strictEqual(entry.validate(null, deps).status, "error");
  });

  it("theme effect proxies to deps.activateTheme and maps throws to error", () => {
    const entry = updateRegistry.theme;
    const calls = [];
    const overrideMap = {
      tiers: {
        workingTiers: {
          "clawd-working-typing.svg": { file: "clawd-working-typing-old.svg" },
        },
      },
    };
    const deps = {
      snapshot: { ...baseSnapshot, themeOverrides: { clawd: overrideMap } },
      activateTheme: (id, variantId, targetOverrideMap) => {
        calls.push({ id, variantId, targetOverrideMap });
        if (id === "bad") throw new Error("boom");
      },
    };
    assert.deepStrictEqual(entry.effect("clawd", deps), { status: "ok" });
    assert.deepStrictEqual(calls, [{
      id: "clawd",
      variantId: null,
      targetOverrideMap: overrideMap,
    }]);

    const err = entry.effect("bad", deps);
    assert.strictEqual(err.status, "error");
    assert.match(err.message, /boom/);
  });

  it("theme effect errors when activateTheme dep missing", () => {
    const entry = updateRegistry.theme;
    const result = entry.effect("clawd", { snapshot: baseSnapshot });
    assert.strictEqual(result.status, "error");
    assert.match(result.message, /activateTheme/);
  });

  it("themeVariant requires a plain object (no effect runs)", () => {
    // Plan §6.2: themeVariant must have validator but NO effect — to avoid
    // double-activating theme alongside `theme` field effect.
    const deps = { snapshot: prefs.getDefaults() };
    assert.strictEqual(updateRegistry.themeVariant({}, deps).status, "ok");
    assert.strictEqual(updateRegistry.themeVariant({ clawd: "chill" }, deps).status, "ok");
    assert.strictEqual(updateRegistry.themeVariant("nope", deps).status, "error");
    assert.strictEqual(updateRegistry.themeVariant(null, deps).status, "error");
    assert.strictEqual(updateRegistry.themeVariant([1, 2], deps).status, "error");
    // Object-form entries have `.validate` + `.effect`; pure-data entries are
    // bare functions. themeVariant MUST be the bare-function form.
    assert.strictEqual(typeof updateRegistry.themeVariant, "function");
  });

  it("agents/themeOverrides require plain objects", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.agents({}, deps).status, "ok");
    assert.strictEqual(updateRegistry.agents([], deps).status, "error");
    assert.strictEqual(updateRegistry.dismissedAgentInstallHints({ "qwen-code": true }, deps).status, "ok");
    assert.strictEqual(updateRegistry.dismissedAgentInstallHints({ "qwen-code": false }, deps).status, "error");
    assert.strictEqual(updateRegistry.dismissedAgentCleanupHints({ "qwen-code": true }, deps).status, "ok");
    assert.strictEqual(updateRegistry.dismissedAgentCleanupHints({ "qwen-code": false }, deps).status, "error");
    assert.strictEqual(updateRegistry.themeOverrides({}, deps).status, "ok");
    assert.strictEqual(updateRegistry.themeOverrides("nope", deps).status, "error");
  });

  it("tgApproval validates the settings object while allowing incomplete saved config", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.tgApproval({
      enabled: false,
      allowedTgUserId: "",
      targetSessionKey: "",
    }, deps).status, "ok");
    assert.strictEqual(updateRegistry.tgApproval({
      enabled: true,
      allowedTgUserId: "123456789",
      targetSessionKey: "telegram:987654321",
    }, deps).status, "ok");
    assert.strictEqual(updateRegistry.tgApproval({
      enabled: true,
      allowedTgUserId: "",
      targetSessionKey: "telegram:987654321",
    }, deps).status, "ok");
    assert.strictEqual(updateRegistry.tgApproval({
      enabled: true,
      allowedTgUserId: "123456789",
      targetSessionKey: "telegram:0",
    }, deps).status, "error");
    assert.strictEqual(updateRegistry.tgApproval({
      enabled: true,
      allowedTgUserId: "123456789",
      targetSessionKey: "telegram:987654321",
      completionOutputMode: "full",
      r3DirectSendEnabled: true,
    }, deps).status, "ok");
    assert.strictEqual(updateRegistry.tgApproval({
      enabled: true,
      allowedTgUserId: "123456789",
      targetSessionKey: "telegram:987654321",
      completionOutputMode: "summary",
    }, deps).status, "error");
  });

  it("feishuApproval is command-only while its validator remains available for defensive checks", () => {
    const current = baseSnapshot.feishuApproval;
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(updateRegistry.feishuApproval.commandOnly, true);
    assert.strictEqual(typeof updateRegistry.feishuApproval.validate, "function");
    assert.strictEqual(updateRegistry.feishuApproval.validate({
      ...current,
      enabled: true,
    }, deps).status, "ok");
    assert.strictEqual(updateRegistry.feishuApproval.validate({
      ...current,
      platform: "lark",
      connectionTimeoutSeconds: 30,
    }, deps).status, "ok");
    for (const patch of [
      { idType: "user_id" },
      { approverId: "ou_forged" },
      { approverId: ` ${current.approverId} ` },
      { approverSource: "manual" },
      { approverBoundPlatform: "lark" },
      { approverBoundAppId: "cli_forged" },
    ]) {
      const result = updateRegistry.feishuApproval.validate({ ...current, ...patch }, deps);
      assert.strictEqual(result.status, "error");
      assert.strictEqual(result.code, "approver-command-required");
    }
    assert.strictEqual(updateRegistry.feishuApproval.validate({
      ...current,
      connectionTimeoutSeconds: 999,
      appSecret: "should-not-live-in-prefs",
    }, deps).status, "error");
  });


  it("sessionAliases requires a plain object of valid alias entries", () => {
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(
      updateRegistry.sessionAliases({ "local|codex|s1": { title: "Codex", updatedAt: 100 } }, deps).status,
      "ok"
    );
    assert.strictEqual(updateRegistry.sessionAliases({}, deps).status, "ok");
    assert.strictEqual(updateRegistry.sessionAliases([], deps).status, "error");
    assert.strictEqual(
      updateRegistry.sessionAliases({ "local|codex|s1": { title: "", updatedAt: 100 } }, deps).status,
      "error"
    );
  });

  it("shortcuts commit validator accepts only known keys with string/null values", () => {
    const entry = updateRegistry.shortcuts;
    const deps = { snapshot: baseSnapshot };
    assert.strictEqual(typeof entry, "object");
    assert.strictEqual(entry.validate({
      togglePet: "CommandOrControl+Shift+Alt+C",
      permissionAllow: null,
    }, deps).status, "ok");
    assert.strictEqual(entry.validate({ bogus: "Ctrl+K" }, deps).status, "error");
    assert.strictEqual(entry.validate({ togglePet: 42 }, deps).status, "error");
  });
});

describe("object-form effects (agent auto-start / manageClaudeHooksAutomatically / openAtLogin)", () => {
  it("autoStartWithClaude effect calls installAutoStart on true", async () => {
    // installAutoStart/uninstallAutoStart go through the server-owned Claude
    // hook operation queue (#657) and now return a Promise.
    let installCalls = 0;
    let uninstallCalls = 0;
    const deps = {
      installAutoStart: () => installCalls++,
      uninstallAutoStart: () => uninstallCalls++,
    };
    const r = await updateRegistry.autoStartWithClaude.effect(true, deps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(installCalls, 1);
    assert.strictEqual(uninstallCalls, 0);
  });

  it("autoStartWithClaude effect calls uninstallAutoStart on false", async () => {
    let installCalls = 0;
    let uninstallCalls = 0;
    const deps = {
      installAutoStart: () => installCalls++,
      uninstallAutoStart: () => uninstallCalls++,
    };
    const r = await updateRegistry.autoStartWithClaude.effect(false, deps);
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

  it("autoStartWithClaude effect noops when Claude hook management is disabled", () => {
    let installCalls = 0;
    let uninstallCalls = 0;
    const deps = {
      snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: false },
      installAutoStart: () => installCalls++,
      uninstallAutoStart: () => uninstallCalls++,
    };
    const r = updateRegistry.autoStartWithClaude.effect(true, deps);
    assert.deepStrictEqual(r, { status: "ok", noop: true });
    assert.strictEqual(installCalls, 0);
    assert.strictEqual(uninstallCalls, 0);
  });

  it("autoStartWithCodex effect writes only a fail-closed gate before commit", () => {
    const writes = [];
    const r = updateRegistry.autoStartWithCodex.effect(true, {
      writeCodexAutoStartGate: (enabled) => {
        writes.push(enabled);
        return true;
      },
    });
    assert.deepStrictEqual(r, { status: "ok" });
    assert.deepStrictEqual(writes, [false]);
  });

  it("manageClaudeHooksAutomatically effect waits for async sync before starting watcher on true", async () => {
    let syncCalls = 0;
    let startCalls = 0;
    let stopCalls = 0;
    const calls = [];
    const deps = {
      syncClaudeHooksNow: async () => {
        syncCalls++;
        calls.push("sync:start");
        await new Promise((resolve) => setTimeout(resolve, 5));
        calls.push("sync:end");
      },
      startClaudeSettingsWatcher: () => {
        startCalls++;
        calls.push("watcher:start");
      },
      stopClaudeSettingsWatcher: () => stopCalls++,
    };
    const r = await updateRegistry.manageClaudeHooksAutomatically.effect(true, deps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(syncCalls, 1);
    assert.strictEqual(startCalls, 1);
    assert.strictEqual(stopCalls, 0);
    assert.deepStrictEqual(calls, ["sync:start", "sync:end", "watcher:start"]);
  });

  it("manageClaudeHooksAutomatically effect skips side effects on true when Claude Code is disabled", async () => {
    let syncCalls = 0;
    let startCalls = 0;
    let stopCalls = 0;
    const snapshot = prefs.getDefaults();
    snapshot.agents["claude-code"].enabled = false;
    const deps = {
      snapshot,
      syncClaudeHooksNow: () => syncCalls++,
      startClaudeSettingsWatcher: () => startCalls++,
      stopClaudeSettingsWatcher: () => stopCalls++,
    };
    const r = await updateRegistry.manageClaudeHooksAutomatically.effect(true, deps);
    assert.deepStrictEqual(r, { status: "ok" });
    assert.strictEqual(syncCalls, 0);
    assert.strictEqual(startCalls, 0);
    assert.strictEqual(stopCalls, 0);
  });

  it("manageClaudeHooksAutomatically effect stops watcher on false", async () => {
    let syncCalls = 0;
    let startCalls = 0;
    let stopCalls = 0;
    const deps = {
      syncClaudeHooksNow: () => syncCalls++,
      startClaudeSettingsWatcher: () => startCalls++,
      stopClaudeSettingsWatcher: () => stopCalls++,
    };
    const r = await updateRegistry.manageClaudeHooksAutomatically.effect(false, deps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(syncCalls, 0);
    assert.strictEqual(startCalls, 0);
    assert.strictEqual(stopCalls, 1);
  });

  it("manageClaudeHooksAutomatically effect returns error when deps missing", () => {
    const r = updateRegistry.manageClaudeHooksAutomatically.effect(true, {});
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /syncClaudeHooksNow/);
  });

  it("manageClaudeHooksAutomatically effect returns error and does not start watcher when async sync fails", async () => {
    let startCalls = 0;
    const deps = {
      syncClaudeHooksNow: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error("spawn failed");
      },
      startClaudeSettingsWatcher: () => { startCalls++; },
      stopClaudeSettingsWatcher: () => {},
    };
    const r = await updateRegistry.manageClaudeHooksAutomatically.effect(true, deps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /spawn failed/);
    assert.strictEqual(startCalls, 0);
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

describe("telegram approval commands", () => {
  it("telegramApproval.setToken validates token and delegates storage", async () => {
    const calls = [];
    const token = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_jklmnop";
    const result = await commandRegistry["telegramApproval.setToken"]({ token }, {
      writeTelegramApprovalToken: (value) => {
        calls.push(value);
        return { status: "ok", tokenStored: true };
      },
    });
    assert.deepStrictEqual(calls, [token]);
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.tokenStored, true);

    const bad = await commandRegistry["telegramApproval.setToken"]({ token: "nope" }, {
      writeTelegramApprovalToken: () => {
        throw new Error("should not write invalid token");
      },
    });
    assert.strictEqual(bad.status, "error");
  });

  it("telegramApproval.status and .test proxy injected runtime helpers", async () => {
    const status = await commandRegistry["telegramApproval.status"](null, {
      getTelegramApprovalStatus: () => ({ status: "running", tokenStored: true }),
    });
    assert.deepStrictEqual(status, {
      status: "ok",
      state: { status: "running", tokenStored: true },
    });

    const testResult = await commandRegistry["telegramApproval.test"](null, {
      sendTelegramApprovalTest: async () => ({ status: "ok", decision: "allow" }),
    });
    assert.deepStrictEqual(testResult, { status: "ok", decision: "allow" });
  });

  it("telegramApproval.tokenInfo returns the masked preview without the raw token", async () => {
    const result = await commandRegistry["telegramApproval.tokenInfo"](null, {
      getTelegramApprovalTokenInfo: () => ({ configured: true, masked: "1234……wXyZ" }),
    });
    assert.deepStrictEqual(result, { status: "ok", configured: true, masked: "1234……wXyZ" });

    const empty = await commandRegistry["telegramApproval.tokenInfo"](null, {
      getTelegramApprovalTokenInfo: () => ({ configured: false, masked: "" }),
    });
    assert.deepStrictEqual(empty, { status: "ok", configured: false, masked: "" });

    const missing = await commandRegistry["telegramApproval.tokenInfo"](null, {});
    assert.equal(missing.status, "error");
  });

  it("telegramMigration.dispatch only accepts renderer-callable user events", async () => {
    const calls = [];
    const deps = {
      telegramMigration: {
        getSnapshot: () => ({ state: "TESTING_NATIVE" }),
        dispatch: async (event) => {
          calls.push(event);
          return { ok: true, state: "TESTING_NATIVE" };
        },
      },
    };

    const allowed = await commandRegistry["telegramMigration.dispatch"](
      { type: "USER_TEST_NATIVE" },
      deps,
    );
    assert.strictEqual(allowed.status, "ok");
    assert.deepStrictEqual(calls, [{ type: "USER_TEST_NATIVE" }]);

    const blocked = await commandRegistry["telegramMigration.dispatch"](
      { type: "TEST_SUCCESS", at: 123 },
      deps,
    );
    assert.strictEqual(blocked.status, "error");
    assert.strictEqual(blocked.errorCode, "EVENT_NOT_ALLOWED");
    assert.deepStrictEqual(calls, [{ type: "USER_TEST_NATIVE" }]);
  });
});

describe("feishu approval commands", () => {
  it("saveFeishuApproverByEmail uses saved authority and returns only the final result", async () => {
    for (const platform of ["feishu", "lark"]) {
      const controller = new AbortController();
      const appId = `cli_${platform}`;
      const transportCalls = [];
      const commitCalls = [];
      const result = await saveFeishuApproverByEmail({
        email: "  ou_admin@example.com  ",
        signal: controller.signal,
        platform: platform === "feishu" ? "lark" : "feishu",
        appId: "renderer-app-id",
        appSecret: "renderer-secret",
      }, {
        getFeishuApprovalPrefs: () => ({
          ...prefs.getDefaults().feishuApproval,
          platform,
        }),
        getFeishuApprovalSecrets: () => ({
          credentialPlatform: platform,
          appId,
          appSecret: "saved-secret",
        }),
        getFeishuApprovalSecretsRevision: () => 7,
        lookupFeishuApproverByEmail: async (payload) => {
          transportCalls.push(payload);
          return { status: "ok", approverId: "  ou_resolved  " };
        },
        commitResolvedApprover: async (payload) => {
          commitCalls.push(payload);
          return { status: "ok", approverId: "must-not-escape", message: "must-not-escape" };
        },
      });

      assert.deepStrictEqual(transportCalls, [{
        platform,
        appId,
        appSecret: "saved-secret",
        email: "ou_admin@example.com",
        signal: controller.signal,
      }]);
      assert.deepStrictEqual(commitCalls, [{
        signal: controller.signal,
        approverId: "ou_resolved",
        platform,
        appId,
        secretsRevision: 7,
      }]);
      assert.deepStrictEqual(result, { status: "ok" });
    }
  });

  it("saveFeishuApproverByEmail rejects thenable saved configuration before lookup", async () => {
    let transports = 0;
    let commits = 0;
    const result = await saveFeishuApproverByEmail({
      email: "person@example.com",
      signal: new AbortController().signal,
    }, {
      getFeishuApprovalPrefs: () => Promise.resolve({
        ...prefs.getDefaults().feishuApproval,
        platform: "feishu",
      }),
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_saved",
        appSecret: "saved-secret",
      }),
      getFeishuApprovalSecretsRevision: () => 7,
      lookupFeishuApproverByEmail: async () => {
        transports += 1;
        return { status: "ok", approverId: "ou_resolved" };
      },
      commitResolvedApprover: async () => {
        commits += 1;
        return { status: "ok" };
      },
    });

    assert.deepStrictEqual(result, { status: "error", code: "lookup-failed" });
    assert.equal(transports, 0);
    assert.equal(commits, 0);
  });

  it("saveFeishuApproverByEmail fails closed before commit and strips transport detail", async () => {
    let transports = 0;
    let commits = 0;
    const baseDeps = {
      getFeishuApprovalPrefs: () => ({
        ...prefs.getDefaults().feishuApproval,
        platform: "feishu",
      }),
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_saved",
        appSecret: "saved-secret",
      }),
      getFeishuApprovalSecretsRevision: () => 7,
      lookupFeishuApproverByEmail: async () => {
        transports += 1;
        return {
          status: "error",
          code: "missing-contact-scope",
          message: "raw email=person@example.com secret=saved-secret",
          approverId: "ou_must_not_escape",
        };
      },
      commitResolvedApprover: async () => {
        commits += 1;
        return { status: "ok" };
      },
    };

    assert.deepStrictEqual(await saveFeishuApproverByEmail({
      email: "not-an-email",
      signal: new AbortController().signal,
    }, baseDeps), { status: "error", code: "invalid-email" });
    assert.equal(transports, 0);

    assert.deepStrictEqual(await saveFeishuApproverByEmail({
      email: "person@example.com",
      signal: new AbortController().signal,
    }, {
      ...baseDeps,
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "lark",
        appId: "cli_saved",
        appSecret: "saved-secret",
      }),
    }), { status: "error", code: "credential-platform-mismatch" });
    assert.equal(transports, 0);

    const transportFailure = await saveFeishuApproverByEmail({
      email: "person@example.com",
      signal: new AbortController().signal,
    }, baseDeps);
    assert.deepStrictEqual(transportFailure, {
      status: "error",
      code: "missing-contact-scope",
    });
    assert.doesNotMatch(JSON.stringify(transportFailure), /person@example\.com|saved-secret|ou_must_not_escape/);
    assert.equal(transports, 1);
    assert.equal(commits, 0);
  });

  it("saveFeishuApproverByEmail does not commit a result after cancellation", async () => {
    const transport = {};
    transport.promise = new Promise((resolve) => { transport.resolve = resolve; });
    const abort = new AbortController();
    let commits = 0;
    const pending = saveFeishuApproverByEmail({
      email: "person@example.com",
      signal: abort.signal,
    }, {
      getFeishuApprovalPrefs: () => ({
        ...prefs.getDefaults().feishuApproval,
        platform: "feishu",
      }),
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_saved",
        appSecret: "saved-secret",
      }),
      getFeishuApprovalSecretsRevision: () => 7,
      lookupFeishuApproverByEmail: () => transport.promise,
      commitResolvedApprover: () => {
        commits += 1;
        return { status: "ok" };
      },
    });
    abort.abort();
    transport.resolve({ status: "ok", approverId: "ou_too_late" });

    assert.deepStrictEqual(await pending, { status: "error", code: "lookup-cancelled" });
    assert.equal(commits, 0);
  });

  it("saveFeishuApproverByEmail sanitizes a rejected internal commit", async () => {
    const result = await saveFeishuApproverByEmail({
      email: "person@example.com",
      signal: new AbortController().signal,
    }, {
      getFeishuApprovalPrefs: () => ({
        ...prefs.getDefaults().feishuApproval,
        platform: "feishu",
      }),
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_saved",
        appSecret: "saved-secret",
      }),
      getFeishuApprovalSecretsRevision: () => 7,
      lookupFeishuApproverByEmail: async () => ({ status: "ok", approverId: "ou_resolved" }),
      commitResolvedApprover: async () => { throw new Error("raw persistence detail"); },
    });
    assert.deepStrictEqual(result, { status: "error", code: "lookup-failed" });
  });

  it("commitResolvedApprover merges only approver fields into the latest locked snapshot", () => {
    const signal = new AbortController().signal;
    const current = {
      ...prefs.getDefaults().feishuApproval,
      enabled: true,
      platform: "lark",
      connectionTimeoutSeconds: 60,
      idType: "union_id",
      approverId: "union_old",
      approverSource: "manual",
      approverBoundPlatform: "lark",
      approverBoundAppId: "cli_saved",
    };
    const action = commandRegistry["feishuApproval.commitResolvedApprover"];
    const result = action({
      signal,
      approverId: "  ou_new  ",
      platform: "lark",
      appId: "cli_saved",
      secretsRevision: 11,
    }, {
      snapshot: { ...prefs.getDefaults(), feishuApproval: current },
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "lark",
        appId: "cli_saved",
        appSecret: "saved-secret",
      }),
      getFeishuApprovalSecretsRevision: () => 11,
    });

    assert.deepStrictEqual(result, {
      status: "ok",
      commit: {
        feishuApproval: {
          ...current,
          idType: "open_id",
          approverId: "ou_new",
          approverSource: "lookup",
          approverBoundPlatform: "lark",
          approverBoundAppId: "cli_saved",
        },
      },
    });
    assert.strictEqual(action.lockKey, "feishuApproval");
  });

  it("commitResolvedApprover rejects cancellation and changed saved identity without a commit", () => {
    const current = {
      ...prefs.getDefaults().feishuApproval,
      platform: "feishu",
    };
    const baseDeps = {
      snapshot: { ...prefs.getDefaults(), feishuApproval: current },
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_saved",
        appSecret: "saved-secret",
      }),
      getFeishuApprovalSecretsRevision: () => 3,
    };
    const action = commandRegistry["feishuApproval.commitResolvedApprover"];
    const aborted = new AbortController();
    aborted.abort();

    for (const [payload, expectedCode] of [
      [{ signal: null, approverId: "ou_new", platform: "feishu", appId: "cli_saved", secretsRevision: 3 }, "lookup-failed"],
      [{ signal: new AbortController().signal, approverId: "  ", platform: "feishu", appId: "cli_saved", secretsRevision: 3 }, "lookup-failed"],
      [{ signal: aborted.signal, approverId: "ou_new", platform: "feishu", appId: "cli_saved", secretsRevision: 3 }, "lookup-cancelled"],
      [{ signal: new AbortController().signal, approverId: "ou_new", platform: "lark", appId: "cli_saved", secretsRevision: 3 }, "lookup-credentials-changed"],
      [{ signal: new AbortController().signal, approverId: "ou_new", platform: "feishu", appId: "cli_other", secretsRevision: 3 }, "lookup-credentials-changed"],
      [{ signal: new AbortController().signal, approverId: "ou_new", platform: "feishu", appId: "cli_saved", secretsRevision: 4 }, "lookup-credentials-changed"],
    ]) {
      const result = action(payload, baseDeps);
      assert.deepStrictEqual(result, { status: "error", code: expectedCode });
      assert.strictEqual("commit" in result, false);
    }

    for (const deps of [
      { ...baseDeps, getFeishuApprovalSecrets: () => Promise.resolve({}) },
      { ...baseDeps, getFeishuApprovalSecretsRevision: () => Promise.resolve(3) },
    ]) {
      const result = action({
        signal: new AbortController().signal,
        approverId: "ou_new",
        platform: "feishu",
        appId: "cli_saved",
        secretsRevision: 3,
      }, deps);
      assert.deepStrictEqual(result, { status: "error", code: "credentials-read-failed" });
      assert.strictEqual("commit" in result, false);
    }
  });

  it("feishuApproval.updateConfig accepts only allowlisted field patches from the latest snapshot", () => {
    const current = {
      ...prefs.getDefaults().feishuApproval,
      enabled: false,
      platform: "lark",
      connectionTimeoutSeconds: 15,
      idType: "open_id",
      approverId: "ou_authoritative",
      approverSource: "lookup",
      approverBoundPlatform: "lark",
      approverBoundAppId: "cli_latest",
    };
    const action = commandRegistry["feishuApproval.updateConfig"];
    assert.equal(typeof action, "function");
    assert.deepEqual(action({ enabled: true, connectionTimeoutSeconds: 30 }, {
      snapshot: { ...prefs.getDefaults(), feishuApproval: current },
    }), {
      status: "ok",
      commit: {
        feishuApproval: {
          ...current,
          enabled: true,
          connectionTimeoutSeconds: 30,
        },
      },
    });

    for (const forbidden of [
      { idType: "user_id" },
      { approverId: "ou_forged" },
      { approverSource: "manual" },
      { approverBoundPlatform: "feishu" },
      { approverBoundAppId: "cli_forged" },
      { appId: "cli_forged" },
      { appSecret: "secret-forbidden" },
      { arbitrary: true },
    ]) {
      const result = action(forbidden, {
        snapshot: { ...prefs.getDefaults(), feishuApproval: current },
      });
      assert.equal(result.status, "error");
      assert.equal("commit" in result, false);
    }
  });

  it("feishuApproval.setSecrets derives credential platform and merges only within the saved identity", async () => {
    const calls = [];
    const saved = {
      credentialPlatform: "feishu",
      appId: "cli_123",
      appSecret: "old-secret",
      verificationToken: "verify",
      encryptKey: "encrypt",
    };
    const result = await commandRegistry["feishuApproval.setSecrets"]({
      credentialPlatform: "lark",
      appSecret: "new-secret",
    }, {
      snapshot: {
        ...prefs.getDefaults(),
        feishuApproval: { ...prefs.getDefaults().feishuApproval, platform: "feishu" },
      },
      getFeishuApprovalSecrets: () => saved,
      writeFeishuApprovalSecrets: (value) => {
        calls.push(value);
        return { status: "ok", secretsStored: true };
      },
    });
    assert.deepStrictEqual(calls, [{ ...saved, appSecret: "new-secret" }]);
    assert.deepStrictEqual(result, { status: "ok", secretsStored: true });
  });

  it("feishuApproval.setSecrets requires confirmation before replacement and writes nothing", async () => {
    let writes = 0;
    const result = await commandRegistry["feishuApproval.setSecrets"]({
      appId: "cli_lark",
      appSecret: "lark-secret",
    }, {
      snapshot: {
        ...prefs.getDefaults(),
        feishuApproval: { ...prefs.getDefaults().feishuApproval, platform: "lark" },
      },
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_feishu",
        appSecret: "feishu-secret",
        verificationToken: "old-verify",
        encryptKey: "old-encrypt",
      }),
      writeFeishuApprovalSecrets: () => {
        writes += 1;
        return { status: "ok", secretsStored: true };
      },
    });
    assert.deepStrictEqual(result, {
      status: "error",
      code: "credentials-replace-confirmation-required",
    });
    assert.strictEqual(writes, 0);
    assert.strictEqual("commit" in result, false);
  });

  it("feishuApproval.setSecrets writes a confirmed replacement and clears omitted optional credentials", async () => {
    const calls = [];
    const result = await commandRegistry["feishuApproval.setSecrets"]({
      appId: "cli_lark",
      appSecret: "lark-secret",
      confirmReplace: true,
    }, {
      snapshot: {
        ...prefs.getDefaults(),
        feishuApproval: { ...prefs.getDefaults().feishuApproval, platform: "lark" },
      },
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_feishu",
        appSecret: "feishu-secret",
        verificationToken: "old-verify",
        encryptKey: "old-encrypt",
      }),
      writeFeishuApprovalSecrets: (value) => {
        calls.push(value);
        return { status: "ok", secretsStored: true };
      },
    });
    assert.deepStrictEqual(result, { status: "ok", secretsStored: true });
    assert.deepStrictEqual(calls, [{
      credentialPlatform: "lark",
      appId: "cli_lark",
      appSecret: "lark-secret",
      verificationToken: "",
      encryptKey: "",
    }]);
  });

  it("feishuApproval.setSecrets rebinds a legacy same App without clearing optional credentials", async () => {
    const calls = [];
    const result = await commandRegistry["feishuApproval.setSecrets"]({
      appId: "cli_legacy",
      appSecret: "rotated-secret",
    }, {
      snapshot: {
        ...prefs.getDefaults(),
        feishuApproval: { ...prefs.getDefaults().feishuApproval, platform: "lark" },
      },
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "unknown",
        appId: "cli_legacy",
        appSecret: "old-secret",
        verificationToken: "old-verify",
        encryptKey: "old-encrypt",
      }),
      writeFeishuApprovalSecrets: (value) => {
        calls.push(value);
        return { status: "ok", secretsStored: true };
      },
    });
    assert.deepStrictEqual(result, { status: "ok", secretsStored: true });
    assert.deepStrictEqual(calls, [{
      credentialPlatform: "lark",
      appId: "cli_legacy",
      appSecret: "rotated-secret",
      verificationToken: "old-verify",
      encryptKey: "old-encrypt",
    }]);
  });

  it("feishuApproval.setSecrets rereads and replans after replacement confirmation", async () => {
    let reads = 0;
    let current = {
      credentialPlatform: "feishu",
      appId: "cli_old",
      appSecret: "old-secret",
      verificationToken: "old-verify",
      encryptKey: "old-encrypt",
    };
    const writes = [];
    const deps = {
      snapshot: {
        ...prefs.getDefaults(),
        feishuApproval: { ...prefs.getDefaults().feishuApproval, platform: "lark" },
      },
      getFeishuApprovalSecrets: () => {
        reads += 1;
        return { ...current };
      },
      writeFeishuApprovalSecrets: (bundle) => {
        writes.push(bundle);
        return { status: "ok", secretsStored: true };
      },
    };
    const draft = { appId: "cli_target", appSecret: "target-secret" };

    assert.deepStrictEqual(
      await commandRegistry["feishuApproval.setSecrets"](draft, deps),
      { status: "error", code: "credentials-replace-confirmation-required" },
    );
    current = {
      credentialPlatform: "lark",
      appId: "cli_target",
      appSecret: "external-secret",
      verificationToken: "external-verify",
      encryptKey: "external-encrypt",
    };
    assert.deepStrictEqual(
      await commandRegistry["feishuApproval.setSecrets"]({ ...draft, confirmReplace: true }, deps),
      { status: "ok", secretsStored: true },
    );
    assert.strictEqual(reads, 2);
    assert.deepStrictEqual(writes, [{
      credentialPlatform: "lark",
      appId: "cli_target",
      appSecret: "target-secret",
      verificationToken: "external-verify",
      encryptKey: "external-encrypt",
    }]);
  });

  it("feishuApproval.setSecrets rejects thenable credential reads without writing", async () => {
    let writes = 0;
    const result = await commandRegistry["feishuApproval.setSecrets"]({
      appId: "cli_target",
      appSecret: "target-secret",
    }, {
      snapshot: {
        ...prefs.getDefaults(),
        feishuApproval: { ...prefs.getDefaults().feishuApproval, platform: "lark" },
      },
      getFeishuApprovalSecrets: () => Promise.resolve({
        credentialPlatform: "lark",
        appId: "cli_target",
        appSecret: "saved-secret",
      }),
      writeFeishuApprovalSecrets: () => {
        writes += 1;
        return { status: "ok" };
      },
    });
    assert.deepStrictEqual(result, { status: "error", code: "credentials-read-failed" });
    assert.strictEqual(writes, 0);
    assert.strictEqual("commit" in result, false);
  });

  it("feishuApproval.setSecrets rejects incomplete replacement without writing", async () => {
    let writes = 0;
    const result = await commandRegistry["feishuApproval.setSecrets"]({ appId: "cli_lark" }, {
      snapshot: {
        ...prefs.getDefaults(),
        feishuApproval: { ...prefs.getDefaults().feishuApproval, platform: "lark" },
      },
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_feishu",
        appSecret: "feishu-secret",
      }),
      writeFeishuApprovalSecrets: () => {
        writes += 1;
        return { status: "ok" };
      },
    });
    assert.deepStrictEqual(result, { status: "error", code: "credentials-replacement-incomplete" });
    assert.strictEqual(writes, 0);
  });

  it("feishuApproval.saveManualApprover binds every ID type to the latest saved identity", () => {
    for (const [idType, approverId] of [
      ["open_id", "ou_manual"],
      ["user_id", "manual-user"],
      ["union_id", "manual-union"],
    ]) {
      const current = {
        ...prefs.getDefaults().feishuApproval,
        platform: "lark",
        approverId: "preserved-before-command",
        approverSource: "unknown",
      };
      const result = commandRegistry["feishuApproval.saveManualApprover"]({ idType, approverId }, {
        snapshot: { ...prefs.getDefaults(), feishuApproval: current },
        getFeishuApprovalSecrets: () => ({
          credentialPlatform: "lark",
          appId: "cli_latest",
          appSecret: "saved-secret",
        }),
      });
      assert.deepStrictEqual(result, {
        status: "ok",
        commit: {
          feishuApproval: {
            ...current,
            idType,
            approverId,
            approverSource: "manual",
            approverBoundPlatform: "lark",
            approverBoundAppId: "cli_latest",
          },
        },
      });
    }
  });

  it("feishuApproval.saveManualApprover rejects email before reading or writing credentials", () => {
    for (const idType of ["open_id", "user_id", "union_id"]) {
      let secretReads = 0;
      const result = commandRegistry["feishuApproval.saveManualApprover"]({
        idType,
        approverId: "ou_admin@example.com",
      }, {
        snapshot: prefs.getDefaults(),
        getFeishuApprovalSecrets: () => {
          secretReads += 1;
          return {
            credentialPlatform: "feishu",
            appId: "cli_saved",
            appSecret: "saved-secret",
          };
        },
      });

      assert.deepStrictEqual(result, { status: "error", code: "email-requires-lookup" });
      assert.equal(secretReads, 0, idType);
      assert.equal("commit" in result, false, idType);
    }
  });

  it("feishuApproval.saveManualApprover rejects malformed IDs before reading credentials", () => {
    for (const [label, payload, expectedCode] of [
      ["bad open_id prefix", { idType: "open_id", approverId: "not-an-open-id" }, "invalid-email"],
      ["open_id newline", { idType: "open_id", approverId: "ou_a\nb" }, "invalid-approver-id"],
      ["open_id NBSP", { idType: "open_id", approverId: "ou_a\u00a0b" }, "invalid-approver-id"],
      ["open_id zero-width", { idType: "open_id", approverId: "ou_\u200b" }, "invalid-approver-id"],
      ["open_id control", { idType: "open_id", approverId: "ou_a\u0007b" }, "invalid-approver-id"],
      ["bare open_id prefix", { idType: "open_id", approverId: "ou_" }, "invalid-approver-id"],
      ["user_id whitespace", { idType: "user_id", approverId: "user id" }, "invalid-approver-id"],
      ["empty", { idType: "open_id", approverId: "" }, "missing-approver"],
      ["whitespace-only", { idType: "open_id", approverId: "   " }, "missing-approver"],
      ["too long", { idType: "open_id", approverId: `ou_${"a".repeat(126)}` }, "missing-approver"],
      ["bad id type", { idType: "tenant_key", approverId: "value" }, "invalid-id-type"],
    ]) {
      let secretReads = 0;
      const result = commandRegistry["feishuApproval.saveManualApprover"](payload, {
        snapshot: prefs.getDefaults(),
        getFeishuApprovalSecrets: () => {
          secretReads += 1;
          return {
            credentialPlatform: "feishu",
            appId: "cli_saved",
            appSecret: "saved-secret",
          };
        },
      });

      assert.deepStrictEqual(result, { status: "error", code: expectedCode }, label);
      assert.equal(secretReads, 0, label);
      assert.equal("commit" in result, false, label);
    }
  });

  it("feishuApproval.saveManualApprover fails closed without deleting the stored approver", () => {
    const current = {
      ...prefs.getDefaults().feishuApproval,
      approverId: "keep-this-value",
      approverSource: "unknown",
    };
    const result = commandRegistry["feishuApproval.saveManualApprover"]({
      idType: "user_id",
      approverId: "new-value",
    }, {
      snapshot: { ...prefs.getDefaults(), feishuApproval: current },
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "unknown",
        appId: "cli_legacy",
        appSecret: "saved-secret",
      }),
    });
    assert.deepStrictEqual(result, { status: "error", code: "credential-provenance-unknown" });
    assert.strictEqual(current.approverId, "keep-this-value");
    assert.strictEqual("commit" in result, false);
  });

  it("all Feishu writers and Test declare the same settings domain lock", () => {
    assert.strictEqual(updateRegistry.feishuApproval.lockKey, "feishuApproval");
    for (const name of [
      "feishuApproval.setSecrets",
      "feishuApproval.saveManualApprover",
      "feishuApproval.commitResolvedApprover",
      "feishuApproval.updateConfig",
      "feishuApproval.test",
    ]) {
      assert.strictEqual(commandRegistry[name].lockKey, "feishuApproval", name);
    }
  });

  it("feishuApproval.setSecrets reports a missing storage boundary", async () => {
    const secrets = { appId: "cli_123", appSecret: "secret" };

    const missing = await commandRegistry["feishuApproval.setSecrets"](secrets, {
      snapshot: prefs.getDefaults(),
      getFeishuApprovalSecrets: () => ({}),
    });
    assert.equal(missing.status, "error");
  });

  it("feishuApproval.status, secretInfo, and test proxy injected runtime helpers", async () => {
    const status = await commandRegistry["feishuApproval.status"](null, {
      getFeishuApprovalStatus: () => ({ status: "running", configured: true, secretsStored: true }),
    });
    assert.deepStrictEqual(status, {
      status: "ok",
      state: { status: "running", configured: true, secretsStored: true },
    });

    const info = await commandRegistry["feishuApproval.secretInfo"](null, {
      getFeishuApprovalSecretInfo: () => ({
        configured: true,
        appId: "cli_......1234",
        appSecret: "secr......alue",
      }),
    });
    assert.deepStrictEqual(info, {
      status: "ok",
      configured: true,
      appId: "cli_......1234",
      appSecret: "secr......alue",
    });

    const coherentSnapshots = [];
    const feishuApproval = {
      ...prefs.getDefaults().feishuApproval,
      enabled: true,
      approverId: "ou_saved",
      approverSource: "lookup",
      approverBoundPlatform: "feishu",
      approverBoundAppId: "cli_saved",
    };
    const testResult = await commandRegistry["feishuApproval.test"](null, {
      snapshot: { ...prefs.getDefaults(), feishuApproval },
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "feishu",
        appId: "cli_saved",
        appSecret: "saved-secret",
      }),
      getFeishuApprovalSecretsRevision: () => 11,
      sendFeishuApprovalTest: async (persisted) => {
        coherentSnapshots.push(persisted);
        return { status: "ok", decision: "deny" };
      },
    });
    assert.deepStrictEqual(testResult, { status: "ok", decision: "deny" });
    assert.deepStrictEqual(coherentSnapshots, [{
      config: feishuApproval,
      secrets: {
        credentialPlatform: "feishu",
        appId: "cli_saved",
        appSecret: "saved-secret",
      },
      secretsRevision: 11,
    }]);

    let sends = 0;
    const mismatched = await commandRegistry["feishuApproval.test"](null, {
      snapshot: { ...prefs.getDefaults(), feishuApproval },
      getFeishuApprovalSecrets: () => ({
        credentialPlatform: "lark",
        appId: "cli_saved",
        appSecret: "saved-secret",
      }),
      sendFeishuApprovalTest: async () => { sends += 1; return { status: "ok" }; },
    });
    assert.deepStrictEqual(mismatched, { status: "error", code: "credential-platform-mismatch" });
    assert.equal(sends, 0);
  });
});

describe("bubble policy commands", () => {
  it("setBubbleCategoryEnabled toggles notification and update defaults", async () => {
    const snapshot = prefs.getDefaults();
    const offNotify = await commandRegistry.setBubbleCategoryEnabled(
      { category: "notification", enabled: false },
      { snapshot }
    );
    assert.strictEqual(offNotify.status, "ok");
    assert.strictEqual(offNotify.commit.notificationBubbleAutoCloseSeconds, 0);
    assert.strictEqual(offNotify.commit.hideBubbles, false);

    const onUpdate = await commandRegistry.setBubbleCategoryEnabled(
      { category: "update", enabled: true },
      { snapshot: { ...snapshot, updateBubbleAutoCloseSeconds: 0 } }
    );
    assert.strictEqual(onUpdate.status, "ok");
    assert.strictEqual(onUpdate.commit.updateBubbleAutoCloseSeconds, 9);
  });

  it("setBubbleCategoryEnabled toggles permission without auto-close", async () => {
    const snapshot = {
      ...prefs.getDefaults(),
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 0,
      updateBubbleAutoCloseSeconds: 0,
    };
    const result = await commandRegistry.setBubbleCategoryEnabled(
      { category: "permission", enabled: false },
      { snapshot }
    );
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.commit.permissionBubblesEnabled, false);
    assert.strictEqual(result.commit.hideBubbles, true);
  });

  it("setAllBubblesHidden preserves category durations while acting as an aggregate override", async () => {
    const snapshot = {
      ...prefs.getDefaults(),
      notificationBubbleAutoCloseSeconds: 12,
      updateBubbleAutoCloseSeconds: 8,
    };
    const hidden = await commandRegistry.setAllBubblesHidden({ hidden: true }, { snapshot });
    assert.strictEqual(hidden.status, "ok");
    assert.deepStrictEqual(hidden.commit, {
      hideBubbles: true,
    });

    const shown = await commandRegistry.setAllBubblesHidden({ hidden: false }, { snapshot: { ...snapshot, hideBubbles: true } });
    assert.strictEqual(shown.status, "ok");
    assert.deepStrictEqual(shown.commit, {
      hideBubbles: false,
    });
  });

  it("setAllBubblesHidden restores defaults when every category is already off", async () => {
    const shown = await commandRegistry.setAllBubblesHidden({ hidden: false }, {
      snapshot: {
        ...prefs.getDefaults(),
        hideBubbles: true,
        permissionBubblesEnabled: false,
        notificationBubbleAutoCloseSeconds: 0,
        updateBubbleAutoCloseSeconds: 0,
      },
    });
    assert.strictEqual(shown.status, "ok");
    assert.deepStrictEqual(shown.commit, {
      hideBubbles: false,
      permissionBubblesEnabled: true,
      notificationBubbleAutoCloseSeconds: 6,
      updateBubbleAutoCloseSeconds: 9,
    });
  });
});

describe("setPermissionAutomationMode danger gate", () => {
  it("refuses auto-tools without confirmed:true (dialog is a real boundary)", async () => {
    const r = await commandRegistry.setPermissionAutomationMode({ mode: "auto-tools" }, {});
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /current or remembered confirmation/);
  });

  it("refuses either automatic mode when confirmed is falsy", async () => {
    for (const bad of [false, "true", 1, null, undefined]) {
      for (const mode of ["auto-tools", "unattended"]) {
        const r = await commandRegistry.setPermissionAutomationMode({ mode, confirmed: bad }, {});
        assert.strictEqual(r.status, "error", `${mode} confirmed=${JSON.stringify(bad)} must be rejected`);
      }
    }
  });

  it("enables both automatic modes only with explicit confirmed:true", async () => {
    for (const mode of ["auto-tools", "unattended"]) {
      const r = await commandRegistry.setPermissionAutomationMode({ mode, confirmed: true }, {});
      assert.strictEqual(r.status, "ok");
      assert.deepStrictEqual(r.commit, { permissionAutomationMode: mode });
    }
  });

  it("accepts a remembered confirmation for only its matching mode", async () => {
    const autoTools = await commandRegistry.setPermissionAutomationMode(
      { mode: "auto-tools", confirmed: false },
      { snapshot: { permissionAutomationAutoToolsWarningDismissed: true } }
    );
    assert.deepStrictEqual(autoTools.commit, { permissionAutomationMode: "auto-tools" });

    const unattended = await commandRegistry.setPermissionAutomationMode(
      { mode: "unattended", confirmed: false },
      { snapshot: { permissionAutomationAutoToolsWarningDismissed: true } }
    );
    assert.strictEqual(unattended.status, "error");
  });

  it("persists don't-show-again atomically only with a current confirmation", async () => {
    const r = await commandRegistry.setPermissionAutomationMode({
      mode: "auto-tools",
      confirmed: true,
      suppressFutureConfirmation: true,
    }, {});
    assert.deepStrictEqual(r.commit, {
      permissionAutomationMode: "auto-tools",
      permissionAutomationAutoToolsWarningDismissed: true,
    });

    const rejected = await commandRegistry.setPermissionAutomationMode({
      mode: "auto-tools",
      confirmed: false,
      suppressFutureConfirmation: true,
    }, { snapshot: { permissionAutomationAutoToolsWarningDismissed: true } });
    assert.strictEqual(rejected.status, "error");
    assert.match(rejected.message, /requires confirmed:true/);
  });

  it("rejects malformed or off-mode warning suppression", async () => {
    assert.strictEqual(
      (await commandRegistry.setPermissionAutomationMode({
        mode: "auto-tools",
        confirmed: true,
        suppressFutureConfirmation: "yes",
      }, {})).status,
      "error"
    );
    assert.strictEqual(
      (await commandRegistry.setPermissionAutomationMode({
        mode: "off",
        suppressFutureConfirmation: true,
      }, {})).status,
      "error"
    );
  });

  it("switches off immediately with no confirmation required", async () => {
    const r = await commandRegistry.setPermissionAutomationMode({ mode: "off" }, {});
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit, { permissionAutomationMode: "off" });
  });

  it("rejects an unknown mode", async () => {
    const r = await commandRegistry.setPermissionAutomationMode({ mode: "yolo", confirmed: true }, {});
    assert.strictEqual(r.status, "error");
  });
});

describe("session cleanup interval validators", () => {
  const snapshot = prefs.getDefaults();

  it("sessionStaleMs accepts 0 (disabled) regardless of workingStaleMs", () => {
    const result = updateRegistry.sessionStaleMs(0, { snapshot });
    assert.strictEqual(result.status, "ok");
  });

  it("sessionStaleMs accepts non-zero values >= current workingStaleMs", () => {
    const result = updateRegistry.sessionStaleMs(600_000, { snapshot });
    assert.strictEqual(result.status, "ok");
  });

  it("sessionStaleMs rejects values below the workingStaleMs floor", () => {
    const result = updateRegistry.sessionStaleMs(60_000, {
      snapshot: { ...snapshot, workingStaleMs: 300_000 },
    });
    assert.strictEqual(result.status, "error");
    assert.match(result.message, /workingStaleMs/);
  });

  it("sessionStaleMs rejects non-integers / out-of-range", () => {
    assert.strictEqual(updateRegistry.sessionStaleMs("nope", { snapshot }).status, "error");
    assert.strictEqual(updateRegistry.sessionStaleMs(1.5, { snapshot }).status, "error");
    assert.strictEqual(updateRegistry.sessionStaleMs(30_000, { snapshot }).status, "error");
    assert.strictEqual(updateRegistry.sessionStaleMs(90_000_000, { snapshot }).status, "error");
  });

  it("workingStaleMs rejects values above sessionStaleMs when the latter is non-zero", () => {
    const result = updateRegistry.workingStaleMs(700_000, {
      snapshot: { ...snapshot, sessionStaleMs: 600_000 },
    });
    assert.strictEqual(result.status, "error");
    assert.match(result.message, /sessionStaleMs/);
  });

  it("workingStaleMs accepts any in-range value when sessionStaleMs is 0", () => {
    const result = updateRegistry.workingStaleMs(700_000, {
      snapshot: { ...snapshot, sessionStaleMs: 0 },
    });
    assert.strictEqual(result.status, "ok");
  });

  it("workingStaleMs accepts equal to sessionStaleMs", () => {
    const result = updateRegistry.workingStaleMs(600_000, {
      snapshot: { ...snapshot, sessionStaleMs: 600_000 },
    });
    assert.strictEqual(result.status, "ok");
  });

  it("workingStaleMs rejects below floor / above ceiling", () => {
    assert.strictEqual(updateRegistry.workingStaleMs(0, { snapshot }).status, "error");
    assert.strictEqual(updateRegistry.workingStaleMs(20_000, { snapshot }).status, "error");
    assert.strictEqual(updateRegistry.workingStaleMs(90_000_000, { snapshot }).status, "error");
  });

  it("codexWorkingStaleMs accepts disabled or an independent in-range timeout", () => {
    assert.strictEqual(updateRegistry.codexWorkingStaleMs(0, { snapshot }).status, "ok");
    assert.strictEqual(updateRegistry.codexWorkingStaleMs(30_000, { snapshot }).status, "ok");
    assert.strictEqual(updateRegistry.codexWorkingStaleMs(86_400_000, { snapshot }).status, "ok");
    assert.strictEqual(updateRegistry.codexWorkingStaleMs(20_000, { snapshot }).status, "error");
    assert.strictEqual(updateRegistry.codexWorkingStaleMs(90_000_000, { snapshot }).status, "error");
  });

  it("detachedIdleStaleMs enforces 5s-300s integer range", () => {
    assert.strictEqual(updateRegistry.detachedIdleStaleMs(5_000, { snapshot }).status, "ok");
    assert.strictEqual(updateRegistry.detachedIdleStaleMs(300_000, { snapshot }).status, "ok");
    assert.strictEqual(updateRegistry.detachedIdleStaleMs(0, { snapshot }).status, "error");
    assert.strictEqual(updateRegistry.detachedIdleStaleMs(1_000, { snapshot }).status, "error");
    assert.strictEqual(updateRegistry.detachedIdleStaleMs(400_000, { snapshot }).status, "error");
  });
});

describe("sessionCleanup.setTriple command", () => {
  const cmd = commandRegistry["sessionCleanup.setTriple"];
  const baseSnapshot = prefs.getDefaults();

  it("commits a full valid triple", async () => {
    const result = await cmd(
      {
        sessionStaleMs: 600_000,
        workingStaleMs: 300_000,
        codexWorkingStaleMs: 0,
        detachedIdleStaleMs: 30_000,
      },
      { snapshot: baseSnapshot }
    );
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(result.commit, {
      sessionStaleMs: 600_000,
      workingStaleMs: 300_000,
      codexWorkingStaleMs: 0,
      detachedIdleStaleMs: 30_000,
    });
  });

  it("rejects an inverted triple (workingStaleMs > sessionStaleMs)", async () => {
    const result = await cmd(
      {
        sessionStaleMs: 120_000,
        workingStaleMs: 300_000,
        detachedIdleStaleMs: 30_000,
      },
      { snapshot: baseSnapshot }
    );
    assert.strictEqual(result.status, "error");
    assert.match(result.message, /workingStaleMs.*must be <= sessionStaleMs/);
  });

  it("accepts sessionStaleMs=0 with any in-range workingStaleMs", async () => {
    const result = await cmd(
      {
        sessionStaleMs: 0,
        workingStaleMs: 86_400_000,
        codexWorkingStaleMs: 1_200_000,
        detachedIdleStaleMs: 30_000,
      },
      { snapshot: baseSnapshot }
    );
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(result.commit, {
      sessionStaleMs: 0,
      workingStaleMs: 86_400_000,
      codexWorkingStaleMs: 1_200_000,
      detachedIdleStaleMs: 30_000,
    });
  });

  it("defaults absent fields from the snapshot", async () => {
    const snapshot = {
      ...baseSnapshot,
      sessionStaleMs: 900_000,
      workingStaleMs: 450_000,
      detachedIdleStaleMs: 45_000,
    };
    const result = await cmd({ sessionStaleMs: 600_000 }, { snapshot });
    assert.strictEqual(result.status, "ok");
    assert.deepStrictEqual(result.commit, {
      sessionStaleMs: 600_000,
      workingStaleMs: 450_000,
      codexWorkingStaleMs: 1_200_000,
      detachedIdleStaleMs: 45_000,
    });
  });

  it("rejects payload with non-integer present value (no silent snapshot fallback)", async () => {
    const result = await cmd(
      { sessionStaleMs: "600000" },
      { snapshot: baseSnapshot }
    );
    assert.strictEqual(result.status, "error");
    assert.match(result.message, /sessionStaleMs.*must be an integer/);
  });

  it("rejects out-of-range fields without committing", async () => {
    const tooSmall = await cmd(
      { sessionStaleMs: 600_000, workingStaleMs: 1_000, detachedIdleStaleMs: 30_000 },
      { snapshot: baseSnapshot }
    );
    assert.strictEqual(tooSmall.status, "error");
    assert.strictEqual(tooSmall.commit, undefined);

    const codexTooSmall = await cmd(
      { sessionStaleMs: 600_000, workingStaleMs: 300_000, codexWorkingStaleMs: 1_000, detachedIdleStaleMs: 30_000 },
      { snapshot: baseSnapshot }
    );
    assert.strictEqual(codexTooSmall.status, "error");
    assert.strictEqual(codexTooSmall.commit, undefined);

    const detTooBig = await cmd(
      { sessionStaleMs: 600_000, workingStaleMs: 300_000, detachedIdleStaleMs: 999_999 },
      { snapshot: baseSnapshot }
    );
    assert.strictEqual(detTooBig.status, "error");
    assert.strictEqual(detTooBig.commit, undefined);
  });

  it("rejects non-object payload", async () => {
    const r = await cmd(null, { snapshot: baseSnapshot });
    assert.strictEqual(r.status, "error");
  });
});

describe("hook commands", () => {
  it("installHooks triggers a one-shot Claude sync without changing prefs", async () => {
    let syncCalls = 0;
    const r = await commandRegistry.installHooks(null, {
      snapshot: prefs.getDefaults(),
      syncClaudeHooksNow: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        syncCalls++;
      },
    });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(syncCalls, 1);
    assert.strictEqual(r.commit, undefined);
  });

  it("uninstallHooks stops watcher, uninstalls hooks, and commits only manageClaudeHooksAutomatically=false", async () => {
    const calls = [];
    const r = await commandRegistry.uninstallHooks(null, {
      snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: true, autoStartWithClaude: true },
      stopClaudeSettingsWatcher: () => calls.push("stop"),
      uninstallClaudeHooksNow: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        calls.push("uninstall");
      },
      startClaudeSettingsWatcher: () => calls.push("start"),
    });
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(calls, ["stop", "uninstall"]);
    assert.deepStrictEqual(r.commit, { manageClaudeHooksAutomatically: false });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(r.commit, "autoStartWithClaude"), false);
  });

  it("uninstallHooks restores watcher on uninstall failure when management was enabled", async () => {
    const calls = [];
    const r = await commandRegistry.uninstallHooks(null, {
      snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: true },
      stopClaudeSettingsWatcher: () => calls.push("stop"),
      uninstallClaudeHooksNow: async () => {
        calls.push("uninstall");
        await new Promise((resolve) => setTimeout(resolve, 1));
        throw new Error("disk locked");
      },
      startClaudeSettingsWatcher: () => calls.push("start"),
    });
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /disk locked/);
    assert.deepStrictEqual(calls, ["stop", "uninstall", "start"]);
  });

  it("cleanupIntegrations disables all managed agents before running cleanup", async () => {
    const calls = [];
    const snapshot = prefs.getDefaults();
    snapshot.dismissedAgentInstallHints = { hermes: true };
    snapshot.dismissedAgentCleanupHints = { "qwen-code": true, hermes: true };
    assert.ok(
      MANAGED_CLEANUP_AGENT_IDS.includes("reasonix"),
      "bulk cleanup should include Reasonix hooks"
    );
    const result = await commandRegistry.cleanupIntegrations(null, {
      snapshot,
      stopIntegrationForAgent: (agentId) => calls.push(["stopIntegration", agentId]),
      stopMonitorForAgent: (agentId) => calls.push(["stopMonitor", agentId]),
      clearSessionsByAgent: (agentId) => calls.push(["clearSessions", agentId]),
      dismissPermissionsByAgent: (agentId) => calls.push(["dismissPermissions", agentId]),
      writeCodexAutoStartGate: () => true,
      cleanupIntegrations: (options) => {
        calls.push(["cleanup", options.source]);
        return {
          mode: "apply",
          summary: { agentsChecked: 15, agentsAffected: 2, entriesRemoved: 3, skipped: 13, failed: 0 },
        };
      },
    });

    assert.strictEqual(result.status, "ok");
    assert.strictEqual(commandRegistry.cleanupIntegrations.lockKey, "agentIntegration");
    assert.strictEqual(result.cleanup.summary.entriesRemoved, 3);
    for (const agentId of MANAGED_CLEANUP_AGENT_IDS) {
      assert.strictEqual(result.commit.agents[agentId].enabled, false, `${agentId} should be disabled`);
      assert.strictEqual(result.commit.agents[agentId].integrationInstalled, false, `${agentId} should be uninstalled`);
      assert.strictEqual(
        result.commit.dismissedAgentInstallHints[agentId],
        true,
        `${agentId} install hint should be dismissed after bulk cleanup`
      );
    }
    assert.deepStrictEqual(result.commit.dismissedAgentCleanupHints, {});
    assert.deepStrictEqual(calls.at(-1), ["cleanup", "about"]);
    assert.deepStrictEqual(calls[0], ["stopIntegration", "claude-code"]);
  });
});

describe("doctor repair commands", () => {
  it("repairs an enabled auto-managed agent through repairIntegrationForAgent without committing prefs", async () => {
    const calls = [];
    const r = await commandRegistry.repairAgentIntegration({ agentId: "codex" }, {
      snapshot: prefs.getDefaults(),
      repairIntegrationForAgent: (agentId, options) => calls.push({ agentId, options }),
    });

    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(calls, [{ agentId: "codex", options: { forceCodexHooksFeature: false } }]);
    assert.strictEqual(r.commit, undefined);
  });

  it("passes explicit Codex feature-force consent and surfaces repair failures", async () => {
    const calls = [];
    const r = await commandRegistry.repairAgentIntegration({
      agentId: "codex",
      forceCodexHooksFeature: true,
    }, {
      snapshot: prefs.getDefaults(),
      repairIntegrationForAgent: (agentId, options) => {
        calls.push({ agentId, options });
        return { status: "error", message: "hooks is still false" };
      },
    });

    assert.strictEqual(r.status, "error");
    assert.match(r.message, /hooks/);
    assert.deepStrictEqual(calls, [{ agentId: "codex", options: { forceCodexHooksFeature: true } }]);
  });

  it("accepts Copilot CLI through the standard auto-repair path", async () => {
    const calls = [];
    const snapshot = prefs.getDefaults();
    snapshot.agents["copilot-cli"].integrationInstalled = true;
    snapshot.agents["copilot-cli"].enabled = true;
    const r = await commandRegistry.repairAgentIntegration({ agentId: "copilot-cli" }, {
      snapshot,
      repairIntegrationForAgent: (agentId) => {
        calls.push(agentId);
        return { status: "ok", added: 10, updated: 0 };
      },
    });

    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(calls, ["copilot-cli"]);
  });

  it("does not repair disabled agents", async () => {
    const snapshot = prefs.getDefaults();
    snapshot.agents.codex = { ...snapshot.agents.codex, enabled: false };
    const calls = [];

    const r = await commandRegistry.repairAgentIntegration({ agentId: "codex" }, {
      snapshot,
      repairIntegrationForAgent: (agentId) => calls.push(agentId),
    });

    assert.strictEqual(r.status, "error");
    assert.match(r.message, /disabled/i);
    assert.deepStrictEqual(calls, []);
  });

  it("does not repair Claude hooks while automatic management is disabled", async () => {
    const calls = [];
    const r = await commandRegistry.repairAgentIntegration({ agentId: "claude-code" }, {
      snapshot: { ...prefs.getDefaults(), manageClaudeHooksAutomatically: false },
      repairIntegrationForAgent: (agentId) => calls.push(agentId),
    });

    assert.strictEqual(r.status, "error");
    assert.match(r.message, /disabled/i);
    assert.deepStrictEqual(calls, []);
  });

  it("routes Doctor permission-bubble repair through a validated commit", async () => {
    const r = await commandRegistry.repairDoctorIssue({ type: "permission-bubble-policy" }, {
      snapshot: {
        ...prefs.getDefaults(),
        hideBubbles: true,
        permissionBubblesEnabled: false,
      },
    });

    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.commit.hideBubbles, false);
    assert.strictEqual(r.commit.permissionBubblesEnabled, true);
  });

  it("routes Doctor restart-clawd repair through deps.restartClawd", async () => {
    const calls = [];
    const r = await commandRegistry.repairDoctorIssue(
      { type: "restart-clawd", confirmed: true },
      { restartClawd: () => calls.push("restart") }
    );

    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(calls, ["restart"]);
  });

  it("does not run Doctor restart-clawd repair without confirmation", async () => {
    const calls = [];
    const r = await commandRegistry.repairDoctorIssue(
      { type: "restart-clawd" },
      { restartClawd: () => calls.push("restart") }
    );

    assert.strictEqual(r.status, "error");
    assert.match(r.message, /confirmation/i);
    assert.deepStrictEqual(calls, []);
  });

  it("returns an error when restart-clawd is dispatched without deps.restartClawd", async () => {
    const r = await commandRegistry.repairDoctorIssue({ type: "restart-clawd", confirmed: true }, {});

    assert.strictEqual(r.status, "error");
    assert.match(r.message, /restartClawd/);
  });

  it("rejects Doctor theme repair so Doctor does not reset user themes", async () => {
    const calls = [];
    const r = await commandRegistry.repairDoctorIssue({ type: "theme-health" }, {
      snapshot: { ...prefs.getDefaults(), theme: "broken", themeVariant: {}, themeOverrides: {} },
      activateTheme: (themeId, variantId, overrideMap) => {
        calls.push({ themeId, variantId, overrideMap });
        return { themeId, variantId: "default" };
      },
    });

    assert.strictEqual(r.status, "error");
    assert.match(r.message, /manually/i);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(r.commit, undefined);
  });
});

describe("setSessionAlias command", () => {
  it("stores a sanitized alias under the normalized session key", () => {
    const snapshot = { ...prefs.getDefaults(), sessionAliases: {} };
    const r = commandRegistry.setSessionAlias(
      { host: null, agentId: "codex", sessionId: "s1", alias: "  Codex\nmain  " },
      { snapshot, now: 1000, getActiveSessionAliasKeys: () => new Set(["local|codex|s1"]) }
    );

    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.sessionAliases, {
      "local|codex|s1": { title: "Codex main", updatedAt: 1000 },
    });
  });

  it("stores Kiro default-session aliases under a cwd-scoped key", () => {
    const snapshot = { ...prefs.getDefaults(), sessionAliases: {} };
    const r = commandRegistry.setSessionAlias(
      { host: null, agentId: "kiro-cli", sessionId: "default", cwd: "/repo/a", alias: "Kiro A" },
      { snapshot, now: 1000, getActiveSessionAliasKeys: () => new Set(["local|kiro-cli|default|cwd:%2Frepo%2Fa"]) }
    );

    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.sessionAliases, {
      "local|kiro-cli|default|cwd:%2Frepo%2Fa": { title: "Kiro A", updatedAt: 1000 },
    });
  });

  it("clears an existing alias when alias is empty", () => {
    const snapshot = {
      ...prefs.getDefaults(),
      sessionAliases: { "local|codex|s1": { title: "Codex main", updatedAt: 1000 } },
    };
    const r = commandRegistry.setSessionAlias(
      { host: "local", agentId: "codex", sessionId: "s1", alias: "   " },
      { snapshot, now: 2000, getActiveSessionAliasKeys: () => new Set(["local|codex|s1"]) }
    );

    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.sessionAliases, {});
  });

  it("returns noop when the alias value is unchanged", () => {
    const snapshot = {
      ...prefs.getDefaults(),
      sessionAliases: { "local|codex|s1": { title: "Codex main", updatedAt: 1000 } },
    };
    const r = commandRegistry.setSessionAlias(
      { host: null, agentId: "codex", sessionId: "s1", alias: "Codex main" },
      { snapshot, now: 2000, getActiveSessionAliasKeys: () => new Set(["local|codex|s1"]) }
    );

    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.noop, true);
  });

  it("prunes expired inactive aliases even when the requested alias is unchanged", () => {
    const old = 1000;
    const now = old + 8 * 24 * 60 * 60 * 1000;
    const snapshot = {
      ...prefs.getDefaults(),
      sessionAliases: {
        "local|codex|s1": { title: "Codex main", updatedAt: old },
        "local|codex|stale": { title: "Stale", updatedAt: old },
      },
    };
    const r = commandRegistry.setSessionAlias(
      { host: null, agentId: "codex", sessionId: "s1", alias: "Codex main" },
      { snapshot, now, getActiveSessionAliasKeys: () => new Set(["local|codex|s1"]) }
    );

    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.sessionAliases, {
      "local|codex|s1": { title: "Codex main", updatedAt: old },
    });
  });

  it("rejects missing sessionId or non-string alias", () => {
    const deps = { snapshot: prefs.getDefaults() };
    assert.strictEqual(
      commandRegistry.setSessionAlias({ host: null, agentId: "codex", sessionId: "", alias: "x" }, deps).status,
      "error"
    );
    assert.strictEqual(
      commandRegistry.setSessionAlias({ host: null, agentId: "codex", sessionId: "s1", alias: 42 }, deps).status,
      "error"
    );
  });
});

describe("shortcut commands", () => {
  function makeShortcutDeps(overrides = {}) {
    const snapshot = overrides.snapshot || prefs.getDefaults();
    const registered = new Set(overrides.registered || []);
    const failures = new Map(Object.entries(overrides.failures || {}));
    const calls = { register: [], unregister: [] };
    const globalShortcut = {
      register(accelerator, handler) {
        calls.register.push({ accelerator, handler });
        if (overrides.failRegister && overrides.failRegister.has(accelerator)) {
          return false;
        }
        registered.add(accelerator);
        return true;
      },
      unregister(accelerator) {
        calls.unregister.push(accelerator);
        if (overrides.throwOnUnregister === accelerator) {
          throw new Error("unregister boom");
        }
        if (overrides.stubbornUnregister === accelerator) return;
        registered.delete(accelerator);
      },
      isRegistered(accelerator) {
        return registered.has(accelerator);
      },
    };
    return {
      deps: {
        snapshot,
        globalShortcut,
        shortcutHandlers: {
          togglePet: () => {},
          quickSelectSession: () => {},
          permissionAllow: () => {},
          permissionDeny: () => {},
        },
        getShortcutFailure: (actionId) => failures.get(actionId) || null,
        clearShortcutFailure: (actionId) => failures.delete(actionId),
      },
      calls,
      registered,
      failures,
    };
  }

  it("registerShortcut commits persistent shortcuts after register-new/unregister-old", () => {
    const snapshot = prefs.validate({
      shortcuts: {
        togglePet: "Ctrl+J",
      },
    });
    const { deps, calls, registered } = makeShortcutDeps({
      snapshot,
      registered: [snapshot.shortcuts.togglePet],
    });
    const r = commandRegistry.registerShortcut({
      actionId: "togglePet",
      accelerator: "Ctrl+K",
    }, deps);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.shortcuts, {
      ...snapshot.shortcuts,
      togglePet: "CommandOrControl+K",
    });
    assert.deepStrictEqual(calls.register.map((c) => c.accelerator), ["CommandOrControl+K"]);
    assert.deepStrictEqual(calls.unregister, ["CommandOrControl+J"]);
    assert.deepStrictEqual([...registered].sort(), ["CommandOrControl+K"]);
  });

  it("registerShortcut rejects internal conflicts before touching globalShortcut", () => {
    const snapshot = prefs.getDefaults();
    const { deps, calls } = makeShortcutDeps({ snapshot });
    const r = commandRegistry.registerShortcut({
      actionId: "togglePet",
      accelerator: snapshot.shortcuts.permissionAllow,
    }, deps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /already bound to permissionAllow/);
    assert.deepStrictEqual(calls.register, []);
    assert.deepStrictEqual(calls.unregister, []);
  });

  it("registerShortcut rejects invalid and dangerous accelerators", () => {
    const { deps } = makeShortcutDeps();
    const invalid = commandRegistry.registerShortcut({
      actionId: "togglePet",
      accelerator: "bad-value",
    }, deps);
    assert.strictEqual(invalid.status, "error");
    assert.match(invalid.message, /invalid accelerator format/);

    const dangerous = commandRegistry.registerShortcut({
      actionId: "togglePet",
      accelerator: "Ctrl+C",
    }, deps);
    assert.strictEqual(dangerous.status, "error");
    assert.match(dangerous.message, /reserved accelerator/);
  });

  it("registerShortcut short-circuits idempotent writes", () => {
    const snapshot = prefs.getDefaults();
    const { deps, calls } = makeShortcutDeps({ snapshot });
    const r = commandRegistry.registerShortcut({
      actionId: "togglePet",
      accelerator: snapshot.shortcuts.togglePet,
    }, deps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.noop, true);
    assert.deepStrictEqual(calls.register, []);
    assert.deepStrictEqual(calls.unregister, []);
  });

  it("registerShortcut retries same persistent value when a runtime failure exists", () => {
    const snapshot = prefs.getDefaults();
    const { deps, calls, failures, registered } = makeShortcutDeps({
      snapshot,
      failures: { togglePet: "system conflict" },
    });
    const r = commandRegistry.registerShortcut({
      actionId: "togglePet",
      accelerator: snapshot.shortcuts.togglePet,
    }, deps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.noop, true);
    assert.deepStrictEqual(calls.register.map((c) => c.accelerator), [
      snapshot.shortcuts.togglePet,
    ]);
    assert.strictEqual(failures.has("togglePet"), false);
    assert.ok(registered.has(snapshot.shortcuts.togglePet));
  });

  it("registerShortcut keeps the old persistent binding when the new register fails", () => {
    const snapshot = prefs.validate({
      shortcuts: {
        togglePet: "Ctrl+J",
      },
    });
    const { deps, calls, registered } = makeShortcutDeps({
      snapshot,
      registered: [snapshot.shortcuts.togglePet],
      failRegister: new Set(["CommandOrControl+K"]),
    });
    const r = commandRegistry.registerShortcut({
      actionId: "togglePet",
      accelerator: "Ctrl+K",
    }, deps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /system conflict/);
    assert.deepStrictEqual(calls.unregister, []);
    assert.ok(registered.has(snapshot.shortcuts.togglePet));
    assert.strictEqual(registered.has("CommandOrControl+K"), false);
  });

  it("registerShortcut rolls back the new persistent binding if old unregister verification fails", () => {
    const snapshot = prefs.validate({
      shortcuts: {
        togglePet: "Ctrl+J",
      },
    });
    const { deps, calls, registered } = makeShortcutDeps({
      snapshot,
      registered: [snapshot.shortcuts.togglePet],
      stubbornUnregister: snapshot.shortcuts.togglePet,
    });
    const r = commandRegistry.registerShortcut({
      actionId: "togglePet",
      accelerator: "Ctrl+K",
    }, deps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /unregister of old accelerator failed/);
    assert.deepStrictEqual(calls.unregister, ["CommandOrControl+J", "CommandOrControl+K"]);
    assert.ok(registered.has(snapshot.shortcuts.togglePet));
    assert.strictEqual(registered.has("CommandOrControl+K"), false);
  });

  it("registerShortcut skips globalShortcut work for contextual actions", () => {
    const snapshot = prefs.getDefaults();
    const { deps, calls } = makeShortcutDeps({ snapshot });
    const r = commandRegistry.registerShortcut({
      actionId: "permissionAllow",
      accelerator: "Ctrl+K",
    }, deps);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.shortcuts.permissionAllow, "CommandOrControl+K");
    assert.deepStrictEqual(calls.register, []);
    assert.deepStrictEqual(calls.unregister, []);
  });

  it("resetShortcut routes through registerShortcut with the default value", () => {
    const snapshot = prefs.validate({
      shortcuts: {
        togglePet: "Ctrl+J",
      },
    });
    const { deps } = makeShortcutDeps({
      snapshot,
      registered: [snapshot.shortcuts.togglePet],
    });
    const r = commandRegistry.resetShortcut({ actionId: "togglePet" }, deps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.commit.shortcuts.togglePet, "CommandOrControl+Shift+Alt+C");
  });

  it("resetAllShortcuts commits the full default shortcut map atomically", () => {
    const snapshot = prefs.validate({
      shortcuts: {
        togglePet: "Ctrl+J",
        permissionAllow: "Ctrl+K",
        permissionDeny: null,
      },
    });
    const { deps, calls } = makeShortcutDeps({
      snapshot,
      registered: [snapshot.shortcuts.togglePet],
    });
    const r = commandRegistry.resetAllShortcuts(null, deps);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.shortcuts, prefs.getDefaults().shortcuts);
    assert.deepStrictEqual(calls.register.map((c) => c.accelerator), [
      "CommandOrControl+Shift+Alt+C",
    ]);
    assert.deepStrictEqual(calls.unregister, ["CommandOrControl+J"]);
  });

  it("resetAllShortcuts leaves prefs untouched when the persistent default is unavailable", () => {
    const snapshot = prefs.validate({
      shortcuts: {
        togglePet: "Ctrl+J",
      },
    });
    const { deps, calls, registered } = makeShortcutDeps({
      snapshot,
      registered: [snapshot.shortcuts.togglePet],
      failRegister: new Set(["CommandOrControl+Shift+Alt+C"]),
    });
    const r = commandRegistry.resetAllShortcuts(null, deps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /system conflict on togglePet/);
    assert.strictEqual(r.commit, undefined);
    assert.deepStrictEqual(calls.unregister, []);
    assert.ok(registered.has(snapshot.shortcuts.togglePet));
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

describe("removeTheme command", () => {
  const baseSnapshot = { ...prefs.getDefaults(), themeOverrides: {} };

  function makeDeps(overrides = {}) {
    const calls = { removeThemeDir: [], getThemeInfo: [] };
    const deps = {
      snapshot: baseSnapshot,
      getThemeInfo: (id) => {
        calls.getThemeInfo.push(id);
        if (id === "cat") return { builtin: false, active: false };
        if (id === "clawd") return { builtin: true, active: true };
        if (id === "activeUser") return { builtin: false, active: true };
        if (id === "missing") return null;
        return { builtin: false, active: false };
      },
      removeThemeDir: async (id) => {
        calls.removeThemeDir.push(id);
      },
      ...overrides,
    };
    return { deps, calls };
  }

  it("rejects non-string payloads", async () => {
    const { deps } = makeDeps();
    const r = await commandRegistry.removeTheme(null, deps);
    assert.strictEqual(r.status, "error");
  });

  it("rejects built-in themes", async () => {
    const { deps, calls } = makeDeps();
    const r = await commandRegistry.removeTheme("clawd", deps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /built-in/);
    assert.deepStrictEqual(calls.removeThemeDir, []);
  });

  it("rejects the active theme", async () => {
    const { deps, calls } = makeDeps();
    const r = await commandRegistry.removeTheme("activeUser", deps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /active/);
    assert.deepStrictEqual(calls.removeThemeDir, []);
  });

  it("rejects managed Codex Pet themes", async () => {
    const { deps, calls } = makeDeps({
      getThemeInfo: (id) => {
        calls.getThemeInfo.push(id);
        if (id === "codex-pet-yoimiya") {
          return { builtin: false, active: false, managedCodexPet: true };
        }
        return { builtin: false, active: false };
      },
    });
    const r = await commandRegistry.removeTheme("codex-pet-yoimiya", deps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /managed Codex Pet/);
    assert.deepStrictEqual(calls.removeThemeDir, []);
  });

  it("rejects unknown themes", async () => {
    const { deps, calls } = makeDeps();
    const r = await commandRegistry.removeTheme("missing", deps);
    assert.strictEqual(r.status, "error");
    assert.deepStrictEqual(calls.removeThemeDir, []);
  });

  it("deletes the dir for a valid user theme", async () => {
    const { deps, calls } = makeDeps();
    const r = await commandRegistry.removeTheme("cat", deps);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(calls.removeThemeDir, ["cat"]);
    // No overrides to clean up → no commit field
    assert.strictEqual(r.commit, undefined);
  });

  it("strips themeOverrides entry on success when one exists", async () => {
    const snapshotWithOverride = {
      ...baseSnapshot,
      themeOverrides: { cat: { attention: { sourceThemeId: "cat", file: "x.svg" } } },
    };
    const { deps } = makeDeps({ snapshot: snapshotWithOverride });
    const r = await commandRegistry.removeTheme("cat", deps);
    assert.strictEqual(r.status, "ok");
    assert.ok(r.commit, "commit field expected");
    assert.deepStrictEqual(r.commit.themeOverrides, {});
  });

  // Phase 3b-swap: removeTheme also strips themeVariant entry
  it("strips themeVariant entry on success when one exists", async () => {
    const snapshotWithVariant = {
      ...baseSnapshot,
      themeVariant: { cat: "chill", clawd: "default" },
    };
    const { deps } = makeDeps({ snapshot: snapshotWithVariant });
    const r = await commandRegistry.removeTheme("cat", deps);
    assert.strictEqual(r.status, "ok");
    assert.ok(r.commit, "commit field expected");
    assert.deepStrictEqual(r.commit.themeVariant, { clawd: "default" });
    assert.strictEqual(r.commit.themeOverrides, undefined);  // wasn't set
  });

  it("strips both themeOverrides and themeVariant when both present", async () => {
    const snapshotWithBoth = {
      ...baseSnapshot,
      themeOverrides: { cat: { attention: { sourceThemeId: "cat", file: "x.svg" } } },
      themeVariant: { cat: "chill" },
    };
    const { deps } = makeDeps({ snapshot: snapshotWithBoth });
    const r = await commandRegistry.removeTheme("cat", deps);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.themeOverrides, {});
    assert.deepStrictEqual(r.commit.themeVariant, {});
  });

  // #509: removeTheme also strips the idleVisual entry
  it("strips idleVisual entry on success when one exists", async () => {
    const snapshotWithIdleVisual = {
      ...baseSnapshot,
      idleVisual: { cat: "cat-idle-nap.svg", clawd: "clawd-idle-reading.svg" },
    };
    const { deps } = makeDeps({ snapshot: snapshotWithIdleVisual });
    const r = await commandRegistry.removeTheme("cat", deps);
    assert.strictEqual(r.status, "ok");
    assert.ok(r.commit, "commit field expected");
    assert.deepStrictEqual(r.commit.idleVisual, { clawd: "clawd-idle-reading.svg" });
  });

  it("strips pet tint, both accessory slots, and holiday opt-in entries on success when they exist", async () => {
    const snapshotWithCustomization = {
      ...baseSnapshot,
      petTint: { cat: "matcha", clawd: "gold" },
      petAccessory: { cat: "halo", clawd: "wizard-hat" },
      petMouthAccessory: { cat: "cigarette", clawd: "cigarette" },
      holidayAccessoryEnabled: { cat: true, clawd: true },
    };
    const { deps } = makeDeps({ snapshot: snapshotWithCustomization });
    const r = await commandRegistry.removeTheme("cat", deps);
    assert.strictEqual(r.status, "ok");
    assert.ok(r.commit, "commit field expected");
    assert.deepStrictEqual(r.commit.petTint, { clawd: "gold" });
    assert.deepStrictEqual(r.commit.petAccessory, { clawd: "wizard-hat" });
    assert.deepStrictEqual(r.commit.petMouthAccessory, { clawd: "cigarette" });
    assert.deepStrictEqual(r.commit.holidayAccessoryEnabled, { clawd: true });
  });

  it("surfaces removeThemeDir throws as error status", async () => {
    const { deps } = makeDeps({
      removeThemeDir: async () => { throw new Error("EBUSY"); },
    });
    const r = await commandRegistry.removeTheme("cat", deps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /EBUSY/);
  });

  it("errors when required deps missing", async () => {
    const r = await commandRegistry.removeTheme("cat", { snapshot: baseSnapshot });
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /getThemeInfo/);
  });
});

// Phase 3b-swap: atomic theme+variant switch via a single command.
describe("setThemeSelection command", () => {
  const baseSnapshot = { ...prefs.getDefaults(), themeVariant: {} };

  function makeDeps(overrides = {}) {
    const calls = { activateTheme: [] };
    const deps = {
      snapshot: baseSnapshot,
      activateTheme: (themeId, variantId, overrideMap) => {
        calls.activateTheme.push({ themeId, variantId, overrideMap });
        // Simulate lenient variant fallback: "dead" variant → resolves to default
        const resolved = variantId === "dead" ? "default" : variantId;
        return { themeId, variantId: resolved };
      },
      getActiveTheme: () => ({
        _id: calls.activateTheme.at(-1)?.themeId || "clawd",
        _capabilities: { petTint: true, accessories: true },
      }),
      ...overrides,
    };
    return { deps, calls };
  }

  it("rejects missing themeId", () => {
    const { deps } = makeDeps();
    const r = commandRegistry.setThemeSelection({}, deps);
    assert.strictEqual(r.status, "error");
  });

  it("rejects non-string variantId when provided", () => {
    const { deps } = makeDeps();
    const r = commandRegistry.setThemeSelection({ themeId: "clawd", variantId: 42 }, deps);
    assert.strictEqual(r.status, "error");
  });

  it("accepts string payload as themeId shorthand", () => {
    const { deps, calls } = makeDeps();
    const r = commandRegistry.setThemeSelection("clawd", deps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(calls.activateTheme.length, 1);
    assert.strictEqual(calls.activateTheme[0].themeId, "clawd");
    assert.strictEqual(calls.activateTheme[0].variantId, "default");
    assert.strictEqual(calls.activateTheme[0].overrideMap, null);
  });

  it("uses snapshot.themeVariant when variantId not provided", () => {
    const snapshotWithVariant = { ...baseSnapshot, themeVariant: { clawd: "chill" } };
    const { deps, calls } = makeDeps({ snapshot: snapshotWithVariant });
    const r = commandRegistry.setThemeSelection({ themeId: "clawd" }, deps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(calls.activateTheme[0].variantId, "chill");
  });

  it("passes the target theme override map into activateTheme", () => {
    const overrideMap = {
      tiers: {
        workingTiers: {
          "clawd-working-typing.svg": { file: "clawd-working-typing-old.svg" },
        },
      },
    };
    const snapshotWithOverride = {
      ...baseSnapshot,
      themeOverrides: { clawd: overrideMap },
    };
    const { deps, calls } = makeDeps({ snapshot: snapshotWithOverride });
    const r = commandRegistry.setThemeSelection({ themeId: "clawd" }, deps);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(calls.activateTheme[0].overrideMap, overrideMap);
  });

  it("explicit variantId overrides snapshot map", () => {
    const snapshotWithVariant = { ...baseSnapshot, themeVariant: { clawd: "chill" } };
    const { deps, calls } = makeDeps({ snapshot: snapshotWithVariant });
    const r = commandRegistry.setThemeSelection({ themeId: "clawd", variantId: "hyper" }, deps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(calls.activateTheme[0].variantId, "hyper");
  });

  it("commits theme + themeVariant atomically", () => {
    const { deps } = makeDeps();
    const r = commandRegistry.setThemeSelection({ themeId: "clawd", variantId: "chill" }, deps);
    assert.strictEqual(r.status, "ok");
    assert.ok(r.commit, "commit field expected");
    assert.strictEqual(r.commit.theme, "clawd");
    assert.deepStrictEqual(r.commit.themeVariant, { clawd: "chill" });
    assert.deepStrictEqual(r.customizationCapabilities, {
      petTint: true,
      accessories: true,
      mouthAccessories: false,
    });
  });

  it("returns the activated theme's fail-closed customization capabilities", () => {
    const { deps } = makeDeps({
      getActiveTheme: () => ({
        _id: "clawd",
        _capabilities: { petTint: true, accessories: false },
      }),
    });
    const r = commandRegistry.setThemeSelection({ themeId: "clawd" }, deps);
    assert.deepStrictEqual(r.customizationCapabilities, {
      petTint: true,
      accessories: false,
      mouthAccessories: false,
    });
  });

  it("preserves other themes' variantIds when committing", () => {
    const snapshotWithVariant = { ...baseSnapshot, themeVariant: { calico: "hyper" } };
    const { deps } = makeDeps({ snapshot: snapshotWithVariant });
    const r = commandRegistry.setThemeSelection({ themeId: "clawd", variantId: "chill" }, deps);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.themeVariant, { calico: "hyper", clawd: "chill" });
  });

  it("self-heals by committing the RESOLVED variantId on dead-variant fallback", () => {
    // Scenario: author deleted `chill` variant. User's stored themeVariant
    // still points to `chill`. setThemeSelection calls activateTheme which
    // lenient-falls back to `default` and returns resolved id. The committed
    // themeVariant records `default`, not the dead `chill` the user asked for.
    const snapshotWithDead = { ...baseSnapshot, themeVariant: { clawd: "dead" } };
    const { deps } = makeDeps({ snapshot: snapshotWithDead });
    const r = commandRegistry.setThemeSelection({ themeId: "clawd" }, deps);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.themeVariant, { clawd: "default" });
  });

  it("surfaces activateTheme throws as error status (no commit)", () => {
    const { deps } = makeDeps({
      activateTheme: () => { throw new Error("theme missing"); },
    });
    const r = commandRegistry.setThemeSelection({ themeId: "broken" }, deps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /theme missing/);
    assert.strictEqual(r.commit, undefined);
  });

  it("errors when activateTheme dep is missing", () => {
    const r = commandRegistry.setThemeSelection({ themeId: "clawd" }, { snapshot: baseSnapshot });
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /activateTheme/);
  });
});

// #509: default idle visual picker command.
describe("setIdleVisual command", () => {
  const activeTheme = {
    _id: "clawd",
    states: { idle: ["clawd-idle-follow.svg"] },
    idleAnimations: [
      { file: "clawd-idle-look.svg", duration: 6500 },
      { file: "clawd-idle-reading.svg", duration: 14000 },
    ],
  };

  function makeDeps(overrides = {}) {
    return {
      snapshot: { ...prefs.getDefaults(), idleVisual: {} },
      getActiveTheme: () => activeTheme,
      ...overrides,
    };
  }

  it("rejects missing themeId and malformed file", () => {
    assert.strictEqual(commandRegistry.setIdleVisual({}, makeDeps()).status, "error");
    assert.strictEqual(
      commandRegistry.setIdleVisual({ themeId: "clawd", file: 42 }, makeDeps()).status,
      "error"
    );
    assert.strictEqual(
      commandRegistry.setIdleVisual({ themeId: "clawd", file: "" }, makeDeps()).status,
      "error"
    );
  });

  it("errors when getActiveTheme dep is missing", () => {
    const r = commandRegistry.setIdleVisual(
      { themeId: "clawd", file: "clawd-idle-look.svg" },
      { snapshot: prefs.getDefaults() }
    );
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /getActiveTheme/);
  });

  it("rejects a themeId that is not the active theme", () => {
    const r = commandRegistry.setIdleVisual({ themeId: "calico", file: "x.svg" }, makeDeps());
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /not the active theme/);
  });

  it("rejects files that are not idle visuals of the theme", () => {
    const r = commandRegistry.setIdleVisual(
      { themeId: "clawd", file: "clawd-working-typing.svg" },
      makeDeps()
    );
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /not an idle visual/);
  });

  it("commits the merged map for a valid pool file, preserving other themes", () => {
    const deps = makeDeps({
      snapshot: { ...prefs.getDefaults(), idleVisual: { calico: "calico-idle-stretch.svg" } },
    });
    const r = commandRegistry.setIdleVisual({ themeId: "clawd", file: "clawd-idle-reading.svg" }, deps);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.idleVisual, {
      calico: "calico-idle-stretch.svg",
      clawd: "clawd-idle-reading.svg",
    });
  });

  it("null file deletes the entry; noop when already unset", () => {
    const deps = makeDeps({
      snapshot: { ...prefs.getDefaults(), idleVisual: { clawd: "clawd-idle-look.svg" } },
    });
    const r = commandRegistry.setIdleVisual({ themeId: "clawd", file: null }, deps);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.idleVisual, {});

    const r2 = commandRegistry.setIdleVisual({ themeId: "clawd", file: null }, makeDeps());
    assert.strictEqual(r2.status, "ok");
    assert.strictEqual(r2.noop, true);
    assert.strictEqual(r2.commit, undefined);
  });

  it("selecting the theme default stores nothing (absence = default)", () => {
    const deps = makeDeps({
      snapshot: { ...prefs.getDefaults(), idleVisual: { clawd: "clawd-idle-look.svg" } },
    });
    const r = commandRegistry.setIdleVisual({ themeId: "clawd", file: "clawd-idle-follow.svg" }, deps);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.idleVisual, {});

    const r2 = commandRegistry.setIdleVisual(
      { themeId: "clawd", file: "clawd-idle-follow.svg" },
      makeDeps()
    );
    assert.strictEqual(r2.status, "ok");
    assert.strictEqual(r2.noop, true);
  });

  it("noop when re-selecting the current choice", () => {
    const deps = makeDeps({
      snapshot: { ...prefs.getDefaults(), idleVisual: { clawd: "clawd-idle-look.svg" } },
    });
    const r = commandRegistry.setIdleVisual({ themeId: "clawd", file: "clawd-idle-look.svg" }, deps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.noop, true);
  });

  it("updateRegistry accepts idleVisual plain objects only", () => {
    assert.strictEqual(updateRegistry.idleVisual({ clawd: "x.svg" }).status, "ok");
    assert.strictEqual(updateRegistry.idleVisual("nope").status, "error");
  });
});

describe("setAnimationOverride reaction slot", () => {
  const baseSnapshot = { theme: "clawd", themeOverrides: {} };
  const noopDeps = { snapshot: baseSnapshot, activateTheme: () => {} };

  it("rejects unknown reactionKey", () => {
    const r = commandRegistry.setAnimationOverride({
      themeId: "clawd",
      slotType: "reaction",
      reactionKey: "explode",
      file: "x.svg",
    }, noopDeps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /reactionKey/);
  });

  it("accepts valid reactionKey and writes reactions.<key>.file", () => {
    const r = commandRegistry.setAnimationOverride({
      themeId: "clawd",
      slotType: "reaction",
      reactionKey: "clickLeft",
      file: "my-poke.svg",
    }, noopDeps);
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(
      r.commit.themeOverrides.clawd.reactions.clickLeft,
      { file: "my-poke.svg" }
    );
  });

  it("rejects durationMs for drag reaction (drag plays until pointer-up)", () => {
    const r = commandRegistry.setAnimationOverride({
      themeId: "clawd",
      slotType: "reaction",
      reactionKey: "drag",
      durationMs: 2000,
    }, noopDeps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /drag/);
  });

  it("accepts durationMs for clickLeft reaction", () => {
    const r = commandRegistry.setAnimationOverride({
      themeId: "clawd",
      slotType: "reaction",
      reactionKey: "clickLeft",
      durationMs: 3000,
    }, noopDeps);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.commit.themeOverrides.clawd.reactions.clickLeft.durationMs, 3000);
  });

  it("rejects autoReturnMs for reaction slots", () => {
    const r = commandRegistry.setAnimationOverride({
      themeId: "clawd",
      slotType: "reaction",
      reactionKey: "clickLeft",
      autoReturnMs: 3000,
    }, noopDeps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /autoReturnMs/);
  });

  it("clears reaction override when file is set to null with no other fields", () => {
    const snapshot = {
      theme: "clawd",
      themeOverrides: {
        clawd: { reactions: { clickLeft: { file: "old.svg" } } },
      },
    };
    const r = commandRegistry.setAnimationOverride({
      themeId: "clawd",
      slotType: "reaction",
      reactionKey: "clickLeft",
      file: null,
    }, { snapshot, activateTheme: () => {} });
    assert.strictEqual(r.status, "ok");
    // With reactions.clickLeft emptied to {}, buildThemeOverrideMap should drop
    // both `reactions` and the themeId if nothing else remains.
    assert.strictEqual(r.commit.themeOverrides.clawd, undefined);
  });

  it("preserves existing hitbox overrides when editing a reaction slot", () => {
    const snapshot = {
      theme: "clawd",
      themeOverrides: {
        clawd: {
          reactions: { clickLeft: { file: "old.svg" } },
          hitbox: { wide: { "clawd-error.svg": true } },
        },
      },
    };
    const r = commandRegistry.setAnimationOverride({
      themeId: "clawd",
      slotType: "reaction",
      reactionKey: "clickLeft",
      file: "new.svg",
    }, { snapshot, activateTheme: () => {} });
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.themeOverrides.clawd.hitbox, {
      wide: { "clawd-error.svg": true },
    });
  });
});

describe("setSoundOverride command", () => {
  const baseSnapshot = { theme: "clawd", themeOverrides: {} };
  const noopDeps = { snapshot: baseSnapshot, activateTheme: () => {} };

  it("rejects missing themeId / soundName", () => {
    let r = commandRegistry.setSoundOverride({ soundName: "complete", file: "a.mp3" }, noopDeps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /themeId/);
    r = commandRegistry.setSoundOverride({ themeId: "clawd", file: "a.mp3" }, noopDeps);
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /soundName/);
  });

  it("rejects file when it is not null and not a non-empty string", () => {
    const r = commandRegistry.setSoundOverride(
      { themeId: "clawd", soundName: "complete", file: "" },
      noopDeps
    );
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /file/);
  });

  it("writes { sounds: { complete: { file } } } on first override", () => {
    const r = commandRegistry.setSoundOverride(
      { themeId: "clawd", soundName: "complete", file: "my-complete.mp3" },
      noopDeps
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.themeOverrides.clawd.sounds, {
      complete: { file: "my-complete.mp3" },
    });
  });

  it("preserves originalName in the committed entry when provided", () => {
    const r = commandRegistry.setSoundOverride(
      { themeId: "clawd", soundName: "complete", file: "complete.mp3", originalName: "cat-demo.mp3" },
      noopDeps
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.themeOverrides.clawd.sounds, {
      complete: { file: "complete.mp3", originalName: "cat-demo.mp3" },
    });
  });

  it("null file clears the entry and removes the theme row when nothing else is overridden", () => {
    const snapshot = {
      theme: "clawd",
      themeOverrides: {
        clawd: { sounds: { complete: { file: "old.mp3" } } },
      },
    };
    const r = commandRegistry.setSoundOverride(
      { themeId: "clawd", soundName: "complete", file: null },
      { snapshot, activateTheme: () => {} }
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.commit.themeOverrides.clawd, undefined);
  });

  it("preserves unrelated soundName entries when editing one", () => {
    const snapshot = {
      theme: "clawd",
      themeOverrides: {
        clawd: {
          sounds: {
            complete: { file: "c.mp3" },
            confirm: { file: "x.wav" },
          },
        },
      },
    };
    const r = commandRegistry.setSoundOverride(
      { themeId: "clawd", soundName: "complete", file: "new-c.mp3" },
      { snapshot, activateTheme: () => {} }
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.themeOverrides.clawd.sounds, {
      complete: { file: "new-c.mp3" },
      confirm: { file: "x.wav" },
    });
  });

  it("preserves existing animation overrides when editing a sound slot", () => {
    const snapshot = {
      theme: "clawd",
      themeOverrides: {
        clawd: {
          states: { attention: { file: "attn.svg" } },
          hitbox: { wide: { "clawd-error.svg": true } },
          sounds: { confirm: { file: "c.wav" } },
        },
      },
    };
    const r = commandRegistry.setSoundOverride(
      { themeId: "clawd", soundName: "complete", file: "done.mp3" },
      { snapshot, activateTheme: () => {} }
    );
    assert.strictEqual(r.status, "ok");
    const nextClawd = r.commit.themeOverrides.clawd;
    assert.deepStrictEqual(nextClawd.states, { attention: { file: "attn.svg" } });
    assert.deepStrictEqual(nextClawd.hitbox, { wide: { "clawd-error.svg": true } });
    assert.deepStrictEqual(nextClawd.sounds, {
      confirm: { file: "c.wav" },
      complete: { file: "done.mp3" },
    });
  });

  it("same value is a noop (no commit)", () => {
    const snapshot = {
      theme: "clawd",
      themeOverrides: {
        clawd: { sounds: { complete: { file: "same.mp3" } } },
      },
    };
    const r = commandRegistry.setSoundOverride(
      { themeId: "clawd", soundName: "complete", file: "same.mp3" },
      { snapshot, activateTheme: () => {} }
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.noop, true);
  });

  it("when active theme changes, calls activateTheme with the new override map", () => {
    const snapshot = { theme: "clawd", themeOverrides: {} };
    const calls = [];
    const r = commandRegistry.setSoundOverride(
      { themeId: "clawd", soundName: "complete", file: "a.mp3" },
      {
        snapshot,
        activateTheme: (themeId, variantId, overrideMap) => calls.push({ themeId, variantId, overrideMap }),
      }
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].overrideMap.sounds, { complete: { file: "a.mp3" } });
  });

  it("active theme edit without activateTheme dep returns error", () => {
    const r = commandRegistry.setSoundOverride(
      { themeId: "clawd", soundName: "complete", file: "a.mp3" },
      { snapshot: { theme: "clawd", themeOverrides: {} } }
    );
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /activateTheme/);
  });

  it("non-active theme skips activateTheme but still commits", () => {
    const calls = [];
    const r = commandRegistry.setSoundOverride(
      { themeId: "other", soundName: "complete", file: "a.mp3" },
      {
        snapshot: { theme: "clawd", themeOverrides: {} },
        activateTheme: () => calls.push("boom"),
      }
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(calls.length, 0);
    assert.ok(r.commit.themeOverrides.other.sounds);
  });
});

describe("setWideHitboxOverride command", () => {
  it("rejects missing file / themeId", () => {
    const r = commandRegistry.setWideHitboxOverride({ themeId: "clawd", enabled: true }, { snapshot: {} });
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /file/);
  });

  it("rejects non-boolean / non-null enabled", () => {
    const r = commandRegistry.setWideHitboxOverride({
      themeId: "clawd", file: "x.svg", enabled: "yes",
    }, { snapshot: {} });
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /boolean or null/);
  });

  it("writes hitbox.wide[file] = true when enabled", () => {
    const snapshot = { theme: "clawd", themeOverrides: {} };
    const r = commandRegistry.setWideHitboxOverride(
      { themeId: "clawd", file: "clawd-error.svg", enabled: true },
      { snapshot, activateTheme: () => {} }
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(
      r.commit.themeOverrides.clawd.hitbox.wide,
      { "clawd-error.svg": true }
    );
  });

  it("clears the entry when enabled=null (fall back to theme default)", () => {
    const snapshot = {
      theme: "clawd",
      themeOverrides: {
        clawd: { hitbox: { wide: { "clawd-error.svg": true } } },
      },
    };
    const r = commandRegistry.setWideHitboxOverride(
      { themeId: "clawd", file: "clawd-error.svg", enabled: null },
      { snapshot, activateTheme: () => {} }
    );
    assert.strictEqual(r.status, "ok");
    // Entire hitbox + themeId entry drops when last toggle is cleared.
    assert.strictEqual(r.commit.themeOverrides.clawd, undefined);
  });

  it("noop when setting same value", () => {
    const snapshot = {
      theme: "clawd",
      themeOverrides: {
        clawd: { hitbox: { wide: { "clawd-error.svg": true } } },
      },
    };
    const r = commandRegistry.setWideHitboxOverride(
      { themeId: "clawd", file: "clawd-error.svg", enabled: true },
      { snapshot }
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.noop, true);
  });

  it("triggers activateTheme with next override map when active theme changes", () => {
    let activatedWith = null;
    const snapshot = { theme: "clawd", themeOverrides: {} };
    const r = commandRegistry.setWideHitboxOverride(
      { themeId: "clawd", file: "foo.svg", enabled: true },
      {
        snapshot,
        activateTheme: (id, variantId, overrideMap) => { activatedWith = { id, overrideMap }; },
      }
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(activatedWith.id, "clawd");
    assert.deepStrictEqual(activatedWith.overrideMap, {
      hitbox: { wide: { "foo.svg": true } },
    });
  });

  it("prefers refreshActiveThemeHitboxOverrides over activateTheme for active theme changes", () => {
    let refreshedWith = null;
    let activated = false;
    const snapshot = { theme: "clawd", themeOverrides: {} };
    const r = commandRegistry.setWideHitboxOverride(
      { themeId: "clawd", file: "foo.svg", enabled: true },
      {
        snapshot,
        refreshActiveThemeHitboxOverrides: (id, overrideMap) => {
          refreshedWith = { id, overrideMap };
        },
        activateTheme: () => {
          activated = true;
        },
      }
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(refreshedWith, {
      id: "clawd",
      overrideMap: {
        hitbox: { wide: { "foo.svg": true } },
      },
    });
    assert.strictEqual(activated, false);
  });
});

describe("theme override subtree preservation", () => {
  it("setThemeOverrideDisabled keeps existing reactions and hitbox overrides", () => {
    const snapshot = {
      theme: "clawd",
      themeOverrides: {
        clawd: {
          states: { attention: { file: "attention.svg" } },
          reactions: { clickLeft: { file: "click.svg" } },
          hitbox: { wide: { "clawd-error.svg": true } },
        },
      },
    };
    const r = commandRegistry.setThemeOverrideDisabled(
      { themeId: "clawd", stateKey: "attention", disabled: true },
      { snapshot }
    );
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit.themeOverrides.clawd.reactions, {
      clickLeft: { file: "click.svg" },
    });
    assert.deepStrictEqual(r.commit.themeOverrides.clawd.hitbox, {
      wide: { "clawd-error.svg": true },
    });
  });
});

describe("importAnimationOverrides command", () => {
  const validPayload = {
    version: 1,
    themes: {
      clawd: {
        states: {
          error: { file: "clawd-error.svg" },
          attention: { disabled: true },
        },
      },
    },
  };

  it("rejects non-object payloads", () => {
    const r = commandRegistry.importAnimationOverrides(null, { snapshot: {} });
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /must be an object/);
  });

  it("rejects payloads missing themes map", () => {
    const r = commandRegistry.importAnimationOverrides({ version: 1 }, { snapshot: {} });
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /themes/);
  });

  it("rejects payloads whose version is newer than supported", () => {
    const r = commandRegistry.importAnimationOverrides(
      { version: 999, themes: { clawd: {} } },
      { snapshot: {} }
    );
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /newer than supported/);
  });

  it("rejects when normalized payload has no valid entries", () => {
    const r = commandRegistry.importAnimationOverrides(
      { version: 1, themes: { clawd: { not_a_real_field: 1 } } },
      { snapshot: {} }
    );
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /no valid/);
  });

  it("merges by theme id into existing overrides by default", () => {
    const snapshot = {
      theme: "calico",
      themeOverrides: {
        calico: { states: { attention: { file: "cat-attention.svg" } } },
      },
    };
    const r = commandRegistry.importAnimationOverrides(validPayload, { snapshot });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.mode, "merge");
    assert.ok(r.commit.themeOverrides.calico, "calico overrides preserved on merge");
    assert.ok(r.commit.themeOverrides.clawd, "clawd overrides added on merge");
    assert.strictEqual(r.importedThemeCount, 1);
  });

  it("replaces the entire map when mode=replace", () => {
    const snapshot = {
      theme: "calico",
      themeOverrides: {
        calico: { states: { attention: { file: "cat-attention.svg" } } },
      },
    };
    const r = commandRegistry.importAnimationOverrides(
      { ...validPayload, mode: "replace" },
      { snapshot, activateTheme: () => {} }
    );
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.mode, "replace");
    assert.strictEqual(r.commit.themeOverrides.calico, undefined);
    assert.ok(r.commit.themeOverrides.clawd);
  });

  it("calls activateTheme with the new override map for the active theme", () => {
    // Regression: the effect runs BEFORE controller._commit, so activateTheme
    // must receive the new override map explicitly — reading themeOverrides
    // from the store would see the stale pre-import value and the imported
    // slots would never take effect.
    const calls = [];
    const snapshot = { theme: "clawd", themeOverrides: {} };
    const r = commandRegistry.importAnimationOverrides(validPayload, {
      snapshot,
      activateTheme: (id, variantId, overrideMap) => {
        calls.push({ id, variantId, overrideMap });
      },
    });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].id, "clawd");
    assert.ok(calls[0].overrideMap, "overrideMap must not be null");
    assert.deepStrictEqual(
      calls[0].overrideMap,
      r.commit.themeOverrides.clawd,
      "activateTheme must receive the same normalized override map that gets committed"
    );
  });

  it("skips activateTheme when active theme overrides are unchanged", () => {
    let activated = null;
    const snapshot = {
      theme: "clawd",
      themeOverrides: {
        clawd: {
          states: {
            error: { file: "clawd-error.svg" },
            attention: { disabled: true },
          },
        },
      },
    };
    const r = commandRegistry.importAnimationOverrides(validPayload, {
      snapshot,
      activateTheme: (id) => { activated = id; },
    });
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(activated, null, "activateTheme should not fire when data unchanged");
  });

  it("errors when activateTheme dep is missing and active theme needs reload", () => {
    const snapshot = { theme: "clawd", themeOverrides: {} };
    const r = commandRegistry.importAnimationOverrides(validPayload, { snapshot });
    assert.strictEqual(r.status, "error");
    assert.match(r.message, /activateTheme/);
  });

  it("does not require activateTheme when import only touches non-active themes", () => {
    const snapshot = { theme: "calico", themeOverrides: {} };
    const r = commandRegistry.importAnimationOverrides(validPayload, { snapshot });
    assert.strictEqual(r.status, "ok");
    assert.ok(r.commit.themeOverrides.clawd);
  });
});

describe("textScaleByDisplay validator", () => {
  it("has a registry entry so command commits pass controller validation", () => {
    // Regression: the controller rejects command commits whose keys lack a
    // registry validator ("unknown settings key textScaleByDisplay").
    assert.strictEqual(typeof updateRegistry.textScaleByDisplay, "function");
  });

  it("accepts a valid display map and rejects junk entries", () => {
    assert.strictEqual(updateRegistry.textScaleByDisplay({ "1": 1.35, "2": 0.8 }).status, "ok");
    assert.strictEqual(updateRegistry.textScaleByDisplay({}).status, "ok");
    assert.strictEqual(updateRegistry.textScaleByDisplay(null).status, "error");
    assert.strictEqual(updateRegistry.textScaleByDisplay([1.2]).status, "error");
    assert.strictEqual(updateRegistry.textScaleByDisplay({ "1": 99 }).status, "error");
    assert.strictEqual(updateRegistry.textScaleByDisplay({ "1": "1.2" }).status, "error");
    assert.strictEqual(updateRegistry.textScaleByDisplay({ " ": 1.2 }).status, "error");
  });
});

describe("setTextScaleForDisplay command", () => {
  it("writes the entry for the resolved display and keeps other displays", () => {
    const r = commandRegistry.setTextScaleForDisplay({ value: 1.35 }, {
      snapshot: { textScaleByDisplay: { "2": 1.2 } },
      resolveTextScaleDisplayKey: () => "1",
    });
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit, { textScaleByDisplay: { "1": 1.35, "2": 1.2 } });
  });

  it("overwrites an existing entry for the same display", () => {
    const r = commandRegistry.setTextScaleForDisplay({ value: 1 }, {
      snapshot: { textScaleByDisplay: { "1": 1.35 } },
      resolveTextScaleDisplayKey: () => "1",
    });
    assert.deepStrictEqual(r.commit, { textScaleByDisplay: { "1": 1 } });
  });

  it("falls back to the legacy global without display context", () => {
    const r = commandRegistry.setTextScaleForDisplay({ value: 1.25 }, { snapshot: {} });
    assert.strictEqual(r.status, "ok");
    assert.deepStrictEqual(r.commit, { textScale: 1.25 });
  });

  it("never evicts the entry being written when the map is at capacity", () => {
    const full = {};
    for (let i = 0; i < 16; i++) full[`d${i}`] = 1.2;
    const r = commandRegistry.setTextScaleForDisplay({ value: 1.4 }, {
      snapshot: { textScaleByDisplay: full },
      resolveTextScaleDisplayKey: () => "fresh",
    });
    assert.strictEqual(r.commit.textScaleByDisplay.fresh, 1.4);
    assert.strictEqual(Object.keys(r.commit.textScaleByDisplay).length, 16);
  });

  it("rejects out-of-range and non-numeric values", () => {
    const deps = { snapshot: {}, resolveTextScaleDisplayKey: () => "1" };
    assert.strictEqual(commandRegistry.setTextScaleForDisplay({ value: 0.5 }, deps).status, "error");
    assert.strictEqual(commandRegistry.setTextScaleForDisplay({ value: 2 }, deps).status, "error");
    assert.strictEqual(commandRegistry.setTextScaleForDisplay({ value: "abc" }, deps).status, "error");
    assert.strictEqual(commandRegistry.setTextScaleForDisplay(null, deps).status, "error");
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
