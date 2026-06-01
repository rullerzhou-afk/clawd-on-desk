# Plan: Issue #357 Context Usage Display (A1)

> Status: Draft v1 (requirements + development plan, no code yet).
> Date: 2026-06-01
> Issue: https://github.com/rullerzhou-afk/clawd-on-desk/issues/357 ("宠物可以支持显示上下文用量吗，感觉很实用")
> Scope: Surface per-session context-window usage (tokens used vs. limit) in the Session HUD / Dashboard, driven by data the agents already emit. Read-only telemetry; no change to agent behavior, permission flow, or animation priority.

---

## 1. Goal

Let the user see, at a glance, how full the current agent session's context window is, so they know when a `/compact` or new session is coming. Two surfaces:

1. **Session HUD** (next to the pet) — a compact usage indicator per live session row.
2. **Sessions Dashboard** — the same usage, with the raw `used / limit (tokens)` numbers.

Optional stretch (Phase 2): when a session crosses a high-usage threshold (e.g. ≥ 90%), bias the pet toward an `attention`-style cue. This is deliberately out of scope for Phase 1 to avoid touching the state-priority machine.

### Non-goals

- No new always-on polling. Usage piggybacks on existing hook events / JSONL polling.
- No cross-agent normalization beyond a single `{ used, limit, percent }` shape.
- No historical token graphs (that belongs to the separate A2 "stats panel" idea).
- No change to `state.js` priority resolution or animation selection in Phase 1.

---

## 2. Where the data comes from

Context usage is per-agent and not uniformly available. The plan only lights up the indicator for agents that actually provide the numbers, and degrades silently (no indicator) otherwise.

| Agent | Source of usage | Availability |
|---|---|---|
| **Claude Code** | Transcript JSONL already read by `hooks/clawd-hook.js` (`readTranscriptTailEntries`). Assistant message entries carry a `usage` object (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`). The context window size is model-dependent (e.g. 200k). | High — transcript tail is already parsed today for session title / API error, so no new file IO. |
| **Codex CLI** | Session JSONL carries `token_count` / `event_msg` records with cumulative token usage and context window info. The JSONL is already polled by `agents/codex-log-monitor.js`. | Medium — needs a new parser branch in the monitor; only fallback (non-hook) sessions emit through polling. |
| **Other agents** (Copilot, Gemini, Cursor, Kimi, Qwen, opencode, Pi, …) | No reliable usage signal in current hook payloads. | None in Phase 1 — indicator simply hidden. |

Key implication: **Claude Code is the primary target for Phase 1** because the transcript tail is already read on every hook event. Codex is a fast-follow once the Claude path proves out the data shape. Everything else degrades to "no indicator".

### Computing percent

```
contextUsage = {
  used:    input_tokens + cache_read_input_tokens + cache_creation_input_tokens (+ output of last turn),
  limit:   model context window (from a small per-model lookup table, with a sane default),
  percent: clamp(round(used / limit * 100), 0, 100),
  source:  "claude" | "codex"   // for debugging / formatting
}
```

The exact `used` formula is finalized during implementation against a real Claude Code transcript (per AGENTS.md, transcript/usage changes must be verified against a real session, not a hand-written payload). The model→limit table lives next to the parser and falls back to a conservative default when the model is unknown, in which case only the raw `used` count is shown (no percent).

---

## 3. Data flow (matches existing field plumbing)

Context usage rides the exact same path that `model` / `provider` / `sessionTitle` already travel, so no new transport is introduced:

```
hooks/clawd-hook.js                      (parse transcript tail → context_usage)
  → POST /state body: { ..., context_usage: { used, limit } }
src/server-route-state.js                (validate data.context_usage like model/provider)
  → updateSession({ ..., contextUsage })
src/state.js  updateSession()            (store srcContextUsage, sticky like model)
  → session.contextUsage
src/state-session-snapshot.js            (buildSessionSnapshotEntry adds contextUsage)
  → snapshot entry { ..., contextUsage }
src/session-hud-renderer.js              (render usage chip in the row "right" cluster)
src/dashboard-renderer.js                (render used / limit / percent in detail)
```

Codex fallback path:

```
agents/codex-log-monitor.js              (parse token_count event → contextUsage)
  → same updateSession({ contextUsage }) entry point as today's monitor callbacks
```

### Validation rules (server-route-state.js)

Mirror the defensive pattern used for `model` / `cwd`:

- Accept `data.context_usage` only when it is an object with finite, non-negative `used` (and optional finite positive `limit`).
- Drop silently on malformed input (no 400) — usage is best-effort telemetry.
- Empty / missing input is sticky: it does not clear a previously known `contextUsage` (same "ignore + fall back" rule as `sessionTitle`).

---

## 4. Settings & UI

### 4.1 Preference

Add one boolean to `src/prefs.js`, following the existing `sessionHudShow*` family:

```js
sessionHudShowContextUsage: { type: "boolean", default: true },
```

Wire it through the standard settings chain (`settings-controller` is the only writer; `prefs.js` → `settings-actions` → store → renderer broadcast). Expose it as a toggle in the Session HUD settings section alongside `Show state labels` / `Show elapsed`, plus an i18n string in `src/settings-i18n.js` (en / zh-CN / zh-TW / ko / ja).

### 4.2 Session HUD indicator

In `src/session-hud-renderer.js`, the row already has a `right` cluster holding the state chip + elapsed. Add a small usage chip there, only when `sessionHudShowContextUsage` is on **and** `session.contextUsage` exists:

- Compact form: `72%` (or a thin horizontal bar) — keep it tiny; the HUD is space-constrained.
- Color ramp: neutral < 75%, warm 75–90%, hot ≥ 90% (reuse existing chip color tokens in `session-hud.html` / styles, do not invent a new palette).
- `title` tooltip carries the raw `used / limit` for hover detail.
- When `limit` is unknown, show the raw token count (e.g. `18.2k`) with no percent and neutral color.

### 4.3 Dashboard detail

In `src/dashboard-renderer.js`, render the full `used / limit (percent)` line in the session detail area. Same gating on `contextUsage` presence.

---

## 5. Phasing

**Phase 1 — Claude Code only (ship first):**
1. Extend `hooks/clawd-hook.js` transcript-tail reader to compute `context_usage` from the existing parsed entries (no new file reads).
2. Plumb `context_usage` through `server-route-state.js` → `state.js` → snapshot.
3. Add `sessionHudShowContextUsage` pref + settings toggle + i18n.
4. Render the HUD usage chip and Dashboard detail.
5. Tests (see §6) + manual verification against a real Claude Code session.

**Phase 2 — Codex fallback:**
6. Parse `token_count` from `agents/codex-log-monitor.js` and feed the same `updateSession` field.

**Phase 3 (optional, separate PR) — high-usage attention cue:**
7. Evaluate biasing the pet toward an attention cue at ≥ threshold. Requires explicit design sign-off because it touches state priority; intentionally deferred.

---

## 6. Testing

Following the repo's Node built-in test-runner convention (`npm test`), all logic must be unit-testable without Electron:

- **Parser unit tests**: feed representative Claude transcript-tail entries (with / without `usage`, with cache tokens, unknown model) and assert the computed `{ used, limit, percent }`. Add Codex `token_count` fixtures in Phase 2.
- **Server route tests** (`server-route-state` style): valid object accepted, malformed dropped, empty input is sticky (does not clear prior usage).
- **Snapshot tests** (`state-session-snapshot`): `contextUsage` flows into the snapshot entry and is `null`/absent when unknown.
- **Settings tests**: `sessionHudShowContextUsage` default, persistence, and effect propagation.
- **Manual (required by AGENTS.md)**: verify against a real Claude Code session that the displayed percent tracks the terminal's own `/context` view as the conversation grows; transcript/usage changes cannot be validated with hand-written payloads alone.

---

## 7. Risks & open questions

- **Token formula accuracy**: cache-read vs. cache-creation vs. input token accounting must match how Claude Code itself reports context fullness; finalize against a real transcript before locking the formula.
- **Model→limit table drift**: context windows change with model releases. Keep the table small, centralized, and default-safe; show raw counts when the model is unknown rather than guessing a wrong percent.
- **HUD real estate**: the HUD is intentionally compact. A percent chip is the safe default; a thin bar is a follow-up if it reads well.
- **Codex hook-mode sessions**: official Codex hooks may not carry token counts, so Phase 2 usage is best-effort on the JSONL-polled fallback only (consistent with the existing Codex fallback limitations in `docs/guides/known-limitations.md`).
- **Privacy**: only aggregate token counts cross the local HTTP boundary (already `127.0.0.1`-bound); no prompt content is added to the payload.

---

## 8. Touch list (for the implementation PR)

| File | Change |
|---|---|
| `hooks/clawd-hook.js` | Compute `context_usage` from transcript-tail entries; add to `/state` body |
| `src/server-route-state.js` | Validate + forward `context_usage` → `contextUsage` |
| `src/state.js` | Store `srcContextUsage` on the session (sticky, like `model`) |
| `src/state-session-snapshot.js` | Add `contextUsage` to `buildSessionSnapshotEntry` |
| `src/session-hud-renderer.js` | Render usage chip in the row `right` cluster |
| `src/dashboard-renderer.js` | Render `used / limit (percent)` detail |
| `src/prefs.js` | Add `sessionHudShowContextUsage` boolean |
| `src/settings-i18n.js` + Session HUD settings tab | Toggle + 5-language strings |
| `agents/codex-log-monitor.js` | (Phase 2) parse `token_count` → `contextUsage` |
| `test/*.test.js` | Parser, server route, snapshot, settings tests |

---

*This document is the requirements + development plan for A1. It intentionally contains no functional code changes; the implementation lands in a follow-up PR that follows the touch list and phasing above.*
