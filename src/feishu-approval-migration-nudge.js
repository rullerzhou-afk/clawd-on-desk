"use strict";

const feishuApprovalSettings = require("./feishu-approval-settings");

const LEGACY_PROVENANCE_SIGNATURE = "legacy-provenance";
const LEGACY_PROVENANCE_REASONS = new Set([
  "credential-provenance-unknown",
  "approver-provenance-unknown",
]);

function decideFeishuApprovalMigrationNudge(config, secrets, previousSignature = "", options = {}) {
  const previous = typeof previousSignature === "string" ? previousSignature : "";
  const readiness = (options.readiness || feishuApprovalSettings.readiness)(config, secrets);
  const enabled = !!(config && config.enabled === true);

  if (!enabled || (readiness && readiness.ready === true)) {
    return {
      shouldNotify: false,
      shouldPersist: previous !== "",
      nextSignature: "",
      reason: readiness && readiness.reason ? readiness.reason : "",
    };
  }

  const reason = readiness && readiness.reason ? readiness.reason : "";
  if (!LEGACY_PROVENANCE_REASONS.has(reason)) {
    return {
      shouldNotify: false,
      shouldPersist: false,
      nextSignature: previous,
      reason,
    };
  }

  return {
    shouldNotify: previous !== LEGACY_PROVENANCE_SIGNATURE,
    shouldPersist: false,
    nextSignature: LEGACY_PROVENANCE_SIGNATURE,
    reason,
  };
}

function createFeishuApprovalMigrationNudge(options = {}) {
  const getConfig = options.getConfig || (() => ({}));
  const getSecrets = options.getSecrets || (() => ({}));
  const getLastSignature = options.getLastSignature || (() => "");
  const setLastSignature = options.setLastSignature || (() => undefined);
  const showNotification = options.showNotification || (() => false);
  const openSettings = options.openSettings || (() => undefined);

  async function sync({ allowNotify = false } = {}) {
    const previous = getLastSignature() || "";
    const decision = decideFeishuApprovalMigrationNudge(
      getConfig(),
      getSecrets(),
      previous,
      options,
    );
    if (decision.shouldPersist) {
      await setLastSignature(decision.nextSignature);
      return { ...decision, notified: false };
    }
    if (!allowNotify || !decision.shouldNotify) {
      return { ...decision, notified: false };
    }
    const delivered = showNotification({
      reason: decision.reason,
      onClick: openSettings,
    }) !== false;
    if (delivered) await setLastSignature(decision.nextSignature);
    return { ...decision, notified: delivered };
  }

  return { sync };
}

module.exports = {
  LEGACY_PROVENANCE_SIGNATURE,
  LEGACY_PROVENANCE_REASONS,
  decideFeishuApprovalMigrationNudge,
  createFeishuApprovalMigrationNudge,
};
