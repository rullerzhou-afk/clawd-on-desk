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

## Security

**Anyone who can publish to the topic can drive the pet.** ntfy topics on a public server have no authentication by default; the topic name is the only secret.

- Use an unguessable topic name, for example `clawd-$(openssl rand -hex 16)`, not `my-agents`.
- Prefer an access-controlled topic (self-hosted ntfy, or ntfy.sh with a reserved topic) and set `NTFY_TOKEN` on the bridge so it can subscribe. Give senders a token with write-only access.
- The bridge forwards state only, never permission decisions, so the worst a stranger can do is animate the pet.

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

`<id>` and `<Event>` accept only letters, digits, `.`, `_` and `-`. The message body is never forwarded to Clawd, so do not put secrets or prompts in tags.

The bridge reconnects with backoff and resumes from the last message id. If Clawd is not running, events are dropped rather than queued.
