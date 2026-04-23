// Claude Code agent configuration
// Extracted from hardcoded constants in main.js and clawd-hook.js

module.exports = {
  id: "claude-code",
  name: "Claude Code",
  processNames: { win: ["claude.exe"], mac: ["claude"], linux: ["claude"] },
  eventSource: "hook",
  // PascalCase event names — matches Claude Code hook system
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    StopFailure: "error",
    SubagentStart: "juggling",
    SubagentStop: "working",
    PreCompact: "sweeping",
    PostCompact: "attention",
    Notification: "notification",
    Elicitation: "notification",
    WorktreeCreate: "carrying",
  },
  capabilities: {
    httpHook: true,
    permissionApproval: true,
    notificationHook: true,
    sessionEnd: true,
    subagent: true,
  },
  pidField: "claude_pid",
};
