// Command Code agent configuration
// Hook-based integration via ~/.commandcode/settings.json
// (the user-scope settings file Command Code deep-merges under project scope).
//
// Phase 1 is local / main-session / state-only:
//   - Command Code keeps every permission decision. Its hook set has no
//     PermissionRequest event, and Clawd never answers PreToolUse with
//     allow/deny; the hook always emits passive `{}` stdout.
//   - Events: SessionStart / PreToolUse / PostToolUse / Stop. There is no
//     SessionEnd, Notification, UserPromptSubmit, or compaction event, so
//     sessions retire through the agent-pid exit sweep (the hook reports the
//     CLI pid when the process tree can be resolved) and the server's stale
//     timeout.
//   - No subagent aggregation, startup recovery, remote SSH, WSL, quota,
//     context usage, or session-title extraction. Command Code hook payloads
//     never carry the prompt, so the HUD falls back to the cwd basename.
//   - stdin is snake_case Claude-style (`hook_event_name`, `session_id`,
//     `cwd`, `permission_mode`, `tool_name`, `tool_input`).
//
// The CLI sets `process.title = "command-code"` at startup
// (dist/cli.mjs, setStableProcessTitle), so macOS/Linux `ps` reports
// "command-code" regardless of which npm bin alias (`cmd`, `cmdc`,
// `command-code`, `commandcode`) launched it. Windows only changes the
// console title: the process stays `node.exe`, so the hook's pid resolver
// identifies it by its command line (`command-code/dist/index.mjs`).
//
// User-scope settings.json hooks are exempt from Command Code's project-hook
// trust gate (`checkTrust` returns "trusted" for source "user"), so the
// registered entries run without an approval prompt. On Windows the CLI is
// launched as `cmdc` (`cmd` collides with the command interpreter), and the
// installer requires `~/.commandcode/` to exist — the CLI ran at least once.

module.exports = {
  id: "command-code",
  name: "Command Code",
  processNames: {
    // Windows has no distinct image name: the CLI runs under node.exe, and
    // matching `cmd.exe` (the interpreter) or a bare `node.exe` would be
    // wrong. The hook-side pid resolver uses the command-line probe instead.
    win: [],
    mac: ["command-code"],
    linux: ["command-code"],
  },
  // The CLI is long-lived per session and reports no SessionEnd; a running
  // process at Clawd startup is not proof of an active turn. Startup recovery
  // stays off on every OS (same rule as the other hook-only CLIs).
  startupRecoveryProcessNames: { win: [], mac: [], linux: [] },
  eventSource: "hook",
  eventMap: {
    SessionStart: "idle",
    PreToolUse: "working",
    PostToolUse: "working",
    Stop: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    // State-only: Command Code has no PermissionRequest event and Clawd never
    // answers PreToolUse, so there is no permission request to observe.
    mobilePermissionObservation: false,
    interactiveBubble: false,
    // Command Code has no Notification hook event.
    notificationHook: false,
    // Command Code has no SessionEnd hook event.
    sessionEnd: false,
    subagent: false,
  },
  hookConfig: {
    configFormat: "commandcode-settings-json",
  },
  stdinFormat: "commandCodeHookJson",
  pidField: "source_pid",
};
