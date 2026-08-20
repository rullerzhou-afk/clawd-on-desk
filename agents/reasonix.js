// Reasonix agent configuration
// Hook-only integration via ~/.reasonix/settings.json
// Reasonix is a Go CLI coding agent; Phase 1 is state-only (no permission bubble).
// Reasonix owns its own permission flow natively via its Gate + terminal prompt.

module.exports = {
  id: "reasonix",
  name: "Reasonix",
  processNames: { win: ["reasonix.exe", "reasonix-desktop.exe", "reasonix-cli.exe"], mac: ["reasonix", "reasonix-desktop"], linux: ["reasonix", "reasonix-desktop"] },
  // reasonix-desktop(.exe) is a resident GUI: valid for process detection and
  // hook PID attribution, but its mere presence is not turn activity. Keep it
  // out of startup recovery, matching the Qoder/QoderWork/WorkBuddy boundary.
  startupRecoveryProcessNames: { win: ["reasonix.exe", "reasonix-cli.exe"], mac: ["reasonix"], linux: ["reasonix"] },
  eventSource: "hook",
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    Stop: "attention",
    SubagentStop: "working",
    Notification: "notification",
    PreCompact: "sweeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    mobilePermissionObservation: false,
    interactiveBubble: false,
    notificationHook: true,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "reasonix-settings-json",
  },
  stdinFormat: "reasonixHookJson",
  pidField: "reasonix_pid",
};
