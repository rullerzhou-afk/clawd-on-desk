# Task 8 Report: End-To-End Focused Regression Tests

## What I implemented

Added focused regression coverage for the Codex/WavePet coexistence path:

- `test/main-codex-log-suppress.test.js` now verifies that an official Codex hook session still suppresses the legacy lifecycle `response_item:function_call` update, while the raw Codex record path still produces a `wavepet:` mapped update.
- `test/registry.test.js` now asserts that `agents/codex.js` keeps `logEventMap["event_msg:agent_message"] === null`, so WavePet continues to consume raw records separately instead of reusing the old lifecycle mapping.

I did not change production code for this task.

## What I tested and results

Focused regression slice:

```bash
node --test test/main-codex-log-suppress.test.js test/registry.test.js
```

Result: passed, 13/13 tests green.

Required focused Codex/WavePet slice:

```bash
node --test test/wavepet-token-estimator.test.js test/wavepet-codex-event-adapter.test.js test/wavepet-engine.test.js test/wavepet-clawd-mapper.test.js test/wavepet-runtime.test.js
```

Result: passed, 26/26 tests green.

Required Codex monitor / runtime slice:

```bash
node --test test/codex-log-monitor.test.js test/agent-runtime-main.test.js test/main-codex-log-suppress.test.js test/registry.test.js
```

Result: passed, 75/75 tests green.

Full suite:

```bash
npm test
```

Result: failed because of the existing Electron install issue in this checkout, not because of the regression tests. The run ends with:

```text
Error: Electron failed to install correctly, please delete node_modules/electron and try installing again
```

## TDD Evidence

### RED

Command:

```bash
node --test test/main-codex-log-suppress.test.js test/registry.test.js
```

Output excerpt:

```text
✖ keeps lifecycle suppression while still allowing WavePet raw records through
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

3 !== 2
```

Why expected: the new regression test was written first and initially counted helper bookkeeping as part of the runtime call total, so it failed before I corrected the assertion to measure only the `updateSession` path.

### GREEN

Command:

```bash
node --test test/main-codex-log-suppress.test.js test/registry.test.js
```

Output excerpt:

```text
✔ suppresses guardian_assessment for hook-active Codex sessions
✔ keeps lifecycle suppression while still allowing WavePet raw records through
✔ should have logEventMap for poll-based agents
ℹ tests 13
ℹ fail 0
```

## Files changed

- `test/main-codex-log-suppress.test.js`
- `test/registry.test.js`
- `.superpowers/sdd/task-8-report.md`

## Self-review findings

- The new test in `main-codex-log-suppress.test.js` checks the exact coexistence boundary the brief asked for: legacy lifecycle suppression stays active, but the raw record path still emits a `wavepet:` update.
- The registry assertion keeps Codex's `event_msg:agent_message` mapping at `null`, which preserves the separation between the old lifecycle map and WavePet's raw-record processing.
- No production behavior was changed.

## Concerns

- `npm test` is still blocked by the local Electron installation problem in `node_modules/electron/index.js`. The focused Node test commands required by the brief pass cleanly, but the full suite cannot be claimed green in this environment until that baseline issue is fixed.
