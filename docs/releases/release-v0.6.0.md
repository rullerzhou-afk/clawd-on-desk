## v0.6.0

### New Features

- **Settings panel overhaul** (#95, #97) — introduces a dedicated multi-tab settings window and moves growing controls out of crowded menus. `v0.6.0` adds General preferences, Agent manager, per-agent bubble toggles, Theme management, Animation overrides, Reaction cards, Global shortcuts, Edge pinning, and an About tab
- **Theme ecosystem** — fully pluggable theme system replacing hardcoded constants. Themes now define state-to-asset mapping, timings, hitboxes, sounds (#84, thanks @Rladmsrl), fade behavior, and capability metadata in `theme.json`; external themes load from the user config directory (`%APPDATA%/clawd-on-desk/themes/` on Windows, `~/Library/Application Support/clawd-on-desk/themes/` on macOS, `~/.config/clawd-on-desk/themes/` on Linux) with mixed-format rendering (SVG + GIF + APNG + WebP); contributor tooling now includes a skeleton template, validation CLI (`scripts/validate-theme.js`), scaffold CLI, and capability badges
- **Built-in Calico theme** — ships a new calico cat theme with APNG/SVG mixed assets, eye/head tracking, mini-mode variants, and extensive sizing/positioning polish across different display setups
- **Theme controls in Settings and menus** — right-click theme switching now pairs with a Settings-based theme picker/delete flow, "Open Theme Folder", capability-aware animation overrides with import/export, per-file wide-hitbox toggle, reaction cards, and aspect-ratio warnings
- **Sessions and permission UX upgrades** — Sessions menu now shows official agent logos (#78, thanks @TaoXieSZ), real `session_title` names, and status badges; permission bubbles now show session folder + short id and support answer elicitation flows
- **Display and windowing improvements** (#77, #79, thanks @TaoXieSZ, @stickycandy) — proportional size mode (#77), Send to Display, edge pinning, virtual bounds support, smoother size slider/switch animations, space-switching flicker fix (#79), and a more predictable cross-screen drag path make multi-monitor setups behave much better
- **Mini mode and update UX polish** — adds mini-working typing animation (#121, thanks @sophie-haynes), improves mini entry timing, and replaces traditional update dialogs with pet-following update bubbles (#88, thanks @YOIMIYA66)
- **Korean localization** — completes Korean locale support alongside the existing English and Chinese experience

### Bug Fixes

- **DND no longer denies Claude Code permissions on behalf of user** — DND mode now uses `res.destroy()` to let Claude Code fall back to its built-in chat confirmation instead of actively rejecting. Verified on CC 2.1.92+; older CC versions or future upstream changes to destroyed-connection handling may behave differently — if Clawd is in DND and CC hangs on a tool, open the CC terminal and answer there
- **Bubble focus steal fixes** (#75, #80, #98, thanks @stickycandy, @Rladmsrl, @Kevin7Qi) — permission bubbles now open with `show: false`, use `type: "panel"` (`NSPanel`) on macOS, restore topmost state more carefully for floating bubbles, and preserve the previously focused app more reliably on macOS hotkey flows (#80)
- **Cursor false error animation** (#74, thanks @TaoXieSZ) — `postToolUseFailure` demoted from `error` to `working` for Cursor Agent, since tool failures (file not found, grep no match) are normal workflow, not real errors; task-level errors still trigger error state via `stop` with `status === "error"`
- **High-DPI drag and display edge robustness** (#103, #124, thanks @sefuzhou770801-hub, @PeterShanxin) — drag now anchors to the main-process DIP cursor, portrait displays keep the pet readable, work-area queries guard against empty-display enumeration (#93), and Windows taskbar-edge topmost behavior is reasserted more reliably. A few remaining `screen.getAllDisplays()` callsites in mini mode will be hardened in 0.6.1
- **Theme runtime hardening** — fixes theme sanitization, cross-platform basename handling, SVG `url(#id)` preservation, theme switching/pet geometry stability, theme selection persistence, fallback override cards, and asset picker stability
- **Mini mode resilience** (#121, #122, #123) — drag-enter animation replay is reliable again, themes without mini typing assets cleanly fall back, and mini-working timing/energy were retuned
- **Permission bubble flow polish** — bubble stacks anchor to the pet, CC/opencode bubbles replay notification animation when needed, and lingering subagent sessions are cleaned up more reliably
- **Proportional size prompt window** — use `contextIsolation` for the custom percentage input dialog
- **Windows dev-mode auto-start EINVAL** (#128, thanks @CHIANGANGSTER) — `spawn("npm.cmd", { detached: true })` fails on Windows after Node.js CVE-2024-27980 patch; wrap with `cmd.exe /c` and add `windowsHide: true` to keep the auto-launched dev instance invisible
- **Claude Code worktree compatibility** (#129, thanks @IsuminI for the report) — skip `WorktreeCreate` handling to unblock `claude -w`
- **Windows open-at-login for unpackaged Electron runs** (#81, thanks @YOIMIYA66) — ensures dev-mode auto-start persists correctly when running from source
- **Remote deploy completeness** (#99, thanks @Kevin7Qi) — include `json-utils.js` and `shared-process.js` in remote deploy payload so SSH-based hooks work end-to-end
- **Kiro CLI WSL setup** (#91, thanks @ssly) — Kiro agent inheritance switched to `EXCLUDED_KEYS` filter, WSL setup notes added to docs

### Security & Input Hardening

Release-prep pass that tightened external input surfaces — especially relevant with the new external theme ecosystem and elicitation flows.

- **Theme SVG sanitizer hardened** — external theme SVGs now block URL-encoded path traversal (`..%2F..`), protocol-relative URLs (`//host/...`), absolute paths (`C:\`, `/etc`), and `url(...)` references inside inline `style=` / presentation attributes (`fill`, `stroke`, `filter`, `mask`, `marker-*`, etc.). Fragment-only `url(#id)` and safe relative asset refs continue to work
- **Permission bubble input caps** — `permission_suggestions` capped at 20 entries with `addRules` merge preserved; elicitation `AskUserQuestion` caps questions at 5, options at 5 per question, plus per-field length clamps on header / prompt / option label / description. Prevents malformed or hostile agent payloads from blowing up bubble layout
- **Session title normalization** — hook-supplied `session_title` strips C0/DEL/C1 control characters, collapses whitespace, and clamps to 80 characters with ellipsis. Keeps the Sessions menu readable regardless of what agents send

### Refactoring & Tests

- **Shared process utilities** — extracted `shared-process.js` from hook scripts, deduplicating PID resolution and stdin reading across all agents
- **Deduplicated `extractExistingNodeBin`** — single implementation shared across all hook installers
- **Hook payload testability** — extracted `buildStateBody` from `clawd-hook` and cleaned up state/update callsites to make hook behavior easier to verify
- **State machine unit tests** — added unit tests for `state.js` core logic (priority, min-display, oneshot, sleep sequence)
- **Agent config data integrity tests** — validate all agent modules export required fields and consistent event maps

### Docs & Legal

- **Artwork license separation** — source code license and character artwork rights are documented separately, with artwork under All Rights Reserved and a no-commercial-use notice
- **Docs reorganization and localization** — docs are now split into clearer category subfolders, setup/architecture notes were refreshed, and Korean documentation coverage was added
- **Chinese README synced with setup docs** (#82, thanks @YOIMIYA66)

### Contributors

Huge thanks to everyone who shipped code, reported issues, or improved docs for v0.6.0:

- **@TaoXieSZ** — agent session icons (#78), proportional size mode (#77), Cursor false error demote (#74)
- **@YOIMIYA66** — pet-following update bubbles (#88), Windows open-at-login for unpackaged runs (#81), Chinese README sync (#82)
- **@Kevin7Qi** — macOS NSPanel focus fix (#98), remote deploy completeness (#99)
- **@Rladmsrl** — sound effects moved into theme system (#84), macOS focus restore after permission hotkey (#80)
- **@stickycandy** — lost-focus fix (#75), space-switching flicker fix (#79)
- **@PeterShanxin** — high-DPI drag anchor (#124)
- **@sefuzhou770801-hub** — portrait-display readability (#103)
- **@sophie-haynes** — mini-working typing animation (#121)
- **@ssly** — Kiro agent WSL setup + `EXCLUDED_KEYS` filter (#91)
- **@CHIANGANGSTER** — Windows dev-mode auto-start EINVAL (#128)
- **@IsuminI** — reported the `WorktreeCreate` hook bug that led to #129
- **@Tonic-Jin**, **@seoki180** — Korean locale feedback and community contributions

### Known Limitations

- **macOS elicitation input** — the permission bubble runs with `focusable:false` and `type:"panel"` (NSPanel) on macOS. This combination has not been fully verified for `AskUserQuestion` typing flows. If the first character you type in an elicitation prompt on macOS doesn't land in the bubble input, dismiss the bubble and answer in the CC terminal. Full macOS verification is tracked for 0.6.1
