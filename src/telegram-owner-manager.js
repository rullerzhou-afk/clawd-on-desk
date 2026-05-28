"use strict";

// Owner manager: executes side-effects emitted by the migration reducer and
// guarantees that at no point in time both the Go sidecar (`isRunning()`) and
// the native poller (`isPolling()`) are active against the same Telegram bot
// token. Mutual exclusion is enforced two ways:
//
//   1. Pre-condition checks before START_SIDECAR / START_NATIVE_POLLER.
//   2. Post-condition assertion after every effect — if a fake / future code
//      path silently violates the invariant, the manager throws InvariantError
//      and the reducer driver can surface a fatal bug.
//
// All `apply()` calls are serialized through an internal queue so that
// concurrent reducer dispatches cannot race.

const { SIDE_EFFECTS } = require("./telegram-migration-state");

const DEFAULT_SETTLE_MS = 500;
const DEFAULT_STOP_GRACE_MS = 2000;

class InvariantError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "InvariantError";
    this.code = code;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

class TelegramOwnerManager {
  constructor({
    sidecar,
    native,
    settleMs = DEFAULT_SETTLE_MS,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    now = () => Date.now(),
    sleep = defaultSleep,
    onPersist = null,
    onRuntimeStatus = null,
    logger = null,
  } = {}) {
    if (!sidecar || typeof sidecar.start !== "function" || typeof sidecar.stop !== "function" || typeof sidecar.isRunning !== "function") {
      throw new TypeError("owner-manager: sidecar handle must implement start/stop/isRunning");
    }
    if (!native || typeof native.start !== "function" || typeof native.stop !== "function" || typeof native.isPolling !== "function") {
      throw new TypeError("owner-manager: native handle must implement start/stop/isPolling");
    }
    this.sidecar = sidecar;
    this.native = native;
    this.settleMs = settleMs;
    this.stopGraceMs = stopGraceMs;
    this.now = now;
    this.sleep = sleep;
    this.onPersist = onPersist;
    this.onRuntimeStatus = onRuntimeStatus;
    this.logger = logger;
    this._lastSidecarStopAt = -Infinity;
    this._queue = Promise.resolve();
  }

  snapshot() {
    return {
      sidecarRunning: !!this.sidecar.isRunning(),
      nativePolling: !!this.native.isPolling(),
    };
  }

  apply(sideEffects) {
    const effects = Array.isArray(sideEffects) ? sideEffects : [];
    const work = this._queue.then(() => this._applyNow(effects));
    // Swallow rejection on the queue handle so that one failed apply() does
    // not poison every subsequent dispatch. Callers still observe the error
    // through the returned promise.
    this._queue = work.catch(() => {});
    return work;
  }

  async _applyNow(effects) {
    this._assertMutex("pre-apply");
    for (const fx of effects) {
      if (!fx || typeof fx.type !== "string") continue;
      await this._runOne(fx);
      this._assertMutex(`post-${fx.type}`);
    }
  }

  async _runOne(fx) {
    switch (fx.type) {
      case SIDE_EFFECTS.STOP_SIDECAR:
        await this.sidecar.stop({ graceMs: this.stopGraceMs });
        this._lastSidecarStopAt = this.now();
        return;
      case SIDE_EFFECTS.STOP_NATIVE_POLLER:
        await this.native.stop();
        return;
      case SIDE_EFFECTS.START_SIDECAR:
        if (this.native.isPolling()) {
          throw new InvariantError(
            "PRE_START_SIDECAR_BUT_NATIVE_POLLING",
            "Refused to start sidecar while native poller is active",
          );
        }
        {
          const started = await this.sidecar.start();
          if (started === false) {
            throw new InvariantError(
              "SIDECAR_START_FAILED",
              "Sidecar handle reported startup failure",
            );
          }
        }
        return;
      case SIDE_EFFECTS.START_NATIVE_POLLER:
        if (this.sidecar.isRunning()) {
          throw new InvariantError(
            "PRE_START_NATIVE_BUT_SIDECAR_RUNNING",
            "Refused to start native poller while sidecar is running",
          );
        }
        await this._waitForSettle();
        await this.native.start();
        return;
      case SIDE_EFFECTS.SEND_TEST_CARD:
        if (typeof this.native.sendTestCard !== "function") {
          throw new TypeError("native handle missing sendTestCard()");
        }
        await this.native.sendTestCard(fx.payload || {});
        return;
      case SIDE_EFFECTS.PERSIST_PREFS:
        if (typeof this.onPersist === "function") {
          await this.onPersist(fx.payload || {});
        }
        return;
      case SIDE_EFFECTS.EMIT_RUNTIME_STATUS:
        if (typeof this.onRuntimeStatus === "function") {
          await this.onRuntimeStatus(fx.payload || {});
        }
        return;
      default:
        if (this.logger) this.logger.warn(`owner-manager: ignoring unknown effect ${fx.type}`);
        return;
    }
  }

  async _waitForSettle() {
    const elapsed = this.now() - this._lastSidecarStopAt;
    const remaining = this.settleMs - elapsed;
    if (remaining > 0) await this.sleep(remaining);
  }

  _assertMutex(label) {
    if (this.sidecar.isRunning() && this.native.isPolling()) {
      throw new InvariantError(
        "MUTUAL_EXCLUSION_VIOLATED",
        `Both sidecar running and native polling at ${label}`,
      );
    }
  }
}

module.exports = {
  TelegramOwnerManager,
  InvariantError,
  DEFAULT_SETTLE_MS,
  DEFAULT_STOP_GRACE_MS,
};
