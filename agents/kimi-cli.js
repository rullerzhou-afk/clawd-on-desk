// Kimi agent configuration — covers both generations (#563):
//   legacy Kimi CLI (Python)      → hooks in ~/.kimi/config.toml
//   Kimi Code (TypeScript, node)  → hooks in ~/.kimi-code/config.toml
// The agent id stays "kimi-cli" for prefs/state compatibility; the display
// name follows the current upstream product name.

module.exports = {
  id: "kimi-cli",
  name: "Kimi Code",
  // kimi / kimi.exe match the legacy CLI and Kimi Code's native
  // (install-script) build. The npm build of Kimi Code runs under node and is
  // caught by command-line matching in the hook's pid resolver and the
  // startup-recovery process scan, not by these names.
  processNames: { mac: ["kimi", "Kimi Code"], linux: ["kimi"], win: ["kimi.exe"] },
  eventSource: "hook",
  // PascalCase event names — identical stdin shape across both generations.
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    StopFailure: "error",
    SubagentStart: "juggling",
    SubagentStop: "working",
    PreCompact: "sweeping",
    PostCompact: "attention",
    Notification: "notification",
    // Kimi Code native events (legacy CLI never sends these).
    PermissionRequest: "notification",
    PermissionResult: "working",
    Interrupt: "idle",
  },
  capabilities: {
    httpHook: true,
    permissionApproval: true,
    notificationHook: true,
    interactiveBubble: false,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "kimi-toml",
  },
  stdinFormat: "claudeHookJson",
  pidField: "kimi_pid",
};
