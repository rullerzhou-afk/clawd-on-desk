## v1.0.0

Clawd v1.0.0 adds local activity Footprints, expandable permission cards and an
overflow queue, signed macOS in-app updates, and Windows fullscreen auto-hide.
It also improves Codex session recovery, Claude background completion, agent
installation detection, and Settings navigation.

### Local Activity Footprints

- **Private activity history** (#963) — Settings → Footprints shows Today,
  This week, This month, and This year. It counts accepted agent signals and
  distinguishes recorded quiet periods from periods Clawd could not observe.
  Unsupported metrics remain a dash, never an invented zero.
- **Local storage only** — recording is on by default, with 14 local days of
  minimized event tickets and 400 local days of daily totals and coverage.
  Footprints does not store prompts, responses, commands, paths, project names,
  or raw session/turn/tool identifiers, and adds no network, export, or sharing.
- **Recording controls** — turn off Record footprints to pause, or Clear
  footprint data to remove the managed history. Delayed completion counts cannot
  cross a clear or off/on boundary. Normal completion feedback still works.
  When preference recovery pauses recording, the page explains that state.
- **Clock changes** — historical local hours stay visible after timezone changes,
  including coverage without activity; daylight-saving gaps and folds retain
  their distinct meaning.

### Permission Cards And Desktop

- **Expandable details and overflow queue** (#937, #944, #949, #950, #953) —
  inspect longer requests, plans, and questions while preserving input drafts.
  Answerable questions open in detail when space allows. The queue navigates
  requests without making decisions. Global Allow/Deny shortcuts refuse an
  overflow target that is clipped or obscured by the session HUD, including
  queue loading and failure fallback.
- **Independent bubble placement** (#918, #934) — permission and update bubbles
  can follow Clawd automatically or on a preferred side, or stay at one of four
  primary-display corners, while avoiding other floating surfaces.
- **Windows fullscreen auto-hide** (#973) — optionally hides Clawd and floating
  surfaces during fullscreen use, including newly arriving local permission
  cards. Leaving fullscreen restores only requests still pending. Remote
  approval and configured auto-close keep their existing behavior.
- **Desktop reliability** (#928, #955, #957) — improves permission cleanup,
  macOS theme-specific Dock/menu-bar icons, and animation/geometry settlement.
- **Settings polish** (#923, #925, #926, #929, #930, #931, #932) — improves
  language picking, collapsible sections, focus rings, idle visual selection,
  and permission automation controls.

### Agents And Sessions

- **TraeCode / Trae CN** (#886) — experimental state-only hooks, including
  Windows Sandbox command handling. Enable hooks in Trae CN's own Settings;
  approvals remain in Trae. Migration preserves unrelated nested hook entries.
- **DeepSeek Harness** (#938, #962) — supports exact rc.2 and rc.6 version
  contracts, safer lifecycle cleanup, and POSIX GUI-launch discovery. Real
  API-backed session approval was verified with rc.6 source runs on macOS and
  Windows x64; rc.2 Windows packaged evidence covers install/web boot and direct
  bridge-client round trips. These are separate validation levels. See the
  [DSH guide](../guides/dsh-setup.md) for the experimental scope.
- **Codex** (#954, #959, #960) — restores scoped-session focus, adds an opt-in
  cold-start switch, and separates active-turn timeout from idle cleanup.
  Upgrades retain a longer effective legacy timeout when the Codex-specific
  preference is absent. Delayed question/output records cannot revive a closed
  turn or extend another turn's lifetime.
- **Claude completion and installation detection** (#958, #961) — improves
  background subagent completion and avoids mistaking leftover directories for
  installed agents.

### Upgrade Notes

- **macOS: install v1.0.0 manually once.** v0.16.0 and older packaged apps
  cannot install this update themselves. Download the signed DMG, quit Clawd,
  and replace the application while keeping its data. Starting with this bridge
  version, later signed releases can use in-app download and Restart Now, or
  Later followed by quit/reopen (#922). Linux packages still update manually.
- Footprints starts recording by default after upgrade. Use Settings → Footprints
  to turn it off or clear its history. See the [Footprints guide](../guides/recap.md)
  for retention, metric coverage, and recovery behavior.
- If bubble following was previously disabled, fixed placement now uses the
  selected corner of the primary display rather than the display containing Clawd.
- Launch once after upgrading so installed and enabled integrations reconcile
  their packaged hooks/plugins. Disabled integrations are not reinstalled.

### Contributors

Thanks to first-time contributors @eugenewang5425 (DeepSeek Harness rc.2, #938),
@draintovmasyan783-creator (Codex scoped focus, #954), and @Yueh-H (macOS Control
modifier, #946), and returning contributors @KaiC5504, @YOIMIYA66, and
@xiaoshidefeng. Existing contributor credit and original authorship are retained.

### Validation Status

Local source validation on September 3, 2026 completed with **9,295 passed,
0 failed, and 42 skipped** tests. The release contract and asset audit passed;
the existing tracked-tree size warning remains. An isolated macOS Electron
check confirmed that clipped permission buttons cannot be decided by hotkey.

This remains a preparation candidate. Final-head multi-platform builds,
signed package checks, downloaded-asset smoke, Windows/WSL/Linux device checks,
and a real signed macOS A→B update are separate gates still to complete before
publication. Local source tests do not stand in for them. Follow the
[release checklist](../project/release-process.md).
