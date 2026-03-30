// Codex CLI agent configuration
// Windows hooks completely disabled — uses JSONL log polling instead

module.exports = {
  id: "codex",
  name: "Codex CLI",
  processNames: { win: ["codex.exe"], mac: ["codex"], linux: ["codex"] },
  nodeCommandPatterns: [], // Rust native binary, not node
  eventSource: "log-poll",
  // JSONL record type:subtype → pet state mapping
  // ⚠️ Also duplicated in hooks/codex-remote-monitor.js (zero-dep requirement) — keep in sync
  logEventMap: {
    "session_meta": "idle",
    "event_msg:task_started": "thinking",
    "event_msg:user_message": "thinking",
    "event_msg:agent_message": null, // text output only — working is reserved for function_call
    "response_item:function_call": "working",
    "response_item:custom_tool_call": "working",
    "response_item:web_search_call": "working",
    "event_msg:task_complete": "codex-turn-end", // resolved by monitor: attention if tools were used, idle otherwise
    "event_msg:context_compacted": "sweeping",
    "event_msg:turn_aborted": "idle",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    sessionEnd: false, // no SessionEnd event, rely on task_complete + timeout
    subagent: false,
  },
  logConfig: {
    sessionDir: "~/.codex/sessions",
    filePattern: "rollout-*.jsonl",
    pollIntervalMs: 1500,
  },
  pidField: "codex_pid",
};
