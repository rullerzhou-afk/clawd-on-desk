// CodeBuddy IDE/CLI agent configuration
// Hook-based integration — Claude Code-compatible hook format
// Settings: ~/.codebuddy/settings.json
// Docs: https://www.codebuddy.ai/docs/zh/cli/hooks

module.exports = {
  id: "codebuddy",
  name: "CodeBuddy",
  processNames: {
    win: ["CodeBuddy.exe", "codebuddy.exe"],
    mac: ["CodeBuddy"],
    linux: ["codebuddy", "CodeBuddy"],
  },
  eventSource: "hook",
  // PascalCase event names — identical to Claude Code hook system
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
  pidField: "codebuddy_pid",
};
