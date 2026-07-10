// QoderWork agent configuration
// Hook-only integration via ~/.qoderwork/settings.json (Phase 1: state-only).
//
// QoderWork is a standalone Electron IDE (separate from Qoder IDE / Qoder CLI)
// that shares the `qodercli` backend binary. Because `qodercli` is ambiguous
// (both Qoder IDE and QoderWork spawn it), processNames only lists the IDE
// process name `QoderWork` so startup recovery never confuses the two.
//
// Clawd observes QoderWork's permission events (PermissionRequest /
// PermissionDenied) as passive `working` state (they fire 40+ times per task
// as part of normal tool flow) but NEVER answers QoderWork permission
// decisions — the hook always returns `{}` so QoderWork's native permission
// flow stays in control.
// See docs/project/agent-runtime-architecture.md.

module.exports = {
  id: "qoderwork",
  name: "QoderWork",
  // QoderWork is a standalone Electron IDE. Its backend CLI `qodercli` is
  // shared with Qoder IDE, so we deliberately exclude it from processNames
  // to avoid mis-attributing a Qoder-IDE-spawned qodercli to QoderWork.
  // Startup recovery (src/state.js) only watches the IDE process name.
  processNames: {
    win: ["QoderWork.exe"],
    mac: ["QoderWork"],
    linux: ["QoderWork"],
  },
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
    interactiveBubble: false,
    notificationHook: true,
    sessionEnd: true,
    subagent: false,
  },
  hookConfig: {
    configFormat: "qoderwork-settings-json",
  },
  stdinFormat: "qoderworkHookJson",
  pidField: "source_pid",
};
