# Task 3 Report: Native WavePet Rule Engine

## What you implemented

- Added `src/wavepet/engine.js` with a CommonJS `WavePetEngine` that consumes WavePet events and produces `WavePetState` snapshots.
- Preserved the required constants and output schema from the brief:
  - `STATE_ZH`
  - `STATE_PRIORITY`
  - `MIN_VISIBLE_MS`
  - `DEFAULT_THRESHOLDS`
  - `schema_version: "codex_pet_state.v0"`
- Implemented turn tracking, recent-turn history, signal derivation, score calculation, raw state selection, smoothing/hold behavior, presentation mapping, and online feature reporting.
- Added `test/wavepet-engine.test.js` with the exact Task 3 state-transition coverage from the brief.

## What you tested and results

- `node --test test/wavepet-engine.test.js`
  - Result: PASS (`5` tests passed, `0` failed)
- `node --test test/wavepet-token-estimator.test.js`
  - Result: PASS (`4` tests passed, `0` failed)
- `node --test test/wavepet-codex-event-adapter.test.js`
  - Result: PASS (`7` tests passed, `0` failed)

## TDD Evidence

### RED

- Command:
  - `node --test test/wavepet-engine.test.js`
- Output:

```text
Error: Cannot find module '../src/wavepet/engine'
...
✖ test/wavepet-engine.test.js
ℹ pass 0
ℹ fail 1
```

- Why expected:
  - The brief requires writing the engine tests first, and `src/wavepet/engine.js` did not exist yet. The failure proved the test was exercising the missing production module rather than passing accidentally.

### GREEN

- Command:
  - `node --test test/wavepet-engine.test.js`
- Output:

```text
✔ starts with steady work and moves to reading on early read tools
✔ long output enters deep output
✔ failed tests enter overheat debugging
✔ assistant end closes current turn and returns closing signal before later steady state
✔ hold prevents immediate downgrade from deep output
ℹ pass 5
ℹ fail 0
```

## Files changed

- `src/wavepet/engine.js`
- `test/wavepet-engine.test.js`
- `.superpowers/sdd/task-3-report.md`

## Self-review findings

- The implementation is scoped to the native rule engine only and does not pull mapper/runtime/integration concerns into this task.
- The state smoothing logic preserves the brief’s hold and priority behavior, including preventing immediate downgrade from `deep_output`.
- The engine keeps recent-turn context for short-horizon state prediction signals, matching the task’s product intent beyond simple animation labeling.

## Any concerns

- No functional concerns from the required scope.
- There is an unrelated pre-existing modification in `.superpowers/sdd/task-1-report.md`; it was not changed or reverted.

## Review Fix Follow-up

### Fix summary

- Removed the post-`assistant_end` restoration of the finished turn into `current`, so completed turns are only counted once in `recentTurns`.
- Preserved the visible `closing` transition with a transient completion boost consumed during the `assistant_end` update, allowing smoothing/hold to keep the closing presentation without sticky finished-turn state.
- Allowed strong higher-priority raw states to switch immediately when they meet their activation threshold, fixing delayed jumps such as `deep_output -> overheat_debugging`.
- Gated `online_features.current_silent_wait_ms` on `active`, matching the existing inactive gating for `signals.silent_wait_load`.
- Replaced the earlier closing test with a later-settling regression that asserts both coherent diagnostics and eventual exit from sticky `closing`.

### TDD RED/GREEN evidence for added tests

#### RED

- Command:
  - `node --test test/wavepet-engine.test.js`
- Result:
  - FAIL (`3` failing tests, `4` passing)
- Added failing coverage:
  - `assistant end closes the turn once, preserves transient closing, and later settles`
  - `strong higher-priority overheat switches immediately from deep output`
  - `inactive turns report zero silent wait in signals and diagnostics`
- Observed failures:
  - `current_assistant_tokens_streamed` remained `100` after `assistant_end`
  - state stayed `deep_output` instead of immediately switching to `overheat_debugging`
  - `current_silent_wait_ms` incorrectly reported `7000` while inactive

#### GREEN

- Command:
  - `node --test test/wavepet-engine.test.js`
- Result:
  - PASS (`7` passing, `0` failing)

### Test command and result

- `node --test test/wavepet-engine.test.js`
  - PASS (`7` passing, `0` failing)
- `node --test test/wavepet-token-estimator.test.js`
  - PASS (`4` passing, `0` failing)
- `node --test test/wavepet-codex-event-adapter.test.js`
  - PASS (`7` passing, `0` failing)

### Files changed

- `src/wavepet/engine.js`
- `test/wavepet-engine.test.js`
- `.superpowers/sdd/task-3-report.md`

### Concerns

- No new functional concerns in scope.
