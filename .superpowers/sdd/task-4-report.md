# Task 4 Report: WavePet To Clawd Mapper

## What I implemented

- Added `src/wavepet/clawd-mapper.js` with `mapWavePetToClawd(waveState, options)`.
- Mapped WavePet states to existing Clawd logical states and display hints:
  - `reading_understanding` -> `thinking` / `clawd-working-thinking.svg`
  - `steady_work` -> `working` / `clawd-working-typing.svg`
  - `deep_output` -> `working` / `clawd-working-ultrathink.svg`
  - `overheat_debugging` -> `working` with `clawd-working-debugger.svg`, or `error` with no hint when `hardFailure: true`
  - `closing` -> `attention` when `completed: true`, otherwise `thinking` / `clawd-working-thinking.svg`
- Preserved the incoming WavePet payload under `wavepet` unchanged.
- Updated `themes/clawd/theme.json` `displayHintMap` to include:
  - `clawd-working-ultrathink.svg`
  - `clawd-working-typing-boss.svg`
- Added `test/wavepet-clawd-mapper.test.js` from the brief.

## What I tested and results

- `node --test test/wavepet-clawd-mapper.test.js` -> pass
- `node --test test/wavepet-engine.test.js` -> pass
- `node --test test/wavepet-token-estimator.test.js` -> pass
- `node --test test/wavepet-codex-event-adapter.test.js` -> pass

## TDD Evidence

### RED

- Command: `node --test test/wavepet-clawd-mapper.test.js`
- Output: `Error: Cannot find module '../src/wavepet/clawd-mapper'`
- Why expected: the test file imported the new mapper before the module existed, so the first run failed for the intended missing-file reason.

### GREEN

- Command: `node --test test/wavepet-clawd-mapper.test.js`
- Output: all 4 mapper tests passed
- Why expected: the mapper module and theme aliases were implemented to match the brief exactly.

## Files changed

- `src/wavepet/clawd-mapper.js`
- `test/wavepet-clawd-mapper.test.js`
- `themes/clawd/theme.json`

## Self-review findings

- The mapper keeps the WavePet object intact under `wavepet`.
- The theme now exposes both new display hints required by the mapper.
- Existing Clawd state names are reused; no new renderer behavior was introduced.

## Concerns

- None beyond the usual dependency on the existing Clawd SVG assets already present in `assets/svg`.
