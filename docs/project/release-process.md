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

Manual workflow dispatch builds Windows, macOS, and Linux artifacts, checks
each unpacked resources tree for retired Telegram sidecar binaries/source, and
gates every package on its target-native Koffi payload, a packaged positive-call
smoke, and updater metadata matching both the generated artifacts and the exact
`package.json` release version. It then uploads
the installers plus JSON evidence manifests. It does not publish a GitHub
Release.

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

### v0.15.0 Draft Smoke Checklist

Use the draft release installer or package artifact, not `npm start`. Windows
required items are the primary publish gate. If macOS or Linux hardware is not
available, record that platform as not real-machine validated in the release
notes.

Before launching:

- Download the draft release asset for the platform being tested.
- Confirm the packaged app shows `0.15.0` metadata.
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
  listed artifact filename identify `0.15.0`.
- For migration smoke, install v0.14.0 first and save a copy of the old
  `clawd-prefs.json` before upgrading.
- For Reasonix smoke, prepare a machine with Reasonix initialized so
  `<Reasonix home>/` exists (`%APPDATA%\reasonix` on Windows,
  `~/.reasonix` on macOS/Linux). A skipped install because Reasonix is missing
  does not validate the packaged hook path.
- For Remote SSH smoke, prepare at least one saved profile that can connect
  through an SSH reverse tunnel.

Required all-platform checks:

- Fresh install, launch, pet appears, no error dialog.
- Upgrade install over v0.14.0, launch, pet appears, no error dialog. Existing
  agent installation/enabled flags and user theme/animation choices remain intact.
- Settings -> About shows `v0.15.0`, sourced from `app.getVersion()`.
- First-run tutorial opens once for a fresh profile; Finish, Skip, and OS close
  each persist `tutorialSeen=true` and do not reopen on restart.
- Upgrade profile with no `tutorialSeen` sees the tutorial once; an already-seen
  profile does not reopen it.
- Existing macOS users keep their previous Dock setting after upgrade; fresh
  macOS installs default to pet + menu-bar accessory with no Dock tile.
- Settings -> General / Agents / Animation & Sound render correctly in all supported
  languages, including sidebar SVG icons and the folded Animation Map subtab.
- Settings -> About contributors include the four v0.15.0 first-time
  contributors: `weed33834`, `arismarioneves`, `wang4433`, and
  `shengmai-justin`.
- Reinstall one existing hook-based agent, such as Codex, and confirm the
  packaged hook script can `require()` its dependencies.
- Run one real Claude Code or Codex session and confirm the pet reacts to state
  changes and still plays completion happy on Stop.
- Confirm a completed turn uses the distinct default completion sound rather
  than the ordinary confirmation cue.
- Run one real OpenCode session through a title rename, tool activity, and
  SessionEnd. HUD/Dashboard must show the bounded title, retain causal ordering,
  and remove the session without replaying a stale state after a slow endpoint.
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
- Set `REASONIX_HOME` to an unresolved variable and confirm install/sync fails
  closed without writing `settings.json` into the launch directory.
- Install ZCode and confirm its state-only events reach Clawd without replacing
  ZCode's native permission flow. From an Orca pane, jump back to the session
  and confirm the validated pane key focuses the correct pane locally and over
  managed Remote SSH.
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
- Update labels never show a duplicated prefix such as `vv0.15.0`.
- Telegram approval cards show the final outcome for decisions made on Telegram
  and for approvals resolved elsewhere.
- Scan the mobile PWA pairing URL on a phone and confirm session cards appear.
- Regenerate or reset the mobile token and confirm the phone can reconnect with
  the new token.

Windows checks:

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

As of 2026-08-17, the upstream 0.14.0 manifest has been repaired and published by
[`microsoft/winget-pkgs#416019`](https://github.com/microsoft/winget-pkgs/pull/416019).
It now carries the four expected architecture/scope entries and
`License: AGPL-3.0-only`. The former Dumplings tracker was also removed in
[`SpecterShell/Dumplings#130`](https://github.com/SpecterShell/Dumplings/issues/130),
so it is not currently competing with the maintainer-owned release path. The
workflow stays prepare-only until its **generated output** is validated
automatically; fixing the upstream shape alone is not sufficient reason to expose
a submission token.

The current release gap is **v0.15.0**. Its first prepare run
[`31654717731`](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/31654717731)
ran before the upstream repair and inherited the old two-x64 shape; komac also
emitted `License: AGPL-3.0` with a `HEAD` license URL. Microsoft currently lists
0.14.0 as the newest catalog version. Run prepare once against the corrected
upstream manifest to capture the new raw output, implement the stage 3 gate and
normalization, then re-run v0.15.0 and require the gated workflow to pass before
submitting that version manually while stage 4 remains disabled.

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
3. **Validate komac's output — next.** First run prepare against the corrected
   upstream shape to retain an unmodified sample. Then extend the gate to parse
   the generated YAML and assert the package identifier/version; exact
   `{x64, arm64} x {user, machine}` set; each entry's URL, SHA256 and `Custom`
   switch; `InstallerType: nullsoft`; `UpgradeBehavior: install`; top-level
   `InstallerSwitches.Upgrade: --updated`; and ProductCode
   `3e932233-a8b2-5530-b285-e0ceb08488f2` at both the installer and
   `AppsAndFeaturesEntries` levels. The locale manifest must carry
   `License: AGPL-3.0-only` and a version-pinned `LicenseUrl`. Komac overwrites
   `License` from the repository's current `licenseInfo.spdxId`, which GitHub
   reports as `AGPL-3.0`, not the `AGPL-3.0-only` in `package.json`, so the gate
   must rewrite and then assert these fields rather than accepting the raw output.
   After that change lands, re-run v0.15.0 and require the gated workflow to pass.
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
- Confirm `License` reads `AGPL-3.0-only`. The live v0.14.0 manifest is corrected;
  versions v0.6.2 through v0.13.0 still carry the stale `MIT` value from before
  `3b6277ff` relicensed the project on 2026-04-25.
- Until stage 4 is enabled, open a one-version PR in `microsoft/winget-pkgs` from
  the validated artifact, then track validation, merge and the publish-pipeline
  result. A successful prepare run alone does **not** publish the release.
- v0.15.0 is the immediate outstanding submission; do not wait for the next
  application release to close this gap.
- After the catalog refreshes, run an independent Windows `winget install` or
  `winget upgrade` smoke test before documenting the command in the READMEs.
