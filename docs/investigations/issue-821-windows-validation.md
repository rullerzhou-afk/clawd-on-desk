# Issue #821 Windows validation evidence

Date: 2026-08-09

Host: Microsoft Windows NT 10.0.26200.0, AMD64

Producer: Codex CLI 0.147.0 (`originator=codex-tui`, `source=cli`)

This record is intentionally privacy-safe. It retains only time, source,
event type, a SHA-256 prefix for the canonical session, and a SHA-256 prefix
for the normalized opaque turn ID. Prompt text, assistant output, tool input,
commands, and raw rollout lines are excluded.

This is a real cross-channel Codex CLI capture. It validates the Draft v4
Part A identity preflight, but it is **not** a ChatGPT Desktop or reporter-side
reproduction of Issue #821.

## Cross-channel identity capture

Canonical session digest: `2e27af1e370fe2d2`

```text
2026-08-08T23:04:13.998Z sid=2e27af1e370fe2d2 source=jsonl    event=event_msg:task_started  turn=d4fe677e03ae2427
2026-08-08T23:04:14.336Z sid=2e27af1e370fe2d2 source=official event=UserPromptSubmit        turn=d4fe677e03ae2427
2026-08-08T23:32:25.008Z sid=2e27af1e370fe2d2 source=official event=Stop                    turn=d4fe677e03ae2427
2026-08-08T23:32:25.083Z sid=2e27af1e370fe2d2 source=jsonl    event=event_msg:task_complete turn=d4fe677e03ae2427
```

Result: the normalized official and JSONL IDs are present and equal at both
the start and terminal boundaries. The Part A single-ID fence preflight passes
for this current CLI producer.

## Local verification matrix

| Draft v4 case | Result | Evidence / limitation |
|---|---|---|
| Tool-using turn completes normally | Pass (CLI) | The captured turn completed naturally; official `Stop` and JSONL `task_complete` matched. |
| Stop during an active tool | Not run | A manual terminal injection followed by a real late tool event tested the fence, but does not count as a real user stop. |
| Stop during model streaming without a tool | Not run | Requires an interactive Desktop/CLI smoke. |
| Immediately start a new turn in the same thread | Pass (CLI) | The next real `UserPromptSubmit` reopened the same canonical session and admitted work immediately. |
| Keep a completed Desktop thread focused through token refresh | Not run | Automated composition covers liveness separation; the required 20-minute Desktop observation remains outstanding. |
| Run two Desktop threads and stop only one | Not run | Requires an interactive Desktop smoke. |
| Restart while active; repeat for terminal/stuck state | Partial (CLI) | Active-rollout synthetic backfill was observed. The full active + terminal/stuck Desktop restart matrix remains outstanding. |

## Fence diagnostic probe

In an isolated local Clawd runtime, an official `Stop` boundary was injected
for the active captured turn. A real official `PostToolUse` for the same turn
arrived 321 ms later and was rejected with `reason=closed-turn-id`. The next
real turn reopened the same session. This proves the late-tail fence path but
is not represented as a real user-stop result in the matrix above.

## Closure status

The Issue #821 reporter has not yet supplied their OS, Codex/ChatGPT Desktop
version, or a confirmation run. The PR must therefore reference the issue
without auto-closing it until the reporter platform smoke in Draft v4 section
10.2 is complete.
