"use strict";

// Telegram's Go sidecar was retired in v0.14. Historical "legacy" prefs are
// still read so old users can be routed to the native verification gate, but
// there is deliberately no legacy runtime state or side effect in this module.

const STATES = Object.freeze({
  IDLE: "IDLE",
  NATIVE_MIGRATION_REQUIRED: "NATIVE_MIGRATION_REQUIRED",
  TESTING_NATIVE: "TESTING_NATIVE",
  NATIVE_ACTIVE: "NATIVE_ACTIVE",
  NEEDS_SETUP: "NEEDS_SETUP",
});

const EVENTS = Object.freeze({
  INIT: "INIT",
  USER_TEST_NATIVE: "USER_TEST_NATIVE",
  TEST_SUCCESS: "TEST_SUCCESS",
  TEST_FAILED: "TEST_FAILED",
  TEST_TIMEOUT: "TEST_TIMEOUT",
  USER_DISABLE: "USER_DISABLE",
});

const SIDE_EFFECTS = Object.freeze({
  START_NATIVE_POLLER: "START_NATIVE_POLLER",
  STOP_NATIVE_POLLER: "STOP_NATIVE_POLLER",
  SEND_TEST_CARD: "SEND_TEST_CARD",
  PERSIST_PREFS: "PERSIST_PREFS",
});

const ERROR_CODES = Object.freeze({
  ILLEGAL_TRANSITION: "ILLEGAL_TRANSITION",
  CONFIG_INCOMPLETE: "CONFIG_INCOMPLETE",
  TRANSPORT_INVALID: "TRANSPORT_INVALID",
});

const TEST_ORIGINS = Object.freeze({
  LEGACY: "legacy",
  NATIVE_UNVERIFIED: "native-unverified",
  NATIVE_VERIFIED_REPAIR: "native-verified-repair",
  IDLE: "idle",
});

const VALID_TRANSPORTS = new Set(["legacy", "native", "off"]);

function defaultPrefs() {
  return {
    transport: "off",
    nativeVerifiedAt: null,
    migration: { importedAt: null, importError: null },
    legacyEnabled: null,
  };
}

function defaultFiles() {
  return {
    nativeConfigComplete: false,
  };
}

function normalizePrefs(prefs) {
  const base = defaultPrefs();
  if (!prefs || typeof prefs !== "object") {
    return {
      prefs: base,
      normalized: true,
      transportProvided: false,
      transportInvalid: false,
    };
  }
  const transportProvided = Object.prototype.hasOwnProperty.call(prefs, "transport");
  const transportValid = transportProvided && VALID_TRANSPORTS.has(prefs.transport);
  return {
    prefs: {
      transport: transportValid ? prefs.transport : "off",
      nativeVerifiedAt: Number.isFinite(prefs.nativeVerifiedAt) && prefs.nativeVerifiedAt > 0
        ? prefs.nativeVerifiedAt
        : null,
      legacyEnabled: typeof prefs.legacyEnabled === "boolean" ? prefs.legacyEnabled : null,
      migration: {
        importedAt: Number.isFinite(prefs.migration && prefs.migration.importedAt)
          ? prefs.migration.importedAt
          : null,
        importError: typeof (prefs.migration && prefs.migration.importError) === "string"
          ? prefs.migration.importError
          : null,
      },
    },
    normalized: !transportValid,
    transportProvided,
    transportInvalid: transportProvided && !transportValid,
  };
}

function normalizeFiles(files) {
  const base = defaultFiles();
  if (!files || typeof files !== "object") return base;
  return {
    nativeConfigComplete: files.nativeConfigComplete === true,
  };
}

function effect(type, payload) {
  return payload === undefined ? { type } : { type, payload };
}

function result(state, {
  sideEffects = [],
  prefsPatch = null,
  errorCode = null,
  diagnosticCode = null,
  testOrigin = null,
} = {}) {
  const out = { state, sideEffects, errorCode };
  if (prefsPatch) out.prefsPatch = prefsPatch;
  if (diagnosticCode) out.diagnosticCode = diagnosticCode;
  if (testOrigin) out.testOrigin = testOrigin;
  return out;
}

function originForPrefs(rawPrefs) {
  const normalized = normalizePrefs(rawPrefs);
  const p = normalized.prefs;
  if (!normalized.normalized && p.transport === "native") {
    return p.nativeVerifiedAt
      ? TEST_ORIGINS.NATIVE_VERIFIED_REPAIR
      : TEST_ORIGINS.NATIVE_UNVERIFIED;
  }
  if (!normalized.normalized && p.transport === "off") return TEST_ORIGINS.IDLE;
  if (!normalized.normalized && p.transport === "legacy") return TEST_ORIGINS.LEGACY;
  return p.legacyEnabled === true ? TEST_ORIGINS.LEGACY : TEST_ORIGINS.IDLE;
}

function computeInitial({ prefs, files }) {
  const normalized = normalizePrefs(prefs);
  const p = normalized.prefs;
  const f = normalizeFiles(files);
  const diagnosticCode = normalized.transportInvalid ? ERROR_CODES.TRANSPORT_INVALID : null;

  if (!normalized.normalized && p.transport === "off") {
    return result(STATES.IDLE, { diagnosticCode });
  }

  if (!normalized.normalized && p.transport === "native") {
    if (!f.nativeConfigComplete) {
      return result(STATES.NEEDS_SETUP, {
        diagnosticCode,
        testOrigin: p.nativeVerifiedAt
          ? TEST_ORIGINS.NATIVE_VERIFIED_REPAIR
          : TEST_ORIGINS.NATIVE_UNVERIFIED,
      });
    }
    if (p.nativeVerifiedAt) {
      return result(STATES.NATIVE_ACTIVE, {
        sideEffects: [effect(SIDE_EFFECTS.START_NATIVE_POLLER)],
        diagnosticCode,
      });
    }
    return result(STATES.NATIVE_MIGRATION_REQUIRED, {
      diagnosticCode,
      testOrigin: TEST_ORIGINS.NATIVE_UNVERIFIED,
    });
  }

  if (!normalized.normalized && p.transport === "legacy") {
    return result(
      f.nativeConfigComplete ? STATES.NATIVE_MIGRATION_REQUIRED : STATES.NEEDS_SETUP,
      { diagnosticCode, testOrigin: TEST_ORIGINS.LEGACY },
    );
  }

  // Missing/invalid transport is legacy only when the old enable intent is
  // explicit. main.js mirrors the v0.8 tgApproval.enabled bit into this field
  // when the historical tgMigration object did not carry it.
  if (p.legacyEnabled === true) {
    return result(
      f.nativeConfigComplete ? STATES.NATIVE_MIGRATION_REQUIRED : STATES.NEEDS_SETUP,
      { diagnosticCode, testOrigin: TEST_ORIGINS.LEGACY },
    );
  }
  return result(STATES.IDLE, { diagnosticCode, testOrigin: TEST_ORIGINS.IDLE });
}

function incompleteResult() {
  return result(STATES.NEEDS_SETUP, { errorCode: ERROR_CODES.CONFIG_INCOMPLETE });
}

function applyEvent({ state, prefs, files, testOrigin }, event) {
  if (!event || typeof event !== "object" || !event.type) {
    return result(state, { errorCode: ERROR_CODES.ILLEGAL_TRANSITION });
  }
  if (event.type === EVENTS.INIT) return computeInitial({ prefs, files });

  const f = normalizeFiles(files);

  if (event.type === EVENTS.USER_DISABLE) {
    const sideEffects = [
      effect(SIDE_EFFECTS.PERSIST_PREFS, {
        transport: "off",
        nativeVerifiedAt: null,
      }),
    ];
    if (state === STATES.NATIVE_ACTIVE || state === STATES.TESTING_NATIVE) {
      sideEffects.push(effect(SIDE_EFFECTS.STOP_NATIVE_POLLER));
    }
    return result(STATES.IDLE, {
      sideEffects,
      prefsPatch: { transport: "off", nativeVerifiedAt: null },
    });
  }

  if (event.type === EVENTS.USER_TEST_NATIVE) {
    if (![STATES.IDLE, STATES.NEEDS_SETUP, STATES.NATIVE_MIGRATION_REQUIRED].includes(state)) {
      return result(state, { errorCode: ERROR_CODES.ILLEGAL_TRANSITION });
    }
    if (!f.nativeConfigComplete) return incompleteResult();
    const origin = state === STATES.IDLE
      ? TEST_ORIGINS.IDLE
      : (testOrigin || originForPrefs(prefs));
    return result(STATES.TESTING_NATIVE, {
      sideEffects: [
        effect(SIDE_EFFECTS.START_NATIVE_POLLER),
        effect(SIDE_EFFECTS.SEND_TEST_CARD),
      ],
      testOrigin: origin,
    });
  }

  if (event.type === EVENTS.TEST_SUCCESS) {
    if (state !== STATES.TESTING_NATIVE) {
      return result(state, { errorCode: ERROR_CODES.ILLEGAL_TRANSITION });
    }
    const verifiedAt = Number.isFinite(event.at) && event.at > 0 ? event.at : Date.now();
    const prefsPatch = { transport: "native", nativeVerifiedAt: verifiedAt };
    return result(STATES.NATIVE_ACTIVE, {
      sideEffects: [effect(SIDE_EFFECTS.PERSIST_PREFS, prefsPatch)],
      prefsPatch,
    });
  }

  if (event.type === EVENTS.TEST_FAILED || event.type === EVENTS.TEST_TIMEOUT) {
    if (state !== STATES.TESTING_NATIVE) {
      return result(state, { errorCode: ERROR_CODES.ILLEGAL_TRANSITION });
    }
    const origin = testOrigin || originForPrefs(prefs);
    return result(
      origin === TEST_ORIGINS.IDLE ? STATES.IDLE : STATES.NATIVE_MIGRATION_REQUIRED,
      {
        sideEffects: [effect(SIDE_EFFECTS.STOP_NATIVE_POLLER)],
        testOrigin: origin,
      },
    );
  }

  return result(state, { errorCode: ERROR_CODES.ILLEGAL_TRANSITION });
}

function checkInvariants({ sideEffects } = {}) {
  const violations = [];
  const known = new Set(Object.values(SIDE_EFFECTS));
  for (const entry of Array.isArray(sideEffects) ? sideEffects : []) {
    if (!entry || !known.has(entry.type)) violations.push(`unknown side effect: ${entry && entry.type}`);
  }
  return violations;
}

module.exports = {
  STATES,
  EVENTS,
  SIDE_EFFECTS,
  ERROR_CODES,
  TEST_ORIGINS,
  defaultPrefs,
  defaultFiles,
  normalizePrefs,
  normalizeFiles,
  originForPrefs,
  computeInitial,
  applyEvent,
  checkInvariants,
};
