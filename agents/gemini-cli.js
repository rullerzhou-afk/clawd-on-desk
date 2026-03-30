// Gemini CLI agent configuration
// Hooks via ~/.gemini/settings.json, stdin JSON + stdout JSON

module.exports = {
  id: "gemini-cli",
  name: "Gemini CLI",
  processNames: { win: ["gemini.exe"], mac: ["gemini"], linux: ["gemini"] },
  nodeCommandPatterns: [],
  eventSource: "hook",
  // PascalCase event names — matches Gemini CLI hook system
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    BeforeAgent: "thinking",
    BeforeTool: "working",
    AfterTool: "working",
    AfterAgent: "attention",
    Notification: "notification",
    PreCompress: "sweeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "gemini-settings-json",
  },
  stdinFormat: "geminiHookJson",
  pidField: "gemini_pid",
};
