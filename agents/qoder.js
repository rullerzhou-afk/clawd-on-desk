// Qoder IDE agent configuration
// Hooks via ~/.qoder/settings.json, stdin JSON + stdout JSON
// Based on https://docs.qoder.com/zh/extensions/hooks

module.exports = {
  id: "qoder",
  name: "Qoder IDE",
  processNames: { win: ["qoder.exe"], mac: ["qoder"], linux: ["qoder"] },
  nodeCommandPatterns: [],
  eventSource: "hook",
  // PascalCase event names — matches Qoder hook system
  eventMap: {
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false, // PreToolUse exit 2 blocks, but no HTTP decision
    sessionEnd: false,
    subagent: false,
  },
  hookConfig: {
    configFormat: "qoder-settings-json",
  },
  stdinFormat: "qoderHookJson",
  pidField: "qoder_pid",
};
