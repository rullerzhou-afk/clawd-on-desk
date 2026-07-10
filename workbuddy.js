// WorkBuddy IDE/CLI agent configuration
// Hook-based integration using the CodeBuddy/Claude Code-compatible hook shape.
// Settings: ~/.workbuddy/settings.json

module.exports = {
  id: "workbuddy",
  name: "WorkBuddy",
  processNames: {
    win: ["WorkBuddy.exe", "workbuddy.exe"],
    mac: ["WorkBuddy"],
    linux: ["workbuddy", "WorkBuddy"],
  },
  eventSource: "hook",
  eventMap: {
    SessionStart:     "idle",
    SessionEnd:       "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse:       "working",
    PostToolUse:      "working",
    Stop:             "attention",
    PermissionRequest:"notification",
    Notification:     "notification",
    PreCompact:       "sweeping",
  },
  capabilities: {
    httpHook: true,
    permissionApproval: true,
    notificationHook: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "claude-code-compatible",
  },
  stdinFormat: "claudeCodeHookJson",
  pidField: "workbuddy_pid",
};
