# WavePet Codex State

WavePet is a Codex-specific state layer for Clawd. It maps Codex JSONL activity into persistent user-perceived waiting states:

- reading/understanding
- steady work
- deep output
- overheat debugging
- closing

WavePet does not estimate exact model compute or remaining turns. It is a presentation signal for the desktop pet.

## Manual Smoke

1. Start Clawd with Codex enabled.
2. Start a Codex session.
3. Ask a prompt that requires reading several files.
4. Confirm the pet shows a thinking or reading visual.
5. Ask for a code edit.
6. Confirm the pet shows active working.
7. Ask for a long explanation or wait through a long command.
8. Confirm the pet shows a deep-output style visual.
9. Trigger a failing test.
10. Confirm the pet shows a debugging style visual.
11. Let the turn complete.
12. Confirm completion still uses the existing happy/attention behavior and does not double-fire.
