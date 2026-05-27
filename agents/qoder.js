// Qoder agent configuration
// Hooks via ~/.qoder/settings.json, stdin JSON

module.exports = {
  id: "qoder",
  name: "Qoder",
  processNames: { win: ["qoder.exe", "qoder-cli.exe"], mac: ["qoder", "qoder-cli"], linux: ["qoder", "qoder-cli"] },
  eventSource: "hook",
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Notification: "notification",
    Stop: "idle",
    SessionEnd: "sleeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    notificationHook: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "qoder-settings-json",
  },
  stdinFormat: "qoderHookJson",
  pidField: "source_pid",
};
