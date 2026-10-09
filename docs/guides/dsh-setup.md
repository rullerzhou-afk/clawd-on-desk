# DeepSeek Harness Integration

[Back to the setup guide](setup-guide.md)

Clawd's first DeepSeek Harness (DSH) integration is experimental and supports
both DSH carriers: the `web` profile (`dsh web`, driven by the global npm CLI)
and the DeepSeek Harness desktop app (its own profile at
`$DSH_HOME/profiles/desktop`). A Clawd-managed plugin runs inside DSH and uses
public APIs for both state observation and ordinary blocking approvals. Clawd
does not read DSH's projection files and does not install a second monitor. In
Clawd this is still one agent (`deepseek-harness`) with one Settings row and one
Doctor row.

The compatibility gate admits a whole verified minor line while DSH remains a
developer preview. Clawd keeps two tables. The family table is the admission
rule: a host version is supported when it parses strictly, its `major.minor`
matches a family, and it is at or above that family's first verified release.
Build metadata (`+...`) is rejected.

| Family | Minimum admitted version | Range |
| --- | --- | --- |
| `0.2` | `0.2.0-rc.2` | `>=0.2.0-rc.2 <0.3.0-0` |
| `0.1` | `0.1.0-rc.6` | `>=0.1.0-rc.6 <0.2.0-0` |

The verified-artifact list is the one place that names concrete releases; new
generation markers and manual `npx` fallbacks pin to it:

| DSH version | npm artifact | npm integrity (sha512) |
| --- | --- | --- |
| `0.2.0-rc.2` (used when the host version is unknown) | `@deepseek-ai/dsh@0.2.0-rc.2` | `sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==` |
| `0.1.5-rc.3` | `@deepseek-ai/dsh@0.1.5-rc.3` | `sha512-c0W6Xqc4ChjFcCJkbzPeIxZQdnbKqe+QAcJzWGtogg0ZzsnZRcw3vopMyZ5oZU6E2fmyqGcyDR1sBeiCH4yHcg==` |
| `0.1.5-rc.1` | `@deepseek-ai/dsh@0.1.5-rc.1` | `sha512-rmNmzQCg3oIc1z8xH7izRSOuy1TNzq+/NILyfM+7e8DKOyV+yBtg47WEsqR2SiIe1ATec3L/rUa1YhIcfQ2XEg==` |
| `0.1.1-rc.2` | `@deepseek-ai/dsh@0.1.1-rc.2` | `sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==` |
| `0.1.0-rc.6` | `@deepseek-ai/dsh@0.1.0-rc.6` | `sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==` |

Only the listed versions were verified by hand; a family is an admission rule,
not a claim that every release inside it was tested. Install and Repair select
the contract of the host's family; Uninstall and manual `npx` commands pin the
marker's own artifact when its version is listed, otherwise the family's newest
verified artifact. Two hosts in the same family share one generation, and the
marker keeps the version it was first staged for. Pre-family markers keep their
old exact `=<version>` range for hash verification. Adding a new minor line
means verifying and listing at least one artifact for it and adding a family
row. The public seams were first
audited against upstream commit `47f9438`, then rechecked in the compiled
rc.6 artifact; that commit is a source baseline, not a claimed tag mapping.
The `0.1.5-rc.1` row was added after re-checking the same four public seams
(`session/created`, `session/event`, `session/disposed`, and the
`approval/request` waterfall) in the published `0.1.5-rc.1` artifact. The
optional title and context-pressure projections were also checked against
the published rc.1 packages. A
controlled macOS session and approval smoke against a localhost mock Clawd
endpoint followed; its scope is
described below. The `0.1.5-rc.3` row was added after re-checking the same four
public seams (`session/created`, `session/event`, `session/disposed`, and the
`approval/request` waterfall) plus the optional title and context-pressure
projections in the published rc.3 artifact; a macOS real-machine run using the
real Clawd UI followed (see below).
The `0.2.0-rc.2` row was added after a read-only static audit of the published
`0.2.0-rc.2` artifact confirmed the same four public seams plus the optional
title and context-pressure projections, followed by the 2026-10-04 macOS
real-machine check described below. That check reused the rc.3 bridge generation
Clawd had already installed: its four bridge files were byte-identical to
`hooks/dsh-clawd-bridge` at main `fe3e1b01`, but the installer at the time did not
yet admit `0.2.0-rc.2`, so it was not an install performed by Clawd's installer.
A later 2026-10-04 run used the `0.2.0-rc.2` generation that Clawd's installer
produced and passed (see below). In `0.2.0-rc.2` a failed `tool/result` marks
`isError` on the message rather than on its content items; the bridge accepts
both shapes.
A version outside every family, or below its family's floor, fails before Clawd
changes the DSH profile.

## Behavior

The plugin observes `session/created`, `session/event`, and `session/disposed`.
It sends a minimal allowlisted payload to Clawd's dynamically discovered local
port; prompts, reasoning, tool arguments, tool results, environment variables,
and credentials are never forwarded. Per-session FIFO delivery plus DSH's
persistent event sequence prevents a late tool event from reviving a disposed
session.

| DSH public event | Clawd event / state |
| --- | --- |
| session created | `SessionStart` / `idle` |
| turn started | `UserPromptSubmit` / `thinking` |
| tool call | `PreToolUse` / `working` |
| successful tool result | `PostToolUse` / `working` |
| failed tool result | `PostToolUseFailure` / `error` |
| turn ended | `Stop` / `attention` (or `StopFailure` / `error`) |
| session disposed | `SessionEnd` / `sleeping` |

DSH's `session/title` event supplies the Session HUD and Dashboard title. When
the public session projection service is present, the plugin also follows
`contextPressure` changes and reads its current value when a session is
created. Clawd displays the same reference occupancy as DSH's ContextMeter:
`(projectedTokens ?? pressureTokens) / contextWindow`, rounded and capped at
100%. It appears only after DSH has reported both usage and model capacity.
The projection is a reference estimate, especially after content changes or a
model switch. Projection updates annotate an existing Clawd session without
creating a card or changing its activity time. If DSH no longer reports both
operands, Clawd clears the old percentage instead of displaying a stale one.
The standard completion bell appears when a finished DSH session is unread.

The quota coin is separate account telemetry. DSH does not currently expose
a five-hour usage bucket through this plugin's public session APIs, so Clawd
does not invent a DSH `5h` percentage. DeepSeek's
[API balance](https://api-docs.deepseek.com/api/get-user-balance/) is an amount
of money and cannot be represented as that rolling-window percentage.

For ordinary `approval/request`, the plugin prepends a blocking listener:

- Clawd **Allow** returns DSH `allowed-once`.
- Clawd **Deny** returns DSH `rejected`.
- HTTP 204, timeout, invalid response, DND, disabled integration, or unavailable
  Clawd calls `next()` so DSH's own approval flow (the web answerer, or the
  desktop app's own approval dialog) remains authoritative.
- DSH cancellation aborts the pending HTTP request.
- `policy="never"` is enforced by DSH before listener dispatch and cannot be
  overridden by Clawd.

`ask_user_question` stays entirely in DSH's native provider. Clawd does not
replace private provider state, create a second question bubble, or auto-answer
questions. DSH approvals also remain manual when Clawd auto-tools or unattended
mode is enabled; per-session grants are not offered in this experimental release.

## Requirements

- A DSH host version inside a verified family on the same machine: `0.2` at or
  above `0.2.0-rc.2`, or `0.1` at or above `0.1.0-rc.6`.

For the `web` profile:

- The `web` profile.
- `pnpm`, because the official DSH plugin command delegates profile mutation to
  pnpm.
- Preferably a global `dsh` CLI on `PATH` for automatic install, repair, and
  uninstall.

For the DeepSeek Harness desktop app (macOS, Windows):

- macOS: DeepSeek Harness installed in `/Applications` or `~/Applications`.
- Windows: a per-user install found through the `HKCU` uninstall entry (display
  name starting with "DeepSeek Harness ") or
  `%LOCALAPPDATA%\Programs\DeepSeek Harness`.
- Windows 11: run Clawd without elevation (not as administrator). An elevated
  process cannot traverse a junction that a non-admin process created, so an
  elevated Clawd may read a plugin installed without elevation as missing. This
  is inferred from an installer-code run; an actually elevated Clawd was not
  reproduced.
- The desktop app opened at least once, so its profile exists. A desktop app
  that was never opened is skipped with a hint to open it once.
- No global CLI is needed: Clawd uses the launcher bundled inside the app.
- Clawd reads the static version from the app bundle (`Info.plist`) or the
  Windows uninstall entry's `DisplayVersion`, then confirms it by running the
  launcher's `--version` before it touches the profile.
- The app does not have to be closed. A newly added plugin loads while it runs;
  a plugin update needs a restart (see Persistent notices).

Linux does not support the desktop app; on Linux only the `web` profile applies.

`DSH_HOME` is honored when it is a trimmed non-empty value; otherwise Clawd uses
`~/.dsh`.

## Install and repair

Open **Settings → Agents**, find **DeepSeek Harness (experimental)**, and click
**Install**. One queued operation handles both carriers, web first and desktop
second, and a failure on one side does not stop the other. Each side independently:

1. copies the packaged bridge into an immutable hash generation under
   `~/.clawd/integrations/deepseek-harness/homes/<dsh-home-hash>/generations/`;
2. calls `dsh plugin --profile web add <generation>` (web, through the global
   CLI) or `dsh plugin --profile desktop add <generation>` (desktop, through the
   launcher bundled in the app);
3. verifies both DSH profile rows, the final profile-local package resolution,
   the Clawd ownership marker, protocol, compatibility range, and bundle hash.

Install succeeds when at least one side verifies healthy. A failure on the other
side becomes a warning on the result and a persistent notice under the row.

The same operation is available for development:

```bash
npm run install:dsh
node hooks/dsh-install.js --repair
```

The `<dsh-home-hash>` namespace is derived from the canonical `DSH_HOME` path.
Separate DSH homes therefore never share a generation that one home's uninstall
or cleanup could delete.

For the `web` profile, if DSH is only used through `npx`, Clawd does not
download it automatically. Settings returns a manual
`npx @deepseek-ai/dsh@<artifact> plugin --profile web ... add`
command pointing at the staged managed generation and explicitly setting the
canonical target `DSH_HOME` (PowerShell on Windows, POSIX environment-prefix
syntax elsewhere). The pinned artifact follows the owned marker: when the
marker's version is on the verified list it is used as-is; otherwise it is the
marker's family's newest verified artifact. With no marker at all it is the
preferred family's newest verified artifact. This keeps an
alternate home from accidentally mutating the
default `~/.dsh` when the command is pasted into a fresh terminal. After that command succeeds,
Install can verify the existing marker-owned plugin without requiring a global
CLI. The generation is protected by a Clawd-owned manual reference until it is
verified, replaced, or explicitly uninstalled; its marker records that the DSH
version was assumed at staging because no CLI version probe was available. A
malformed, foreign, or concurrently replaced reference fails closed, reports its
exact path, and retains managed generations for manual inspection.

The desktop app never uses `npx` and never gets a manual `npx` command: Clawd
always drives it through the launcher bundled in the app, and manual npx
commands and their reference belong to the `web` profile only.

Startup sync repairs only an already opted-in, installed-and-enabled integration.
It never initializes a missing DSH profile. It does add the plugin to an
already-initialized desktop profile (this is how the desktop side gets installed
on a normal start). Settings Install or explicit Doctor Repair may allow the
official CLI to initialize a missing web profile. A running `dsh web` process may
need a restart after install or repair to load a new generation; the desktop app
loads a newly added plugin while it runs, but a plugin update needs a restart.

Upgrading the DSH host and Clawd separately has two paths. When only DSH is
upgraded and Clawd stays on the same version, startup sync keeps the existing
generation instead of staging a new one (it reports `generation-conflict`
internally). The kept generation already contains the bridge files from the
current Clawd version, but its marker still records the older DSH version. To
switch to the new contract right away, open **Settings → Agents**, click
**Uninstall** and then **Install** for DeepSeek Harness, and restart any running
`dsh web`. When Clawd itself is upgraded first and the installed generation was
staged by an older Clawd version, startup sync replaces that generation
automatically.

### Mutation lock recovery

Install, Repair, Uninstall, and cleanup share a per-`DSH_HOME` mutation lock.
Clawd automatically recovers a stranded lock only when its owner metadata is
valid, it is older than twice the operation timeout recorded by that owner, and
an OS PID probe returns `ESRCH` (the recorded process definitely no longer exists). A live
PID, `EPERM`, an unknown liveness result, or malformed/foreign owner metadata is
never taken over.

Lock errors include the exact `mutation.lock` path. If automatic recovery refuses
the lock, close every Clawd instance using that DSH home, verify the reported PID
is no longer running, and inspect `owner.json` at that exact path. Do not delete a
lock owned by a live or unknown process. Preserve malformed or foreign contents
for inspection; Clawd never recursively removes a canonical lock during owner
write failure or release, and only removes the exact isolated owner file plus an
empty lock directory.

## Persistent notices

Settings → Agents shows persistent notices under the DeepSeek Harness row, one
per unacknowledged record. They keep telling the user what a short toast cannot:

- **Desktop restart required**: a plugin update staged a new generation. The
  desktop app loads a newly added plugin while it runs, but it does not reload a
  replaced same-name package, so it needs a restart.
- **Installed in desktop**: a first install into the desktop app.
- **Manual command**: the web side needs a command run by hand. Clawd only
  copies it; it never runs it.
- **Not installed / not fully removed** on either side. A failure that Repair
  can fix also says to open Doctor and click Fix.

Notices are stored per profile under the managed root (`notices-web.json`,
`notices-desktop.json`). If a notice cannot be written, the operation still
succeeds and only adds a warning.

## Two-step repair when the plugin is disabled in DSH

DSH can disable the plugin while keeping the dependency: the bundle row is gone
but the dependency remains. DSH's `plugin add` does not re-enable an existing
dependency. Clawd's explicit repair (Doctor's Fix, or Settings Install) removes
the plugin first and then adds it, and records the pending step per profile in
`repair-operation-<profile>.json`; if the repair is interrupted, the next
explicit repair resumes it. DSH's `plugin remove` only clears the dependency and
bundle rows and updates the lock file, leaving the `node_modules` link behind
(a symlink on macOS, a junction on Windows), so the repair removes Clawd's own
leftover link before it adds the plugin again. Startup sync only reports
`plugin-disabled-in-dsh` and does not change the profile.

## Uninstall and ownership safety

Use Settings → Agents → Uninstall, or:

```bash
npm run uninstall:dsh
```

Uninstall processes both carriers. Clawd verifies ownership before it calls the
official remove command, and it commits the uninstalled preference only after
every Clawd registration is confirmed gone (both profiles' dependency and bundle
rows, and the resolved Clawd package on each side). A user package or fork with
the same package name is reported as a conflict and is never overwritten or
removed.

The two profiles share `generations/`. Cleanup of unreferenced generations pauses
while either side has unprocessed state — an inspection latch, removal residue,
an invalid repair record or manual reference, an unreadable profile, or a
symlinked profile directory. The pause never blocks install; if it leaves old
files behind during uninstall, the result describes them in `warnings`.

`$DSH_HOME/profiles/node_modules` is DSH/pnpm's shared dependency fallback, not a
Clawd ownership anchor or cleanup target. Clawd may report what resolves there,
but it never rewrites or deletes that tree; pnpm owns any fallback-link cleanup.

Doctor reports DSH host detection separately from managed plugin disk health.
The DSH row carries both sides in one detail line (`web: …; desktop: …`); its
status is the worst applicable side, and the Fix button appears whenever at
least one side can be attempted and is not healthy, even if the other side needs
manual attention. Disk health cannot prove that an already-running DSH process
loaded the new generation, so restart guidance remains conservative.

On Windows, Doctor and the installation detector are synchronous and never start
a process. They read one registry snapshot that is refreshed asynchronously when
Clawd starts (whether or not DSH is enabled), before Doctor runs, and on a manual
Agents-page scan. Until a snapshot exists, the desktop side is reported as
"cannot verify".

The installer and Doctor admit only a host whose `major.minor` matches a family
and that is at or above that family's floor before changing the profile; each
operation resolves its target from the detected host version, or from the owned
marker when no CLI probe is available, and never guesses from a range outside
those families. Upgrading from a pre-family exact generation is automatic when
the installed Clawd is newer: startup sync stages the family generation through
the normal Clawd-version rules. Running the same Clawd version from source
reports `generation-conflict` instead, and needs an explicit repair (Settings →
Agents: uninstall, then install; or Doctor's repair).

DSH does not currently expose a public host-version/activation seam to
external plugins, so an already-installed bridge cannot reliably disable itself
before listener registration if DSH is upgraded in place. This is an explicit
experimental limitation: restart after changes, heed Doctor compatibility
warnings, and rely on DSH's native web flow whenever Clawd yields no decision.

## Scope and fallback

- Windows x64 native DSH web is the first target. Real rc.6 install, config
  composition, web boot, uninstall, and packaged-app source loading were verified
  on 2026-08-14.
- On 2026-08-29, **rc.6 source-checkout** runs on Windows x64 and macOS
  verified real API-backed DSH web sessions plus manual Clawd **Allow Once**
  and **Deny** round trips. macOS also verified Settings Install under a
  Finder-like GUI `PATH`. These are source-run results, not packaged API-session
  verification ([#962](https://github.com/rullerzhou-afk/clawd-on-desk/pull/962)).
- Separately, the 2026-08-29 **Windows x64 rc.2 packaged-app** evidence covered
  install, web boot, and `/state` plus Allow/Deny round trips driven directly
  through the bridge's `clawd-client`. It did not demonstrate an API-backed rc.2
  DSH session. On 2026-08-31, maintainer validation also covered the rc.2 Windows
  install/uninstall lifecycle through isolated pnpm and the real rc.6 macOS
  lifecycle, including no-CLI commands
  ([#938](https://github.com/rullerzhou-afk/clawd-on-desk/pull/938)).
  Automated installer coverage includes rc.1 installation, rc.3 installation,
  first install below
  a symlinked parent, rc.6 retention, rc.2 installation, cross-contract
  generation migration, and unlisted-version rejection.
- On 2026-09-23, a **macOS rc.1 source-run** used isolated `HOME` and `DSH_HOME`,
  real `dsh web` sessions created and prompted through DSH's public API, and a
  localhost mock Clawd endpoint. Without the bridge, the baseline session
  emitted no `/state` request. With the bridge, the endpoint received
  `SessionStart`, `UserPromptSubmit`, and `Stop`; a controlled ordinary approval
  request sent to `/permission` resolved to `allowed-once` for Allow and
  `rejected` for Deny. An HTTP 204 left the request pending until DSH session
  cancellation produced `cancelled`. The probe ended before any model step.
  This verifies the bridge and DSH API behavior, not the real Clawd UI or a
  packaged app.
- On 2026-09-24, a second isolated rc.1 Web API run verified `session/title`
  forwarding and live `contextPressure` updates. A local fake SSE endpoint
  supplied controlled model usage, so no real model call or user DSH profile
  was involved. A synthetic 500013-token prompt against DSH's 1000000-token
  context window produced `context_usage: { used: 500013, limit: 1000000,
  percent: 50 }` at a mock Clawd `/state` endpoint, alongside SessionStart,
  UserPromptSubmit, and Stop. This verifies the DSH-to-bridge calculation and
  delivery, not a real user's usage, the Clawd UI, or a packaged app.
- On 2026-09-27, a **macOS rc.3 source-run** used macOS 26.6.2 on Apple silicon
  with the globally npm-installed `@deepseek-ai/dsh@0.1.5-rc.3`
  (`dsh --version` printed `0.1.5-rc.3`) running `dsh web`. It used the
  maintainer's everyday DSH profile rather than an isolated `DSH_HOME`, and Clawd
  ran from this branch's source at commit `691e2ee3`, not a packaged app. Clawd's
  startup sync replaced the managed bridge generation left by an older Clawd
  build with the rc.3 generation (manifest `installedDshVersion: 0.1.5-rc.3`,
  range `=0.1.5-rc.3`), and DSH web listed `clawd-bridge` as an enabled global
  plugin. The real conversation used DSH's official DeepSeek provider with
  `deepseek-flash`, the default `workspace-write` permission preset, and the
  `ask` approval policy. Clawd received `SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `Stop` from the bridge.
  Clawd's Session HUD showed the DSH-generated session title and the context
  occupancy percentage (confirmed visually). For an approval, asking DSH to
  create a file outside the workspace made the model request sandbox escalation
  to `danger-full-access` for bash, which raised `approval/request` and showed a
  Clawd approval bubble. Choosing **Allow** recorded `allowed-once` in DSH, the
  command ran, and the file was created. Choosing **Deny** recorded `rejected`,
  the tool call failed (Clawd showed `PostToolUseFailure`), and the command did
  not run (the Deny prompt targeted the file created in the Allow step, and its
  modification time did not change). This verifies install via startup sync,
  session state, HUD metadata, and Allow/Deny with the real Clawd UI on a source
  run. It did not cover a packaged app, a first install through Settings,
  Uninstall, DND, or the HTTP 204 hand-back and cancellation paths; the last two
  were exercised against a mock endpoint in the 2026-09-23 rc.1 run and were not
  retested on rc.3.
- On 2026-10-04, a **macOS 0.2.0-rc.2 source-run** used macOS 26.6.2 on Apple
  silicon with the globally npm-installed `@deepseek-ai/dsh@0.2.0-rc.2`
  (`dsh --version` printed `0.2.0-rc.2`) running `dsh web`, and Clawd from source
  at main `fe3e1b01`. The installed bridge generation was still the rc.3
  generation Clawd had staged earlier: its four bridge files were byte-identical
  to `hooks/dsh-clawd-bridge` at main `fe3e1b01`, but the installer at the time
  did not yet admit `0.2.0-rc.2`, so this was not an install owned by Clawd's
  `0.2.0-rc.2` contract.
  DSH's plugin list and assembled config included the bridge with no compatibility
  warning. A real conversation used DSH's official DeepSeek provider with
  `DeepSeek-V41-Flash`, the default `workspace-write` permission preset, and the
  `ask` approval policy. Clawd received `SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, and `Stop`. Asking DSH to create a file outside the
  workspace was first refused by the sandbox, then raised `approval/request` on a
  sandbox-escalation retry. Choosing **Allow** recorded `allowed-once`, the file
  was created, and Clawd received `PostToolUse` and `Stop`. Choosing **Deny**
  recorded `rejected` and left the file unchanged; the rejected result carried
  `message.isError: true` (the `0.2.0-rc.2` location) with no content-item
  `isError`, and the rc.3 bridge, which only checked `data.error` and content-item
  `isError`, reported it as `PostToolUse` instead of `PostToolUseFailure`. This
  run is the evidence for the `0.2.0-rc.2` message-level failure shape; it did not
  itself produce a correct `PostToolUseFailure`. It did not cover an install
  performed by Clawd's installer for `0.2.0-rc.2`, a first install through
  Settings, Uninstall, DND, the HTTP 204 hand-back, Windows, a packaged app, or
  the desktop profile.
- On 2026-10-04, a second **macOS 0.2.0-rc.2 source-run** used the `0.2.0-rc.2`
  generation produced by Clawd's own installer. Clawd ran from source at main
  `fe3e1b01` plus this change's three runtime files, and startup sync replaced
  the rc.3 generation left by Clawd 1.1.0 (the new manifest recorded
  `sourceClawdVersion: 1.2.0`, `installedDshVersion: 0.2.0-rc.2`, range
  `=0.2.0-rc.2`); the profile dependency moved to the new generation and the old
  generation was removed. Restarting `dsh web` and opening a real conversation
  with DSH's official DeepSeek provider, `DeepSeek-V41-Flash`, the default
  `workspace-write` permission preset, and the `ask` approval policy delivered
  `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` to
  Clawd. For a sandbox-escalation approval to write outside the workspace,
  **Allow** recorded `allowed-once` and created the file; **Deny** recorded
  `rejected`, left the file unchanged (its modification time and size did not
  change), and — because the failed
  result carried `message.isError: true` with no `data.error` — Clawd showed
  `PostToolUseFailure` / `error` before `Stop`. Clawd's Session HUD showed the
  DSH-generated session title and the context occupancy percentage (1%),
  confirmed visually. This verifies install via startup sync with a generation
  Clawd itself staged, state mapping, HUD metadata, Allow/Deny, and the
  message-level failure flag with the real Clawd UI on a source run. It did not
  cover a packaged app, a first install through Settings, Uninstall, DND, the
  HTTP 204 hand-back and cancellation, Windows, or the desktop profile.
- On 2026-10-04, a **macOS desktop-app source-run** used macOS 26.6.2 on Apple
  silicon with the DeepSeek Harness desktop app `0.2.0-rc.2` in `/Applications`,
  the globally npm-installed `@deepseek-ai/dsh@0.2.0-rc.2`, and Clawd from
  source at commit `ac64d726`. Startup sync installed the plugin into the
  desktop profile, sharing the same generation as web; the row showed the
  "installed in desktop" notice and the Doctor row reported both sides healthy.
  A real conversation inside the desktop app delivered state events from the
  desktop app's host process. A tool call that wrote outside the workspace raised
  an approval: **Allow** created the file, and **Deny** left the file's content
  and modification time unchanged with Clawd showing `PostToolUseFailure`.
  Acknowledging a notice removed it. Changing the bridge source (same Clawd
  version) made startup sync report `generation-conflict` on both sides and point
  at Doctor; Doctor's repair moved both sides to the new generation, removed the
  old one, and raised the "restart desktop" notice, after which the desktop app's
  events came from a new host process. Settings Uninstall removed both profiles'
  dependency and bundle rows, cleaned the link `dsh plugin remove` leaves behind,
  deleted the generation, and cleared both notices; reinstalling through Settings
  put both sides back and the desktop app showed the "installed in desktop"
  notice again (so a first install through Settings is covered). With Clawd in
  Do Not Disturb, a workspace-escaping write produced no Clawd bubble and a
  no-decision response; the desktop app showed its own native approval dialog,
  the file was created after approval, and `PreToolUse` → `PostToolUse` → `Stop`
  still arrived. This verifies the desktop carrier, the shared generation,
  Doctor's one row and Fix, the persistent notices, uninstall/reinstall and a
  first install through Settings, and the DND hand-back to the desktop app's own
  approval dialog on a source run. It did not cover a packaged app or Windows.
- On 2026-10-04, a **Windows x64 installer-code run** used Windows 11 (build
  26200) x64 with the DeepSeek Harness desktop app `0.2.0-rc.2` installed
  per-user under `%LOCALAPPDATA%\Programs\DeepSeek Harness` and the global npm
  `@deepseek-ai/dsh@0.1.0-rc.6` (so web is in the `0.1` family and the desktop app
  in `0.2`). Node ran commit `ac64d726`'s installer code directly (no Electron,
  not a packaged app); the SSH session was an elevated administrator. Verified:
  PowerShell read the registry and found the desktop app (uninstall display name
  "DeepSeek Harness 0.2.0-rc.2"); static discovery reported "cannot verify" until
  a snapshot existed and started no process; the bundled `dsh.cmd` (a path with
  spaces) returned `0.2.0-rc.2` from `--version`; install ran
  `dsh.cmd plugin --profile desktop add`, pnpm linked a junction into the
  generation, Clawd verified it and recorded "installed in desktop", and web and
  the desktop app — in two different version families — kept separate generations
  side by side; Doctor showed one row with both sides and a Fix button; uninstall
  removed the desktop side's dependency and bundle rows, cleaned the junction
  `dsh plugin remove` left behind, and deleted only the desktop generation while
  keeping the one web still used.
- On 2026-10-04, a **Windows real-Clawd (Electron) source run** followed in a
  user session with normal permissions. An Electron-only bug first made Clawd
  treat the desktop app as not installed, because Electron's `fs` reports
  `app.asar` as a directory while the Windows install check required a file
  (fixed in `d8190692`). After the fix, startup sync installed the plugin into a
  desktop app that stayed open — its host process was never restarted — and
  recorded "installed in desktop"; a new conversation delivered events from that
  same host process, so **Windows also loads a newly added plugin while the app
  is open, with no restart**. It did not cover approvals in the Windows desktop
  app, the Electron UI (the Settings notice line and the Doctor window), or a
  packaged app.

  Limitation observed in the earlier installer-code run: an **elevated
  administrator** process on Windows 11 cannot traverse a junction created by a
  non-admin process (PowerShell: "The path cannot be traversed because it
  contains an untrusted mount point"; Node: `UNKNOWN`). The existing web-profile
  junction had been created earlier without elevation, so in that session Clawd
  could not read web's plugin and web's add failed; the desktop junction was
  created in the same session and worked throughout. Clawd running normally is
  not affected. This suggests — but was not reproduced with an actually elevated
  Clawd — that running Clawd as administrator could read plugins installed
  without elevation as missing.
- Linux, WSL, remote SSH, macOS packaging, and ARM64 packaging remain
  unverified; so do approvals in the Windows desktop app, the Electron UI on
  Windows, and the HTTP 204/cancellation hand-back.
- Clicking a desktop-app session opens the DeepSeek Harness desktop window
  (via `dsh://open`, falling back to launching the app when the protocol is not
  handled). This is supported on macOS and Windows only. On 2026-10-05 it was
  verified from source on macOS 26.6.2 and on Windows 11 x64 with the desktop app
  `0.2.0-rc.2`: clicking a desktop session brought the window to the front
  through `dsh://open` with another app in front, when the window was minimized,
  and after it was closed. The launch fallback (used when the protocol cannot be
  opened) is covered by unit tests only. It does not switch to that specific
  conversation: DSH has no external session-navigation entry point, so the
  window shows whatever it was already on. Web sessions remain unfocusable.
  The launch fallback refuses to start when discovery is not a single verified
  install: two valid installs at different real paths are ambiguous (for example
  a system-wide and a per-user copy), and any candidate it cannot verify also
  blocks an automatic launch. Two symlinked locations that resolve to the same
  bundle count as one install.
- The desktop app reopens the previous conversation on launch. Clawd puts that
  conversation in the Session HUD only after it has an action — a prompt, a tool
  call, or an approval — so an untouched reopened conversation never adds a HUD
  row. The Dashboard still lists it and its open button works the same.
- The bridge reports the desktop carrier, so the desktop app needs one restart
  after a plugin update before its sessions become clickable.
- Closing the local bubble does not deny the request. If a configured Telegram
  or Feishu/Lark remote channel takes it, that channel may decide; otherwise DSH
  receives no Clawd decision and continues its native flow.
- Hiding the pet is not DND, so a new approval may still show a bubble. DND
  returns control to DSH without deciding.
