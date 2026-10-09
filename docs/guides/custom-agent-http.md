# Custom HTTP Agent Integration

[Back to the setup guide](setup-guide.md)

Clawd can register a local application as a custom HTTP agent. Registration gives the application a stable `agent_id`, a display name, and an enable switch. It does **not** install a hook, inject code, watch the process, or make an arbitrary executable report activity automatically. The application (or a small adapter you control) must send state events to Clawd.

Custom HTTP agents are state-only in v1. They can drive animations and create sessions in the Dashboard, but they cannot use Clawd's permission approval protocol. Keep Allow/Deny decisions in the application's native UI.

## 1. Register the application

Open **Settings → Agents**, add a discovery path, scan it, and select **Register** for the candidate. A candidate only means Clawd found a launchable executable; it is not proof that the application is an AI tool or that it already implements this HTTP contract.

After registration, copy these values from the custom agent card:

- **Agent ID** — a stable ID such as `custom-nova-ai-0123456789ab`;
- **State endpoint** — the current local `/state` URL;
- **Minimum JSON payload** — a ready-to-adapt request body.

The card remains under **Detected locally** while its saved executable exists. Removing a discovery path only removes that scan source; it does not remove the registration. Use **Remove** on the agent card to delete the registration.

## 2. Discover the runtime port

Clawd binds only to `127.0.0.1` and chooses the first available port in `23333–23337`. Do not hard-code `23333`. While Clawd is running it writes:

```text
~/.clawd/runtime.json
```

The relevant shape is:

```json
{
  "app": "clawd-on-desk",
  "port": 23334
}
```

Read the file for every new sender process, verify `app === "clawd-on-desk"`, and use its `port`. The port may change after Clawd restarts. If the file is absent, malformed, or the connection is refused, treat Clawd as offline and continue the agent's normal work without blocking.

## 3. POST a state event

Send JSON to `http://127.0.0.1:<runtime-port>/state` with `Content-Type: application/json`.

The local hook endpoint is for native adapters, not browser pages. Each request
must use a literal loopback authority (`127.0.0.1`, `localhost`, or `[::1]`,
with an optional valid port), omit the `Origin` header, and contain exactly one
`Host` header and one `Content-Type` header whose media type is
`application/json`. A charset parameter is allowed. Clawd rejects an unsafe or
ambiguous transport before reading the JSON body, so do not route this endpoint
through a browser fetch, hostname alias, or proxy that adds `Origin` or duplicate
authority/media-type headers.

Minimum payload:

```json
{
  "agent_id": "custom-nova-ai-0123456789ab",
  "session_id": "project-a",
  "state": "working",
  "event": "PreToolUse"
}
```

The four fields should be strings. `agent_id` must exactly match a currently registered custom agent. Use a stable `session_id` for one conversation or task so subsequent events update the same Dashboard session. Clawd namespaces this value internally with the registered `agent_id`, so separate custom applications may safely reuse values such as `default` or `project-a`.

Common state/event pairs are:

| Situation | `state` | Suggested `event` |
|---|---|---|
| Session started or waiting | `idle` | `SessionStart` |
| User submitted a prompt | `thinking` | `UserPromptSubmit` |
| Tool or model work is running | `working` | `PreToolUse` / `PostToolUse` |
| Parallel/subagent work | `juggling` | `SubagentStart` |
| Work failed | `error` | `PostToolUseFailure` |
| Turn completed | `attention` | `Stop` |
| Informational alert | `notification` | `Notification` |
| Session ended | `idle` | `SessionEnd` |

The active theme must provide the requested state. Unknown states return HTTP 400. `SessionEnd` removes the session rather than leaving an idle card.

Useful optional fields:

| Field | Type | Purpose |
|---|---|---|
| `cwd` | string | Project directory shown in session UI |
| `tool_name` | string | Current tool name |
| `tool_use_id` | string | Correlates tool lifecycle events |
| `source_pid` | positive integer | Local terminal/process focus metadata |
| `agent_pid` | positive integer | Agent process identity |
| `pid_chain` | positive integer[] | Process ancestry metadata |
| `platform` | string | Runtime surface, for example `webui` |
| `editor` | `code` or `cursor` | Editor focus hint |
| `headless` | boolean | Excludes a background session from HUD/focus UI |

The request body limit is 16 KiB. Do not send secrets, full prompts, arbitrary tool input, or files; custom integration needs lifecycle metadata, not conversation content.

## 4. Platform examples

Replace the sample `agent_id` with the value shown in Settings.

### Windows PowerShell

```powershell
$runtime = Get-Content -Raw (Join-Path $HOME ".clawd\runtime.json") | ConvertFrom-Json
if ($runtime.app -ne "clawd-on-desk") { throw "Clawd runtime identity mismatch" }
$payload = @{
  agent_id = "custom-nova-ai-0123456789ab"
  session_id = "project-a"
  state = "working"
  event = "PreToolUse"
} | ConvertTo-Json -Compress
Invoke-WebRequest -Method Post -ContentType "application/json" `
  -Uri "http://127.0.0.1:$($runtime.port)/state" -Body $payload
```

### macOS shell

```bash
PORT="$(node -p 'const r=require(process.env.HOME+"/.clawd/runtime.json"); if(r.app!=="clawd-on-desk") throw Error("identity mismatch"); r.port')"
curl --fail-with-body -X POST "http://127.0.0.1:${PORT}/state" \
  -H 'content-type: application/json' \
  -d '{"agent_id":"custom-nova-ai-0123456789ab","session_id":"project-a","state":"working","event":"PreToolUse"}'
```

### Linux shell

```bash
PORT="$(python3 -c 'import json, pathlib; r=json.loads((pathlib.Path.home()/".clawd/runtime.json").read_text()); assert r.get("app")=="clawd-on-desk"; print(r["port"])')"
curl --fail-with-body -X POST "http://127.0.0.1:${PORT}/state" \
  -H 'content-type: application/json' \
  -d '{"agent_id":"custom-nova-ai-0123456789ab","session_id":"project-a","state":"working","event":"PreToolUse"}'
```

## 5. Responses and gates

- **200 `ok`** — the state payload was valid and passed the agent gate. During Do Not Disturb, Clawd can still return success while suppressing the visible reaction; do not treat HTTP 200 as proof that an animation was shown.
- **204 No Content** — the custom agent is disabled, its registration was removed/does not exist, or the request used an unsupported custom route. No new state session is created for a disabled or rejected custom ID.
- **400** — malformed JSON, an unknown state, an invalid state-specific payload, or duplicate `Host` / `Content-Type` headers.
- **403** — the request included `Origin` or used a non-loopback/invalid `Host` authority.
- **415** — `Content-Type` was missing or its media type was not `application/json`.
- **413** — the JSON body exceeded 16 KiB.
- **Connection failure** — Clawd is not running or the runtime file is stale. The sender should fail open and continue its own workflow.

Recent accepted state activity is shown on the custom agent card for the current Clawd run and is available to Doctor. It is intentionally in memory only and resets when Clawd restarts.

## 6. Permission boundary

Do not POST custom agent requests to `/permission`. Registered custom agents receive HTTP 204 with no approval decision, and removed or forged custom IDs are rejected the same way. Clawd never returns Claude Code's `hookSpecificOutput` protocol for custom agents.

This boundary is deliberate: a generic state event is portable, but permission schemas and blocking response contracts differ between tools. A custom application must keep permission prompts and decisions in its own native workflow.
