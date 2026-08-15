// TraeCode IDE agent configuration
// Hook-based integration — Claude Code-compatible hook format
// Config: ~/.trae-cn/hooks.json
// Docs: https://docs.trae.cn/ide/automate-actions-with-hooks

module.exports = {
  id: "traecode",
  name: "TraeCode",
  processNames: {
    win: ["Trae.exe", "trae.exe"],
    mac: ["Trae", "trae"],
    linux: ["trae", "Trae"],
  },
  startupRecoveryProcessNames: {
    win: [],
    mac: [],
    linux: [],
  },
  eventSource: "hook",
  eventMap: {
    SessionStart:     "idle",
    UserPromptSubmit: "thinking",
    PreToolUse:       "working",
    PostToolUse:      "working",
    Stop:             "attention",
    Notification:     "notification",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    interactiveBubble: false,
    notificationHook: true,
    sessionEnd: false,
    subagent: false,
  },
  hookConfig: {
    configFormat: "traecode-hooks-json",
  },
  stdinFormat: "claudeCodeHookJson",
  pidField: "traecode_pid",
};
