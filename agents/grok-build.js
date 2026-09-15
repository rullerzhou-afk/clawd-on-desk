// Grok Build agent configuration
// Hook-based integration via ~/.grok/hooks/clawd-on-desk.json
// (or $GROK_HOME/hooks/clawd-on-desk.json).
//
// Phase 1 is local / main-session / state-only:
//   - Grok keeps every permission decision; Clawd never registers /permission
//     and the hook always emits passive `{}` stdout.
//   - No subagent aggregation, terminal focus, startup recovery, remote SSH,
//     WSL, quota/context usage, or session-title extraction.
//   - stdin is camelCase (`sessionId` / `toolName`); event names are the
//     camelCase key with snake_case value, or the snake_case compatibility key
//     with the PascalCase value (see hooks/grok-hook.js).
//
// `grok` is not a valid agent id here: the unshipped PR preview used a bare
// `grok` id and never shipped, so no migration is possible or needed.

module.exports = {
  id: "grok-build",
  name: "Grok Build",
  processNames: {
    win: ["grok.exe"],
    mac: ["grok"],
    linux: ["grok"],
  },
  // Grok Build is local state-only; a long-lived CLI process is not an active
  // turn signal. Startup recovery is deliberately disabled on every OS.
  startupRecoveryProcessNames: { win: [], mac: [], linux: [] },
  eventSource: "hook",
  // PascalCase event names match Grok's Claude-compatible hook_event_name.
  // Stop is only reached for an exact `end_turn` with no live background work;
  // the adapter resolves continuation/teardown Stops locally. Notification
  // presentation includes the passive PermissionDenied observation.
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    StopFailure: "error",
    StopCancelled: "idle",
    Notification: "notification",
    PreCompact: "sweeping",
    PostCompact: "thinking",
    PermissionDenied: "notification",
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
    configFormat: "grok-hooks-json",
  },
  stdinFormat: "grokHookJson",
};
