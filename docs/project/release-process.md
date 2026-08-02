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
uploads build artifacts. It does not publish a GitHub Release.

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

### v0.14.0 Draft Smoke Checklist

Use the draft release installer or package artifact, not `npm start`. Windows
required items are the primary publish gate. If macOS or Linux hardware is not
available, record that platform as not real-machine validated in the release
notes.

Before launching:

- Download the draft release asset for the platform being tested.
- Confirm the packaged app shows `0.14.0` metadata.
- Confirm packaged resources include `app.asar.unpacked/hooks`,
  `app.asar.unpacked/agents`, `app.asar.unpacked/extensions`,
  and `app.asar.unpacked/themes`.
- Confirm the retirement assertion passes and neither
  `sidecars/cc-connect-clawd` nor any `cc-connect-clawd(.exe)` exists.
- Confirm Windows artifacts are architecture-specific x64 / ARM64 installers,
  not a universal NSIS installer.
- For migration smoke, install v0.13.0 first and save a copy of the old
  `clawd-prefs.json` before upgrading.
- For Reasonix smoke, prepare a machine with Reasonix initialized so
  `<Reasonix home>/` exists (`%APPDATA%\reasonix` on Windows,
  `~/.reasonix` on macOS/Linux). A skipped install because Reasonix is missing
  does not validate the packaged hook path.
- For Remote SSH smoke, prepare at least one saved profile that can connect
  through an SSH reverse tunnel.

Required all-platform checks:

- Fresh install, launch, pet appears, no error dialog.
- Upgrade install over v0.13.0, launch, pet appears, no error dialog. Existing
  agent installation/enabled flags and user theme/animation choices remain intact.
- Settings -> About shows `v0.14.0`, sourced from `app.getVersion()`.
- First-run tutorial opens once for a fresh profile; Finish, Skip, and OS close
  each persist `tutorialSeen=true` and do not reopen on restart.
- Upgrade profile with no `tutorialSeen` sees the tutorial once; an already-seen
  profile does not reopen it.
- Existing macOS users keep their previous Dock setting after upgrade; fresh
  macOS installs default to pet + menu-bar accessory with no Dock tile.
- Settings -> General / Agents / Animation & Sound render correctly in all five
  languages, including sidebar SVG icons and the folded Animation Map subtab.
- Settings -> About contributors include the six v0.14.0 first-time
  contributors: `LinYsssss`, `He-wei-gui`, `liugou27`, `YOOGOMJA`,
  `anupamme`, and `anthonyonazure`.
- Reinstall one existing hook-based agent, such as Codex, and confirm the
  packaged hook script can `require()` its dependencies.
- Run one real Claude Code or Codex session and confirm the pet reacts to state
  changes and still plays completion happy on Stop.
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
- Dizzy spin: on the Clawd theme, circle the cursor rapidly and confirm dizzy
  triggers; repeat on Calico/Cloudling and confirm no unsupported-state glitch.
- Low-power idle mode: verify sleeping/Cloudling static sleep behavior and that
  the HUD can be reclaimed/reopened without a blank surface.
- Right-click Hide pet / Show pet still works; while hidden, a newly arriving
  permission request still shows a bubble, by design.
- Settings -> About -> Check for updates completes without an error.
- Update labels never show a duplicated prefix such as `vv0.14.0`.
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
