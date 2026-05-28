"use strict";

// Main-process controller that bolts the migration reducer + owner-manager
// onto Clawd's existing sidecar lifecycle. The renderer never talks to the
// reducer directly — it goes through this controller via IPC commands, so the
// state machine has a single source of truth.

const {
  STATES,
  EVENTS,
  applyEvent,
  computeInitial,
  defaultPrefs,
} = require("./telegram-migration-state");
const { TelegramOwnerManager } = require("./telegram-owner-manager");

function createTelegramMigrationController({
  sidecar,
  native,
  readPrefs,
  writePrefs,
  readFiles,
  settleMs,
  stopGraceMs,
  log = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  testTimeoutMs = 60000,
}) {
  if (!sidecar || typeof sidecar.isRunning !== "function") {
    throw new TypeError("migration-controller: sidecar handle required");
  }
  if (!native || typeof native.isPolling !== "function") {
    throw new TypeError("migration-controller: native handle required");
  }
  if (typeof readPrefs !== "function" || typeof writePrefs !== "function") {
    throw new TypeError("migration-controller: readPrefs/writePrefs required");
  }
  if (typeof readFiles !== "function") {
    throw new TypeError("migration-controller: readFiles required");
  }

  let state = STATES.IDLE;
  let prefs = defaultPrefs();
  let runtimeStatus = { transport: "off", status: "stopped", reason: null };
  let pendingTestTimer = null;
  let lastError = null;

  const manager = new TelegramOwnerManager({
    sidecar,
    native,
    settleMs,
    stopGraceMs,
    onPersist: async (patch) => {
      prefs = { ...prefs, ...patch };
      await writePrefs(patch);
    },
    onRuntimeStatus: (s) => {
      runtimeStatus = { ...runtimeStatus, ...s };
    },
    logger: { warn: (msg) => log("warn", String(msg)) },
  });

  function readPrefsNow() {
    // Important: do NOT fill `transport` with defaultPrefs()'s "off". The
    // reducer treats an explicit "off" as "user has disabled remote approval",
    // which is a different signal from "v0.8 user upgrading and we have no
    // pref yet". Only carry the field through when the caller actually set it.
    const raw = readPrefs() || {};
    prefs = {
      nativeVerifiedAt: typeof raw.nativeVerifiedAt === "number" ? raw.nativeVerifiedAt : null,
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
      dispatch({ type: EVENTS.TEST_TIMEOUT }).catch(() => {});
    }, testTimeoutMs);
    if (pendingTestTimer && typeof pendingTestTimer.unref === "function") {
      pendingTestTimer.unref();
    }
  }

  async function dispatch(event) {
    readPrefsNow();
    const files = readFilesNow();
    const result = applyEvent({ state, prefs, files }, event);

    if (result.errorCode) {
      lastError = { code: result.errorCode, eventType: event && event.type };
      log("warn", `migration dispatch ${event && event.type} rejected`, {
        code: result.errorCode,
      });
      return { ok: false, errorCode: result.errorCode, state };
    }

    try {
      await manager.apply(result.sideEffects || []);
    } catch (err) {
      lastError = { code: err && err.code ? err.code : "APPLY_FAILED", message: err && err.message };
      log("warn", "migration apply failed", { error: err && err.message });

      if (event && event.type === EVENTS.USER_ROLLBACK_TO_LEGACY && result.state === STATES.SWITCHING_TO_LEGACY) {
        state = STATES.SWITCHING_TO_LEGACY;
        const failed = applyEvent(
          { state, prefs, files: readFilesNow() },
          { type: EVENTS.SIDECAR_START_FAILED, reason: lastError.code },
        );
        try {
          await manager.apply(failed.sideEffects || []);
          state = failed.state;
          clearTestTimer();
        } catch (fallbackErr) {
          lastError = {
            code: fallbackErr && fallbackErr.code ? fallbackErr.code : "APPLY_FAILED",
            message: fallbackErr && fallbackErr.message,
          };
          state = result.state;
        }
      }
      // Best-effort recover: re-read the world so state mirrors reality.
      return { ok: false, errorCode: lastError.code, message: lastError.message, state };
    }

    state = result.state;
    lastError = null;

    // Arm/clear the 60s test timer alongside state transitions (per plan §148
    // the Telegram tap deadline is owned by the driver, not the reducer).
    if (state === STATES.TESTING_NATIVE) armTestTimer();
    else clearTestTimer();

    if (event && event.type === EVENTS.USER_ROLLBACK_TO_LEGACY && state === STATES.SWITCHING_TO_LEGACY) {
      return dispatch({ type: EVENTS.SIDECAR_STARTED });
    }

    return { ok: true, state };
  }

  async function init() {
    readPrefsNow();
    const files = readFilesNow();
    const result = computeInitial({ prefs, files });
    try {
      await manager.apply(result.sideEffects || []);
    } catch (err) {
      log("warn", "migration init apply failed", { error: err && err.message });
    }
    state = result.state;
    return state;
  }

  function getSnapshot() {
    return {
      state,
      transport: prefs.transport,
      nativeVerifiedAt: prefs.nativeVerifiedAt,
      legacyEnabled: prefs.legacyEnabled,
      runtimeStatus,
      ownerSnapshot: manager.snapshot(),
      migrationInfo: prefs.migration || { importedAt: null, importError: null },
      lastError,
    };
  }

  return { init, dispatch, getSnapshot, _manager: manager };
}

module.exports = { createTelegramMigrationController };
