// Copilot CLI agent configuration
// Hooks work on Windows + macOS, similar architecture to Claude Code

module.exports = {
  id: "copilot-cli",
  name: "Copilot CLI",
  processNames: { win: ["copilot.exe"], mac: ["copilot"], linux: ["copilot"] },
  startupRecoveryProcessNames: { win: ["copilot.exe"], mac: ["copilot"], linux: ["copilot"] },
  eventSource: "hook",
  // camelCase event names — matches Copilot CLI hook system
  eventMap: {
    sessionStart: "idle",
    sessionEnd: "sleeping",
    userPromptSubmitted: "thinking",
    preToolUse: "working",
    postToolUse: "working",
    errorOccurred: "error",
    agentStop: "attention",
    subagentStart: "juggling",
    subagentStop: "working",
    preCompact: "sweeping",
  },
  capabilities: {
    httpHook: false,
    // permissionRequest is wired in via command hook + curl https — same
    // shape as Codex/Qwen (hook command exits 0 with JSON stdout). The
    // bubble pipeline returns no-decision on fallback so Copilot's
    // native menu still owns the call.
    permissionApproval: true,
    interactiveBubble: true,
    sessionEnd: true,
    subagent: true,
  },
  // User-global hooks at <COPILOT_HOME or ~/.copilot>/hooks/hooks.json,
  // merged with optional .github/hooks/*.json at repo scope by Copilot CLI.
  hookConfig: {
    configFormat: "user-global-hooks-json",
  },
  // stdin JSON uses camelCase field names (sessionId not session_id)
  stdinFormat: "camelCase",
  pidField: "copilot_pid",
};
