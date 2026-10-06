"use strict";

const feishuApprovalSettings = require("../feishu-approval-settings");

const LEGACY_PROVENANCE_REASONS = new Set([
  "credential-provenance-unknown",
  "approver-provenance-unknown",
]);

function checkFeishuApproval(options = {}) {
  const config = options.config && typeof options.config === "object" ? options.config : {};
  if (config.enabled !== true) {
    return {
      id: "feishu-approval",
      status: "pass",
      level: null,
      reason: "disabled",
      detail: "Feishu/Lark remote approval is disabled.",
    };
  }

  const ready = (options.readiness || feishuApprovalSettings.readiness)(
    config,
    options.secrets || {},
  );
  if (ready && ready.ready === true) {
    return {
      id: "feishu-approval",
      status: "pass",
      level: null,
      reason: "ready",
      detail: "Feishu/Lark remote approval is configured.",
    };
  }

  const reason = ready && ready.reason ? ready.reason : "invalid-config";
  const legacy = LEGACY_PROVENANCE_REASONS.has(reason);
  return {
    id: "feishu-approval",
    status: "warning",
    level: "warning",
    reason,
    detail: legacy
      ? "Saved Feishu/Lark credentials predate platform binding. Open Settings -> Remote Approval, choose Feishu or Lark, save App ID/App Secret again, then save the approver again."
      : `Feishu/Lark remote approval is enabled but unavailable: ${(ready && ready.message) || reason}.`,
  };
}

module.exports = { checkFeishuApproval };
