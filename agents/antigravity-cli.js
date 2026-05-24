// Antigravity CLI agent configuration
// Hooks via ~/.gemini/config/hooks.json, stdin JSON + stdout JSON

module.exports = {
  id: "antigravity-cli",
  name: "Antigravity CLI",
  processNames: { win: ["agy.exe"], mac: ["agy"], linux: ["agy"] },
  eventSource: "hook",
  // PreToolUse intentionally omitted: agy owns permission via its native menu,
  // triggered by the LLM's proactive ask_permission tool calls.
  eventMap: {
    PreInvocation: "thinking",
    PostToolUse: "working",
    PostInvocation: "idle",
    Stop: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    interactiveBubble: false,
    notificationHook: false,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "antigravity-hooks-json",
  },
  stdinFormat: "antigravityHookJson",
  pidField: "agy_pid",
};
