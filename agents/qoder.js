// Qoder agent configuration
// Hook-only integration via ~/.qoder/settings.json / ~/.qoder-cn/settings.json.
//
// Clawd observes Qoder's permission events (PermissionRequest / PermissionDenied)
// as passive notifications but NEVER answers Qoder permission decisions — the
// hook always returns `{}` so Qoder's native permission flow stays in control.
// See docs/project/agent-runtime-architecture.md.

module.exports = {
  id: "qoder",
  name: "Qoder",
  // qoder.exe / qoder is the IDE; the official CLI is `qodercli`
  // (npm i -g @qoder-ai/qodercli). `qoder-cli` is kept as a defensive alias.
  // Both IDE and CLI can host an agent process tree, so the hook PID resolver
  // attributes either to this agent. Startup recovery (src/state.js)
  // deliberately watches only the CLI names — an idle open IDE must not look
  // like active agent work.
  processNames: {
    win: ["qoder.exe", "qodercli.exe", "qoder-cli.exe", "qoder cn.exe", "qodercn.exe", "qoderclicn.exe"],
    mac: ["qoder", "qodercli", "qoder-cli", "qoder cn", "qodercn", "qoderclicn"],
    linux: ["qoder", "qodercli", "qoder-cli", "qoder cn", "qodercn", "qoderclicn"],
  },
  startupRecoveryProcessNames: {
    win: ["qodercli.exe", "qoder-cli.exe", "qoderclicn.exe"],
    mac: ["qodercli", "qoder-cli", "qoderclicn"],
    linux: ["qodercli", "qoder-cli", "qoderclicn"],
  },
  eventSource: "hook",
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    Notification: "notification",
    // Phase 1 state-only: observed as a passive notification, no decision.
    PermissionRequest: "notification",
    PermissionDenied: "notification",
    SessionEnd: "sleeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    mobilePermissionObservation: false,
    interactiveBubble: false,
    notificationHook: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "qoder-settings-json",
  },
  stdinFormat: "qoderHookJson",
  pidField: "source_pid",
};
