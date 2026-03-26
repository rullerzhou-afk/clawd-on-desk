// OpenCode/Crush agent configuration
// OpenCode is an open-source coding agent (forked by Charm as Crush)
// https://github.com/anomalyco/opencode

module.exports = {
  id: "opencode",
  name: "OpenCode/Crush",
  processNames: { win: ["opencode.exe", "crush.exe"], mac: ["opencode", "crush"] },
  // node/bun running opencode/crush
  nodeCommandPatterns: ["opencode", "crush"],
  eventSource: "plugin",
  // Event names from OpenCode plugin system (dot-notation)
  eventMap: {
    "session.created": "idle",
    "session.deleted": "sleeping",
    "session.error": "error",
    "chat.message": "thinking",
    "tool.execute.before": "working",  // dynamic in plugin
    "tool.execute.after": "working",   // dynamic in plugin
    "command.execute.before": "working",
    "experimental.session.compacting": "sweeping",
    "permission.ask": "attention",
  },
  capabilities: {
    httpHook: false,      // Plugin-based, not HTTP hooks
    permissionApproval: false,  // OpenCode handles permissions internally
    sessionEnd: true,
    subagent: false,      // No explicit subagent events
  },
  pidField: "agent_pid",
};
