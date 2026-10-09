"use strict";

const { getAgent } = require("../agents/registry");

function resolveAgentDisplayName(agentId, customApplications = []) {
  if (typeof agentId !== "string" || !agentId) return "";
  const registered = getAgent(agentId);
  if (registered && typeof registered.name === "string" && registered.name) return registered.name;
  if (Array.isArray(customApplications)) {
    const custom = customApplications.find((application) => (
      application && application.id === agentId && typeof application.name === "string" && application.name
    ));
    if (custom) return custom.name;
  }
  return agentId;
}

module.exports = { resolveAgentDisplayName };
