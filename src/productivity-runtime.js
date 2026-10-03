"use strict";
const { createQuietHoursScheduler } = require("./quiet-hours");
const { createQuotaAlerts } = require("./quota-alerts");

function createProductivityRuntime(options) {
  const controller = options.settingsController;
  const state = options.state;
  const pet = options.petWindowRuntime;
  let started = false, disposed = false, quotaTimer = null, unsubscribe = null;
  const setTimer = options.setInterval || setInterval;
  const clearTimer = options.clearInterval || clearInterval;
  const quota = createQuotaAlerts({ historyPath: options.historyPath,
    notify: options.notifyQuota, logWarn: options.logWarn, now: options.now });
  const schedule = createQuietHoursScheduler({
    getConfig: () => controller.hasReadFailure() ? null : controller.get("quietHours"),
    getState: () => ({ dnd: options.getDoNotDisturb(), hidden: pet.isPetHidden() }),
    applyState: (patch) => {
      if ("dnd" in patch) patch.dnd ? state.enableDoNotDisturb() : state.disableDoNotDisturb();
      if ("hidden" in patch) pet.setPetHidden(patch.hidden, { manual: false });
    },
    now: options.now, setInterval: setTimer, clearInterval: clearTimer,
    onError: () => options.logWarn?.("Clawd: quiet hours could not update pet state"),
  });
  function observeQuota() {
    if (!started || disposed || controller.hasReadFailure()) return;
    const prefs = controller.getSnapshot();
    try {
      quota.observe(state.getAccountQuotaSnapshot(), {
        enabled: prefs.quotaAlertsEnabled, thresholds: prefs.quotaAlertThresholds,
        recoveryEnabled: prefs.quotaRecoveryAlertsEnabled, suppressed: options.getDoNotDisturb(),
      });
    } catch { options.logWarn?.("Clawd: quota alerts could not inspect usage"); }
  }
  function refresh() { schedule.poll(); observeQuota(); }
  function start() {
    if (started || disposed) return;
    started = true;
    schedule.start(); observeQuota();
    quotaTimer = setTimer(observeQuota, 15_000);
    quotaTimer?.unref?.();
    unsubscribe = controller.subscribe(({ changes }) => {
      if (["quietHours", "quotaAlertsEnabled", "quotaAlertThresholds", "quotaRecoveryAlertsEnabled"]
        .some((key) => key in changes)) refresh();
    });
    options.powerMonitor?.on("resume", refresh);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    if (quotaTimer) clearTimer(quotaTimer);
    options.powerMonitor?.removeListener("resume", refresh);
    schedule.dispose({ restore: false }); quota.dispose();
  }
  return { start, dispose, observeQuota,
    noteManualChange: (field) => schedule.noteManualChange(field) };
}
module.exports = { createProductivityRuntime };
