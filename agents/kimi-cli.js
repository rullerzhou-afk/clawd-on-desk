// Kimi agent configuration — covers both generations (#563):
//   legacy Kimi CLI (Python)      → hooks in ~/.kimi/config.toml
//   Kimi Code (TypeScript, node)  → hooks in ~/.kimi-code/config.toml
// The agent id stays "kimi-cli" for prefs/state compatibility; the display
// name follows the current upstream product name.

const {
  KIMI_PROCESS_NAMES,
  KIMI_STARTUP_RECOVERY_PROCESS_NAMES,
} = require("../hooks/kimi-process-names");

module.exports = {
  id: "kimi-cli",
  name: "Kimi Code",
  // On macOS/Linux Kimi Code retitles itself kimi-code (cut to fit its launch
  // command; see hooks/kimi-process-names.js), native and npm builds alike.
  // On Windows the native build is kimi.exe, while the npm build stays
  // node.exe and is caught by command-line matching in the hook's pid resolver
  // and the startup-recovery process scan, not by these names.
  processNames: KIMI_PROCESS_NAMES,
  startupRecoveryProcessNames: KIMI_STARTUP_RECOVERY_PROCESS_NAMES,
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
