# #655 — Local Codex archive lifecycle

Status: implementation plan approved for delegation by the user on 2026-09-13.
Baseline: `18e64ec8a026f61c398b70899296ae02582fa1ae`.
Branch: `fix/codex-archive-655`.
Owner task: `01a09889-25ff-75a3-8f1d-2ef81bd52a83`.
Contributor report: https://github.com/rullerzhou-afk/clawd-on-desk/issues/655 (reported by @200780381).
Maintainer response: https://github.com/rullerzhou-afk/clawd-on-desk/issues/655#issuecomment-5650333859

## Problem and outcome

Local Codex tasks remain in Clawd HUD/focus surfaces after being archived. The existing generic/desktop idle timeout does not establish archive state. The current JSONL monitor treats a moved file as a read error, without retiring the task.

A completed, unarchived task must retain its existing behavior. Once positive local archive evidence is detected, its live Clawd card/focus entry must be removed promptly (target within one ordinary background check, about 10 seconds for normal-sized data). Other local Codex tasks, even those sharing a process, remain untouched. Later stale hook/JSONL activity must not recreate an entry while its archive evidence remains valid. After an actual unarchive, subsequent real activity can create the task again.

This is only the Codex half of #655. Do not change WorkBuddy, close #655, or use “Fixes #655” in a commit/PR description.

## Evidence and current interfaces

- OpenAI official archive contract: https://learn.chatgpt.com/docs/app-server#archive-a-thread — archive moves persisted JSONL into archived sessions and emits thread/archived. Clawd does not currently own an app-server connection and must not add one just for this fix.
- Local installed Codex CLI: 0.154.0. Existing local archive layout observed read-only: a flat archived_sessions directory with rollout-*.jsonl files. Do not infer arbitrary recursive layouts or read real conversation bodies while developing.
- `agents/codex-log-monitor.js:_pollFile` stat error returns an error only. Its tracked-file capacity is bounded; official-hook-only sessions and sessions outside that tracked set still need archive handling.
- `src/agent-runtime-main.js` owns local monitor callbacks, official-hook arbitration, turn fences and session updates. `getStateRuntime().sessions` is the live session source.
- `src/state.js:dismissSession` already retires live state and cancels completion-related timers, then broadcasts snapshots. Reuse the lifecycle owner rather than deleting Map entries behind its back. If an additional retirement helper is needed, make it narrow and reasoned.
- `src/state-session-snapshot.js` drives HUD, Dashboard, menu and focus metadata; avoid separate HUD-only filtering that leaves other active focus routes stale.
- `hooks/codex-session-index.js` already resolves CODEX_HOME/default home and strips the codex: prefix. Reuse/factor small existing helpers where appropriate, without expanding hook dependency closure unnecessarily.

## Implementation approach

1. Add a small runtime-owned archive tracker, composed in agent-runtime-main; use injectable filesystem/root/timer dependencies for focused tests. Keep archive observation separate from JSONL turn-content parsing, so it works for official hooks and sessions untracked by the monitor.
2. Resolve the configured local Codex home (trimmed nonempty CODEX_HOME, otherwise ~/.codex). Observe only its archived_sessions and relevant live candidate IDs. Never infer local archive status for remote SSH profiles, WSL, another agent, or an unrelated profile with a colliding raw ID.
3. Use positive, validated file evidence. Check a regular rollout JSONL under the archive root, exact canonical task identity, and bounded metadata sufficient to distinguish a matching rollout from a malformed/unrelated filename. Do not follow arbitrary symlinks or accept traversal input. Missing active file, permission denied, unreadable metadata, malformed files, partial scans and I/O errors are UNKNOWN, not proof of archive.
4. Keep I/O asynchronous and bounded. No synchronous full archive scan in snapshot building, a HTTP hook, or every session update. Bound per-batch enumeration/metadata reads and retained caches; avoid silently declaring unscanned entries unarchived. Do not permanently miss entries beyond an arbitrary cap. Use generation/cancellation guards so disable, cleanup, newer activity or a changed root cannot be affected by stale async work.
5. Reconcile positive archive evidence with current live state immediately before retirement. Reuse existing cancellation, snapshot and focus cleanup paths. Archive is not a new completion: do not play success, increment recap completions, send a completion push, or fabricate a permission allow/deny. If an owned pending prompt must be dismissed, use the existing no-decision semantics scoped to that session only.
6. Gate late lifecycle callbacks against currently confirmed archive evidence; do not block session-independent account quota ingestion. Refresh/revalidate evidence so unarchive clears suppression and fresh activity can resume. Unknown errors alone must neither newly retire sessions nor be presented as a successful unarchive. Do not make archive suppression permanent.
7. Start/stop alongside the enabled local Codex runtime; clean up timers, iterators and pending work on disable/shutdown. Keep existing timeout preferences, replay fences, hook-primary arbitration, subagent attribution and other agent semantics intact.
8. Update the durable runtime architecture document with the narrow behavior and limits. Do not add settings, a database dependency, network service, native app-server bridge, generalized lifecycle framework, or history/resume feature rewrite.

The implementer may select simpler mechanics that satisfy these boundaries. State any deviation and its evidence. If a requirement cannot be met safely, report it instead of loosening it silently.

## Required meaningful tests

- Same completed task remains visible before archive and retires after positive archive evidence even with the process alive and idle timeout disabled.
- Two independent local tasks sharing a PID: archive one, retain the other.
- Official-hook session not present in JSONL monitor's tracked files is covered.
- Exact identity and source scoping: local/remote/WSL same raw ID, malformed/traversal IDs, mismatched metadata, symlink/non-regular file, unrelated filename.
- Missing active file alone, missing archive directory, permission error, truncated metadata and interrupted/partial scans cause no new destructive decision.
- Known archived task cannot be recreated by late official hook, JSONL lifecycle or passive user-input callbacks; account quota remains independent.
- Archive then unarchive permits a subsequent fresh real event; obsolete async results do not re-retire a task after restoration.
- Dispose/disable/root-generation changes cancel work and prevent late effects.
- Bounded discovery across a directory larger than one batch eventually reaches late candidates; no synchronous hot-path scan.
- Archive retirement does not emit completion/recap or fabricate permission decisions, and removes active HUD/focus surfaces consistently.

Run focused suites appropriate to the actual changed seams; include agent-runtime-main, Codex monitor/callback/turn-fence, snapshot/state cleanup and relevant permission tests. Run broader tests once after meaningful coverage passes; compare unrelated failures to baseline rather than hiding them.

## Native acceptance and evidence

Codex parent will independently inspect the diff and test results. Use an isolated official Codex app-server/CLI process with synthetic test-owned local session data to validate real archive/unarchive filesystem behavior when feasible, without running a model or touching real user tasks/config. This establishes the upstream runtime/filesystem layer, not a GUI claim. Real Clawd/Codex GUI interaction remains a separately stated acceptance layer unless actually exercised.

Retain precise base/final commits, focused test outputs and full formal implementer/reviewer reports outside the repository in the task evidence directory. No raw private session/prompt logs in project docs. No push, PR creation, merge, deployment, hook installation, proxy changes or external comments by delegates.

## Handoff sequence

1. 云宝: plan and authorized issue reply.
2. 鲸宝: implement and validate on the isolated branch, then provide a formal handoff with changed files, evidence and limits.
3. Claude: independently adversarial-review an exact snapshot of the completed implementation; report concrete findings, do not modify code.
4. 云宝: independently adjudicate every finding, send valid issues back to the same 鲸宝 session, obtain follow-up review as needed, and perform final verification.

No self-approval or clean-looking test counts substitute for this sequence.
