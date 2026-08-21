// TraeCode (Trae CN IDE) agent configuration
// Hook-based integration — Claude Code-compatible hook format
// Scope: Trae CN only — install/detection/cleanup use ~/.trae-cn/hooks.json.
// The international Trae build uses ~/.trae/hooks.json and is not covered by
// this first release.
// Config: ~/.trae-cn/hooks.json
// Docs: https://docs.trae.cn/ide/automate-actions-with-hooks

module.exports = {
  id: "traecode",
  name: "TraeCode",
  processNames: {
    win: ["Trae CN.exe", "trae cn.exe", "TraeCN.exe", "traecn.exe"],
    mac: ["Trae", "trae"],
    linux: ["trae", "Trae"],
  },
  startupRecoveryProcessNames: {
    win: [],
    mac: [],
    linux: [],
  },
  eventSource: "hook",
  eventMap: {
    SessionStart:     "idle",
    UserPromptSubmit: "thinking",
    PreToolUse:       "working",
    PostToolUse:      "working",
    Stop:             "attention",
    Notification:     "notification",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    interactiveBubble: false,
    notificationHook: true,
    sessionEnd: false,
    subagent: false,
  },
  hookConfig: {
    configFormat: "traecode-hooks-json",
  },
  stdinFormat: "claudeCodeHookJson",
  pidField: "traecode_pid",
};
