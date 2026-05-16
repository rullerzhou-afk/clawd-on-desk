// Nano Agent configuration
// Hook-based integration via nano-agent's pkg/hookservice.
// Hooks are registered under `security.hooks` in ~/.config/nano/config.yaml
// and receive event/payload via NANO_HOOK_INPUT env (JSON), with NANO_TOOL_NAME
// and NANO_TOOL_INPUT as legacy env vars. Event names are snake_case (e.g.
// `pre_tool_use`); we normalize to PascalCase before reporting state.
// Docs: nano-agent/docs/features/HOOKS.md

module.exports = {
  id: "nano-agent",
  name: "Nano Agent",
  processNames: { win: ["nano.exe"], mac: ["nano"], linux: ["nano"] },
  eventSource: "hook",
  // PascalCase event names — normalized from nano-agent's snake_case events
  // by hooks/nano-agent-hook.js before posting to /state.
  eventMap: {
    SessionStart:       "idle",
    SessionEnd:         "sleeping",
    UserPromptSubmit:   "thinking",
    PreToolUse:         "working",
    PostToolUse:        "working",
    PostToolUseFailure: "error",
    Stop:               "attention",
    StopFailure:        "error",
    SubagentStart:      "juggling",
    SubagentStop:       "working",
    PreCompact:         "sweeping",
    PostCompact:        "attention",
    Notification:       "notification",
    PermissionRequest:  "notification",
  },
  capabilities: {
    httpHook: true,            // nano-agent hookservice supports type:http
    permissionApproval: true,  // permission_request flows through HTTP hook
    notificationHook: true,
    sessionEnd: true,
    subagent: true,
  },
  hookConfig: {
    configFormat: "nano-yaml",
  },
  stdinFormat: "nanoHookEnv",
  pidField: "nano_pid",
};
