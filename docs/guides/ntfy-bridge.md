# ntfy Bridge for Remote Agents

[Back to the custom HTTP agent guide](custom-agent-http.md)

Agents running on a server or remote desktop cannot reach Clawd's loopback `/state` endpoint. If they can publish to [ntfy](https://ntfy.sh), `scripts/ntfy-bridge.js` closes the gap: it runs on the machine where Clawd runs, subscribes to a topic, and forwards lifecycle messages to a registered [custom HTTP agent](custom-agent-http.md).

The bridge is **state-only**. Allow/Deny decisions cannot be made through ntfy and stay in the agent's own UI.

## Setup

1. In **Settings → Agents**, register a custom agent and copy its Agent ID.
2. Run the bridge next to Clawd (Node 18+, no dependencies):

```bash
node scripts/ntfy-bridge.js --topic my-agents --agent-id custom-nova-ai-0123456789ab
```

Options: `--server <url>` (default `https://ntfy.sh`, also `NTFY_SERVER`), `--topic` (`NTFY_TOPIC`), `--agent-id` (`CLAWD_AGENT_ID`). For protected topics set `NTFY_TOKEN`; it is sent as a Bearer token and never logged.

## Sender side

Publish with tags. The `clawd-<state>` tag is required; other messages on the topic are ignored.

```bash
curl -H "Tags: clawd-working,clawd-session-build42" -d "tool running" https://ntfy.sh/my-agents
curl -H "Tags: clawd-attention,clawd-session-build42,clawd-event-Stop" -d "done" https://ntfy.sh/my-agents
```

| Tag | Meaning |
|---|---|
| `clawd-idle` / `thinking` / `working` / `juggling` / `error` / `attention` / `notification` | Required. The state to show. |
| `clawd-session-<id>` | Optional. Groups events into one session (default: the topic name). |
| `clawd-event-<Event>` | Optional. Overrides the default event name for that state. |

`<id>` and `<Event>` accept only letters, digits, `.`, `_` and `-`. The message body is never forwarded to Clawd, so do not put secrets or prompts in tags. Anyone who can publish to the topic can drive the pet, so use a hard-to-guess topic or an access-controlled one.

The bridge reconnects with backoff and resumes from the last message id. If Clawd is not running, events are dropped rather than queued.
