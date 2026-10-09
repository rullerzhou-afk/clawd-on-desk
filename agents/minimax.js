// MiniMax Code agent configuration (MiniMax mcode CLI / MiniMax Code desktop app)
// Hook-based integration via a local plugin directory:
//   ~/.minimax/plugins/clawd-state/.claude-plugin/plugin.json
//   ~/.minimax/plugins/clawd-state/hooks/hooks.json
// (or $MINIMAX_DATA_DIR/plugins/clawd-state/...). MiniMax Code carries hooks
// inside plugins: the manifest declares "hooks": ["hooks/hooks.json"] and the
// hook document is parsed in the Claude Code-compatible format (sourceFormat
// CLAUDE) — see MiniMax-AI/minimax-code packages/agent-modules/plugin-hooks.
//
// Phase 1 is local / state-only:
//   - MiniMax keeps every permission decision. PermissionRequest is NOT
//     registered at all: the plugin-hook runner enforces a hard 1–10 second
//     timeout budget per handler (SessionEnd events get 3s total), so a
//     blocking human-approval round trip is physically impossible.
//   - There is no Notification event in MiniMax's plugin hook set.
//   - No terminal focus, startup recovery (the desktop app is long-lived and
//     does not represent an active turn), remote SSH, or WSL.
//   - stdin is snake_case Claude-compatible (`hook_event_name`, `session_id`,
//     `cwd`, `tool_name`); every event answers `{}` (permissionDecision
//     defaults to abstain, leaving MiniMax's native flow untouched).

module.exports = {
  id: "minimax",
  name: "MiniMax Code",
  processNames: {
    win: ["MiniMax Code.exe", "mcode.exe"],
    mac: ["MiniMax Code", "mcode"],
    linux: ["mcode", "MiniMax Code"],
  },
  // The desktop app is long-lived and does not represent an active turn, and
  // `mcode` CLI processes are not reliably attributable at Clawd startup.
  startupRecoveryProcessNames: { win: [], mac: [], linux: [] },
  eventSource: "hook",
  // PascalCase event names match MiniMax's Claude-compatible hook_event_name
  // (PLUGIN_HOOK_EVENTS). PermissionRequest is deliberately absent — see the
  // Phase 1 note above.
  eventMap: {
    SessionStart: "idle",
    SessionEnd: "sleeping",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    Stop: "attention",
    SubagentStart: "juggling",
    SubagentStop: "working",
    PreCompact: "sweeping",
    // Compaction finishing is not turn completion (#406): the hook reports
    // thinking for an automatic compaction and idle for a manual one.
    PostCompact: "thinking",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    interactiveBubble: false,
    notificationHook: false,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "minimax-plugin-hooks",
  },
  stdinFormat: "claudeCodeHookJson",
  pidField: "minimax_pid",
};
