// WorkBuddy IDE/CLI agent configuration
// Hook-based integration — Claude Code-compatible hook format
// Settings: ~/.workbuddy-ai/settings.json (current) or ~/.workbuddy/settings.json (legacy)
// Docs: https://www.codebuddy.cn/docs/workbuddy/Overview

module.exports = {
  id: "workbuddy",
  name: "WorkBuddy",
  processNames: {
    // NOTE on process names — WorkBuddy is a GUI Electron app, not a bare CLI
    // like `claude`/`codebuddy`. Verified on macOS: current 5.2.3 ships "WorkBuddy AI
    // Helper" variants; older builds shipped "WorkBuddy Helper" variants. The main
    // executable is the bare "Electron" binary, which we deliberately DO NOT
    // list — matching it would false-positive on dev-mode Clawd and other
    // unrenamed Electron apps. These remain general process metadata; the
    // startup keep-awake surface below is intentionally empty.
    win: ["WorkBuddy.exe", "workbuddy.exe"],
    mac: [
      "WorkBuddy AI Helper",
      "WorkBuddy AI Helper (Renderer)",
      "WorkBuddy Helper",
      "WorkBuddy Helper (Renderer)",
    ],
    linux: ["workbuddy", "WorkBuddy"],
  },
  // WorkBuddy is a long-lived desktop app; hooks remain authoritative for
  // whether an agent turn is active.
  startupRecoveryProcessNames: { win: [], mac: [], linux: [] },
  eventSource: "hook",
  // PascalCase event names — identical to Claude Code hook system.
  // NOTE: no PermissionRequest entry. Desktop WorkBuddy resolves the entire
  // permission loop inside its own native sandbox (sandbox-core/tsbx) and GUI
  // confirmation cards; Clawd's /permission endpoint is never called in the
  // desktop form factor (verified on Windows). A permission prompt surfaces to
  // Clawd only as a Notification (notification_type "permission_prompt"), which
  // is enough for the bell/attention cue — so WorkBuddy is notification-only,
  // like qoderwork.
  eventMap: {
    SessionStart:     "idle",
    SessionEnd:       "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse:       "working",
    PostToolUse:      "working",
    Stop:             "attention",
    Notification:     "notification",
    PreCompact:       "sweeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    interactiveBubble: false,
    notificationHook: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "claude-code-compatible",
  },
  stdinFormat: "claudeCodeHookJson",
  pidField: "workbuddy_pid",
};
