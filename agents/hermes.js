// Hermes Agent configuration
// Perception via Hermes Python plugin hooks installed under Hermes' plugin dir.

module.exports = {
  id: "hermes",
  name: "Hermes Agent",
  processNames: { win: ["hermes.exe"], mac: ["hermes"], linux: ["hermes"] },
  eventSource: "plugin-event",
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    StopFailure: "error",
    SessionEnd: "sleeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    interactiveBubble: false,
    sessionEnd: true,
    subagent: false,
  },
  pidField: "hermes_pid",
};
