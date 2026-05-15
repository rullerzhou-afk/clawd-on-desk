## v0.7.1

### New Features

- **Hermes Agent plugin integration** - Clawd now supports Hermes Agent via a Python plugin with session boundary hooks, terminal focus metadata, WebUI session metadata, a dedicated agent icon, and default enablement for new installs.
- **Pi Agent extension integration** - Pi is supported through a global extension under `~/.pi/agent/extensions`, with permission bubbles for `bash`/`write`/`edit` operations and a dedicated agent icon.
- **OpenClaw state-only integration** - OpenClaw is supported through `~/.openclaw/openclaw.json` plugin path for state reporting, with a session icon and icon attribution. Phase 1 covers local `openclaw tui --local`.
- **Settings Doctor panel** - New diagnostics modal in Settings that checks agent integration health, hook/plugin installation status, and feature coverage, with collapsible detail sections and attention indicators.
- **Chinese (Traditional) translation** (#280) - Full zh-TW locale coverage for Settings, Codex Pet dialogs, question navigation labels, and i18n tests.
- **Session HUD auto-hide and pin** (#210) - Session HUD now defaults to auto-hide and exposes a pin toggle; settings are collapsed into a summary group.
- **One-click remote SSH tunnel (Phase 2)** (#252) - Enhanced remote SSH deployment with improved profile management and IPC.
- **Copilot CLI remote SSH deployment** (#284) - Remote deploy now copies and registers Copilot CLI hooks when `~/.copilot/` exists on the remote host, marks those hooks as remote, and carries host prefix metadata while skipping local-only PID collection.
- **User theme zip package import** - Settings can now import user theme zip packages directly, with import queue semantics and validation.
- **Copilot CLI session name forwarding** (#267) - Copilot CLI hook now forwards the session name to Clawd for better session display.
- **Permission auto-close fallback** (#273) - Stuck hook sockets now auto-close after a configurable timeout instead of blocking indefinitely.
- **Custom scrollbar styles** (#243) - Settings window now uses custom scrollbar styles for a more polished look.
- **Go to Terminal workspace focus** - "Go to Terminal" now focuses the originating workspace when using Superset deep-link.
- **cmux workspace switching** (#259) - Session focus now supports cmux (terminal multiplexer), resolving cmux binary path via Spotlight (mdfind), matching panel UUID, and searching all cmux windows for the target TTY.
- **Settings custom language picker** (#283) - Language selection in Settings now uses an accessible custom listbox with keyboard support and polished light/dark styling.

### Bug Fixes

- **wmic deprecation** (#268) - Replaced all Windows `wmic` process lookups with PowerShell `Get-CimInstance` across hooks, pi-extension, opencode-plugin, and state modules, fixing deprecation warnings and failures on newer Windows builds.
- **macOS hook node path detection** - Fixed node binary path resolution for Claude hooks on macOS.
- **Windows PowerShell terminal focus** - Fixed terminal focus failing when PowerShell was the active shell.
- **Fullscreen window pet recovery** - Pet now recovers correctly after fullscreen window switches on Windows.
- **Hermes CIM process lookup** - Replaced Windows process lookup with CIM snapshot for Hermes agent.
- **Sound settings toggles** - Hardened sound settings summary controls sync and compatibility.
- **Theme card keyboard events** - Isolated theme card button keyboard events to prevent interference.
- **Summary chips compatibility** - Preserved summary chip clearing compatibility and fixed gap rendering.
- **Animation override controls** - Stabilized animation override pending sync, wide hitbox affordances, and stale state cleanup.
- **Bubble policy summary inline** - Kept bubble policy summary inline instead of wrapping.
- **Low power idle CPU** - Fixed excessive CPU usage during low-power idle mouse-follow.
- **Mini mode crabwalk** - Fixed reverse mini crabwalk during pre-entry animation.
- **Doctor panel polish** - Multiple rounds of review feedback, collapsed detail sections, timestamp display, and attention check clarifications.
- **Claude auto-start session handoff** - Fixed session not being handed off correctly when Claude auto-starts Clawd.
- **Codex Desktop session focus** (#281) - Fixed Codex Desktop sessions not opening from dashboard, preserved permission focus metadata through stale logs and review rounds, and carried metadata correctly across session transitions.
- **cmux panel focus hardening** - Fixed cmux panel focus matching when multiple cmux windows are present.
- **Windows CIM timeout hardening** - Bounded Windows CIM parent-process lookups in terminal focus and Hermes fallback metadata resolution to avoid slow system queries stalling focus/session metadata paths.
- **Settings language picker stability** (#283) - Avoided duplicate language update requests, restored the committed language when a pending selection is canceled or fails, and cleaned up document listeners across re-renders.

### Refactoring & Tests

- **Massive modular extraction** - Broke up monolithic source files into focused modules:
  - `state.js` split into 7 focused modules: priority, visual-resolver, hitbox-resolver, session-snapshot, stale-cleanup, session-events, agent-icons
  - `server.js` split into: route handlers (state, permission), hook event buffer, permission utilities, integration sync runtime, claude settings watcher, codex official turn tracking
  - `settings-actions.js` split into: agents, shortcuts, system, theme-overrides, validators
  - `theme-loader.js` split into: schema, variants, sanitizer, metadata, assets-cache, context, fade-sequencer, runtime
  - Extracted runtime modules: topmost, floating-window, pet-window, agent-runtime, settings-window, shortcut, settings-ipc, session-ipc, pet-interaction-ipc
  - Extracted bubble renderer assets, settings stylesheet, codex pet main runtime
- **Permission bubble IPC normalization** - Unified permission bubble IPC registration patterns.
- **New test coverage** - Added tests for: runtime refactor follow-ups, settings router auto-close, topmost/floating-window/pet-window/agent-runtime/theme-runtime/focus-mac-extras/focus-superset, hermes install/plugin, copilot hook/install, remote SSH Copilot deploy, settings language picker behavior, dashboard, codex pet import queue, and i18n zh-TW.

### Docs & Contributors

- **Hermes Agent docs** - Added Hermes Agent to Japanese and Korean READMEs.
- **OpenClaw support docs** - Documented OpenClaw integration and added icon attribution.
- **Copilot remote SSH docs** - Documented automatic Copilot CLI hook registration for remote deploy while keeping local Copilot setup manual.
- **Animation preview docs** - Updated animation preview documentation.
- **No-cryptocurrency disclaimer** - Added disclaimer to README.
- **Release packaging prep** - Bumped package metadata to 0.7.1 and ensured the v0.7.1 release note is tracked.
- **10 contributors** shipped code in this release (193 commits).

### Contributors

Huge thanks to everyone who shipped code, tests, docs, or release polish for v0.7.1:

- **@rullerzhou-afk** - Hermes/Pi/OpenClaw integrations, Hermes terminal metadata and install hardening, massive refactor rounds, remote SSH support, settings/animation polish, Copilot remote deploy review, and release preparation (107 commits)
- **@YOIMIYA66** - Settings Doctor panel, Settings custom language picker (#283), Codex Desktop focus fixes, bubble policy summary fix, animation override and wide-hitbox fixes, theme card/status-space fixes, settings general panel polish (#265), and README contributor-grid hardening
- **@Ruller_Lulu** - One-click remote SSH tunnel Phase 2 (#252), Windows fullscreen pet recovery, and release merge/review support
- **@hwasowl** - wmic deprecation fix (#268) for hooks, pi-extension, opencode-plugin, and state modules
- **@pan93412** - Chinese (Traditional) translation (#280)
- **@LyuBingrong** - Settings disclosure chevrons (#253), animation override action layout (#249), and release merge/review support
- **@nmsn** - cmux workspace switching (#259), summary chips gap fix (#260)
- **@tatsuyanakano** - Go to Terminal redo (#257), Superset workspace focus, and focus test fixes
- **@keiyo118** - Hermes Agent Japanese and Korean README docs (#276)
- **@XiangZheng2002** - Copilot CLI session name forwarding (#267) and Copilot CLI remote SSH hook deployment (#284)

### Known Limitations

- **Hermes Agent is Windows/Python-first** - Python plugin tests use `python3` off Windows; Hermes terminal focus metadata depends on Windows Terminal parent fallback.
- **OpenClaw is state-only (Phase 1)** - No permission bubble or terminal focus for OpenClaw yet; primarily supports local `openclaw tui --local`.
- **Pi permission bubbles cover bash/write/edit only** - Other Pi operations fall back to terminal confirmation.
- **Codex hook coverage is still not complete** - Official hooks remain primary, JSONL polling retained as fallback.
- **cmux focus requires Spotlight** - cmux binary path resolution on macOS depends on `mdfind` (Spotlight); if Spotlight indexing is disabled for the cmux binary location, focus will fall back to default terminal matching.
