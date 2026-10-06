"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  STATES,
  EVENTS,
  SIDE_EFFECTS,
  ERROR_CODES,
  TEST_ORIGINS,
  normalizePrefs,
  computeInitial,
  applyEvent,
  checkInvariants,
} = require("../src/telegram-migration-state");

function files(complete = true) {
  return { nativeConfigComplete: complete };
}

function effectTypes(value) {
  return (value.sideEffects || []).map((entry) => entry.type);
}

test("legacy transport is a migration marker and never starts a sidecar", () => {
  const value = computeInitial({
    prefs: { transport: "legacy", legacyEnabled: true },
    files: files(true),
  });
  assert.equal(value.state, STATES.NATIVE_MIGRATION_REQUIRED);
  assert.equal(value.testOrigin, TEST_ORIGINS.LEGACY);
  assert.deepEqual(value.sideEffects, []);
  assert.equal(Object.prototype.hasOwnProperty.call(STATES, "LEGACY_ACTIVE"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(SIDE_EFFECTS, "START_SIDECAR"), false);
});

test("missing transport with legacy intent routes to migration-required", () => {
  const value = computeInitial({
    prefs: { legacyEnabled: true },
    files: files(true),
  });
  assert.equal(value.state, STATES.NATIVE_MIGRATION_REQUIRED);
  assert.equal(value.testOrigin, TEST_ORIGINS.LEGACY);
});

test("missing transport without enable intent stays IDLE", () => {
  const value = computeInitial({ prefs: { legacyEnabled: false }, files: files(true) });
  assert.equal(value.state, STATES.IDLE);
  assert.equal(value.testOrigin, TEST_ORIGINS.IDLE);
});

test("explicit off wins over a stale legacyEnabled=true bit", () => {
  const value = computeInitial({
    prefs: { transport: "off", legacyEnabled: true },
    files: files(true),
  });
  assert.equal(value.state, STATES.IDLE);
});

test("verified native starts native polling", () => {
  const value = computeInitial({
    prefs: { transport: "native", nativeVerifiedAt: 123 },
    files: files(true),
  });
  assert.equal(value.state, STATES.NATIVE_ACTIVE);
  assert.deepEqual(effectTypes(value), [SIDE_EFFECTS.START_NATIVE_POLLER]);
});

test("unverified native requires verification, not setup", () => {
  const value = computeInitial({
    prefs: { transport: "native", nativeVerifiedAt: null },
    files: files(true),
  });
  assert.equal(value.state, STATES.NATIVE_MIGRATION_REQUIRED);
  assert.equal(value.testOrigin, TEST_ORIGINS.NATIVE_UNVERIFIED);
});

test("native with temporarily incomplete config enters NEEDS_SETUP and keeps repair origin", () => {
  const value = computeInitial({
    prefs: { transport: "native", nativeVerifiedAt: 123 },
    files: files(false),
  });
  assert.equal(value.state, STATES.NEEDS_SETUP);
  assert.equal(value.testOrigin, TEST_ORIGINS.NATIVE_VERIFIED_REPAIR);
});

test("legacy with incomplete config enters NEEDS_SETUP", () => {
  const value = computeInitial({
    prefs: { transport: "legacy" },
    files: files(false),
  });
  assert.equal(value.state, STATES.NEEDS_SETUP);
  assert.equal(value.testOrigin, TEST_ORIGINS.LEGACY);
});

test("invalid transport never starts runtime and surfaces a diagnostic", () => {
  const normalized = normalizePrefs({ transport: "wat", legacyEnabled: true });
  assert.equal(normalized.transportInvalid, true);
  const value = computeInitial({
    prefs: { transport: "wat", legacyEnabled: true },
    files: files(true),
  });
  assert.equal(value.state, STATES.NATIVE_MIGRATION_REQUIRED);
  assert.equal(value.diagnosticCode, ERROR_CODES.TRANSPORT_INVALID);
  assert.deepEqual(value.sideEffects, []);
});

test("migration-required starts native test using live complete config", () => {
  const value = applyEvent({
    state: STATES.NATIVE_MIGRATION_REQUIRED,
    prefs: { transport: "legacy" },
    files: files(true),
    testOrigin: TEST_ORIGINS.LEGACY,
  }, { type: EVENTS.USER_TEST_NATIVE });
  assert.equal(value.state, STATES.TESTING_NATIVE);
  assert.equal(value.testOrigin, TEST_ORIGINS.LEGACY);
  assert.deepEqual(effectTypes(value), [
    SIDE_EFFECTS.START_NATIVE_POLLER,
    SIDE_EFFECTS.SEND_TEST_CARD,
  ]);
});

for (const state of [STATES.NATIVE_MIGRATION_REQUIRED, STATES.NEEDS_SETUP, STATES.IDLE]) {
  test(`${state} rechecks live config before starting a test`, () => {
    const value = applyEvent({
      state,
      prefs: state === STATES.IDLE ? { transport: "off" } : { transport: "legacy" },
      files: files(false),
      testOrigin: state === STATES.IDLE ? TEST_ORIGINS.IDLE : TEST_ORIGINS.LEGACY,
    }, { type: EVENTS.USER_TEST_NATIVE });
    assert.equal(value.state, STATES.NEEDS_SETUP);
    assert.equal(value.errorCode, ERROR_CODES.CONFIG_INCOMPLETE);
    assert.deepEqual(value.sideEffects, []);
  });
}

test("NEEDS_SETUP can start immediately after live config is repaired", () => {
  const value = applyEvent({
    state: STATES.NEEDS_SETUP,
    prefs: { transport: "legacy" },
    files: files(true),
    testOrigin: TEST_ORIGINS.LEGACY,
  }, { type: EVENTS.USER_TEST_NATIVE });
  assert.equal(value.state, STATES.TESTING_NATIVE);
  assert.equal(value.testOrigin, TEST_ORIGINS.LEGACY);
});

test("successful real callback selects native and persists verification time", () => {
  const value = applyEvent({
    state: STATES.TESTING_NATIVE,
    prefs: { transport: "legacy" },
    files: files(true),
    testOrigin: TEST_ORIGINS.LEGACY,
  }, { type: EVENTS.TEST_SUCCESS, at: 456 });
  assert.equal(value.state, STATES.NATIVE_ACTIVE);
  assert.deepEqual(value.prefsPatch, { transport: "native", nativeVerifiedAt: 456 });
});

for (const origin of [TEST_ORIGINS.LEGACY, TEST_ORIGINS.NATIVE_UNVERIFIED]) {
  for (const eventType of [EVENTS.TEST_FAILED, EVENTS.TEST_TIMEOUT]) {
    test(`${origin} ${eventType} returns to migration-required without fallback`, () => {
      const value = applyEvent({
        state: STATES.TESTING_NATIVE,
        prefs: origin === TEST_ORIGINS.LEGACY
          ? { transport: "legacy" }
          : { transport: "native", nativeVerifiedAt: null },
        files: files(true),
        testOrigin: origin,
      }, { type: eventType });
      assert.equal(value.state, STATES.NATIVE_MIGRATION_REQUIRED);
      assert.deepEqual(effectTypes(value), [SIDE_EFFECTS.STOP_NATIVE_POLLER]);
    });
  }
}

test("IDLE-origin test failure returns to IDLE", () => {
  const value = applyEvent({
    state: STATES.TESTING_NATIVE,
    prefs: { transport: "off" },
    files: files(true),
    testOrigin: TEST_ORIGINS.IDLE,
  }, { type: EVENTS.TEST_FAILED });
  assert.equal(value.state, STATES.IDLE);
});

test("disable persists explicit off before stopping native", () => {
  const value = applyEvent({
    state: STATES.NATIVE_ACTIVE,
    prefs: { transport: "native", nativeVerifiedAt: 1 },
    files: files(true),
  }, { type: EVENTS.USER_DISABLE });
  assert.equal(value.state, STATES.IDLE);
  assert.deepEqual(effectTypes(value), [
    SIDE_EFFECTS.PERSIST_PREFS,
    SIDE_EFFECTS.STOP_NATIVE_POLLER,
  ]);
  assert.deepEqual(value.prefsPatch, { transport: "off", nativeVerifiedAt: null });
});

test("late terminal events are illegal and carry no effects", () => {
  const value = applyEvent({
    state: STATES.NATIVE_ACTIVE,
    prefs: { transport: "native", nativeVerifiedAt: 1 },
    files: files(true),
  }, { type: EVENTS.TEST_TIMEOUT });
  assert.equal(value.errorCode, ERROR_CODES.ILLEGAL_TRANSITION);
  assert.deepEqual(value.sideEffects, []);
});

test("the exported transition vocabulary contains no legacy runtime event/effect", () => {
  const forbidden = /SIDECAR|ROLLBACK|ENABLE_LEGACY|LEGACY_ACTIVE|SWITCHING_TO_LEGACY/;
  for (const value of [
    ...Object.values(STATES),
    ...Object.values(EVENTS),
    ...Object.values(SIDE_EFFECTS),
  ]) {
    assert.doesNotMatch(value, forbidden);
  }
  assert.deepEqual(checkInvariants({ sideEffects: [{ type: SIDE_EFFECTS.START_NATIVE_POLLER }] }), []);
});
