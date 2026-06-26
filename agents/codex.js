// Codex CLI agent configuration
// Official hooks are primary for lifecycle state; JSONL polling remains as
// fallback and for events official hooks do not cover yet.

module.exports = {
  id: "codex",
  name: "Codex CLI",
  processNames: { win: ["codex.exe"], mac: ["codex"], linux: ["codex"] },
  eventSource: "hook+log-poll",
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PermissionRequest: "notification",
    PostToolUse: "working",
    Stop: "codex-turn-end",
  },
  // JSONL record type:subtype → pet state mapping. The remote monitor keeps
  // a zero-dep subset of this table; update both paths when adding shared
  // Codex JSONL events.
  logEventMap: {
    "session_meta": "idle",
    "event_msg:task_started": "thinking",
    "event_msg:user_message": "thinking",
    "event_msg:agent_message": null, // text output only — working is reserved for function_call
    "event_msg:guardian_assessment": "working", // Codex Desktop auto-review/approval is active work, not terminal idle
    "event_msg:exec_command_end": "working",
    "event_msg:patch_apply_end": "working",
    "event_msg:custom_tool_call_output": "working",
    "response_item:function_call": "working",
    "response_item:custom_tool_call": "working",
    "response_item:web_search_call": "working",
    "event_msg:task_complete": "codex-turn-end", // resolved by monitor: attention if tools/assistant output happened, idle otherwise
    "event_msg:context_compacted": "sweeping",
    "event_msg:turn_aborted": "idle",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: true,
    // Official PermissionRequest is a real approval path. JSONL fallback still
    // keeps interactiveBubble=true for older/no-hook sessions.
    interactiveBubble: true,
    sessionEnd: false, // no SessionEnd event; task_complete marks the turn done, process exit clears the session
    subagent: false,
  },
  logConfig: {
    sessionDir: "~/.codex/sessions",
    filePattern: "rollout-*.jsonl",
    pollIntervalMs: 1500,
  },
  hookConfig: {
    configFormat: "codex-hooks-json",
  },
  stdinFormat: "codexHookJson",
  pidField: "codex_pid",
};
