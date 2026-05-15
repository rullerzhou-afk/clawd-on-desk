# Copilot CLI Hook Setup

## Local install (manual)

Create `~/.copilot/hooks/hooks.json` with the following content. Replace `/path/to/clawd-on-desk` with your actual install path.

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js sessionStart", "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js sessionStart", "timeoutSec": 5 }],
    "userPromptSubmitted": [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js userPromptSubmitted", "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js userPromptSubmitted", "timeoutSec": 5 }],
    "preToolUse": [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js preToolUse", "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js preToolUse", "timeoutSec": 5 }],
    "postToolUse": [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js postToolUse", "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js postToolUse", "timeoutSec": 5 }],
    "sessionEnd": [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js sessionEnd", "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js sessionEnd", "timeoutSec": 5 }]
  }
}
```

## Remote SSH

When you deploy hooks to a remote host with `bash scripts/remote-deploy.sh user@host`, Copilot CLI hooks are now configured automatically — `copilot-hook.js` is copied to `~/.claude/hooks/` on the remote and `~/.copilot/hooks/hooks.json` is registered for you (alongside Claude Code and Codex CLI hooks). No manual step required.

If Copilot CLI is not installed on the remote (`~/.copilot/` missing), the registration step is skipped with a warning and the rest of the deploy continues normally.

## Session rename

Copilot CLI stores the current session name in `~/.copilot/session-state/<sessionId>/workspace.yaml` (`name:` field). The hook reads that file on every event and forwards the name to Clawd as the session title, so `/rename` inside Copilot CLI propagates to the Session HUD and Dashboard on the next hook event (next user message, tool run, etc.). Auto-generated names (`user_named: false`) are used as-is, matching Codex thread-name behavior.
