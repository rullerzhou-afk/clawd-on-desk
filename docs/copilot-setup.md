# Copilot CLI Hook Setup

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
