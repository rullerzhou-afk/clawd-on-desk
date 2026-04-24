# State Mapping

[Back to README](../README.md)

Events from all agents (Claude Code hooks, Codex JSONL, Copilot hooks) map to the same animation states:

| Agent Event | State | Animation | Clawd | Calico |
|---|---|---|---|---|
| Idle (no activity) | idle | Eye-tracking follow | <img src="../assets/gif/clawd-idle.gif" width="160"> | <img src="../assets/gif/calico-idle.gif" width="130"> |
| Idle (random) | idle | Reading / patrol | <img src="../assets/gif/clawd-idle-reading.gif" width="160"> | |
| UserPromptSubmit | thinking | Thought bubble | <img src="../assets/gif/clawd-thinking.gif" width="160"> | <img src="../assets/gif/calico-thinking.gif" width="130"> |
| PreToolUse / PostToolUse | working (typing) | Typing | <img src="../assets/gif/clawd-typing.gif" width="160"> | <img src="../assets/gif/calico-typing.gif" width="130"> |
| PreToolUse (3+ sessions) | working (building) | Building | <img src="../assets/gif/clawd-building.gif" width="160"> | <img src="../assets/gif/calico-building.gif" width="130"> |
| SubagentStart (1) | juggling | Juggling | <img src="../assets/gif/clawd-juggling.gif" width="160"> | <img src="../assets/gif/calico-juggling.gif" width="130"> |
| SubagentStart (2+) | conducting | Conducting | <img src="../assets/gif/clawd-conducting.gif" width="160"> | <img src="../assets/gif/calico-conducting.gif" width="130"> |
| PostToolUseFailure | error | Error | <img src="../assets/gif/clawd-error.gif" width="160"> | <img src="../assets/gif/calico-error.gif" width="130"> |
| Stop / PostCompact | attention | Happy | <img src="../assets/gif/clawd-happy.gif" width="160"> | <img src="../assets/gif/calico-happy.gif" width="130"> |
| PermissionRequest | notification | Alert | <img src="../assets/gif/clawd-notification.gif" width="160"> | <img src="../assets/gif/calico-notification.gif" width="130"> |
| PreCompact | sweeping | Sweeping | <img src="../assets/gif/clawd-sweeping.gif" width="160"> | <img src="../assets/gif/calico-sweeping.gif" width="130"> |
| WorktreeCreate | carrying | Carrying | <img src="../assets/gif/clawd-carrying.gif" width="160"> | <img src="../assets/gif/calico-carrying.gif" width="130"> |
| 60s no events | sleeping | Sleep | <img src="../assets/gif/clawd-sleeping.gif" width="160"> | <img src="../assets/gif/calico-sleeping.gif" width="130"> |

## Kimi Code CLI (Kimi-CLI) Hook Events

Kimi Code CLI (Kimi-CLI) now uses hook-only integration (`~/.kimi/config.toml`), and maps these 13 hook events to shared Clawd states:

| Kimi Hook Event | State |
|---|---|
| SessionStart | idle |
| SessionEnd | sleeping |
| UserPromptSubmit | thinking |
| PreToolUse | working by default. Permission animation only flips when payload carries explicit approval signals (`permission_required` / `requires_approval` / `waiting_for_approval` / `is_permission_request`). Persistent mode switch: `CLAWD_KIMI_PERMISSION_MODE=explicit` (default — only explicit signals trigger notification) or `CLAWD_KIMI_PERMISSION_MODE=suspect` (deferred heuristic for gated tools). The installer (`npm run install:kimi-hooks` and the auto-sync at startup) bakes this value into the `command` field of `~/.kimi/config.toml` so it survives Clawd restarts. Other optional knobs: `CLAWD_KIMI_PERMISSION_IMMEDIATE=1` forces immediate remap for permission-gated tools; `CLAWD_KIMI_PERMISSION_SUSPECT=1` (legacy alias) enables deferred suspect mode for the current process only; `CLAWD_KIMI_PERMISSION_SUSPECT_MS=<ms>` tunes the suspect window; `CLAWD_KIMI_DISABLE_PRETOOL_PERMISSION=1` keeps explicit-only behavior even when optional modes are set. |
| PostToolUse | working |
| PostToolUseFailure | error |
| Stop | attention |
| StopFailure | error |
| SubagentStart | juggling |
| SubagentStop | working |
| PreCompact | sweeping |
| PostCompact | attention |
| Notification | notification |

## Mini Mode

Drag to the right screen edge (or right-click → "Mini Mode") to enter mini mode — half-body visible at screen edge, peeking out on hover.

| Trigger | Mini Reaction | Clawd | Calico |
|---|---|---|---|
| Default | Breathing + blinking + eye tracking | <img src="../assets/gif/clawd-mini-idle.gif" width="100"> | <img src="../assets/gif/calico-mini-idle.gif" width="80"> |
| Hover | Peek out + wave | <img src="../assets/gif/clawd-mini-peek.gif" width="100"> | <img src="../assets/gif/calico-mini-peek.gif" width="80"> |
| Notification | Alert pop | <img src="../assets/gif/clawd-mini-alert.gif" width="100"> | <img src="../assets/gif/calico-mini-alert.gif" width="80"> |
| Task complete | Happy celebration | <img src="../assets/gif/clawd-mini-happy.gif" width="100"> | <img src="../assets/gif/calico-mini-happy.gif" width="80"> |

## Click Reactions

Easter eggs — try double-clicking, rapid 4-clicks, or poking Clawd repeatedly to discover hidden reactions.
