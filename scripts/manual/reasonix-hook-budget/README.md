# Reasonix Windows hook budget (#1198)

This manual check uses the official Reasonix consumer at
`b5b7cf49e6aed3b0f65ebc72a1c1602183aa7d49`: `Load` → `Runner` →
`DefaultSpawner` → cmd → the actual Clawd-generated PowerShell command → Node.
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
go build -mod=readonly -o (Join-Path $validationRoot 'reasonix-native-consumer.exe') ./cmd/clawd-consumer-check
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
