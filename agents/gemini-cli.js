// Gemini CLI agent configuration
// Hooks via ~/.gemini/settings.json, stdin JSON + stdout JSON

module.exports = {
  id: "gemini-cli",
  name: "Gemini CLI",
  processNames: { win: ["gemini.exe"], mac: ["gemini"], linux: ["gemini"] },
  startupRecoveryProcessNames: { win: ["gemini.exe"], mac: ["gemini"], linux: ["gemini"] },
  eventSource: "hook",
  // PascalCase event names — matches Gemini CLI hook system
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    BeforeAgent: "thinking",
    BeforeTool: "working",
    AfterTool: "working",
    AfterAgent: "idle",
    Notification: "notification",
    // Hook runtime sends preserve_state=true for this event, so state.js keeps
    // the active visual while recording the raw PreCompress event.
    PreCompress: "idle",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    notificationHook: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "gemini-settings-json",
  },
  stdinFormat: "geminiHookJson",
  pidField: "gemini_pid",
};
