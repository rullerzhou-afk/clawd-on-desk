# Release Process

Use this flow when preparing a Clawd app release.

## Before Tagging

1. Update `package.json` to the release version.
2. Add `docs/releases/release-vX.Y.Z.md`.
3. Run the local tests that match the change scope. For full release prep, run:

```bash
npm run verify:release
npm test
npm run audit:assets
```

4. Run the `Build & Release` workflow manually on `main`.

For macOS Developer ID certificate creation, App Store Connect Team API key
setup, local verification, and the exact GitHub Actions secret names, follow
[`docs/guides/release-signing.md`](../guides/release-signing.md). Never commit a
`.p12`, `.p8`, certificate password, or decoded secret file.

Manual workflow dispatch builds Windows, macOS, and Linux artifacts, checks
each unpacked resources tree for retired Telegram sidecar binaries/source, and
gates every package on its target-native Koffi payload, a packaged positive-call
smoke, and updater metadata matching both the generated artifacts and the exact
`package.json` release version. It then uploads
the installers plus JSON evidence manifests. It does not publish a GitHub
Release.

When all five macOS signing secrets are configured, the manual workflow produces
Developer ID signed and notarized apps, then mounts both generated DMGs and
verifies the exact app bundle each DMG contains. With none of the secrets
configured, a manual run explicitly retains the ad-hoc validation path. A
partial secret set always fails. A `v*` tag build fails closed unless the full
secret set is available, so an official draft cannot silently contain an ad-hoc
macOS build.

Each staged application must contain exactly one physical Koffi native addon at
`app.asar.unpacked/node_modules/koffi/build/koffi/<target-triplet>/koffi.node`.
The native inventory audit must reject every foreign-architecture binary except
the exact electron-builder-managed Windows `resources/elevate.exe` ia32 helper.
Do not rewrite `app.asar` from `afterPack`: electron-builder records ASAR
integrity before that hook, so Koffi cleanup is physical-file pruning only.

## Draft Release

After the manual build artifacts look good, create and push the final version
tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing a `v*` tag runs the same build workflow again and creates a draft GitHub
Release with the generated installers and release notes. Draft releases are not
visible to normal users and are not consumed by the updater.

Download and smoke-test the draft release assets before publishing the draft.
If the draft is wrong, fix the issue before publishing; do not publish a known
bad draft release.

### v1.0.0 Draft Smoke Checklist

Use the draft release installer or package artifact, not `npm start`. Windows
required items are the primary publish gate. If macOS or Linux hardware is not
available, record that platform as not real-machine validated in the release
notes.

Before launching:

- Download the draft release asset for the platform being tested.
- On macOS, download each DMG through a browser so it carries quarantine
  metadata. Confirm it opens without a Privacy & Security override, then verify
  the copied app with `spctl` and `stapler` as documented in the signing guide.
- Confirm the packaged app shows `1.0.0` metadata.
- Confirm packaged resources include `app.asar.unpacked/hooks`,
  `app.asar.unpacked/agents`, `app.asar.unpacked/extensions`,
  and `app.asar.unpacked/themes`.
- Confirm the retirement assertion passes and neither
  `sidecars/cc-connect-clawd` nor any `cc-connect-clawd(.exe)` exists.
- Confirm Windows artifacts are architecture-specific x64 / ARM64 installers,
  not a universal NSIS installer.
- Download the native-package, Koffi prune/smoke, and updater metadata manifests.
  Confirm the target has one matching `koffi.node`, no foreign native payload,
  and no unreviewed exception. Confirm each updater metadata `version` and every
  listed artifact filename identify `1.0.0`.
- For migration smoke, install v0.16.0 first and save a copy of the old
  `clawd-prefs.json` before upgrading.
- For legacy Feishu/Lark migration smoke, enable remote approval in v0.15.0 with saved
  App credentials and an approver before upgrading. Keep the old
  `feishu-approval.env` alongside the prefs copy.
- For Reasonix smoke, prepare a machine with Reasonix initialized so
  `<Reasonix home>/` exists (`%APPDATA%\reasonix` on Windows,
  `~/.reasonix` on macOS/Linux). A skipped install because Reasonix is missing
  does not validate the packaged hook path.
- For Remote SSH smoke, prepare at least one saved profile that can connect
  through an SSH reverse tunnel.

Required all-platform checks:

- Fresh install, launch, pet appears, no error dialog.
- Footprints is enabled by default. Confirm Today/Week/Month/Year show local
  accepted activity and coverage, preserve unsupported metrics as a dash, and
  add no content or raw identifiers to storage. Turn recording off/on and clear
  during a pending completion: old counts must not reappear, while the normal
  completion animation still works. Recovered/locked preferences must visibly
  report recording paused until an explicit, permitted Settings action resumes it.
- Move the system timezone west after recording, then inspect Today/Week.
  Recorded activity and coverage at the frozen local hour remain visible.
- With enough permission requests to overflow a small display, exercise queue
  loading/ACK failure and native window clamping. Allow/Deny shortcuts must not
  decide a partly clipped or hidden target; normal safe cards remain usable.
- End Codex turn A, then let its delayed question/output reach the JSONL monitor.
  It must not revive A or extend turn B. Real current-turn questions still keep
  an active task alive. Upgrade a profile with a long generic working timeout
  and no Codex-specific value: preserve its previous effective Codex duration.

- Upgrade install over v0.16.0, launch, pet appears, no error dialog. Existing
  agent installation/enabled flags and user theme/animation choices remain intact.
- Settings -> About shows `v1.0.0`, sourced from `app.getVersion()`.
- First-run tutorial opens once for a fresh profile; Finish, Skip, and OS close
  each persist `tutorialSeen=true` and do not reopen on restart.
- Upgrade profile with no `tutorialSeen` sees the tutorial once; an already-seen
  profile does not reopen it.
- Existing macOS users keep their previous Dock setting after upgrade; fresh
  macOS installs default to pet + menu-bar accessory with no Dock tile.
- Settings -> General / Agents / Animation & Sound render correctly in all supported
  languages, including sidebar SVG icons and the folded Animation Map subtab.
- Settings -> About contributors include the three v1.0.0 first-time
  contributors: `eugenewang5425`, `draintovmasyan783-creator`, and `Yueh-H`,
  while preserving all previous contributors.
- Make `clawd-prefs.json` temporarily unreadable and launch once. Confirm the
  startup warning and Doctor critical item both explain that agent events and
  approvals are paused; restore access and restart before continuing.
- Replace `clawd-prefs.json` with truncated JSON and launch once. Confirm the
  original bytes are retained in `clawd-prefs.json.bak`, startup and Doctor say
  the recovered defaults are non-authoritative for this launch, and every agent
  event/permission/sync gate stays closed until Settings are reviewed and Clawd
  is restarted.
- Repeat with a path collision that prevents `clawd-prefs.json.bak` from being
  created. Confirm the primary file remains byte-for-byte unchanged, Settings
  writes stay locked, and startup/Doctor report backup failure without claiming
  that a backup exists.
- Reinstall one existing hook-based agent, such as Codex, and confirm the
  packaged hook script can `require()` its dependencies.
- Run one real Claude Code or Codex session and confirm the pet reacts to state
  changes and still plays completion happy on Stop.
- Confirm a completed turn uses the distinct default completion sound rather
  than the ordinary confirmation cue.
- Run one real OpenCode session through a title rename, tool activity, and
  SessionEnd. HUD/Dashboard must show the bounded title, retain causal ordering,
  and remove the session without replaying a stale state after a slow endpoint.
- Stop Clawd while OpenCode is running, trigger a permission request, and confirm
  the plugin leaves the decision in OpenCode's native UI without POSTing its
  reverse-bridge credentials to another listener in the Clawd port range.
- Restart Clawd during an active Claude session, then let the real hook resume
  and end it. Dashboard/HUD must keep one canonical session throughout and
  remove it cleanly on SessionEnd, with no duplicate or ghost recovery row.
- Exercise manual accessories on normal, interrupt, sleep, idle, reaction, and
  mini animations. Animation Map overrides must keep the wardrobe available;
  a frame without safe geometry hides only that frame's accessory. Toggle the
  holiday option and confirm it temporarily overrides, then restores, the
  saved manual accessory.
- Exercise Ask every time, Question prompts only, and Auto-approve at both the
  global and live-session scopes. Confirmation gates must appear where required,
  and the unattended runtime elevation must downgrade after restart.
- Feed Claude and Codex quota data from local plus Remote SSH sources. Confirm
  per-source values appear in Dashboard and the configurable pet Orbit ring,
  merge-across-machines can be turned both on and off, and an occupied third-party
  Claude statusline is preserved unless explicit chaining is enabled.
- Trigger a long CJK Claude or Codex completion and confirm the Stop event reaches
  Clawd without a 413 and the happy animation is not dropped.
- Codex official hook health: disable hooks / leave hooks unreviewed, confirm
  Agents badge or startup nudge reports attention, then repair/review and
  confirm it returns healthy.
- Claude hook health: delete one managed hook script and atomically replace
  `settings.json`; confirm the watcher/periodic audit repairs supported damage,
  while a still-missing declared core event is never reported as a successful Fix.
- Register two custom HTTP agents and send the same raw `session_id` from both;
  confirm Dashboard keeps separate sessions, then disable/delete one and confirm
  the other remains intact. Forged/stale `custom-` ids must be rejected.
- Install WorkBuddy against the current `~/.workbuddy-ai/settings.json` path and
  confirm state + Notification events arrive without Clawd taking over approval.
- Install MiMo Code into a commented/trailing-comma JSONC config, exercise
  Allow/Always/Deny and DND fallback, then uninstall and confirm user config is preserved.
- Settings -> Agents -> Install Reasonix succeeds on Windows when paths contain
  spaces, and the written command uses the EncodedCommand path when needed.
- Install TraeCode on Windows with Node under `C:\Program Files`, enable the
  hooks in Trae CN using Sandbox mode, and confirm all six event types exit 0;
  then uninstall and confirm all six encoded managed entries are removed.
- Set `REASONIX_HOME` to an unresolved variable and confirm install/sync fails
  closed without writing `settings.json` into the launch directory.
- Install ZCode and confirm lifecycle events plus a real `PermissionRequest`
  reach Clawd. Exercise manual Allow and Deny, then confirm no-decision falls
  back to ZCode's native permission flow and permission automation stays
  unavailable. From an Orca pane, jump back to the session and confirm the
  validated pane key focuses the correct pane locally and over managed Remote SSH.
- Install QwenWork on Windows or macOS and confirm lifecycle state reaches Clawd,
  `PermissionRequest` / `PermissionDenied` remain observation-only, and uninstall
  removes only Clawd-managed hook entries.
- Remote SSH profile with connect-on-launch connects after startup; repeat with
  local port 23333 occupied so the server binds a later port and the tunnel still
  targets the real bound port.
- Upgrade a Remote SSH target that still has the legacy Codex monitor PID file;
  deploy/cleanup must complete without shell `bad substitution`. Confirm
  revoke-all invalidates both current and previous routing nonces, and a normal
  edit of a profile-isolated profile preserves its runtime mode/key/layout.
- Upgrade a profile that used the retired Telegram sidecar. Confirm the one-time
  startup reminder points to Settings -> Remote Approval, saved token/recipient
  values remain, and approval plus completion notifications stay disabled until
  a real native verification callback succeeds. Failure/timeout must not restart
  the retired sidecar.
- Upgrade the prepared legacy v0.15.0 Feishu/Lark profile. Confirm the legacy setup
  remains fail-closed, a one-time startup warning points to Remote Approval,
  and Doctor reports the binding problem. Re-save the selected platform and
  App ID/App Secret, then re-save the approver; restart and confirm the client
  becomes ready without another warning.
- Install the DeepSeek Harness bridge with its managed root reached through a
  filesystem symlink. Confirm install and Doctor both report the verified
  generation as healthy; foreign same-name packages must still fail closed.
- Enable Discord Rich Presence without animation mirroring, then opt into the
  animation mirror. Confirm coarse status text remains stable, supported Clawd
  animations use the repository-hosted GIFs, and disabling the option returns
  to state-based presence.

Recommended all-platform checks:

- Free roam: enable it, wait idle, confirm the pet moves, keeps hitbox/HUD/bubble
  alignment, and cancels on mouse move, state change, drag, mini mode, and DND.
- Free roam constraints: exercise axis off/horizontal/vertical both with and
  without a valid fence, then use a small fence and invalid/missing fence input.
  Targets must remain reachable and on-screen, with invalid input falling back
  safely.
- Dizzy spin: on the Clawd theme, circle the cursor rapidly and confirm dizzy
  triggers; repeat on Calico/Cloudling and confirm no unsupported-state glitch.
- Low-power idle mode: verify sleeping/Cloudling static sleep behavior and that
  the HUD can be reclaimed/reopened without a blank surface.
- Right-click Hide pet / Show pet still works; while hidden, a newly arriving
  permission request still shows a bubble, by design.
- Settings -> About -> Check for updates completes without an error.
- Update labels never show a duplicated prefix such as `vv1.0.0`.
- Telegram approval cards show the final outcome for decisions made on Telegram
  and for approvals resolved elsewhere.
- Scan the mobile PWA pairing URL on a phone and confirm session cards appear.
- Regenerate or reset the mobile token and confirm the phone can reconnect with
  the new token.

Windows checks:

- Required: enable fullscreen auto-hide, enter a fullscreen application, and
  send a new permission request. Local surfaces stay hidden; leaving fullscreen
  restores only requests still pending. Manual Hide pet keeps its separate
  behavior for new requests; remote approval and configured auto-close still work.
- Required: cold-start the packaged app twice with a saved upgrade position;
  the first rendered pet visual must appear at that position without using
  "Bring Pet to Primary Display" / "将桌宠拉回主屏".
- Required: fullscreen/borderless game or video app smoke. The pet should float
  over the fullscreen app when overlay mode is on; clicking or dragging the pet
  must not kick the app out of fullscreen.
- Required: lock/sleep/resume or display wake smoke with low-power idle enabled;
  eye tracking should recover after the renderer reports wake recovery.
- Required: drag a folder onto the pet and confirm a terminal opens in that
  directory.
- Required: right-click New Session starts Claude Code without `0x800700c1`.
- Required: prompt submission under Windows Terminal produces no visible
  PowerShell flash; cloak/sleep/display-wake recovery restores the pet and tray
  icon without a transient size jump.
- Recommended: focus jump targets the correct terminal.
- Recommended: after restart, the pet restores its saved position and Keep size
  across displays does not grow after DPI/display-scale changes.

macOS checks:

- Required when macOS hardware is available: manually install the signed v1.0.0
  DMG over v0.16.0 once, preserving app data. Validate a signed A→B updater pair
  from an update-capable build on each available architecture, including
  Restart Now and Later/quit/reopen; record exact versions and asset hashes.
  A source run or a mocked updater does not complete this gate.
- Required when macOS hardware is available: toggle menu-bar and Dock visibility,
  restart, and confirm both preferences persist and Settings can still regain focus.
- Required when macOS hardware is available: test Dock left/right/bottom plus
  auto-hide and confirm physical-edge pinning stays on-screen across displays.
- Required when macOS hardware is available: Ghostty cross-Space focus switches
  to the target Space without yanking the Ghostty window to the current desktop.
- Required when macOS hardware is available: answer a permission with
  Ctrl+Shift+Y or Ctrl+Shift+N and confirm focus is not stolen back to the agent
  terminal.
- Required when macOS hardware is available: while editing text in a permission
  or elicitation bubble, the pet drops behind the input surface and the IME
  candidate window remains visible; ending edit restores stationary behavior.
- Recommended: jumping back to a session restores a minimized terminal window.
- Recommended: dragging a folder onto the pet does not open a terminal and does
  not crash. This is intentionally disabled on macOS.

Linux checks:

- Required when Linux hardware is available: Wayland session launches
  successfully and relaunches under XWayland when available; pet transparency
  and positioning work.
- Required when Linux hardware is available: MiMo JSONC install/uninstall keeps
  executable modes and comment-preserving writes correct on a POSIX filesystem.
- Recommended for tmux users: focus jumps to the correct tmux pane.

All required Windows items must pass before publishing the draft. Required macOS
and Linux items must pass when those machines are available. If any required
item fails, fix it and create a new draft release; do not publish a known-bad
draft.

## Retired Telegram Sidecar Guard

The legacy Telegram sidecar was removed in v0.14.0. Release builds must run
`scripts/assert-no-retired-telegram-sidecar.js` against every unpacked target:
Windows x64/arm64, macOS x64/arm64, and Linux x64. The assertion scans both the
outer resources tree and the real `app.asar`; a retired executable or runtime
module is a hard failure.

## WinGet Publishing

Publishing the draft release fires `.github/workflows/winget.yml`. **It currently
prepares only** — it generates the manifest komac would submit and uploads it as
an artifact. It holds no long-lived PAT or repository secret; the ambient job
`GITHUB_TOKEN` it uses has `contents: read` and cannot write to this repository or
to winget-pkgs. Automatic submission is deliberately not enabled yet; see the
staged plan below.

As of 2026-08-23, the upstream 0.14.0 manifest has been repaired and published by
[`microsoft/winget-pkgs#416019`](https://github.com/microsoft/winget-pkgs/pull/416019),
and v0.15.0 was subsequently published by
[`microsoft/winget-pkgs#419082`](https://github.com/microsoft/winget-pkgs/pull/419082)
on 2026-08-18. The v0.15.0 installer manifest carries the four expected
architecture/scope entries and its locale declares `License: AGPL-3.0-only`.
The former Dumplings tracker was also removed in
[`SpecterShell/Dumplings#130`](https://github.com/SpecterShell/Dumplings/issues/130),
so it is not currently competing with the maintainer-owned release path.

The catalog gap is closed, but the published v0.15.0 locale still points both
`LicenseUrl` and `ReleaseNotesUrl` at v0.14.0. Its files were generated with
winmatsch, so their publication does not validate this repository's komac output.
The first v0.15.0 prepare run
[`31654717731`](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/31654717731)
also predates the upstream repair and reproduced the old two-x64 shape. The
workflow therefore stays prepare-only until its **generated output** is validated
automatically; a correct upstream installer matrix alone is not sufficient reason
to expose a submission token.

**The workflow must already be on `main` before the tag is created.** For
`release` events GitHub reads the workflow definition from the tagged ref, so a
tag cut before this file landed can never trigger it — including v0.14.0, which
was published on 2026-08-02.

The workflow checks out the default branch **explicitly** for tooling, then reads
the target tag's `package.json` through the API and passes it with
`--package-json`. Without an explicit `ref:`, `actions/checkout` takes the ref
that triggered the run — for a release event that is the tag, which for older
releases does not contain this tooling at all. Splitting the two keeps the
tooling current while the installer filenames stay tied to the tree that actually
produced the release's assets.

### Why submission is staged rather than immediate

`komac update` does not turn the URLs it is given into installer entries. It
reads the **previous** manifest and emits one entry per previous entry, matching
each to its best new installer
(`src/commands/update_version.rs` -> `src/match_installers.rs`, which iterates
`previous_installers`). Passing correct URLs therefore does not produce a correct
manifest: if the upstream shape is wrong, komac faithfully reproduces it.

Before the upstream repair, the v0.14.0 manifest had two entries, both
`Architecture: x64` — those two were the **user/machine scope split**, carrying
`/currentuser` and `/allusers`, not two architectures. Scoring both against a
correct pair of new installers gave the x64 installer 8 points and the arm64
installer 6, so both previous entries took x64 and the arm64 installer was
discarded.

That manifest was repaired by hand in `microsoft/winget-pkgs#416019`. The live
shape is now **four** entries, not two:

| Architecture | Scope | Installer | Custom |
| --- | --- | --- | --- |
| x64 | user | `...-x64.exe` | `/currentuser` |
| x64 | machine | `...-x64.exe` | `/allusers` |
| arm64 | user | `...-arm64.exe` | `/currentuser` |
| arm64 | machine | `...-arm64.exe` | `/allusers` |

Collapsing to two entries would drop the per-user/per-machine choice the NSIS
installer supports (`build.nsis` sets `oneClick: false` and no `perMachine`).

### Staged plan

1. **Prepare-only plumbing — complete; still the current execution mode.** Hosted
   run
   [`31549249655`](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/31549249655)
   successfully exercised the workflow, token, installer downloads and artifact
   paths. Against the then-broken upstream manifest it reproduced komac's bad
   two-x64 output, confirming why automatic submission had to remain disabled.
2. **Repair upstream — complete.** `microsoft/winget-pkgs#416019` fixed v0.14.0
   to the four entries above, changed the license to `AGPL-3.0-only`, passed the
   full validation pipeline and was published on 2026-08-17. The competing
   Dumplings tracker has also been removed.
3. **Validate komac's output — next.** Run prepare against the current four-entry
   upstream shape to retain an unmodified sample. Then extend the gate to parse
   the generated YAML and assert the package identifier/version; exact
   `{x64, arm64} x {user, machine}` set; each entry's URL, SHA256 and `Custom`
   switch; `InstallerType: nullsoft`; `UpgradeBehavior: install`; top-level
   `InstallerSwitches.Upgrade: --updated`; and ProductCode
   `3e932233-a8b2-5530-b285-e0ceb08488f2` at both the installer and
   `AppsAndFeaturesEntries` levels. The locale manifest must carry
   `License: AGPL-3.0-only` plus version-pinned `LicenseUrl` and `ReleaseNotesUrl`.
   Komac overwrites `License` from the repository's current `licenseInfo.spdxId`,
   which GitHub reports as `AGPL-3.0`, not the `AGPL-3.0-only` in `package.json`,
   so the gate must rewrite and then assert these fields rather than accepting the
   raw output. Until this gate lands, the per-release manual review must enforce
   the same contract; the published v0.15.0 manifest is not evidence that komac's
   generated output is safe.
4. **Enable submission — optional and not started.** Split into `prepare` and
   `submit` jobs so the PAT exists only in the final step, and pin every `uses:`
   to a commit SHA at that point. Prefer a dedicated account for the token:
   `public_repo` grants write access to every public repository its owner can
   write to, this one included.

### Why the installer filename is a contract

electron-builder emits a **32-bit x86 NSIS stub for both the x64 and the arm64
target**, so PE-header inspection reports `x86` for both installers. Komac
resolves architecture from the URL and lets that value override whatever binary
analysis produced, so the `${arch}` token in `build.win.artifactName` is the only
correct architecture signal we publish.

`npm run verify:winget-arch` enforces this. It ports the upstream
`Architecture::from_url` delimiter algorithm and fails the release if a filename
stops resolving to the architecture it was built for, if two targets collapse
onto one architecture, if the published set is not exactly `x64` and `arm64`, if
a filename stops matching the workflow's `INSTALLERS_REGEX`, if the release
carries a stray asset that regex would also select, if the release tag disagrees
with `package.json`, or if both installers share a digest.

**This gate checks komac's input, not its output.** It cannot detect the
shape-preservation problem described above; validating the generated YAML is a
separate step (stage 3).

This guard exists because the third-party bot that previously owned the manifest
forwarded only the first matching `.exe`. That was harmless while we shipped one
Windows installer; from **v0.6.2** (2026-04-27), the first release to publish
`-x64.exe` and `-arm64.exe` side by side, through v0.14.0 — **12 versions** —
the original manifests each declared two `Architecture: x64` entries that both
pointed at the **arm64** installer. The NSIS stub runs on x64, so the install
reported success and the app then failed to launch.

### Why komac is invoked directly

The obvious choice, `winget-releaser`, is a composite action whose own steps run
`cargo-bins/cargo-binstall@main` (a mutable branch ref) and
`cargo binstall komac -y` (an unpinned build) — both in the same job, both
*before* the step that would receive a PAT. Pinning that action to a commit SHA
freezes the wrapper and neither of those links, so the workflow installs komac
itself from a release archive whose SHA-256 is pinned in `env`.

Bumping `KOMAC_VERSION` requires bumping `KOMAC_SHA256` in the same edit; the
checksum is asserted in `test/winget-arch-contract.test.js`.

Note that `actions/checkout@v4` and friends are still mutable tags. That is
acceptable while this workflow holds no secret, and matches the rest of the
repository's workflows; it must be resolved to commit SHAs before stage 4 adds a
token.

### Setup, when stage 4 is reached

1. A `rullerzhou-afk/winget-pkgs` fork now exists from the manual repair. Before
   reusing it, decide whether a dedicated low-privilege account should own the
   submission token instead.
2. Create a **classic** PAT for that account with `public_repo` scope and store
   it as the `WINGET_TOKEN` repository secret. Fine-grained tokens do not work
   with komac's fork flow.
3. The former `SpecterShell/Dumplings` tracker was removed in
   [`a21ff13d`](https://github.com/SpecterShell/Dumplings/commit/a21ff13d2243afa0f58e9569a2f69e9903d726e2).
   Reconfirm it has not returned before enabling submission.

### Per-release checks

- Download the `winget-generated-manifest` artifact and confirm it carries
  **four** installer entries — `x64` and `arm64`, each in `user` and `machine`
  scope — with the right filename and `Custom` switch in each.
- Confirm `License` reads `AGPL-3.0-only`, and that `LicenseUrl` and
  `ReleaseNotesUrl` are pinned to the release being submitted. The live v0.14.0
  manifest is corrected; versions v0.6.2 through v0.13.0 still carry the stale
  `MIT` value from before `3b6277ff` relicensed the project on 2026-04-25.
- Until stage 4 is enabled, open a one-version PR in `microsoft/winget-pkgs` from
  the validated artifact, then track validation, merge and the publish-pipeline
  result. A successful prepare run alone does **not** publish the release.
- v0.15.0 is present upstream, but its locale still points `LicenseUrl` and
  `ReleaseNotesUrl` at v0.14.0. Do not copy those stale values into v1.0.0.
- After the catalog refreshes, run an independent Windows `winget install` or
  `winget upgrade` smoke test before documenting the command in the READMEs.
