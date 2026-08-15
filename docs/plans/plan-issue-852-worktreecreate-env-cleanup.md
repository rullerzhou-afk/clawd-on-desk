# Plan: #852 ownership-safe cleanup for env-indirected `WorktreeCreate` hooks

> Status: **Implemented; automated verification and the macOS Claude Code release gate passed after post-review corrections.**
> Date: 2026-08-13
> Issue: https://github.com/rullerzhou-afk/clawd-on-desk/issues/852
> Scope: Claude Code hook ownership, registration/reconciliation/uninstall,
> watcher accounting, health diagnostics, and regression coverage

---

## 0. Decision summary

Issue #852 contains a real, reproducible cleanup gap, but its historical attribution
is not supported by the repository evidence.

- Clawd did register `WorktreeCreate` from the first commit and mapped it to the
  `carrying` animation. That handler only reported state; it never implemented
  Claude Code's worktree-provider contract.
- PR #129 correctly stopped registering the event and added marker-scoped cleanup
  for old commands containing the literal filename `clawd-hook.js`.
- A command that refers to the script indirectly as `${CLAWD_HOOK_PATH}` is not
  recognized by that cleanup. If `settings.env.CLAWD_HOOK_PATH` resolves to
  `clawd-hook.js`, Claude still executes the obsolete notification-only hook and
  native worktree creation fails because the hook returns no path.
- No released Clawd installer, reachable branch/tag/reflog, recovered unreachable
  object, or public GitHub source contains `CLAWD_HOOK_PATH` or `CLAWD_NODE_BIN`.
  The env-indirected form is therefore an external compatibility case, not evidence
  of an official historical "env-var command refactor."

The fix should nevertheless support that external form, but only when both the
command syntax and `settings.env` value prove the same filename-level ownership that
the existing literal marker already uses. A bare occurrence of `CLAWD_HOOK_PATH` or
`CLAWD_NODE_BIN` is not sufficient ownership evidence.

The repair must also handle the likely current state of an affected machine: because
today's installer does not recognize the env form, it appends a canonical literal
hook beside it. A correct migration must fold all owned state hooks for each event to
one survivor. It must never rewrite a working env-indirected hook to bare `node` when
an absolute executable cannot be resolved, and the Claude settings watcher must not
count the env-owned hook as third-party content before removing or migrating it.

## 1. Verified history and current behavior

### 1.1 What Clawd originally implemented

Commit `02d00a40` registered `WorktreeCreate` and mapped it to `carrying`. The hook:

1. read the Claude hook payload for session metadata;
2. posted a state update to Clawd;
3. exited successfully with empty stdout.

The complete Git history contains no `git worktree add`, `worktree_name`,
`base_ref`, stdout path, or `hookSpecificOutput.worktreePath` implementation.
The surviving mappings in `hooks/clawd-hook.js`, `agents/claude-code.js`, UI text,
and animation documentation are state/animation compatibility, not a worktree
creator.

Claude Code treats `WorktreeCreate` as a work-performing replacement for its default
Git behavior. Once configured, a command hook must create the worktree and print its
absolute path. The old Clawd hook therefore blocked `claude -w` despite exiting 0.
PR #129 removed the event from `CORE_HOOKS`, retained the animation mapping as a
possible future observation path, and added cleanup for literal Clawd commands.

### 1.2 The present cleanup gap

The synchronous registration path currently removes deprecated hooks with:

```js
removeMatchingCommandHooks(
  settings.hooks[event],
  (command) => command.includes(MARKER)
);
```

The asynchronous registration path has the same predicate. Uninstall, versioned-hook
reconciliation, and stale command cleanup for HTTP-only events also rely on literal
marker checks.

Given:

```json
{
  "env": {
    "CLAWD_NODE_BIN": "/opt/homebrew/bin/node",
    "CLAWD_HOOK_PATH": "/Applications/Clawd on Desk.app/Contents/Resources/app.asar.unpacked/hooks/clawd-hook.js"
  },
  "hooks": {
    "WorktreeCreate": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAWD_NODE_BIN}\" \"${CLAWD_HOOK_PATH}\" WorktreeCreate",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

both `registerHooks()` and `registerHooksAsync()` report `removed: 0`; the obsolete
entry remains. `unregisterHooks()` and `unregisterHooksAsync()` leave it behind too.
This behavior has been reproduced with isolated temporary settings files.

There is a second current-state regression that the implementation fixture must
model. Running today's registration once against an active env-indirected state hook
does not recognize it; the installer appends a canonical literal hook. The event then
has two Clawd state commands. Merely changing `syncCommandHook()` to match the env
form is insufficient: it currently rewrites every match, so both entries become
byte-identical canonical commands and remain duplicated forever.

### 1.3 Evidence limits that must remain explicit

The implementation and PR must not claim that Clawd generated the env-indirected
form. The investigation covered:

- all reachable local and remote refs, tags, and reflogs;
- every release-era installer implementation;
- the unreachable commits and recoverable small blobs available at investigation
  time (the exact count is intentionally omitted because Git GC changes it);
- public GitHub code search for both variable names.

All searches returned zero Clawd sources for `CLAWD_HOOK_PATH` and
`CLAWD_NODE_BIN`. The likely sources are a user edit, a third-party configuration
manager, or an external migration script. The reporter should be invited to provide
a redacted historical `settings.env`, `hooks.WorktreeCreate`, and provenance, but a
response is not required to implement a fail-closed compatibility rule.

There is also positive timeline evidence against the reported entry being a direct
Clawd installer artifact. PR #129's merge commit `ef5a0b8a` removed
`WorktreeCreate` on 2026-04-18. Commit `996dabcb` (#349) introduced both
`timeout: 5` and `async: true` for Clawd state hooks on 2026-05-27, and is a
descendant of `ef5a0b8a`. Therefore no Clawd version could have emitted a
`WorktreeCreate` state hook with `timeout: 5`, and Clawd never emitted the reported
combination of `timeout: 5` without `async: true`. The compatibility case remains
real; its asserted Clawd provenance does not.

## 2. Required contracts

The change must satisfy all of these contracts:

1. Literal commands containing `clawd-hook.js` retain their current managed-marker
   behavior.
2. An env-indirected command is managed only when it contains an exact supported
   reference to `CLAWD_HOOK_PATH` **and** the parsed settings object's own
   `env.CLAWD_HOOK_PATH` value is a non-empty string whose cross-platform basename is
   exactly `clawd-hook.js`.
3. `CLAWD_NODE_BIN` is never ownership evidence by itself.
4. Missing, malformed, nested, indirectly defined, or third-party env values fail
   closed: preserve the hook.
5. Do not perform general shell expansion, consult `process.env`, execute a shell, or
   resolve arbitrary variables while inspecting settings.
6. Do not delete or rewrite `settings.env.CLAWD_HOOK_PATH` or
   `settings.env.CLAWD_NODE_BIN`. They may be shared by user tooling.
7. Preserve unrelated hooks, including siblings within the same nested hook entry.
8. Synchronization and uninstallation must have sync/async parity.
9. Active Clawd state hooks using the proven env-indirected form must converge to
   exactly one owned command per event. When a safe canonical target is available,
   prefer an already-canonical entry, otherwise rewrite one owned survivor, and
   remove all additional owned siblings/wrappers. An env entry beside a canonical
   entry is deleted, not rewritten into a second canonical copy.
10. `WorktreeCreate` remains absent from `CORE_HOOKS`; this change must not revive a
    Clawd worktree provider or change `clawd-hook.js` stdout.
11. Existing atomic-write, backup, symlink-preservation, and server-owned Claude hook
    operation queue behavior must remain unchanged.
12. Migration must not downgrade the Node executable. If no usable absolute Node
    path can be resolved, keep one proven env-indirected active hook as the survivor
    instead of rewriting it to bare `node`; remove any additional Clawd-owned
    duplicates that can be folded into that survivor.
13. The env-indirected ownership branch accepts only a single simple command
    invocation. Shell composition or substitution (`&&`, `;`, `|`, `$(`, redirects,
    or trailing commands) fails closed even if the command mentions the variables.
14. Installer mutation, watcher third-party accounting, and health inspection must
    share the same env-ownership classification. One subsystem must not call an
    entry Clawd-owned while another calls it third-party or missing.

## 3. Ownership design

### 3.1 Add one shared, settings-aware classifier

Put the pure command/settings classification in `hooks/json-utils.js`, which is
already shared by the installer and health code and is already part of the Remote
SSH hook-file manifest. Do not make the read-only health inspector import the
mutation-oriented installer. Expose a helper conceptually shaped as:

```js
classifyManagedClaudeStateHookCommand(command, settings, event)
// => "literal" | "env" | null
```

Build it on a separate pure syntactic recognizer for the narrow env invocation. The
health inspector may use that recognizer to report `env-indirection-unverified` when
the command shape matches but `settings.env.CLAWD_HOOK_PATH` is absent or does not
prove ownership. That diagnostic is read-only and non-automatic: mutation still sees
`null`, preserves the hook, and watcher accounting still counts it as third-party.

The literal branch retains today's `clawd-hook.js` marker semantics unchanged. The
new env branch returns `"env"` only when all of the following hold:

- `settings.env` is an object with its own `CLAWD_HOOK_PATH` property;
- the value is a trimmed, non-empty direct path whose cross-platform basename is
  exactly `clawd-hook.js`;
- the command is a single simple POSIX-style invocation whose interpreter token is
  either `${CLAWD_NODE_BIN}` / `$CLAWD_NODE_BIN`, a direct absolute Node path, or the
  exact bare token `node`, followed by `${CLAWD_HOOK_PATH}` /
  `$CLAWD_HOOK_PATH`;
- a “direct absolute Node path” is absolute under POSIX or Windows path semantics,
  contains no variable/substitution/control syntax, and has a case-insensitive
  basename exactly equal to `node` or `node.exe`, matching the narrow candidate
  semantics of `src/doctor-detectors/agent-node-bin-parser.js` rather than accepting
  an arbitrary absolute executable;
- variable tokens may be unquoted or double-quoted only; single quotes are rejected
  because POSIX shells would not expand variables inside them;
- its sole trailing argument is the enclosing Claude event name; and
- there are no shell control, redirection, command-substitution, prefix/suffix, or
  trailing-command tokens.

This deliberately supports only the POSIX-shell form evidenced by #852. Variable
expansion is performed by the shell that runs the hook, not by Claude Code itself.
On Windows Clawd writes `shell: "powershell"`, where `${VAR}` is not environment
variable syntax, so V1 must not invent `%VAR%` or `$env:VAR` compatibility without a
real sample. It also must not support `${VAR:-default}`, nested expansion, or values
exported only from `.zshrc`/`process.env`.

The interpreter token narrows the accepted simple-command grammar but is not
ownership evidence. Ownership comes from the exact `CLAWD_HOOK_PATH` token, the
matching event argument, and `settings.env.CLAWD_HOOK_PATH` basename proof. Requiring
`CLAWD_NODE_BIN` as a second variable would contradict that separation and miss
externally rewritten commands that kept a literal absolute Node path or bare `node`.

Implement the absolute-Node candidate check locally in `hooks/json-utils.js` using
its existing Node built-ins; do not import `../src/doctor-detectors/agent-node-bin-parser.js`
or any other path outside `hooks/`. `json-utils.js` is deployed in Remote SSH's
`HOOK_FILES`, while remote hosts receive no `src/` tree. Sharing code through a
reverse `../src/...` edge would pass the current manifest regexes yet fail remotely
with `MODULE_NOT_FOUND`. Semantic consistency here is required; a new cross-layer
runtime dependency is forbidden.

The classifier must reject examples such as:

```text
$CLAWD_HOOK_PATH_SUFFIX
${NOT_CLAWD_HOOK_PATH}
echo CLAWD_HOOK_PATH
"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" WorktreeCreate && do-something
"${CLAWD_NODE_BIN}" "${CLAWD_HOOK_PATH}" WorktreeCreate; notify-user
'${CLAWD_NODE_BIN}' '${CLAWD_HOOK_PATH}' WorktreeCreate
```

The env value must reject examples such as:

```text
/opt/company/user-worktree.js
/opt/clawd-hook.js.backup
${ANOTHER_PATH}/clawd-hook.js
```

The filename check intentionally matches the existing marker policy's ownership
granularity. Requiring the current absolute packaged path would fail to clean stale
paths from older app versions. Requiring the simple invocation, event argument, exact
hook-path variable token, constrained Node interpreter token, and settings value
prevents that filename-level rule from claiming an arbitrary user worktree provider.

### 3.2 Apply the predicate consistently

Thread the settings-aware predicate through every operation that currently treats
the Clawd state-hook marker as ownership evidence:

| Path | Required behavior |
|---|---|
| `registerHooks()` deprecated hook cleanup | Remove the proven env-indirected `WorktreeCreate` hook. |
| `registerHooksAsync()` deprecated hook cleanup | Same result as sync. |
| Active core-hook synchronization | Collect all literal/env-owned state hooks for the event, choose one survivor, canonicalize it only with a trusted absolute Node resolution or an access-checked strict env candidate, and remove all other owned hooks while preserving mixed third-party siblings. |
| Versioned-hook reconciliation | Remove an unsupported env-owned Clawd state hook under the same version rules as a literal hook. |
| HTTP-only command cleanup | Remove an env-owned stale command hook such as an obsolete `PermissionRequest` command entry. |
| `unregisterHooks()` | Remove env-owned Clawd state hooks while preserving top-level env and third-party hooks. |
| `unregisterHooksAsync()` | Same result as sync. |
| `src/claude-settings-watcher.js` snapshots | Exclude strict env-owned state hooks from the third-party count, so Clawd's own cleanup cannot trigger suspicious-shrink accounting. |
| `src/claude-hook-health.js` inspection | Classify commands before target validation. Literal commands keep the existing validator; strict env-owned commands bypass it and map to dedicated env issue codes, because `${CLAWD_NODE_BIN}` / `${CLAWD_HOOK_PATH}` are intentionally unexpanded literals to that validator. |

Replace the state-hook use of `syncCommandHook()` with a child-level fold operation;
the current visitor rewrites every match and cannot remove duplicates. The fold must
work for flat entries and nested `entry.hooks[]` children:

1. classify every command child for the enclosing event;
2. when a safe canonical target exists, prefer an already-identical canonical child,
   otherwise reuse the first owned child and rewrite it;
3. remove every other owned child, pruning only wrappers that become empty under the
   existing structure rules; and
4. when no safe canonical target exists, preserve a literal child if one exists;
   only an env-only event prefers one strict env child unchanged. Remove the other
   owned duplicates instead of writing bare `node` or deleting a working literal
   command in favor of an unverifiable env command.

Auto-start matching continues to use `auto-start.js` / `auto-start.sh` and can keep
its existing sync helper. `CLAWD_HOOK_PATH` identifies only the state hook and must
not claim auto-start entries.

Health inspection must collect per-child records rather than only command strings,
retaining the enclosing event and child identity needed for classification and
duplicate detection. Apply these issue rules before calling `validateHookCommand()`:

- literal-marker state commands continue through the existing Node/script validator;
- strict env-owned commands never enter that validator, because its POSIX absolute
  path checks necessarily classify `${CLAWD_NODE_BIN}` / `${CLAWD_HOOK_PATH}` as
  `node-bin-invalid` / `script-path-missing`;
- a strict env-owned command with a safe absolute migration target emits
  `env-hook-migratable` with `automaticRepairable: true`;
- a strict env-owned command without a safe target emits
  `env-hook-node-unresolved` with `automaticRepairable: false`;
- a syntactically recognizable but ownership-unverified env command emits
  `env-indirection-unverified` with `automaticRepairable: false`; and
- more than one **installer-owned** state command for an event emits
  `duplicate-managed-state-hook` with `automaticRepairable: true`, because the fold
  can remove extras even if an env survivor cannot yet be canonicalized. A legacy
  PowerShell `EncodedCommand` that health can decode for read-only validation but the
  installer cannot claim does not participate in this automatic duplicate count.

Every new automatic issue code (`env-hook-migratable` and
`duplicate-managed-state-hook`) must be registered in
`REPAIR_CLASS_BY_CODE`. The two non-automatic codes must not be registered. This is a
functional requirement, not bookkeeping: an automatic issue omitted from the map
produces a null repair signature and is silently treated as having no repair work;
an env command accidentally fed into the legacy validator produces an automatic
legacy signature and burns all three repair attempts even though the installer
intentionally preserves it.

### 3.3 Resolve Node without destructive fallback

Treat ownership and executable discovery as separate decisions. A direct absolute
`settings.env.CLAWD_NODE_BIN` is not ownership evidence, but after at least one
command has independently passed the strict `CLAWD_HOOK_PATH` ownership classifier,
it may be used as an executable-path fallback.

Preserve the existing explicit/resolver/literal-path behavior, then consider the env
candidate before falling back to `"node"`. For the env candidate:

- require a trimmed direct absolute path under cross-platform path semantics;
- reject variables, shell syntax, or a basename-only `node` token;
- apply the same platform access rule as the existing async extracted-path check
  (`X_OK` on POSIX, `F_OK` on Windows), with injectable filesystem seams for tests;
- never mutate or delete `settings.env.CLAWD_NODE_BIN`; and
- require sync and async paths to make the same decision for the **new env Node
  candidate** under equivalent injected resolver/access results.

Do not reuse that strict env-data predicate for an already resolved Node path. The
installer's explicit caller choice, resolver output, and preserved literal path are
the same trusted values already serialized into every normal core hook; an absolute
path such as `C:\Program Files (x86)\nodejs\node.exe` or `/usr/bin/nodejs` must not
be rejected merely because it falls outside the deliberately narrower grammar for
untrusted `settings.env` input. Mixing these two trust classes can make health report
`env-hook-migratable` while registration refuses to migrate, exhausting the watcher
repair budget.

Do not otherwise normalize the pre-existing literal-path behavior while implementing
this issue. The sync path intentionally preserves an extracted literal Node path
without an access check, while the async path validates it (`X_OK` on POSIX, `F_OK`
on Windows); #317 tests lock that difference. Parity in this plan is scoped to the
new env candidate and final mutation result under controlled fixtures, not permission
to refactor #317's resolver policy.

Only an explicit or discovered usable absolute path is safe for canonicalizing an
env-owned active hook. Bare `node` remains the legacy last resort for unrelated fresh
installation behavior, but it must not replace an existing env-owned command. If no
safe path exists, retain one env command, fold away owned duplicates, expose a
non-auto-repairable Doctor/health diagnostic, and avoid a watcher repair loop.

### 3.4 Preserve structure and persistence behavior

Keep `removeMatchingCommandHooks()` only for paths whose semantics are “remove every
owned match”: deprecated cleanup, unsupported versioned hooks, stale HTTP-only
commands, and uninstall. Its `(command) => boolean` API cannot implement active
one-survivor folding when two children have identical command strings.

Active state synchronization requires a new position-aware fold helper. It must
identify children by their structural position (flat entry index, or entry index plus
nested hook index), not by command value or object reference. Today's installer can
rewrite two stale literal commands into byte-identical canonical commands, and
`removeMatchingCommandHooks()` also clones wrappers while filtering, so neither
string identity nor preselected object identity can express “keep this one, remove
the other.” The new helper must apply the same structure-preservation rules:

- remove only the matching child from a mixed nested entry;
- keep non-command hooks and third-party command siblings;
- keep auto-start children even under `SessionStart`;
- preserve every wrapper-level field such as `matcher` unchanged while replacing its
  `hooks` array;
- drop a wrapper only when its `hooks` array has no remaining children and the
  wrapper is not itself a flat command entry; and
- delete the event key only when no entries remain.

The parsed `settings.env` object is evidence only. It must round-trip unchanged
through registration and uninstall. Existing atomic backup/write helpers remain the
only persistence path.

## 4. Files and implementation sequence

### 4.1 `hooks/json-utils.js`

1. Add the pure simple-invocation parser/classifier used by mutation, snapshots, and
   health inspection. Inline the small absolute `node` / `node.exe` basename check
   with `path.posix` / `path.win32` semantics; `hooks/json-utils.js` must remain a
   Node-builtins-only leaf and must not require anything under `../src` or otherwise
   outside `hooks/`.
2. Keep the literal-marker branch behavior-compatible with today.
3. Keep the narrow syntactic recognizer independently usable for read-only health
   diagnostics when settings ownership is unverified.
4. Add a direct-absolute env Node candidate reader that does not perform expansion or
   imply ownership.
5. Prefer black-box installer/watcher/health tests; add narrow utility tests only for
   lexical boundary and compound-command failures that are hard to diagnose through
   an installer fixture.

### 4.2 `hooks/install.js`

1. Replace state-hook synchronization with a new position-aware one-survivor fold;
   do not reuse either the all-matches rewrite behavior of `syncCommandHook()` or the
   string-predicate API of `removeMatchingCommandHooks()`.
2. Pass the shared classifier into versioned, deprecated, HTTP-only, and uninstall
   cleanup in both sync and async paths.
3. Add the validated env Node fallback and the no-bare-node migration guard.
4. Keep the existing helper for auto-start, whose ownership markers are unchanged.
5. Make removal output generic (for example, `obsolete or incompatible managed
   hooks`) rather than calling every cleanup an incompatible versioned hook.

### 4.3 Watcher and health surfaces

1. In `src/claude-settings-watcher.js`, make snapshot accounting settings-aware and
   exclude strict env-owned state commands from `thirdPartyHookCount`.
2. In `src/claude-hook-health.js`, replace/extend
   `findMarkerCommandsForEvent()` so inspection retains event and child records rather
   than returning only strings. Classify before validation: only literal-marker
   records enter `validateHookCommand()`; env-owned records map directly to
   `env-hook-migratable` or `env-hook-node-unresolved`.
3. Register every automatic env/duplicate issue in `REPAIR_CLASS_BY_CODE`, and assert
   its non-null signature. Keep unresolved/unverified codes out of that map and
   assert that `hasNoAutomaticRepairWork()` is true for them, so they never consume
   the three repair attempts.
   A syntactically matching env command that lacks `settings.env` ownership proof is
   also a visible, non-mutating `env-indirection-unverified` diagnostic, covering
   variables exported only from a shell profile without claiming the hook.
4. Update both watcher no-repair branches—the initial inspection path and the
   post-repair verification path—so unresolved/unverified diagnostics consistently
   report degraded instead of healthy and do not seed a misleading third-party
   snapshot. Whether a repair happened earlier in the cycle must not change the
   final status for the same diagnostic.
5. If needed, add a concise explanation in
   `src/doctor-detectors/agent-integrations.js` so Doctor tells the user that the env
   hook was preserved because its Node path could not be safely resolved.

### 4.4 Tests

Add behavior-level fixtures to `test/install.test.js` plus focused coverage in the
existing Claude watcher/health test files. Avoid a suite that only proves a regex;
the essential contracts are mutation shape, deduplication, accounting, repairability,
and sync/async parity.

Also harden `test/remote-deploy.test.js` as part of this change. Its dependency-closure
scanner must recognize both `./...` and `../...` static CommonJS specifiers. Resolve
each relative target from the requiring file, assert that every `HOOK_FILES` runtime
dependency remains inside `hooks/`, and then assert the normalized in-hooks target is
also present in `HOOK_FILES`. Keep the existing bare-package/builtin check. This closes
the current blind spot where `require("../src/...")` matches neither manifest regex
and a remote-only `MODULE_NOT_FOUND` can ship behind a green local suite.

### 4.5 Durable documentation and intentionally unchanged surfaces

After implementation, update the marker-scoped cleanup description at the relevant
Claude hook section of `docs/project/agent-runtime-architecture.md` (currently near
line 258) to describe the strict legacy env-indirection exception, one-survivor fold,
and fail-closed Node behavior. Do not rewrite release notes until the target release
is known.

`hooks/cleanup-integrations.js` already delegates Claude cleanup to
`unregisterHooks()`, so About cleanup inherits the fix and needs no separate mutation
logic. The literal checks in `src/doctor-detectors/agent-descriptors.js` and the WSL
installation detector may remain: an env-only configuration can continue to appear
uninstalled, and Install/Fix is the supported entry into migration. Record this
intent in code comments/tests so it is not rediscovered as an omission.

Apart from watcher/health accounting, no changes are expected in
`hooks/clawd-hook.js`, `agents/claude-code.js`, the agent registry, state mapping,
permission routing, or Settings persistence architecture.

## 5. Required regression matrix

### 5.1 Positive ownership cases

1. Use the reporter's exact nested `WorktreeCreate` command, including `timeout: 5`;
   it is removed when `settings.env.CLAWD_HOOK_PATH` ends in `clawd-hook.js`.
2. The unbraced `$CLAWD_NODE_BIN` / `$CLAWD_HOOK_PATH` simple form behaves the same
   way.
3. `"/opt/homebrew/bin/node" "${CLAWD_HOOK_PATH}" WorktreeCreate` and
   `node "${CLAWD_HOOK_PATH}" WorktreeCreate` are recognized under the same ownership
   proof; the absence of a `CLAWD_NODE_BIN` token is not a rejection reason.
4. An active env-only state hook plus a valid absolute env Node fallback migrates to
   exactly one current canonical command while preserving the entire `settings.env`
   object/value content unchanged.
5. An active env hook and an already-canonical hook under the same event fold to the
   existing canonical survivor. A second registration is a no-op and the event still
   has exactly one owned command.
6. Multiple env/literal owned duplicates in flat and nested wrappers fold at child
   granularity without deleting a mixed third-party sibling.
7. Two stale literal-marker hooks that the old synchronizer would rewrite to the same
   canonical string fold to exactly one child, proving the helper does not rely on
   command-string or object-reference identity.
8. `SessionStart` containing one auto-start hook, one env-owned state hook, and one
   canonical state hook ends with exactly one auto-start child and one state child.
9. A preserved third-party child keeps its original `timeout`, `async`, `shell`, and
   other fields byte-for-byte at the object/value level.
10. Versioned-hook reconciliation removes an unsupported strict env-owned command.
11. HTTP-only cleanup removes a strict env-owned stale `PermissionRequest` command
   while preserving the current Clawd HTTP hook and third-party entries.
12. Sync and async registration from identical fresh fixtures produce deeply equal
   settings and compatible result counters. Running async registration after sync on
   the same fixture produces no further file change.
13. Sync and async uninstall remove env-owned state hooks and preserve all top-level
    env keys verbatim.
14. Watcher snapshots classify strict env-owned commands as managed, and their
    migration/removal does not satisfy `isSuspiciousShrink()` even when another
    independently unhealthy condition is present.
15. Health repair converges in both directions:
    - safe absolute Node: `env-hook-migratable` and duplicate issues produce a
      non-null repair signature, one repair folds/migrates them, and verification is
      healthy;
    - no safe Node: `env-hook-node-unresolved` produces a null signature,
      `hasNoAutomaticRepairWork()` is true, repeated checks do not increment attempts,
      runtime status is degraded rather than healthy, and status never reaches
      `manual-fix-required`.
16. All-delete paths must not inherit survivor semantics: put two strict env-owned
    obsolete commands under `WorktreeCreate` (one using `CLAWD_NODE_BIN`, one using a
    direct absolute Node path). Registration removes both and deletes the empty event
    key. Apply equivalent multi-match assertions where practical to versioned,
    HTTP-only, and uninstall coverage.
17. An env command beside an existing literal command with a trusted absolute Node
    path outside the strict env-data grammar (including a Windows `(x86)` path and a
    POSIX `nodejs` basename) preserves/canonicalizes the literal survivor and removes
    the env duplicate.
18. A health `env-hook-migratable` signature followed by real installer repair and
    health reinspection must converge to a null signature. An encoded command that
    is read-only-visible to health but not mutation-owned must not create an automatic
    duplicate-repair signature the installer cannot clear.

### 5.2 Fail-closed cases

Each of these must preserve the hook:

1. `settings.env` is absent or not an object.
2. `CLAWD_HOOK_PATH` is absent, empty, or non-string.
3. The command contains only `CLAWD_NODE_BIN`.
4. `CLAWD_HOOK_PATH` points to `user-worktree.js`.
5. It points to `clawd-hook.js.backup` or a similarly named file.
6. The command uses `CLAWD_HOOK_PATH_SUFFIX`, `NOT_CLAWD_HOOK_PATH`, or plain text
   without an exact variable reference.
7. The env value itself contains another variable rather than a direct path.
8. A third-party `WorktreeCreate` hook shares the same event or wrapper.
9. The otherwise matching command is compound or substituted (`&&`, `;`, `|`, `$(`,
   redirection, a prefix command, or a trailing command).
10. The command's trailing event token does not match its enclosing settings event.
11. On the Node fallback path, `nodeBin: null` plus an env-only active hook with a
    missing, non-absolute, inaccessible, or indirect `CLAWD_NODE_BIN` must never
    rewrite that hook to bare `node`. One env survivor remains, duplicates are folded,
    and health reports a non-automatic unresolved-Node diagnostic.
12. Single-quoted `$CLAWD_HOOK_PATH` / `${CLAWD_HOOK_PATH}` is not owned because a
    POSIX shell will not expand it; preserve it and optionally surface the read-only
    unverified-indirection diagnostic. This is intentionally preserving a broken
    external configuration under fail-closed ownership rules, not claiming that the
    single-quoted hook can execute successfully.

For cases 1, 2, and 7 where the simple command syntax is recognizable but settings
cannot prove ownership, add a read-only `env-indirection-unverified` health/Doctor
assertion. It must not trigger mutation, automatic repair, or managed-hook accounting.

### 5.3 Existing invariants

Retain or extend assertions that:

- a fresh installation does not register `WorktreeCreate`;
- literal-marker cleanup from #129 still works;
- cleanup is idempotent;
- unrelated hooks and HTTP entries remain untouched;
- a cleanup-only mutation (`added: 0`, `removed > 0`) creates the expected backup and
  persists atomically;
- no-op second registration creates no backup and leaves the file unchanged;
- symlink-safe writes are unchanged;
- active state hooks end with `async: true` and the current timeout, but the exact
  report fixture proves those fields are not used as ownership evidence;
- removal logs no longer mislabel deprecated/env cleanup as versioned-only; and
- `WorktreeCreate` remains absent from `CORE_HOOKS` in both sync and async flows.

## 6. Verification and acceptance

Automated verification:

```text
node --test test/install.test.js test/claude-hook-health.test.js test/claude-settings-watcher.test.js test/remote-deploy.test.js
npm test
```

Also run an isolated fixture probe that invokes the public sync and async APIs on the
exact redacted #852 shape and records the before/after `WorktreeCreate` entries. Run
it once with env-only entries and once with the real post-current-installer state
(env plus canonical duplicates). Force the Node resolver failure seam in a separate
probe and assert no env command becomes bare `node`. Do not use the developer's real
`~/.claude/settings.json` for these probes.

Real Claude Code validation is required before calling the user-facing bug fixed:

1. On the available Mac, use a test-owned/disposable Claude configuration and first
   reproduce the obsolete env `WorktreeCreate` command (with `timeout: 5`) beside a
   separate user-authored hook; confirm the pre-fix missing-path failure.
2. Add an env-indirected active state hook beside the canonical active hook that the
   current installer would have appended. This models the affected machine's likely
   real starting point, not just the original report excerpt.
3. Run the supported Clawd Install/Repair path and confirm deprecated cleanup plus
   one-survivor folding. Verify the top-level env and user hook are unchanged.
4. Run Install/Repair a second time and compare the settings file: no mutation,
   backup, or duplicate may be added.
5. Treat the settings assertion as the primary duplicate detector: every active event
   must contain exactly one owned state command. Then trigger a test-owned Claude
   session and inspect the Mac Clawd debug log (normally
   `~/Library/Application Support/clawd-on-desk/debug.log`) or an instrumented local
   state receiver for the same session/event, confirming one receipt rather than
   relying on HUD/Dashboard appearance; duplicate state POSTs are visually idempotent.
6. Run `claude -w` and confirm native worktree creation succeeds.
7. Use a test harness on the Mac to force resolver failure against an env-only active
   hook. Confirm a valid absolute `settings.env.CLAWD_NODE_BIN` is used; then use an
   invalid/missing value and confirm the env command is preserved, never rewritten
   to bare `node`, with a visible diagnostic.
8. Clean up only the test-owned terminal/session and worktree through their owning
   Claude/Git workflow.

The Mac check is a release gate for this fix, not a pre-authorized pending item. If
the machine is temporarily unavailable, implementation may proceed through automated
review but #852 must not be closed until the gate runs. Unit tests prove deterministic
cleanup; they do not prove POSIX shell expansion or Claude's native worktree lifecycle.

### 6.1 Verification record (2026-08-13)

- Windows development host after adversarial PR review corrections: the focused
  installer/health/watcher/Doctor/remote-deploy suite passed 290/290; the full
  `npm test` run passed 7,764 tests with 35 expected skips and zero failures
  (7,799 total).
- macOS arm64 host, Claude Code 2.1.211: the final `test/install.test.js` passed
  102/102 using
  an isolated copy of the current hooks and a test-owned Node-compatible runtime.
- Post-review commit `45e6ec2d` reran the expanded installer + health suite on the
  same macOS arm64 host: 144/144 passed. The exact env-indirected
  `WorktreeCreate` fixture again produced Claude's native “hook succeeded but
  returned no worktree path” failure; repair reported `removed=1`, a second
  registration was a zero-change no-op, and Claude then created the native
  worktree before the isolated config stopped at the expected login boundary.
- The combined env + canonical fixture removed both obsolete `WorktreeCreate`
  entries, retained one active state hook plus one auto-start hook, preserved the
  third-party sibling/wrapper/env data, and produced zero changes on the second
  registration (`added=0`, `updated=0`, `removed=0`).
- With the reported env-indirected `WorktreeCreate` entry present, real
  `claude --worktree` reproduced `hook succeeded but returned no worktree path`.
  After repair removed that entry, the same native command created and registered
  its Git worktree before the deliberately isolated Claude config stopped at login.
- An instrumented localhost receiver recorded one `StopFailure` and one
  `SessionEnd` for the test session, with no duplicate receipt of either event.
- A real macOS executable-permission probe classified the absolute env Node as
  `env-hook-migratable` and converged to `healthy`. A missing env Node remained
  env-indirected, exposed `env-hook-node-unresolved`, produced no repair signature,
  and scheduled no automatic repair work.
- Both Claude-created worktrees were removed through `git worktree`; the validated
  test-owned `/tmp` directories were then deleted. The real Claude settings and
  real Clawd runtime file were never read or modified.
- Two independent pre-PR implementation reviews ended in `APPROVE`; a later
  adversarial PR review found that the strict external-env candidate predicate was
  incorrectly reused for trusted resolver output. That review drove regression tests
  for Windows `(x86)` / POSIX `nodejs` paths, end-to-end health-to-installer
  convergence, flat env entries, async env uninstall, and the EncodedCommand
  read-only/mutation ownership boundary. The expanded macOS gate recorded above was
  then rerun on the corrected commit before merge/issue closure.

Acceptance criteria:

- the exact #852 configuration is repaired by both registration paths;
- the env-plus-canonical current-state configuration converges to one hook and stays
  unchanged on the second run;
- resolver failure never rewrites an env-owned active hook to bare `node`;
- env-owned commands bypass the literal target validator, and the dedicated health
  codes produce the intended repair signature/no-signature behavior without a
  three-attempt loop;
- Settings/CLI uninstall also removes the proven env-owned state hook;
- no fail-closed fixture loses a user hook;
- `SessionStart` folding preserves exactly one auto-start hook;
- deprecated/versioned/HTTP-only/uninstall cleanup retains all-delete semantics and
  never leaves an obsolete survivor;
- watcher accounting cannot raise suspicious-shrink because Clawd migrated its own
  env-owned entry;
- `settings.env` is byte-for-byte equivalent at the object/value level after the
  mutation;
- no new `WorktreeCreate` registration or worktree-provider behavior is introduced;
- every Remote SSH `HOOK_FILES` relative dependency remains inside `hooks/`, with
  `../` specifiers covered by the manifest test;
- focused and full tests pass;
- the required Mac Claude Code validation is completed.

## 7. GitHub handling and wording

Before or alongside the implementation PR, reply on #852 with two points:

1. the cleanup gap has been reproduced and will be handled safely;
2. repository and release history contain no Clawd writer for the two env variables,
   so the reporter is asked for a redacted historical config/provenance sample.

The reply should explicitly build on xiaoshidefeng's 2026-08-12 history-search
comment rather than restating it. Acknowledge that the proposed broad
`command.includes("CLAWD_HOOK_PATH")` direction identifies the missing compatibility
class, then explain why the implementation uses the narrower simple-command plus
`settings.env` basename proof: a name-only substring could delete a user-authored
compound worktree provider. At review time there is no associated open repair PR;
the only relevant merged PR remains #129.

The implementation PR should be described as:

> compatibility cleanup for externally env-indirected Clawd hook commands

It should not claim to repair an official pre-#129 env-var format. Close #852 only
after the fix is merged and the real Claude validation status is recorded. The close
comment should distinguish the verified cleanup behavior from the unverified origin
claim.

## 8. Explicit non-goals

- Do not re-register `WorktreeCreate`.
- Do not implement `git worktree add` or print a worktree path from
  `clawd-hook.js`.
- Do not revive the deferred `PreToolUse` carrying-animation idea in this PR.
- Do not add a general-purpose shell/environment interpolator.
- Do not treat arbitrary `CLAWD_*` variables as ownership markers.
- Do not remove top-level env variables or rewrite unrelated Claude settings.
- Do not broaden the change to other agents' installers without concrete evidence
  that they use the same external indirection format.

## 9. Principal risks and mitigations

| Risk | Mitigation |
|---|---|
| Deleting a legitimate user worktree creator | Require the exact single-invocation grammar, matching event token, and an env value whose basename is exactly the established marker; reject compound commands and add negative fixtures. |
| Leaving duplicate active state hooks | Use a position-aware fold rather than the string-predicate remover, prefer an existing safe canonical command, and assert identical-string plus second-run cases. |
| Survivor fold leaks into deprecated cleanup | Keep the helpers/call sites separate and test two obsolete `WorktreeCreate` entries are both removed with the event key deleted. |
| Replacing a working env hook with unusable bare `node` | Use a validated absolute env Node only after independent ownership proof; otherwise retain one env survivor and surface a non-automatic diagnostic. |
| Watcher reports that Clawd deleted third-party hooks | Use the shared classifier in snapshot accounting and test the suspicious-shrink threshold with an independently unhealthy config. |
| Preserved env hook burns three automatic repair attempts | Classify before validation, bypass `validateHookCommand()` for env literals, and lock dedicated issue-code membership in `REPAIR_CLASS_BY_CODE`. |
| Fold deletes Claude auto-start | Classify only state children and test the mixed `SessionStart` wrapper explicitly. |
| Sync/async behavior drift | Share one helper and assert deep parity. |
| Turning cleanup into shell execution | Inspect parsed strings only; no expansion, subprocess, or `process.env`. |
| Shell-profile-only variables are silently ignored | Keep mutation fail-closed but surface the recognized/unverified syntax in Doctor without excluding it from third-party accounting. |
| Shared classifier adds a remote-only missing dependency | Keep `json-utils.js` builtins-only, forbid dependencies outside `hooks/`, and extend the Remote SSH closure test to inspect `../` specifiers. |
| Overstating the regression in release notes | Use external-compatibility wording and retain the provenance caveat. |
| Accidentally reviving the original #127 bug | Lock `WorktreeCreate` absence from `CORE_HOOKS` and leave hook stdout unchanged. |
