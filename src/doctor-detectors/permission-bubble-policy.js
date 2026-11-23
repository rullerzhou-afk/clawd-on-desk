"use strict";

const { getBubblePolicy } = require("../bubble-policy");

function checkPermissionBubblePolicy(options = {}) {
  const prefs = options.prefs || {};
  let policy;
  try {
    policy = getBubblePolicy(prefs, "permission");
  } catch {
    policy = { enabled: prefs.permissionBubblesEnabled !== false && prefs.hideBubbles !== true };
  }

  if (!policy.enabled) {
    return {
      id: "permission-bubble-policy",
      status: "fail",
      level: "warning",
      detail: "Permission bubbles are globally disabled",
      textHint: "Open Settings -> Notifications -> Bubbles and turn on permission bubbles.",
      fixAction: { type: "permission-bubble-policy" },
    };
  }

  if (options.doNotDisturb) {
    return {
      id: "permission-bubble-policy",
      status: "suppressed-by-dnd",
      level: "info",
      detail: "DND is on; bubbles are suppressed",
      textHint: "Right-click the pet and toggle DND off if you want bubbles back.",
    };
  }

  return {
    id: "permission-bubble-policy",
    status: "pass",
    level: null,
    detail: "Permission bubbles are enabled",
  };
}

module.exports = { checkPermissionBubblePolicy };
