// Antigravity editor agent configuration
// Uses Antigravity language-server logs under ~/Library/Application Support/Antigravity/logs

module.exports = {
  id: "antigravity",
  name: "Antigravity",
  processNames: {
    win: ["Antigravity.exe"],
    mac: ["Antigravity"],
    linux: ["antigravity", "Antigravity"],
  },
  eventSource: "log-poll",
  logEventMap: {
    plannerRequest: "thinking",
    overlayAction: "working",
    cascadeFailure: "error",
    sessionIdle: "idle",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    sessionEnd: false,
    subagent: false,
  },
  logConfig: {
    logsDir: "~/Library/Application Support/Antigravity/logs",
    fileName: "ls-main.log",
    pollIntervalMs: 1500,
    idleAfterMs: 6000,
    tailLinesOnStart: 200,
  },
  pidField: "antigravity_pid",
};
