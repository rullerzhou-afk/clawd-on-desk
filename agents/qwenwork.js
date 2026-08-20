// QwenWork (千问办公) agent configuration
// Hook-only integration via ~/.QwenWorkCN/settings.json (Phase 1: state-only).
//
// QwenWork is a standalone desktop AI agent with its own hooks system.
// The process name on macOS is "千问办公" (Chinese); on Windows it is
// "QwenWorkCN.exe".
//
// Clawd observes QwenWork's lifecycle events as passive state changes only —
// the hook always returns `{}` so QwenWork's native permission flow stays in
// control.
// See docs/project/agent-runtime-architecture.md.

module.exports = {
  id: "qwenwork",
  name: "QwenWork",
  category: "work",
  // QwenWork is a standalone desktop app. The Windows executable is QwenWorkCN.exe
  // (process name "QwenWorkCN"). On macOS the executable basename is "QwenWorkCN"
  // (from QwenWorkCN.app/Contents/MacOS/QwenWorkCN, what `ps -o comm=` returns);
  // "千问办公" is the app display name, listed as a fallback.
  //
  // Linux is intentionally EMPTY: https://qwenwork.cn/download ships macOS 14+,
  // Windows 10+ and HarmonyOS 6.1+ only — there is no Linux client, and this
  // PR's own verification covered macOS and Windows. A speculative Linux
  // process name would also make `src/wsl-deploy.js` look like a supported
  // pairing target (see the negative contract in test/wsl-deploy.test.js).
  // Restore it only alongside a real install package + process name + config
  // dir + hook runner + Pair/Unpair + stdout + /state matrix.
  processNames: {
    win: ["QwenWorkCN.exe"],
    mac: ["QwenWorkCN", "千问办公"],
    linux: [],
  },
  // The long-lived IDE process is not an active-turn signal.
  startupRecoveryProcessNames: { win: [], mac: [], linux: [] },
  eventSource: "hook",
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
    Notification: "notification",
    // Phase 1 state-only: mapped to "working" (not "notification") to avoid
    // animation spam — these fire 40+ times per task as part of normal tool use.
    PermissionRequest: "working",
    PermissionDenied: "working",
    SessionEnd: "sleeping",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    mobilePermissionObservation: false,
    interactiveBubble: false,
    notificationHook: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "qwenwork-settings-json",
  },
  stdinFormat: "qwenworkHookJson",
  pidField: "source_pid",
};
