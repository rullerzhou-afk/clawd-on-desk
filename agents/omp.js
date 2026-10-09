// OMP (oh-my-pi) agent configuration
// Perception via OMP extension: lifecycle event hook -> HTTP POST to Clawd.
// OMP keeps its own execution model; Clawd is state-only here and must not add
// a permission layer on top of it.

module.exports = {
  id: "omp",
  name: "OMP",
  processNames: { win: ["omp.exe"], mac: ["omp"], linux: ["omp"] },
  // A bare `omp` process name is ambiguous on POSIX; package-path matching in
  // state.js covers the known CLI distribution there.
  startupRecoveryProcessNames: { win: ["omp.exe"], mac: [], linux: [] },
  eventSource: "extension",
  // Clawd-internal event names. hooks/omp-extension-core.js translates OMP's
  // native snake_case events to this shared PascalCase event vocabulary.
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    PreCompact: "sweeping",
    PostCompact: "attention",
    SessionEnd: "sleeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    notificationHook: false,
    interactiveBubble: false,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "omp-extension",
  },
};
