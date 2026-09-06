## v0.16.0

v0.16.0 is an agent-integration, remote-notification, accessory-geometry, and
macOS release-hardening update. It adds the first experimental DeepSeek Harness
bridge, manual ZCode permission approval, Slack notifications, Kimi quota
visibility, and a Spanish interface. It also hardens OpenCode/Codex integration,
preference recovery, Windows fullscreen detection, and Developer ID packaging.

### Agent Integrations And Permissions

- **DeepSeek Harness bridge** (#876) — adds a Windows-first experimental,
  plugin-only integration for the `web` profile, with managed immutable
  generations, state events, and manual Allow Once / Deny handling for ordinary
  approval requests. `ask_user_question`, automation, foreign packages, unknown
  mutations, and unsupported DSH versions remain fail-closed. Thanks to
  first-time contributor @RS-Nocsi.
- **Manual ZCode approval** (#880) — adds the blocking `PermissionRequest` hook
  and desktop Allow/Deny bubble while deliberately keeping ZCode outside global
  and per-session permission automation. Foreign hooks remain the sole owner,
  and no-decision paths fall back to ZCode's native UI. Thanks to @liugou27.
- **OpenCode JSONC and Desktop bridge support** (#899, #900) — writes the plugin
  into the effective JSON/JSONC configuration and supports OpenCode Desktop's
  Node utility-process bridge. Permission forwarding now requires the live,
  owner-only Clawd runtime identity instead of sending reverse-bridge credentials
  to scanned ports, while preserving no-decision fallback to the native
  permission flow when Clawd is unavailable or intentionally silent.
- **Codex and Gemini detection fixes** (#897) — installation discovery now
  distinguishes real CLI evidence from directories created by other products or
  by Clawd itself.
- **Codex hook review stability and Claude hook repair** (#870, #873) — keeps
  official-hook trust stable across builds and safely handles environment-based
  worktree hook paths.

### Remote Approval, Notifications, And Quota

- **Slack notification-only channel** (#836, recovered and hardened in #909) —
  sends bounded, ordered completion/error and permission-request announcements
  by Incoming Webhook or bot token. Slack never makes approval decisions, link
  unfurling is disabled, secrets remain outside prefs, and outbound summaries
  avoid raw sensitive search content. Thanks to first-time contributors
  @wang4433 and @shengmai-justin.
- **Feishu/Lark approver lookup by email** (#750) — resolves an approver through
  the selected platform and binds the saved identity to that platform and App.
  Thanks to first-time contributor @Cobb04.
- **Safe Feishu/Lark upgrade guidance** — configurations saved before platform
  and approver provenance binding stay fail-closed. A one-time startup notice
  and Doctor warning now explain the required repair instead of letting remote
  approval disappear silently.
- **Kimi subscription quota rings** (#881) — adds bounded local quota refresh and
  shared Dashboard/Orbit presentation for Kimi Code CLI.
- **Safer session labels in remote output** (#905, #909) — notifications use the
  snapshot-owned display tag and suppress opaque internal workspace identifiers.

### Desktop Runtime And Reliability

- **Accessory-aware drag hitboxes** (#866) — moving and animated accessories now
  participate in the canonical geometry handshake, including mini mode and
  holiday/accessory changes, so the interactive surface follows what is drawn.
  Thanks to first-time contributor @CheeseAgent.
- **Subagent activity tiers** (#877) — juggling intensity follows live subagent
  lifecycle identities instead of aggregate session count.
- **Windows fullscreen detection** (#889) — distinguishes maximized normal windows
  from fullscreen applications so ordinary maximization no longer triggers the
  fullscreen overlay policy. Thanks to @KaiC5504.
- **Unreadable or damaged preferences are visible and still safe** (#888, #891)
  — Clawd no longer overwrites a prefs file it could not read. If readable
  contents are malformed, it preserves the original as `clawd-prefs.json.bak`
  and repairs the primary file, but agent gates remain closed for that launch.
  If the backup cannot be created, the primary file and Settings writes remain
  locked instead of risking the only copy. Startup and Doctor explain the exact
  recovery path and required restart. Thanks to @chrono-meta.
- **Completion and accessory lifecycle cleanup** — closes stale completion and
  geometry state that could otherwise survive into later activity.

### Packaging, Localization, And Diagnostics

- **Developer ID signing and notarization** (#915) — official macOS tag builds
  require the complete signing secret set, validate PKCS#8 input, lock the
  certificate to the configured Apple Team, assert required entitlements are
  true, notarize, mount both DMGs, and verify the exact bundled apps. A partial
  secret set or ad-hoc tag build fails closed.
- **Five-target native release gate** — manual and tag release workflows now
  require target-native packaged Koffi calls on Windows x64/ARM64, macOS
  Intel/Apple Silicon, and Linux x64 before a draft can be created.
- **No eager macOS Keychain access** (#914) — Remote SSH identity remains lazy so
  ordinary startup does not request Keychain access.
- **Spanish UI and README** (#890) — adds complete `es` locale coverage. Thanks
  to first-time contributor @Zamaniego.
- **Theme validator exit semantics** (#892, #903) — distinguishes invalid themes
  from a validator that could not run. Thanks to @chrono-meta.
- **WinGet release-process clarification** (#896) — keeps submission
  prepare-only and records the architecture-validation boundary.
- **Release diagnostics repaired** — DSH ownership now compares canonical paths,
  including symlinked homes and managed roots, and Windows-only filesystem tests
  no longer create impossible Windows paths on POSIX runners.

### Contributors

Six first-time contributors landed changes in this release:

- @CheeseAgent — accessory-aware hitboxes and geometry validation (#866)
- @RS-Nocsi — DeepSeek Harness integration (#876)
- @Cobb04 — Feishu/Lark approver lookup by email (#750)
- @wang4433 — Slack notification channel (#836, #909)
- @shengmai-justin — Slack transport, reliability, and documentation (#836, #909)
- @Zamaniego — Spanish localization (#890)

Returning contributors include @chrono-meta (#888, #892), @KaiC5504 (#889),
@PeterShanxin (#859), and @liugou27 (#880).

### Upgrade Notes

- Launch Clawd once after upgrading so installed and enabled integrations can
  reconcile their packaged hooks, plugins, and extensions.
- Existing Feishu/Lark users must open **Settings → Remote Approval**, select the
  correct platform, save **App ID / App Secret** again, and then save the
  approver again. Until both bindings are refreshed, the client intentionally
  stays off; the desktop approval bubble remains the local fallback.
- DeepSeek Harness is experimental, disabled by default, and limited to the
  supported `@deepseek-ai/dsh@0.1.0-rc.6` web profile. API-backed session and
  approval smoke is not yet claimed as Windows-verified.
- Slack is notification-only. Answer permission requests in Clawd, Telegram, or
  Feishu/Lark; Slack cannot Allow or Deny.
- Packaged macOS and Linux builds still do not perform in-app updates. Download
  future versions manually from GitHub Releases.

### Validation Status

Local source-tree validation passed on August 23, 2026: `verify:release`,
Electron installation verification, and all 8,621 automated tests completed
with 8,591 passes, zero failures, and 30 platform/dependency skips. The asset
audit reported zero errors and one warning because the 52.40 MiB tracked tree is
above its 50 MiB warning budget.

The final code-bearing candidate at
`119257ebad54dbcd8b24df178397e83341cbcc9e` passed the manual
[Build & Release workflow](https://github.com/rullerzhou-afk/clawd-on-desk/actions/runs/32621621221)
on August 23, 2026. The run completed the release validator, Developer ID
signing and notarization, Windows/macOS/Linux full test and packaging jobs, and
target-native package audits for Windows x64/ARM64, macOS Intel/Apple Silicon,
and Linux x64. This release-note-only follow-up must pass the same workflow on
the final `main` head before the tag is created.

Separate real-device evidence was collected before the final release-note and
Windows DSH canonical-path repairs: required Windows hardware checks passed on a
real x64 machine after upgrading from v0.15.0, and the available macOS hardware
checks passed with the signed pre-final candidate. The recommended Windows
DPI/display-scale change was not run. The final draft assets still require the
downloaded-package smoke checks below before publication.

Any later commit must rerun the exact-tree manual workflow. This candidate is
not publish-ready until a tag creates the draft release, its downloaded assets
pass smoke testing, and the remaining applicable platform/agent evidence in the
release checklist is recorded. Skipped tests and source-only checks are not
substitutes for those gates.
