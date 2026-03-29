// Copilot CLI agent configuration
// Hooks work on Windows + macOS, similar architecture to Claude Code

module.exports = {
  id: "copilot-cli",
  name: "Copilot CLI",
  processNames: { win: ["copilot.exe"], mac: ["copilot"], linux: ["copilot"] },
  nodeCommandPatterns: ["@github/copilot"],
  eventSource: "hook",
  // camelCase event names — matches Copilot CLI hook system
  eventMap: {
    sessionStart: "idle",
    sessionEnd: "sleeping",
    userPromptSubmitted: "thinking",
    preToolUse: "working",
    postToolUse: "working",
    errorOccurred: "error",
    agentStop: "attention",
    subagentStart: "juggling",
    subagentStop: "working",
    preCompact: "sweeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false, // preToolUse only supports deny, not allow
    sessionEnd: true,
    subagent: true,
  },
  // Copilot hooks use project-level hooks.json (not global settings)
  hookConfig: {
    configFormat: "project-hooks-json",
  },
  // stdin JSON uses camelCase field names (sessionId not session_id)
  stdinFormat: "camelCase",
  pidField: "copilot_pid",
};
