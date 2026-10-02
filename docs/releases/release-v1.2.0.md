## v1.2.0

Clawd v1.2.0 adds experimental MiniMax Code support, OpenCode 2.x permissions,
DeepSeek Harness session details, safer optional approval automation, and new
theme behavior. Idle bubbles in the built-in Clawd theme now mirror on the right
half of the screen, where the pet appears by default. This release also improves
session recovery, hook health, notifications, and remote Codex monitoring.

### Agents And Sessions

- **MiniMax Code** (#1038, #1049) — adds an experimental, state-only integration
  through Clawd's managed local plugin at `~/.minimax/plugins/clawd-state`.
  MiniMax's hook timeout does not support blocking approvals, so Clawd does not
  show permission bubbles for it. Enable the plugin in MiniMax with
  `mcode plugin enable clawd-state@local` or its plugin panel. Thanks to
  @xiaoshidefeng.
- **OpenCode 2.x** (#1045, #1053, #1067, #1079) — detects a v1, v2, or unknown
  host before changing its `plugin` and `plugins` registrations. The v2 plugin
  uses the new event API and a blocking permission hook. If host detection
  fails, `CLAWD_OPENCODE_HOST` can pin the host version. Windows detection now
  handles installation paths with non-ASCII characters. Thanks to
  @xiaoshidefeng and @gzx19990101.
- **OpenCode approvals** (#1075, #1079; issue #1065) — reaches wildcard-bound
  `opencode web` and `serve --hostname 0.0.0.0` over loopback, withdraws pending
  bubbles when a session is interrupted, and scans compound shell commands such
  as `a && b` for destructive-operation reminders and warning badges.
- **DeepSeek Harness** (#1046) — supports 0.1.5-rc.1 and rc.3 and forwards
  session titles and context usage. Thanks to @ypjn.
- **Claude recovery and completion** (#1061, #1063; issue #1060) — idle sessions
  no longer resume as working after a Clawd restart. Normally ended sessions,
  including turns that ended while background work continued, stay ended after
  a reboot. A trailing `SubagentStop` no longer cancels completion animation
  or notification. Thanks to @KaiC5504.
- **Codex session cards** (#1032, #1074, #1079; issue #1073) — groups remote
  Desktop rollouts by thread, omits the `memories` consolidation worker, and
  prevents remote monitor restarts from inventing idle sessions or reviving
  finished turns.
- **Session identity and process fixes** (#1031, #1051, #1052, #1055, #1056;
  issue #908) — probes Claude transcripts by raw session ID, preserves Cursor
  delivery time through slow metadata lookup, recognizes Linux Node processes
  named `MainThread` and retitled Kimi Code processes, and avoids probing WSL
  session PIDs on the Windows host. Thanks to @hanzhe-one.

### Dashboard, Themes, And Desktop

- **Claude hook health** (#1059, #1064; issue #898) — the Agents card reflects
  hooks displaced by tools such as CC Switch, paused automatic repair, repeated
  repair failures, and missing scripts, with an explanation when attention is
  needed. Windows shows one tray notice when automatic repair pauses. Thanks
  to @hanzhe-one.
- **Desktop and Settings fixes** (#724, #1071) — the first click reaches
  Settings or Dashboard when Clawd is in the macOS background. Custom app
  launchability uses one rule, and saving a permission URL waits for sync to
  finish. Thanks to @200780381 and @52mzd.
- **Theme animations** (#1050, #1076) — opted-in idle animations mirror on the
  right half of the screen; the built-in Clawd idle bubble opts in. Mini mode
  gains selectable peek hold and sleep peek visuals, plus idle visuals that
  appear only when selected. Thanks to @KaiC5504.
- **Whale-chan** (#1077) — adds an optional official theme downloadable from
  Settings; its media is not in the installer. Rights in the original character
  design, setting and upstream materials remain with their creators; the theme
  credits ZipZipPipe and 上善无形 as named by
  [Neko3000/deepseek-whalechan](https://github.com/Neko3000/deepseek-whalechan).
  New animation and effects by 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk))
  are licensed under CC BY-NC-SA 4.0; see the theme package for full terms. It
  is an unofficial, non-commercial fan work, not affiliated with or endorsed by
  DeepSeek, and it is not covered by this project's AGPL-3.0 source license.
- **Codex Pet poses** (#1022, #1079) — juggling gets its own pose, and already
  imported pets are regenerated once after upgrade. Thanks to @chrono-meta.

### Remote Workflows And Reliability

- **Optional destructive-operation reminder** (#1021) — disabled by default.
  When enabled, recognized destructive commands pause auto-tools or unattended
  approval for a person to review; the feature only makes automation more
  conservative. A heredoc body containing an odd number of quotes or `(#N)`
  can be treated as unanalyzable and held for review. Thanks to @chrono-meta.
- **Notifications** (#1066) — queued Slack notifications are retained, while
  permission alerts use a separate lane.
- **WinGet release tooling** (#1034) — validates the generated manifests before
  submission; automatic submission remains disabled by default.
- **Documentation** (#1054, #1079) — synchronizes multilingual READMEs and
  guides, including the Korean README update. Thanks to @jin-codes.

### Upgrade Notes

- Launch Clawd once after upgrading so installed and enabled integrations can
  reconcile their packaged hooks, plugins, and extensions (#1038, #1045).
- Enable the MiniMax plugin inside MiniMax after installing its integration;
  the integration reports state only (#1038).
- For OpenCode 2.x, run `opencode service restart` after installing or updating
  its plugin; opening a new session alone does not guarantee a shared-service
  reload. For OpenCode 1.x, restart opencode to load the updated plugin
  (#1045, #1079).
- The built-in Clawd idle bubble now mirrors on the right half of the screen,
  which affects the default bottom-right pet position. Imported Codex Pets
  refresh once to pick up the new juggling pose (#1050, #1079).
- Whale-chan downloads on demand from the separate official theme repository;
  it is not bundled with Clawd (#1077).

### Contributors

Thanks to contributors whose work landed between v1.1.0 and v1.2.0:
@chrono-meta, @hanzhe-one, @200780381, @xiaoshidefeng, @KaiC5504,
@jin-codes, @gzx19990101, @ypjn, and @52mzd. Existing contributor credit and
original authorship remain in Settings About and every README variant.

### Validation Status

Before tagging, two independent full-release reviews of `v1.1.0..main`
reported no P0/P1 issues; their fixes landed in #1079. The release commit
passed the full test suite on macOS (11,523 tests, 0 failures), CI on Windows,
macOS and Linux, and the packaged-artifact audits for all five targets.

Checked on real hardware with the v1.2.0 draft assets:

- **Windows 11 x64** (Chinese locale, code page 936): the draft installer
  silently upgraded an existing per-machine v1.1.0 install. `clawd-prefs.json`
  was unchanged (266 keys), and the app launched with the pet visible and no
  error dialog. Checked by hand: Settings About shows v1.2.0 with the new
  contributors; fullscreen auto-hide and the fullscreen overlay; the saved
  position across two cold starts; eye tracking after lock, sleep and resume;
  dragging a folder onto the pet opens a terminal; right-click New Session;
  and a real agent session with its completion animation and no PowerShell
  flash. Real OpenCode 1.18.31 sessions reached Clawd with their state events
  and a permission bubble, including one started from a Chinese-named
  directory.
- **macOS arm64** (the draft DMG, installed to Applications): the bundled app
  passed `codesign --verify --deep --strict`, `spctl` (accepted, Notarized
  Developer ID) and `stapler validate`; its payload holds one darwin-arm64
  Koffi addon, no retired Telegram sidecar and no official-theme media.
  Settings About shows v1.2.0 with every contributor; the first click reaches
  Settings and Dashboard while Clawd is in the background; menu-bar and Dock
  visibility persist across a restart; approving with the permission shortcut
  does not return focus to the terminal; and a real Claude Code session drives
  the pet through to the completion animation. Dock pinning kept the pet on
  screen with the Dock on the left or right, with and without auto-hide, and
  at the bottom without auto-hide.
- **In-app update, macOS arm64** (after publication): the signed v1.1.0
  build updated itself to v1.2.0 both with Restart Now and with Later
  followed by quit and reopen. The updated app passed `codesign` and
  Gatekeeper (Notarized Developer ID), and its code signature matches the
  v1.2.0 DMG build.
- **Earlier real-machine checks for #1079**: OpenCode host detection under a
  Chinese Windows path, OpenCode v2.0.18 bubble withdrawal after an
  interruption, a Codex Pet upgrade from v1.1.0, and remote monitor replay
  using real Codex Desktop rollouts.

**Not tested**:
- On the packaged Windows build: OpenCode 2.x; manual Allow, Deny and Always
  decisions in OpenCode bubbles; the Claude hook-health badge and tray notice
  after hooks are displaced; and WSL session PID handling.
- On the packaged macOS build: the IME candidate window in bubbles, Ghostty
  cross-Space focus, and Dock pinning at the bottom with auto-hide. The code
  behind these did not change in this release.
- The macOS x64 build on real hardware; it was verified by CI only.
- The in-app update on Windows and on macOS x64.
- Linux packages on real Linux hardware.
- The complete Remote SSH path.
- Other long-standing checklist items not listed above were not re-run for
  this release.
