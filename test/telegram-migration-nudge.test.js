"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SIGNATURES,
  decideTelegramMigrationNudge,
  createTelegramMigrationNudge,
} = require("../src/telegram-migration-nudge");
const { STATES, TEST_ORIGINS } = require("../src/telegram-migration-state");

test("legacy and native verification nudges use distinct persistent signatures", () => {
  const legacy = decideTelegramMigrationNudge({
    state: STATES.NATIVE_MIGRATION_REQUIRED,
    transport: "legacy",
    testOrigin: TEST_ORIGINS.LEGACY,
  }, "");
  const native = decideTelegramMigrationNudge({
    state: STATES.NEEDS_SETUP,
    transport: "native",
    testOrigin: TEST_ORIGINS.NATIVE_VERIFIED_REPAIR,
  }, "");

  assert.deepStrictEqual(
    { notify: legacy.shouldNotify, kind: legacy.kind, signature: legacy.nextSignature },
    { notify: true, kind: "legacy", signature: SIGNATURES.LEGACY },
  );
  assert.deepStrictEqual(
    { notify: native.shouldNotify, kind: native.kind, signature: native.nextSignature },
    { notify: true, kind: "native", signature: SIGNATURES.NATIVE },
  );
});

test("startup nudge is shown once, persists only after delivery, and opens Settings", async () => {
  let signature = "";
  let notifications = 0;
  let opened = 0;
  const runtime = createTelegramMigrationNudge({
    getSnapshot: () => ({
      state: STATES.NATIVE_MIGRATION_REQUIRED,
      transport: "legacy",
      testOrigin: TEST_ORIGINS.LEGACY,
    }),
    getLastSignature: () => signature,
    setLastSignature: async (value) => { signature = value; },
    showNotification: ({ kind, onClick }) => {
      notifications += 1;
      assert.strictEqual(kind, "legacy");
      onClick();
      return true;
    },
    openSettings: () => { opened += 1; },
  });

  assert.strictEqual((await runtime.sync({ allowNotify: true })).notified, true);
  assert.strictEqual(signature, SIGNATURES.LEGACY);
  assert.strictEqual((await runtime.sync({ allowNotify: true })).notified, false);
  assert.strictEqual(notifications, 1);
  assert.strictEqual(opened, 1);
});

test("active or explicitly off state clears the dedupe while testing preserves it", () => {
  for (const state of [STATES.NATIVE_ACTIVE, STATES.IDLE]) {
    const decision = decideTelegramMigrationNudge({ state }, SIGNATURES.LEGACY);
    assert.strictEqual(decision.shouldPersist, true);
    assert.strictEqual(decision.nextSignature, "");
  }
  const testing = decideTelegramMigrationNudge({ state: STATES.TESTING_NATIVE }, SIGNATURES.LEGACY);
  assert.strictEqual(testing.shouldPersist, false);
  assert.strictEqual(testing.nextSignature, SIGNATURES.LEGACY);
});

test("a failed notification is retried on the next startup", async () => {
  let signature = "";
  const runtime = createTelegramMigrationNudge({
    getSnapshot: () => ({ state: STATES.NEEDS_SETUP, testOrigin: TEST_ORIGINS.LEGACY }),
    getLastSignature: () => signature,
    setLastSignature: async (value) => { signature = value; },
    showNotification: () => false,
  });

  assert.strictEqual((await runtime.sync({ allowNotify: true })).notified, false);
  assert.strictEqual(signature, "");
});
