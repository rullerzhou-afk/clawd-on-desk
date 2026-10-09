# Codex Subagent Session Metadata

Date: 2026-05-01

## Local Samples

Read from `C:\Users\Ruller\.codex\sessions\2026\05\01\*.jsonl`.

Root session first-line shape:

```json
{
  "type": "session_meta",
  "payload": {
    "source": "cli",
    "originator": "codex-tui",
    "cli_version": "0.128.0"
  }
}
```

Subagent session sample:

```json
{
  "type": "session_meta",
  "payload": {
    "source": {
      "subagent": {
        "thread_spawn": {
          "parent_thread_id": "019de173-e4a3-72a1-9da3-a28fcb3e43e0",
          "depth": 1,
          "agent_path": null,
          "agent_nickname": "Newton",
          "agent_role": "explorer"
        }
      }
    },
    "agent_role": "explorer",
    "agent_nickname": "Newton",
    "originator": "codex-tui"
  }
}
```

The subagent sample was `rollout-2026-05-01T12-16-50-019de1c0-ed8e-73b0-992d-10972022b4ca.jsonl`.

## Conclusions

- `payload.source.subagent` is present in the local subagent sample and is the primary signal.
- `payload.agent_role` is present on the same subagent sample and is a secondary signal.
- Root samples observed on 2026-04-28 through 2026-05-01 use `payload.source: "cli"` and do not carry `agent_role`, `agent_id`, `agent_type`, or `parent_session_id`.
- The subagent `session_meta` first line was 22187 UTF-8 bytes because `base_instructions` is embedded. An 8KB read is not enough; hook-side metadata reading must read in chunks up to a bounded cap and stop at the first newline.
- No local hook stdin dump was available. Current OpenAI Codex hooks documentation (`https://developers.openai.com/codex/hooks`) lists common hook input fields such as `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and `model`, but does not document a root/subagent role field in the hook payload, so Clawd reads `transcript_path` metadata for the hook state path.

## Implementation Notes

- Treat unknown fields as `unknown` and fail open as root/interactive behavior.
- Do not infer subagents from cwd or timing.
- `/permission` must classify subagents, but role and interactivity are separate concerns.
  **PR #448's permission behavior was superseded on 2026-07-31.** Codex uses `headless:true`
  on subagent state sessions to keep background child activity out of HUD/focus/completion
  priority; that presentation marker must not suppress an official `PermissionRequest` from a
  visible Agent thread. `buildPermissionBody` therefore still carries `codex_session_role` (plus
  the child nickname/parent provenance). The interactive exception is limited to the resolved
  Codex adapter plus audited CLI/Desktop originators; `codex_exec`, unknown originators, and an
  explicit or derived `headless:true` stay on no-decision → native fallback, including when the
  permission is the first event and no in-memory session exists yet. Ordinary headless
  sessions still use the existing session gate. Interactive child requests enter the same
  bubble/automation chokepoint as their parent. The state-path guidance above is unchanged.
