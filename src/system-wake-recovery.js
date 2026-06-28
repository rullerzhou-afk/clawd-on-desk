"use strict";

const RETRY_DELAYS_MS = Object.freeze([0, 250, 1000, 2500]);
const WAKE_DEDUPE_MS = 500;
const WAKE_TIMEOUT_MS = 7500;
const VALID_TRIGGERS = new Set(["resume", "unlock-screen"]);
const VALID_RESULTS = new Set(["resumed", "no-svg", "error"]);

function requiredDependency(value, name) {
  if (!value) throw new Error(`createSystemWakeRecovery requires ${name}`);
  return value;
}

function normalizeWakeStatus(payload) {
  if (!payload || typeof payload !== "object") return null;
  const id = typeof payload.id === "string" ? payload.id : "";
  const result = typeof payload.result === "string" ? payload.result : "";
  if (!/^wake-[a-z0-9]+-\d+$/.test(id) || id.length > 96) return null;
  if (!VALID_RESULTS.has(result)) return null;
  return {
    id,
    result,
    lowPowerWasPaused: payload.lowPowerWasPaused === true,
    pauseStyleRemoved: payload.pauseStyleRemoved === true,
    eyeTrackingReady: payload.eyeTrackingReady === true,
    eyeTargetWasCurrentDocument: payload.eyeTargetWasCurrentDocument === true,
    objectReloaded: payload.objectReloaded === true,
    eyeTargetRebound: payload.eyeTargetRebound === true,
  };
}

function createSystemWakeRecovery(options = {}) {
  const powerMonitor = requiredDependency(options.powerMonitor, "powerMonitor");
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const sendToRenderer = requiredDependency(options.sendToRenderer, "sendToRenderer");
  const onRecovered = requiredDependency(options.onRecovered, "onRecovered");
  const log = options.log || (() => {});
  const onError = options.onError || (() => {});
  const now = options.now || Date.now;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;

  let started = false;
  let wakeSequence = 0;
  let activeWake = null;
  let lastWake = null;

  function clearWakeTimers(wake) {
    if (!wake) return;
    while (wake.timers.length) clearTimer(wake.timers.pop());
    if (wake.timeoutTimer) {
      clearTimer(wake.timeoutTimer);
      wake.timeoutTimer = null;
    }
  }

  function sendAttempt(wake, attempt) {
    if (activeWake !== wake) return;
    try {
      sendToRenderer("system-wake", {
        id: wake.id,
        trigger: wake.trigger,
        attempt,
      });
    } catch (err) {
      onError(err);
    }
  }

  function finishWithTimeout(wake) {
    if (activeWake !== wake) return;
    clearWakeTimers(wake);
    wake.timedOut = true;
    activeWake = null;
    log(
      `system-wake id=${wake.id} trigger=${wake.trigger} result=timeout ` +
      "receiptMs=- lowPowerWasPaused=- pauseStyleRemoved=- eyeTrackingReady=- " +
      "eyeTargetWasCurrentDocument=- objectReloaded=- eyeTargetRebound=- late=-"
    );
  }

  function trigger(trigger) {
    if (!VALID_TRIGGERS.has(trigger)) return null;
    const startedAt = Number(now());

    // Windows commonly emits resume and unlock-screen as one burst. Keep one
    // wake id even if the renderer acknowledges before the second event lands.
    if (activeWake) return activeWake.id;
    if (lastWake && startedAt - lastWake.startedAt <= WAKE_DEDUPE_MS) return lastWake.id;

    const wake = {
      id: `wake-${Math.max(0, startedAt).toString(36)}-${++wakeSequence}`,
      trigger,
      startedAt,
      timers: [],
      timeoutTimer: null,
      recovered: false,
      timedOut: false,
    };
    activeWake = wake;
    lastWake = wake;

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === 0) {
        sendAttempt(wake, attempt);
      } else {
        wake.timers.push(setTimer(() => sendAttempt(wake, attempt), delay));
      }
    }
    wake.timeoutTimer = setTimer(() => finishWithTimeout(wake), WAKE_TIMEOUT_MS);
    return wake.id;
  }

  function handleStatus(_event, payload) {
    const status = normalizeWakeStatus(payload);
    if (!status) return false;

    let wake = null;
    let late = false;
    if (activeWake && status.id === activeWake.id) {
      wake = activeWake;
    } else if (
      lastWake
      && status.id === lastWake.id
      && lastWake.timedOut
      && !lastWake.recovered
      && status.result === "resumed"
    ) {
      wake = lastWake;
      late = true;
    } else {
      return false;
    }

    const receiptMs = Math.max(0, Number(now()) - wake.startedAt);
    if (!late) {
      clearWakeTimers(wake);
      activeWake = null;
    }
    wake.recovered = true;

    try {
      onRecovered(status, { trigger: wake.trigger, receiptMs, late });
    } catch (err) {
      onError(err);
    }
    log(
      `system-wake id=${wake.id} trigger=${wake.trigger} result=${status.result} ` +
      `receiptMs=${receiptMs} lowPowerWasPaused=${status.lowPowerWasPaused ? 1 : 0} ` +
      `pauseStyleRemoved=${status.pauseStyleRemoved ? 1 : 0} ` +
      `eyeTrackingReady=${status.eyeTrackingReady ? 1 : 0} ` +
      `eyeTargetWasCurrentDocument=${status.eyeTargetWasCurrentDocument ? 1 : 0} ` +
      `objectReloaded=${status.objectReloaded ? 1 : 0} ` +
      `eyeTargetRebound=${status.eyeTargetRebound ? 1 : 0} ` +
      `late=${late ? 1 : 0}`
    );
    return true;
  }

  const onResume = () => trigger("resume");
  const onUnlockScreen = () => trigger("unlock-screen");

  function start() {
    if (started) return;
    started = true;
    powerMonitor.on("resume", onResume);
    powerMonitor.on("unlock-screen", onUnlockScreen);
    ipcMain.on("system-wake-status", handleStatus);
  }

  function dispose() {
    if (!started) return;
    started = false;
    powerMonitor.removeListener("resume", onResume);
    powerMonitor.removeListener("unlock-screen", onUnlockScreen);
    ipcMain.removeListener("system-wake-status", handleStatus);
    clearWakeTimers(activeWake);
    activeWake = null;
  }

  return {
    start,
    dispose,
    trigger,
    handleStatus,
    getPendingWakeId: () => activeWake && activeWake.id,
  };
}

module.exports = {
  RETRY_DELAYS_MS,
  WAKE_DEDUPE_MS,
  WAKE_TIMEOUT_MS,
  normalizeWakeStatus,
  createSystemWakeRecovery,
};
