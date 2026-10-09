// CodeWhale agent configuration
// Perception via lifecycle hooks: [[hooks.hooks]] in ~/.codewhale/config.toml
// Hook scripts receive context via environment variables (DEEPSEEK_SESSION_ID,
// DEEPSEEK_TOOL_NAME, DEEPSEEK_MODE, DEEPSEEK_WORKSPACE, etc.) and POST to
// Clawd's /state endpoint.
//
// Phase 1: state-only integration — no permission bubbles, no subagent tracking.

module.exports = {
  id: "codewhale",
  name: "CodeWhale",
  processNames: { win: ["codewhale.exe"], mac: ["codewhale"], linux: ["codewhale"] },
  startupRecoveryProcessNames: { win: ["codewhale.exe"], mac: ["codewhale"], linux: ["codewhale"] },
  eventSource: "hook",
  // Clawd-internal event names (PascalCase). hooks/codewhale-hook.js translates
  // CodeWhale snake_case lifecycle events into these.
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Notification: "attention",
    StopFailure: "error",
    PreCompact: "sweeping",
    PostCompact: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,  // Phase 2 requires CodeWhale source changes
    notificationHook: true,
    interactiveBubble: false,
    sessionEnd: true,
    subagent: false,
  },
  pidField: "codewhale_pid",
};
