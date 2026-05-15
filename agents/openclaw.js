// OpenClaw agent configuration
// Perception via OpenClaw plugin hooks -> HTTP POST to Clawd.

module.exports = {
  id: "openclaw",
  name: "OpenClaw",
  // OpenClaw is an npm CLI and commonly appears as node.exe ... openclaw.mjs
  // on Windows. A broad node.exe match would create false positives. Phase 1
  // avoids process-name detection and keeps terminal focus as a known limit
  // because OpenClaw's installer blocks plugins that import child_process.
  processNames: { win: [], mac: [], linux: [] },
  eventSource: "plugin-event",
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    StopFailure: "error",
    PreCompact: "sweeping",
    PostCompact: "attention",
    SessionEnd: "sleeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    notificationHook: false,
    interactiveBubble: false,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "openclaw-plugin",
  },
  pidField: "openclaw_pid",
};
