# External review command for automatic approvals

Clawd can run one executable before it answers **allow** on its own. This is
opt-in, empty by default, and only ever *narrows* what permission automation
allows — it never turns an ask into an allow, rewrites the request, or grants
session trust.

## Configuration

The setting lives in `clawd-prefs.json` (the Settings page has no entry for this
command-only option yet). Quit Clawd, edit the file, and start it again:

```json
{
  "permissionAutomationMode": "auto-tools",
  "permissionReviewCommand": ["/usr/local/bin/python3", "/Users/me/gates/review.py"],
  "permissionReviewTimeoutMs": 5000
}
```

- `permissionReviewCommand` — an **argv array**, not a shell command line. The
  first element is the executable; no shell, variable expansion, globbing or
  quoting is applied. Empty (the default) means the feature is off. A malformed
  value is rejected at load time and normalizes to off.
- `permissionReviewTimeoutMs` — how long one review may run. Default `5000`,
  allowed range `250`–`60000`.

Use an **absolute path** for the executable. Clawd launched from Finder or a
desktop shortcut inherits a minimal `PATH`; a bare `python` / `node` then fails
with `ENOENT`, and because that fails closed, every automatic allow would
quietly turn into a card. The log records the command as `unavailable` when
this happens.

The conceptual names used in issue #995 map to these flat keys:
`permissionAutomation.externalReview.command` → `permissionReviewCommand`,
`permissionAutomation.externalReview.timeoutMs` → `permissionReviewTimeoutMs`.

On Windows the executable must be a real program (for example `python.exe` or
`node.exe`). A `.cmd`/`.bat` shim cannot be launched without a shell, and is
treated as an unavailable command.

## Contract

The command is started once per accepted permission request that automation is
about to allow. The request is written to **stdin** as one JSON object:

```json
{
  "tool": "Bash",
  "toolInput": { "command": "git push --force origin main" },
  "agent": "claude-code",
  "sessionId": "s1.bG9jYWw.Y2xhdWRlOng",
  "cwd": "C:\\work\\project"
}
```

`toolInput` is the accepted input before display-preview truncation. `cwd` is
empty when the agent does not report one. DSH's ApprovalRequest carries no tool
arguments, so its `toolInput` is `{}`.

The exit code is the whole answer:

| Outcome | Result |
| --- | --- |
| `0` | No objection — automation may allow. |
| `1` | Pause: the request goes to the normal human card. The last non-empty stdout line is shown as a note. |
| `2` | Same as `1`, with a warning marker. |
| Any other code, signal, timeout, missing/non-executable command, unreadable settings, over-limit payload | Pause at the human card. A failed review is never retried into an allow. |

Pretty-printing more than one line is fine; only the last non-empty line is
used, stripped of control characters and bounded to 160 characters. The note is
shown on the local bubble and forwarded verbatim into Telegram/Feishu cards, so
a gate that echoes command text will echo it there too — do not print secrets.
Output is never parsed for an allow/deny decision.

## Scope and safety

- **Downgrade-only.** The command cannot approve a request automation would
  have deferred, cannot deny anything, and does not run on the destructive-hold
  path (`destructiveActionReminder` already stops that request).
- **Only ordinary tool requests.** Questions (`AskUserQuestion`) and plan
  review (`ExitPlanMode`) keep their existing automation behavior.
- **Synchronous by request.** The review settles before the entry can reach any
  automatic-allow path: global automation, an existing session grant, a grant
  created later (sweep), and the remote-only Telegram/Feishu path all see the
  frozen verdict. A "late result" cannot exist because the allow cannot be
  emitted first.
- **Request-scoped.** If the request goes away while the command runs — the
  agent drops the connection, the user presses Esc, the hook process is killed
  — the child is terminated and its result is discarded; no card is created.
  DND, an agent-disable, or the branch-specific permission/family/subagent gate
  that lands mid-review is re-checked the same way, because the result was
  authorized for the state at accept time. A global bubble toggle remains a
  remote-only exception where that branch supports Telegram/Feishu fallback.
- **Fail closed.** A request that is pending when a session grant arrives is
  not swept unless it was explicitly cleared by exit `0`. An entry that never
  carried a verdict is treated as not reviewed.
- **Session trust stays available.** "Don't ask again in this session" is a
  human action, so it is still offered when the configured command has not
  cleared the current request. If an equivalent grant already exists, the
  clicked card may resolve against it; other pending requests whose gate did
  not clear them remain held. Later requests are reviewed normally.
- **Bounded.** At most four reviews run at once; further requests pause for a
  human without starting a process. Captured stdout is capped at 64 KiB (stderr
  is drained and discarded), and stdin payloads above 1 MiB are refused.
  In-flight reviews are terminated when Clawd quits and finish as
  `cancelled/app-quitting`, so they cannot create a card during shutdown.
- **Trusted configuration.** The value is command-only at the settings
  controller boundary: a generic renderer `settings:update` cannot introduce an
  executable. In this first release the prefs file is the only writer. The
  command runs with Clawd's own privileges and receives the tool input, so only
  configure a program you trust.
- **Process cleanup.** Clawd terminates the process group it started on timeout,
  cancellation, or quit: a negative PID on POSIX, `taskkill /T` on Windows. That
  reaches a shell wrapper's children; descendants that detach into a new group
  of their own are still the script's responsibility.

Sessions that never send a `PermissionRequest` to Clawd — Claude Code with
`--dangerously-skip-permissions` or `defaultMode: "auto"`, for example — are
outside this feature. Those agents never ask Clawd, so there is nothing to
review.

For a Codex Auto request that Clawd would otherwise have claimed silently, a
held review returns the request to Codex's own approval prompt instead of
opening a Clawd card: that mode deliberately does not render Clawd bubbles.

## Example gate

```python
#!/usr/bin/env python3
import json
import sys

request = json.load(sys.stdin)
command = (request.get("toolInput") or {}).get("command", "")
if "git push --force" in command:
    print("force-push blocked by policy gate")
    sys.exit(1)
sys.exit(0)
```

With `permissionReviewCommand: ["python", "/path/to/gate.py"]`, an automatic
allow becomes a human card carrying “force-push blocked by policy gate” as the
note; everything else is allowed exactly as before.
