## v0.12.0

v0.12.0 is a remote-approval and agent-coverage release. It ships Discord Rich
Presence, WSL auto-discovery with one-click pairing, the Feishu remote-approval
channel, Telegram elicitation (AskUserQuestion) support, LAN Approval (beta),
Kimi Code and QoderWork agent support, dedicated roam walk visuals, an
irreversible-action hint on permission bubbles, and a broad set of fixes around
Windows PowerShell window flashes, Antigravity stdin handling, macOS IME
occlusion, and multi-display mini mode.

This release also welcomes **eight first-time contributors**.

### New Features

- **Discord Rich Presence** (#215, #508, #644, #649, #650) - Clawd can mirror your agent status to your Discord profile. Ships with the official "Clawd on Desk" Application ID so it works with zero configuration; a custom App ID remains available as a collapsed advanced option. Thanks to first-time contributor @KaiC5504.
- **WSL auto-discovery and one-click pairing** (#565) - Clawd detects WSL distros, pairs agent hooks into them in one click, and marks sessions with their WSL source so mixed Windows/WSL setups stay legible. Thanks to first-time contributor @V1staz.
- **Feishu remote-approval channel** (#511) - Permission requests can now be approved or denied from Feishu, joining Telegram as a remote-approval channel. Thanks to first-time contributor @yanguibao1997.
- **Telegram elicitation (AskUserQuestion), beta** (#609, #651) - When an agent asks a clarifying question, the Telegram and Feishu channels render the options as an interactive card with quote-safe Other answers, fail-closed auth on both approval and elicitation callbacks, secret redaction on the outgoing question/option text, and localized card text in five languages. Beta: two answer-fidelity edge cases (a long question's display form vs. its answer key, and option labels over 32 characters) are deferred and tracked in #659. Thanks to first-time contributor @JasonZH6600.
- **LAN Approval (beta) and Settings sidebar consolidation** (#645) - Remote Approval settings are consolidated under one sidebar entry with per-channel subtabs, and a LAN-based approval channel ships behind a beta flag.
- **Kimi Code support** (#593) - The new Kimi Code CLI (`~/.kimi-code`) is supported alongside the legacy Kimi CLI, with hook auto-registration on startup (#563).
- **QoderWork IDE agent support** (#598) - QoderWork sessions get state-only tracking (Phase 1), mirroring the existing Qoder integration. Thanks to first-time contributor @xiaoshidefeng, who built the original integration in #510.
- **Context and account usage bars** (#590) - Claude Code 1M-context detection is corrected, and Antigravity gains context and account-usage bars in the HUD/dashboard. Thanks to first-time contributor @Yike-Ye.
- **Irreversible-action hint** (#613, #625) - Permission bubbles show a warning badge when a command looks irreversible, with quote-aware segment splitting, command-position anchoring, capped input scanning, and dark-mode theming. Thanks to returning contributor @chrono-meta.
- **Dedicated roam walk visuals** (#612, #580) - Calico and Cloudling get their own walk animations during free roam, and the crab gets a direction-aware crabwalk with mirroring.

### Bug Fixes And Hardening

- **Windows PowerShell window flash** (#627, #628, #630) - Hook events no longer cold-start a PowerShell window per event: snapshots are cached per session with a sliding TTL, and spawns carry `-WindowStyle Hidden`. Thanks to first-time contributor @Schlaflied for the follow-up hardening.
- **Antigravity stdin reliability** (#568, #582, #585, #638, #641) - Fixed the first-token stall when the hook runner never closes stdin, moved to EOF-driven reads with a 2s safety net, added `sid=default` diagnostics, and stopped the Antigravity wrapper from leaking a UTF-8 BOM into hook stdin on Windows (cp65001).
- **Telegram remote approval hardening** (#600, #611) - Approvals now work with bubbles disabled, summaries fall back sanely, `$`-replacement in card text is fixed, and the approval/Direct Send/settings surfaces are localized. Remote-only "go to terminal" resolves as no-decision instead of hanging the hook. Thanks to @JasonZH6600.
- **macOS IME occlusion** (#626) - Text-input bubbles no longer cover the macOS IME candidate window, and IME editing-state visibility round-trips through one place. Thanks to @Yike-Ye.
- **Mini mode stays on its display** (#547) - Restoring from mini mode keeps the pet on the display it was snapped to instead of jumping to a neighbor. Thanks to first-time contributor @royhuang91.
- **Windows executable icon** (#621) - The packaged exe gets its icon and version info back by removing `signAndEditExecutable: false` from the build config.
- **Qoder Windows hooks** (#597, #615) - Qoder hook commands are written bash-portable so Windows setups where Qoder executes hooks through bash work again.
- **WSL-shared Codex config** (#544, #594) - Codex hook entries write dual command fields so a `CODEX_HOME` shared between Windows and WSL works from both sides.
- **Fullscreen taskbar regression** (#586, #587) - `skipTaskbar` is reasserted after the hit-window focusable flip so the pet does not reappear in the taskbar during fullscreen overlay.
- **Roam size on mixed DPI** (#569, #579) - Walk size is anchored so the pet no longer grows when roaming across displays with different DPI.
- **Permission hotkeys while pet is hidden** (#601, #604) - Allow/Deny global hotkeys stay live for visible bubbles even when the pet window is hidden.
- **Telegram encoding cleanup** (#622) - Stray BOM removed and mojibake arrows restored in Telegram strings from #609.
- **Elicitation agent attribution** (#651) - Elicitation cards attribute the requesting agent correctly, and the CodeBuddy installer gains an ownership test.
- **Remote-approval hardening (pre-release)** - Telegram approval callbacks fail closed when the allowed user is unset (parity with elicitation); agent-controlled text in Feishu cards is stripped of Markdown/structural characters and secrets so it can't forge a status line or inject a mention; elicitation question/option text is secret-redacted before it leaves the desktop; QoderWork writes its Windows hook in the bash-portable form (parity with #615); and a non-string tool-input field can no longer crash the permission bubble.

### Removals

- **Hardware Buddy (Clawstick) integration removed** (#646) - The experimental hardware companion integration is retired. The `hardwareBuddy` prefs key is no longer read; leftover keys in existing prefs files are ignored harmlessly.
- **Telegram migration-card layer retired** (#647) - The dead v0.9.0 migration-card rendering layer is removed; the runtime migration state machine remains.

### Upgrade Notes

- Release metadata is set to `0.12.0` in `package.json` and `package-lock.json`.
- No prefs version migration in this release. New keys (`discordPresence`, `feishuApproval`, `agents.qoderwork`) are backfilled with defaults by the schema normalizer on first launch.
- Discord Rich Presence is opt-in from **Settings -> Discord** and uses the official Application ID by default; no Discord developer setup is needed.
- The Feishu channel currently supports **Feishu (feishu.cn) only**. The SDK domain is hardcoded to Feishu and there is no region/domain setting, so Lark (international) tenants are not supported in this release.
- Remote Approval settings moved: Telegram, Feishu, and LAN Approval now live under the consolidated **Remote Approval** sidebar entry with per-channel subtabs.
- Kimi users: hook registration now targets Kimi Code (`~/.kimi-code`) when present; legacy Kimi CLI installs keep working. Hooks re-sync automatically on startup.
- After updating, launch Clawd once so hook registrations and the Antigravity wrapper refresh on the next startup sync (automatic — it just needs one launch).
- Codex on Windows: the dual `commandWindows` field (#544) is only honored by Codex builds from ~2026-05 onward. Older Codex builds ignore it and would run the POSIX command form on Windows — update Codex if you run it there.

### Contributors

Huge thanks to everyone who shipped code, tests, docs, QA, or release polish for v0.12.0 - and welcome to this release's **eight first-time contributors**:

- **@rullerzhou-afk** (鹿鹿 · creator) - Settings consolidation and LAN Approval beta, Kimi Code and QoderWork enablement, roam walk visuals, Windows PowerShell flash/exe icon/Qoder hook fixes, Antigravity stdin hardening, Telegram encoding cleanup, release work, and follow-up reviews.
- **@KaiC5504** - Discord Rich Presence (#508). *First-time contributor.*
- **@V1staz** - WSL auto-discovery, one-click pairing, and session source badges (#565). *First-time contributor.*
- **@yanguibao1997** - Feishu remote-approval channel (#511). *First-time contributor.*
- **@JasonZH6600** - Telegram elicitation support (#609) and remote-approval hardening (#600). *First-time contributor.*
- **@Yike-Ye** - Context/account usage bars and Claude Code 1M detection (#590), macOS IME occlusion fix (#626). *First-time contributor.*
- **@royhuang91** - Mini-mode display restore fix (#547). *First-time contributor.*
- **@Schlaflied** - PowerShell snapshot-spawn hardening (#628). *First-time contributor.*
- **@xiaoshidefeng** - QoderWork IDE agent integration (#510, landed via #598). *First-time contributor.*
- **@chrono-meta** - Irreversible-action hint on permission bubbles (#613).
- **@YOIMIYA66** - Maintainer reviews and QA.
- **@Bynlk** - Continued core ownership of the Mobile / PWA companion line.

### Known Limitations

- The Feishu channel has not yet had end-to-end real-device validation on a Feishu (feishu.cn) tenant; the flow is implemented against the Feishu domain but unverified on live hardware. Reports welcome.
- QoderWork support is state-only (Phase 1) and has not had a packaged-build smoke test on a machine with QoderWork installed; the integration author will help verify after release.
- LAN Approval is beta: expect rough edges, and treat it as LAN-trusted only.
- WSL pairing currently requires **mirrored** networking (`.wslconfig`: `networkingMode=mirrored`). Under the default NAT mode the Windows-side server (bound to 127.0.0.1) is unreachable from the WSL VM, so paired hooks can't report; the pairing step warns when it detects this.
- Discord Rich Presence real-device validation was done by the contributor; packaged-build regression after release is planned.
- Codex terminal focus is still unavailable because official hooks and JSONL fallback do not carry a usable terminal PID.
- macOS and Linux packaged auto-update remain manual-download only; git checkout users can still update through the git-mode updater.
