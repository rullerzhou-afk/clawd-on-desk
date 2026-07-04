// mimicode agent configuration
// Perception via mimocode Plugin SDK (@mimo-ai/plugin): event hook → HTTP POST to Clawd
// Plugin registered in ~/.config/mimocode/mimocode.jsonc "plugin" array (global scope)

module.exports = {
  id: "mimocode",
  name: "MiMo Code",
  processNames: { win: ["mimo.exe"], mac: ["mimo"], linux: ["mimo"] },
  eventSource: "plugin-event",
  // Clawd-internal event names (PascalCase) — mimocode-plugin/index.mjs translates
  // mimocode native events (session.status, message.part.updated, etc) into these.
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
    // Phase 2: PermissionRequest rides a parallel channel (event permission.asked
    // → plugin POST /permission → bubble → REST reply), not agent eventMap.
    // Phase 3: SubagentStart/SubagentStop (subtask tracking)
  },
  capabilities: {
    httpHook: false,         // mimocode permission goes via plugin event forward, not HTTP blocking
    permissionApproval: true, // Phase 2: Clawd bubble → mimocode REST reply
    sessionEnd: true,
    subagent: false,         // Phase 3 will flip to true once subtask lifecycle verified
  },
  pidField: "mimocode_pid",
};
