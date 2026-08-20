// DeepSeek Harness web-profile integration. A Clawd-managed in-process DSH
// plugin observes public session events and prepends a blocking ordinary-tool
// approval listener. ask_user_question remains entirely native to DSH.

module.exports = {
  id: "deepseek-harness",
  name: "DeepSeek Harness (web, experimental)",
  // DSH runs through Node, so generic process-name recovery would claim
  // unrelated Node sessions. Plugin lifecycle events are authoritative.
  processNames: { win: [], mac: [], linux: [] },
  startupRecoveryProcessNames: { win: [], mac: [], linux: [] },
  eventSource: "plugin-event",
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    StopFailure: "error",
    SessionEnd: "sleeping",
  },
  capabilities: {
    httpHook: true,
    permissionApproval: true,
    mobilePermissionObservation: false,
    notificationHook: false,
    interactiveBubble: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "dsh-plugin",
  },
};
