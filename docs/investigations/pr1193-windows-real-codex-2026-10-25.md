# PR #1193: Windows real Codex acceptance (2026-10-25)

Result: **PASS** for plan progress and local Auto approval, after the Code Mode
plan ingestion and Windows canonical-path fixes in this revision.

## Environment and boundary

- Windows 10.0.26200, Node 24.12.0, Electron 41.10.4, Codex CLI 0.164.0.
- Native interactive Codex TUI, `gpt-6.1-sol`, actual installed official hooks,
  `tools.update_plan.enabled=true`, human reviewer and on-request approval.
- Full Clawd application from source, isolated home/preferences, Codex Auto mode,
  global permission automation off. State, plan and permission events were not
  fabricated. Read-only observers recorded the actual production runtime.
- This validates the source application with Windows dependencies, not an
  installer/package build. Daily Codex config/hooks and Clawd runtime hashes were
  unchanged; credentials and full transcripts were not exported.

## Observed behavior

1. Real Code Mode `update_plan` calls produced 0/3, 1/3, 2/3 and 3/3. The HUD
   reflected the ratios, and the Dashboard exposed the exact counts. Official
   structured PostToolUse events supplied the counts; later JSONL metadata did
   not erase them.
2. Actual PermissionRequest transitions preserved the current checklist.
   Completing the first turn retained 3/3 (100%). Resuming the same conversation
   and submitting a new turn cleared that completed checklist.
3. The accepted final resumed turn used a real Windows `\\?\C:\...` transcript
   path. Auto selected the current human-reviewed request, the visible bubble
   retained 1/2 (50%), and a native mouse click on its Allow button wrote and read
   back only the designated test proof file. The plan then reached 2/2 (100%),
   the session became idle, and no permission remained pending.
4. The final bubble was measured at 340 × 356 DIP, with the entire Allow button
   inside its visible viewport. HUD, Dashboard and bubble were inspected after
   layout settled. Early diagnostic rounds that captured during window creation
   interfered with first rendering and are excluded from visual acceptance;
   removing those early captures required no product/window code change.

## Regression checks

- Full local suite: 13,517 tests; 13,442 passed, 75 platform/environment skips,
  zero failures.
- Focused suite, including the added runtime source-arbitration test: 754 tests;
  753 passed, one Windows-only skip, zero failures.
- Real Windows path/parser suite: 31 tests; 30 passed, one POSIX-only skip.
  The namespaced-path case also rejects a foreign transcript and a wrong turn.
- Original direct-function-call JSONL support, bounded counts, local-only routing,
  old-turn rejection, new-turn clearing and permission recovery remain covered.
