# Reasonix Windows hook budget (#1198)

This manual check uses the official Reasonix consumer at
`b5b7cf49e6aed3b0f65ebc72a1c1602183aa7d49`: `Load` → `Runner` →
`DefaultSpawner` → cmd → the actual Clawd-generated command → Node (with
PowerShell only when the installer selects its compatibility fallback).
It fires `UserPromptSubmit` and `PreToolUse` directly, without a CLI session,
model request, tool execution, or access to the user's Reasonix configuration.

## Build

Obtain the complete pinned [official source](https://github.com/esengine/DeepSeek-Reasonix/tree/b5b7cf49e6aed3b0f65ebc72a1c1602183aa7d49)
in an isolated temporary directory. Copy this directory's `main.go` into that
module as `cmd/clawd-consumer-check/main.go` (required by Go's internal imports).
From that source directory, build with an installed Go 1.26.x:

```powershell
# validationRoot is the absolute, dedicated temporary test directory.
$env:GOTOOLCHAIN = 'local'
$env:GOCACHE = Join-Path $validationRoot 'go-build-cache'
go build -buildvcs=false -mod=readonly -o (Join-Path $validationRoot 'reasonix-native-consumer.exe') ./cmd/clawd-consumer-check
```

Missing module dependencies may download normally. Preserve `go.mod`/`go.sum`
and network settings; do not install a different toolchain to hide a failure.

## Run on Windows

Set `driver` to this directory's `run-consumer.cjs`, `consumer` to the built
executable, and `fixedRepo` / `oldRepo` to isolated Clawd checkouts. The old
control uses the original hook from `c52e2df6`. Run sequentially:

```powershell
node $driver --consumer $consumer --repo $fixedRepo --mode normal --expect pass
node $driver --consumer $consumer --repo $fixedRepo --mode stream --expect pass
node $driver --consumer $consumer --repo $fixedRepo --mode stream --delay-ms 1800 --expect pass
node $driver --consumer $consumer --repo $oldRepo --mode stream --delay-ms 1800 --expect block
```

Each command checks both events and prints JSON evidence. `--event` selects one
event; `--repeat 2` repeats sequentially. The driver owns a real loopback HTTP
fixture at port 23337, refusing to reuse an occupied port (`--port` may select
another free Clawd port in 23333–23337). Settings, runtime identity, PID cache
and optional preload all use a new temporary home, removed after the run.
No installer or live Clawd service is needed.

Normal HTTP returns the Clawd identity header and a completed response.
Streaming HTTP sends a byte every 30ms without an identity header or EOF;
this keeps the socket inactivity timeout alive without monkeypatching HTTP.
The optional delay is injected **before** the hook script starts its clock.
It is controlled launch overhead, not evidence that ordinary machines always
take that long to launch.

Pass requires the official 5000ms timeout, one actual POST for the event,
silent exit 0, no timeout, and `blocked=false`. The old negative control must
instead produce both `timedOut=true` and `blocked=true`; an unrelated spawn
error does not count. After a blocked control, the driver waits for the
synthetic Node descendant to finish naturally rather than killing unrelated
Windows processes.

This validates the pinned native hook consumer, not a full installed Reasonix
session or production failure frequency. Its consequences differ by event:
`UserPromptSubmit` blocks the submission; `PreToolUse` blocks the tool call.

## Recorded check: 2026-10-15

Windows x64, Node 24.12.0, Go 1.26.3; Clawd fix `fd713a3a`, baseline
`c52e2df6`, and the pinned official Reasonix source above. Each row ran once
per event and received exactly one real POST. No model or live user session ran.

| Control | UserPromptSubmit | PreToolUse | Native outcome |
| --- | ---: | ---: | --- |
| Fixed, normal HTTP | 1074ms | 1032ms | Pass, exit 0 |
| Fixed, streaming HTTP | 2030ms | 2029ms | Pass, exit 0 |
| Fixed, streaming + injected 1800ms startup | 3813ms | 3831ms | Pass, exit 0 |
| Baseline, same streaming + startup injection | 5502ms | 5501ms | TimedOut + Block |

The baseline's return time includes the upstream 500ms pipe-drain allowance;
its configured timeout remained 5000ms. This negative control demonstrates the
native consequence under the injected condition, not natural failure frequency.

The focused Windows regression set passed 233 tests with one POSIX-only skip.
Its real Windows wrapper checks also covered stdin delayed 1800ms **after Node
readiness**: both blocking events exited in 3508–3525ms, with HTTP-attempt
receipts. On macOS, 152 related checks and 15 delivery checks passed (six
Windows-only delivery checks skipped). The four new direct-Node hanging-HTTP
regressions failed against the baseline at 3526–4050ms and passed with the fix.

## Follow-up check: 2026-10-21

The reporter's phase receipts at PR head `e45bd9bb` measured up to 2557ms
before Node readiness, about 2500ms inside Node with late input, and up to
122ms after Node exit. The 2500ms script deadline still leaves too little
room for that launch chain. This follow-up keeps the 2000ms stdin window and
Windows encoded command, reduces blocking post-stdin waiting to 200ms, and
caps the script at 2200ms. Non-blocking event budgets are unchanged. It remains
best-effort state delivery: slow discovery or transport may be abandoned.

The encoded command is retained for older Reasonix releases: installed
v1.13.1 still passes the flat command through Go's Windows argv encoder.
[Upstream #6911](https://github.com/esengine/DeepSeek-Reasonix/pull/6911) fixes
that quoting contract in newer source, but removing PowerShell unconditionally
would break older CLI/desktop installs and literal special-character paths.

The driver now supports two explicit, test-only injections:

- `--launch-floor-ms 2700` delays the preloader until at least 2700ms after
  the driver launches the native consumer, before the production hook clock.
- `--stdin-delay-ms 1800` buffers the consumer's real stdin, then relays the
  same bytes to the hook after the requested delay. The official consumer's
  timeout/decision logic and the production hook are not modified.

Both delays emit receipts and are checked; a missing POST never counts as a
pass. This is controlled fault injection, not natural failure frequency.
Use the PR-head hook plus its helpers as `prHeadHook` for the negative control:

```powershell
node $driver --consumer $consumer --repo $fixedRepo --mode stream --launch-floor-ms 2700 --stdin-delay-ms 1800 --repeat 2 --expect pass
node $driver --consumer $consumer --repo $fixedRepo --hook $prHeadHook --mode stream --launch-floor-ms 2700 --stdin-delay-ms 1800 --expect block
node $driver --consumer $consumer --repo $fixedRepo --mode normal --launch-floor-ms 2700 --stdin-delay-ms 1900 --expect pass
```

Windows x64, Node 24.12.0, Go 1.26.3, same pinned official consumer:

| Control | UserPromptSubmit | PreToolUse | Native outcome |
| --- | ---: | ---: | --- |
| Follow-up, normal HTTP | 340ms | 296ms | Pass, exit 0 |
| Follow-up, stream + 2700ms launch floor + 1800ms stdin, two runs | 4691–4697ms | 4685–4686ms | All pass, exit 0 |
| PR head `e45bd9bb`, identical injected conditions | 5188ms | 5167ms | Both TimedOut + Block |
| Follow-up, healthy HTTP + 2700ms launch floor + 1900ms stdin | 4601ms | 4604ms | Pass, actual POST received |

Every row received exactly one `/state` POST with the correct event and agent.
The native timeout remained 5000ms. The positive stress cases leave roughly
300ms of measured headroom on this machine; this does not guarantee success
under arbitrary OS stalls or replace the reporter's own retest.

The focused set passed all 43 tests on Windows and 37 on macOS (six Windows-only
skips). The related server-config/process/PID-cache set passed 185 tests on
macOS (one platform skip). Four strengthened hanging-HTTP regressions all fail
against `e45bd9bb` (691–1000ms waiting after the HTTP attempt) and pass with the
follow-up (about 200ms), so a fast local wrapper cannot conceal the old wait.

An additional **full CLI smoke passed** with the installed, unmodified Windows
Reasonix v1.13.1 executable and Node 24.12.0. It used a new temporary home,
installer-generated settings, a local synthetic OpenAI-compatible endpoint,
and a real `read_file` call. The second model request contained the exact test
file contents; the CLI printed the final completion marker and exited 0.
All six actual hook POSTs arrived with `agent_id=reasonix`: `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, and `SessionEnd`.
The full session took 5137ms (not a per-hook duration), with no hook timeout or
block. The generated hook path contained spaces and literal `& %PATH%!$`.
No paid model, live Clawd UI, user configuration or proxy setting was changed.

The initial CLI fixture used `http://127.0.0.1:23337/v1` and stalled even with
all Clawd hooks removed. A temporary diagnostic build of the same upstream
v1.13.1 source traced that request to `127.0.0.1:7897`, the existing system
proxy. Its `internal/sysproxy/sysproxy.go` bypass matcher only handles leading
wildcards, so the existing Windows `127.*` trailing-wildcard entry did not
match. The fixture endpoint was changed to `http://localhost:23337/v1`, which
matches the already-existing exact `localhost` exclusion. The successful run
above used the installed original executable, not the diagnostic build.
This change was limited to the disposable test endpoint; proxy settings and
the production Clawd integration remained untouched. It verifies the full
CLI path with deterministic model replies, not a live provider or desktop
animation, and does not replace the reporter's own slower-machine retest.

## Follow-up check: 2026-10-22

The reporter's later Node 22.22.2 receipts on main (including #1199) showed
3493–4145ms before Node readiness and 5687–6333ms total with late stdin. That
phase includes the complete wrapper/Node launch; it does not establish that
PowerShell alone accounts for the delay. Our Windows 11 machine did **not**
reproduce that delay naturally: baseline late-input checks passed in
2292–2309ms. A controlled 3500ms pre-Node launch floor plus 1800ms late input
reproduced both native timeout/block decisions with the unchanged main hook.

The installer now avoids PowerShell when the exact absolute Node and hook can
be expressed without quotes. It queries existing DOS short aliases once at
installation, verifies their file identities, and escapes shell characters in
the script argument. It neither enables 8.3 naming nor changes the selected
Node executable. Missing/unsafe aliases retain the encoded fallback. This
removes one launch layer on eligible paths; it does not make arbitrary
multi-second Node/OS stalls safe or fix the fallback's slow-launch exposure.
The issue remains open for the reporter's machine to retest.

To isolate the removed launch layer, the native fixture now accepts
`--powershell-delay-ms`: its test-only executable shim waits, records a receipt,
and then invokes the original Windows PowerShell. The production installer
selects whether that shim is used. Direct commands must produce no shim
receipt. `--delay-ms` still injects an independent Node startup delay, while
`--stdin-delay-ms` delays the actual input bytes. Build the updated `main.go`
and use this revision's driver for both repositories:

```powershell
# oldRepo is main a114fd00 (already contains #1199); fixedRepo is this change.
node $driver --consumer $consumer --repo $oldRepo --mode stream --powershell-delay-ms 2500 --delay-ms 1000 --stdin-delay-ms 1800 --expect block
node $driver --consumer $consumer --repo $fixedRepo --mode stream --powershell-delay-ms 2500 --delay-ms 1000 --stdin-delay-ms 1800 --repeat 3 --expect pass
```

Windows 11 x64, Node 24.12.0, Go 1.26.3, the same pinned official consumer:

| Control | Measured duration | Native outcome |
| --- | ---: | --- |
| Main, 2500ms PowerShell shim + 1000ms Node delay + 1800ms stdin, both events | about 5501ms | Both TimedOut + Block |
| Candidate, same options, direct launch bypasses PowerShell shim, three runs/event | 3077–3093ms | All six pass, exit 0 |
| Candidate, normal HTTP, both events | 87–98ms | Both pass, exit 0 |
| Candidate, 2200ms Node delay + 1800ms stdin + streaming HTTP, both events | 4282ms | Both pass, exit 0 |

Every row received exactly one real `/state` POST. The injected wait in the
removed layer is deliberately absent in the candidate; these results must
not be described as surviving the same 3500ms absolute pre-Node floor.
The official timeout remains 5000ms, and production hook budgets are unchanged.

Two complete sessions with installed Reasonix v1.13.1 also passed: direct
launch (4336ms) and a deliberately unsafe short alias forcing encoded fallback
(5055ms). Both used isolated homes, deterministic local model replies, a real
`read_file`, all six state events, and exit 0 without hook errors. These are
whole-session durations, not per-hook durations. The final focused Windows set
passed all 54 tests (Node 24.12.0), including Doctor validation of the generated
command. Another 166 related Doctor checks passed with one platform skip. The
full macOS suite passed 13,321 tests with
73 platform skips and no failures (Node 24.18.0). No paid model, user settings,
live Clawd UI, or proxy configuration was changed. Node 22.22.2 was not run
on this machine because the separate runtime download did not complete; the
reporter's exact runtime/slow-host combination still needs a retest.

### Windows CI regression follow-up

The installation-detector test now explicitly selects the encoded fallback
instead of assuming every Windows path needs it, and separately checks direct
commands whose short filename needs the ownership marker. A Windows-only
regression copies the real hooks into the default install directory layout,
runs the actual short-name query with the installer's forward-slash path, and
verifies both file identities, all generated event commands, Doctor parsing,
and silent execution. It uses an independent backslash query to skip only
when the volume/profile has no usable aliases; an installer fallback or query
failure is a test failure when those aliases exist.

On the same Windows 11 / Node 24.12.0 machine, the real-query regression ran
without skipping. The complete repository suite then passed **13,411 tests**
with **127 platform skips and zero failures** (57.3 seconds), using the normal
`test/run-tests.js` entry point and all locked dependency versions. This
supersedes the focused-only Windows coverage above; #1198 remains open for
the reporter's exact runtime and slower host.

## Collect phase timings after a failed Windows retest

The delivery tests emit a `reasonix-hook-timing` JSON diagnostic before their
assertions, on both pass and failure. The Windows wrapper budget remains
**5000ms**; no production hook or installer change is needed to collect it.
After updating the PR checkout, run this PowerShell block from its root. Each
event runs in its own test invocation, without the other delivery cases before
it (this does not guarantee a cold OS or filesystem cache):

```powershell
foreach ($eventName in 'UserPromptSubmit', 'PreToolUse') {
  node --test --test-concurrency=1 "--test-name-pattern=real Windows wrapper below 5s for $eventName with 1800ms-late stdin and hanging HTTP" test/reasonix-hook-delivery.test.js
}
```

Share the two `reasonix-hook-timing` lines and each test's pass/fail result.
They contain event labels, Node/platform information and elapsed milliseconds,
without local paths, raw timestamps, PIDs or payload contents. No Reasonix
installation or live user session is required.

- `spawnToReadyMs`: parent launch start to the Node preloader's ready receipt.
  This includes wrapper/Node startup and preloader setup; it is not a separate
  measurement of PowerShell alone.
- `readyToRequestMs`: ready receipt to the first attempted HTTP request,
  including input wait and hook setup.
- `stdinSentAfterReadyMs` / `stdinSentToRequestMs`: locate the parent's input
  write within that interval. These are write-attempt timestamps, not proof of
  child receipt. Immediate-input cases normally have a negative first value.
- `requestToNodeExitMs`: first HTTP attempt to Node's exit receipt.
- `readyToNodeExitMs`: the observed Node lifetime after preloader readiness;
  the production hook starts its own clock slightly later.
- `nodeExitToCloseMs`: exit receipt to the parent's child `close` event,
  including receipt writing, remaining Node/wrapper shutdown and pipe closing.
- `totalMs`: the complete measured duration checked against `budgetMs`.

A missing receipt produces `null` for dependent timings rather than zero. The
readiness/request/exit receipts are small synchronous test-only file writes and
are included in measured time; wall-clock changes or heavy scheduling stalls
can affect the readings. Passing locally does not resolve an overrun reported
on another machine.
