// CodeBuddy IDE/CLI agent configuration
// Hook-based integration — uses Claude Code-compatible hook format
// CodeBuddy v1.16.0+ supports 7 hook events via ~/.codebuddy/settings.json
// https://www.codebuddy.ai/docs/zh/cli/hooks

module.exports = {
  id: "codebuddy",
  name: "CodeBuddy",
  processNames: {
    win: ["CodeBuddy.exe", "codebuddy.exe"],
    mac: ["CodeBuddy"],
    linux: ["codebuddy", "CodeBuddy"],
  },
  nodeCommandPatterns: ["@tencent-ai/agent-sdk", "codebuddy"],
  eventSource: "hook",

  // Hook event → pet state mapping
  // CodeBuddy v1.16.0 supports 7 events (marked with ✓)
  // Additional events are mapped for forward compatibility (marked with ○)
  eventMap: {
    SessionStart:       "idle",         // ✓ 会话开始
    SessionEnd:         "sleeping",     // ✓ 会话结束
    UserPromptSubmit:   "thinking",     // ✓ 用户提交问题
    PreToolUse:         "working",      // ✓ 工具调用前
    PostToolUse:        "working",      // ✓ 工具调用后
    Stop:               "attention",    // ✓ Agent 停止
    PreCompact:         "sweeping",     // ✓ 上下文压缩前
    // Forward compatibility — not yet supported by CodeBuddy
    PostToolUseFailure: "error",        // ○ 工具调用失败
    StopFailure:        "error",        // ○ 停止异常
    SubagentStart:      "juggling",     // ○ 子代理启动
    SubagentStop:       "working",      // ○ 子代理结束
    PostCompact:        "attention",    // ○ 上下文压缩后
    Notification:       "notification", // ○ 系统通知
  },

  capabilities: {
    httpHook: true,
    permissionApproval: true,
    sessionEnd: true,
    subagent: false,  // not yet supported by CodeBuddy
  },
  hookConfig: {
    configFormat: "claude-code-compatible",  // same format as ~/.claude/settings.json
    settingsPath: "~/.codebuddy/settings.json",
  },
  pidField: "codebuddy_pid",
};
