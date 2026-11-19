## v1.5.0

Clawd v1.5.0 gives each phone its own pairing, moves Linux `.deb` updates to an
official APT source, and animates the pet while Codex delegated subagents work.
It also tidies the AI Coding Tools and Permissions & approval settings, adds
support for community themes with author credits, shows Codex plan progress, and
keeps Clawd's local server running when its default ports are unavailable.

### Linux updates

- **Official APT source** (#1255, #1288; related #1221) — `.deb` installations
  keep update notifications, but the button now reads "Update with APT" and opens
  the setup guide instead of running a privileged installer, which could fail
  when no desktop authorization window was available. The opt-in source at
  <https://apt.clawdondesk.com/> supports Debian 12/13 and Ubuntu 22.04/24.04 on
  amd64. Its signing key is limited to this source through `Signed-By`, and a pin
  limits the source to Clawd's two packages. A release notification can arrive a
  few minutes before the source has the new version. AppImage keeps its in-app
  updater, including when the folder it unpacks into is reached through a
  symbolic link. Other packaged Linux installs, such as an unpacked directory,
  show "Open Downloads" instead. Thanks to @Kris20030907 for reporting the failed
  update.

> **Linux `.deb` updates now use APT.** Existing users can add the official source once using the [migration guide](https://apt.clawdondesk.com/), even if the old in-app update failed. Quit Clawd before updating, then reopen it. AppImage keeps its in-app updater.

> **Linux `.deb` 改用 APT 更新。** 旧用户可按[迁移指南](https://apt.clawdondesk.com/#chinese)接入一次官方软件源，无需先修好旧版应用内更新。更新前请退出 Clawd，完成后重新打开。AppImage 保留应用内更新。

### Phone pairing

- **One token per phone** (#1279; issues #487, #1281) — each phone now has its
  own token, so locking the phone or restarting Clawd no longer leaves it holding
  a token that was replaced while it was away and forces a new pairing. To pair,
  open the pairing link on the phone and type the 8-character code from
  Settings → Permissions & approval → LAN approval. The code is single-use and
  valid for 10 minutes; "Refresh pairing code" makes a new one. A Safari tab and
  an "Add to Home Screen" app pair separately and count as two devices, up to 20
  including phones that have not connected yet. Not tested on a real iPhone.
  Thanks to @Bynlk, whose real-iPhone testing in #663 showed why the old shared
  token could not be rotated safely.
- **Paired devices list** (#1280) — the same card lists paired phones with their
  last-seen time. "Revoke" removes one phone, and "Revoke old token" cuts off
  every phone still using a link from before the update. "Regenerate Token" is
  now part of "Reset phone access".
- **Safer phone connections** (#1289) — a phone connection that Clawd rejects,
  for example because of a wrong token, could raise an unhandled error in Clawd's
  main process if it sent a malformed or oversized message while closing. Such
  connections are now handled safely, and a message from a phone may be at most
  4,096 bytes (the limit was about 100 MiB). Phone preview is off by default, and
  this needed a misbehaving device on your network.

### Codex

- **Delegated subagents animate the pet** (#1270, #1283, #1284) — while a local
  Codex session has delegated subagents working, the pet shows the subagent
  animation (headphones for one, juggling for two or more in the default theme)
  and the HUD row shows the session as running. If the parent turn ends first, its
  completion cue (sound, taskbar flash, happy animation) is held back and plays
  once, when the last subagent really finishes or the parent exits. It is dropped
  if the parent starts a new turn or is interrupted first, and a subagent that
  stays silent for 20 minutes is released. Clawd also reads recently active
  session logs first, which cut the delay before a subagent shows up from about
  6–10 seconds to 0.09–1.38 seconds in a small macOS measurement. This covers
  local sessions only; WSL and Remote SSH Codex sessions are unchanged. **Known
  difference:** only the pet and the HUD wait for subagents. The Dashboard,
  Telegram and Slack completion messages, phone notifications and Discord
  presence follow the parent session's own state and treat its Stop as done.
  These changes were tested with real Codex sessions on Windows and macOS. Thanks
  to @200780381.
- **Temporary chats** (#1258; related #1254) — confirmed temporary Codex Desktop
  threads no longer try to resume through a link that fails. Clicking one
  activates the already-open Codex app on Windows and macOS; it does not select
  the exact side chat, and Linux is not supported. Two switches in Settings →
  Sessions → Session HUD, both off by default, collapse completed or active
  temporary chats from the HUD; they can also hide ordinary side chats. Completion
  sounds and animations still play, and phone previews are not affected. Thanks to
  @200780381.
- **Plan progress** (#1193; issue #1190) — while Codex has a valid step plan, the
  HUD row shows a thin progress bar (hover for "Plan 3/5 · 60%") and the Dashboard
  shows the same line. Only the step counts are used, never the step text. Thanks
  to @daijx-ai.
- **Untitled Desktop chats** (#1171; related #1103) — untitled Codex Desktop
  chats from the same folder now show `<folder> · <short tag>` so they can be told
  apart; before, they all showed the bare folder name. Thanks to @200780381.

### Claude Code

- **"Handling tools" status** (#1274; related #1018) — while the main local
  Claude Code session is calling a tool, the HUD can show "Handling tools" and the
  phone preview shows the same state; Discord presence counts it as working.
  Themes can give it its own animation (`states.executing`) and otherwise keep
  "working". It is a hint about the tool-call phase, which starts before the
  permission check, so it does not mean a command was approved or is running.
  Remote, WSL, headless, subagent and other agents' sessions are unchanged. Thanks
  to @Swcmb for the request in #1018.

### Settings

- **AI Coding Tools layout** (#1230, #1227) — each card has a status sentence and
  one main control (the master switch, or Install). Expand a card for its
  settings, grouped as Approvals, Alerts, Connection, WSL, Quota and Info, with
  explanations behind an (i) toggle. A "Disconnect …" link at the bottom of a card
  reveals the Uninstall button, and uninstalling now uses Clawd's own confirmation
  dialog. A broken hook states its cause next to a "Fix it" link that opens
  Doctor. Under Discover and add, "Detected locally" offers "Install all" when two
  or more tools are found. No setting or command was removed, but four controls
  were renamed (see Upgrade Notes). Thanks to @YOIMIYA66 for the refinements in
  #1227.
- **Permissions & approval layout** (#1231) — the Telegram, Feishu / Lark and
  Slack cards show a status sentence. Until a channel is set up, only its "Start
  setup" steps are shown; its enable switch and notification options appear once
  it is configured, and the test link appears only when a test can run. The LAN
  approval card follows the same layout. No preference, command or confirmation
  changed.
- **Update diagnostics** (#1227) — when an update fails, the error details now
  include the error code, HTTP status, syscall, host and related fields, and the
  repair advice is labeled "Repair suggestion (for reference only)".
- **Disable hardware acceleration on Windows** (#1211, #1277; issue #1183) — a
  Windows-only switch in Settings → General → Startup & system for machines where
  the pet turns into a black square at a screen edge. It uses a bit more CPU and
  applies after a restart: while the saved setting differs from the running one,
  the row says "Not applied yet. Restart Clawd to switch." and offers a "Restart
  Clawd" button. The reporter confirmed that the switch removes the black square.
  Thanks to @Mouren-Lee for the report and testing.

### Agent integrations

- **ZCode questions** (#1266; issue #1264) — ZCode's `AskUserQuestion` now opens a
  Clawd question bubble, and your answer goes back to ZCode. Questions are never
  answered automatically. Requests Clawd cannot answer, such as ExitPlanMode,
  flash a short notification and stay in ZCode, and approvals ZCode does not send
  to hooks also stay there. Tested with ZCode 3.16.3 on macOS. Thanks to
  @xiaoshidefeng, and to @tianxingjian2406 for the report.
- **OpenCode serve sessions on Windows** (#1194; issue #1134) — the Dashboard adds
  a separate "Open in new terminal" action for local OpenCode v1 `serve` sessions.
  It needs Windows Terminal. Thanks to @hanzhe-one, and to @Hatsunemiku533 for the
  report.
- **Reasonix on Windows** (#1199, #1239; issue #1198) — the state hooks now leave
  more of Reasonix's five-second limit free and start Node directly when the path
  is safe. On the reporter's slow Windows host a hook went from 5.7–6.3 seconds to
  2.6–2.7 seconds. When no safe direct path exists, for example with non-ASCII
  profile paths or volumes without 8.3 short names, the previous launcher is still
  used. State delivery is best effort: if Clawd is too slow to answer, the hook
  gives up rather than delay Reasonix. Thanks to @200780381 for the report and the
  retests, and to @sLingli for the compatibility pointers.
- **DeepSeek Harness** (#1242, #1224) — session rows keep the current title,
  including after Clawd restarts or when the title changed while Clawd was closed.
  On Windows, Clawd no longer holds the desktop app's `app.asar` open, which could
  stop DeepSeek Harness from updating itself. Thanks to @Free-LZJ.
- **WorkBuddy** (#1207; related #634) — hook processes now share a per-session
  process cache, so most tool events no longer trigger a Windows process
  snapshot. Thanks to @eugenewang5425.
- **Installation detection** (#1262) — product files count as evidence that
  ZCode, CodeBuddy or Qoder is installed only when they are the expected file or
  directory type. A directory where a file is expected, or a file where a directory
  is expected, no longer counts. Thanks to @200780381.

### Themes

- **Community themes** (#1236, #1237, #1238) — Settings → Theme can show reviewed
  community themes in their own "Community themes" group, with a "Community"
  badge and a "By" credit with the author's name that stays visible for themes
  installed with this version, even offline. Community themes are added to the
  catalog separately from app releases, so none may be listed yet. A contribution
  guide and an issue form explain how to submit one. Older Clawd versions show
  community themes as official.

### Platform

- **Local server ports** (#1261; issue #1248) — if none of Clawd's default local
  ports (23333–23337) can be used, because Windows has reserved them or another
  program holds them, Clawd now falls back to a port chosen by the system and
  saves it in `~/.clawd/runtime.json`, where the hooks it installed look for it.
  This applies on every platform. Before, the local server did not start and
  agent state and permission bubbles stopped working. Claude Code and CodeBuddy
  sessions that were already running may need a new session or a hook reload. A
  WSL distribution with its own Linux home cannot discover a port outside
  23333–23337, and Pair says so. See
  [known limitations](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/docs/guides/known-limitations.md).
  Thanks to @dferrandizmont for the report.
- **Curly quotes in Windows paths** (#1289) — PowerShell also reads ‘ ’ ‚ ‛ as
  single quotes, so a folder or install path containing one could end a quoted
  string early. The command Clawd launched then failed to start, and a folder name
  crafted on purpose could add extra commands; this needed you to run from that
  folder yourself. Clawd now quotes these characters correctly in the commands it
  builds: opening a terminal in a folder, starting a Claude Code session, "Open in
  new terminal", and the Codex, Antigravity, Copilot and DeepSeek Harness hook
  launchers.
- **macOS display changes** (#1269; issue #1268) — after connecting a display or
  changing the main display, the click area returns to the pet instead of staying
  somewhere else. The reporter confirmed it on macOS. Thanks to @XYZliang.
- **Eye tracking on Linux X11** (#1205; related #441) — on Xorg, and in the
  XWayland mode Clawd restarts into, the eyes now follow the cursor across the
  whole desktop instead of stopping at the last position near the pet, and moving
  the mouse anywhere now counts as activity for the idle and sleep timers. Over
  native Wayland windows the cursor is still not visible to Clawd. Thanks to
  @Aminorsh, and to @DtDEncryption for asking for full-screen tracking in #441.

### Documentation and maintenance

- **Guides** (#1217, #1255, #1236) — the Chinese setup guide now matches the
  English one, and there are new guides for Linux APT setup and for contributing
  themes, in English and Chinese. Thanks to @tianxingjian2406 for #1217.
- **Contributor credits** (#1263, #1273) — adds newly verified contributors to the
  README and Settings lists.

### Upgrade Notes

- **Linux `.deb`:** follow the migration notice above once. The update button
  opens the guide; it does not install anything itself. A release notification can
  arrive a few minutes before the APT source has the new version.
- **Phones:** an already paired phone migrates when its page reloads; an older
  Home Screen web app may need to be refreshed twice, which was not tested on iOS.
  The old shared link no longer changes and stays valid until you use "Revoke old
  token" or "Reset phone access"; do that if an old phone or browser should no
  longer connect. Enabling permission summaries also authorizes anyone still
  holding the old link.
- **Phone preview ports:** phone preview keeps its own fixed LAN ports
  23334–23338 and does not follow the local server to a fallback port. The two
  Codex temporary-chat switches do not affect it.
- **Windows hardware acceleration:** the switch only applies after restarting
  Clawd.
- **ZCode:** ZCode reads its hook settings only when it starts. After Clawd
  installs or re-registers its ZCode hooks, restart ZCode; until then requests
  quietly stay in ZCode.
- **DeepSeek Harness:** restart DeepSeek Harness (the desktop app, or `dsh web`)
  after updating so it loads the refreshed plugin. Settings → AI Coding Tools
  shows a notice when a restart is needed.
- **Renamed controls:** "Show pop-up bubbles" is now "Permission prompts as Clawd
  bubbles" (AI Coding Tools, Approvals group). "Collect local Claude usage" is now
  "Read local Claude quota and context usage" (AI Coding Tools → Claude Code,
  Quota group). "Pause automation for destructive actions" is now "Ask me before
  auto-allowing destructive commands" (Permissions & approval → On this machine).
  "Codex permission mode" is now "Who handles approvals" (AI Coding Tools →
  Codex).
- **Downgrading:** the prefs schema remains version 21. Saving settings in
  v1.4.0 drops `sessionHudHideCompletedCodexEphemeral`,
  `sessionHudHideActiveCodexEphemeral` and `disableHardwareAcceleration` (the two
  Codex temporary-chat switches and the Windows hardware-acceleration switch), so
  they are off again after you upgrade. v1.4.0 only knows the old shared link:
  phones paired with a code stop working there, and work again in v1.5.0.
  "Reset phone access" in v1.4.0 does not revoke them; revoke them in v1.5.0.
  Back up prefs before downgrading.

### Contributors

Thanks to contributors whose work landed between v1.4.0 and v1.5.0: @200780381,
@Free-LZJ, @hanzhe-one, @eugenewang5425, @tianxingjian2406, @xiaoshidefeng,
@YOIMIYA66, and new contributors @Aminorsh, @daijx-ai, and @XYZliang. Thanks also
to @Kris20030907 (issue #1221), @Mouren-Lee (issue #1183), @Hatsunemiku533 (issue
#1134), @dferrandizmont (issue #1248), @Swcmb (issue #1018), @DtDEncryption
(issue #441), @sLingli (compatibility pointers in #1198), and @Bynlk (iPhone
testing in #663) for reports and testing.

### Validation Status

Checked with the v1.5.0 draft assets:

- **Release CI** — the manual Build & Release run on `e752627d` and the tag
  build passed every job: full test suites on Linux, macOS and Windows with no
  failures, native-package audits for all five targets, Koffi packaged smoke,
  updater metadata, and the retired Telegram sidecar assertion. The 13 draft
  assets match the v1.4.0 set, all three `latest*.yml` files point at 1.5.0
  artifacts with matching sizes, and the SHA-512 of the Windows x64 installer
  and the macOS arm64 DMG match them.
- **macOS signing** — both DMGs contain Developer ID signed, notarized apps; on
  the arm64 app, `codesign`, `spctl` (Notarized Developer ID) and
  `stapler validate` passed.
- **Windows x64 (real machine)** — silent upgrade over an installed v1.4.0
  (`/S /allusers --updated`). The installed app reports 1.5.0 and contains one
  `win32_x64` Koffi binary, NOTICE and the bundled theme catalog, with no
  official theme media. Preferences were unchanged at version 21, the Claude,
  Codex and OpenCode configuration was byte-identical after startup, and Codex
  hooks kept firing without a new `/hooks` review. Launched on the desktop, the
  pet, tray and Settings worked. In the packaged app, Settings showed v1.5.0 in
  About, the hardware acceleration switch with its restart note, the two
  temporary-chat switches, and the Permissions & approval subpages.
- **Local server ports (Windows, packaged, isolated profile)** — with all five
  default ports held by another program, the app moved to a system-assigned port
  and published it. A real Claude hook reached it, Claude's permission URL
  followed it, a restart kept it, and releasing the ports returned the app to
  23333.
- **Codex subagents** — on Windows, real `codex exec` runs with two subagents
  against the packaged app. The pet moved to the subagent animations and played
  the happy animation once, both when the parent waited and when it stopped
  first. A subagent appeared 0.14–1.37 seconds after its log was created (four
  samples), even though the logs' modified time stayed frozen on NTFS. On macOS
  the same changes were tested on a source build before merging.
- **macOS arm64 (real machine)** — the draft DMG (hash checked) installed over
  v1.4.0 and launched from `/Applications`; the pet and Settings worked and
  About showed v1.5.0. Preferences were unchanged, Claude hooks moved to the
  installed app, the Codex, OpenCode and WorkBuddy configuration was unchanged,
  and a real Claude Code session reported the "Handling tools" state.
- **APT source** — on 2026-10-31 a 1.3.0 → 1.4.0 upgrade through the source
  passed on Ubuntu 22.04 and 24.04 virtual machines, where the app also started
  and answered afterwards, and in Debian 12 and 13 containers, which did not run
  the app. It passed after the first publication and again after a rehearsed
  second publication with the same packages. The tagged-build gate passed on the
  Ubuntu 26.04 runner image, and a publish request from the tag did not deploy.
  Publishing this release started the publisher by itself, and the source had
  1.5.0 about 75 seconds later, keeping 1.4.0 and 1.3.0 and retiring 1.2.0. The
  previous index stayed available by hash, and a 1.3.0 → 1.5.0 upgrade through the
  source passed on the same four systems.
- **In-app update** — on a real Windows x64 desktop, v1.4.0 found v1.5.0,
  downloaded it and finished through Restart Now. The app reopened as 1.5.0 under
  the same install entry, with the Claude, Codex and OpenCode configuration
  unchanged. On macOS arm64, a copy of v1.4.0 did the same; the updated copy is
  validly signed and its app archive matches the v1.5.0 DMG.

**Not tested**:

- The in-app update for an AppImage, and the Later, quit and reopen path on Windows
  and macOS.
- Any real phone: pairing, migration, revocation and the Home Screen app.
- macOS x64 and Windows ARM64 on real hardware (CI only).
- Linux on real hardware: the "Update with APT" button, AppImage Download and
  Restart Now, and X11 cursor tracking (CI only).
- Ports reserved by Windows itself; only ports held by another program were
  tested on the packaged app.
- Real clicks on a Windows path containing a curly quote; the quoting was checked
  with the Windows PowerShell 5.1 parser.
- Real ZCode on Windows, and real Reasonix, WorkBuddy, OpenCode `serve` and
  DeepSeek Harness hosts on this build. Their PRs record earlier host tests.
- The hardware acceleration fix and the macOS display fix on this build; each
  reporter confirmed them on a test build.
- A community theme from the live catalog, which has none yet.
- The macOS first-launch Gatekeeper prompt for a browser download.
- Other checks in the release smoke checklist that are not listed above.
