# Known Limitations

[Back to README](../README.md)

| Limitation | Details |
|---|---|
| **Codex CLI: no terminal focus** | Codex sessions use JSONL log polling which doesn't carry terminal PID info. Clicking Clawd won't jump to the Codex terminal. Claude Code and Copilot CLI work fine. |
| **Codex CLI: Windows hooks disabled** | Codex hardcodes hooks off on Windows, so we poll log files instead. This means ~1.5s latency vs near-instant for hook-based agents. |
| **Copilot CLI: manual hook setup** | Copilot is the one supported agent that still requires manually creating `~/.copilot/hooks/hooks.json`. |
| **Copilot CLI: no permission bubble** | Copilot's `preToolUse` hook only supports deny, not the full allow/deny flow. Permission bubbles currently work with Claude Code, CodeBuddy, and opencode. |
| **Gemini CLI: no working state** | Gemini's session JSON only records completed messages, not in-progress tool execution. The pet jumps from thinking straight to happy/error — no typing animation during work. |
| **Gemini CLI: no permission bubble** | Gemini handles tool approval inside the terminal. File polling can't intercept or display approval requests. |
| **Gemini CLI: no terminal focus** | Session JSON doesn't carry terminal PID info, same limitation as Codex. |
| **Gemini CLI: polling latency** | ~1.5s poll interval + 4s defer window for batching tool completion signals. Noticeably slower than hook-based agents. |
| **Cursor Agent: no permission bubble** | Cursor handles permissions via stdout JSON in the hook, not HTTP blocking — Clawd can't intercept the approval flow. |
| **Cursor Agent: startup recovery** | No process detection on startup (matching the editor PID would false-trigger on any Cursor instance). Clawd stays idle until the first hook event fires. |
| **Kiro CLI: no session tracking** | Kiro CLI stdin JSON has no session_id — all Kiro sessions are merged into a single tracked session. |
| **Kiro CLI: no SessionEnd** | Kiro CLI has no session end event, so Clawd can't detect when a Kiro session ends. |
| **Kiro CLI: no subagent detection** | Kiro CLI has no subagent events, so juggling/conducting animations won't trigger. |
| **Kiro CLI: terminal permission prompts stay in terminal** | Kiro state hooks are verified on macOS and Windows, but when Kiro shows native terminal permission prompts such as `t / y / n`, those still need to be handled in the terminal. Clawd does not currently replace that flow. |
| **Kimi Code CLI (Kimi-CLI): hook-only runtime path** | Kimi in Clawd is hook-only (`~/.kimi/config.toml`). If a future Kimi release breaks hook delivery, recover by reverting to the historical log-poll implementation from commit `e57679a` (the current `agents/kimi-log-monitor.js` is a compatibility stub). |
| **Kimi Code CLI (Kimi-CLI): `[[hooks]]` blocks referencing `kimi-hook.js` are owned by Clawd** | Clawd auto-syncs Kimi hooks on every startup (and from `npm run install:kimi-hooks`). Any `[[hooks]]` block whose `command` references `kimi-hook.js` is treated as Clawd-owned: all such blocks are removed and rewritten as the canonical 13 events (including any `CLAWD_KIMI_PERMISSION_MODE=…` prefix, which is carried over from a prior install when no env var is passed). Non-hook sections in `config.toml` (e.g. `[server]`, `[mcp]`, `[[tools]]`) and any `[[hooks]]` block you wrote yourself without referencing `kimi-hook.js` are left untouched. Change permission-mode behavior via env vars (e.g. `CLAWD_KIMI_PERMISSION_MODE`) before re-running the installer instead of hand-editing the `command` field. |
| **opencode: subtask menu clutter** | When opencode delegates to parallel subagents via the `task` tool, the subagent sessions briefly appear in the Sessions submenu while they run (5-8 seconds), then self-clean. Cosmetic only — the building animation fires correctly. |
| **opencode: terminal focus limited to spawning terminal** | The plugin runs in-process with opencode, so `source_pid` points to the terminal that launched opencode. If you use `opencode attach` from a different window, terminal focus jumps to the original launcher. |
| **macOS/Linux packaged auto-update** | DMG/AppImage/deb installs cannot auto-update — use `git clone` + `npm start` for auto-update via `git pull`, or download new versions manually from GitHub Releases. |
| **No test framework for Electron** | Unit tests cover agents and log polling, but the Electron main process (state machine, windows, tray) has no automated tests. |
| **Claude Code: tools rejected when Clawd is offline** | When Clawd's HTTP server isn't running, the `PermissionRequest` hook (registered by Clawd) fails with `ECONNREFUSED`, and Claude Code currently denies the tool call instead of falling through to its built-in prompt — affecting `Edit`, `Write`, `Bash`, etc. This contradicts CC's documented non-blocking behavior for HTTP hook failures — see [anthropics/claude-code#46193](https://github.com/anthropics/claude-code/issues/46193). Workaround: keep Clawd running (recommended), or temporarily rename the `PermissionRequest` key in `~/.claude/settings.json` to disable the hook. |
