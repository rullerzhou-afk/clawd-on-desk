// ZCode agent configuration
// ZCode is 智谱/Z.ai's Electron desktop ADE. Legacy builds spawned `zcode-cli`;
// current builds can run Resources/glm/zcode.cjs through Electron's Node mode.
// Both read ~/.zcode/cli/config.json. Config-file hooks nest under
// `hooks.events.*` (NOT `hooks.*` like plugin hooks.json), require
// `hooks.enabled: true`, and treat missing / empty / "*" matchers as match-all.
// ZCode supports exactly 7 events: SessionStart, UserPromptSubmit, PreToolUse,
// PermissionRequest, PostToolUse, PostToolUseFailure, Stop. It does NOT support
// SessionEnd or Notification.
// Phase 1: state-only hook integration (no PermissionRequest bubble).

module.exports = {
  id: "zcode",
  name: "ZCode",
  // The ZCode desktop app (Electron) spawns a per-session agent runtime. Keep
  // pure-name matching limited to the unambiguous legacy `zcode-cli`; current
  // Electron Node-mode sessions are identified jointly by executable name and
  // the `zcode.cjs` command-line token in hooks/zcode-hook.js and src/state.js.
  //
  // CROSS-PLATFORM NOTE:
  //   - macOS / Linux: the runtime is a standalone binary `zcode-cli` (one per
  //     live session) in legacy 3.4.x builds. Verified on macOS 3.4.2.
  //     The signed macOS 3.5.3 bundle instead ships `Resources/glm/zcode.cjs`;
  //     the name+cmdline resolver covers it without accepting the bare GUI.
  //   - Windows: per reviewer's audit of the 3.3.6 installer, the app reuses
  //     the Electron shell via `ZCode.exe resources/glm/zcode.cjs app-server
  //     --stdio` with ELECTRON_RUN_AS_NODE=1 — i.e. the working process is
  //     `ZCode.exe` with a distinctive cmdline, NOT a `zcode-cli.exe` binary.
  //     `zcode-cli.exe` below is a placeholder until a Windows smoke confirms
  //     the exact name; the hook adapter's cmdline check (`zcode.cjs`) is the
  //     authoritative Windows signal today.
  processNames: { win: ["zcode-cli.exe"], mac: ["zcode-cli"], linux: ["zcode-cli"] },
  // startupRecoveryProcessNames drives state.js's running-agent detection.
  //   - mac/linux: legacy `zcode-cli` participates directly. Current
  //     `zcode.cjs` runtimes use state.js's command-line marker fallback; the
  //     ambiguous GUI executable is intentionally absent from this name list.
  //   - win: the Windows runtime is the desktop shell `ZCode.exe` reused to run
  //     `... zcode.cjs app-server` (ELECTRON_RUN_AS_NODE=1). The bare name is
  //     ambiguous (the always-running shell would be mis-credited), so win
  //     uses the `(Name='ZCode.exe' AND CommandLine LIKE '%zcode.cjs%')` joint
  //     form declared separately in state.js's commandLineNeedles — NOT this
  //     name list. Leaving win:[] here keeps the shell out of the pure-name
  //     scan while the joint clause catches the real working process.
  startupRecoveryProcessNames: { win: [], mac: ["zcode-cli"], linux: ["zcode-cli"] },
  eventSource: "hook",
  // ZCode has no SessionEnd event; session completion relies on Stop + the
  // app's auto-fallback timeout. PostToolUseFailure maps to `error` (a tool
  // failed), matching the authoritative state-mapping table and Qoder.
  eventMap: {
    SessionStart: "idle",
    UserPromptSubmit: "thinking",
    PreToolUse: "working",
    PostToolUse: "working",
    PostToolUseFailure: "error",
    Stop: "attention",
  },
  capabilities: {
    httpHook: false,
    permissionApproval: false,
    mobilePermissionObservation: false,
    notificationHook: false,
    interactiveBubble: false,
    sessionEnd: false,
    subagent: false,
  },
  hookConfig: {
    configFormat: "zcode-config-json",
  },
  stdinFormat: "qwenHookJson",
};
