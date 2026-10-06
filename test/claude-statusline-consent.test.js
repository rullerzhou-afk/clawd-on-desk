"use strict";
const { it } = require("node:test");
const assert = require("node:assert/strict");
const { setClaudeCollectionWithConsent } = require("../src/claude-statusline-consent");
const { createSettingsController } = require("../src/settings-controller");
const { DEFAULTS } = require("../src/prefs");
const digest = "a".repeat(64);
const occupied = { status: "error", reason: "statusline-occupied", statuslineFingerprint: digest };

it("consent is requested only for an occupied, digest-bound slot", async () => {
  for (const result of [{ status: "ok" }, { status: "error", reason: "unavailable" }, { ...occupied, statuslineFingerprint: undefined }]) {
    assert.equal(await setClaudeCollectionWithConsent(true, { setEnabled: async () => result, confirm: () => assert.fail("unexpected dialog") }), result);
  }
});

it("accepting retries once with the inspected digest; no unbounded re-prompt on another conflict", async () => {
  const calls = [];
  let prompts = 0;
  const result = await setClaudeCollectionWithConsent(true, {
    setEnabled: async (options) => { calls.push(options); return occupied; },
    confirm: async () => { prompts++; return true; },
  });
  assert.equal(result, occupied);
  assert.equal(prompts, 1);
  assert.deepEqual(calls, [{ enabled: true }, { enabled: true, chainExisting: true, expectedStatuslineFingerprint: digest }]);
});

it("cancellation and a failed dialog do not retry or commit the collection preference", async () => {
  for (const confirm of [async () => false, async () => { throw new Error("dialog closed"); }]) {
    let calls = 0;
    const controller = createSettingsController({ loadResult: { snapshot: { ...DEFAULTS, claudeQuotaCollectionEnabled: false }, locked: false }, injectedDeps: {
      setClaudeQuotaCollectionEnabled: (enabled) => setClaudeCollectionWithConsent(enabled, { confirm, setEnabled: async () => { calls++; return occupied; } }),
    } });
    const result = await controller.applyUpdate("claudeQuotaCollectionEnabled", true);
    assert.equal(result.cancelled, true);
    assert.equal(controller.get("claudeQuotaCollectionEnabled"), false);
    assert.equal(calls, 1);
  }
});

it("confirmed failure does not commit, and successful confirmed registration does", async () => {
  for (const success of [false, true]) {
    let calls = 0;
    const controller = createSettingsController({ loadResult: { snapshot: { ...DEFAULTS, claudeQuotaCollectionEnabled: false }, locked: false }, injectedDeps: {
      setClaudeQuotaCollectionEnabled: (enabled) => setClaudeCollectionWithConsent(enabled, { confirm: async () => true,
        setEnabled: async () => ++calls === 1 ? occupied : { status: success ? "ok" : "error" } }),
    } });
    await controller.applyUpdate("claudeQuotaCollectionEnabled", true);
    assert.equal(controller.get("claudeQuotaCollectionEnabled"), success);
  }
});

it("opt-out never asks for coexistence", async () => {
  const result = await setClaudeCollectionWithConsent(false, { setEnabled: async (options) => {
    assert.deepEqual(options, { enabled: false }); return { status: "ok" };
  }, confirm: () => assert.fail("unexpected dialog") });
  assert.equal(result.status, "ok");
});
