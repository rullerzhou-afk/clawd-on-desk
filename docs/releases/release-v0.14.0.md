## v0.14.0

v0.14.0 is a personalization, permission-automation, and remote-runtime
reliability release. It adds theme-aware pet colors and accessories, optional
holiday and test-result reactions, per-session permission automation, live pet
animation mirroring in Discord Rich Presence, ZCode support, account-wide
Claude/Codex subscription quota surfaces, and stronger terminal-focus and
startup recovery across supported agents.

This release also retires the legacy Telegram Go sidecar in favor of the native
transport and welcomes **six first-time contributors**.

### Pet Personalization And Presence

- **Theme-aware colors and accessory wardrobe** (#529, #728, #730) — customize
  supported pets with saved color tints and seven pixel-art accessories. The
  accessory layer follows the pet across animations, respects direction and
  theme capabilities, and degrades safely when a theme does not support a
  customization. The original wardrobe, tint, seasonal, and test-reaction work
  came from first-time contributor @anthonyonazure in #529 and was carried
  forward with co-author credit through the hardened successor changes.
- **Optional holiday accessories** (#791) — a separate opt-in can temporarily
  select the Halloween, Christmas, or New Year accessory and then restore the
  user's saved manual choice. The runtime override is never persisted as a
  pseudo-accessory value.
- **Optional test-result reactions** (#792) — recognized successful and failed
  test-run summaries can trigger a short celebration or failure reaction. The
  hook path is payload-bounded, accepts only explicit runner summaries, and is
  disabled by default.
- **Live Discord animation mirror** (#738) — Discord Rich Presence can mirror
  Clawd's current on-screen animation through repository-hosted GIFs. The
  animation mirror is a separate off-by-default option and keeps public status
  text coarse. Thanks to returning contributor @KaiC5504.
- **Codex Pet V2 import** (#786) — current Codex Pet V2 atlases can be imported
  without regressing existing theme behavior.

### Permission Automation And Agent Runtime

- **Safer permission automation** (#740, #748, #749) — replace the old global
  all-or-nothing switch with explicit Ask every time, Question prompts only,
  and Auto-approve modes. Automation can be scoped per live session, dangerous
  modes require clear confirmation, and the most permissive mode is reduced
  after restart instead of becoming a permanent unattended default.
- **Reliable multi-question remote replies** (#623) — indexed Telegram and
  Feishu/Lark answers now preserve the question-to-answer mapping instead of
  applying an ambiguous response to the wrong prompt.
- **Codex subagent approval routing** (#790) — interactive approval requests
  from Codex subagents are attributed and intercepted without confusing them
  with the parent session.
- **ZCode integration** (#677) — ZCode gains state-only hooks, additive config
  registration, Claude-import cleanup, lifecycle/process detection, and Windows
  process-cache support. Clawd observes state but leaves permission decisions to
  ZCode. Thanks to first-time contributor @liugou27.
- **Shared stable PID cache** (#634, #729) — twelve remaining hook adapters now
  share the stable process-tree cache while preserving agent-specific session
  boundaries and SessionEnd cleanup. Thanks to first-time contributor
  @LinYsssss.
- **Startup recovery** (#653, #769) — active Claude sessions can be restored
  after Clawd restarts, and Codex SessionStart can safely cold-launch the
  packaged app without bypassing the agent gate. Thanks to returning
  contributor @200780381 and first-time contributor @He-wei-gui.
- **Reasonix lifecycle and Windows delivery** (#733, #745) — encoded hook
  detection, config fallback, renamed desktop/CLI processes, cold starts,
  deadlines, and post-idle delivery are hardened. Thanks to returning
  contributor @sLingli.
- **Agent attribution and terminal focus** (#759, #764, #776) — Cursor
  compatibility hooks retain their real origin, Orca focus uses verified pane
  identity and refuses ambiguous targets, and cmux uses the real `workspaceId`
  schema. Thanks to @KaiC5504 and first-time contributor @YOOGOMJA.

### Subscription Quota And Context Usage

- **Account-wide Claude and Codex quota** (#660) — subscription limits are
  stored independently of session lifetime and shown in the Dashboard and a
  configurable pet-attached Orbit ring. Local and Remote SSH sources remain
  distinguishable, with an opt-in merged view for users who intentionally
  share one account. Remote Claude statusline chaining never silently replaces
  an occupied third-party statusline. Thanks to returning contributor
  @Tonic-Jin.
- **Codex provider routing** (#782) — Codex Spark and other reported quota
  windows remain separated by source instead of being merged into the wrong
  subscription bucket.
- **Claude Opus 5 context size** (#783) — current Opus 5 model identifiers are
  recognized as one-million-token context models where applicable.

### Remote, Desktop, And Settings Reliability

- **Remote SSH isolation hardening** (#736) — profiles use dedicated local
  ingress, pinned routing identity, layout-scoped leases, fencing checks, and
  owner-verified cleanup so sessions and mutations cannot silently cross
  profiles. Experimental same-account profile isolation remains release-gated
  and is not presented as full HOME or same-UID security isolation.
- **Native Telegram migration** (#775) — the legacy Go sidecar is no longer
  shipped, started, or accepted as fallback. Existing legacy users retain their
  saved Telegram settings but must complete one real nonce verification callback
  before native remote approval becomes active.
- **Display-edge and mini-mode convergence** (#690, #747, #751) — render and hit
  windows now share logical/physical edge mapping, topology reconciliation, and
  guarded mini transitions across mixed display layouts. Free roam no longer
  starts while the pet is being dragged (#716, #780).
- **Settings and updater polish** (#731, #737, #739, #741, #746, #785, #787,
  #793) — window titles and language controls are localized, tutorial and agent
  icons are consistent, settings interactions survive resizing and bounds
  persistence, destructive cleanup uses an in-app confirmation, and update
  failures expose structured, copyable diagnostics.
- **Asset and package integrity** (#760, #761, #762, #771, #774, #781) — agent
  and tray icons use canonical sources, redundant packaged assets are removed,
  every packaged architecture asserts that the retired Telegram sidecar is
  absent, and the repository audit rejects missing provenance, unsafe
  duplicates, malformed binaries, and retired sidecar content. macOS signed
  payloads and Linux artifacts receive platform-appropriate structural checks.
- **Dependency security** (#725) — the affected SDK dependency chain is updated
  for the reported Axios security issue. Thanks to first-time contributor
  @anupamme.

### Contributors

Welcome to first-time contributors **@LinYsssss**, **@He-wei-gui**,
**@liugou27**, **@YOOGOMJA**, **@anupamme**, and **@anthonyonazure**.

Thanks also to returning contributors **@KaiC5504**, **@sLingli**,
**@Tonic-Jin**, and **@200780381**, to maintainers **@rullerzhou-afk** and
**@YOIMIYA66**, and to everyone who reviewed or tested real agent, terminal,
remote, and platform behavior.

### Upgrade Notes

- Existing preferences, installed/enabled agent flags, themes, manual pet
  colors, and manual accessories are preserved when upgrading from v0.13.0.
- Users still configured for the legacy Telegram sidecar enter a blocking
  migration-required state and receive a one-time startup reminder. Their token,
  allowed user, and target chat remain saved. Open **Settings → Remote
  Approval** and complete the real native verification callback; Telegram
  approval and completion notifications remain disabled until that succeeds.
  A failed check never revives the retired sidecar.
- The most permissive unattended automation mode is not a permanent restart
  default. Review the selected permission automation mode after upgrading and
  keep Ask every time when automatic decisions are not intended.
- ZCode is state-only. Its native permission flow remains authoritative, and an
  explicitly disabled ZCode hook configuration is preserved rather than
  overwritten.
- Local Claude quota collection is opt-in because it installs Clawd's visible
  statusline. An existing third-party statusline is preserved; Remote SSH
  chaining is a separate per-profile opt-in.
- Launch Clawd once after upgrading so installed and enabled integrations can
  reconcile their managed hooks/plugins against the packaged v0.14.0 files.

### Validation Status

Release validation is complete. Whole-version multi-agent review, independent
Claude cross-review, post-fix regression review, the full automated test suite,
the repository asset audit, and the final multi-platform package build all
passed on main commit `1d87aa12086c4952aed70642e3133abc6016be71`.

The packaged v0.14.0 x64 installer was installed and smoke-tested on Windows 11
x64. The final checks covered upgrade preference and position preservation,
five-language Settings and contributor credits, packaged Codex hooks and a real
Codex lifecycle, saved-position cold starts, fullscreen click/drag behavior,
folder drag-and-drop, New Session, Windows Terminal prompt submission without a
visible PowerShell flash, lock/sleep/resume recovery, and sleep accessory
tracking. No release-blocking failure remained after the repair candidate was
installed. The ARM64 Windows installer was checked for identity, architecture,
contents, and retirement-manifest integrity but was not installed on x64
hardware.

The final macOS and Linux packages were built and structurally validated in CI;
this release candidate was not rerun on dedicated macOS or Linux hardware.
Feature-specific real-machine evidence recorded on the merged implementation
PRs—including Remote SSH/quota, Reasonix, Orca focus, MiMo Code, permission UI,
and Discord Rich Presence—was retained rather than redundantly recreating every
integration environment during the final Windows package smoke.
