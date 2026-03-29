## v0.5.5

### Codex CLI Permission Notification Bubbles

Codex CLI now shows informational bubbles when it executes shell commands, similar to Claude Code's permission system. The bubbles are non-blocking (auto-dismiss after 30s) and display the command being run. Bubbles are automatically cleared when the Codex turn ends.

### Plan Review Bubble

A new bubble appears when Claude Code exits Plan Mode, letting you approve the plan or jump to the terminal to review it — without switching windows.

### Elicitation Bubble

When Claude Code asks a question (AskUserQuestion / Elicitation), a "Needs Input" bubble now appears with a "Go to Terminal" button, so you don't miss prompts that need your attention.

### Linux Support (PR #38)

First-class Ubuntu/Linux support. Includes runtime fixes (scoping Windows-only FFI/HWND logic, GNOME dock visibility, XDG autostart), terminal focusing via wmctrl/xdotool, Linux agent process detection, AppImage + deb packaging, and a Linux CI build job.

### Remote SSH Agent Support (Issue #9)

Run Clawd on a remote server and sync state back to your local desktop pet. Includes a one-click `remote-deploy.sh` setup script for SSH environments.

### Auto-Recover Hooks Wiped by CC-Switch (Issue #37)

CC-Switch overwrites `~/.claude/settings.json` when switching providers, wiping all registered hooks. Clawd now watches the `~/.claude/` directory and automatically re-registers hooks within seconds when they disappear. Includes debounce (1s) and rate-limiting (5s) to avoid write conflicts.

### Large Permission Payload Support (Issue #36)

The `/permission` endpoint previously rejected payloads over 64KB, causing tools like Write (with large file content) to be auto-denied. The limit is now 512KB, and `tool_input` values are recursively truncated to 500-char previews before being sent to the bubble UI.

### Codex Animation State Resolution

Fixed chaotic animation flickering when Codex CLI turns end. The state machine now uses smart resolution: if tools were used during the turn, show the "happy" animation; otherwise, return to idle quietly.

### Bug Fixes

- Fixed duplicate permission bubbles caused by stale PermissionRequest command hooks coexisting with HTTP hooks
- Fixed permission bubbles disappearing too quickly on client disconnect (2s minimum display time)
- Fixed crash when rapidly toggling mini mode (#32)
- Fixed macOS fullscreen visibility for all windows (#33)
- Removed Reject button from plan review bubble (terminal only supports Approve)

### Refactoring

- Simplified context menu by moving settings to tray menu
- Deduplicated `reapplyMacVisibility` and `contextMenuOwner` setup
- Hoisted `truncateDeep` to module level with recursion depth guard

### Community

- [@wanghaichen1](https://github.com/wanghaichen1) — reported permission payload too large (#36) and VS Code/Cursor extension monitoring (#35)
- [@von-mon](https://github.com/von-mon) — reported CC-Switch hook wipe issue (#37)
- [@NeizhiTouhu](https://github.com/NeizhiTouhu) — full Linux support: runtime, packaging, and CI (PR #38)
