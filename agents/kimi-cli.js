// Kimi CLI agent configuration
// Uses log polling on ~/.kimi/logs/kimi.log — zero configuration needed

module.exports = {
  id: "kimi-cli",
  name: "Kimi CLI",
  processNames: { mac: ["Kimi Code"], linux: ["kimi"], win: ["kimi.exe"] },
  eventSource: "log-poll",
  // Log line pattern → pet state mapping (resolved by KimiLogMonitor)
  logEventMap: {
    session_start: "idle",
    user_input: "thinking",
    llm_step: "working",
    tool_shell: "working",
    tool_agent: "juggling",
    tool_ask_user: "attention",
    tool_web_search: "working",
    tool_fetch_url: "working",
    tool_read_file: "working",
    tool_write_file: "working",
    tool_str_replace_file: "working",
    tool_grep: "working",
    tool_glob: "working",
    tool_todo: "working",
    tool_set_todo_list: "working",
    tool_exit_plan_mode: "working",
    tool_enter_plan_mode: "working",
    tool_search_web: "working",
    turn_end: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    interactiveBubble: false,
    sessionEnd: true,
    subagent: true,
  },
  logConfig: {
    logDir: "~/.kimi/logs",
    filePattern: "kimi*.log",
    pollIntervalMs: 500,
    // How long to wait after the last LLM step before declaring turn end
    turnEndDeferMs: 800,
    // How long before a tracked file is considered stale
    staleTimeoutMs: 300000,
  },
  pidField: "kimi_pid",
};
