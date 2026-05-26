// Qwen Code agent configuration
// Hook-only integration via ~/.qwen/settings.json

module.exports = {
  id: "qwen-code",
  name: "Qwen Code",
  processNames: { win: ["qwen.exe"], mac: ["qwen"], linux: ["qwen"] },
  eventSource: "hook",
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    Stop: "attention",
    PermissionRequest: "notification",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: true,
    notificationHook: true,
    interactiveBubble: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "qwen-settings-json",
  },
  stdinFormat: "qwenHookJson",
};
