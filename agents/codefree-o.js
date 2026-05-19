// CodeFree-O agent configuration
// CodeFree-O (中国电信 CodeFree 研发大模型) is built on the opencode platform:
//   - Same process name (opencode.exe / opencode)
//   - Same config directory (~/.config/opencode/)
//   - Same plugin system (@opencode-ai/plugin SDK)
//   - Same event vocabulary (session.status, message.part.updated, etc.)
//
// Perception via CodeFree-O Plugin: event hook → HTTP POST to Clawd
// Plugin registered in ~/.config/opencode/opencode.json "plugin" array (global scope)
//
// The codefree-o-plugin/ is a dedicated copy of opencode-plugin/ with
// AGENT_ID="codefree-o" so Clawd can distinguish CodeFree-O sessions
// from vanilla opencode sessions in the UI, settings, and permission flow.

module.exports = {
  id: "codefree-o",
  name: "CodeFree-O",
  processNames: { win: ["opencode.exe"], mac: ["opencode"], linux: ["opencode"] },
  eventSource: "plugin-event",
  // Clawd-internal event names (PascalCase) — codefree-o-plugin/index.mjs translates
  // CodeFree-O native events (session.status, message.part.updated, etc) into these.
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
    httpHook: false,         // CodeFree-O permission goes via plugin event forward, not HTTP blocking
    permissionApproval: true, // Phase 2: Clawd bubble → CodeFree-O REST reply (via reverse bridge)
    notificationHook: true,  // Clawd intercepts session.idle → Notification; oh-my-openagent session-notification hook disabled
    sessionEnd: true,
    subagent: false,         // Phase 3 will flip to true once subtask lifecycle verified
  },
  pidField: "opencode_pid",
};
