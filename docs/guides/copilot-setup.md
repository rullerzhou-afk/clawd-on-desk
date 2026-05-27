# Copilot CLI Hook Setup

[Back to README](../../README.md) · [简体中文](copilot-setup.zh-CN.md)

> **Starting in v0.8.x, Clawd auto-syncs Copilot CLI hooks by default.** Enabling the Copilot CLI agent in Settings is enough — on launch, Clawd writes `copilot-hook.js` into `<COPILOT_HOME or ~/.copilot>/hooks/hooks.json` using marker-based merge that preserves your other hook entries.
>
> This document is kept as the **advanced / manual fallback**: useful for debugging, customizing the event subset, working offline, or testing Clawd's behavior.

## Auto-sync at a glance

- **Trigger**: Clawd launches *and* Copilot CLI is enabled in Settings.
- **Target file**: `<copilot-home>/hooks/hooks.json`, where `<copilot-home>` is `$COPILOT_HOME` (trimmed, non-empty) or `~/.copilot` if the env is unset.
- **Registered events (10)**: `sessionStart`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `sessionEnd`, `errorOccurred`, `agentStop`, `subagentStart`, `subagentStop`, `preCompact`.
- **Coverage**: only entries containing the `copilot-hook.js` marker are managed; your other entries and other `hooks/*.json` files are left untouched.
- **`disableAllHooks`**: if either `hooks.json` or `<copilot-home>/settings.json` has `disableAllHooks: true` at the top level, doctor surfaces a warning and suppresses the Fix button (so it does not overwrite your explicit intent). Clawd still writes its entries, but Copilot will not execute them.

## Manual configuration (fallback)

Create `<copilot-home>/hooks/hooks.json` and replace `/path/to/clawd-on-desk` with your actual install path:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart":         [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js sessionStart",         "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js sessionStart",         "timeoutSec": 5 }],
    "userPromptSubmitted":  [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js userPromptSubmitted",  "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js userPromptSubmitted",  "timeoutSec": 5 }],
    "preToolUse":           [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js preToolUse",           "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js preToolUse",           "timeoutSec": 5 }],
    "postToolUse":          [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js postToolUse",          "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js postToolUse",          "timeoutSec": 5 }],
    "sessionEnd":           [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js sessionEnd",           "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js sessionEnd",           "timeoutSec": 5 }],
    "errorOccurred":        [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js errorOccurred",        "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js errorOccurred",        "timeoutSec": 5 }],
    "agentStop":            [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js agentStop",            "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js agentStop",            "timeoutSec": 5 }],
    "subagentStart":        [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js subagentStart",        "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js subagentStart",        "timeoutSec": 5 }],
    "subagentStop":         [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js subagentStop",         "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js subagentStop",         "timeoutSec": 5 }],
    "preCompact":           [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js preCompact",           "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js preCompact",           "timeoutSec": 5 }]
  }
}
```

The `bash` / `powershell` fields are Copilot CLI's official per-platform dispatch mechanism (see the [Copilot Hooks Reference](https://docs.github.com/en/copilot/reference/hooks-configuration)). Copilot loads every `.json` file under `<copilot-home>/hooks/` and merges them, so you can freely name additional files (e.g. `clawd.json`, `my-team.json`). Clawd manages only `hooks.json`.

## `COPILOT_HOME` custom directory

Copilot CLI supports a `COPILOT_HOME` environment variable that redirects the entire config directory (see the [Config Directory Reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)). Clawd reads this env at launch:

- **Windows**: system-level environment variables are visible to Clawd automatically; user-level variables take effect after a restart.
- **macOS / Linux GUI launches**: Clawd.app launched by launchd / Finder **does not inherit** env vars from your shell's `.zshrc` / `.bashrc`. To make `COPILOT_HOME` visible to Clawd:
  - macOS: run `launchctl setenv COPILOT_HOME /your/path`, then restart Clawd.
  - Linux: set it in `~/.profile`, `/etc/environment`, or your desktop entry.
- **Runtime changes**: the descriptor caches the path doctor displays. Changing `COPILOT_HOME` requires restarting Clawd before doctor will show the new path. The actual hook sync reads the latest env at call time, so a stale doctor path can be misleading if you change the env without restart.

## Remote SSH

`scripts/remote-deploy.sh user@host` registers Copilot CLI hooks automatically: `copilot-hook.js` is copied to `~/.claude/hooks/` on the remote, and the remote `~/.copilot/hooks/hooks.json` is wired up alongside Claude Code and Codex CLI. No manual step required.

If Copilot CLI is not installed on the remote (`~/.copilot/` missing), the registration step is skipped with a warning and the rest of the deploy continues.

## Session rename

Copilot CLI stores the current session name in `<copilot-home>/session-state/<sessionId>/workspace.yaml` (`name:` field). `copilot-hook.js` reads that file on every event and forwards the name as the session title to Clawd, so a `/rename` inside Copilot CLI propagates to the Session HUD and Dashboard on the next hook event (next user prompt, tool run, etc.). The `COPILOT_HOME` env is honored by the session-state resolver too.

Auto-generated names (`user_named: false`) are used as-is, matching Codex thread-name behavior.
