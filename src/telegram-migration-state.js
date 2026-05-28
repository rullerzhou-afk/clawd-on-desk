"use strict";

const STATES = Object.freeze({
  IDLE: "IDLE",
  LEGACY_ACTIVE: "LEGACY_ACTIVE",
  TESTING_NATIVE: "TESTING_NATIVE",
  NATIVE_ACTIVE: "NATIVE_ACTIVE",
  SWITCHING_TO_LEGACY: "SWITCHING_TO_LEGACY",
  NEEDS_SETUP: "NEEDS_SETUP",
});

const EVENTS = Object.freeze({
  INIT: "INIT",
  USER_TEST_NATIVE: "USER_TEST_NATIVE",
  USER_ENABLE_LEGACY: "USER_ENABLE_LEGACY",
  TEST_SUCCESS: "TEST_SUCCESS",
  TEST_FAILED: "TEST_FAILED",
  // 60s wall-clock timeout while waiting for the user's Telegram tap.
  // The reducer treats it as a sub-case of TEST_FAILED, but having a distinct
  // event type means the driver (owner-manager or the UI orchestrator) MUST
  // own a wall-clock timer that dispatches this when no callback arrives,
  // otherwise TESTING_NATIVE hangs indefinitely.
  TEST_TIMEOUT: "TEST_TIMEOUT",
  USER_ROLLBACK_TO_LEGACY: "USER_ROLLBACK_TO_LEGACY",
  SIDECAR_STARTED: "SIDECAR_STARTED",
  SIDECAR_START_FAILED: "SIDECAR_START_FAILED",
  USER_DISABLE: "USER_DISABLE",
});

const SIDE_EFFECTS = Object.freeze({
  START_SIDECAR: "START_SIDECAR",
  STOP_SIDECAR: "STOP_SIDECAR",
  START_NATIVE_POLLER: "START_NATIVE_POLLER",
  STOP_NATIVE_POLLER: "STOP_NATIVE_POLLER",
  SEND_TEST_CARD: "SEND_TEST_CARD",
  PERSIST_PREFS: "PERSIST_PREFS",
  // Runtime-status notifications for the UI. The reducer emits these when the
  // state alone cannot express whether the transport is healthy (e.g. a
  // sidecar start that failed still resolves to LEGACY_ACTIVE per plan §130,
  // but the UI must surface "failed" so the user knows approval is broken).
  EMIT_RUNTIME_STATUS: "EMIT_RUNTIME_STATUS",
});

const ERROR_CODES = Object.freeze({
  ILLEGAL_TRANSITION: "ILLEGAL_TRANSITION",
  TRANSPORT_NORMALIZED: "TRANSPORT_NORMALIZED",
  // Rollback / re-enable refused because the on-disk legacy env file is gone.
  LEGACY_ENV_MISSING: "LEGACY_ENV_MISSING",
  // Rollback / re-enable refused because legacy env exists but other config
  // (toml / user id / chat id) is incomplete — UI can offer "fix legacy
  // setup" instead of an opaque illegal-transition toast.
  LEGACY_CONFIG_INCOMPLETE: "LEGACY_CONFIG_INCOMPLETE",
});

const VALID_TRANSPORTS = new Set(["legacy", "native", "off"]);

function defaultPrefs() {
  return {
    transport: "off",
    nativeVerifiedAt: null,
    migration: { importedAt: null, importError: null },
    // legacyEnabled mirrors v0.8.x tgApproval.enabled. Tri-state:
    //   true  = v0.8.x user had Telegram approval enabled
    //   false = v0.8.x user had it explicitly disabled (must not auto-activate)
    //   null  = unknown / fresh install
    legacyEnabled: null,
  };
}

function defaultFiles() {
  return {
    hasLegacyEnvFile: false,
    legacyConfigComplete: false,
    nativeConfigComplete: false,
  };
}

function normalizePrefs(prefs) {
  const base = defaultPrefs();
  if (!prefs || typeof prefs !== "object") return { prefs: base, normalized: true };
  const hasTransport = Object.prototype.hasOwnProperty.call(prefs, "transport");
  const transportValid = hasTransport && VALID_TRANSPORTS.has(prefs.transport);
  const out = {
    transport: transportValid ? prefs.transport : "off",
    nativeVerifiedAt: typeof prefs.nativeVerifiedAt === "number" ? prefs.nativeVerifiedAt : null,
    legacyEnabled: typeof prefs.legacyEnabled === "boolean" ? prefs.legacyEnabled : null,
    migration: {
      importedAt:
        prefs.migration && typeof prefs.migration.importedAt === "number"
          ? prefs.migration.importedAt
          : null,
      importError:
        prefs.migration && typeof prefs.migration.importError === "string"
          ? prefs.migration.importError
          : null,
    },
  };
  // "normalized" = caller did not supply a valid transport value. Either the
  // field was missing (legacy user upgrading from v0.8.x) or it held garbage.
  // Per plan §99-101 this is not an error — the reducer falls back to file
  // detection without raising errorCode.
  const normalized = !transportValid;
  return { prefs: out, normalized };
}

function normalizeFiles(files) {
  const base = defaultFiles();
  if (!files || typeof files !== "object") return base;
  return {
    hasLegacyEnvFile: !!files.hasLegacyEnvFile,
    legacyConfigComplete: !!files.legacyConfigComplete,
    nativeConfigComplete: !!files.nativeConfigComplete,
  };
}

function effect(type, payload) {
  return payload === undefined ? { type } : { type, payload };
}

function ok(state, sideEffects = [], prefsPatch = null, errorCode = null) {
  const result = { state, sideEffects, errorCode };
  if (prefsPatch) result.prefsPatch = prefsPatch;
  return result;
}

function illegal(currentState, code = ERROR_CODES.ILLEGAL_TRANSITION) {
  return { state: currentState, sideEffects: [], errorCode: code };
}

function computeInitial({ prefs, files }) {
  const normalizedPrefs = normalizePrefs(prefs);
  const f = normalizeFiles(files);
  const p = normalizedPrefs.prefs;

  // Explicit "off" → user disabled remote approval, regardless of file state.
  if (p.transport === "off" && !normalizedPrefs.normalized) {
    return ok(STATES.IDLE, []);
  }

  if (p.transport === "legacy") {
    if (f.legacyConfigComplete) {
      return ok(STATES.LEGACY_ACTIVE, [effect(SIDE_EFFECTS.START_SIDECAR)]);
    }
    return ok(STATES.NEEDS_SETUP, []);
  }

  if (p.transport === "native") {
    if (f.nativeConfigComplete && p.nativeVerifiedAt) {
      return ok(STATES.NATIVE_ACTIVE, [effect(SIDE_EFFECTS.START_NATIVE_POLLER)]);
    }
    return ok(STATES.NEEDS_SETUP, []);
  }

  // transport was missing or invalid → "undecided"; detect legacy artefacts.
  // Plan §81 + safety: only auto-activate legacy if the v0.8.x user had
  // tgApproval.enabled === true. If they had explicitly disabled remote
  // approval (legacyEnabled === false), respect that and stay IDLE — otherwise
  // upgrading to v0.9.0 would silently re-enable Telegram for them.
  // legacyEnabled === null means "we don't know" — treat as enabled to keep
  // backwards-compat for callers that don't supply the field yet.
  const legacyOptedOut = p.legacyEnabled === false;
  if (f.legacyConfigComplete && !legacyOptedOut) {
    return ok(STATES.LEGACY_ACTIVE, [effect(SIDE_EFFECTS.START_SIDECAR)]);
  }
  if (f.hasLegacyEnvFile && !f.legacyConfigComplete && !legacyOptedOut) {
    return ok(STATES.NEEDS_SETUP, []);
  }
  return ok(STATES.IDLE, []);
}

function applyEvent({ state, prefs, files }, event) {
  if (!event || typeof event !== "object" || !event.type) {
    return illegal(state);
  }
  if (event.type === EVENTS.INIT) {
    return computeInitial({ prefs, files });
  }

  const f = normalizeFiles(files);
  const p = normalizePrefs(prefs).prefs;

  if (event.type === EVENTS.USER_DISABLE) {
    const fx = [];
    if (state === STATES.LEGACY_ACTIVE || state === STATES.SWITCHING_TO_LEGACY) {
      fx.push(effect(SIDE_EFFECTS.STOP_SIDECAR));
    }
    if (state === STATES.NATIVE_ACTIVE || state === STATES.TESTING_NATIVE) {
      fx.push(effect(SIDE_EFFECTS.STOP_NATIVE_POLLER));
    }
    fx.push(effect(SIDE_EFFECTS.PERSIST_PREFS, { transport: "off" }));
    return ok(STATES.IDLE, fx);
  }

  if (event.type === EVENTS.USER_ENABLE_LEGACY) {
    // Restore legacy mode (old user previously disabled, or new user picks
    // legacy explicitly from Settings). Requires legacy env+config to be
    // intact; otherwise illegal so the UI surfaces a setup card.
    if (state !== STATES.IDLE && state !== STATES.NEEDS_SETUP && state !== STATES.LEGACY_ACTIVE) {
      return illegal(state);
    }
    if (!f.legacyConfigComplete) {
      return illegal(state, ERROR_CODES.LEGACY_CONFIG_INCOMPLETE);
    }
    return ok(
      STATES.LEGACY_ACTIVE,
      [
        effect(SIDE_EFFECTS.START_SIDECAR),
        effect(SIDE_EFFECTS.PERSIST_PREFS, { transport: "legacy", legacyEnabled: true }),
      ],
      { transport: "legacy", legacyEnabled: true },
    );
  }

  if (event.type === EVENTS.USER_TEST_NATIVE) {
    if (state === STATES.IDLE || state === STATES.NEEDS_SETUP) {
      if (!f.nativeConfigComplete) return illegal(state);
      return ok(STATES.TESTING_NATIVE, [
        effect(SIDE_EFFECTS.START_NATIVE_POLLER),
        effect(SIDE_EFFECTS.SEND_TEST_CARD),
      ]);
    }
    if (state === STATES.LEGACY_ACTIVE) {
      if (!f.nativeConfigComplete) return illegal(state);
      return ok(STATES.TESTING_NATIVE, [
        effect(SIDE_EFFECTS.STOP_SIDECAR),
        effect(SIDE_EFFECTS.START_NATIVE_POLLER),
        effect(SIDE_EFFECTS.SEND_TEST_CARD),
      ]);
    }
    return illegal(state);
  }

  if (event.type === EVENTS.TEST_SUCCESS) {
    if (state !== STATES.TESTING_NATIVE) return illegal(state);
    const verifiedAt = typeof event.at === "number" ? event.at : Date.now();
    return ok(
      STATES.NATIVE_ACTIVE,
      [effect(SIDE_EFFECTS.PERSIST_PREFS, { transport: "native", nativeVerifiedAt: verifiedAt })],
      { transport: "native", nativeVerifiedAt: verifiedAt },
    );
  }

  if (event.type === EVENTS.TEST_FAILED || event.type === EVENTS.TEST_TIMEOUT) {
    if (state !== STATES.TESTING_NATIVE) return illegal(state);
    // Stop native poller first regardless of fallback target.
    const fx = [effect(SIDE_EFFECTS.STOP_NATIVE_POLLER)];
    // legacyConfigComplete alone is not enough: we must also respect the
    // v0.8.x opt-out signal. If the user had Telegram explicitly disabled in
    // v0.8 (legacyEnabled === false) we do NOT auto-restart the sidecar.
    const legacyAvailable = f.legacyConfigComplete && p.legacyEnabled !== false;
    if (legacyAvailable) {
      fx.push(effect(SIDE_EFFECTS.START_SIDECAR));
      return ok(STATES.LEGACY_ACTIVE, fx);
    }
    if (f.nativeConfigComplete) {
      // New user, native config there but test failed — stay at IDLE so they can retry.
      return ok(STATES.IDLE, fx);
    }
    return ok(STATES.NEEDS_SETUP, fx);
  }

  if (event.type === EVENTS.USER_ROLLBACK_TO_LEGACY) {
    if (state !== STATES.NATIVE_ACTIVE) return illegal(state);
    if (!f.hasLegacyEnvFile) return illegal(state, ERROR_CODES.LEGACY_ENV_MISSING);
    if (!f.legacyConfigComplete) return illegal(state, ERROR_CODES.LEGACY_CONFIG_INCOMPLETE);
    return ok(STATES.SWITCHING_TO_LEGACY, [
      effect(SIDE_EFFECTS.STOP_NATIVE_POLLER),
      effect(SIDE_EFFECTS.START_SIDECAR),
    ]);
  }

  if (event.type === EVENTS.SIDECAR_STARTED) {
    if (state !== STATES.SWITCHING_TO_LEGACY) return illegal(state);
    return ok(
      STATES.LEGACY_ACTIVE,
      [effect(SIDE_EFFECTS.PERSIST_PREFS, { transport: "legacy" })],
      { transport: "legacy" },
    );
  }

  if (event.type === EVENTS.SIDECAR_START_FAILED) {
    if (state !== STATES.SWITCHING_TO_LEGACY) return illegal(state);
    // Per plan §"切 native → legacy" rule 4: stay legacy-selected with failed
    // status. State still resolves to LEGACY_ACTIVE (so the UI doesn't snap
    // back to NATIVE_ACTIVE and confuse the user about which mode is
    // "selected"), but we emit a runtime-status side-effect so the UI can
    // render a failure banner / retry button.
    return ok(
      STATES.LEGACY_ACTIVE,
      [
        effect(SIDE_EFFECTS.PERSIST_PREFS, { transport: "legacy" }),
        effect(SIDE_EFFECTS.EMIT_RUNTIME_STATUS, {
          transport: "legacy",
          status: "failed",
          reason: (event && event.reason) || "sidecar_start_failed",
        }),
      ],
      { transport: "legacy" },
    );
  }

  return illegal(state);
}

function checkInvariants({ state, sideEffects }) {
  const violations = [];
  const fx = Array.isArray(sideEffects) ? sideEffects : [];
  const starts = new Set(fx.filter((e) => e && typeof e.type === "string").map((e) => e.type));
  if (starts.has(SIDE_EFFECTS.START_SIDECAR) && starts.has(SIDE_EFFECTS.START_NATIVE_POLLER)) {
    violations.push("START_SIDECAR and START_NATIVE_POLLER in same transition");
  }
  // Mutual exclusion: stable states must not be "polling/running both" — encoded via state itself.
  if (state === STATES.LEGACY_ACTIVE && starts.has(SIDE_EFFECTS.START_NATIVE_POLLER)) {
    violations.push("LEGACY_ACTIVE side-effect started native poller");
  }
  if (state === STATES.NATIVE_ACTIVE && starts.has(SIDE_EFFECTS.START_SIDECAR)) {
    violations.push("NATIVE_ACTIVE side-effect started sidecar");
  }
  return violations;
}

module.exports = {
  STATES,
  EVENTS,
  SIDE_EFFECTS,
  ERROR_CODES,
  defaultPrefs,
  defaultFiles,
  normalizePrefs,
  normalizeFiles,
  computeInitial,
  applyEvent,
  checkInvariants,
};
