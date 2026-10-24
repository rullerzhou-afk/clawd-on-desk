# Release Process

Use this flow when preparing a Clawd app release.

## Before Tagging

1. Update `package.json` to the release version.
2. Add `docs/releases/release-vX.Y.Z.md` and a matching `!` allowlist line in
   `.gitignore` (for example `!docs/releases/release-v1.4.0.md`). Without the
   allowlist, `git add` silently skips the note and CI's `validate-release`
   skips all three platform builds.
3. Run the local tests that match the change scope. For full release prep, run:

```bash
npm run verify:release
npm test
npm run audit:assets
```

Official downloadable themes (for example Hash Sage and Whale-chan) ship as versioned GitHub
Release assets in the separate `rullerzhou-afk/clawd-themes` repository, never
inside Clawd. Before tagging, refresh the bundled catalog snapshot with
`npm run update:official-theme-snapshot` and commit the diff if the snapshot
changed. Confirm the packaged resources still contain no
`themes/hash-sage/**` or `themes/whale-chan/**` payload and that `npm run audit:assets` reports the
tracked-tree budget within policy. On a pull request, the
`audit:pr-history-assets` gate additionally proves no large official-theme
media entered the PR's reachable history.

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

### v1.4.0 Draft Smoke Checklist

Use the draft release installer or package artifact, not `npm start`, and record
platform, architecture, host version, and result for each selected check.
Windows applicable required items are the primary publish gate; unavailable
macOS/Linux hardware must be recorded as **Not tested** in the release notes.

#### 本版必测（Required for this release）

The following release gates and v1.4.0 behavior checks are required for this
draft. A source run, unit test, or a previous release's evidence does not
replace a packaged-app or real-host check.

**Recurring release gates**

- **All targets:** packaged app shows `1.4.0` metadata, and About shows `v1.4.0` from `app.getVersion()`.
- **All targets:** packaged resources contain the expected hooks, agents, extensions, themes, NOTICE, and official catalog snapshot, with no retired Telegram sidecar or unshipped official-theme payload.
- **All targets:** native-package/Koffi manifests show exactly one matching native addon, the packaged positive-call smoke passes, and no foreign native payload is present.
- **All targets:** updater metadata versions and artifact names match `1.4.0` and the generated assets.
- **Windows x64/arm64:** validate separate architecture-specific NSIS installers and the intended user/machine installation paths.
- **macOS x64/arm64:** validate signing, quarantine, `codesign`, `spctl`, and notarization/stapler evidence when the signed assets are available; otherwise record **Not tested**.
- **Windows/macOS/Linux:** fresh-install and launch the packaged app with a visible pet and no error dialog.
- **Windows/macOS/Linux:** upgrade a real v1.3.0 installation to v1.4.0 and confirm the app launches and preserves the documented v1.3.0 settings; the prefs schema remains version 21, so this release performs no prefs migration.
- **Windows; macOS on available architectures:** exercise a real v1.3.0 → v1.4.0 updater pair, including Restart Now and Later/quit/reopen, and record versions and asset hashes.
- **All supported permission hosts:** verify manual native Allow/Deny fallback after Clawd DND, disabled bubbles, disconnect, shutdown, or no-decision paths; no timeout or remote failure may invent a decision.

**v1.4.0 new behavior matrix — 21 required items**

1. **External review:** on three supported platforms, exercise Qwen, Copilot, Hermes, and OpenCode where their real permission paths are available; cover a slow review, a gate-mode change, and no-decision fallback without turning a review failure into Allow/Deny.
2. **External-review command contract:** cover exit 0/1/2, another exit code, missing/non-executable command, timeout, concurrency, oversized payload, broken output/disconnect, and Clawd quit cleanup.
3. **Codex Auto on Windows WSL/Remote:** combine WSL and Remote SSH requests with Auto, the external review, session overrides, DND, and no-decision; verify that Clawd only overrides Codex's automatic reviewer for the documented global Bash/apply_patch auto-allow exception.
4. **OpenCode/MiMo v1 permission race:** while external review is pending, answer Allow/Reject in the native permission UI and confirm review completion creates no stale Clawd approval bubble and submits no second decision; cover no-decision fallback.
5. **v1 question boundaries:** cover single and multi-question/multi-select prompts, DND, closed/disconnected Clawd, and quit; native UI must retain unanswered questions and ordered `string[][]` answers.
6. **Phone preview:** cover pairing, retained pairing, reset, default-off, revoke, native read-only behavior, DND, and hidden/closed Clawd; record that the historical #893 real-phone checklist was not rerun.
7. **KiroCrew gateway:** with the gateway stopped, install/uninstall and restart; cover the mutation lock, foreign config, and two main agents plus a child gateway session; assert that a child agent has no working-session row and startup sync does not reopen a hook the user disabled in KiroCrew.
8. **Qoder CN:** on Windows, cover Qoder CN and international Qoder coexistence, Doctor, real events, and uninstall without creating a missing home; record macOS/Linux CN as **Not tested** if not run.
9. **OpenCode v1/v2:** cover upgrade, repeated no-op sync, v1 cleanup, v2-only `plugins` registration, removal of Clawd-owned old `plugin` entries, preservation of foreign tuple/options, and `opencode service restart`.
10. **Windows Codex Desktop:** cover five SessionStart causes, the short-lived wrapper, the shared app-server, and conservative focus boundaries, including the first ordinary message that may lack process metadata.
11. **Codex lifecycle:** on all three platforms, cover late SessionStart, progress, Stop, Interrupt, compaction, and title changes for real local sessions.
12. **Terminal focus:** on macOS/Linux, cover herdr and Ghostty focus plus the documented degradation; include the herdr server/version boundary.
13. **Settings behavior:** cover all five tabs, old Telegram migration, all three Permissions & approval subpages, the quota deep link, and the seven-language mobile consent dialog.
14. **Settings geometry:** on macOS and Windows, cover 1366×768 and 125%/high-DPI layouts, tab focus, deep links, and overflow.
15. **Built-in and user themes:** cover Clawd, Calico, and a user/external theme through deep sleep and wake; verify the documented static/continuing sleep differences, mini mode, and hitboxes in the packaged Electron renderer.
16. **Random animation pools:** on macOS and Windows, confirm tier/state-scoped `files` pools stay stable within a state and reroll only at the documented boundaries.
17. **External theme safety:** load an external theme containing an XML declaration and other processing instructions; confirm sanitizer/cache handling preserves the XML declaration, removes other processing instructions such as `<?xml-stylesheet?>`, and re-cleans cached SVGs after upgrade without affecting approved assets.
18. **Linux workspaces:** cover sticky/all-workspaces placement, focus, and keyboard behavior on the supported X11/XWayland paths.
19. **Linux packaged Electron:** launch the packaged X11 path and confirm the allocator does not crash; record AppImage/deb coverage separately.
20. **Windows packaging:** cover x64/arm64 packages, WinGet preparation, and a real v1.3.0 → v1.4.0 upgrade; record architecture-specific gaps.
21. **Clean checkout/docs:** in a clean checkout, run the contributor generator, verify all six READMEs, SVGs, navigation, the Chinese permission anchor, and the release-doc version contract.

#1223 is folded into the external-review, Codex Auto, and OpenCode/KiroCrew
checks above; it has no separate real-host smoke item. Do not claim the
historical phone checklist (#893) was rerun unless new evidence exists.

#### 老功能抽测（Regression sampling）

Sample a few historical items on each release; record every item not run on the
release page as **Not tested** rather than carrying forward an earlier pass.
The former v1.3.0 required matrix is retained below as regression evidence, not
as an automatic v1.4.0 gate. Keep the recurring release gates above required.

##### v1.3.0 historical required matrix

These are the required checks from the v1.3.0 release for changes from
v1.2.0 → v1.3.0. They remain here as regression sampling, not as fixed v1.4.0
gates; CI artifact evidence can satisfy static functional checks, while GUI and
host checks need the actual packaged app.

- **Windows/macOS/Linux:** upgrade a v20 profile to prefs v21 with Codex Intercept/Native migrated to Auto once, then re-select Intercept and restart to confirm that new choice persists (#1156, #1167).
- **Codex supported platforms:** compare human-reviewed local shell/file requests with automatic reviewers, MCP/app, unknown evidence, and remote/WSL requests, confirming only proved local human requests enter Clawd's bubble/IM approval entry or mirrored approvals in Auto (#1156); the v1.4.0 remote exception is covered by new-behavior item 3.
- **Windows/macOS + local Codex:** run a real long Ask me turn whose turn_context is more than 1 MiB behind the request, compact and continue with unchanged approval settings, and confirm Auto still shows a Clawd bubble within its bounded evidence window (#1169).
- **Codex supported platforms:** sync and review PreCompact, PostCompact, Interrupt, and SessionEnd in `/hooks`, confirm Agents/Doctor recover to healthy after review, and before review confirm compaction has only its JSONL completion cue while an already-trusted PermissionRequest still works (#1129, #1158, #1160).
- **Windows + Codex:** leave only the four new state hooks unreviewed and confirm the tray notice says approvals still work and directs the user to `/hooks`, while Doctor reports pending review instead of blaming connectivity (#1169).
- **Codex supported platforms:** exercise manual/automatic compaction start, success, interruption, and fast completion alongside busy and completing peer sessions, confirming holds release and sweeping yields without losing peers' completion cues (#1110, #1129, #1160).
- **Codex Desktop on supported platforms:** confirm recognized ambient-suggestion threads stay hidden, ordinary side chats remain visible, and SessionEnd retires rows without stale lifecycle replay except those retained for a replyable completion mapping (#1158).
- **Windows/macOS/Linux + local Codex:** rename or generate a native title without rollout growth and confirm HUD/Dashboard refresh through the normal approximately 1.5-second poll without changing activity or completion (#1111).
- **Windows/macOS/Linux:** keep genuine current-turn Codex model/tool progress running through a long wait, then stop it, confirming the card does not expire early and all agents' busy sessions block roaming until work ends (#1162).
- **Windows/macOS/Linux + Claude:** verify PostToolBatch is written only at ≥2.1.280 and UserPromptExpansion only at ≥2.1.265, older hosts can still read settings, foreign hook entries remain intact, and owned env hooks migrate only when a usable local Node is found (#1070, #1084, #1123).
- **Windows/macOS/Linux + Claude ≥2.1.280:** run serial/parallel tools, queued prompts, results before starts, subagents, failures, Stop, pending approvals, and DND, confirming accepted batches return to thinking without reviving completed work and comparing Footprints tool counts with real calls (#1123, #1150, #1153, #1154).
- **Windows/macOS + Claude ≥2.1.265:** use `/design` in Clawd with a saved head accessory, confirm painting and completion heart eyes preserve supported accessories, and check Calico/Cloudling fallback (#1084).
- **Windows/macOS/Linux + Claude CLI/VS Code:** confirm manual titles outrank AI titles and prompt-first-line fallback, including resume and a Clawd restart (#1127).
- **Windows + Claude:** leave a live interactive session idle for more than ten minutes, resume work and restart Clawd, confirming one canonical recovered row and no reuse of another process's identity (#1108).
- **macOS/Windows + DSH:** upgrade the v1.3.0 web/desktop bridge once across the verified 0.1/0.2 families, restart hosts, and confirm another Clawd restart does not replace healthy generations again (#1128, #1130, #1131).
- **macOS/Windows + DSH:** open a desktop-only installation once to initialize its profile, then exercise Install/Repair/Uninstall with both carriers and confirm one Doctor row, per-profile notices, and preservation of the other profile when one side fails or is removed (#1131).
- **macOS/Windows + DSH:** run real desktop state and Allow/Deny requests, restart after a generation update, and test `dsh://open` from foreground, minimized, and closed windows plus the unique-install launch fallback without promising a conversation-specific jump (#1131, #1132).
- **Linux + DSH web:** confirm web Install, Doctor, approvals, and upgrade remain usable without a desktop carrier (#1130, #1131).
- **macOS/Windows + DSH:** change the host from the 0.1 to 0.2 family while Clawd stays on the same version and confirm the localized Settings notice directs Uninstall then Install using the visible button names (#1169).
- **macOS/Windows + DSH/Kimi desktop and supported CLI/web platforms:** confirm SessionStart-only conversations remain in Dashboard and out of HUD until real activity, with metadata unable to reveal them early (#1133, #1159).
- **macOS/Windows + WorkBuddy:** install against the current or compatible legacy home and confirm completed cards survive per-turn host exit, late SessionStart, auth_success, and idle_prompt until the configured idle timeout or app exit, with native approval untouched (#1136, #1138).
- **macOS/Windows + WorkBuddy:** compare native titles, idle renames, empty-title context, model/window changes, and post-compaction usage with HUD/Dashboard, confirming unreadable databases preserve the previous gauge and another home's same ID does not own lifecycle (#1135, #1168).
- **macOS/Windows + WorkBuddy:** archive/delete a conversation and confirm retirement within one approximately two-second poll when readable, then unarchive and send a new message to restore it without late archived events recreating the row (#1140).
- **Windows + WorkBuddy/CodeBuddy:** exercise slow process snapshots and confirm immediate legal stdout followed by completed state delivery, including WorkBuddy main-process identity when resolution succeeds and cleanup after app exit (#1104, #1146).
- **CodeBuddy supported platforms:** confirm command hooks return `{}` without a tool decision and an independent real HTTP PermissionRequest still round-trips through manual approval (#1115).
- **macOS/Windows + Qoder/QoderWork:** confirm native session titles still display after the shared incremental-reader refactor (#1135).
- **Windows/macOS/Linux:** set a session to Ask every time under global unattended, then use a request with failed identity verification and confirm the stricter session policy prevents automatic approval (#1114).
- **Windows/macOS/Linux, including multiple displays or high DPI:** confirm a permission bubble's first visible frame is already positioned and transient geometry failure keeps it pending without flashing at the provisional origin (#1161).
- **OpenCode v1/v2 and MiMo supported platforms:** close an unanswered bubble window and confirm the host's native prompt remains available without a tool denial (#1121).
- **Windows/macOS/Linux:** enable the destructive-operation reminder and compare recognized git/gh `$(cat <<'EOF' …)` message arguments with a plain/unrecognized heredoc and a destructive trailing command, confirming only message text avoids the false hold (#1096).
- **Windows/macOS/Linux:** inspect Dashboard history grouping, fallback first-prompt titles, short IDs, worktree transcripts, visible-row scope, and automation-unavailable explanations with picker focus preserved (#1085, #1086, #1116, #971).
- **Windows/macOS/Linux:** open Themes offline with no cache, confirm bundled catalog cards, banner and Retry, restore connectivity, and download a theme while preserving hover/scroll/focus and correct completion after tab change or Settings reload (#1124, #1088, #1098).
- **Windows/macOS/Linux:** move the pet across displays and use the size slider during roaming, confirming actual-size readout including `100%+`, no roaming overwrite, and nearest-tick/max-clamped size when Keep size across displays is disabled (#1091, #1092, #1093).
- **Windows/macOS/Linux:** compare Cloudling normal/mini visuals and slider limits after upgrade, recording the approximately 29% normal-size reduction and unchanged saved selection (#1094).
- **Windows/macOS/Linux:** verify quota reminders default off, then exercise four timing presets, threshold/window labels, confirmed recovery, failed-send backoff, OS silence/DND, Test, and click-to-Settings with platform notification permission recorded (#1126, #1151, #1152).
- **Windows/macOS/Linux:** restart with a large retained Footprints journal and activity arriving during reconciliation, toggle/clear recording, and confirm counts do not return after clearing, unsupported metrics remain a dash, and Sessions started is absent (#1143, #1144).
- **Windows/macOS + Remote SSH:** re-Deploy/Repair a v1.3.0 target with the new Codex hooks and shared helper closure, review its hooks, and confirm remote Codex monitoring and Claude batch delivery still work (#1110, #1123, #1158, #1160).
- **Linux X11/Wayland/XWayland + FUSE AppImage:** terminate only test-owned wrappers before Electron, verify `/state` still responds, then use SIGTERM or desktop shutdown and confirm independent temporary copies survive until process-group exit and are cleaned afterward (#1058).
- **Linux + AppImage:** exercise tmpfs, a non-executable or undersized TMPDIR, a valid executable non-FUSE TMPDIR, a manually extracted AppDir, and the Homebrew cask path, recording startup I/O, single/relaunch peak space, forced-supervisor residuals, and Bazzite reporter confirmation (#1058).
- **Linux + deb:** install, launch, and uninstall the package and inspect `dpkg -c` for AppRun/supervisor packaging without assuming the FUSE AppImage path runs in deb (#1058).
- **Feishu/Lark supported platforms:** use the existing network configuration for a real SDK REST/WebSocket/card-callback round trip and disconnect fallback after the axios update (#1102).
- **Windows:** cold-start twice at the saved upgrade position, exercise fullscreen overlay clicks/drag, and lock/sleep/wake with low-power mode, confirming position, focus, eye tracking, and size remain stable through the size-runtime changes (#1091).
- **Release CI, all targets:** run the manual Build & Release and Wayland smoke workflows, require relevant Test jobs to pass, and compare the bundled official catalog snapshot with the published catalog before tagging (#1058, #1099, #1124).

##### 其他历史与平台抽测

Sample a few items on each release; record every item not run on the release
page as **Not tested** rather than carrying forward an earlier pass.
These retain older behavior checks and historical migrations; their former
Required/Recommended labels do not make the entire matrix a v1.4.0 gate.
Historical migration fixtures below are separate from the required v1.3.0
upgrade path.

**Historical migration and fixture preparation**

- For migration smoke, install v0.16.0 first and save a copy of the old
  `clawd-prefs.json` before upgrading.
- For legacy Feishu/Lark migration smoke, enable remote approval in v0.15.0 with saved
  App credentials and an approver before upgrading. Keep the old
  `feishu-approval.env` alongside the prefs copy.
- For Reasonix smoke, prepare a machine with Reasonix initialized so
  `<Reasonix home>/` exists (`%APPDATA%\reasonix` on Windows,
  `~/.reasonix` on macOS/Linux). A skipped install because Reasonix is missing
  does not validate the packaged hook path.

**All-platform behavior**

- Move the system timezone west after recording, then inspect Today/Week.
  Recorded activity and coverage at the frozen local hour remain visible.
- With enough permission requests to overflow a small display, exercise queue
  loading/ACK failure and native window clamping. Allow/Deny shortcuts must not
  decide a partly clipped or hidden target; normal safe cards remain usable.
- End Codex turn A, then let its delayed question/output reach the JSONL monitor.
  It must not revive A or extend turn B. Real current-turn questions still keep
  an active task alive. Upgrade a profile with a long generic working timeout
  and no Codex-specific value: preserve its previous effective Codex duration.
- First-run tutorial opens once for a fresh profile; Finish, Skip, and OS close
  each persist `tutorialSeen=true` and do not reopen on restart.
- Upgrade profile with no `tutorialSeen` sees the tutorial once; an already-seen
  profile does not reopen it.
- Existing macOS users keep their previous Dock setting after upgrade; fresh
  macOS installs default to pet + menu-bar accessory with no Dock tile.
- Settings -> General / Agents / Animation & Sound render correctly in all supported
  languages, including sidebar SVG icons and the folded Animation Map subtab.
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
- Confirm a completed turn uses the distinct default completion sound rather
  than the ordinary confirmation cue.
- Run one real OpenCode session through a title rename, tool activity, and
  SessionEnd. HUD/Dashboard must show the bounded title, retain causal ordering,
  and remove the session without replaying a stale state after a slow endpoint.
- Stop Clawd while OpenCode is running, trigger a permission request, and confirm
  the plugin leaves the decision in OpenCode's native UI without POSTing its
  reverse-bridge credentials to another listener in the Clawd port range.
- Exercise manual accessories on normal, interrupt, sleep, idle, reaction, and
  mini animations. Animation Map overrides must keep the wardrobe available;
  a frame without safe geometry hides only that frame's accessory. Toggle the
  holiday option and confirm it temporarily overrides, then restores, the
  saved manual accessory.
- Feed Claude and Codex quota data from local plus Remote SSH sources. Confirm
  per-source values appear in Dashboard and the configurable pet Orbit ring,
  merge-across-machines can be turned both on and off, and an occupied third-party
  Claude statusline is preserved unless explicit chaining is enabled.
- Trigger a long CJK Claude or Codex completion and confirm the Stop event reaches
  Clawd without a 413 and the happy animation is not dropped.
- Claude hook health: delete one managed hook script and atomically replace
  `settings.json`; confirm the watcher/periodic audit repairs supported damage,
  while a still-missing declared core event is never reported as a successful Fix.
- Register two custom HTTP agents and send the same raw `session_id` from both;
  confirm Dashboard keeps separate sessions, then disable/delete one and confirm
  the other remains intact. Forged/stale `custom-` ids must be rejected.
- Install MiMo Code into a commented/trailing-comma JSONC config, exercise
  Allow/Always/Deny and DND fallback, then uninstall and confirm user config is preserved.
- Install, enable inside MiniMax (`mcode plugin enable clawd-state@local` or the
  plugin panel), and uninstall MiniMax Code. Confirm state events arrive, no
  Clawd permission bubble appears, and unrelated plugins remain intact.
- OpenCode 2.x packaged acceptance: verify v2 `plugins` registration and cleanup of Clawd-owned old `plugin` entries, live state
  flow idle→thinking→working→attention, and a blocking bubble round-trip for
  Allow, Deny, same-session Always, and auto-tools. Interrupt a session with a
  pending approval: its bubble must withdraw. Exercise a compound shell command
  such as `a && b` and confirm destructive-operation reminders and warning
  badges inspect each command. Check the `opencode web` / `serve --hostname
  0.0.0.0` reply path reaches the host through loopback. A missing Clawd
  endpoint must leave the decision in OpenCode's native UI. This extends the
  macOS source/real-machine v2.0.15 checks from 2026-09-24; the packaged asset
  still needs its own spot check.
- Host version controls OpenCode registration: confirmed v2 writes `plugins`,
  confirmed v1 removes only Clawd-owned v2 entries, and unknown leaves
  `plugins` untouched. Verify `CLAWD_OPENCODE_HOST` recovers from failed host
  detection, then remove the override. For OpenCode 2.x, run
  `opencode service restart` after updating the plugin; a new session alone
  may retain the old shared service. For OpenCode 1.x, restart opencode.
- Windows packaged opencode acceptance (#1026, requires a real opencode 1.18.31):
  install the Program Files Clawd package, confirm the opencode config points at
  `%USERPROFILE%\.clawd\integrations\...\generations\<hash>\opencode-plugin` (never
  `app.asar.unpacked`), and that the managed five-file generation bytes/hash match the
  packaged source with no deny-write ACL. Start a real opencode session and confirm
  exactly one Clawd state stream and one permission request per interaction (no double
  load from a duplicate entry). Restart Clawd twice and confirm startup sync is
  idempotent. Repair a single legacy/missing legacy entry and confirm in-place
  migration with the source untouched; arrange a modified Clawd-like copy and confirm
  Install/Repair fail closed with Doctor needs-review and no Fix. Uninstall and confirm
  proven-owned entries are gone, Settings shows uninstalled/disabled, third-party
  plugin/tuple/options are unchanged, and residual generation files (if any) no longer
  emit events after Clawd is removed. Source-level tests do not satisfy this item.
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
  startup reminder points to Settings -> Permissions & approval -> IM channels, saved token/recipient
  values remain, and approval plus completion notifications stay disabled until
  a real native verification callback succeeds. Failure/timeout must not restart
  the retired sidecar.
- Upgrade the prepared legacy v0.15.0 Feishu/Lark profile. Confirm the legacy setup
  remains fail-closed, a one-time startup warning points to Permissions & approval -> IM channels,
  and Doctor reports the binding problem. Re-save the selected platform and
  App ID/App Secret, then re-save the approver; restart and confirm the client
  becomes ready without another warning.
- Queue Slack notifications while its sender is busy; confirm none are lost
  and a permission alert can use its separate lane.
- End a Claude turn and deliver a trailing `SubagentStop`; completion animation
  and notification must remain. Restart Clawd with an idle Claude session and
  reboot after a normally ended turn, including one with background work;
  neither may return as working or interrupted.
- Run a Codex memory consolidation and confirm no `memories` worker card appears
  in HUD or Dashboard.
- On an existing imported Codex Pet, upgrade from v1.1.0 and confirm its
  juggling pose refreshes once without losing the imported theme.
- Enable Discord Rich Presence without animation mirroring, then opt into the
  animation mirror. Confirm coarse status text remains stable, supported Clawd
  animations use the repository-hosted GIFs, and disabling the option returns
  to state-based presence.

**Other desktop and notification sampling**

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
- Download, install, select, and uninstall Whale-chan from Settings -> Theme;
  confirm the theme is absent from packaged resources and its license/credit
  remains available from the separately downloaded theme package.
- Opt into mini peek hold and sleep peek and confirm each appears at the
  intended state boundary. Check selectable-only idle visuals appear only
  after selection. On the built-in Clawd theme, play its idle bubble on both
  halves of the screen and confirm it mirrors on the right; repeat with an
  opted-in custom idle animation.
- Right-click Hide pet / Show pet still works; while hidden, a newly arriving
  permission request still shows a bubble, by design.
- Settings -> About -> Check for updates completes without an error.
- Update labels never show a duplicated prefix such as `vv1.4.0`.
- Telegram approval cards show the final outcome for decisions made on Telegram
  and for approvals resolved elsewhere.
- Scan the mobile PWA pairing URL on a phone and confirm session cards appear.
- Regenerate or reset the mobile token and confirm the phone can reconnect with
  the new token.

**Windows sampling**

- run real packaged OpenCode 1.18.31 and 2.x sessions. Verify v1
  `plugin` and v2 `plugins` registration, one state stream and one permission
  request per interaction, Allow/Deny/Always decisions, interruption cleanup,
  compound-command warnings, and uninstall preservation. Include a host path
  with non-ASCII characters under code page 936 and confirm detection; for 2.x,
  also run `opencode service restart`. Record the exact 2.x version and any
  packaging differences from the macOS v2.0.15 source check.
- displace Claude's managed hooks as CC Switch can, then observe the
  Agents attention badge and reason for paused repair, repeated repair failure,
  or a missing script. Confirm the one-time tray notice on repair pause and a
  healthy badge after a verified repair.
- run a WSL agent session and confirm its PID is not probed on the
  Windows host or aliased to an unrelated local process.
- enable fullscreen auto-hide, enter a fullscreen application, and
  send a new permission request. Local surfaces stay hidden; leaving fullscreen
  restores only requests still pending. Manual Hide pet keeps its separate
  behavior for new requests; remote approval and configured auto-close still work.
- drag a folder onto the pet and confirm a terminal opens in that
  directory.
- right-click New Session starts Claude Code without `0x800700c1`.
- prompt submission under Windows Terminal produces no visible
  PowerShell flash; cloak/sleep/display-wake recovery restores the pet and tray
  icon without a transient size jump.
- focus jump targets the correct terminal.
- after restart, the pet restores its saved position and Keep size
  across displays does not grow after DPI/display-scale changes.

**macOS sampling**

- toggle menu-bar and Dock visibility,
  restart, and confirm both preferences persist and Settings can still regain focus.
- test Dock left/right/bottom plus
  auto-hide and confirm physical-edge pinning stays on-screen across displays.
- Ghostty cross-Space focus switches
  to the target Space without yanking the Ghostty window to the current desktop.
- answer a permission with
  Ctrl+Shift+Y or Ctrl+Shift+N and confirm focus is not stolen back to the agent
  terminal.
- while editing text in a permission
  or elicitation bubble, the pet drops behind the input surface and the IME
  candidate window remains visible; ending edit restores stationary behavior.
- put Clawd in the background, then
  click Settings and Dashboard once each. The first click must reach the page.
- restart Remote SSH monitoring
  during a Codex Desktop thread and replay real turn-split rollouts. Confirm
  one card per thread, no invented idle row, and no finished turn revived as
  working. Record whether the full SSH deploy/tunnel/approval path was tested.
- jumping back to a session restores a minimized terminal window.
- dragging a folder onto the pet does not open a terminal and does
  not crash. This is intentionally disabled on macOS.

**Linux sampling**

- MiMo JSONC install/uninstall keeps
  executable modes and comment-preserving writes correct on a POSIX filesystem.
- focus jumps to the correct tmux pane.

Applicable required gates and new behavior items must pass before publishing;
fix a failed gate and create a new draft, and report unavailable hardware and
deferred historical samples accurately in the release note.

## Retired Telegram Sidecar Guard

The legacy Telegram sidecar was removed in v0.14.0. Release builds must run
`scripts/assert-no-retired-telegram-sidecar.js` against every unpacked target:
Windows x64/arm64, macOS x64/arm64, and Linux x64. The assertion scans both the
outer resources tree and the real `app.asar`; a retired executable or runtime
module is a hard failure.

## WinGet Publishing

Publishing the draft release fires `.github/workflows/winget.yml`. The `prepare`
job generates a manifest with Komac, normalizes the locale metadata, validates
the complete generated tree, and uploads the exact files that may be submitted.
It receives only the ambient read-only `GITHUB_TOKEN`.

An optional `submit` job can then open a one-version PR in
`microsoft/winget-pkgs`. It is disabled unless the repository variable
`WINGET_AUTO_SUBMIT` compares equal to `true` (GitHub expression comparisons are
case-insensitive). Only the final step receives the classic PAT stored as the
`winget-submit` environment secret `WINGET_TOKEN`. The workflow's ambient
`GITHUB_TOKEN` remains read-only; the PAT separately carries every permission of
its owner, so a dedicated account is the minimum-blast-radius configuration.
The job re-downloads and revalidates the artifact, checks that the version is not
already in the catalog or an open PR, and submits the four verified files without
asking Komac to regenerate them. This opens the PR only: Microsoft validation,
moderator approval, merge, catalog publication, and native Windows acceptance
remain external gates.

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
generated-output validator exists because a correct upstream installer matrix
alone is not sufficient reason to expose a submission token.

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

1. **Prepare-only plumbing — complete.** Hosted
   run
   [`31549249655`](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/31549249655)
   successfully exercised the workflow, token, installer downloads and artifact
   paths. Against the then-broken upstream manifest it reproduced komac's bad
   two-x64 output, confirming why automatic submission had to remain disabled.
2. **Repair upstream — complete.** `microsoft/winget-pkgs#416019` fixed v0.14.0
   to the four entries above, changed the license to `AGPL-3.0-only`, passed the
   full validation pipeline and was published on 2026-08-17. The competing
   Dumplings tracker has also been removed.
3. **Validate Komac's output — complete.** The generated-output gate parses the
   YAML and asserts the package identifier/version; exact
   `{x64, arm64} x {user, machine}` set; each entry's URL, SHA256 and `Custom`
   switch; `InstallerType: nullsoft`; `UpgradeBehavior: install`; top-level
   `InstallerSwitches.Upgrade: --updated`; and ProductCode
   `3e932233-a8b2-5530-b285-e0ceb08488f2` at both the installer and
   `AppsAndFeaturesEntries` levels. The locale manifest must carry
   `License: AGPL-3.0-only` plus version-pinned `LicenseUrl` and `ReleaseNotesUrl`.
   Komac overwrites `License` from the repository's current `licenseInfo.spdxId`,
   which GitHub reports as `AGPL-3.0`, not the `AGPL-3.0-only` in `package.json`,
   so the gate rewrites and then asserts these fields rather than accepting the
   raw output. The gate also restores missing `InstallerSwitches.Upgrade` to
   `--updated`; all other inconsistencies still fail closed.
   It writes normalization only after the complete tree passes, emits
   a SHA256 evidence report, rejects unsupported root/nested keys, and is
   byte-for-byte idempotent. The submission process recalculates all four hashes
   against that report immediately before copying the files.
4. **Enable submission — implemented, disabled pending configuration.** The
   workflow is split into `prepare` and `submit`, every third-party `uses:` is
   pinned to a commit SHA, and the PAT exists only in the final submission step.
   Set up the account, secret and opt-in variable below as a separate repository
   configuration change. Prefer a dedicated account for the token: `public_repo`
   grants write access to every public repository its owner can write to, this
   one included.

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

This first gate checks Komac's input, not its output. The separate
`verify:winget-manifest` gate validates and normalizes the generated YAML before
the artifact is uploaded or the submission job can start.

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

All third-party Actions used by this workflow are pinned to full commit SHAs.
When updating an Action, resolve and review the new tag target and change the SHA
explicitly; do not replace it with a mutable major-version tag.

### Optional automatic-submission setup

1. Choose the account that will submit. A dedicated low-privilege account is
   preferred; a PAT owned by `rullerzhou-afk` can also write to this source
   repository. The chosen account's `winget-pkgs` repository must be a fork of
   `microsoft/winget-pkgs`, and the account must complete Microsoft's CLA when
   prompted.
2. Create the `winget-submit` GitHub environment. Add a required reviewer only
   if opening each PR should require a human gate; keep any deployment-ref rule
   compatible with release tags.
3. Create a **classic** PAT for that account with `public_repo` scope and store
   it as the `WINGET_TOKEN` secret in the `winget-submit` environment, not as a
   repository-wide secret. Fine-grained tokens can write a fork but cannot open
   the required PR against the upstream repository.
4. Set the required repository variable `WINGET_FORK_OWNER` to the submitting
   account's login. The workflow deliberately has no owner fallback.
5. The former `SpecterShell/Dumplings` tracker was removed in
   [`a21ff13d`](https://github.com/SpecterShell/Dumplings/commit/a21ff13d2243afa0f58e9569a2f69e9903d726e2).
   Reconfirm it has not returned before enabling submission.
6. Set the repository variable `WINGET_AUTO_SUBMIT` to `true` (comparison is
   case-insensitive). Removing it or changing it to another value returns the
   workflow to prepare-and-upload mode without deleting the secret.

### Per-release checks

- Confirm `prepare` passed both `verify:winget-arch` and
  `verify:winget-manifest`. The uploaded `winget-generated-manifest` artifact is
  the normalized, validated four-file tree plus its evidence report.
- Before either manual or automatic submission, synchronize the submitting
  `winget-pkgs` fork with upstream `master` (for example,
  `gh api -X POST repos/<fork>/merge-upstream -f branch=master`). A shallow
  checkout of a stale fork cannot push the submission branch when upstream has
  moved ahead.
- If automatic submission is disabled, open a one-version PR from that exact
  artifact. If it is enabled, confirm the `submit` job reports either the new PR
  URL or an intentional `already-published` / `open-pull-request` skip.
- Track Microsoft's validation, moderator review, merge, and catalog-publish
  result. A successful Clawd workflow or an opened PR alone does **not** publish
  the release.
- Historical v0.15.0 locale links pointed at v0.14.0. The output gate rewrites
  both links to the current release tag; never copy metadata from a prior
  version by hand.
- After the catalog refreshes, run an independent Windows `winget install` or
  `winget upgrade` smoke test before documenting the command in the READMEs.

## APT source and Linux migration

The official APT channel is prepared by `apt-release-dispatch.yml` → main's `publish-apt.yml`. Follow [APT maintenance](../guides/apt-maintenance.md) for the reviewed key ceremony, main-only environment protection, prepare-only run, first deployment of existing releases, and recovery. The source is not considered active until its activation record contains a production fingerprint and successful HTTPS/APT evidence.

Before releasing the app's APT button, deploy and verify the source and bilingual guide using existing stable assets. Tagged builds require `repository.py verify-live` to authenticate the live source and reach the guide; manual validation builds do not require production activation. Add the provided migration notice to that first release's notes; do not modify old published release notes. Preserve both AppImage and `.deb` entries in `latest-linux.yml`, and verify their final archive markers with `scripts/apt/verify-package-formats.py`. A source-publication failure does not remove the last successful site; notifications can precede publication and must not imply the package is already available through APT.
