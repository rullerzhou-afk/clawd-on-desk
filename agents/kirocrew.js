// KiroCrew agent configuration
// KiroCrew is the autonomous agent gateway/dashboard layer built on top of Kiro.
// Unlike `kiro-cli` (interactive terminal, hooks via ~/.kiro/agents/*.json),
// KiroCrew runs agents through a background MCP gateway and fires its own
// chat-lifecycle hooks stored in ~/.kiro/crew/hooks.json. Those hooks are the
// integration point this adapter uses.
// Docs: KiroCrew "Steering files, prompts and hooks" (chat lifecycle hooks).

module.exports = {
  id: "kirocrew",
  name: "KiroCrew",
  // The gateway is a long-lived background service, not a per-session CLI
  // process in the pet's PID tree. Process-name detection cannot attribute pet
  // state to it, so state is driven entirely by the hook bridge (host-tagged,
  // like a remote source) rather than by PID resolution.
  processNames: { win: [], mac: [], linux: [] },
  eventSource: "hook",
  // PascalCase event names — matches KiroCrew's chat lifecycle hook system.
  eventMap: {
    AgentSpawn: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    Stop: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    // The gateway has an explicit end-of-turn event (Stop) but no distinct
    // session-end lifecycle moment exposed to hooks, so sessionEnd stays false.
    sessionEnd: false,
    // KiroCrew spawns background subagents, but their lifecycle is not surfaced
    // to the five gateway hook events, so the pet cannot react to them yet.
    subagent: false,
  },
  hookConfig: {
    configFormat: "kirocrew-hooks-json",
  },
  // KiroCrew hook-event JSON uses PascalCase event names on stdin and in
  // $KIROCREW_HOOK_EVENT.
  stdinFormat: "PascalCase",
  // No per-session PID is attributable to the background gateway.
  pidField: null,
};
