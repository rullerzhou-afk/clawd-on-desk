# OpenClaw Bridge

Connects [OpenClaw](https://github.com/openclaw/openclaw) agent sessions to Clawd on Desk. The bridge watches session JSONL files for state changes and pushes them to the pet in real-time.

## Setup

```bash
# Same machine (agent + pet on one device)
node bridges/openclaw/bridge.js

# Remote (agent on server, pet on laptop via Tailscale/LAN)
PET_HOST=<pet-machine-ip> PET_TOKEN=<secret> node bridges/openclaw/bridge.js
```

## State Mapping

| Agent Event | Pet State | Animation |
|---|---|---|
| User sends message | `thinking` | Thought bubbles |
| Tool call (search, exec, etc.) | `working` | Typing on keyboard |
| Tool result returns | `working` | Still typing |
| Text reply complete | `attention` | Happy nod ✨ |
| Memory compaction | `sweeping` | Sweeping animation |
| No activity (2 min) | `idle` | Eye tracking cursor |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PET_HOST` | `127.0.0.1` | Pet server hostname/IP |
| `PET_TOKEN` | _(none)_ | Bearer token for remote auth |
| `SESSIONS_DIR` | `~/.openclaw/agents/main/sessions` | Session JSONL directory |

## Architecture

```
OpenClaw Agent          Bridge              Desktop Pet
┌────────────┐    ┌──────────────┐    ┌──────────────┐
│ Session     │    │ Watch JSONL  │    │ Electron app │
│ JSONL files │───→│ Map states   │───→│ HTTP :23333  │
│             │    │ POST /state  │    │ SVG + CSS    │
└────────────┘    └──────────────┘    └──────────────┘
```

The bridge polls the most recently modified `.jsonl` file in the sessions directory every 500ms, reads new lines, and maps entry types to pet animation states.
