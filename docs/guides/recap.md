# Local Activity Footprints

Clawd can keep private, local footprints of the agent activity it actually receives. Open **Settings → Footprints**, or choose **Open Footprints** from Clawd's right-click menu.

Footprints is a companion-style review, not a time tracker or productivity score. It has four fixed views:

- **Today**: 24 local-hour bars, linearly scaled against that day's busiest hour
- **This week**: seven rows of 24 local-hour cells
- **This month**: a normal Monday-first calendar
- **This year**: 12 rows with up to 31 day cells

Hover or focus an agent row to highlight only that agent. Click the row, or press Enter/Space, to lock the highlight; press Escape to unlock it. Hover an activity bar or cell to see each agent's share of that period. The timeline is one keyboard stop: use the arrow keys, Home, and End to inspect periods without tabbing through hundreds of marks.

While Footprints is open, newly accepted activity refreshes the visible range automatically. Short hook bursts are coalesced so the page updates promptly without rebuilding for every individual signal.

## What the numbers mean

Footprints counts accepted Clawd activity signals. It never guesses work time from process uptime or idle thresholds.

| Value | Meaning |
|---|---|
| Agents seen | Distinct supported built-in agents that produced accepted activity in the selected range |
| Sessions started | Reliable, explicit fresh-session boundaries, assigned once to the local day on which the session started |
| Turns completed | Completion boundaries that survived the agent-specific completion arbitration |
| Tool calls | One reliable start or completion boundary per tool, chosen explicitly for each agent |
| Activity bar/cell | Accepted activity signals in that local hour or day |

Agent integrations do not expose identical signals. A dash (`—`) means that Clawd cannot reliably measure that value for that agent. It is intentionally different from `0`, which means a supported metric was observed and its count was actually zero. Registered custom HTTP agents are not included in Footprints v1 because their event vocabulary is user-defined and has no trusted metric mapping.

The views do not show tokens, cost, models, reasoning level, skills, work/coding duration, streaks, longest sessions, peak days, rankings, or productivity/efficiency scores. There is no cross-agent productivity headline; inspection stays scoped to each hour or day.

## Recorded, not recorded, and clock changes

A quiet period is meaningful only while Clawd was able to record. Footprints therefore stores coverage separately from activity:

- a covered empty cell means Clawd was running and recording, but received no accepted signal;
- an uncovered period means Clawd was closed, the computer was suspended, or Footprints recording was turned off;
- dates before Footprints was first enabled are marked as not started and are never backfilled;
- Do Not Disturb still records accepted activity. DND suppresses interruption and animation; it does not pretend that Clawd stopped observing;
- a daylight-saving hour that never existed is marked as a gap;
- when the clock repeats an hour, both real intervals stay distinct in storage and their counts share one marked fold cell;
- events keep the desktop's local date, time zone, and offset from when Clawd accepted them. Travelling later does not move old activity to a different day.

Most command hooks do not provide their own timestamp, so Clawd uses the receiving desktop's clock. Remote SSH and WSL activity therefore belongs to the desktop's local day, not the remote machine's day. Live Codex JSONL fallback events are the exception: after replay and source arbitration, they retain the trusted timestamp from the accepted log line.

## Local storage and privacy

Recording is on by default. It creates only local files under `~/.clawd/recap-v1/`:

```text
meta.json                         local salt, frozen recording start, retention settings
events/YYYY-MM-DD.jsonl          minimized event tickets for 14 local days
daily-YYYY-MM.json               daily aggregates retained for 400 local days
coverage-YYYY-MM.json            recording coverage retained for 400 local days
coverage-open.json               crash-safe heartbeat for the current coverage interval
quarantine/                      bounded recovery copies of rejected managed files
```

The minimized tickets contain a timestamp, frozen local time fields, built-in agent id, local/WSL/remote scope class, metric flags, and HMAC identifiers used for short-term deduplication. Clawd never writes prompt or response text, commands, tool names or arguments, tool output, paths, filenames, project or repository names, branches, session titles, cwd, account identifiers, raw session/profile/event/turn/tool identifiers, or the original upstream event name into recap storage.

Footprints does not add telemetry, network requests, export, sharing, notifications, or automatic posting. Local, WSL, and Remote SSH sources remain separate broad rows; profile and distribution names are neither stored in the 400-day aggregate nor returned by recap queries.

Malformed managed files and unsupported pre-release schemas are rejected without historical projection. When possible they move into `quarantine/`, which is pruned after seven days and capped at 16 files / 1 MiB total. It may therefore temporarily contain bounded copies of rejected old shapes. **Clear footprint data** removes the quarantine together with the rest of the managed recap generation.

Turn off **Record footprints** to stop new event tickets and close the current coverage interval. **Clear footprint data** removes the managed recap history and rotates its local HMAC salt; the operation cannot be undone.

## Maintainer invariants

- Record only after the agent gate and all source, replay, deduplication, subagent, and completion arbitration have accepted the event. `updateSession()` entry is not an acceptance boundary.
- Metric support belongs to the explicit table in `src/recap-metrics.js`; do not infer it from registry capabilities or normalized event names.
- Keep ephemeral ingress identities separate from the persisted allowlist. Persist only HMAC values when a stable identity is required.
- Preserve `null` for unsupported metrics. Never render or aggregate it as zero.
- DND must not stop recap coverage or discard pending completion arbitration. Suspend, process shutdown, and the recording preference do stop coverage.
- Journal before updating the aggregate so retained tickets can rebuild interrupted writes. Keep 14-day tickets and 400-day daily/coverage retention bounded.
- Rebuild retained journal history in bounded event-loop batches; do not reintroduce synchronous whole-journal aggregate projection or unreleased schema migration.
- Historical civil dates are frozen at acceptance time. Preserve real epoch time, IANA time zone, UTC offset, local date, and local hour; keep Today at 24 hourly bars and the longer ranges on their fixed cells, with explicit gap/fold states.
- Do not add tokens, duration, cost, streaks, scores, export/share, network delivery, raw content, or long-lived linkable identities without a new product and privacy review.
