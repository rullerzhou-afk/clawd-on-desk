// AutoClaw agent configuration (智谱 AutoClaw desktop app)
// AutoClaw embeds an OpenClaw gateway (openclaw 2026.6.8 in AutoClaw 1.20.0)
// that runs with its own OpenClaw state dir at ~/.openclaw-autoclaw (injected
// via OPENCLAW_STATE_DIR, not the shared ~/.openclaw). Perception reuses the
// same OpenClaw plugin contract as the openclaw integration, materialized as
// a separate plugin dir (hooks/autoclaw-plugin/) so the two hosts report
// distinct agent ids from independent configs.
//
// Phase 1 is state-only, mirroring openclaw:
//   - AutoClaw keeps every permission decision in its own UI; the plugin
//     registers no approval hooks and Clawd never surfaces a bubble.
//   - No terminal focus: sessions live inside the desktop app, and the
//     embedded-gateway process tree is not attributable to a terminal.
//   - processNames stay empty (same rationale as openclaw): a broad
//     Electron/node match would create false positives.

module.exports = {
  id: "autoclaw",
  name: "AutoClaw",
  processNames: { win: [], mac: [], linux: [] },
  startupRecoveryProcessNames: { win: [], mac: [], linux: [] },
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
    mobilePermissionObservation: false,
    notificationHook: false,
    interactiveBubble: false,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "openclaw-plugin",
  },
  pidField: "autoclaw_pid",
};
