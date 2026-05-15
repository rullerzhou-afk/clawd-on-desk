// Pi agent configuration
// Perception via Pi extension: lifecycle event hook -> HTTP POST to Clawd

module.exports = {
  id: "pi",
  name: "Pi",
  processNames: { win: ["pi.exe"], mac: ["pi"], linux: ["pi"] },
  eventSource: "extension",
  // Clawd-internal event names. hooks/pi-extension-core.js translates Pi's
  // native snake_case events to this shared PascalCase event vocabulary.
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    PreCompact: "sweeping",
    PostCompact: "attention",
    SessionEnd: "sleeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: true,
    notificationHook: false,
    interactiveBubble: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "pi-extension",
  },
  // Historical registry field for agent-specific pid names. The Pi extension
  // should send generic agent_pid; no pi_pid payload is required.
  pidField: "pi_pid",
};
