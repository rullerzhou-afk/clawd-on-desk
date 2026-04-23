"use strict";

// Pure gate helpers over a prefs snapshot. Default-true for missing
// snapshot / entry / flag so an install that predates a flag still runs.

function readFlag(snapshot, agentId, flag) {
  if (!agentId) return true;
  if (!snapshot || typeof snapshot !== "object") return true;
  const agents = snapshot.agents;
  if (!agents || typeof agents !== "object") return true;
  const entry = agents[agentId];
  if (!entry || typeof entry !== "object") return true;
  return entry[flag] !== false;
}

const isAgentEnabled = (snapshot, agentId) => readFlag(snapshot, agentId, "enabled");
const isAgentPermissionsEnabled = (snapshot, agentId) => readFlag(snapshot, agentId, "permissionsEnabled");
const isAgentNotificationHookEnabled = (snapshot, agentId) => readFlag(snapshot, agentId, "notificationHookEnabled");

module.exports = { isAgentEnabled, isAgentPermissionsEnabled, isAgentNotificationHookEnabled };
