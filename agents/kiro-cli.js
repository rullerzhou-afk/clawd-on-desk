// Kiro CLI agent configuration
// Hooks via ~/.kiro/agents/clawd.json, stdin JSON + exit code gating
// Docs: https://kiro.dev/docs/cli/hooks/

module.exports = {
  id: "kiro-cli",
  name: "Kiro CLI",
  // mac/linux keep legacy "kiro" alongside the real "kiro-cli" until a mac user confirms.
  processNames: { win: ["kiro-cli.exe"], mac: ["kiro-cli", "kiro"], linux: ["kiro-cli", "kiro"] },
  eventSource: "hook",
  // camelCase event names — matches Kiro CLI hook system
  eventMap: {
    agentSpawn: "idle",
    userPromptSubmit: "thinking",
    preToolUse: "working",
    postToolUse: "working",
    stop: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    sessionEnd: false,
    subagent: false,
  },
  hookConfig: {
    configFormat: "kiro-agent-json",
  },
  stdinFormat: "camelCase",
  pidField: "kiro_pid",
};
