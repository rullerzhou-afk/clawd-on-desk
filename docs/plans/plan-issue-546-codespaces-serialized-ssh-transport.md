# Plan: Codespaces serialized SSH transport compatibility (#546)

> Status: **Implemented and verified; real Codespaces V1-V5/V7-V14, automated V6, and ordinary-host V15 pass**
> Date: 2026-08-09
> Issue: [#546 — Codespaces + `gh cs ssh --stdio` breaks Remote SSH deploy/probe on Windows when background tunnel is active](https://github.com/rullerzhou-afk/clawd-on-desk/issues/546)
> Baseline: `main@82a47f69c0447670c7752828524bcc55f82cf77a`
> Scope: Windows OpenSSH targets whose effective `ProxyCommand` uses `gh cs ssh --stdio`, plus an explicit serialized-transport compatibility override for equivalent single-session transports
> Out of scope: an upstream GitHub CLI/Win32-OpenSSH fix, ControlMaster as the primary solution, aggregate multi-profile tunnels, broad Remote SSH isolation changes, or blind retry of remote mutations

---

## 1. Decision summary

#546 is real and was reproduced against a temporary GitHub Codespace from Windows on 2026-08-09. The current Clawd connection model necessarily overlaps a long-lived `ssh -N -R` process with separate SSH processes for health probing, Node discovery, Codex monitor maintenance, Deploy / Repair, cleanup, and other remote operations. With a Codespaces target reached through `ProxyCommand gh cs ssh --stdio`, that overlap can hang or fail with EOF / code 255 and can leave the `gh cs ssh --stdio` child alive after its parent `ssh.exe` has gone away.

The fix is **not** “call `disconnect()` before Deploy” and is **not** “add one retry.” The reviewed design has four inseparable parts:

1. classify the effective SSH transport without connecting, automatically recognizing Codespaces stdio proxy targets and allowing an explicit serialized compatibility override;
2. coordinate all Clawd-managed SSH/SCP work by the effective transport target rather than by profile alone, admitting every transport-bearing child through one pre-spawn gateway with an opaque reservation token;
3. replace the separate health-probe SSH with a readiness-and-stay command carried by the main reverse-tunnel SSH connection;
4. suspend the persistent session through an in-band stdin-EOF shutdown, wait for every managed child's `close`, quarantine the transport instead of mutating when drain is unproven, keep the reservation across the complete operation or deployment transaction, then reconnect only when that operation's explicit resume policy and the latest user intent allow it.

Normal SSH targets remain on the existing parallel-capable path in this issue. This avoids forcing every Remote SSH Deploy / Repair offline and preserves the current online dual-nonce rotation behavior for transports that support concurrent sessions.

## 2. Confirmed evidence and certainty boundary

### 2.1 Current production overlap

The current call graph creates concurrent sessions in several places:

```text
Connect
  -> remote-ssh-ipc.js::connectProfile()
  -> remote-ssh-runtime.js::connect()
  -> spawnTunnel(): ssh -N -R ...
  -> startProbeLoop(): a second ssh <health command>

Connect with autoStartCodexMonitor=true
  -> runtime.connect() starts the tunnel
  -> startCodexMonitor() is launched fire-and-forget
  -> Node verify / lease / ownership preflight / monitor mutation / release
     each use one-shot SSH while the tunnel is alive

Deploy / Repair
  -> remoteSsh:deploy
  -> secureDeploy()
  -> shell/home/Node probes + lease + many ssh/scp steps
     while any existing tunnel remains alive
```

`remote-ssh-runtime.js::disconnect()` currently calls `child.kill()`, clears its references, changes status to idle, and returns synchronously. It does not prove that the outer `ssh.exe`, its stdio, or the nested ProxyCommand process has reached `close`. The global auxiliary-child set also lacks profile and transport ownership, so it cannot be used as a per-target drain barrier.

### 2.2 In-memory concurrency proof

A single-session transport mock was run without changing repository files:

- the first `ssh -N -R` was admitted;
- in 1.2 seconds the current probe loop attempted five more SSH processes;
- all five were rejected by the mock transport;
- the runtime remained `connecting`.

A separate drain mock proved that `disconnect()` followed in the same tick by SCP still overlaps: SCP is admitted only after the tunnel child emits its deferred close. Current IPC tests also confirm that a connected profile enters `deployFn` without any disconnect call.

### 2.3 Real Windows OpenSSH + Codespaces reproduction

A temporary 2-core Codespace was created for `rullerzhou-afk/clawd-on-desk@main`, tested, and deleted. No repository change was made in the Codespace.

Control result:

```text
Windows OpenSSH
  -> ProxyCommand gh cs ssh --stdio
  -> node -v
  -> v24.14.0
```

Concurrent baseline:

```text
ssh -N -R ...             # alive before second connection
+ second ssh "node -v"   # did not complete
```

The harness reached its 90-second command timeout. After the parent test `ssh.exe` disappeared, a test-owned `gh.exe` with the exact `gh cs ssh -c <codespace> --stdio` command line remained alive and retained local TCP connections. Stopping the Codespace did not make it exit within the observation window; it was terminated only after exact PID, executable name, command line, and test Codespace identity were revalidated. No user terminal, `ssh.exe`, conhost, or unrelated process was terminated.

### 2.4 Single-session proof of concept

The same real Codespace passed this topology:

```text
one Windows ssh process
  -> -R <remote-port>:127.0.0.1:<local-test-http-port>
  -> remote Node readiness command on the same SSH connection
  -> remote GET crosses the reverse forward
  -> local server returns HTTP 200 + test header
  -> remote prints an unpredictable ready marker
  -> connection stays alive for 8 seconds
  -> remote command exits naturally
```

Observed result:

```json
{
  "code": 0,
  "markerSeen": true,
  "localHits": 1,
  "heldAfterReadyMs": 8000
}
```

The SSH and ProxyCommand processes then exited naturally with no residue. This proves that `ssh -R` plus a remote readiness-and-stay command works over the exact Windows OpenSSH / Codespaces stdio path and can perform the current end-to-end HTTP check without a second SSH connection.

### 2.5 What remains an inference

The reproduction proves that Clawd creates the reported overlap and that removing the overlap is a viable compatibility workaround. It does not prove which upstream layer is solely responsible for every EOF / 255 result: Win32 pipe handling, GitHub CLI forwarding, Codespaces RPC/server startup, and Windows OpenSSH may all contribute.

Do not describe this work as an upstream root-cause fix. Completion means Clawd no longer creates overlapping managed sessions for a serialized transport and the real #546 workflow passes.

## 3. Mandatory invariants

The implementation is acceptable only if all of the following remain true.

### T1. At most one managed session per serialized transport

From preparation through live tunnel and maintenance, a serialized transport target has at most one live Clawd-managed top-level transport-bearing child (`ssh` or `scp`). The invariant is keyed by effective transport identity, not `profileId`, and is enforced **before spawn**, not by post-spawn bookkeeping. The nested `gh cs ssh --stdio` process is outside Node's child registry; absence of nested residue is established by the graceful-close protocol plus real Windows verification, not claimed as directly observable by the coordinator.

### T2. Connected still means end-to-end verified

Clawd must not replace the health probe with a timer or merely trust that `ssh.exe` stayed alive. `connected` still requires:

- remote forward creation;
- the correct remote identity document;
- exact install/profile/runtime/layout/port binding;
- a valid routing nonce read on the remote, never supplied in a marker;
- an HTTP request through the reverse forward;
- `x-clawd-server: clawd-on-desk` and HTTP 200 from the profile ingress.

### T3. Drain is proven by graceful completion and `close`, not requested by `kill`

The persistent serialized session keeps SSH stdin piped. Intentional suspend/disconnect ends stdin so the remote readiness process exits naturally, then waits for the outer child `close`. Every one-shot captures `exit` metadata and normally settles only after `close`. On a drain deadline, its caller-facing operation result may reject once with `TransportUndrainedError`, but a separate `closePromise`/registry retains the child and reservation until actual `close`. A force-killed outer `ssh.exe` is not proof that its nested ProxyCommand chain drained. The slot becomes quarantined, no mutation/release/reconnect child may spawn, and later recovery follows the lock-stage rules in T12.

### T4. Deployment suspension covers the whole durable transaction

For a connected serialized profile, the exclusive transport reservation starts before `remoteSsh.beginIdentityRotation` and ends only after the deploy result, `markDeployed`, and `commitIdentityRotation` paths finish or fail. Releasing the reservation around only `deployFn` would expose a half-persisted A-to-B identity state.

### T5. Resume follows current intent, not stale state

Track two separate counters:

- `intentGeneration`: incremented only by admitted explicit Connect/Disconnect intent;
- `attemptGeneration`: incremented for each connection attempt, retry, suspend, cancellation, or immutable-target refresh.

A suspended Deploy/Repair tunnel reconnects only if:

- the profile still exists;
- the user has not disconnected during the operation;
- the latest committed profile remains connect-ready;
- no other profile owns the same serialized transport.

The captured intent generation detects whether the user changed intent; it is not an unconditional equality gate that can discard a newer valid state. A busy Connect does not queue or leave `desiredConnected=true`. Every asynchronous continuation must validate its opaque reservation and attempt token.

Never use only `wasConnected` plus `finally { connect(oldProfile) }`.

### T6. Identity and secret hygiene do not weaken

The ready marker uses a per-connection random challenge and contains no routing nonce, token, remote configuration, or private path. The remote command reads the identity file itself. Logs, progress messages, error objects, argv assertions, and snapshots must not expose routing nonces or private-key contents.

### T7. Unknown-result mutations are not blindly retried

EOF / 255 can occur after a remote mutation executed but before its result arrived. Automatic retries are allowed only for classified read-only discovery and readiness operations. Deploy / cleanup / installer mutations retain the current lease, fencing, persisted identity transaction, and explicit Retry semantics.

### T8. Existing secure Remote SSH boundaries remain authoritative

This issue must not bypass:

- `runtimeKey -> remote layout` resolution;
- installation identity binding;
- routing-nonce ingress validation;
- layout-scoped deploy lease and fencing;
- ownership-checked cleanup;
- exact remote port pinning;
- profile-isolation release gate.

### T9. Normal SSH behavior is preserved

Profiles classified as ordinary parallel-capable SSH keep the current tunnel and probe path in this issue. Existing online Deploy / Repair behavior, recovery backoff, and tests must remain green.

### T10. Same-transport multi-profile behavior is explicit

The first implementation does not aggregate multiple profiles into one SSH process. If another profile requests Connect, Deploy, Repair, Cleanup, force revoke, runtime-mode work, Authenticate, or Open Terminal through an occupied serialized transport key, return a structured `serialized_transport_busy` result naming only safe display data. It does not queue, change intent, suspend the owner, or start a second child.

### T11. Every child is bound to one immutable target

Admission, settings re-read, effective-transport inspection, and installation binding must agree before any durable local or remote mutation. Each child receives an immutable operation/connection target, transport key, reservation token, and attempt generation. Settings refresh never re-keys a live child. A target change while work is waiting aborts with `profile_changed` before identity rotation or releases and reacquires from the new target; it never silently continues under the old reservation.

### T12. Unknown transport completion quarantines the operation

If a mutation child times out or cannot prove `close`, the coordinator synchronously invalidates the operation token and settles its public result once with a bounded `TransportUndrainedError`. Subsequent callback steps, remote lease release, identity mark/commit, automatic reconnect, and automatic replay are forbidden. Current deploy locks have **no TTL and are never auto-taken-over**. Before any lock command was attempted, a later natural/controlled close may leave the slot stopped for explicit Retry. Once lock acquisition was attempted or a lock may be owned, preserve the primary error and add `manual_lock_inspection_required`; automatic Retry remains disabled until a human verifies and resolves the exact layout-scoped lock through an existing ownership-safe procedure. A late verified close updates only child tracking; it never re-settles the result, reactivates the old callback, resumes, or replays the mutation. A force-killed outer child never makes Retry safe because it does not prove the nested proxy drained.

## 4. Production design

### 4.1 Add bounded effective-transport inspection

Create an async, side-effect-bounded module `src/remote-ssh-transport.js` that does not import runtime, IPC, or deploy code:

```text
inspectEffectiveTransport(immutableProfileTarget)
  -> {
       mode: "parallel" | "serialized" | "unknown",
       kind: "standard" | "codespaces-stdio" | "explicit-serialized" | "inspection-failed",
       key,
       effectiveHost,
       effectiveUser,
       effectivePort,
       fingerprint,
       reason
     }
```

For automatic classification:

1. run local `ssh -G` with `shell:false`, the profile's host/port/identity selection, a strict timeout, and hard stdout/stderr caps, but no network connection;
2. note that user SSH config can contain `Match exec`, so inspection may execute a user-configured local matcher even though Clawd never connects or evaluates the returned ProxyCommand;
3. decode output through the repository's shell-byte decoder and parse OpenSSH key/value output case-insensitively;
4. tokenize the effective `proxycommand` without executing or replaying it;
5. recognize basename `gh` or `gh.exe`, `cs ssh` or `codespace ssh`, exact `--stdio`, and Codespace selector forms `-c value`, `--codespace value`, or `--codespace=value`;
6. normalize the Codespace name and derive `codespace:<normalized-name>` as the transport key.

Do not infer mode from host alias text, `hostPrefix`, PID, process appearance, or a fixed `gh.exe` path. Quoted paths, spaces, slash variants, option ordering, and extra arguments must be covered by fixtures produced from real `ssh -G` output. Never retain or log raw `ssh -G` output or the raw ProxyCommand.

There is no result cache that skips cross-operation inspection because `~/.ssh/config`, `Include`, `Match`, environment, or a regenerated Codespaces alias may change independently. Coalesce only identical in-flight inspection within one operation/attempt. Re-inspect before every top-level reservation and automatic reconnect attempt.

For fail-safe fallback only, the coordinator keeps a process-lifetime sticky map keyed by the immutable local target fingerprint (normalized profile host/port/identity selection plus explicit mode; never raw ProxyCommand):

```text
{ lastKnownMode: "serialized", key, evidenceKind, fingerprintVersion: 1 }
```

A successful inspection replaces/removes the sticky entry only while no child is live; an explicit transport-field edit/profile deletion invalidates the old fingerprint entry. A transient reinspection failure may reuse only a sticky `serialized` result and still reports a warning; it never uses the map to skip inspection. The map is not persisted and is not renderer-visible. After app restart, absence of an entry makes inspection failure a first-use `unknown`, which fails closed with actionable guidance or requires the explicit override. It must never silently fall back to parallel and recreate #546.

For an explicit serialized override, derive a conservative key from the effective user/hostname/port when available. In v1 this only promises coalescing for the same effective destination; arbitrary aliases that hide a shared custom single-session proxy require a future user-supplied transport-group key and must not be described as automatically equivalent. Identity file is not a concurrency-domain separator for a detected Codespace.

### 4.2 Add one narrow profile compatibility field

Extend the validated Remote SSH profile with a persistent, local-orchestration-only field:

```text
sshTransportMode: "auto" | "serialized"
```

- `auto` is the default and classifies `gh cs ssh --stdio` as serialized;
- `serialized` is an explicit compatibility override for equivalent transports;
- this field is sanitized, validated, migrated, saved, and round-tripped through Settings;
- it is not in `DEPLOY_TARGET_FIELDS`, is never written into remote identity, and must not invalidate `lastDeployedAt` or trigger false deploy drift;
- a server-generated transport hint is preserved in locally owned historical-target ledger entries so cleanup can classify the actual old target without changing remote ownership identity.

The historical hint schema is exact and local-only:

```text
sshTransportHint: {
  version: 1,
  mode: "serialized",
  kind: "codespaces-stdio" | "explicit-serialized",
  keyId: "codespace:<normalized-name>" | "destination-sha256:<64 lowercase hex>"
}
```

`keyId` is capped at 160 characters; Codespace names use the inspector's strict normalized-character/length validation, and explicit destination material is hashed rather than copied into the hint. Only the main-process `markDeployed`/owned-target writer may create this from a successful trusted inspection. Profile input and renderer IPC cannot supply it. Load/sanitize rejects unknown versions, modes, kinds, key prefixes, lengths, or characters. It is not part of `DEPLOY_TARGET_FIELDS`, `remoteOwnershipDomainKey`, deploy drift, or remote identity and is never exposed to the renderer.

Historical cleanup always attempts fresh inspection first. If inspection transiently fails, a valid trusted serialized hint may only preserve serialization/key admission; it does not imply that the host remains reachable or authorize ownership takeover. SSH failure stops actionably. Without a trusted hint, `unknown` fails closed. A successful fresh inspection replaces the local hint only through the server-owned ledger writer.

Settings should expose this as an advanced compatibility control with conservative wording, while automatically detected Codespaces profiles require no manual toggle. Add translations for en / zh / zh-TW / ko / ja / pt-BR.

Do not add a UI option that disables automatic Codespaces protection in this issue. A false-negative can use the explicit override; an expert bypass that reintroduces the known hang is not required for v1.

Transport-affecting fields (`host`, port, identity selection, runtime mode, or `sshTransportMode`) cannot be edited while that profile owns or waits on non-idle transport work. Settings must require explicit Disconnect first. A live child keeps the immutable classification/key with which it was admitted; config drift is considered only by the next top-level operation or reconnect, never by re-keying it in place.

### 4.3 Introduce a transport-scoped coordinator

Add `src/remote-ssh-transport-coordinator.js`, constructed and wired by `src/main.js`. It maintains admission slots keyed by effective transport key, but it is not a second runtime state machine.

Suggested slot state:

```text
transportKey
mode
ownerProfileId
phase: idle | preparing | tunnel | suspending | operation | quarantined | failed
operationName
intentGeneration
desiredConnected
activeLease: opaque token + lease generation
trackedChildren: Map<child, immutable child metadata>
lateCloseDisposition
```

Ownership boundaries are fixed:

- the coordinator owns admission, key/owner, opaque reservations, intent/attempt generations, child admission/lifecycle, drain, and quarantine;
- `remote-ssh-runtime.js` remains the sole owner of tunnel status, `sshChild`, retry/backoff, ingress, and user-visible connection events;
- `remote-ssh-ipc.js` owns durable settings/identity transactions and provides an injected preparation callback; runtime must not import deploy code;
- the settings controller remains the only durable settings writer.

The coordinator exposes an opaque operation/connection lease. Every serialized transport-bearing child must be created through the only production gateway, for example:

```text
spawnManagedTransportChild({
  reservationToken,
  attemptToken,
  profileId,
  immutableTarget,
  transportKey,
  role,
  tool,
  args,
  options
}) -> tracked ChildProcess
```

The gateway atomically validates the live lease, owner, key, attempt generation, role, and available slot **before** calling `child_process.spawn`, then registers the returned child in the same synchronous stack. Post-spawn `registerChild(metadata)` is not sufficient and must not be the serialized-path API. `remote-ssh-runtime.js`, `remote-ssh-node.js`, `remote-ssh-shell-detect.js`, `remote-ssh-deploy.js`, and monitor helpers receive the gateway/lease through dependency injection; serialized-reachable production code must not bypass it with raw `spawn`.

`ssh -G` is a local classification child rather than a transport-bearing session and does not consume the serialized slot, but it still uses the same bounded child supervisor for timeout, output cap, and `close` settlement.

Required coordinator behavior:

- Connect is idempotent for the owning profile.
- any non-owner action on an occupied key receives `serialized_transport_busy`; it is not queued and cannot suspend the owner;
- Duplicate mutating actions from another renderer receive `transport_operation_busy` rather than running with stale snapshots.
- Automatic reconnect remains owned by the same slot and cannot race a Deploy suspension.
- every child has two lifecycles: a caller-facing `operationResult` and an internal `closePromise`/registry entry;
- a normal result captures `exitCode`/`signal` on `exit` but `operationResult` settles and registration releases only after `close`;
- timeout requests graceful stop/termination, atomically invalidates the operation token, and may settle `operationResult` once with `TransportUndrainedError`; it does not settle/release `closePromise`, child tracking, or the reservation;
- every deploy/monitor/lease continuation calls `operationContext.assertActive()` immediately after each awaited child/remote step and before every local persistence/state mutation;
- JavaScript `finally` still runs after `TransportUndrainedError`, but it must check the invalid context and skip remote lock release, identity persistence, settings writes, and reconnect; only coordinator-owned quarantine diagnostics are allowed;
- a late verified natural/controlled close changes quarantine to stopped/failed, never re-settles `operationResult` or invokes old continuation logic; explicit Retry is enabled only when no deploy lock may have been acquired;
- app shutdown marks slots stopped, cancels retries, requests graceful shutdown of exact owned children, then may terminate only those top-level children as a final shutdown action; it never launches follow-up work;
- it never uses `taskkill`, `Stop-Process`, PID/name guessing, or process-wide discovery as a lifecycle mechanism.

Add a dependency/static test that enumerates serialized-reachable production modules and fails if they acquire raw `child_process.spawn` for `ssh`/`scp`. Unit fakes must model `exit` and `close` as independent events.

### 4.4 Make serialized Connect one coordinated async operation

`connectProfile()` and the runtime Connect entry point become Promise-aware. An explicit Connect is admitted synchronously before changing intent: success sets `desiredConnected=true` and increments `intentGeneration`; a busy rejection changes neither and leaves no queued intent. Its Promise settles after bounded inspection/admission and the first attempt has either been scheduled or rejected; connection success/failure continues through the existing status events rather than keeping IPC pending across infinite backoff.

Each explicit Connect or connect-on-launch intent owns one **preparation epoch**. The first serialized flow is:

```text
inspect immutable target and reserve transport
  -> re-read current profile + installation binding
  -> re-inspect and require the same key/fingerprint
  -> record desiredConnected=true + intent generation
  -> validate installation binding / deploy readiness
  -> resolve or verify absolute remote Node while no tunnel exists
  -> if autoStartCodexMonitor:
       attempt secure monitor maintenance once in this preparation epoch
       reuse the resolved nodeBin; do not probe Node again
  -> start/reuse the profile ingress
  -> spawn the single persistent SSH tunnel
  -> wait for exact ready marker
  -> connected
```

The second inspection/profile read is the pre-mutation drift barrier. If it changes the effective target/key/fingerprint, release and reacquire before any mutation or return `profile_changed`; never call `beginIdentityRotation` or monitor mutation using a reservation for another target. Every spawned child receives that immutable snapshot.

Monitor startup remains best-effort only when it fails with a known non-transport result and its child has closed. It must finish before the tunnel is spawned. An unknown-result or undrained monitor attempt blocks the tunnel and quarantines the slot. Automatic tunnel reconnect retries run only read-only Node verification/readiness work and never replay monitor start/stop mutation from that preparation epoch. A cleanly closed monitor warning may be shown once and Connect may continue.

Runtime receives an injected `prepareSerializedAttempt` callback from IPC/main composition for the explicit epoch; runtime does not import deployment code. On later automatic retries it calls only the coordinator and read-only runtime/Node path.

`connectOnLaunchProfiles()` remains non-blocking to app startup but performs inspection/admission sequentially in persisted profile order, catches every returned Promise, and reports later same-key profiles busy deterministically. `src/main.js` uses `void connectOnLaunchProfiles().catch(logSafeError)` rather than creating unobserved parallel admissions.

The ordinary parallel-capable flow may retain its current synchronous facade internally, but IPC should safely `await Promise.resolve(...)` so both modes have one public contract.

### 4.5 Carry readiness on the persistent tunnel SSH

For serialized transports only, replace:

```text
ssh -N -R ...
+ separate ssh <probe command>
```

with:

```text
ssh -T -R ... -o ExitOnForwardFailure=yes ... host <readiness-and-stay command>
```

Requirements for the remote Node command:

1. use the pre-resolved absolute Node path;
2. read and parse the layout identity file;
3. validate identity version, installId, profileId, runtimeKey, layoutVersion, deployedAt, exact remote port, and nonce shape;
4. GET the pinned remote forward port with the identity's routing nonce header;
5. require Clawd's server header and HTTP 200;
6. retry connection-refused / not-yet-forwarded conditions within the existing bounded probe window, because OpenSSH may open the exec channel before the remote-forward success reply is observable to the remote command;
7. after success, print exactly one line containing a locally generated random challenge marker;
8. keep the Node event loop alive by keeping SSH stdin open and listening for EOF;
9. on intentional local `sshChild.stdin.end()`, stop readiness work, close its local resources, and exit cleanly so the SSH session and reverse forward end naturally;
10. return stable exit codes compatible with the current probe classification before readiness.

The local SSH child must use `stdio` with writable stdin. Normal suspend/disconnect uses stdin EOF first and waits for `close`; it does not call `kill()`. An intentional-close attempt token prevents the resulting exit from entering reconnect/backoff. Force-killing the outer process after a timeout may be used only for final app shutdown where no new work follows; it can never authorize a subsequent mutation or reconnect.

The local parser must:

- handle arbitrary chunk boundaries, CRLF, and unrelated startup output;
- cap stdout and stderr buffers;
- accept only the exact full-line marker for the current child and challenge;
- require that the current SSH child is still alive when accepting readiness;
- ignore markers, exits, closes, and callbacks from stale reservation/attempt generations;
- set `connected` only after marker validation.

The marker challenge is not an authentication secret, but it prevents a stale banner or unrelated remote output from falsely marking a new tunnel ready. Never reuse the routing nonce as the challenge or include the nonce in argv/stdout.

Before the marker, classify remote readiness exit codes separately from transport failure code 255 and redacted SSH stderr. After the marker, an unintentional child close is a tunnel loss and enters existing bounded reconnect/backoff; an intentional stdin-EOF close is not a failure.

If the absolute Node path is stale and the command exits 126/127, wait for the main child `close`, clear only the matching Node cache, resolve Node through one admitted read-only SSH while the slot remains reserved, then create a fresh attempt token and retry. Never launch the resolver while the tunnel is live or after only its `exit` event.

### 4.6 Add awaitable suspend, drain, and conditional resume

Expose a narrow runtime/coordinator operation such as:

```text
withExclusiveTransport(immutableTarget, operationPolicy, async operationContext => { ... })
```

For an ordinary parallel transport it preserves the tunnel behavior but retains the existing per-profile mutation single-flight. For a serialized transport it:

1. rejects a non-owner profile before changing either profile's intent;
2. records current intent and changes the slot to `suspending`, invalidating attempt tokens and blocking retry/new Connect;
3. ends persistent SSH stdin and asks any pre-operation one-shot to stop through its exact owned handle;
4. waits for every tracked child `close`, not merely `exit`;
5. on deadline, moves to `quarantined`, returns `transport_drain_timeout`, and never invokes the callback;
6. re-reads the profile, installation binding, and effective transport; key/fingerprint drift returns `profile_changed` or reacquires before mutation;
7. supplies a non-spoofable `operationContext` whose spawn gateway is the only way to start each sequential SSH/SCP child;
8. holds the reservation until the callback, local identity persistence, and permitted resume decision finish;
9. releases to idle only after the last operation child closes and all durable local work is complete.

The operation context becomes permanently `undrained` if any one-shot timeout/termination request does not reach `close` by the deadline. The coordinator synchronously invalidates its opaque operation token and settles the caller-facing `operationResult` once with `{ timedOut:true, drainVerified:false }` / `TransportUndrainedError`; the independent `closePromise`, registry entry, and transport reservation remain live. From that point the spawn gateway and `operationContext.assertActive()` reject all later steps. Every helper/caller must assert after each `await` and before `recordStep`, identity/settings persistence, mark/commit, or another spawn. `finally` blocks explicitly test the context and skip `releaseDeployLock()`, persistence, and reconnect when invalid.

Recovery depends on the last attempted role:

- if timeout occurred before any deploy-lock acquisition command, a later **natural/controlled** close may move the slot to stopped and allow explicit Retry;
- if acquire-lock itself became unknown or any later lock-protected step was attempted, the remote lock may exist permanently. Return the primary error plus `manual_lock_inspection_required`, retain safe lock owner/layout identifiers, and disable automatic/one-click Retry until a human verifies the exact lock;
- do not add stale-lock TTL, automatic takeover, or automatic deletion in #546. A resumable same-lease protocol would require separately designed persisted `leaseId`, ownership proof, and fencing and is out of scope;
- if the outer process was force-killed, its `close` is not a natural/controlled drain and never enables Retry/new transport work. Operation-time timeout does not force-kill; only final app shutdown may terminate an exact owned top-level process, after which the app starts nothing else.

A late close is consumed only by the coordinator's registry lifecycle: it records redacted diagnostics and changes the slot to stopped/failed, with Retry availability determined by whether deploy-lock acquisition was ever attempted. It does not settle `operationResult` again or wake the old operation continuation. Normal results still settle only after `close`; the bounded timeout error is the sole exception and never unregisters/releases the child. Do not clear child references prematurely. Do not fall back to `taskkill`, broad `Stop-Process`, PID/name guessing, or a parent `ssh.exe` close as proof of nested `gh.exe` drain.

If callback success is followed by resume failure, preserve callback success and attach a structured `resumeWarning`. If the callback already failed, preserve its primary error and attach resume/drain detail separately.

### 4.7 Put every managed one-shot path behind the reservation

The following paths must participate when the transport is serialized:

- Connect-time remote Node resolution;
- Connect-time Codex monitor start;
- `remoteSsh:deploy`, covering begin rotation through mark/commit;
- Disconnect-time monitor stop;
- profile cleanup / remote uninstall;
- force-revoke cleanup paths;
- runtime-mode bootstrap/switch/finalization;
- any later Doctor repair or remote probe that uses SSH/SCP.

Audit every `spawn("ssh")`, `spawn("scp")`, `resolveRemoteNodeBin()`, `detectRemoteShell()`, `startCodexMonitor()`, and `stopCodexMonitor()` call reachable from Remote SSH IPC. Add a test that fails when a serialized managed child is spawned without an active reservation/role.

Deploy must be structured approximately as:

```text
withExclusiveTransport(immutableTarget, deployResumePolicy, async operationContext => {
  beginIdentityRotation
  refresh deploy profile
  secureDeploy
  if success: markDeployed
  if success: commitIdentityRotation
  refresh runtime profile
  return primary result
})
```

An interrupted or failed transaction continues using the existing accepted `toNonce` plus TTL-bounded `fromNonce` behavior. Retry resumes the same transaction nonce as today.

Do not wrap only `secureDeploy()`. Do not release the reservation before persistence. Do not reconnect from a stale pre-deploy profile snapshot.

Each IPC handler has an explicit intent/resume policy:

| Operation | Intent update before waiting | Owner live tunnel | Resume |
|---|---|---|---|
| explicit Connect / connect-on-launch | set true only after admission | prepare then create one tunnel | n/a |
| Deploy / Repair | none | graceful suspend | only if latest intent/profile still requests it |
| explicit Disconnect + monitor stop | synchronously set false and increment intent generation | graceful drain | never |
| cleanup / profile delete | synchronously set false | close ingress, drain, then target-by-target work | never |
| force revoke | synchronously set false | close ingress and drain before local revocation | never |
| runtime-mode switch/retirement | synchronously set false | close ingress and drain old target | never |
| Connect clicked while Deploy/Repair owns slot | no intent change | return busy | no queued resume |

If Disconnect arrives during Deploy/Repair, it synchronously flips intent before waiting. Any required monitor stop is coalesced as a post-operation step under the still-held owner reservation, after the deploy child has closed; it cannot start concurrently. The Deploy result and Disconnect's bounded wait/warning are reported independently.

Cleanup and runtime-mode flows operate on `managedDeployTargets`/historical immutable targets, not merely the current profile. Inspect and reserve each actual target separately in stable ledger order, hold at most one transport reservation at a time, preserve sibling-ownership skip rules, and release it before advancing to another key. The locally persisted transport hint travels with historical ownership metadata but is not part of remote identity or deploy drift. Never acquire multiple keys together.

Deploy/Repair internal suspension keeps the profile ingress bound so the existing A-to-B nonce acceptance window remains authoritative; its nonce lookup must read the latest committed profile. Explicit Disconnect, delete/cleanup, force revoke, and runtime-mode retirement close the ingress and all accepted/pending connections before local nonce or ownership revocation. Add a request-race test proving an old nonce cannot enter after destructive closure.

### 4.8 Define the interactive-terminal boundary

Authenticate and Open Terminal create user-owned interactive sessions whose actual SSH lifetime is hidden behind Windows Terminal / Terminal.app / another emulator. Clawd cannot safely hold a coordinator lease until those detached sessions finish.

For a serialized transport whose same-key slot is in any non-idle phase (`preparing`, reconnect/backoff ownership, `tunnel`, `suspending`, `operation`, `quarantined`, or failed with a tracked child), including ownership by another profile:

- return a structured busy result;
- tell the user to Disconnect before opening another interactive SSH session;
- never pause a live tunnel and then immediately relaunch it behind the user's terminal.

Only a truly idle slot with no tracked child may launch Authenticate/Open Terminal. After the user disconnects, the detached interactive session remains user-controlled. Document that Clawd cannot observe when it ends or prevent the user from clicking Connect while it is still active. Solving user-owned terminal multiplexing is not part of #546.

### 4.9 Preserve actionable transport errors

Normalize one-shot results to retain:

```text
tool: ssh | scp
step/role
exitCode
signal
timedOut
drainVerified
redactedStderrSummary
```

Capture at most 8 KiB per stderr stream in memory and retain at most a 1 KiB redacted summary in the per-profile progress lifetime; do not persist it to settings. Redact known routing/transaction nonces, identity paths, common token formats, and command fragments before the result leaves the child supervisor. The renderer shows a concise classified message. Empty stderr must still produce a useful timeout/exit/signal/drain result. Never retain or log raw `ssh -G` output, raw ProxyCommand/argv, private-key material, environment secrets, remote config contents, or routing nonces.

Classify known Codespaces symptoms (`EOF`, unknown remote read, code 255, timeout) as transport failures for display and reconnect policy, not as proof of one particular upstream defect.

Coordinator/IPC failures use a stable bounded schema:

```text
{
  ok: false,
  code: serialized_transport_busy | transport_operation_busy |
        transport_drain_timeout | transport_quarantined |
        transport_inspection_failed | profile_changed,
  recoveryCode?: manual_lock_inspection_required,
  profileId,
  ownerProfileId?,
  operation?,
  tool?, role?, exitCode?, signal?, timedOut?, drainVerified?,
  message,
  redactedStderrSummary?
}
```

`message` is locale-ready and bounded to 1 KiB; `redactedStderrSummary` is also bounded to 1 KiB. No field exposes the raw transport key, ProxyCommand, argv, identity path, or nonce. Renderer-facing profile IDs are already application identifiers and may be included; host/user/command details require an existing sanitized display formatter.

`recoveryCode:manual_lock_inspection_required` supplements rather than replaces the primary transport/mutation `code`. It is set when acquire-lock or any lock-protected result is unknown, and disables automatic/one-click Retry. The UI may link to exact ownership-safe manual guidance but must not expose an automatic stale-lock delete action.

### 4.10 UI and documentation behavior

Settings changes:

- advanced `SSH transport compatibility` control (`Auto` / `Serialize managed SSH sessions`);
- optional read-only indication when Codespaces stdio was auto-detected;
- transport-busy and drain-timeout messages;
- Deploy / Repair progress line while the tunnel is intentionally suspended;
- disable conflicting actions across all profile cards that share the same serialized transport key, not only the card whose button was clicked;
- preserve the current main status enum; expose only `transportPhase`, `transportOwnerProfileId`, and safe `conflictingProfileIds` in renderer snapshots, never raw ProxyCommand, argv, transport key, or inspection output;
- require Disconnect before editing transport-affecting fields while the profile owns non-idle work;
- show quarantine/drain timeout as requiring inspection and explicit Retry, never as an automatic retry countdown.

Documentation updates after implementation:

- `docs/guides/guide-remote-ssh.md` and zh-CN counterpart: Codespaces setup, auto detection, intentional short disconnect during Deploy / Repair, interactive terminal boundary;
- `docs/guides/setup-guide.md` and zh-CN counterpart: supported Codespaces flow;
- `docs/guides/known-limitations.md` and zh-CN counterpart: one live Clawd profile per serialized transport in v1;
- `docs/project/agent-runtime-architecture.md`: transport coordinator ownership and single-session readiness path.

## 5. File-level change map

Expected production changes:

| File | Responsibility |
|---|---|
| `src/main.js` | construct/inject inspector, coordinator, spawn gateway, and serialized preparation callback; catch connect-on-launch Promise |
| `src/remote-ssh-transport.js` (new) | bounded async `ssh -G`, parser, Codespaces classification, immutable target fingerprint and key derivation |
| `src/remote-ssh-transport-coordinator.js` (new) | admission slots, opaque leases, intent/attempt generations, pre-spawn gateway, close barrier and quarantine |
| `src/remote-ssh-runtime.js` | Promise-aware Connect/Disconnect, persistent readiness command, marker parsing, serialized reconnect path |
| `src/remote-ssh-ipc.js` | operation policy matrix, full transactions, target revalidation, monitor preparation epoch, historical-target reservations, interactive busy boundary |
| `src/remote-ssh-node.js` | gateway-based child admission, `close` settlement, reuse of pre-resolved node path |
| `src/remote-ssh-shell-detect.js` | gateway-based child admission and `close` settlement |
| `src/remote-ssh-deploy.js` | operation-context spawn, undrained short-circuit, structured redacted results, node reuse, conditional lock release |
| `src/remote-ssh-profile.js` | validated `sshTransportMode` default/sanitize/migration without deploy-target drift |
| `src/settings-actions.js` | settings update validation, active-edit rejection, local target-ledger hint preservation |
| `src/settings-tab-remote-ssh.js` | compatibility control, transport phase/busy UX, progress detail |
| `src/preload-settings.js` | Promise/structured result surface if required |
| `src/settings-i18n.js` | all supported locale strings |
| Remote SSH guides/project docs | behavior and boundary documentation |

Expected test changes:

| File | Coverage |
|---|---|
| `test/remote-ssh-transport.test.js` (new) | real `ssh -G` fixtures, token parser forms, Codespace key, override, unknown/fail-closed behavior |
| `test/remote-ssh-transport-coordinator.test.js` (new) | pre-spawn admission, opaque leases, distinct exit/close, drain, quarantine, late close, owner policy |
| `test/remote-ssh-runtime.test.js` | persistent command, stdin-EOF shutdown, marker parser, no second probe, stale child, read-only reconnect, Node stale recovery |
| `test/remote-ssh-ipc.test.js` | full transaction suspension, preparation epoch, intent policies, target drift, historical targets, ingress race, resume warnings |
| `test/remote-ssh-deploy.test.js` | operation-context roles, close settlement, never-close at lease/mutation/release, redacted results, node reuse |
| `test/remote-ssh-profile.test.js` | profile field default/sanitize/migration and no false deploy drift |
| `test/settings-actions.test.js` | active transport-field edit rejection and owned-target hint persistence |
| `test/settings-tab-remote-ssh.test.js` | compatibility form rendering/actions and safe transport snapshot |
| `test/settings-renderer-browser-env.test.js` | compatibility UI and cross-profile busy state |
| `test/i18n.test.js` | locale key completeness |
| `test/preload-settings.test.js` | only if the IPC surface/schema changes |

The listed ownership split is part of the contract: coordinator and runtime must not both own tunnel state/backoff, and runtime must not import deploy code. A new shared child-supervisor file may be extracted, but its pre-spawn and `close` guarantees may not be weakened. `preload-settings.js` changes only when a new bridge API/schema is actually required.

## 6. Automated test matrix

### A. Transport inspection

1. GitHub-generated Windows ProxyCommand with `C:\Program Files\GitHub CLI\gh.exe` is detected.
2. Quoted executable path, `gh.exe` on PATH, slash variants, option reordering, `cs|codespace ssh`, `-c value`, `--codespace value`, `--codespace=value`, and extra arguments are detected.
3. `gh cs ssh` without exact `--stdio` is not auto-classified.
4. An unrelated ProxyCommand containing words like `codespace` is not classified.
5. Two aliases resolving to the same `-c <codespace-name>` share one key.
6. Explicit serialized mode works when `ssh -G` is incomplete; its v1 same-effective-destination limitation is explicit.
7. Identity-file differences do not split a known Codespace key.
8. Each top-level operation re-inspects; identical in-flight calls coalesce without a persistent profile-only cache.
9. A transient failure preserves last-known serialized; first-use unknown fails closed and never starts a parallel child.
10. `ssh -G` uses `shell:false`, output/timeout caps, settles on `close`, and neither returns nor logs raw ProxyCommand/output.
11. Sticky safety entries live only in the coordinator process, never skip inspection, invalidate on target-field edit/deletion, and disappear across a simulated app restart.

### B. Serialized Connect invariant

1. A single-connection fake transport records `maxActiveManagedChildren === 1`.
2. Connect cache miss sequence is Node resolution close, optional monitor SSHs close, then one persistent tunnel.
3. No separate health-probe child is spawned after the serialized tunnel.
4. Remote command args include `-R` and `ExitOnForwardFailure=yes`, omit `-N`, and contain no nonce.
5. Marker split across chunks succeeds only after exact reconstruction.
6. Startup noise, prefix/suffix text, wrong challenge, stale generation, and marker from an old child fail.
7. Marker plus a dead child does not mark connected.
8. Before-ready exit codes preserve current probe classifications.
9. After-ready exit enters tunnel reconnect/backoff.
10. Intentional stdin EOF reaches remote clean exit and local `close` without starting reconnect.
11. Node 126/127 closes the tunnel before the resolver starts.
12. An automatic reconnect never repeats the preparation epoch's monitor mutation.
13. Hung readiness becomes quarantined; it does not pretend to leave no child or start another.
14. Busy Connect changes neither intent generation nor `desiredConnected`; admitted Connect increments exactly once.

### C. Drain and operation ordering

1. A fake child emits `exit`, delays `close`, and proves neither the helper nor next operation settles early.
2. Intentional suspend uses stdin EOF; merely killing/closing the outer fake does not authorize the operation.
3. A never-closing child returns `transport_drain_timeout`, quarantines the slot, and leaves callback count zero.
4. Late close leaves failed/stopped, does not replay callback/resume, and enables explicit Retry only when no deploy lock may have been acquired.
5. Backoff timer firing during suspension cannot spawn.
6. A pending Node resolver or monitor child is included in the drain.
7. Deploy first remote child starts only after every old transport child closes.
8. Success reconnects from the latest committed profile.
9. Deploy failure, throw, target drift, stamp failure, and commit failure preserve the primary result and apply the documented resume policy.
10. Disconnect during Deploy increments intent and prevents `finally` reconnect.
11. Profile deletion during Deploy prevents reconnect.
12. App cleanup during Deploy cannot start reconnect.
13. A never-closing child during lease acquire, fenced mutation, or release makes IPC return a bounded `TransportUndrainedError`; the separate close registry still owns the child/reservation.
14. Timeout invalidates the operation token; callback-tail, `recordStep`, settings/identity spies, lock-release SSH, mark/commit, and resume counts all remain zero.
15. A later emitted `close` updates only registry/slot state: the public result remains single-settled and every old callback/persistence/spawn spy stays zero.
16. Timeout result includes `drainVerified:false`; reservation is not released just because termination was requested.
17. Serialized-reachable production modules cannot spawn SSH/SCP except through a valid opaque reservation gateway; a released/spoofed token fails before spawn.
18. Undrained before lock acquisition permits explicit Retry only after natural/controlled close; unknown acquire or later step returns `manual_lock_inspection_required` and never auto-retries/deletes/takes over the lock.

### D. Identity transaction safety

1. Suspension begins before `beginIdentityRotation`.
2. Reservation remains held through `markDeployed` and `commitIdentityRotation`.
3. A-to-B retry uses the same `toNonce`.
4. Active transactions accept only the existing TTL-bounded nonce set.
5. No result, marker, argv, progress event, or log contains nonce plaintext.
6. Deploy/Repair suspension keeps latest-profile nonce acceptance; destructive Disconnect/delete/revoke closes ingress and pending requests before revocation.
7. An old-nonce request racing destructive closure is rejected and cannot reach state/permission routing.

### E. Other managed operations

1. Connect-time monitor completes before tunnel spawn and reuses nodeBin.
2. Monitor start is attempted at most once per explicit preparation epoch and never by automatic reconnect.
3. Disconnect writes intent false before waiting, drains, then runs monitor stop under the same reservation, and never resumes.
4. Cleanup/uninstall, force revoke, runtime-mode switch/bootstrap/finalize apply their no-resume policies.
5. Multiple historical cleanup targets are inspected/reserved sequentially in stable order with no simultaneous multi-key lease.
6. Duplicate Deploy from another renderer returns busy.
7. Every non-owner action on the same transport returns `serialized_transport_busy`, changes no intent, and spawns nothing.
8. Authenticate/Open Terminal is blocked in every non-idle/quarantined same-key phase and allowed only when idle/no-child.
9. Profile/SSH-config drift while queued returns `profile_changed` before rotation; a live child is never re-keyed.
10. Active transport-field edits are rejected until explicit Disconnect.
11. Historical hint schema accepts only server-generated v1 serialized values, is absent from renderer/deploy identity/drift, falls back safely on inspection failure, and rejects forged/oversized input.

### F. Ordinary SSH regression

1. Existing `ssh -N -R` plus separate probe tests remain unchanged for standard profiles.
2. Existing concurrent-capable Deploy / Repair behavior remains unchanged.
3. Existing forward-conflict recovery, unknown-strike limit, secure ingress, Node cache, and profile-isolation tests remain green.
4. `npm test` passes with no reduction of current coverage.
5. Ordinary helpers also wait for `close` before sequential reuse where lifecycle ordering matters, without acquiring a serialized transport lease.

## 7. Real verification matrix

Automated tests are necessary but not sufficient. Merge requires a real Windows OpenSSH + GitHub Codespaces run using a Host alias whose effective ProxyCommand is `gh cs ssh -c <name> --stdio`.

### 7.1 Reproducible harness procedure

Implementation must add a tracked manual harness/procedure (prefer `scripts/manual/remote-ssh-codespaces-546.ps1` plus a short README) with these properties:

1. Prerequisites: Windows OpenSSH, GitHub CLI, a clean `gh auth status` showing `codespace` scope, Node/npm dependencies, and explicit repository/branch inputs. Every `gh` invocation is requested with elevation and executed outside the sandbox, per `AGENTS.md`.
2. Create a uniquely named temporary 2-core Codespace for the requested repository/branch with a bounded retention; record its exact name and creation time in an evidence JSON file.
3. Generate a temporary SSH config/alias under the harness temp directory using GitHub CLI output. Never edit the user's `~/.ssh/config` or keys. All baseline SSH commands use `ssh -F <temp-config> <temp-alias> ...` with explicit 30/90-second deadlines.
4. Allocate a known free local loopback port for the standalone HTTP check and a test-only remote port. For the app flow, use only Clawd's normal `127.0.0.1:23333-23337` ingress allocation and record the chosen profile/remote port without recording its nonce.
5. Before and after every scenario, record exact test-owned `ssh.exe` and `gh.exe` PID/executable/command-line samples plus timestamps and role transitions. Never infer ownership from PID/start time alone; evidence must contain the unique Codespace name/config alias and redact paths/tokens/nonces.
6. V6 is a module-level manual integration run, not a packaged-app/UI debug feature. The script composes the production coordinator + IPC dependencies directly and decorates the injected spawn gateway in-process to fail one named safe pre-mutation/read-only role after a real tunnel drain. No environment switch, hidden IPC, or injection provider is added to `src/main.js` or packaged code. Evidence is the returned structured result plus phase/child ordering; separate unit tests cover unknown-result mutation quarantine. Add a test/static assertion that production composition does not import the manual harness or read a failure-injection flag.
7. V8 seeds a deliberately nonexistent absolute Node cache entry through the test harness, then proves the old tunnel closes before real rediscovery. It does not rename/remove the Codespace's real Node executable.
8. V9 starts a test-owned remote Node port holder under a unique `/tmp/clawd-546-*` record using a completed sequential SSH command, then Connect runs with no setup SSH still alive. Cleanup signals only the exact recorded remote helper through a later sequential SSH after Connect has stopped.
9. V10 tests the readiness contract outside the Settings deploy transaction. A completed sequential setup SSH writes a unique test identity document under `/tmp/clawd-546-<challenge>/identity.json`, scoped only to the temporary Codespace and test profile values, then exits. The one persistent test SSH runs the production readiness-command builder against that explicit test path while the local test ingress expects a different nonce; pass evidence is the classified readiness exit and absence of Connected/marker. After that SSH naturally closes, one sequential cleanup command removes only the exact test directory. It never edits a production Clawd layout/identity, invokes deploy ownership mutation, or weakens lease/fencing; it does not claim to be a full Settings UI scenario.
10. V13 remains connected for at least 60 seconds (at least two configured ServerAlive intervals), then sends one real supported hook event through the remote installation and observes the expected local state transition.
11. Each scenario writes command-independent evidence: timestamps, safe profile/Codespace identifiers, coordinator phase transitions, maximum managed child count, exit/close ordering, redacted results, and residue checks. Raw ProxyCommand, SSH config output, argv secrets, identity contents, and nonces are excluded.
12. In `finally`, first ask every test session/helper to exit naturally and wait with a bound. Delete the exact temporary Codespace with an elevated/out-of-sandbox GitHub CLI command even on failure. Never use broad `taskkill`, `Stop-Process`, process names, or Terminal-window closure for cleanup. If an exact helper cannot be proven test-owned, preserve it and ask the user to close it manually.

The procedure begins with the sequential `node -v` control, then runs V1-V14 in order. It must state the exact timeout for each phase and produce one timestamped evidence directory suitable for issue/PR attachment. A separate ordinary Linux SSH target is required for V15; if none is available, V15 is an explicit release blocker rather than inferred from unit tests.

### 7.2 Scenarios

| ID | Scenario | Pass condition |
|---|---|---|
| V1 | Sequential baseline | `ssh <alias> node -v` works before Clawd testing |
| V2 | Auto classification | profile is detected as Codespaces serialized without manual override |
| V3 | Connect without monitor | one managed `ssh.exe` / one ProxyCommand chain; remote-to-local secure health passes; UI becomes Connected |
| V4 | Connect with default auto monitor | every monitor SSH closes before the persistent tunnel starts; maximum managed concurrency stays one |
| V5 | Connected Deploy / Repair | graceful stdin EOF closes old tunnel and its exact ProxyCommand chain before the first deploy SSH/SCP; transaction succeeds; exactly one new tunnel starts afterward |
| V6 | Safe injected pre-mutation failure | original error is visible; reconnect follows current intent; no orphan child or mutation retry |
| V7 | Disconnect during Deploy | operation completes/fails safely and tunnel does not restart |
| V8 | Node path stale | tunnel closes, Node is rediscovered with no overlap, then Connect succeeds or fails actionably |
| V9 | Remote port occupied | `ExitOnForwardFailure` is surfaced; no false marker/Connected state |
| V10 | Bad identity / wrong nonce | readiness fails closed; no general-port fallback |
| V11 | Same Codespace, second profile | second profile gets busy and starts no second ProxyCommand chain |
| V12 | Interactive boundary | Open Terminal is blocked while managed serialized tunnel is live and works after explicit Disconnect |
| V13 | Longevity | tunnel survives at least two ServerAlive intervals and continues carrying real hook events |
| V14 | Cleanup | natural disconnect/delete and bounded async app quit leave no test-owned `ssh.exe`, `gh cs ssh --stdio`, or remote readiness Node; no broad process kill is used |
| V15 | Normal host regression | one ordinary Linux SSH target still passes Connect, Deploy / Repair, monitor, disconnect, and cleanup |

For process inspection, match the exact test Codespace/profile command line. The coordinator can prove only its top-level child lifecycle; V14 is the required evidence that natural close also tears down nested GitHub CLI and remote readiness processes on Windows. App quit must expose an async bounded drain gate before process exit. Do not terminate Windows Terminal, Codex, `cmd.exe`, arbitrary `ssh.exe`, OpenConsole, or conhost as cleanup.

## 8. Implementation phases

### Phase 0 — Characterization tests

- Write locally failing characterization tests for Codespaces `ssh -G` parsing, pre-spawn admission, single-session concurrency, distinct exit/close, default monitor ordering, and same-transport policy; commit them only together with the implementation that makes them green.
- Preserve current ordinary SSH tests unchanged.

### Phase 1 — Classification, lifecycle supervisor, and coordinator (inactive)

- Add profile field, bounded per-operation inspection, transport key, opaque lease, pre-spawn gateway, intent/attempt generations, graceful child supervisor, close barrier, and quarantine.
- Keep production automatic Codespaces activation behind an internal non-release flag while Connect/operation coverage is incomplete.
- Tests must prove no child starts without admission and no mutation begins before close.

### Phase 2 — Single-session readiness (still inactive)

- Add stdin-EOF readiness-and-stay command and exact marker parser.
- Switch only serialized transports away from `-N` plus separate probe.
- Add stale Node and exit-classification handling.

### Phase 3 — Full operation coverage and activation

- Make Connect/Disconnect Promise-aware.
- Add the one-per-intent monitor preparation epoch before tunnel start; keep auto reconnect read-only.
- Wrap the entire Deploy identity transaction.
- Cover cleanup historical targets, revoke, runtime-mode, ingress closure, and every remaining managed one-shot path.
- Add the handler intent/resume matrix, immutable-target drift barrier, mid-operation quarantine, and conditional resume from current intent/profile.
- Only after Phases 1-3 are complete and focused/full tests are green may automatic Codespaces classification affect production behavior. No releasable commit may contain the half-fixed state of a serialized tunnel plus separate probe or uncovered mutations.

### Phase 4 — UX, diagnostics, and docs

- Add advanced compatibility control, detected/busy/drain messages, progress detail, translations, and user documentation.
- Keep secrets and raw command lines out of UI/logs.

### Phase 5 — Verification and release gate

- Keep every commit green; run focused tests after each phase, then concrete `node --check` commands for every changed JavaScript file, `npm test`, and `git diff --check`.
- Run the tracked harness for V1-V14 on a temporary Codespace and V15 on a real normal SSH host.
- Delete the temporary Codespace after evidence collection.
- Do not close #546 or claim Codespaces support until the real matrix passes.

Minimum automated handoff commands (omit only a listed file that was not created/changed, and add any extra changed JavaScript file):

```powershell
node --check src/main.js
node --check src/remote-ssh-transport.js
node --check src/remote-ssh-transport-coordinator.js
node --check src/remote-ssh-runtime.js
node --check src/remote-ssh-ipc.js
node --check src/remote-ssh-node.js
node --check src/remote-ssh-shell-detect.js
node --check src/remote-ssh-deploy.js
node --check src/remote-ssh-profile.js
node --check src/settings-actions.js
node --check src/settings-tab-remote-ssh.js
node --check src/settings-i18n.js
node --test test/remote-ssh-transport.test.js test/remote-ssh-transport-coordinator.test.js test/remote-ssh-runtime.test.js test/remote-ssh-ipc.test.js test/remote-ssh-deploy.test.js test/remote-ssh-profile.test.js test/settings-actions.test.js test/settings-tab-remote-ssh.test.js test/settings-renderer-browser-env.test.js test/i18n.test.js
npm test
git diff --check
```

## 9. Rejected shortcuts

### 9.1 Only disconnect around Deploy

Rejected because Connect itself overlaps tunnel and probe; default monitor startup adds more overlaps; synchronous `disconnect()` does not drain; and other cleanup/runtime-mode operations still collide.

### 9.2 Only merge the health probe

Rejected as incomplete because Deploy, Node resolution, monitor maintenance, and cleanup still open one-shot sessions while the tunnel lives.

### 9.3 Per-profile mutex

Rejected because two profile aliases may resolve to the same Codespace transport. The concurrency domain is the effective transport target.

### 9.4 ControlMaster / ControlPath

Rejected as the primary Windows fix. OpenSSH multiplexing is not a reliable supported primitive in native Win32-OpenSSH, and the issue reporter observed instability on this path. It also would not replace Clawd's need for explicit operation ownership and lifecycle tests.

### 9.5 Trust process survival instead of end-to-end readiness

Rejected because it weakens secure ingress and can show Connected when the remote port, identity, routing nonce, or local service is wrong.

### 9.6 Blind retry of code 255

Rejected for mutations because remote execution may have completed before transport failure. Existing persisted transactions and explicit Retry are the safe recovery model.

### 9.7 Aggregate tunnel in v1

Rejected because one SSH carrying multiple profile forwards requires readiness fan-out, identity/port ownership, independent reconnect semantics, and UX that are much larger than #546. The v1 policy is one live profile per serialized transport.

### 9.8 Modify user SSH config automatically

Rejected. Clawd reads the effective config with `ssh -G`; it does not write `~/.ssh/config`, create Codespaces aliases, replace user ProxyCommand entries, or create SSH keys as part of this fix.

## 10. Acceptance checklist

- [ ] Codespaces stdio is automatically and correctly classified from effective SSH config.
- [ ] Explicit serialized override exists without invalidating remote deployment stamps.
- [ ] Unknown/failed first classification fails closed; no persistent profile-only cache can erase a prior serialized result.
- [ ] Process-lifetime sticky serialized evidence is precisely keyed/invalidated, never skips inspection, and is absent after restart.
- [ ] Every serialized SSH/SCP spawn passes a valid opaque reservation through the pre-spawn gateway; post-spawn registration cannot satisfy the invariant.
- [ ] Serialized Connect reaches Connected with exactly one persistent managed SSH chain.
- [ ] The ready marker proves the same secure end-to-end checks as today and contains no nonce.
- [ ] Intentional tunnel suspension ends stdin, waits for `close`, and is proven on Windows to leave no nested GitHub CLI/remote readiness residue.
- [ ] All one-shot helpers separate public operation result from close tracking: normal results settle/release on `close`; undrained timeout returns once while registry/reservation remain held.
- [ ] Default Codex monitor maintenance completes before the tunnel.
- [ ] Automatic reconnect never repeats monitor or another unknown-result mutation.
- [ ] Connected Deploy / Repair waits for verified close before any SSH/SCP mutation.
- [ ] The exclusive reservation covers begin-rotation through stamp/commit.
- [ ] A never-closing pre-operation or mid-operation child quarantines the slot and blocks callback continuation, lock-release SSH, mark/commit, reconnect, and replay.
- [ ] Late close changes only registry/slot state; invalid operation callbacks and persistence/spawn side effects remain unreachable.
- [ ] The plan introduces no fictional lock TTL/takeover: unknown acquire/locked mutation returns `manual_lock_inspection_required` and requires exact human verification.
- [ ] Disconnect during an operation prevents stale automatic resume.
- [ ] Every same-transport non-owner action returns busy, changes no intent, and spawns nothing.
- [ ] Cleanup historical targets, revoke, runtime-mode, Node, shell, and monitor paths use immutable per-target reservations.
- [ ] Historical serialized hints have the server-owned v1 schema and never enter deploy identity/drift or renderer input.
- [ ] Profile/config drift is revalidated before mutation and never re-keys a live child.
- [ ] Destructive disconnect/revoke/cleanup closes ingress before nonce/ownership revocation; old-nonce races fail closed.
- [ ] No blind mutation retry is introduced.
- [ ] Renderer/log results are bounded and redacted; raw `ssh -G`, ProxyCommand, argv, identity contents, and nonces are never retained.
- [ ] Ordinary SSH behavior and all existing security gates remain unchanged.
- [ ] Focused tests, explicit `node --check <changed-js>` commands, full `npm test`, and `git diff --check` pass at every commit.
- [x] Real Codespaces V1-V5 and V7-V14 plus normal-host V15 pass without orphan processes; V6 is a module-composition/automated negative-path gate and packaged code exposes no injection switch.
- [ ] The manual harness has no packaged-code failure-injection switch or hidden IPC.
- [ ] English, Simplified Chinese, Traditional Chinese, Korean, Japanese, and Brazilian Portuguese UI strings are complete.
- [ ] User/project documentation describes the compatibility mode and remaining interactive-terminal boundary.

## 11. Review record

This contract was reviewed after drafting and again after all blocking findings were integrated. No implementation files were changed during review.

- Architecture/concurrency review: **PASS** — pre-spawn admission, graceful drain, module ownership, monitor preparation epoch, and same-key non-owner policy are implementable.
- Security/transaction review: **PASS** — operation-result/close lifecycle split, invalid-token continuation guards, quarantine, target drift, nonce/ingress boundaries, redaction, and lock recovery semantics are explicit.
- IPC/runtime handoff review: **HANDOFF PASS** — phase activation, intent reducer, sticky classification, historical hint schema, real harness boundary, file map, and test commands are sufficiently specified for implementation.

### 11.1 Local implementation and verification record

The reviewed contract was implemented and final-smoked on 2026-08-09/10. The
implementation adds effective-transport inspection, an opaque pre-spawn
coordinator, persistent in-band readiness, graceful EOF drain, operation
intent/quarantine handling, Settings UI and locale coverage, historical
transport hints, and tracked Windows manual helpers. The final full suite is
green (`7340` tests: `7309` passed, `31` skipped, `0` failed).

PR #845 used two exact temporary Codespaces and isolated `USERPROFILE`, SSH
config, and Electron userData roots. V1-V5 and V7-V14 passed the real
Windows OpenSSH + `gh cs ssh --stdio` boundary. Highlights:

- a 10-minute redacted observer reported peak `ssh=1`, `gh=1` through default
  monitor preparation, Deploy/Repair, the persistent tunnel, reconnect, and
  disconnect transitions;
- V8 replaced a seeded nonexistent absolute Node cache with a valid resolved
  path/version before reaching Connected;
- V9 exposed a Win32/Codespaces peculiarity: the default SSH log level can
  return exit 255 with zero stdout/stderr on remote-forward rejection. The
  Codespaces serialized tunnel now enables DEBUG1 (`-v`); the same real command then
  exposed `remote forward failure`, and the production classifier returned
  permanent `forward_failed` with no false marker/Connected state;
- V10's tracked standalone helper used the production readiness builder and a
  test-only identity under `/tmp/clawd-546-v10-*`; the wrong nonce produced
  exit 3, no ready marker, one rejected request, and exact cleanup;
- V11 kept the live owner Connected while the same-Codespace sibling action was
  disabled; a forced click left the one SSH PID unchanged;
- V13 carried a real supported hook event after more than two ServerAlive
  intervals; the hook exited 0;
- V14 ended with zero local test SSH/GitHub CLI/Electron processes and zero
  remote monitor, test `/tmp` roots, or port-23333 listeners. Both exact
  Codespaces were deleted and verified absent.

V15 separately passed on a Raspberry Pi ordinary Linux SSH target: standard
classification, Deploy, Connect, Connected
Repair, Disconnect, ownership-safe cleanup/redeploy, normal quit, and remote
monitor residue checks all succeeded.

V6 is intentionally recorded as a module-composition/automated gate rather
than a packaged-app infrastructure scenario. A production failure-injection
switch or hidden IPC would create the security/maintenance surface this plan
forbids. Real drain/order behavior is exercised by V4/V5/V7; focused tests
inject the safe pre-mutation failure and prove the structured result, current
intent resume policy, and zero mutation replay/orphan child.

## 12. Primary references

- GitHub issue [#546](https://github.com/rullerzhou-afk/clawd-on-desk/issues/546)
- OpenSSH [`ssh(1)`](https://man.openbsd.org/ssh.1) for `-N`, `-R`, remote commands, forwarding, and session lifetime
- OpenSSH [`ssh_config(5)`](https://man.openbsd.org/ssh_config.5#ProxyCommand) for ProxyCommand behavior
- OpenSSH portable client flow around forwarding and session setup: [`ssh.c`](https://github.com/openssh/openssh-portable/blob/master/ssh.c)
- GitHub CLI Codespaces SSH implementation and generated ProxyCommand: [`pkg/cmd/codespace/ssh.go`](https://github.com/cli/cli/blob/trunk/pkg/cmd/codespace/ssh.go)
- Win32-OpenSSH ControlMaster tracking issue: [PowerShell/Win32-OpenSSH#1328](https://github.com/PowerShell/Win32-OpenSSH/issues/1328)

## 13. Handoff rule

This document is a reviewed implementation contract, not authorization to broaden Remote SSH architecture. If implementation discovers that an invariant cannot be met without changing ordinary SSH behavior, secure identity semantics, profile-isolation release gates, or user-owned terminal behavior, stop and revise this plan before coding further.
