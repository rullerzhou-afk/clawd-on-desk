"use strict";

const { createQuotaAlerts } = require("./quota-alerts");

function createQuotaAlertsRuntime(options) {
  const controller = options.settingsController;
  let started = false, disposed = false, timer = null, unsubscribe = null;
  const setTimer = options.setInterval || setInterval;
  const clearTimer = options.clearInterval || clearInterval;
  const quota = createQuotaAlerts({
    historyPath: options.historyPath, notify: options.notifyQuota,
    logWarn: options.logWarn, now: options.now,
  });
  function observeQuota() {
    if (!started || disposed || controller.hasReadFailure()) return;
    const prefs = controller.getSnapshot();
    try {
      quota.observe(options.state.getAccountQuotaSnapshot(), {
        enabled: prefs.quotaAlertsEnabled, thresholds: prefs.quotaAlertThresholds,
        recoveryEnabled: prefs.quotaRecoveryAlertsEnabled,
        suppressed: options.getDoNotDisturb(),
      });
    } catch { options.logWarn?.("Clawd: quota alerts could not inspect usage"); }
  }
  function start() {
    if (started || disposed) return;
    started = true;
    observeQuota();
    timer = setTimer(observeQuota, 15_000);
    timer?.unref?.();
    unsubscribe = controller.subscribe(({ changes }) => {
      if (["quotaAlertsEnabled", "quotaAlertThresholds", "quotaRecoveryAlertsEnabled"]
        .some((key) => key in changes)) observeQuota();
    });
    options.powerMonitor?.on("resume", observeQuota);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    if (timer !== null) clearTimer(timer);
    options.powerMonitor?.removeListener("resume", observeQuota);
    quota.dispose();
  }
  return { start, dispose, observeQuota };
}
module.exports = { createQuotaAlertsRuntime };
