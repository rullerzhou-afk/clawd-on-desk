"use strict";

// Enumerated transition table for the Telegram migration state machine.
// Each case is: { name, state, prefs, files, event, expect: { state, sideEffectTypes, errorCode?, prefsPatch? } }
//
// Conventions:
//   - sideEffectTypes is an ordered array of side-effect `.type` strings; the
//     test driver checks order and exact set.
//   - When `errorCode` is omitted, the case is a "legal" transition; when
//     present (and not null), the case is an "illegal event under this state"
//     and the expected state MUST equal the input state.
//   - prefsPatch is the persisted-fields diff produced by reducer; omitted
//     means none.

const {
  STATES,
  EVENTS,
  SIDE_EFFECTS,
  ERROR_CODES,
} = require("../../src/telegram-migration-state");

const fullLegacyFiles = {
  hasLegacyEnvFile: true,
  legacyConfigComplete: true,
  nativeConfigComplete: false,
};
const fullNativeFiles = {
  hasLegacyEnvFile: false,
  legacyConfigComplete: false,
  nativeConfigComplete: true,
};
const bothConfigsFiles = {
  hasLegacyEnvFile: true,
  legacyConfigComplete: true,
  nativeConfigComplete: true,
};
const emptyFiles = {
  hasLegacyEnvFile: false,
  legacyConfigComplete: false,
  nativeConfigComplete: false,
};
const partialLegacyFiles = {
  hasLegacyEnvFile: true,
  legacyConfigComplete: false,
  nativeConfigComplete: false,
};

// Explicit "off" — user has previously disabled remote approval.
const prefsOff = { transport: "off", nativeVerifiedAt: null, migration: { importedAt: null, importError: null } };
// "Undecided" — v0.8.x user upgrading; prefs file has no `transport` key yet.
const prefsUndecided = { nativeVerifiedAt: null, migration: { importedAt: null, importError: null } };
// v0.8.x user who had Telegram explicitly disabled (tgApproval.enabled === false).
const prefsUndecidedOptOut = { ...prefsUndecided, legacyEnabled: false };
// v0.8.x user who had Telegram enabled — same as prefsUndecided semantically,
// but pinned for clarity in the table.
const prefsUndecidedOptIn = { ...prefsUndecided, legacyEnabled: true };
const prefsLegacy = { ...prefsOff, transport: "legacy" };
const prefsNativeVerified = { ...prefsOff, transport: "native", nativeVerifiedAt: 1700000000000 };
const prefsNativeUnverified = { ...prefsOff, transport: "native", nativeVerifiedAt: null };

// ============================================================================
// INIT (startup normalization) — drives `computeInitial`.
// ============================================================================
const initCases = [
  {
    name: "INIT: fresh install (no prefs, no files) → IDLE",
    state: STATES.IDLE,
    prefs: prefsOff,
    files: emptyFiles,
    event: { type: EVENTS.INIT },
    expect: { state: STATES.IDLE, sideEffectTypes: [] },
  },
  {
    name: "INIT: legacy v0.8.x user upgrading (no transport pref) + full env → LEGACY_ACTIVE",
    state: STATES.IDLE,
    prefs: prefsUndecided,
    files: fullLegacyFiles,
    event: { type: EVENTS.INIT },
    expect: { state: STATES.LEGACY_ACTIVE, sideEffectTypes: [SIDE_EFFECTS.START_SIDECAR] },
  },
  {
    name: "INIT: v0.8.x user upgrading with legacyEnabled=true + full env → LEGACY_ACTIVE",
    state: STATES.IDLE,
    prefs: prefsUndecidedOptIn,
    files: fullLegacyFiles,
    event: { type: EVENTS.INIT },
    expect: { state: STATES.LEGACY_ACTIVE, sideEffectTypes: [SIDE_EFFECTS.START_SIDECAR] },
  },
  {
    name: "INIT: v0.8.x user who had Telegram disabled (legacyEnabled=false) → IDLE, NOT re-enabled",
    state: STATES.IDLE,
    prefs: prefsUndecidedOptOut,
    files: fullLegacyFiles,
    event: { type: EVENTS.INIT },
    expect: { state: STATES.IDLE, sideEffectTypes: [] },
  },
  {
    name: "INIT: v0.8.x opt-out user with partial legacy files → IDLE (still respects opt-out)",
    state: STATES.IDLE,
    prefs: prefsUndecidedOptOut,
    files: partialLegacyFiles,
    event: { type: EVENTS.INIT },
    expect: { state: STATES.IDLE, sideEffectTypes: [] },
  },
  {
    name: "INIT: user explicitly disabled (transport=off) ignores leftover legacy files",
    state: STATES.IDLE,
    prefs: prefsOff,
    files: fullLegacyFiles,
    event: { type: EVENTS.INIT },
    expect: { state: STATES.IDLE, sideEffectTypes: [] },
  },
  {
    name: "INIT: transport=legacy persisted + legacy files complete → LEGACY_ACTIVE",
    state: STATES.IDLE,
    prefs: prefsLegacy,
    files: fullLegacyFiles,
    event: { type: EVENTS.INIT },
    expect: { state: STATES.LEGACY_ACTIVE, sideEffectTypes: [SIDE_EFFECTS.START_SIDECAR] },
  },
  {
    name: "INIT: transport=native verified + native config complete → NATIVE_ACTIVE",
    state: STATES.IDLE,
    prefs: prefsNativeVerified,
    files: fullNativeFiles,
    event: { type: EVENTS.INIT },
    expect: { state: STATES.NATIVE_ACTIVE, sideEffectTypes: [SIDE_EFFECTS.START_NATIVE_POLLER] },
  },
  {
    name: "INIT: transport=native but nativeVerifiedAt null → NEEDS_SETUP",
    state: STATES.IDLE,
    prefs: prefsNativeUnverified,
    files: fullNativeFiles,
    event: { type: EVENTS.INIT },
    expect: { state: STATES.NEEDS_SETUP, sideEffectTypes: [] },
  },
  {
    name: "INIT: transport=legacy persisted but env partial → NEEDS_SETUP",
    state: STATES.IDLE,
    prefs: prefsLegacy,
    files: partialLegacyFiles,
    event: { type: EVENTS.INIT },
    expect: { state: STATES.NEEDS_SETUP, sideEffectTypes: [] },
  },
  {
    name: "INIT: invalid transport value → normalized silently, falls back per files",
    state: STATES.IDLE,
    prefs: { transport: "garbage", nativeVerifiedAt: null, migration: {} },
    files: emptyFiles,
    event: { type: EVENTS.INIT },
    expect: { state: STATES.IDLE, sideEffectTypes: [] },
  },
  {
    name: "INIT: invalid transport + legacy file residue → NEEDS_SETUP (normalized)",
    state: STATES.IDLE,
    prefs: { transport: "garbage", nativeVerifiedAt: null, migration: {} },
    files: partialLegacyFiles,
    event: { type: EVENTS.INIT },
    expect: { state: STATES.NEEDS_SETUP, sideEffectTypes: [] },
  },
];

// ============================================================================
// USER_TEST_NATIVE
// ============================================================================
const userTestCases = [
  {
    name: "USER_TEST_NATIVE @ IDLE with native config → TESTING_NATIVE (no STOP_SIDECAR)",
    state: STATES.IDLE,
    prefs: prefsOff,
    files: fullNativeFiles,
    event: { type: EVENTS.USER_TEST_NATIVE },
    expect: {
      state: STATES.TESTING_NATIVE,
      sideEffectTypes: [SIDE_EFFECTS.START_NATIVE_POLLER, SIDE_EFFECTS.SEND_TEST_CARD],
    },
  },
  {
    name: "USER_TEST_NATIVE @ LEGACY_ACTIVE with native config → TESTING_NATIVE (stops sidecar first)",
    state: STATES.LEGACY_ACTIVE,
    prefs: prefsLegacy,
    files: bothConfigsFiles,
    event: { type: EVENTS.USER_TEST_NATIVE },
    expect: {
      state: STATES.TESTING_NATIVE,
      sideEffectTypes: [
        SIDE_EFFECTS.STOP_SIDECAR,
        SIDE_EFFECTS.START_NATIVE_POLLER,
        SIDE_EFFECTS.SEND_TEST_CARD,
      ],
    },
  },
  {
    name: "USER_TEST_NATIVE @ IDLE without native config → illegal",
    state: STATES.IDLE,
    prefs: prefsOff,
    files: emptyFiles,
    event: { type: EVENTS.USER_TEST_NATIVE },
    expect: { state: STATES.IDLE, sideEffectTypes: [], errorCode: ERROR_CODES.ILLEGAL_TRANSITION },
  },
  {
    name: "USER_TEST_NATIVE @ NATIVE_ACTIVE → illegal (already active)",
    state: STATES.NATIVE_ACTIVE,
    prefs: prefsNativeVerified,
    files: fullNativeFiles,
    event: { type: EVENTS.USER_TEST_NATIVE },
    expect: {
      state: STATES.NATIVE_ACTIVE,
      sideEffectTypes: [],
      errorCode: ERROR_CODES.ILLEGAL_TRANSITION,
    },
  },
  {
    name: "USER_TEST_NATIVE @ TESTING_NATIVE → illegal (already testing)",
    state: STATES.TESTING_NATIVE,
    prefs: prefsOff,
    files: fullNativeFiles,
    event: { type: EVENTS.USER_TEST_NATIVE },
    expect: {
      state: STATES.TESTING_NATIVE,
      sideEffectTypes: [],
      errorCode: ERROR_CODES.ILLEGAL_TRANSITION,
    },
  },
];

// ============================================================================
// TEST_SUCCESS / TEST_FAILED
// ============================================================================
const testOutcomeCases = [
  {
    name: "TEST_SUCCESS @ TESTING_NATIVE → NATIVE_ACTIVE + persist transport=native",
    state: STATES.TESTING_NATIVE,
    prefs: prefsOff,
    files: fullNativeFiles,
    event: { type: EVENTS.TEST_SUCCESS, at: 1700000123456 },
    expect: {
      state: STATES.NATIVE_ACTIVE,
      sideEffectTypes: [SIDE_EFFECTS.PERSIST_PREFS],
      prefsPatch: { transport: "native", nativeVerifiedAt: 1700000123456 },
    },
  },
  {
    name: "TEST_SUCCESS @ LEGACY_ACTIVE → illegal",
    state: STATES.LEGACY_ACTIVE,
    prefs: prefsLegacy,
    files: fullLegacyFiles,
    event: { type: EVENTS.TEST_SUCCESS, at: 1700000000000 },
    expect: {
      state: STATES.LEGACY_ACTIVE,
      sideEffectTypes: [],
      errorCode: ERROR_CODES.ILLEGAL_TRANSITION,
    },
  },
  {
    name: "TEST_FAILED @ TESTING_NATIVE with legacy files → LEGACY_ACTIVE (restart sidecar)",
    state: STATES.TESTING_NATIVE,
    prefs: prefsLegacy,
    files: bothConfigsFiles,
    event: { type: EVENTS.TEST_FAILED, errorClass: "timeout" },
    expect: {
      state: STATES.LEGACY_ACTIVE,
      sideEffectTypes: [SIDE_EFFECTS.STOP_NATIVE_POLLER, SIDE_EFFECTS.START_SIDECAR],
    },
  },
  {
    name: "TEST_FAILED @ TESTING_NATIVE new user with native config only → IDLE",
    state: STATES.TESTING_NATIVE,
    prefs: prefsOff,
    files: fullNativeFiles,
    event: { type: EVENTS.TEST_FAILED, errorClass: "401" },
    expect: {
      state: STATES.IDLE,
      sideEffectTypes: [SIDE_EFFECTS.STOP_NATIVE_POLLER],
    },
  },
  {
    name: "TEST_FAILED @ TESTING_NATIVE no fallback config → NEEDS_SETUP",
    state: STATES.TESTING_NATIVE,
    prefs: prefsOff,
    files: emptyFiles,
    event: { type: EVENTS.TEST_FAILED, errorClass: "401" },
    expect: {
      state: STATES.NEEDS_SETUP,
      sideEffectTypes: [SIDE_EFFECTS.STOP_NATIVE_POLLER],
    },
  },
  {
    name: "TEST_FAILED @ IDLE → illegal",
    state: STATES.IDLE,
    prefs: prefsOff,
    files: emptyFiles,
    event: { type: EVENTS.TEST_FAILED, errorClass: "timeout" },
    expect: { state: STATES.IDLE, sideEffectTypes: [], errorCode: ERROR_CODES.ILLEGAL_TRANSITION },
  },
  {
    name: "TEST_TIMEOUT @ TESTING_NATIVE with legacy files → LEGACY_ACTIVE",
    state: STATES.TESTING_NATIVE,
    prefs: prefsLegacy,
    files: bothConfigsFiles,
    event: { type: EVENTS.TEST_TIMEOUT },
    expect: {
      state: STATES.LEGACY_ACTIVE,
      sideEffectTypes: [SIDE_EFFECTS.STOP_NATIVE_POLLER, SIDE_EFFECTS.START_SIDECAR],
    },
  },
  {
    name: "TEST_TIMEOUT @ TESTING_NATIVE new user → IDLE",
    state: STATES.TESTING_NATIVE,
    prefs: prefsOff,
    files: fullNativeFiles,
    event: { type: EVENTS.TEST_TIMEOUT },
    expect: { state: STATES.IDLE, sideEffectTypes: [SIDE_EFFECTS.STOP_NATIVE_POLLER] },
  },
  {
    name: "TEST_TIMEOUT @ LEGACY_ACTIVE → illegal",
    state: STATES.LEGACY_ACTIVE,
    prefs: prefsLegacy,
    files: fullLegacyFiles,
    event: { type: EVENTS.TEST_TIMEOUT },
    expect: { state: STATES.LEGACY_ACTIVE, sideEffectTypes: [], errorCode: ERROR_CODES.ILLEGAL_TRANSITION },
  },
  {
    name: "TEST_FAILED @ TESTING_NATIVE legacyEnabled=false → NEEDS_SETUP (NOT auto-restart sidecar)",
    state: STATES.TESTING_NATIVE,
    prefs: { ...prefsLegacy, legacyEnabled: false },
    files: bothConfigsFiles,
    event: { type: EVENTS.TEST_FAILED, errorClass: "401" },
    // legacyEnabled === false ⇒ skip the sidecar restart path. Native config
    // is also present so the user can retry test; we fall to IDLE.
    expect: { state: STATES.IDLE, sideEffectTypes: [SIDE_EFFECTS.STOP_NATIVE_POLLER] },
  },
];

// ============================================================================
// Rollback / sidecar lifecycle
// ============================================================================
const rollbackCases = [
  {
    name: "USER_ROLLBACK_TO_LEGACY @ NATIVE_ACTIVE with legacy env → SWITCHING_TO_LEGACY",
    state: STATES.NATIVE_ACTIVE,
    prefs: prefsNativeVerified,
    files: bothConfigsFiles,
    event: { type: EVENTS.USER_ROLLBACK_TO_LEGACY },
    expect: {
      state: STATES.SWITCHING_TO_LEGACY,
      sideEffectTypes: [SIDE_EFFECTS.STOP_NATIVE_POLLER, SIDE_EFFECTS.START_SIDECAR],
    },
  },
  {
    name: "USER_ROLLBACK_TO_LEGACY @ NATIVE_ACTIVE without legacy env → LEGACY_ENV_MISSING",
    state: STATES.NATIVE_ACTIVE,
    prefs: prefsNativeVerified,
    files: fullNativeFiles,
    event: { type: EVENTS.USER_ROLLBACK_TO_LEGACY },
    expect: {
      state: STATES.NATIVE_ACTIVE,
      sideEffectTypes: [],
      errorCode: ERROR_CODES.LEGACY_ENV_MISSING,
    },
  },
  {
    name: "USER_ROLLBACK_TO_LEGACY with env present but config incomplete → LEGACY_CONFIG_INCOMPLETE",
    state: STATES.NATIVE_ACTIVE,
    prefs: prefsNativeVerified,
    files: { hasLegacyEnvFile: true, legacyConfigComplete: false, nativeConfigComplete: true },
    event: { type: EVENTS.USER_ROLLBACK_TO_LEGACY },
    expect: {
      state: STATES.NATIVE_ACTIVE,
      sideEffectTypes: [],
      errorCode: ERROR_CODES.LEGACY_CONFIG_INCOMPLETE,
    },
  },
  {
    name: "USER_ENABLE_LEGACY @ IDLE with legacy config → LEGACY_ACTIVE + persist legacyEnabled=true",
    state: STATES.IDLE,
    prefs: prefsOff,
    files: fullLegacyFiles,
    event: { type: EVENTS.USER_ENABLE_LEGACY },
    expect: {
      state: STATES.LEGACY_ACTIVE,
      sideEffectTypes: [SIDE_EFFECTS.START_SIDECAR, SIDE_EFFECTS.PERSIST_PREFS],
      prefsPatch: { transport: "legacy", legacyEnabled: true },
    },
  },
  {
    name: "USER_ENABLE_LEGACY @ NEEDS_SETUP with legacy config → LEGACY_ACTIVE",
    state: STATES.NEEDS_SETUP,
    prefs: prefsOff,
    files: fullLegacyFiles,
    event: { type: EVENTS.USER_ENABLE_LEGACY },
    expect: {
      state: STATES.LEGACY_ACTIVE,
      sideEffectTypes: [SIDE_EFFECTS.START_SIDECAR, SIDE_EFFECTS.PERSIST_PREFS],
      prefsPatch: { transport: "legacy", legacyEnabled: true },
    },
  },
  {
    name: "USER_ENABLE_LEGACY @ IDLE without legacy config → LEGACY_CONFIG_INCOMPLETE",
    state: STATES.IDLE,
    prefs: prefsOff,
    files: emptyFiles,
    event: { type: EVENTS.USER_ENABLE_LEGACY },
    expect: {
      state: STATES.IDLE,
      sideEffectTypes: [],
      errorCode: ERROR_CODES.LEGACY_CONFIG_INCOMPLETE,
    },
  },
  {
    name: "USER_ENABLE_LEGACY @ NATIVE_ACTIVE → illegal (must rollback explicitly)",
    state: STATES.NATIVE_ACTIVE,
    prefs: prefsNativeVerified,
    files: bothConfigsFiles,
    event: { type: EVENTS.USER_ENABLE_LEGACY },
    expect: {
      state: STATES.NATIVE_ACTIVE,
      sideEffectTypes: [],
      errorCode: ERROR_CODES.ILLEGAL_TRANSITION,
    },
  },
  {
    name: "SIDECAR_STARTED @ SWITCHING_TO_LEGACY → LEGACY_ACTIVE + persist transport=legacy",
    state: STATES.SWITCHING_TO_LEGACY,
    prefs: prefsNativeVerified,
    files: bothConfigsFiles,
    event: { type: EVENTS.SIDECAR_STARTED },
    expect: {
      state: STATES.LEGACY_ACTIVE,
      sideEffectTypes: [SIDE_EFFECTS.PERSIST_PREFS],
      prefsPatch: { transport: "legacy" },
    },
  },
  {
    name: "SIDECAR_START_FAILED @ SWITCHING_TO_LEGACY → LEGACY_ACTIVE + EMIT_RUNTIME_STATUS",
    state: STATES.SWITCHING_TO_LEGACY,
    prefs: prefsNativeVerified,
    files: bothConfigsFiles,
    event: { type: EVENTS.SIDECAR_START_FAILED, reason: "binary_missing" },
    expect: {
      state: STATES.LEGACY_ACTIVE,
      sideEffectTypes: [SIDE_EFFECTS.PERSIST_PREFS, SIDE_EFFECTS.EMIT_RUNTIME_STATUS],
      prefsPatch: { transport: "legacy" },
    },
  },
  {
    name: "SIDECAR_STARTED @ LEGACY_ACTIVE → illegal",
    state: STATES.LEGACY_ACTIVE,
    prefs: prefsLegacy,
    files: fullLegacyFiles,
    event: { type: EVENTS.SIDECAR_STARTED },
    expect: {
      state: STATES.LEGACY_ACTIVE,
      sideEffectTypes: [],
      errorCode: ERROR_CODES.ILLEGAL_TRANSITION,
    },
  },
];

// ============================================================================
// USER_DISABLE (any → IDLE)
// ============================================================================
const disableCases = [
  {
    name: "USER_DISABLE @ LEGACY_ACTIVE → IDLE + STOP_SIDECAR + persist transport=off",
    state: STATES.LEGACY_ACTIVE,
    prefs: prefsLegacy,
    files: fullLegacyFiles,
    event: { type: EVENTS.USER_DISABLE },
    expect: {
      state: STATES.IDLE,
      sideEffectTypes: [SIDE_EFFECTS.STOP_SIDECAR, SIDE_EFFECTS.PERSIST_PREFS],
    },
  },
  {
    name: "USER_DISABLE @ NATIVE_ACTIVE → IDLE + STOP_NATIVE_POLLER + persist transport=off",
    state: STATES.NATIVE_ACTIVE,
    prefs: prefsNativeVerified,
    files: fullNativeFiles,
    event: { type: EVENTS.USER_DISABLE },
    expect: {
      state: STATES.IDLE,
      sideEffectTypes: [SIDE_EFFECTS.STOP_NATIVE_POLLER, SIDE_EFFECTS.PERSIST_PREFS],
    },
  },
  {
    name: "USER_DISABLE @ TESTING_NATIVE → IDLE + STOP_NATIVE_POLLER",
    state: STATES.TESTING_NATIVE,
    prefs: prefsOff,
    files: fullNativeFiles,
    event: { type: EVENTS.USER_DISABLE },
    expect: {
      state: STATES.IDLE,
      sideEffectTypes: [SIDE_EFFECTS.STOP_NATIVE_POLLER, SIDE_EFFECTS.PERSIST_PREFS],
    },
  },
  {
    name: "USER_DISABLE @ IDLE → IDLE (no-op, still persists off)",
    state: STATES.IDLE,
    prefs: prefsOff,
    files: emptyFiles,
    event: { type: EVENTS.USER_DISABLE },
    expect: {
      state: STATES.IDLE,
      sideEffectTypes: [SIDE_EFFECTS.PERSIST_PREFS],
    },
  },
];

const ALL_CASES = [
  ...initCases,
  ...userTestCases,
  ...testOutcomeCases,
  ...rollbackCases,
  ...disableCases,
];

module.exports = {
  ALL_CASES,
  initCases,
  userTestCases,
  testOutcomeCases,
  rollbackCases,
  disableCases,
  fixtures: {
    fullLegacyFiles,
    fullNativeFiles,
    bothConfigsFiles,
    emptyFiles,
    partialLegacyFiles,
    prefsOff,
    prefsUndecided,
    prefsUndecidedOptIn,
    prefsUndecidedOptOut,
    prefsLegacy,
    prefsNativeVerified,
    prefsNativeUnverified,
  },
};
