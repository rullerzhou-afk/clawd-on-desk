// Cursor IDE — Agent (Composer) hooks via ~/.cursor/hooks.json
// Event names are camelCase (Cursor hook spec); cursor-hook.js normalizes to PascalCase for the state machine.

module.exports = {
  id: "cursor-agent",
  name: "Cursor Agent",
  processNames: {
    win: ["Cursor.exe"],
    mac: ["Cursor"],
    linux: ["cursor", "Cursor"],
  },
  // An open IDE is not evidence that Cursor Agent is mid-turn.
  startupRecoveryProcessNames: { win: [], mac: [], linux: [] },
  eventSource: "hook",
  eventMap: {
    sessionStart: "idle",
    sessionEnd: "sleeping",
    beforeSubmitPrompt: "thinking",
    preToolUse: "working",
    postToolUse: "working",
    postToolUseFailure: "working",
    stop: "attention",
    subagentStart: "juggling",
    subagentStop: "working",
    preCompact: "sweeping",
    afterAgentThought: "thinking",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "cursor-hooks-json",
  },
  stdinFormat: "cursorHookJson",
  pidField: "cursor_pid",
};
