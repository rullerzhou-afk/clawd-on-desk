# Issue #862 — Claude subagent hook protocol evidence (2026-08-14)

## Status

The key native-identity, blocked-stop, background-after-parent-stop, compact,
and clear cells are confirmed on authenticated Claude Desktop Code **Local**
sessions. Windows hook invocation and the two-child identity/order path are
also confirmed on real Windows 11 hardware. The remaining compatibility matrix
is intentionally partial.

- macOS Claude Code: `2.1.211`
- `claude auth status`: `loggedIn=false`, `authMethod=none`
- A real isolated `claude -p` capture attempt stopped at `Not logged in · Please run /login`. It emitted only `UserPromptSubmit` followed by `SessionEnd(reason=other)`; no subagent lifecycle was reached.
- Claude Desktop Local loaded a temporary project-level privacy-limited sampler
  and completed real concurrent, blocked-stop, background, compact, and clear
  runs.
- Windows 11 Claude Code `2.1.232` loaded an isolated `--settings` sampler from
  PR head `d3c5851b` and completed a real two-child concurrent run.
- The temporary project hook was removed immediately after capture. `~/.claude/settings.json` was neither read nor modified; the existing `.claude/settings.local.json` was left unchanged.

This selects the trusted native-ID implementation branch and satisfies the core
macOS D0 gate for #862. The maintainer separately confirmed a real Desktop run
where a new `UserPromptSubmit` arrived before the existing child's
`SubagentStop`; that observation did not retain a raw sampler artifact. Nested
launch, subagent-scoped `SessionEnd`, resume, and interruption remain
non-blocking compatibility follow-ups. The Windows platform gate is complete.

## Authenticated Desktop Local capture

Anthropic documents that Desktop Code's Local sessions use the same underlying
engine as the CLI and that Desktop and CLI share Claude settings, including
hooks: <https://code.claude.com/docs/en/desktop>. That makes this a real local
hook-protocol capture rather than a UI simulation.

One privacy-limited session produced the following raw order (the sampler records
the protocol child ids; this document replaces them with A/B/C):

| Order | Raw event | Identity evidence |
|---:|---|---|
| 1 | `PreToolUse(Agent)` | tool-use 1 |
| 2 | `PreToolUse(Agent)` | distinct tool-use 2 |
| 3 | `SubagentStart` | child A, `agent_type=Explore` |
| 4 | `SubagentStart` | distinct child B, `agent_type=Explore` |
| 5 | `SubagentStop` | child A reused exactly |
| 6 | `SubagentStop` | child B reused exactly |
| 7–8 | `PostToolUse(Agent)` | the two original tool-use ids reused |
| 9–12 | `PreToolUse(Agent)` → native start C → native stop C → `PostToolUse(Agent)` | third child paired exactly |
| 13 | parent `Stop` | main-turn completion |

The important result is `confirmedIds.size === 2` while A and B overlap. Native starts/stops carry stable child ids, and the synthetic and native streams observe the same population rather than two populations. The current Desktop tool spelling is `Agent`, not the legacy `Task`; the hook and compatibility classifier now accept both. The third child reported that it could not launch a nested agent, so this run did not exercise the parent-originator hazard.

## Blocked stop and same-ID readmission

A one-shot command hook returned the documented
`{"decision":"block","reason":"..."}` response for the first
`SubagentStop`. The passive sampler ran before that blocker. With the real child
id replaced by D, the observed sequence was:

1. `PreToolUse(Agent)` then native `SubagentStart(D)`;
2. first `SubagentStop(D, stop_hook_active=false)`;
3. after the hook veto, `PreToolUse(Bash, agent_id=D)` then matching
   `PostToolUse(Bash, agent_id=D)`;
4. second `SubagentStop(D, stop_hook_active=true)`;
5. matching parent `PostToolUse(Agent)` then parent `Stop`.

The same child id continued after the attempted stop. This directly confirms
the self-correcting rule used by the implementation: remove on stop, but re-add
the id when later non-stop activity from that id proves it is still alive.

## Background child after the parent turn

A real `Agent` tool was launched with background execution. With child E, the
ordering was:

1. `PreToolUse(Agent)`;
2. parent `PostToolUse(Agent)` and native `SubagentStart(E)`;
3. parent `Stop`;
4. `PreToolUse(Bash, agent_id=E)` about 0.5 seconds later;
5. matching `PostToolUse(Bash, agent_id=E)` about 20 seconds later;
6. `SubagentStop(E)`.

Therefore raw parent `Stop` is not a whole-tracker clear. The child remained
live and identifiable after the main turn finished. A second prompt did not win
the timing race before this child's stop; a follow-up construction caused the
child to background its shell and stop early. `UserPromptSubmit` while the child
is still live therefore remains unverified rather than being reported as a
pass.

## Compact and clear boundaries

Desktop `/compact` on this build emitted, for the same session:

1. `PreCompact`;
2. an unmatched `SubagentStop` with an otherwise unseen id and no observed
   `SubagentStart`;
3. `SessionStart(source=compact)`;
4. `PostCompact`.

The unmatched stop validates the matched-only no-op requirement. A compact
`SessionStart` must not clear confirmed children merely because it is a main
session start.

Desktop `/clear` did **not** emit `SessionStart(source=clear)` in this run. It
emitted `SessionEnd(reason=other)` for the old session. On the next prompt it
emitted two new `SessionStart(source=startup)` events with distinct session ids;
one ended immediately with `reason=other`, and the other received the prompt.
The implementation's startup clear is therefore the effective Desktop clear
boundary for this installed version. Merely leaving and reopening the session
in the Desktop UI emitted no resume hook; restarting the app was intentionally
not attempted because another unrelated Claude session was running.

## Windows 11 SSH capture

The reporter's Windows machine (`RULLER-PC`, Windows 11 `10.0.26200`) ran Claude
Code `2.1.232` and Node `24.12.0`. A separate temporary checkout was pinned to
PR head `0bb7df97`, then fast-forwarded to `d3c5851b` after the Windows-only
permission-mode assertion below was repaired. Neither of the reporter's dirty
working trees nor the running `D:\animation` Electron process was changed.

One read-only `claude --print --settings <isolated-file>` run launched exactly
two concurrent Explore children and produced 16 privacy-limited records:

- two distinct `PreToolUse(Agent)` tool-use IDs;
- two distinct native `SubagentStart` child IDs;
- two matching native `SubagentStop` child IDs;
- two matching `PostToolUse(Agent)` tool-use IDs;
- no fields outside the sampler whitelist.

The command returned `WINDOWS_862_DONE` with exit code zero. The first focused
test run exposed two sampler-only failures because NTFS reports inherited ACLs
as mode `0666` even after Node requests `0600`. Commit `d3c5851b` limits the
POSIX mode assertion to platforms that implement it and documents the Windows
ACL boundary. The exact `d3c5851b` rerun then passed the focused
lifecycle/hook/route/renderer suite: 759 passed, zero failed, zero skipped.

## Primary contract evidence

Anthropic's current hook reference specifies:

- `SubagentStart` carries an `agent_id` that is the subagent's unique identifier.
- `SubagentStop` carries the same identity fields and `stop_hook_active`.
- `SubagentStop` can be blocked, so a stop delivery is a termination attempt rather than irrevocable proof that the child exited.
- `SessionStart.source` is one of `startup`, `resume`, `clear`, or `compact`.

Source: <https://code.claude.com/docs/en/hooks>

These contract fields justify the implementation's trusted native-ID lane and explicit `SessionStart` source handling. A later event from the same child re-admits it after a blocked stop.

## Repository evidence

`hooks/clawd-hook.js` also emits a synthetic `SubagentStart` for current `PreToolUse(Agent)` and legacy `PreToolUse(Task)`. It forwards `payload.agent_id` independently, so a nested subagent-tool call can contain the parent child ID. Therefore classification must use explicit lifecycle provenance (or the incoming Agent/Task tool name) before considering an ID native.

The implemented tracker uses independent evidence floors:

- trusted native child IDs: exact `Set` membership and 2+ tier support;
- synthetic/anonymous delivery: bounded visual floor of one;
- restored lease: bounded visual floor of one that cannot hold lifecycle state.

The visual count is the maximum of those observations, not their sum. This prevents native + synthetic double delivery from inflating one child to two.

## Isolated sampler

`scripts/manual/claude-subagent-event-sampler.js` creates a standalone `--settings` hook file and records only a fixed whitelist:

- raw/payload event names;
- redacted session hash;
- child ID/type;
- tool name/use ID;
- start/end source or reason;
- `stop_hook_active`;
- monotonic sequence and timestamp.

It excludes prompts, tool input/output, cwd, transcript paths, model content,
and environment data. The log is capped at 1 MiB and opened mode `0600` on
POSIX. On Windows the capture lives under the current user's ACL-protected temp
directory because NTFS does not implement POSIX permission bits.

Automated sampler tests cover the whitelist, redaction, event registration,
permissions, cap, and one-shot blocker. The temporary settings and raw log used
for this Desktop run were reviewed and deleted after the evidence above was
recorded. Optional sampler follow-ups remain for nesting, a raw capture of the
maintainer-verified live-child `UserPromptSubmit`, subagent-scoped `SessionEnd`,
resume, and interruption. Windows invocation is now confirmed.

## Remaining evidence

The core identity/order cells are complete. Current evidence and follow-ups are:

1. ✅ two concurrent children produce two distinct native IDs;
2. ✅ start/stop reuse the same ID and real ordering is recorded;
3. ✅ a blocked `SubagentStop` is followed by activity with the same id and an
   eventual second stop;
4. ✅ a background child remains active after the parent `Stop`;
5. ✅ compact and clear ordering is recorded for this installed Desktop build;
6. ✅ the maintainer manually verified a new prompt before the live child's stop
   (real Desktop behaviour, without a retained raw sampler log);
7. nested Agent/Task delivery, subagent-scoped end, resume, and interruption are
   non-blocking compatibility follow-ups;
8. ✅ Windows 11 hook invocation produced two distinct native child IDs and
   passed the focused 759-test lifecycle/renderer suite.
