"use strict";

function buildSettingsAgentOrderExports() {
  const COLLAPSIBLE_AGENT_PRIORITY = [
    "claude-code",
    "codex",
    "gemini-cli",
    "kimi-cli",
    "opencode",
    "pi",
    "codebuddy",
  ];

  const NON_COLLAPSIBLE_AGENT_PRIORITY = [
    "cursor-agent",
    "copilot-cli",
    "kiro-cli",
    "openclaw",
    "hermes",
  ];

  const COLLAPSIBLE_AGENT_PRIORITY_MAP = new Map(
    COLLAPSIBLE_AGENT_PRIORITY.map((id, index) => [id, index])
  );
  const NON_COLLAPSIBLE_AGENT_PRIORITY_MAP = new Map(
    NON_COLLAPSIBLE_AGENT_PRIORITY.map((id, index) => [id, index])
  );

  function normalizeAgentName(agent) {
    if (!agent || typeof agent.name !== "string") return "";
    return agent.name.trim();
  }

  function isAgentCollapsible(agent) {
    const caps = agent && agent.capabilities ? agent.capabilities : {};
    return !!(caps.permissionApproval || caps.interactiveBubble || caps.notificationHook);
  }

  function getAgentEventSourceBadgeKey(agent) {
    const eventSource = agent && typeof agent.eventSource === "string" ? agent.eventSource : "";
    if (eventSource === "log-poll") return "eventSourceLogPoll";
    if (eventSource === "plugin-event") return "eventSourcePlugin";
    if (eventSource === "extension") return "eventSourceExtension";
    return "eventSourceHook";
  }

  function compareAgentNames(a, b) {
    return normalizeAgentName(a).localeCompare(normalizeAgentName(b), undefined, {
      sensitivity: "base",
      numeric: true,
    });
  }

  function getAgentPriorityIndex(agent, collapsible) {
    const map = collapsible
      ? COLLAPSIBLE_AGENT_PRIORITY_MAP
      : NON_COLLAPSIBLE_AGENT_PRIORITY_MAP;
    if (!agent || typeof agent.id !== "string") return Number.POSITIVE_INFINITY;
    return map.has(agent.id) ? map.get(agent.id) : Number.POSITIVE_INFINITY;
  }

  function compareAgentPriority(a, b, collapsible) {
    const aPriority = getAgentPriorityIndex(a, collapsible);
    const bPriority = getAgentPriorityIndex(b, collapsible);
    if (aPriority === bPriority) return 0;
    if (!Number.isFinite(aPriority)) return 1;
    if (!Number.isFinite(bPriority)) return -1;
    return aPriority - bPriority;
  }

  function sortAgentMetadataForSettings(list) {
    const agents = Array.isArray(list) ? list.slice() : [];
    agents.sort((a, b) => {
      const aCollapsible = isAgentCollapsible(a);
      const bCollapsible = isAgentCollapsible(b);
      if (aCollapsible !== bCollapsible) return aCollapsible ? -1 : 1;

      const priorityDiff = compareAgentPriority(a, b, aCollapsible);
      if (priorityDiff !== 0) return priorityDiff;

      const nameDiff = compareAgentNames(a, b);
      if (nameDiff !== 0) return nameDiff;

      const aId = a && typeof a.id === "string" ? a.id : "";
      const bId = b && typeof b.id === "string" ? b.id : "";
      return aId.localeCompare(bId, undefined, { sensitivity: "base", numeric: true });
    });
    return agents;
  }

  return {
    COLLAPSIBLE_AGENT_PRIORITY,
    NON_COLLAPSIBLE_AGENT_PRIORITY,
    getAgentEventSourceBadgeKey,
    isAgentCollapsible,
    sortAgentMetadataForSettings,
  };
}

const settingsAgentOrderExports = buildSettingsAgentOrderExports();

if (typeof module !== "undefined" && module.exports) {
  module.exports = settingsAgentOrderExports;
}
if (typeof globalThis !== "undefined") {
  globalThis.ClawdSettingsAgentOrder = settingsAgentOrderExports;
}
