"use strict";

// Native-only Telegram migration controller. Historical legacy prefs can route
// a user to NATIVE_MIGRATION_REQUIRED, but this controller has no sidecar
// dependency, sidecar owner, or fallback path.

const {
  STATES,
  EVENTS,
  SIDE_EFFECTS,
  ERROR_CODES,
  TEST_ORIGINS,
  applyEvent,
  computeInitial,
} = require("./telegram-migration-state");
const { ERROR_CLASSES } = require("./telegram-native-client");
const {
  ALLOWED_TEST_ERROR_CLASSES,
  sanitizeErrorClass,
  normalizeTelegramVerificationFailure,
} = require("./telegram-verification-failure");

function createTelegramMigrationController({
  native,
  readPrefs,
  writePrefs,
  readFiles,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  testTimeoutMs = 60000,
  now = Date.now,
  onSnapshotChanged = () => {},
}) {
  if (!native || typeof native.isPolling !== "function"
    || typeof native.start !== "function" || typeof native.stop !== "function"
    || typeof native.sendTestCard !== "function") {
    throw new TypeError("migration-controller: native handle required");
  }
  if (typeof readPrefs !== "function" || typeof writePrefs !== "function") {
    throw new TypeError("migration-controller: readPrefs/writePrefs required");
  }
  if (typeof readFiles !== "function") {
    throw new TypeError("migration-controller: readFiles required");
  }

  let state = STATES.IDLE;
  let prefs = {};
  let testOrigin = null;
  let pendingTestTimer = null;
  let lastError = null;
  let lastTestResult = null;
  let diagnosticCode = null;
  let revision = 0;
  let dispatchQueue = Promise.resolve();

  function safeLog(level, message, meta) {
    try {
      const pending = log(level, message, meta);
      if (pending && typeof pending.then === "function") {
        void Promise.resolve(pending).catch(() => {});
      }
    } catch {}
  }

  function readPrefsNow() {
    const raw = readPrefs() || {};
    prefs = {
      nativeVerifiedAt: Number.isFinite(raw.nativeVerifiedAt) ? raw.nativeVerifiedAt : null,
      legacyEnabled: typeof raw.legacyEnabled === "boolean" ? raw.legacyEnabled : null,
      migration: raw.migration && typeof raw.migration === "object"
        ? raw.migration
        : { importedAt: null, importError: null },
    };
    if (Object.prototype.hasOwnProperty.call(raw, "transport")) {
      prefs.transport = raw.transport;
    }
    return prefs;
  }

  function readFilesNow() {
    return readFiles() || {};
  }

  function clearTestTimer() {
    if (pendingTestTimer) {
      clearTimer(pendingTestTimer);
      pendingTestTimer = null;
    }
  }

  function armTestTimer() {
    clearTestTimer();
    pendingTestTimer = setTimer(() => {
      pendingTestTimer = null;
      void dispatch({ type: EVENTS.TEST_TIMEOUT });
    }, testTimeoutMs);
    if (pendingTestTimer && typeof pendingTestTimer.unref === "function") {
      pendingTestTimer.unref();
    }
  }

  function snapshotWithoutRevision() {
    return {
      state,
      transport: Object.prototype.hasOwnProperty.call(prefs, "transport")
        ? prefs.transport
        : undefined,
      nativeVerifiedAt: prefs.nativeVerifiedAt || null,
      testOrigin,
      lastError,
      lastTestResult,
      diagnosticCode,
      ownerSnapshot: {
        nativePolling: native.isPolling() === true,
      },
    };
  }

  function emitSnapshotChanged() {
    revision += 1;
    try {
      onSnapshotChanged({ revision, snapshot: getSnapshot() });
    } catch (err) {
      safeLog("warn", "migration snapshot notifier failed", {
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  function getSnapshot() {
    return {
      ...snapshotWithoutRevision(),
      revision,
    };
  }

  async function persistPatch(patch) {
    await writePrefs(patch);
    prefs = { ...prefs, ...patch };
  }

  async function stopNativeBestEffort() {
    try {
      await native.stop();
    } catch (err) {
      safeLog("warn", "native stop failed", {
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  async function applyEffects(sideEffects) {
    for (const entry of Array.isArray(sideEffects) ? sideEffects : []) {
      if (!entry) continue;
      if (entry.type === SIDE_EFFECTS.START_NATIVE_POLLER) {
        await native.start();
      } else if (entry.type === SIDE_EFFECTS.STOP_NATIVE_POLLER) {
        await stopNativeBestEffort();
      } else if (entry.type === SIDE_EFFECTS.SEND_TEST_CARD) {
        await native.sendTestCard(entry.payload);
      } else if (entry.type === SIDE_EFFECTS.PERSIST_PREFS) {
        await persistPatch(entry.payload || {});
      } else {
        const err = new Error(`Unknown Telegram migration side effect: ${entry.type}`);
        err.code = "UNKNOWN_SIDE_EFFECT";
        throw err;
      }
    }
  }

  function targetForOrigin(origin) {
    return origin === TEST_ORIGINS.IDLE
      ? STATES.IDLE
      : STATES.NATIVE_MIGRATION_REQUIRED;
  }

  function recordFailure(outcome, errorClass) {
    const at = Number(now());
    if (outcome === "timeout") {
      lastTestResult = { outcome: "timeout", at };
    } else {
      lastTestResult = {
        outcome,
        errorClass: sanitizeErrorClass(errorClass),
        at,
      };
    }
    const failure = normalizeTelegramVerificationFailure(lastTestResult);
    safeLog("warn", "native Telegram verification failed", {
      outcome: failure ? failure.outcome : "failed",
      errorClass: failure ? failure.errorCode : ERROR_CLASSES.UNKNOWN,
    });
  }

  async function recoverTestApplyFailure(err, origin) {
    await stopNativeBestEffort();
    clearTestTimer();
    state = targetForOrigin(origin);
    testOrigin = origin;
    lastError = {
      code: err && err.code ? String(err.code).slice(0, 64) : "APPLY_FAILED",
      eventType: EVENTS.USER_TEST_NATIVE,
    };
    recordFailure("native-start-failed", sanitizeErrorClass(
      err && err.errorClass,
      err && err.code === "TOKEN_MISSING" ? ERROR_CLASSES.TOKEN_MISSING : "apply-failed",
    ));
    emitSnapshotChanged();
  }

  function isLateTerminal(event) {
    return event
      && [EVENTS.TEST_SUCCESS, EVENTS.TEST_FAILED, EVENTS.TEST_TIMEOUT].includes(event.type)
      && state !== STATES.TESTING_NATIVE;
  }

  async function dispatchNow(event) {
    if (isLateTerminal(event)) {
      return { ok: false, errorCode: ERROR_CODES.ILLEGAL_TRANSITION, state };
    }

    readPrefsNow();
    const files = readFilesNow();
    const reduced = applyEvent({ state, prefs, files, testOrigin }, event);

    if (reduced.errorCode) {
      if (reduced.errorCode === ERROR_CODES.CONFIG_INCOMPLETE) {
        state = STATES.NEEDS_SETUP;
      }
      lastError = {
        code: reduced.errorCode,
        eventType: event && event.type,
      };
      emitSnapshotChanged();
      return { ok: false, errorCode: reduced.errorCode, state };
    }

    const nextOrigin = reduced.testOrigin || testOrigin;
    try {
      await applyEffects(reduced.sideEffects);
    } catch (err) {
      if (event && (event.type === EVENTS.USER_TEST_NATIVE || event.type === EVENTS.TEST_SUCCESS)) {
        await recoverTestApplyFailure(err, nextOrigin || TEST_ORIGINS.IDLE);
        return {
          ok: false,
          errorCode: lastError && lastError.code,
          state,
        };
      }
      lastError = {
        code: err && err.code ? String(err.code).slice(0, 64) : "APPLY_FAILED",
        eventType: event && event.type,
      };
      emitSnapshotChanged();
      return { ok: false, errorCode: lastError.code, state };
    }

    state = reduced.state;
    diagnosticCode = reduced.diagnosticCode || diagnosticCode;
    lastError = null;

    if (event.type === EVENTS.USER_TEST_NATIVE) {
      testOrigin = reduced.testOrigin || TEST_ORIGINS.IDLE;
      lastTestResult = null;
      armTestTimer();
    } else if (event.type === EVENTS.TEST_SUCCESS) {
      clearTestTimer();
      testOrigin = null;
      lastTestResult = null;
    } else if (event.type === EVENTS.TEST_TIMEOUT) {
      clearTestTimer();
      testOrigin = nextOrigin;
      recordFailure("timeout");
    } else if (event.type === EVENTS.TEST_FAILED) {
      clearTestTimer();
      testOrigin = nextOrigin;
      recordFailure("failed", event.errorClass);
    } else if (event.type === EVENTS.USER_DISABLE) {
      clearTestTimer();
      testOrigin = null;
      lastTestResult = null;
      diagnosticCode = null;
    }

    emitSnapshotChanged();
    return { ok: true, state };
  }

  function enqueue(task) {
    const run = dispatchQueue.then(task, task);
    dispatchQueue = run.catch(() => {});
    return run;
  }

  function dispatch(event) {
    return enqueue(() => dispatchNow(event));
  }

  async function initNow() {
    readPrefsNow();
    const initial = computeInitial({ prefs, files: readFilesNow() });
    state = initial.state;
    testOrigin = initial.testOrigin || null;
    diagnosticCode = initial.diagnosticCode || null;
    lastError = null;
    lastTestResult = null;
    try {
      await applyEffects(initial.sideEffects);
    } catch (err) {
      lastError = {
        code: err && err.code ? String(err.code).slice(0, 64) : "NATIVE_START_FAILED",
        eventType: EVENTS.INIT,
      };
      safeLog("warn", "native Telegram init failed", {
        error: err && err.message ? err.message : String(err),
      });
    }
    emitSnapshotChanged();
    return state;
  }

  function init() {
    return enqueue(initNow);
  }

  async function reconcileNow({ identityChanged = false } = {}) {
    const wasTesting = state === STATES.TESTING_NATIVE;
    const wasRuntimeActive = state === STATES.NATIVE_ACTIVE || wasTesting || native.isPolling() === true;
    const priorOrigin = testOrigin;

    readPrefsNow();
    if (identityChanged && !wasTesting) {
      lastTestResult = null;
    }
    if (identityChanged && prefs.transport === "native" && prefs.nativeVerifiedAt) {
      await stopNativeBestEffort();
      clearTestTimer();
      await persistPatch({ nativeVerifiedAt: null });
    }

    const files = readFilesNow();
    const next = computeInitial({ prefs, files });

    if (wasTesting && !identityChanged && files.nativeConfigComplete === true) {
      // A non-connection preference update must not settle or restart an
      // in-flight test.
      return getSnapshot();
    }

    const nextRuntimeActive = next.state === STATES.NATIVE_ACTIVE;
    if (wasRuntimeActive && !nextRuntimeActive) {
      await stopNativeBestEffort();
      clearTestTimer();
    }
    if (nextRuntimeActive && native.isPolling() !== true) {
      try {
        await native.start();
      } catch (err) {
        lastError = {
          code: err && err.code ? String(err.code).slice(0, 64) : "NATIVE_START_FAILED",
          eventType: "CONFIG_CHANGED",
        };
      }
    }

    state = next.state;
    diagnosticCode = next.diagnosticCode || null;
    testOrigin = next.testOrigin
      || (state === STATES.NATIVE_MIGRATION_REQUIRED ? priorOrigin : null);
    if (wasTesting) {
      recordFailure("failed", identityChanged ? "apply-failed" : "unknown");
    }
    emitSnapshotChanged();
    return getSnapshot();
  }

  function reconcileConfiguration(options) {
    return enqueue(() => reconcileNow(options));
  }

  async function disposeNow() {
    clearTestTimer();
    await stopNativeBestEffort();
  }

  function dispose() {
    return enqueue(disposeNow);
  }

  return {
    init,
    dispatch,
    reconcileConfiguration,
    getSnapshot,
    dispose,
  };
}

module.exports = {
  ALLOWED_TEST_ERROR_CLASSES,
  sanitizeErrorClass,
  createTelegramMigrationController,
};
