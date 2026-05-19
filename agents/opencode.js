// opencode agent configuration
// Perception via opencode Plugin SDK: event hook → HTTP POST to Clawd
// Plugin registered in ~/.config/opencode/opencode.json "plugin" array (global scope)

module.exports = {
  id: "opencode",
  name: "OpenCode",
  processNames: { win: ["opencode.exe"], mac: ["opencode"], linux: ["opencode"] },
  eventSource: "plugin-event",
  // Clawd-internal event names (PascalCase) — opencode-plugin/index.mjs translates
  // opencode native events (session.status, message.part.updated, etc) into these.
  // Reusing Claude Code event names lets state.js reuse existing transition logic
  // (e.g. SubagentStop → working whitelist).
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    StopFailure: "error",
    PreCompact: "sweeping",
    PostCompact: "attention",
    Notification: "notification",
    // Phase 2: PermissionRequest rides a parallel channel (event permission.asked
    // → plugin POST /permission → bubble → REST reply), not agent eventMap.
    // Phase 3: SubagentStart/SubagentStop (subtask tracking)
  },
  capabilities: {
    httpHook: false,         // opencode permission goes via plugin event forward, not HTTP blocking
    permissionApproval: true, // Phase 2: Clawd bubble → opencode REST reply
    notificationHook: true,  // Clawd intercepts session.idle → Notification; oh-my-openagent session-notification hook disabled
    sessionEnd: true,
    subagent: false,         // Phase 3 will flip to true once subtask lifecycle verified
  },
  pidField: "opencode_pid",
};
