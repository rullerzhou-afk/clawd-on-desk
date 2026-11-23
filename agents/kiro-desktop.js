// Kiro IDE desktop hooks and local session interaction records.
module.exports = {
  id: "kiro-desktop",
  name: "Kiro IDE",
  processNames: {
    win: ["Kiro.exe"],
    mac: ["Kiro"],
    linux: ["kiro"],
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
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    mobilePermissionObservation: false,
    interactiveBubble: false,
    notificationHook: false,
    sessionEnd: false,
    subagent: false,
    approvalReminder: true,
  },
  hookConfig: {
    configFormat: "kiro-ide-hooks-json",
  },
  stdinFormat: "claudeCodeHookJson",
  pidField: "kiro-desktop_pid",
};
