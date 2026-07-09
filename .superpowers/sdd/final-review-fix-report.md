# Final Review Fix Report

## Files Changed

- `src/wavepet/codex-event-adapter.js`
- `src/wavepet/runtime.js`
- `src/agent-runtime-main.js`
- `test/wavepet-codex-event-adapter.test.js`
- `test/wavepet-runtime.test.js`
- `test/agent-runtime-main.test.js`
- `.superpowers/sdd/final-review-fix-report.md`

## Review Items Addressed

### 1. Critical: duplicate completion from delayed raw JSONL `task_complete`

Addressed.

- Added a regression test covering official Codex `Stop` already completing the turn, followed by a delayed raw JSONL `task_complete`.
- Added `shouldSuppressWavePetCompletion()` in `src/agent-runtime-main.js` so a WavePet `wavepet:closing` -> Clawd `attention` replay is dropped when the session already ended on `Stop` or prior `event_msg:task_complete`.
- Preserved the existing official-hook suppression behavior while still allowing raw JSONL to feed WavePet for non-completion signals.

### 2. Important: missing JSONL fallback mappings for `task_started`, `exec_command_end`, `patch_apply_end`

Addressed.

- Added `event_msg:task_started` -> `assistant_start` fallback in `src/wavepet/codex-event-adapter.js`.
- Added `event_msg:exec_command_end` fallback mapping to `tool_call_end`, including `test_run_end` when command classification resolves to a test command.
- Added `event_msg:patch_apply_end` fallback mapping to `file_edit` plus `tool_call_end`.
- Fallback end handling now retires any synthetic open tool call state so adapter session state does not drift across legacy JSONL shapes.

### 3. Important: routine tool failures escalated to top-priority Clawd `error`

Addressed.

- Narrowed `WavePetRuntime._hardFailure()` so ordinary failed shell/patch/tool outputs no longer escalate to Clawd `error` by severity alone.
- Normal tool failures now remain in WavePet debugging lanes (`overheat_debugging` -> Clawd `working` with debugger hint) unless the caller explicitly passes `hardFailure: true` or events explicitly carry a `clawd_hard_error` marker.
- Updated runtime tests to codify the narrower escalation rule and keep explicit hard-failure override coverage.

### 4. Minor: `WavePetRuntime.clearSession()` integration

Partially addressed with a low-risk path.

- Added `WavePetRuntime.clearAllSessions()`.
- Wired WavePet runtime retirement into `src/agent-runtime-main.js` on:
  - `clearSessionsByAgent("codex")`
  - runtime `cleanup()`
- Did not wire per-session retirement on completion or stale cleanup because `src/agent-runtime-main.js` does not currently own a reliable per-session teardown callback. Clearing WavePet session state at raw completion time would be risky because Clawd still keeps post-completion session metadata and duplicate-suppression tails alive after the turn ends.

## Tests Run

- `node --test test/wavepet-codex-event-adapter.test.js test/wavepet-runtime.test.js test/agent-runtime-main.test.js`
  - Passed: 32/32
- `node --test --test-name-pattern "Codex Stop followed by token_count and task_complete still auto-returns from attention|keeps official Codex Stop as the completion tail when JSONL task_complete arrives later|does not replay remote Codex task_complete after the completion animation returned to idle" test/state.test.js`
  - Passed: 3/3

## Commit Hash

- `58eb186f958afd3571dedf26ef8981f293f51b56`

## Remaining Concerns

- The current low-risk WavePet session retirement is coarse-grained. If the codebase later gains a Codex-owned per-session teardown callback in `agent-runtime-main`, `WavePetRuntime.clearSession(sessionId)` should be wired there instead of relying on agent-wide cleanup boundaries.
