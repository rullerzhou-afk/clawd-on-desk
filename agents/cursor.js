// Cursor agent configuration
// Native hooks via ~/.cursor/hooks.json, stdin JSON with hook_event_name

module.exports = {
  id: "cursor",
  name: "Cursor",
  // Empty: Cursor is always running while the IDE is open, so process detection
  // would permanently suppress sleep. Sessions are tracked via hooks instead.
  processNames: { win: [], mac: [], linux: [] },
  nodeCommandPatterns: [],
  eventSource: "hook",
  // camelCase event names — matches Cursor native hook system
  eventMap: {
    sessionStart: "idle",
    sessionEnd: "sleeping",
    beforeSubmitPrompt: "thinking",
    preToolUse: "working",
    postToolUse: "working",
    postToolUseFailure: "error",
    subagentStart: "juggling",
    subagentStop: "working",
    preCompact: "sweeping",
    stop: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "cursor-hooks-json",
  },
  stdinFormat: "cursorHookJson",
  pidField: "cursor_pid",
};
