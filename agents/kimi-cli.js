// Kimi CLI agent configuration
// Hook-only integration via ~/.kimi/config.toml

module.exports = {
  id: "kimi-cli",
  name: "Kimi CLI",
  processNames: { mac: ["kimi", "Kimi Code"], linux: ["kimi"], win: ["kimi.exe"] },
  eventSource: "hook",
  // PascalCase event names — matches Kimi CLI hook payload.
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
  },
  capabilities: {
    httpHook: true,
    permissionApproval: true,
    notificationHook: true,
    interactiveBubble: false,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "kimi-toml",
  },
  stdinFormat: "claudeHookJson",
  pidField: "kimi_pid",
};
