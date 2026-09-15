# Manual validation harnesses

## Kimi Code quota Phase 0

This manual-only probe validates the experimental Kimi Code API-key usage
endpoint before any product integration is enabled. Create a dedicated Kimi
Code API Key in the Kimi Console, stop other Kimi activity for the sampling
window, then run:

```powershell
pwsh -NoProfile -File scripts/manual/kimi-quota-phase0-smoke.ps1 `
  -QuietWindowConfirmed `
  -Samples 3 `
  -IntervalSeconds 60
```

The wrapper uses hidden input and passes the key to the Node child only through
stdin. The helper has a compiled-in `https://api.kimi.com/coding/v1/usages`
endpoint, rejects redirects by construction, uses a real `Clawd/...` user
agent, caps the body at 64 KiB, and writes only a sanitized report to the OS
temporary directory. It does not accept a key on argv, from an environment
variable, or from a file. Do not paste the key into chat, a shell command, a
fixture, or the repository.

Compare the sanitized 5-hour and weekly values/reset times with the interactive
Kimi Code `/usage` panel. Revoke the dedicated test key in the Kimi Console
after the test; deleting the local report does not revoke the remote key. A
successful response proves only the technical endpoint/schema gate. It does
not grant permission for background polling, so product code remains
manual-only unless Kimi gives public or written permission.

---

## Remote SSH Codespaces serialization (#546)

This harness validates the Windows OpenSSH + `gh cs ssh --stdio` boundary that unit tests cannot prove. It creates (or accepts) one exact Codespace, generates an isolated SSH config under a timestamped evidence directory, runs the sequential control and effective-transport checks, then starts the development app with a temporary `USERPROFILE` so the user's real `~/.ssh/config` is not edited.

Run it from an elevated/out-of-sandbox PowerShell whose `gh auth status` includes the `codespace` scope. The development app receives an explicit temporary OpenSSH `-F` config through `CLAWD_REMOTE_SSH_CONFIG_FILE` and a temporary Electron `--user-data-dir`, so neither SSH config nor Clawd prefs are read from or written to the user's normal profile. (`USERPROFILE` alone does not redirect Windows OpenSSH.)

```powershell
pwsh -NoProfile -File scripts/manual/remote-ssh-codespaces-546.ps1 `
  -Repository owner/repository `
  -Branch main
```

For a bounded, redacted process-concurrency trace while the app checklist is
running, start the companion observer in another elevated PowerShell. It stores
only PID/parent PID, image/role, timestamps, command hashes, and peak counts;
raw command lines are never written.

```powershell
pwsh -NoProfile -File scripts/manual/remote-ssh-codespaces-546-observe.ps1 `
  -Codespace <exact-codespace-name> `
  -OutputPath <evidence-dir>\transport-observation.json `
  -DurationSeconds 600
```

Use `-ExistingCodespace <exact-name>` to reuse a dedicated test Codespace. The script deletes only a Codespace it created itself; `-KeepCodespace` disables that deletion. It never uses `taskkill`, `Stop-Process`, or process-name cleanup. If exact test residue remains, it records safe PID/role/command hashes, preserves the processes, and asks for manual inspection.

## App checklist (V3-V14)

Create one Remote SSH profile using the alias printed by the script. Do not copy the temporary SSH config into the real user config.

- V3 — Disable automatic Codex monitor, Connect, and confirm Connected with one managed SSH/ProxyCommand chain.
- V4 — Enable automatic Codex monitor, reconnect, and confirm monitor one-shots finish before the persistent tunnel.
- V5 — While Connected, run Deploy / Repair. Confirm the old tunnel closes naturally before the first deploy SSH/SCP and exactly one tunnel resumes afterward.
- V6 — Covered by module/manual composition and automated timeout tests; packaged builds expose no failure-injection switch.
- V7 — Start Deploy, click Disconnect during it, and confirm no tunnel resumes.
- V8 — Use a test profile with deliberately stale detected Node metadata; confirm rediscovery happens only after the prior tunnel closes.
- V9 — Use a test-owned remote port holder created by a completed sequential SSH command. Connect must surface `ExitOnForwardFailure`, never Connected. Stop the holder only after Connect has ended.
- V10 — Run the dedicated readiness contract against a test-only identity under `/tmp/clawd-546-<challenge>`; never edit a production Clawd identity or bypass lease/fencing.
- V11 — Add a second profile for the same Codespace. Its Connect must return busy and start no second ProxyCommand chain.
- V12 — Open Terminal must be blocked while the serialized managed session is non-idle, and work after explicit Disconnect.
- V13 — Stay Connected for at least 60 seconds (two ServerAlive intervals), send one real supported hook event, and observe the local state transition.
- V14 — Disconnect and quit Clawd normally. The harness checks for exact Codespace-related `ssh.exe`/`gh.exe` residue after app exit.

Record each observed result in the issue/PR alongside `evidence.json`. The evidence deliberately excludes raw SSH config, ProxyCommand, argv, identity data, paths, tokens, and routing nonces.

V9 has a tracked interactive port-holder entry point. It starts the exact
test-owned listener, waits for the setup SSH child to reach `close`, and then
holds locally without an SSH transport while you run the app Connect attempt.
Press Enter only after that attempt has fully ended; only then does it open one
sequential cleanup SSH and remove its exact `/tmp/clawd-546-v9-*` root.
If the prompt is interrupted, the helper deliberately opens no cleanup SSH and
prints a safe holder ID. After the app attempt ends, recover with the same
config/host plus `--cleanup-id <holder-id>`.

```powershell
node scripts/manual/remote-ssh-codespaces-546-port-holder.js `
  --ssh-config <absolute-temp-config> `
  --host <exact-temp-alias> `
  --remote-port 23333
```

V10 has a tracked standalone entry point. Run it only after all app-managed
transport for the exact Codespace has stopped:

```powershell
node scripts/manual/remote-ssh-codespaces-546-readiness.js `
  --ssh-config <absolute-temp-config> `
  --host <exact-temp-alias>
```

The helper resolves remote Node through one completed sequential SSH, writes a
test-only identity beneath `/tmp/clawd-546-v10-*` without putting its nonce in
argv, runs the production readiness-command builder against a deliberately
different local nonce, waits for `close`, and removes only its exact test root.
Pass output reports `exitCode:3`, `markerSeen:false`, and
`wrongNonceRejected:true` without printing either nonce or the identity path.

## PR #845 verification record (2026-08-10)

- V1/V2 passed twice on temporary Codespaces: Node v24.14.0 and automatic
  `codespaces-stdio` classification.
- V3/V4/V5 passed through the isolated Settings UI. Deploy, default monitor
  preparation, persistent readiness, Connected Repair, and resume never
  exceeded one `ssh.exe` plus its one `gh.exe --stdio` child.
- V6 remains a module-composition/automated negative-path gate; packaged code
  exposes no failure-injection switch.
- V7 passed: Disconnect during Deploy left the profile disconnected.
- V8 passed from a seeded nonexistent absolute Node cache. Connect finished
  green, and the isolated prefs replaced the stale value with a valid resolved
  absolute Node path/version before the persistent tunnel.
- V9 never produced a false marker or Connected state. A real Win32
  OpenSSH/Codespaces control proved the default log level can return exit 255
  with zero stdout/stderr; the Codespaces serialized `-v` command exposed the real remote
  forward failure, and the production classifier returned permanent
  `forward_failed`.
- V10 passed with `exitCode:3`, no marker, one rejected wrong-nonce request,
  and exact `/tmp` cleanup.
- V11 passed with two profiles resolving to the same Codespace key: the live
  owner was green Connected, the sibling Connect was disabled, and clicking it
  left the single SSH PID unchanged.
- V12 passed: interactive terminal launch was blocked while the managed
  serialized session was live and worked after explicit Disconnect.
- V13 passed beyond two ServerAlive intervals. A real `UserPromptSubmit` hook
  exited 0 over the live tunnel, and the 10-minute observer recorded peak
  `ssh=1`, `gh=1`.
- V14 passed after normal final-instance quit: local test `ssh`/`gh`/Electron
  counts were zero; remote monitor, test `/tmp` roots, and port 23333 listeners
  were zero. Both exact temporary Codespaces were then deleted and verified
  absent.
- V15 passed on a separate Raspberry Pi ordinary Linux SSH target: classification, Deploy,
  Connect, Connected Repair, Disconnect, cleanup/redeploy, and normal quit all
  succeeded with no remote monitor residue.

## V15 ordinary-host release blocker

The Codespaces script cannot validate the unchanged parallel path. Before release, use a separate ordinary Linux SSH host and verify Connect, Deploy / Repair, optional monitor, Disconnect, cleanup, and normal app quit. If no ordinary host is available, report V15 as pending; do not infer it from Codespaces or unit tests.

## PR #975 Hermes Remote SSH verification (2026-09-09)

The maintainer fixes were validated on a Raspberry Pi 5 (Debian Linux aarch64,
Node 24.18.0, Hermes Agent 0.20.5), before pushing or merging. The harness used
the production Settings controller/IPC, deployment, transport, nonce-checked
ingress, state route and state machine with real SSH. It used cloned local
Settings and the verified existing installation binding; this was a module
composition smoke, not a Settings GUI smoke.

- Standard-home Deploy verified the plugin hashes, secure marker, enable entry
  and identity commit. Hermes CLI reported Clawd 0.3.0 enabled. The local
  `enabled` flag changed only after success; `integrationInstalled` stayed intact.
- A real API-backed Hermes session executed `printf PR975_PI_SMOKE` and returned
  `PR975_PI_OK`. Clawd received SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, Stop and SessionEnd with the correct profile and no remote process
  metadata. The ordinary SSH connection stayed healthy beyond 60 seconds.
- Connected Repair succeeded and the plugin remained enabled. Cleanup with a
  test-owned foreign leaf preserved that file, retained the installer, and
  reported the precise residual path. Removing that exact fixture allowed the
  real uninstaller to complete.
- Original hook/config files and identity were restored with byte/mode checks;
  all harness transport children exited. User Settings were not changed and no
  Hermes gateway was restarted.
- Windows regression: 541 passed, 9 POSIX skips across 13 files. Hermes installer,
  plugin and SSH deploy regressions passed on both WSL and the Pi: 146 passed,
  zero failures or skips in each. Pi fixtures used a dedicated HOME so the real
  secure identity did not affect ordinary/no-server cases.

The live API smoke covered the account-default root home. Named-profile
filesystem behavior and isolated-layout cleanup exclusion were covered by the
native Pi regressions. This adds no live gateway-reload or Codespaces claim.

### Hermes opt-in permission callback follow-up (2026-09-09)

Real API sessions exposed a pre-existing callback error: an opted-in tool name
was passed both positionally and in the upstream keyword payload, so Python
raised before the permission request and Hermes continued the tool. The fix
passes the callback keywords once and preserves the tool name in subsequent
state events. A regression invokes the registered callback for Allow, Deny and
no-decision; it fails with the original TypeError before the fix.

Validation used the running Windows desktop app and its Settings Deploy/Repair,
with the same Raspberry Pi 5 / Hermes 0.20.5 account-default root home. Each
fresh test CLI temporarily set `CLAWD_HERMES_PERMISSION_TOOLS=terminal`; no
gateway was restarted and the opt-in was not persisted.

- The user clicked Approve on the real desktop bubble. The remote tool record
  contained the expected `printf` output and exit code 0.
- The user clicked Deny on a second real bubble. Its remote tool record contained
  `User denied this tool execution` and no execution output. The agent did not
  retry the blocked tool.
- Dashboard snapshots carried the correct remote profile/host with no local
  terminal PID. The SSH connection remained healthy after both sessions.
- Windows plugin, installer and permission-route regressions: 172 passed,
  zero failures, one privileged-symlink skip.

This verifies the explicit tool opt-in path. It does not claim that Hermes'
native once/session/always approval UI is fully intercepted.
