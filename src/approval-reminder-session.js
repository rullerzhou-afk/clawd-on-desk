"use strict";
const { getAgent } = require("../agents/registry");

function isLocalApprovalReminderSession(session) {
  return getAgent(session?.agentId)?.capabilities.approvalReminder === true
    && !session.host
    && !session.wslDistro
    && session.platform !== "wsl"
    && (session.profileId || "local") === "local";
}

module.exports = { isLocalApprovalReminderSession };
