# Release Process

Use this flow when preparing a Clawd app release.

## Before Tagging

1. Update `package.json` to the release version.
2. Add `docs/releases/release-vX.Y.Z.md`.
3. Run the local tests that match the change scope. For full release prep, run:

```bash
npm test
node scripts/verify-sidecar-binaries.js prebuild:all
```

4. Run the `Build & Release` workflow manually on `main`.

Manual workflow dispatch builds Windows, macOS, and Linux artifacts, fetches the
pinned `cc-connect-clawd` sidecar release, verifies source-pinned checksums, and
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

### v0.11.0 Draft Smoke Checklist

Use the draft release installer or package artifact, not `npm start`. Windows
required items are the primary publish gate. If macOS or Linux hardware is not
available, record that platform as not real-machine validated in the release
notes.

Before launching:

- Download the draft release asset for the platform being tested.
- Confirm the packaged app shows `0.11.0` metadata.
- Confirm packaged resources include `app.asar.unpacked/hooks`,
  `app.asar.unpacked/agents`, `app.asar.unpacked/extensions`,
  `app.asar.unpacked/themes`, and `sidecars/cc-connect-clawd`.
- Confirm Windows artifacts are architecture-specific x64 / ARM64 installers,
  not a universal NSIS installer.
- For migration smoke, install v0.10.0 first and save a copy of the old
  `clawd-prefs.json` before upgrading.
- For Reasonix smoke, prepare a machine with Reasonix initialized so
  `<Reasonix home>/` exists (`%APPDATA%\reasonix` on Windows,
  `~/.reasonix` on macOS/Linux). A skipped install because Reasonix is missing
  does not validate the packaged hook path.
- For Remote SSH smoke, prepare at least one saved profile that can connect
  through an SSH reverse tunnel.

Required all-platform checks:

- Fresh install, launch, pet appears, no error dialog.
- Upgrade install over v0.10.0, launch, pet appears, no error dialog. This path
  exercises prefs v11 to v12 migration.
- Settings -> About shows `v0.11.0`, sourced from `app.getVersion()`.
- First-run tutorial opens once for a fresh profile; Finish, Skip, and OS close
  each persist `tutorialSeen=true` and do not reopen on restart.
- Upgrade profile with no `tutorialSeen` sees the tutorial once; an already-seen
  profile does not reopen it.
- Existing macOS users keep their previous Dock setting after upgrade; fresh
  macOS installs default to pet + menu-bar accessory with no Dock tile.
- Settings -> General / Agents / Animation & Sound render correctly in all five
  languages, including sidebar SVG icons and the folded Animation Map subtab.
- Settings -> About contributors include the seven v0.11.0 first-time
  contributors: `zhaoxv210`, `serenNan`, `IatomicreactorI`, `quantai1314`,
  `Git-creat7`, `undownding`, and `chrono-meta`.
- Reinstall one existing hook-based agent, such as Codex, and confirm the
  packaged hook script can `require()` its dependencies.
- Run one real Claude Code or Codex session and confirm the pet reacts to state
  changes and still plays completion happy on Stop.
- Trigger a long CJK Claude or Codex completion and confirm the Stop event reaches
  Clawd without a 413 and the happy animation is not dropped.
- Codex official hook health: disable hooks / leave hooks unreviewed, confirm
  Agents badge or startup nudge reports attention, then repair/review and
  confirm it returns healthy.
- Settings -> Agents -> Install Reasonix succeeds on Windows when paths contain
  spaces, and the written command uses the EncodedCommand path when needed.
- Remote SSH profile with connect-on-launch connects after startup; repeat with
  local port 23333 occupied so the server binds a later port and the tunnel still
  targets the real bound port.

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
- Update labels never show a duplicated prefix such as `vv0.11.0`.
- Telegram approval cards show the final outcome for decisions made on Telegram
  and for approvals resolved elsewhere.
- Scan the mobile PWA pairing URL on a phone and confirm session cards appear.
- Regenerate or reset the mobile token and confirm the phone can reconnect with
  the new token.

Windows checks:

- Required: fullscreen/borderless game or video app smoke. The pet should float
  over the fullscreen app when overlay mode is on; clicking or dragging the pet
  must not kick the app out of fullscreen.
- Required: lock/sleep/resume or display wake smoke with low-power idle enabled;
  eye tracking should recover after the renderer reports wake recovery.
- Required: drag a folder onto the pet and confirm a terminal opens in that
  directory.
- Required: right-click New Session starts Claude Code without `0x800700c1`.
- Recommended: focus jump targets the correct terminal.
- Recommended: after restart, the pet restores its saved position and Keep size
  across displays does not grow after DPI/display-scale changes.

macOS checks:

- Required when macOS hardware is available: Ghostty cross-Space focus switches
  to the target Space without yanking the Ghostty window to the current desktop.
- Required when macOS hardware is available: answer a permission with
  Ctrl+Shift+Y or Ctrl+Shift+N and confirm focus is not stolen back to the agent
  terminal.
- Recommended: jumping back to a session restores a minimized terminal window.
- Recommended: dragging a folder onto the pet does not open a terminal and does
  not crash. This is intentionally disabled on macOS.

Linux checks:

- Required when Linux hardware is available: Wayland session launches
  successfully and relaunches under XWayland when available; pet transparency
  and positioning work.
- Recommended for tmux users: focus jumps to the correct tmux pane.

All required Windows items must pass before publishing the draft. Required macOS
and Linux items must pass when those machines are available. If any required
item fails, fix it and create a new draft release; do not publish a known-bad
draft.

## Sidecar Dependency

Clawd release builds do not consume upstream `cc-connect` latest artifacts. They
download the fixed `cc-connect-clawd` fork release pinned by
`scripts/fetch-sidecar-binaries.js`, verify SHA256 values pinned in that script,
and package those binaries into app resources.

When the sidecar needs an upstream update, publish a new fixed sidecar release
from the fork first, then update the Clawd pin and rerun the fetch/verify tests.
