# Plan: Identity-first subagent lifecycle tracking (#862)

> Status: **Implemented; core D0 and Windows confirmation complete.** Final
> exact-head re-review remains an open merge gate.
> Supersedes PR #877's original implementation at head `f38414ca`, which must
> not be restored — it replaces the reported defect with a worse one (§2.1).
> Date: 2026-08-14 (design revised after second external review)
> Origin: Issue #862; PR #877; four independent adversarial reviews (one external
> Codex review, three internal agents) that converged on the same root problem,
> plus a second external review of this plan's first draft that rejected its
> design section. §1–§3 (diagnosis) survived that review unchanged; §4–§9 were
> rewritten.
> Scope: subagent lifecycle tracking in `src/state.js`, the juggling tier in
> `src/state-visual-resolver.js`, provenance plumbing from
> `src/server-route-state.js` (and possibly `hooks/clawd-hook.js`), plus
> Settings/theme/doc wording in all locales. Whether a hook protocol change is
> required is decided by D0 (§4.2 item 11, §5.1).

---

## 1. Decision summary

Issue #862 is real: with two subagents in one session the pet stays on the
1-subagent asset. The fix on PR #877 counts subagents instead of sessions, which
addresses the symptom, but it does so with a scalar `liveSubagents += 1 / -= 1`
whose increments and decrements come from **different event streams**. That
converts "the pet leaves juggling too early" into "the pet can never leave
juggling", which is worse and also suppresses every other session's animation.

Do **not** reduce the PR to a plain anonymous tier count either. Even with the
hold branch removed, duplicate starts, synthetic/native double delivery, restored
leases and one-shot states can still push a single subagent into the 2+ tier, so
"fix only the reported scenario with zero new failure modes" is not achievable
that way.

The replacement is an **identity-first tracker with an anonymous floor**: count
subagents we can name, represent everything else as at most one, and never let an
unpaired event stream hold the pet indefinitely.

**The real-machine event protocol is a blocking prerequisite (§4), not a final
smoke test.** Every counting model below is a guess until the actual event
stream is pinned down — and §5.2 spells out the specific D0 outcome under which
this design does **not** fix #862 and a fallback is required.

An earlier draft of this plan proposed a richer model (`provisional` records
keyed by `tool_use_id`, plus a `generation` counter and timers). That was
reviewed and rejected as both unsound and unnecessary: the generation guarantee
is unimplementable on this wire (§5.2), and the provisional lane's job is done by
a single boolean floor. The simpler model below is the one to build.

---

## 2. Verified current behavior on `f38414ca`

All of the following was reproduced through the real `updateSession` entry point
unless stated otherwise.

### 2.1 The counter's increments and decrements come from different event streams

`hooks/clawd-hook.js:358-366` synthesizes every `PreToolUse(tool_name="Task")`
into a `SubagentStart` (applied at `:565`, `:579`). The comment there states that
`PostToolUse(Task)` is **deliberately not** turned into a stop; release is meant
to come from a later `Stop`/`UserPromptSubmit`, or from a real `SubagentStop`
"if Claude emits one".

Before #877 this asymmetry was harmless: the *first* `SubagentStop` restored the
session regardless of how many starts had accumulated. PR #877 gates release on a
counter that only the start side feeds, and adds no dedupe.

Consequence: any leaked start pins the session in `juggling` for the rest of the
turn. Because `juggling: 4` outranks `working: 3`
(`src/state-priority.js:16-17`), one pinned session suppresses the animation of
**every other session** until its parent `Stop`.

Reproduced: `PreToolUse(Task)` → synthetic start, then a native `SubagentStart`
for the same subagent, then its `SubagentStop` → `live` 1 → 2 → 1 → pet stays
juggling. Pre-#877 that stop restored `working`.

### 2.2 The self-heal claim is inverted

`src/state.js:1076-1079` claims a start arriving while the session is not already
juggling "self-heals a session whose SubagentStop never arrived". Measured:

```
2 started              live = 2
1 stopped, 1 lost      live = 1  state = juggling
main-agent PreToolUse  live = 1  state = juggling   <- juggling-hold preserves both
next run SubagentStart live = 2                     <- stacks, does not reset
asset = clawd-working-juggling.svg   (one subagent actually running)
```

The reset at `src/state.js:1084` only fires when `existing.state !== "juggling"`
— precisely the case where nothing was stuck. A lost stop leaves the session
*in* juggling (main-agent tool traffic keeps hitting the juggling-hold at
`:2116-2119`, which preserves state and counter), so the next start takes the
`current + 1` arm.

The PR's own test passed only because it used `attention`/`Stop` to leave
juggling first, which routes around the failure.

### 2.3 One-shot states strand the counter

`src/state.js:2098` (attention/notification/SLEEP) and `:2100-2109`
(`ONESHOT_STATES` = attention, error, sweeping, notification, carrying —
`src/state-priority.js:24`) force the session to `"idle"` while `...base` /
`Object.assign(existing, base)` carries `liveSubagents` through unchanged. The
stranded value is then reinterpreted by the `existing.state === "juggling"` test
at `:1084`.

Reproduced: 2 subagents live → `PostToolUseFailure` → `error` → idle (live=2
stranded) → main-agent `PreToolUse` → third `SubagentStart` → **live resets to 1
with three running** (i.e. #862 returns) → one stop → live=0 → hold gate fails →
restores `working` while two are still running.

Corroborated in production logs: `session-debug.log` shows
`state=juggling ... -> incoming=error/PostToolUseFailure` with the next event for
that session reading `state=idle`, while its `SubagentStop`s arrived four minutes
later. `cleanStaleSessions`' `working-timeout`
(`src/state-stale-cleanup.js:169` → `src/state.js:2403`) strands it identically
after five minutes.

### 2.4 Anonymous counting has no identity

`subagentId` is already destructured at `src/state.js:1632-1633` and used at
`:2064` for the `SessionEnd` automation gate, but `resolveLiveSubagents` ignores
it. Reproduced consequences:

| sequence | result | expected |
|---|---|---|
| duplicate `SubagentStart` for the same `child-a` | `live=2`, three-ball asset | 1, no escalation |
| duplicate `SubagentStop` for `child-a` while `child-b` runs | `live=0`, `state=working` | stay juggling |
| delayed stop from an old run after a new run started | `live=0`, `state=working` | stay juggling |

### 2.5 Restored leases disagree with the renderer

`countLiveSubagents` (`src/state-visual-resolver.js:108-114`) floors a missing
counter to 1; `resolveLiveSubagents` (`src/state.js:1081-1083`) treats the same
absence as 0. A lease restored with `state="juggling"`
(`src/state.js:2313-2356`, permitted at `:2305`, never writes the field) renders
as one subagent but a subsequent `SubagentStart` computes `live=1` instead of 2,
so it does not escalate.

### 2.6 The debug thunk does not do what its comment claims

`src/state.js:878-882` was changed to accept a thunk so that expensive fields
"cost nothing when debug logging is off". But `ctx.debugLog` is unconditionally a
function in all three production wirings (`src/main.js:1858`, `:2310`, `:2348` —
all `debugLog: (msg) => sessionLog(msg)`); the actual switch is inside
`sessionLog` at `src/main.js:2403-2407`. The guard therefore never
short-circuits, `msg()` always runs, and `getSvgOverride("juggling")` walks the
sessions Map twice and eagerly calls `ctx.getIdleVisualChoice()` on every
`SubagentStart` and every held stop **with logging off**. The change added
unconditional per-event work while claiming to avoid it.

---

## 3. What the current tests do not establish

The suite is green (7726 tests, 0 fail) and catches none of §2.

- **The six new tests assert a recomputation, not a paint.** They call
  `api.getSvgOverride(api.resolveDisplayState())`, a pure recomputation over the
  session map. Replaying each while capturing `ctx.sendToRenderer("state-change")`
  shows **five of six diverge** from what the pet actually paints, because
  `themes/clawd/theme.json:656` (`timings.minDisplay.working = 1000`) defers every
  subsequent `setState` into `pendingTimer` (`src/state.js:585-607`). The
  codebase's existing idiom captures `state-change` (`test/state.test.js:522`,
  `857`, `994`, `2220`, and ~7 more); the new suite is the outlier.
- **Surviving mutations.** Deleting the `session.headless ||` guard from
  `countLiveSubagents` (`src/state-visual-resolver.js:111`) leaves the suite
  green, while deleting the identical guard from the older
  `countActiveSessionsByStates` (`:98`) is caught — a load-bearing invariant was
  copied into a new function without its coverage. Also surviving: the negative
  clamp at `src/state.js:1085`, the thunk branch, the hold branch's
  `cleanStaleSessions()`, and `return current;` → `return 0;` in
  `resolveLiveSubagents` (the last of which would silently re-introduce #862 via
  `hooks/claude-statusline.js:137`'s `preserve_state: true` pings).
- The earlier "mutation 4/4 caught" claim covered only four self-selected
  mutations; broader sweeps found 4–9 survivors.

---

## 4. D0 — core real-machine event protocol gate

Nothing in §5 can be declared merge-ready before this. The local implementation
may be built and reviewed against the upstream contract, but it remains
conditional until this gate is run. Two reviewers disagreed on whether
Claude Code emits a native `SubagentStart` alongside its subagent tool call: one
found 2 starts / 2 stops on Claude Code 2.1.211 and could not reproduce double
delivery; another constructed double counting via a probe. Meanwhile
`hooks/install.js:66-67` registers `SubagentStart` **and** `PreToolUse`
unconditionally.

### 4.1 The sampler

D0 needs a deliverable, not just a matrix. Build a standalone raw-event sampler:

- records the **raw** hook event *before* `clawd-hook.js` normalizes
  `PreToolUse(Task/Agent)` into `SubagentStart` (`hooks/clawd-hook.js:579`) — the
  normalized stream is exactly what destroys the provenance we are trying to
  measure;
- creates an isolated settings file for Claude's `--settings` flag, independent
  of the normal hook install path; it never reads or mutates the user's existing
  hook configuration, so there is nothing to merge or restore;
- writes with mode `0600` on POSIX and a hard size cap; Windows captures must
  live under the current user's ACL-protected temp/profile directory because
  NTFS does not implement POSIX permission bits;
- is deleted, with hooks restored, as soon as the matrix is captured.

**Record only:** event name, redacted session id, agent id / type, tool name,
`tool_use_id`, source, `stop_hook_active`, timestamp, monotonic sequence number.

**Never record:** prompts, tool inputs, `cwd`, transcript paths, file contents.

Publish the redacted result to `docs/investigations/`.

### 4.2 The matrix

1. one subagent, normal completion;
2. two concurrent subagents, interleaved completion;
3. **nested** — a subagent that itself invokes Agent (or legacy Task), to confirm the §5.1
   originator-vs-child hazard and how ids appear on both levels;
4. **blocked stop** — a `SubagentStop` vetoed by another hook, followed by
   continued activity from the same child and its eventual real termination
   (§5.2);
5. **background subagent spanning a main turn** — does a child survive
   `UserPromptSubmit`?
6. **`SessionStart` source matrix** — capture `startup`, `resume`, `clear`, and
   `compact` when reproducible, and determine which sources may coexist with a
   live background child; the state layer cannot safely treat every main-thread
   `SessionStart` as a whole-tracker clear without this result;
7. **subagent-scoped `SessionEnd`** versus a main-thread `SessionEnd`;
8. an Agent/Task tool call that fails or is interrupted with Esc;
9. main-turn `Stop` and `UserPromptSubmit`;
10. whether `PreToolUse(Agent)` (or legacy `Task`) and a native
    `SubagentStart` both appear for the same child;
11. **whether native start/stop reliably carry a child `agent_id`** — this is the
    single most important cell in the matrix (§5.2);
12. whether the matching `PostToolUse(Agent/Task)` reliably arrives with the
    same `tool_use_id`;
13. real ordering, and whether any event is redelivered.

Items 1–2 and 9–13 are the blocking core for #862 because they decide whether
the tier can count trusted identities without double delivery. Blocked-stop and
the observed completion/source boundaries additionally validate the cleanup
model. Nested launch, subagent-scoped cancellation/end, interruption, and
`resume` remain useful compatibility follow-ups, but they do not block this
counting fix once provenance, matched deletion, stale cleanup, and scoped-end
behaviour are covered by contract tests. Do not expand this issue into an
unbounded upstream-protocol matrix.

On item 7: an earlier draft listed "a Task denied at the permission prompt" as a
given. Do not assume it. The current tool surface may not prompt for the agent
tool at all, in which case a denial has to be constructed deliberately (e.g. a
temporary blocking hook). Record what this machine's Claude Code build actually
does rather than what a doc implies.

### 4.3 Platform

macOS is adequate for pinning the wire protocol — hook payloads are platform
independent. Windows therefore needed separate confirmation that the hooks are
*invoked* the same way: `hooks/install.js` has had Windows-specific registration
differences before (the EncodedCommand work in PR #805), and the original report
came from Windows 11. §4.5 records that completed gate.

### 4.4 Authenticated Desktop capture (2026-08-14)

Claude Desktop Code in **Local** mode loaded the project hook configuration and
produced a privacy-limited capture from one real session. The current tool name
was `Agent`, not `Task`. For two concurrent Explore children, the raw order was:

1. two distinct `PreToolUse(Agent)` events with distinct `tool_use_id` values;
2. two native `SubagentStart` events with distinct child `agent_id` values;
3. two matching `SubagentStop` events reusing those exact child ids;
4. two matching `PostToolUse(Agent)` events;
5. a third `PreToolUse(Agent)` / native start / native stop / post sequence;
6. a parent `Stop`.

This answers item 11 positively on authenticated Desktop Local and selects the
trusted-ID design branch: two live children can produce
`confirmedIds.size === 2`. It also proves native + synthetic double observation
and the current `Agent` spelling.

Follow-up runs confirmed three more protocol boundaries:

- a vetoed first `SubagentStop(D, stop_hook_active=false)` was followed by
  `PreToolUse` / `PostToolUse` carrying the same child id D, then a second
  `SubagentStop(D, stop_hook_active=true)` — item 4 and same-id readmission are
  real on this build;
- a background child emitted parent `Stop`, then child-originated `PreToolUse`,
  remained active for about 20 seconds, and finally emitted its matching
  `SubagentStop` — a raw parent stop cannot clear the tracker;
- `/compact` emitted `PreCompact`, one unmatched stop for an unseen id,
  `SessionStart(source=compact)`, then `PostCompact`; `/clear` ended the old
  session with `reason=other` and the next prompt started new
  `source=startup` sessions rather than emitting `source=clear`.

The third child reported that nested launch was unavailable, and merely
reopening the Desktop session did not emit `source=resume`. The maintainer also
manually verified a Desktop run where a new `UserPromptSubmit` arrived before
the existing child's `SubagentStop`; no raw sampler artifact was retained for
that observation. Nested delivery, subagent-scoped `SessionEnd`, resume, and
interruption remain non-blocking compatibility follow-ups.

### 4.5 Windows confirmation (2026-08-14)

On real Windows 11 hardware, Claude Code `2.1.232` loaded the isolated sampler
from PR head `0bb7df97` and completed a read-only two-child concurrent run. The
capture contained two distinct synthetic Agent tool-use IDs, two distinct
native child IDs, matched native stops, and matched Agent tool results. No
field outside the sampler whitelist was recorded.

The focused lifecycle/hook/route/renderer suite initially passed 757/759: the
only failures assumed a POSIX `0600` mode on NTFS. Commit `d3c5851b` scoped that
assertion to POSIX and documented the inherited Windows ACL boundary. The exact
Windows rerun then passed 759/759 with zero failures or skips. The reporter's
existing dirty repositories, normal hooks, and running Clawd process were not
modified.

---

## 5. Design

### 5.1 Identity sources, and how to classify them

What the wire already carries, and why the obvious classification rule is unsafe.
An earlier draft of this section claimed provenance could be inferred for free
and that no hook change was needed; that claim is withdrawn — see the ordering
hazard below.

- **Native starts** carry `subagent_id`: `hooks/clawd-hook.js:599` sets
  `body.subagent_id` from `payload.agent_id` when it is present and not
  `claude-code`. It reaches `updateSession` today
  (`src/server-route-state.js:780`, destructured at `src/state.js:1632`).
- **Synthetic starts** carry `tool_use_id`: `hooks/clawd-hook.js:618` sets
  `body.tool_use_id`, and a synthetic start is by construction a current
  `PreToolUse(Agent)` or legacy `PreToolUse(Task)`, which carries one. It is
  unique per tool invocation and therefore idempotent under redelivery.
- **The matching `PostToolUse(Agent/Task)` carries the same `tool_use_id`**, giving the synthetic
  path a natural pairing signal without reclassifying it as a `SubagentStop`
  (which would overturn the deliberate design at `hooks/clawd-hook.js:359-363`
  and is not provably equivalent to subagent termination).

**Classification order matters, and the obvious rule is wrong.** "`subagent_id`
present ⇒ native" **must not** be used. `hooks/clawd-hook.js:579` renames the
event to `SubagentStart` and then `:590-599` forwards `payload.agent_id`
unconditionally. When a subagent *itself* invokes Agent/Task (nested subagents), the
resulting synthetic start carries the **parent's** id — registering it as a new
child would invent a subagent that does not exist.

Correct order:

1. `tool_name === "Agent" || tool_name === "Task"` on a start ⇒ **synthetic**.
   Any `subagent_id` on it is the **originator** (the parent that launched the
   tool), never the new child.
2. otherwise, a `subagent_id` on a start ⇒ **native**, and the id is the child.

Because a synthetic start can never name its own child, `tool_use_id` is the only
child-shaped key it has. Whether the primary Set design is sufficient is decided
by D0 item 11 (§5.2).

Implementation choice: stamp explicit `subagent_lifecycle_source` in
`clawd-hook.js`, allowlist it at the route, and retain the incoming tool-name
rule as compatibility for an older managed hook that has not yet been
synchronized. The stamp is `synthetic-tool`; the route also accepts the
short-lived draft value `synthetic-task`. Normal hook auto-sync picks up the
current stamp; there is no settings/schema migration.

Do **not** forward `tool_use_id` into the v1 tracker. It is already parsed for
other route behavior, but the synthetic lane is intentionally a boolean floor,
not a provisional identity lane. Wiring it into `state.js` without the bounded
lifetime and cleanup protocol described in §5.2 would imply a safety guarantee
this design does not provide.

### 5.2 The tracker

Replace the scalar `liveSubagents` with three per-session fields:

```
confirmedIds:   Set<childId>   // only ids we can trust to name one child
legacyFloor:    boolean        // "at least one anonymous child is running"
recoveredFloor: boolean        // "restarted while juggling" (§5.5)
```

Visual count for the session:

```
max(confirmedIds.size, legacyFloor ? 1 : 0, recoveredFloor ? 1 : 0)
```

`max` rather than a sum is the point: synthetic and native deliveries for the
same child cannot inflate each other, so D0 item 9 stops being a correctness
risk.

Lanes:

- **Native start with a trusted child id** (§5.1 rule 2) ⇒ add to
  `confirmedIds`. Idempotent.
- **Synthetic Agent/Task starts, and anonymous `SubagentStart` from other agents**
  (Cursor `hooks/cursor-hook.js:26-27`, Kimi
  `hooks/kimi-hook.js:23-24`) ⇒ set `legacyFloor = true`. Never accumulates;
  caps the lane at 1.
- Copilot does not emit `SubagentStart`/`SubagentStop`; it has no anonymous lane.
- **Stops**: a stop naming a member of `confirmedIds` removes exactly that
  member; an unknown or duplicate id is a no-op and must never disturb other
  members. An **anonymous** stop keeps the legacy semantics — it clears
  `legacyFloor` and restores on the first stop, which is what keeps §2.1's
  permanent-hold failure mode from returning.
- Reasonix registers `SubagentStop` with no `SubagentStart`
  (`hooks/reasonix-install.js:151`), so unmatched stops are normal traffic and
  must be inert, not underflowing.

**Only `confirmedIds` may sustain a multi-child hold.** An anonymous lane can
never hold beyond its first stop.

**A `SubagentStop` is a termination *attempt*, not an authoritative close.**
Another `SubagentStop` hook can veto the stop and let the same child keep
running, so the id is trustworthy but the event is not final. The tracker must
therefore be self-correcting: any subsequent non-stop activity from an id that
was just removed re-adds it to `confirmedIds`. If that readmission causes visible
flicker, damp it with a short grace period on the stop rather than by trusting
the stop outright. **D0 item 4 now confirms this exact same-id continuation on
authenticated Desktop Local**; no timer is required for correctness.

**No `generation` field.** An earlier draft claimed old-round stops would be
discarded by a generation stamp. That is unimplementable: the wire carries no
generation (`src/server-route-state.js:769`), so a locally incremented counter
cannot tell whether an inbound stop belongs to this round or the last. Matched-
only deletion already makes a late stop for a departed id a no-op. If upstream
ever reuses child ids across rounds, that needs a real wire epoch — not a local
counter.

> **D0 item 11 is answered positively by the authenticated Desktop Local
> capture in §4.4.** Native `SubagentStart` carries a trusted child id, so two
> subagents in one session give `confirmedIds.size == 2` and the tier escalates
> — issue fixed on this protocol.
> If the only start signal is synthetic, then by §5.1 there is no child id at
> all, `confirmedIds` stays empty, `legacyFloor` caps at 1, and **the tier never
> escalates — #862 is not fixed by this design.**
> A synthetic-only result does **not** authorize an implicit fallback in this
> plan. D0 can prove emission, but each hook POST is still an independently
> lossy, short-timeout delivery; even a consistently emitted
> `PostToolUse(Agent/Task)` cannot make an unbounded synthetic hold safe. Stop and
> revise the design before implementation: a `tool_use_id` lane would need an
> explicit bounded lifetime, cleanup/redraw rules, and tests, or the hook
> protocol must gain stronger provenance/lifecycle evidence. Those mechanics are
> intentionally outside this v1 rather than half-specified here.

### 5.3 Lifecycle boundaries

Stop using `existing.state === "juggling"` as the source of truth for liveness.
Visual state and subagent lifecycle must be decoupled — that coupling is the
common root of §2.2 and §2.3.

**Not every lifecycle event is a whole-tracker clear.** An earlier draft listed
`SessionStart` / `SessionEnd` / `UserPromptSubmit` as unconditional clears; that
is wrong on two counts.

- **`SessionEnd` is scoped.** The routing layer already distinguishes them: a
  main-thread `SessionEnd` is authoritative for the whole agent session, but one
  emitted *by a subagent* only closes that subagent — siblings and the parent can
  still be live (`src/server-route-state.js:734-741`). So a `SessionEnd`
  carrying a `subagentId` removes only the matching member of `confirmedIds`.
- **`UserPromptSubmit` must not clear `confirmedIds` unconditionally.** A
  background subagent may legitimately span a main turn. Until D0 item 5 shows
  otherwise, treat a new prompt as a boundary for the *anonymous* floor only.

Whole-tracker clears: `SessionStart(source=startup)` (the observed new-session
boundary, including Desktop's effective post-`/clear` path), a main-thread
`SessionEnd`; a `Stop` genuinely promoted to completion; session deletion.
`SessionStart(source=compact)` is measured non-authoritative and must preserve
confirmed ids. `source=clear` remains accepted as an explicit fresh boundary
from the documented protocol even though this Desktop build used `startup`
after `/clear`. `resume` remains non-clearing pending a live-child capture.
Forward the source/provenance needed to enforce this rule.

`Stop` is deliberately not a raw trigger — the existing background-tasks /
session-crons / stop-hook-veto / completion-debounce logic must run first, and
the clear must attach to the promoted completion, not to every raw `Stop`.

**One-shot visuals need a real return path, not just tracker preservation.**
Error, notification, attention, carrying and sweeping currently overwrite the
session's stored state with `"idle"` (`src/state.js:2098`, `:2100-2109`), and the
resolver only counts sessions whose `state === "juggling"`
(`src/state-visual-resolver.js:108-114`). Preserving `confirmedIds` across a
one-shot therefore does **not** by itself bring juggling back — the session's
underlying logical state has to remain juggling (with the one-shot as a temporary
presentation) so auto-return has something to return to. Whatever mechanism is
chosen, the acceptance test is behavioural: one-shot fires while ids are live,
one-shot settles, pet is juggling again.

**Stale cleanup has two different paths and only one of them deletes.**
`cleanStaleSessions` either deletes the session (`src/state.js:2397`) or merely
flips it to idle in place (`:2401-2405`, `stale-idle`, which only assigns
`s.state = "idle"`). The earlier claim that these paths "already delete the whole
session entry" was wrong: **the stale-idle path leaves the tracker behind and
must clear it explicitly.**

Paths that do drop the whole session entry — `dismissSession`
(`src/state.js:2448`), `clearSessionsByAgent` (`:2513`), main `SessionEnd`
(`:2074`), `evictOldestSessionIfNeeded` (`:1131-1160`) — need verification, not
new code.

### 5.4 Tier resolution

`countLiveSubagents` sums `liveSubagentCount` across non-headless sessions in
`juggling`. The `session.headless` guard is load-bearing and currently untested
(§3) — it needs its own mutation-verified test.

`workingTiers` continues to count sessions; that matches
`docs/guides/state-mapping.md:17` and must not change.

### 5.5 Restored leases

Stop relying on the renderer-side `Math.max(1, live)` to paper over a missing
counter. `restoreSessionFromLease` should set `recoveredFloor = true` when
`lease.state === "juggling"`.

- it is a **presentation floor only** — it contributes to the tier via the `max`
  in §5.2, preserving exactly today's visual behaviour after a restart;
- it never sustains a hold, and it carries no identity;
- **the first fresh lifecycle event for that session replaces it** — once real
  events arrive, the guess is discarded rather than merged, which removes the
  earlier draft's ambiguity about "how a start merges with the baseline";
- `restore juggling lease → SubagentStart` needs an event-level test.

This also resolves the contradiction in the first draft, which simultaneously
held juggling whenever the tracker was non-empty *and* forbade the recovered
baseline from holding. Under §5.2 only `confirmedIds` can hold, so the two rules
no longer conflict.

### 5.6 Debug logging

Revert the thunk check in `src/state.js:878-882`. If lazy evaluation is still
wanted, push it down into `sessionLog()` (`src/main.js:2403-2407`), which is the
only place that knows whether logging is on. Better: reuse the asset already
resolved for the `setState()` call instead of walking the session map a second
time purely for a log line.

Log fields should distinguish sources explicitly:

```
source=native|synthetic-tool|anonymous confirmed=<n> legacyFloor=<0|1> recoveredFloor=<0|1> tier=<...> selectedAsset=<...>
```

The final restore/delete log line must either carry the resolved asset too, or
the PR description must be narrowed to match (`src/state.js:2043` currently does
not).

---

## 6. Staged implementation

1. **D0** — event protocol capture (§4). Item 11 has selected the native-ID
   branch, and blocked-stop/background/compact/clear now have real Desktop Local
   evidence. The maintainer separately confirmed the live-child prompt ordering;
   nesting, scoped end, resume, and interruption are follow-ups. Windows
   invocation is confirmed by §4.5.
2. **Provenance** — whichever of §5.1's two options D0 justifies: the inference
   rule as a floor, or an explicit `raw_hook_event` /
   `subagent_lifecycle_source` stamp.
   Independently reviewable; no behaviour change on its own.
3. **Tracker** — replace the scalar with `confirmedIds` / `legacyFloor` /
   `recoveredFloor`; tier reads the `max`. No hold change yet.
4. **Boundaries** — scoped `SessionEnd`, promoted-completion clears, explicit
   stale-idle teardown, the one-shot return path (§5.3).
5. **Hold** — confirmed-only multi-child hold, anonymous first-stop-restores,
   blocked-stop readmission (§5.2).
6. **Leases** — `recoveredFloor` and its replacement-on-first-event rule (§5.5).
7. **Peripherals** — §8.

Steps 3–6 may be split, but **do not merge any partial state that keeps the
scalar counter**, and do not ship step 5 before step 4 — a hold without correct
teardown is exactly the §2.1 regression.

Explicitly **not** in v1: `tool_use_id`-keyed provisional records, provisional
timers, lane caps, and any `generation` field. They are either unnecessary under
the `max` model or unimplementable on this wire (§5.2).

---

## 7. Test requirements

Every new test must pass real `subagentId` and source values (plus `tool_use_id`
only if D0 forces the fallback lane of §5.2) —
the current helpers (`test/state.test.js:635-637`) pass none, so they do not
exercise the production identity contract at all.

Required cases:

- same-id duplicate start;
- same-id duplicate stop;
- unknown stop while another id is live;
- late stop for an id already removed (no-op via matched-only delete — note there
  is no generation guarantee to test, see §5.2);
- two ids with interleaved start/stop;
- **nested Agent/Task** — a synthetic start carrying the parent's `subagent_id` must
  not register a new child (§5.1);
- **blocked `SubagentStop`** — same id resumes activity after a vetoed stop and
  is readmitted;
- **anonymous-agent lane** — Cursor (`hooks/cursor-hook.js:26-27`) and Kimi
  (`hooks/kimi-hook.js:23-24`) emit
  start/stop events with no child id; they must set `legacyFloor` and keep
  first-stop-restores, never entering `confirmedIds`. Copilot, Codex, and
  opencode produce none today.
- **Reasonix unmatched stop** — registers `SubagentStop` with no `SubagentStart`
  (`hooks/reasonix-install.js:151`), so stray stops are normal traffic and must
  be inert, not underflowing;
- **subagent-scoped `SessionEnd`** removes only its own id, leaving siblings live;
- Esc-interrupted / failed Agent/Task;
- restored juggling lease + new start (and the baseline being replaced by the
  first fresh event);
- one-shot (error / notification) while ids remain live, then **actually
  returning to juggling** — assert the return, not just tracker survival;
- **stale-delete and stale-to-idle as separate cases** — the idle path does not
  delete the session (§5.3) and must clear the tracker explicitly;
- dismiss / agent-disable / main `SessionEnd` teardown;
- headless exclusion (mutation-verified);
- negative / malformed tracker normalization;
- **multi-session mixed mode** — one session on `confirmedIds`, another on
  `legacyFloor`/`recoveredFloor`, verifying the lanes do not interfere.

Pure selector tests may remain, but the render path needs real coverage:

- at least one test capturing `sendToRenderer("state-change")` across a full
  `1 → 2 → 1 → 0` subagent lifecycle;
- a test that rapid changes **within** `minDisplay.working = 1000`
  (`themes/clawd/theme.json:656`) do not paint a stale tier once the deferral
  resolves.

`getSvgOverride(resolveDisplayState())` alone is not a substitute (§3).

---

## 8. Settings, themes and docs

Handle in the same PR:

- **`src/settings-tab-anim-overrides.js:847`** renders juggling tier cards as
  `SubagentStart (${formatSessionRange(...)})`, emitting "sessions / 会话 /
  工作階段 / 세션 / sessões". That is now wrong. It cannot be reworded in place —
  `formatSessionRange` (`:812-836`) is shared with the working tiers at `:846`,
  where "sessions" is still correct. Juggling tiers must say subagents; working
  tiers keep sessions.
- **`docs/guides/state-mapping.md`** — `:7` says "live subagent count" but the
  table rows at `:19-20` are unitless `SubagentStart (1)` / `(2+)` while the
  adjacent working rows say `(1 session)` / `(2 sessions)`. Make the units
  explicit. **`docs/guides/state-mapping.zh-CN.md:19-20` has the same gap**
  (「1 个」/「2+」with no unit) and must be updated in the same pass.
- **Theme-author docs are already correct and need only a clarifying sentence.**
  An earlier review flagged `themes/template/theme.json:72` and
  `docs/guides/guide-theme-creation.md:339-341` as stating session-count
  semantics for juggling tiers. Both were checked and the claim is wrong: those
  lines document **`workingTiers`** (`themes/template/theme.json:71`;
  the guide's example block is a `workingTiers` array), where "concurrent session
  count" is accurate and must stay. The actual `jugglingTiers` documentation
  already says subagent — `themes/template/theme.json:78` ("Optional
  subagent-specific overrides") and `docs/guides/guide-theme-creation.md:260`
  ("Optional subagent juggling overrides"). What is missing is only an explicit
  note that within the juggling group the historical field name
  `minSessions` is a live **subagent** threshold. Add that one sentence; do not
  "fix" the working-tier wording.
- **Do not** rename the field or bump the schema. Existing shape and user
  overrides need no migration — overrides key on the original filename
  (`src/prefs.js:1136`, `src/settings-actions-theme-overrides.js:103-115`) — but
  the semantics must be stated in the UI and docs.

Built-ins verified unaffected in shape: clawd (`themes/clawd/theme.json:613,617`),
calico (`themes/calico/theme.json:140,144`) and cloudling are all 2/1; Codex Pet
import (`src/codex-pet-adapter.js:442-444`) has a single tier pointing at the
fallback file.

---

## 9. Merge preconditions

1. Core D0 identity/order matrix captured from real authenticated Claude
   Code/Desktop and published redacted to `docs/investigations/`; isolated
   sampler settings/log artifacts deleted and the user's normal hooks left
   untouched (§4). Non-core compatibility cells may remain documented follow-ups.
2. **D0 item 11 answered**, and the §5.2 design branch chosen on the basis of it
   — including the honest outcome that a synthetic-only protocol requires a
   separately specified bounded fallback or stronger hook evidence before the
   tier can be fixed safely.
3. Scalar counter replaced by `confirmedIds` / `legacyFloor` / `recoveredFloor`.
4. No anonymous or unpaired event stream can cause a permanent hold; anonymous
   lanes keep first-stop-restores.
5. Nested Agent/Task cannot register a parent id as a child.
6. Regression tests for: restored leases, one-shot **return to juggling**,
   blocked-stop readmission, subagent-scoped `SessionEnd`, and stale-idle
   (as distinct from stale-delete) clearing the tracker.
7. At least one test asserting real renderer `state-change` output across
   `1 → 2 → 1 → 0`.
8. Settings / theme / doc semantics consistent in **all** locales, including
   `state-mapping.zh-CN.md`.
9. Full suite green.
10. The original Windows 11 report path verified on real hardware.
11. Re-review against the new exact head.

---

## 10. Explicitly out of scope

- **Serialization surfaces need no change.** Every outbound boundary is an
  explicit whitelist (`src/state-session-snapshot.js:333-395`, `:537-605`,
  `src/network/mobile-preview-server.js:409-420`); there is no
  `Object.keys(session)`, `for…in`, `JSON.stringify(session)` or
  `structuredClone` in `src/`, `hooks/` or `pwa/`, and no whole-session
  deep-equal test. The tracker will not leak or break lease round-trips or IPC.
- **The Codex permission-focus rebuild** (`src/state.js:1737-1774`) omits the
  counter while preserving a possibly-`juggling` `storedState`. It is unreachable
  today (no producer emits `SubagentStart` for `agent_id=codex`). Leave a comment
  or a contract test; do not widen this PR for it.
- **`KIMI_HOLD_CLEAR_EVENTS`** (`src/state.js:2140-2163`) lists `"SubagentStop"`
  but is unreachable for it because of the early return at `:2057`. Pre-existing
  dead set entry, not introduced here.
- Renaming `minSessions` or bumping the theme schema (§8).
