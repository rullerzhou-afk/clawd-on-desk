# Setup Guide

[Back to README](../../README.md)

## Source Development Prerequisites

Use Node.js 24.18.0 (the repository `.nvmrc`) for installs, tests, and local
launches. Electron's maintained installer requires Node.js 22.12.0 or newer.

Node 24.16.x and 24.17.x have a known stream compatibility regression that can
silently truncate ZIP extraction when an older `extract-zip` / `yauzl` chain is
present ([nodejs/node#63487](https://github.com/nodejs/node/issues/63487)). The
current Electron dependency no longer uses that chain, but 24.18.0 is the
supported development baseline for the repository and for adjacent tooling.

If Electron reports a missing Framework or the integrity check fails, remove
the whole package and reinstall; do not create only `path.txt`:

```bash
rm -rf node_modules/electron
npm install
```

PowerShell equivalent:

```powershell
Remove-Item -Recurse -Force node_modules/electron
npm install
```

For custom development distributions, a Linux launch with
`ELECTRON_OVERRIDE_DIST_PATH` mirrors Electron's resolver and falls back to the
`electron` executable at the override root when `path.txt` is absent. macOS and
Windows overrides must retain Electron's exact standard `path.txt` because
their supported executable layouts use an app bundle and `electron.exe` rather
than the Linux root executable.

## Agent Setup

Fresh installs enable and install only Claude Code and Codex by default. For other local agents, open **Settings → Agents** and click **Install** for that agent first; after that, Clawd keeps the hook/plugin/extension synced on launch while the agent remains enabled. Turning an enabled agent off stops event intake but does not uninstall files. **Uninstall** removes only Clawd-managed hook/plugin/extension entries and also disables that agent.

**Custom HTTP agents** — Settings can register another local executable and assign it a stable `custom-...` ID, but registration does not install a hook or make the application report events automatically. Custom agents are state-only in v1: the application or an adapter must POST lifecycle events to Clawd's runtime `/state` endpoint, and permission decisions stay in the application's own UI. See [custom-agent-http.md](custom-agent-http.md) for dynamic port discovery, payloads, platform examples, and removal/disable behavior.

**Claude Code** — works out of the box. Hooks are auto-registered on launch. Versioned hooks (`PreCompact`, `PostCompact`, `StopFailure`) are registered only when Clawd can positively detect a compatible Claude Code version; if detection fails (common for packaged macOS launches), Clawd falls back to core hooks and removes stale incompatible versioned hooks automatically. Beyond watching the directory `~/.claude/settings.json` lives in, Clawd also runs a read-only health check every 5 minutes — this catches the hook script being deleted from somewhere like a system Temp folder even when `settings.json` itself never changes. If the same problem fails to auto-repair 3 times in a row, Clawd stops retrying automatically and Doctor will prompt for a manual Fix; if the currently-installed hook script itself is missing (a broken install), Clawd won't blindly rewrite the config — it'll prompt you to reinstall or re-extract instead.

### Claude Code usage: official status line, not scraping

Local Claude usage collection is **off by default**. You can opt in under **Settings → General → Quota ring → Collect local Claude usage**. Enabling it adds Clawd's visible `statusLine.command` to `~/.claude/settings.json`.

This uses Claude Code's documented extension mechanism, not a private or reverse-engineered endpoint. Claude Code's [official status-line documentation](https://code.claude.com/docs/en/statusline) provides `context_window.current_usage`, `context_window.context_window_size`, and (when available) `rate_limits` in the JSON sent to a status-line command. It also states that the command runs locally without consuming API tokens.

The data path is:

1. After a normal Claude Code interaction, Claude Code itself sends its documented status-line JSON to the configured command over stdin.
2. Clawd reads the reported input-token usage and context-window size, plus subscription quota when Claude Code supplies it, and renders a short, visible terminal status line.
3. Clawd sends the normalized context snapshot and available quota only to its own loopback service at `127.0.0.1:23333-23337`. For an explicitly deployed SSH profile, that loopback connection travels through the user-configured reverse SSH tunnel back to the local Clawd app.

For this feature, Clawd does **not** make an additional request to Anthropic, scrape `claude.ai`, invoke `/usage`, or read Claude authentication cookies/tokens. It forwards only normalized token counts/window size and available quota percentages/reset times—not prompt or transcript content. Quota availability still follows Claude Code's contract: `rate_limits` may be absent even though context-window data is present.

Clawd is only a viewer of values reported by Claude Code. It does not calculate, change, bypass, or enforce Anthropic subscription limits. If a quota window is absent, delayed, or changes semantics upstream, Clawd can only omit or display the data Claude Code supplied; it is not the source of the account limit.

#### Model-scoped Claude quota (for example Fable)

Claude may enforce a model-scoped weekly limit in addition to the general 5-hour and weekly limits. For example, Anthropic documents that eligible Max and premium-seat subscriptions can use Fable up to a model-specific portion of the account's weekly allowance and can track both values in Claude's own Usage settings. This is analogous at the product level to a separately identified model quota, but it is not currently exposed through the same integration surface Clawd uses.

As of August 15, 2026, Claude Code's documented status-line contract exposes only `rate_limits.five_hour` and `rate_limits.seven_day`. During investigation we observed Claude Code's internal local cache representing Fable as a `weekly_scoped` item under `cachedUsageUtilization.utilization.limits`, and the official client itself uses an internal `/api/oauth/usage` request to obtain richer usage data. Neither that cache schema nor that endpoint is documented as a stable third-party integration contract.

Clawd therefore intentionally does **not** read Claude Code's internal usage cache, read or refresh Claude OAuth credentials, or call the undocumented usage endpoint. Consequently, a Fable/model-scoped limit can appear in Claude's own Usage settings without appearing in Clawd. This is an upstream visibility boundary, not a failure to parse the documented `rate_limits` object: adding another display provider would not help unless a supported source supplies the additional bucket.

Technical feasibility is not treated as platform support. Clawd will reconsider model-scoped Claude quota when Anthropic exposes it through the documented status-line payload, documents a read-only third-party usage interface, or otherwise explicitly supports that integration. Until then, missing Fable quota is expected behavior. See Anthropic's [Fable plan explanation](https://support.claude.com/en/articles/15424964-claude-fable-5-on-your-plan) and Claude Code's [official status-line schema](https://code.claude.com/docs/en/statusline).

The status line is visible and Claude Code provides a single user-level slot. Clawd therefore never silently replaces an existing custom local status line: enabling collection fails safely and leaves the existing command unchanged. Turning collection off removes only a command carrying Clawd's ownership marker and immediately clears cached local Claude quota, while preserving Remote SSH quota and every non-Claude provider.

Without the Clawd statusline, ordinary Claude hooks still report transcript input-token usage. Clawd uses a closed list of known stock Claude IDs for a compatibility denominator; an empty, custom, or unknown model ID shows used tokens with an unknown limit instead of guessing 200K. For a custom provider's reported window to match Claude Code's `/context`, enable the usage statusline so Claude Code's own `context_window_size` becomes authoritative while transcript hooks continue refreshing the used count.

Running `npm run install:claude-hooks` for a local hook repair does not opt in. The explicit debug form `npm run install:claude-hooks -- --statusline` can install and display Clawd's statusline, but the app still discards its local context/quota POSTs while the Settings switch is off; the next local startup reconcile also removes that Clawd-managed debug slot. Remote SSH deployment is a separate explicit action; when a remote already has its own status line, select **Chain into an existing statusline on deploy** to preserve and restore that registration.

**Codex CLI** — works out of the box. Clawd auto-registers official Codex hooks in `~/.codex/hooks.json` when Codex is installed, and enables `[features].hooks = true` unless the user explicitly set hooks to `false`. The installer migrates the deprecated `[features].codex_hooks` key to `hooks` while preserving an explicit false value. Local installs use stable platform entries under `~/.codex/clawd-hooks/`: Windows reads a managed UTF-8/Base64 data sidecar inside Codex's existing PowerShell command process (with a separate JSON health manifest for Doctor), while POSIX uses a small `/bin/sh` wrapper plus manifest. No unsigned `.ps1` is executed. Codex therefore needs one review for the initial install or migration but does not ask again merely because Clawd, its development worktree, or its Node executable changed. Windows and WSL keep separate execution targets when they share `CODEX_HOME`. The official hook path gives live state updates plus real Allow/Deny permission bubbles. **Settings → Agents → Codex → Start with Codex** separately controls whether a local Codex `SessionStart` may cold-launch Clawd; turning it off keeps state and approval integration available whenever Clawd is already running. Fresh installs default this switch off, while upgrades preserve the prior on behavior. Remote SSH and WSL hooks never cold-launch the desktop app. JSONL polling of `~/.codex/sessions/` remains as a state/metadata fallback for hook-disabled sessions and events Codex hooks do not cover; approval prompts are no longer inferred from JSONL. Codex `request_user_input` calls are detected from that transcript stream: Clawd plays the notification reaction and shows a read-only preview of the questions/options. Answer in Codex itself; the card never injects a choice and closes when the matching tool output is recorded.

**Copilot CLI** — install it from **Settings → Agents** when you want local Copilot CLI tracking. Once installed and enabled, Clawd auto-registers hooks in `<COPILOT_HOME or ~/.copilot>/hooks/hooks.json` on launch (marker-based merge — your other hook entries and `hooks/*.json` files are preserved). Remote SSH installs are automatic via the in-app **Settings → Remote SSH → Deploy / Repair Hooks**. If `hooks.json` or `settings.json` has `disableAllHooks: true`, doctor reports a warning and skips the Fix button. See [copilot-setup.md](copilot-setup.md) for manual fallback and `COPILOT_HOME` notes.

**Gemini CLI** — hooks live in `~/.gemini/settings.json`. Install it from **Settings → Agents** when you want local Gemini tracking; after that Clawd keeps the hooks synced on launch while Gemini remains enabled. You can also run `npm run install:gemini-hooks` manually.

**Antigravity CLI (agy)** — hooks live in `~/.gemini/config/hooks.json`. Install it from **Settings → Agents** when you want local agy tracking; after that Clawd keeps the hooks synced on launch while agy remains enabled. You can also run `npm run install:antigravity-hooks` manually. Clawd is a **state-only** integration for agy: it reflects working / idle / attention state on the pet but **does not show permission bubbles**. Every Allow / Deny / Always-allow choice happens in agy's own 5-option terminal menu — choose the menu item labeled "Persist to settings.json" when you want a permanent rule. The Clawd-on-top approach was abandoned after dogfooding showed it yielded 8-10 confirmations per task; PreToolUse hook is intentionally not registered.

**Cursor Agent** — hooks live in `~/.cursor/hooks.json`. Install it from **Settings → Agents** when you want local Cursor Agent tracking; after that Clawd keeps the hooks synced on launch while Cursor Agent remains enabled. You can also run `npm run install:cursor-hooks` manually.

**CodeBuddy** — uses Claude Code-compatible hooks in `~/.codebuddy/settings.json`. Install it from **Settings → Agents** when you want local CodeBuddy tracking; after that Clawd keeps the hooks synced on launch while CodeBuddy remains enabled. The PermissionRequest entry uses the versioned marker `clawd-on-desk.permission.v1`; registration and uninstall leave unrelated HTTP hooks—including a third-party hook named only `clawd`—untouched. Bare `node hooks/codebuddy-install.js` preserves an existing marker-owned custom permission URL. Use `--permission-url local` to explicitly restore the local Clawd endpoint, or `--permission-url https://example/permission` to explicitly set a custom HTTP(S) endpoint.

**WorkBuddy** — uses Claude Code-compatible hooks in `~/.workbuddy-ai/settings.json` (current WorkBuddy AI) or `~/.workbuddy/settings.json` (legacy builds). Install it from **Settings → Agents** when you want local WorkBuddy tracking; after that Clawd keeps the hooks synced on launch while WorkBuddy remains enabled. You can also run `node hooks/workbuddy-install.js` manually. WorkBuddy is a macOS/Windows Electron desktop app with no standalone Linux/WSL CLI; state-driven animations have been verified on macOS. Integration is **state + Notification only**: the desktop app always handles permission approval inside its own native sandbox and GUI confirmation cards, so Clawd never registers a `/permission` HTTP hook. A permission prompt reaches Clawd only as a waiting-for-confirmation Notification carrying its `session_id` — the bell/attention cue works (verified on Windows), but the approve/deny decision stays inside WorkBuddy.

**Kiro CLI** — install it from **Settings → Agents** when you want local Kiro tracking, or run `npm run install:kiro-hooks` if you want hooks registered before launching Clawd. Kiro's built-in `kiro_default` agent is not backed by an editable JSON file, so Clawd creates a custom `clawd` agent and re-syncs it from the latest `kiro_default` each time Clawd starts after the integration is installed, then appends hooks. Use `kiro-cli --agent clawd` for a new chat, or `/agent swap clawd` inside an existing Kiro session, when you want hooks enabled. On macOS and Windows, state-driven animations have been verified; native terminal permission prompts such as `t / y / n` still need to be answered in the terminal.

**Kimi Code** — Clawd supports both Kimi generations through one integration. The modern Kimi Code (TypeScript CLI) keeps hooks in `~/.kimi-code/config.toml` and the legacy Kimi CLI (Python, discontinued upstream) in `~/.kimi/config.toml`; Clawd installs into whichever directories exist (both, if both are present). Install it from **Settings → Agents**; after that Clawd keeps the hooks synced on launch while Kimi remains enabled. You can also run `npm run install:kimi-hooks` manually. Kimi is hook-only in Clawd: state updates and permission notifications come from hook events, not log polling. On Kimi Code, permission bubbles are driven by the CLI's native `PermissionRequest`/`PermissionResult` hook events — they show the exact command awaiting approval and clear as soon as you answer in the terminal, with no configuration needed. If you migrated from the legacy CLI using Kimi Code's built-in migration, Clawd's next sync automatically upgrades the copied hook entries to the new format (the old env-prefix command style does not execute on Windows). On legacy `~/.kimi` installs the permission cue **defaults to the suspect heuristic**: current kimi-cli versions never emit explicit permission fields on `PreToolUse` (verified on 1.37 and 1.49), so the old explicit-only default meant the cue never fired at all. The installer persists the mode as a `--permission-mode=suspect` flag on each hook `command`; a previously chosen mode — including `explicit` — is always preserved across re-syncs, never flipped (installs made with the retired `CLAWD_KIMI_PERMISSION_MODE=…` env-prefix form are migrated to the flag with their value intact). To opt out, set `CLAWD_KIMI_PERMISSION_MODE=explicit` before running the installer (persists it), or set it at kimi-cli runtime as a temporary override — runtime env vars always beat the persisted flag. Trade-off to know about: with the suspect heuristic, a *pre-approved* gated command that runs longer than ~0.8s briefly shows a false-alarm cue (the card auto-closes after a few seconds; the pet keeps its notification pose until the tool finishes). Turn off Kimi's permission cues entirely from **Settings → Agents** if that bothers you. Heads up: the auto-sync rewrites the `command` field in-place if it diverges from the expected line, so manual edits to that field will be silently restored on the next launch.

**Kimi Code subscription quota (experimental)** — Logging into Kimi Code is not enough for Clawd to read quota: the CLI's public hook/status-line payloads do not contain managed usage. Expand **Kimi Code** under **Settings → Agents**, open Kimi Console, create a dedicated Kimi Code API Key, paste it into **Subscription quota**, and choose **Connect**. The connected Key account's rolling 5-hour and weekly percentages then appear in Orbit and Dashboard. Once connected, the card leads with the connection status and last refresh instead of the Key field: **Refresh** is the single primary action, **Replace key** folds out only on demand, and **Disconnect** / **Forget local key** sit apart in a separated danger zone with their consequences spelled out. This integration is manual-only: Clawd contacts Kimi only for Connect, Replace Key, Reconnect, or Refresh, never on startup or in the background. The Key is not read-only—it can call models, consume subscription quota, and may spend Extra Usage—so Clawd stores only a system-vault-encrypted ciphertext and refuses Linux's weak `basic_text` backend. Disconnect stops quota checks but keeps the encrypted local Key, so **Reconnect** can revive it later without re-pasting; Forget local key removes only Clawd's copy. Neither action revokes the still-valid remote Key, which must be revoked separately in [Kimi Console](https://www.kimi.com/code/console). The usage endpoint is experimental, and Clawd cannot prove that the Key belongs to the same account currently logged into the TUI.

**Qwen Code** — hooks live in `~/.qwen/settings.json`. Install it from **Settings → Agents** when you want local Qwen tracking; after that Clawd keeps the hooks synced on launch while Qwen remains enabled. You can also run `npm run install:qwen-hooks` manually. Qwen Code support is hook-only: state updates and blocking `PermissionRequest` approvals come from Qwen hook events. If `disableAllHooks: true` is present in Qwen settings, Clawd can register entries but Qwen will not fire them until the flag is removed.

**ZCode** — config-file hooks live under `hooks.events.*` in `~/.zcode/cli/config.json`. Install it from **Settings → Agents** when you want local ZCode tracking; after that Clawd keeps all seven supported events synced while ZCode remains enabled — six state events plus a blocking `PermissionRequest` approval hook (manual allow/deny from the Clawd bubble or remote approval; when Clawd yields no decision, ZCode's own permission flow takes over). Global and per-session permission automation deliberately defer for ZCode until its tool surface and session identity are audited. You can also run `npm run install:zcode-hooks` manually. Start a new ZCode session after installing so it loads the current hook configuration. ZCode requires `hooks.enabled: true` to run config-file hooks: Clawd supplies that value when it is absent, but preserves an explicit global `hooks.enabled: false` and any per-hook `enabled: false`. Doctor reports those explicit opt-outs without offering a Fix that would override them. If ZCode imported an older Claude configuration, Clawd removes only imported commands that clearly reference its own `clawd-hook.js` from the ZCode config and never edits `~/.claude/settings.json`.

**CodeWhale** — lifecycle hooks live in `~/.codewhale/config.toml` (`[[hooks.hooks]]` entries). Install it from **Settings → Agents** when you want local CodeWhale tracking; after that Clawd keeps the hooks synced on launch while CodeWhale remains enabled. You can also run `npm run install:codewhale-hooks` manually. Phase 1 is state-only: Clawd drives lifecycle/tool/mode animations but does not show permission bubbles or track subagents. See [codewhale-setup.md](codewhale-setup.md) for details and troubleshooting.

**Reasonix CLI** — hooks live in `<Reasonix home>/settings.json` (`~/.reasonix/settings.json` on macOS/Linux, `%APPDATA%\reasonix\settings.json` on current Windows releases). On Windows, Clawd also follows Reasonix's compatibility fallback to the legacy `~/.reasonix/settings.json`; uninstall removes only Clawd-managed entries from both locations. Install it from **Settings → Agents** when you want local Reasonix tracking; after that Clawd keeps the active hooks synced on launch while Reasonix remains enabled. You can also run `npm run install:reasonix-hooks` manually. Phase 1 is state-only: Clawd drives lifecycle, tool, notification, compaction, and subagent-stop animations but leaves permission decisions in Reasonix's own terminal flow.

**opencode** — uses the effective plugin config under `~/.config/opencode/`: `config.json` → `opencode.json` → `opencode.jsonc`, with the later file winning. Install it from **Settings → Agents** when you want local opencode tracking; after that Clawd keeps the plugin synced on launch while opencode remains enabled. You can also run `node hooks/opencode-install.js` manually.

**MiMo Code** — uses the effective plugin config under `~/.config/mimocode/`: `config.json` → `mimocode.json` → default `mimocode.jsonc`, with the later file winning. Install it from **Settings → Agents** when you want local MiMo Code tracking; after that Clawd keeps the winning plugin entry synced on launch while MiMo Code remains enabled. You can also run `npm run install:mimocode-plugin` manually. MiMo Code shares the same `@mimo-ai/plugin` SDK, zero-latency event streaming, and Allow/Always/Deny permission behavior as opencode. In both integrations, child sessions spawned by the `task` tool are headless and do not participate in the visible multi-session animation fanout.

**Pi** — uses a global extension directory at `~/.pi/agent/extensions/clawd-on-desk`. Install it from **Settings → Agents** when you want local Pi tracking; after that Clawd keeps the extension synced on launch while Pi remains enabled. You can also run `npm run install:pi-extension` manually. Interactive Pi sessions report lifecycle and tool activity to Clawd, but Pi is state-only: Clawd does not show permission bubbles, does not call Pi terminal confirmation, and preserves Pi's default YOLO execution behavior.

**OpenClaw** — uses a plugin path under `~/.openclaw/openclaw.json`. Install it from **Settings → Agents** when you want local OpenClaw tracking; after that Clawd keeps the plugin synced on launch while OpenClaw remains enabled. You can also run `npm run install:openclaw-plugin` manually to let OpenClaw's CLI handle first-time setup. Phase 1 is state-only and targets local `openclaw tui --local` sessions.

**Hermes Agent** — install Hermes from [hermes-agent.org](https://hermes-agent.org/) or [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), then install the Clawd integration from **Settings → Agents** when you want local Hermes tracking. Once the integration is installed and Hermes exists (`%LOCALAPPDATA%\hermes` on Windows or `~/.hermes` on macOS/Linux), Clawd copies its plugin into Hermes' managed plugin directory and enables it through `hermes plugins enable clawd-on-desk`. You can force a manual sync with `npm run install:hermes-plugin`, or remove Clawd's Hermes plugin with `npm run uninstall:hermes-plugin`. Hermes supports state, sessions, terminal focus, and supported permission bubbles; see [known-limitations.md](known-limitations.md) for the current boundary.

**QwenWork (千问办公)** — agent id `qwenwork`; hooks live in `~/.QwenWorkCN/settings.json` (that is QwenWork's real user-data home, not the `~/.qwenwork` path its hooks docs mention). Install it from **Settings → Agents** when you want local QwenWork tracking; after that Clawd keeps the hooks synced on launch while QwenWork remains enabled. You can also run `npm run install:qwenwork-hooks` manually, and `npm run uninstall:qwenwork-hooks` to remove them.

- **Platforms:** macOS and Windows desktop only. [qwenwork.cn/download](https://qwenwork.cn/download) ships macOS 14+, Windows 10+ and HarmonyOS 6.1+; there is no Linux client, so QwenWork does not appear as a WSL pairing target and has no Linux process name.
- **Hook-only, state-only:** Clawd drives animations, the Session HUD and the Dashboard from QwenWork's lifecycle events. `PermissionRequest` / `PermissionDenied` are observed only and mapped to `working` (they fire 40+ times per task as part of normal tool use, so mapping them to `notification` would flash constantly).
- **Clawd never decides:** the hook's stdout is always `{}` on every path — success, unknown event, or error. Clawd registers no `/permission` endpoint, produces no Allow / Deny, and QwenWork is not part of permission automation eligibility. Every approval stays in QwenWork's own permission flow.
- **No startup recovery:** the QwenWork desktop process is long-lived, so its presence is not evidence that a turn is running. Clawd only reacts to hook events.
- **Windows command form:** entries use the portable `node "<script>" "<Event>"` form because QwenWork executes command hooks through a POSIX shell. PowerShell `-EncodedCommand` is only *recognized*, so a Clawd-owned entry written by an older build is migrated in place — it is not the form Clawd writes.
- **Ownership:** merges and uninstall only touch entries whose command contains the `qwenwork-hook.js` marker. A hook merely named `clawd` is left alone, and an entry that mixes a Clawd hook with third-party hooks keeps the third-party ones.
- **Optional debug log:** `CLAWD_QWENWORK_HOOK_DEBUG=1` appends an event/shape summary to `~/.clawd/qwenwork-hook-debug.jsonl` (no prompts, tool inputs or paths). Adding `CLAWD_QWENWORK_HOOK_DEBUG_RAW=1` also stores the complete verbatim payload — **that file then contains sensitive data**; delete it when you are done. On macOS/Linux the file is created `0600`; if the hook creates the debug directory it uses `0700`, while an existing shared `~/.clawd` keeps its current permissions.

**Qoder** — hooks live in `~/.qoder/settings.json`. Install it from **Settings → Agents** when you want local Qoder tracking; after that Clawd keeps the hooks synced on launch while Qoder remains enabled. You can also run `npm run install:qoder-hooks` manually. Qoder is **state-only** in Phase 1: the hook always returns `{}`, and `PermissionRequest` / `PermissionDenied` are observed as passive notifications — Clawd never shows permission bubbles or answers permission decisions, so Qoder's native permission flow stays in control. Startup recovery watches only the Qoder CLI processes (`qodercli` / `qoder-cli`), so an already-open idle Qoder IDE is not treated as active agent work.

**TraeCode (Trae CN)** — experimental, state-only. Hooks live in `~/.trae-cn/hooks.json`. Install it from **Settings → Agents**, or run `npm run install:traecode-hooks` / `npm run uninstall:traecode-hooks`.

- **Manual enable required:** TraeCode hooks must be enabled in the Trae IDE itself — there is no programmatic bypass. Open **Settings → Hooks**, create a **Global** hook, click **Enable** in the security warning panel, and set the run mode to **Sandbox**. Clawd does not require **Local auto-run**. This path has been validated with Trae CN 3.3.94 on Windows and macOS. See the [official Trae hooks doc](https://docs.trae.cn/ide/automate-actions-with-hooks).
- **Windows command form:** Clawd deliberately writes a quote-free `powershell.exe ... -EncodedCommand <base64>` wrapper. Trae's Windows sandbox passes the hook through a native `--command-line` argument that splits quoted paths such as `C:\Program Files\nodejs\node.exe`; the encoded payload preserves that argument boundary. Decoding only the `<base64>` token with `[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("<base64>"))` should yield `& '<node.exe>' '<.../traecode-hook.js>'`.
- **Scope:** this first release covers **Trae CN** (`~/.trae-cn/hooks.json`, process names `Trae CN.exe` / `Trae CN`). The international Trae build (`~/.trae/hooks.json`, `Trae.exe`) is not covered.
- **State-only:** the hook's stdout is always `{}` on every path — Clawd registers no `/permission` endpoint and produces no Allow / Deny; every approval stays in Trae's own permission flow. There is no `SessionEnd` event.
- **Session title:** Trae stores the session title server-side, so Clawd derives it from the first prompt line and keeps the **first** title per session (server-side first-wins). Closed conversations retire via the desktop idle-timeout cleanup (traecode-desktop-idle-timeout).

## Permission handling automation

Use the pet or tray **Permission handling** submenu to choose how Clawd handles supported permission requests:

- **Ask every time** makes no automatic decisions.
- **Question prompts only** automatically approves tool-shaped requests from explicitly supported agents, while questions and plan reviews still wait for you. Claude/Qwen use a reviewed built-in list, but not every supported adapter applies a per-tool allowlist.
- **Auto-approve** handles every request the adapter marks automation-eligible. For Claude/Qwen this includes unrecognized non-empty request names; missing names, unsupported decision shapes, and CodeBuddy questions/plans still defer to the native flow. Use it only if you are comfortable delegating this broader set of decisions. After an app restart, this mode downgrades to **Question prompts only**.

Both automation modes are confirmation-gated. The Dashboard can independently set each eligible live session to **Ask every time** or the tools-only mode. New agents do not become eligible merely because they expose permission support, but tool-name handling remains adapter- and mode-specific as described above. State-only integrations and agents that own a native permission flow continue to use that native flow.

## Telegram Approval

Clawd can optionally mirror supported permission bubbles to a dedicated Telegram
bot, so you can Allow or Deny from Telegram while the local desktop bubble
remains available. See [telegram-approval.md](telegram-approval.md) for setup,
token ownership, supported agents, and fallback behavior.

v0.14.0 retires the old Go sidecar transport. Existing legacy users keep their
saved bot token, allowed user, and target chat, but must complete one real
Telegram verification callback from the blocking Settings migration panel
before remote approval is active again. A failed or timed-out check never
deletes those settings and never falls back to the retired runtime.

## Feishu / Lark Approval

Clawd can also mirror permission bubbles to a Feishu (China) or Lark
(International) self-built app as an interactive card. Pick the platform in
**Settings → Remote Approval → Feishu / Lark**; both are the same channel, so
existing Feishu users keep their credentials and stay on Feishu by default. See
[feishu-lark-remote-approval.md](feishu-lark-remote-approval.md) for the
platform choice, permission scope, `open_id` / `union_id` / `user_id`
differences, and card language.

## Slack Notifications

Unlike the two channels above, Slack is **notification-only**: Clawd posts when
a session finishes, errors out, or is waiting for permission, but the decision
is always made in the desktop app — Slack cannot Allow or Deny in this version.
Set it up with an Incoming Webhook (recommended) or an `xoxb-` bot token with
the `chat:write` scope under **Settings → Remote Approval → Slack**.

Messages go to a Slack channel and can include the session title (derived from
your prompt), folder name, and host name, so a **private channel is
recommended**. See [slack-notifications.md](slack-notifications.md) for setup,
the full list of fields that are sent, secret storage, and troubleshooting.

## Remote SSH (Claude Code, Codex CLI & Copilot CLI)

<img src="../../assets/screenshot-remote-ssh.png" width="560" alt="Remote SSH — permission bubble from Raspberry Pi">

Clawd can sense AI agent activity on remote servers via SSH reverse port forwarding. Hook events and permission requests travel through the SSH tunnel back to your local Clawd — no code changes needed on the Clawd side.

**Supported flow: in-app Settings → Remote SSH → Deploy / Repair Hooks**

DMG / installer users add a profile under **Settings → Remote SSH** (host
`user@remote-host`, optional private key, forward port), then click
**Deploy / Repair Hooks**, then connect. Clawd creates a profile-bound local
ingress, maintains the `ssh -R` reverse tunnel to it, and deploys identity-pinned
hooks to the remote. Full walkthrough, multi-user upgrade boundary, Doctor boundary, and
troubleshooting (port conflicts, no Node.js, missing remote sessions, etc.)
in the dedicated guide:

**→ [docs/guides/guide-remote-ssh.md](guide-remote-ssh.md)**

GitHub Codespaces aliases whose effective SSH `ProxyCommand` uses
`gh cs ssh --stdio` are detected automatically. Clawd serializes its managed
SSH/SCP work for that Codespace and carries readiness inside the persistent
reverse-tunnel session; no manual transport override is normally needed.

**How it works:**
- **Claude Code** — command hooks and the static PermissionRequest URL use the profile's exact forward port. The dedicated local ingress validates a routing nonce before forwarding state or a decision.
- **Codex CLI** — official hooks and the layout-scoped fallback monitor use the same pinned transport. Because Clawd cannot focus a window on the remote host, `request_user_input` cards tell you to return to the remote Codex terminal.
- **Copilot CLI** — deploy writes the resolved `<COPILOT_HOME>/hooks/hooks.json` when Copilot CLI is present. Its hooks use the same pinned, identity-checked transport.

**Claude usage and subscription quota from remote machines:**
- **Claude Code** — deploy also registers Clawd's statusline on the remote (`~/.claude/settings.json` `statusLine`), so its reported context window and available Pro/Max `rate_limits` flow through the tunnel into Clawd. This is the same [official, local status-line mechanism described above](#claude-code-usage-official-status-line-not-scraping), not an extra Anthropic request. By default, local, WSL, and each SSH source stay as separate rows/Orbit coins. If you explicitly enable **Merge quota from multiple machines** in Settings, each quota window uses the freshest reporter instead. The slot is only taken when it is empty or already Clawd's — if you run your own statusline on the remote, enable **"Chain into an existing statusline on deploy"** on the profile: your statusline keeps rendering (its original registration is preserved in `~/.claude/hooks/clawd-statusline-chain.json` and restored on uninstall) while Clawd reads context-window data and available quota.
- **Codex CLI** — the remote log monitor forwards the subscription rate limits carried by rollout `token_count` events through the same tunnel. Only `{used percent, reset time}` ever leaves the remote — no tokens, no credentials, no transcript content.

For remote-only Copilot CLI tracking on a fresh local install, turn on **Copilot CLI** in **Settings → Agents** so Clawd accepts those remote hook events. You do not need to click **Install** unless you also want local Copilot hooks on this machine.

Remote SSH hooks carry both the general remote flag and a dedicated secure
marker; missing or damaged identity fails closed and never falls back to port
scanning. Remote PIDs are not treated as local terminal identities, so
terminal focus is unavailable.

All desktops sharing a server must upgrade and successfully redeploy before
the different-Unix-account fix is complete. The standalone
`scripts/remote-deploy.sh` path is disabled because it cannot participate in
the secure profile transaction. Same-Unix-account `profile-isolated` mode is
experimental and release-gated; it separates user-level CLI roots and Clawd
routing, not the whole `HOME`, project files, caches, same-UID access, or
macOS Claude Keychain auth. See the dedicated guide for the exact boundary.

> Thanks to [@Magic-Bytes](https://github.com/Magic-Bytes) for the original SSH tunneling idea ([#9](https://github.com/rullerzhou-afk/clawd-on-desk/issues/9)).

## WSL (Windows Subsystem for Linux)

> This section mainly covers Claude Code and other hook-based agents inside WSL. For the official `Codex CLI + WSL` status, Codex hook feature-flag behavior, and why Clawd does not auto-detect Codex logs under WSL's Linux home by default, see: [codex-wsl-clarification.md](codex-wsl-clarification.md)

If an agent runs inside WSL while Clawd runs on the Windows host, its integration posts to `127.0.0.1:23333-23337`. WSL1 shares that loopback. WSL2 normally needs mirrored networking; default NAT does not make the Windows loopback server reachable from Linux. The in-app Pair flow probes this path and warns when installation succeeded but connectivity did not.

For supported agents, open **Settings → Agents**, use **WSL Scan** from the Connected section, then find the matching distro row and choose **Pair**. A WSL-only agent can remain under the **Unavailable** collapsible section because local installation status and WSL pairing are separate. Pairing enables Clawd's event ingress but does not mark or install a Windows-local integration.

**Hermes Agent in WSL:** Hermes must already be installed in the selected distro. Pair copies a private, temporary installer payload into WSL, installs and enables `clawd-on-desk` in the primary Hermes home and its discovered profiles, then removes the temporary payload. **Unpair** disables/removes only Clawd's Hermes plugin from that distro; it preserves unrelated plugins and does not disable Hermes events globally when another local or WSL source may still be active. Custom WSL `HERMES_HOME` is resolved from the distro's login shell.

**Setup:**

```bash
# Inside your WSL shell:
mkdir -p ~/.claude/hooks

# Copy hook files from the Windows-side repo (adjust the /mnt/ path to your Clawd location)
cp /mnt/d/animation/hooks/{server-config,json-utils,shared-process,clawd-hook,install,codex-hook,codex-install,codex-install-utils,codex-remote-monitor,codex-session-index,codex-subagent-fields,copilot-hook,copilot-install}.js ~/.claude/hooks/

# Register Claude hooks in remote mode
node ~/.claude/hooks/install.js --remote

# Register Codex official hooks in remote mode when Codex CLI is installed in WSL
node ~/.claude/hooks/codex-install.js --remote

# Register Copilot CLI hooks in remote mode when Copilot CLI is installed in WSL
node ~/.claude/hooks/copilot-install.js --remote
```

After setup, start Clawd on Windows and run Claude Code in WSL — Clawd reacts to your sessions automatically. Permission bubbles work too.

The in-app WSL deploy path intentionally runs the Claude installer without `--statusline`, so it provides transcript fallback only and does not claim an authoritative custom-provider window. The manual `--remote` command above does install a visible statusline in WSL's separate home, but the Windows app accepts its context/quota metadata only while **Collect local Claude usage** is enabled. With the switch off, those POSTs are successful no-ops. Windows startup reconciliation cannot remove a statusline from WSL's separate home.

For Codex in WSL, official hooks work when Codex runs inside the WSL environment and `~/.codex` exists there. If you prefer sharing the Windows Codex home, set `CODEX_HOME=/mnt/c/Users/<windows-user>/.codex` inside WSL before running Codex.

### WSL Networking & Hook Registration (Alternative Approach)

Clawd runs as a Windows Electron app, while your AI coding agents (Claude Code, Kiro CLI, etc.) may run inside WSL. Hook scripts in WSL POST HTTP requests to `127.0.0.1:23333`, so WSL and Windows must share the same localhost.

- **WSL1** — works out of the box. WSL1 naturally shares localhost with Windows, no extra configuration needed.
- **WSL2** — requires mirrored networking mode. WSL2 has its own network stack by default, so `127.0.0.1` points to WSL itself, not Windows. Enable mirrored mode in `%USERPROFILE%\.wslconfig` (create the file if it doesn't exist), then run `wsl --shutdown` to restart WSL:

```ini
[wsl2]
networkingMode=mirrored
```

**Manually register hooks inside WSL:**

Clawd auto-registers Claude Code hooks to `~/.claude/settings.json` on Windows startup. But if your agent runs in WSL, hooks need to be registered in WSL's own home directory. Run inside WSL:

```bash
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# Claude Code
node hooks/install.js

# Codex CLI
node hooks/codex-install.js --remote

# Kiro CLI - registers hooks for all custom agents under ~/.kiro/agents/,
# and auto-creates a clawd agent
node hooks/kiro-install.js

# Kimi Code CLI (Kimi-CLI)
node hooks/kimi-install.js

# Qwen Code
node hooks/qwen-code-install.js

# Cursor Agent
node hooks/cursor-install.js

# Gemini CLI
node hooks/gemini-install.js

# Antigravity CLI (agy)
node hooks/antigravity-install.js

# CodeBuddy
# Preserves an existing marker-owned custom permission URL.
node hooks/codebuddy-install.js
# Explicit alternatives:
# node hooks/codebuddy-install.js --permission-url local
# node hooks/codebuddy-install.js --permission-url https://approval.example/permission

# WorkBuddy
node hooks/workbuddy-install.js

# opencode
node hooks/opencode-install.js

# MiMo Code
npm run install:mimocode-plugin

# Pi
node hooks/pi-install.js

# OpenClaw
node hooks/openclaw-install.js
```

> **Tip:** If the repo is cloned inside WSL (e.g. `~/clawd-on-desk`), hook scripts will automatically use WSL's Node.js path. If the repo is on a Windows drive (e.g. `/mnt/c/...`), make sure `node` is in WSL's `PATH`.

## Windows Notes

- **Installer**: GitHub Releases provide separate NSIS installers for Windows x64 and Windows ARM64. Use `Clawd-on-Desk-Setup-<version>-x64.exe` on Intel/AMD Windows, and `Clawd-on-Desk-Setup-<version>-arm64.exe` on Windows on ARM.
- **Auto-update**: packaged Windows installs use `electron-updater`; updates keep the matching architecture.

## macOS Notes

- **From source** (`npm start`): works out of the box on Intel and Apple Silicon.
- **Official DMG installers**: official GitHub Releases provide both x64 and arm64 DMGs. The release workflow signs them with Developer ID, notarizes them with Apple, and staples the notarization ticket. A manual `workflow_dispatch` run without signing credentials may produce only ad-hoc validation artifacts; those are not official distribution packages.
- **Auto-update bridge**: older DMG releases do not include ZIP update payloads, so they cannot update themselves directly to the first release with in-app updates. Existing users must manually install that bridge release from GitHub Releases once. Afterward, official releases can be downloaded inside Clawd and installed either with **Restart Now**, or with **Later** followed by quitting and reopening the app. The capability is not considered verified until an A→B upgrade signed with the same Developer ID succeeds on real hardware; unit tests are not a substitute.
- **Source auto-update**: when running from a cloned repo, "Check for Updates" performs `git pull` + `npm install` (if dependencies changed) and restarts the app automatically.

## Linux Notes

- **From source** (`npm start`): the Electron sandbox is enabled by default. If your Linux dev environment still fails chrome-sandbox initialization, use `CLAWD_DISABLE_SANDBOX=1 npm start` as a temporary workaround.
- **Packages**: AppImage and `.deb` are available from [GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases). After deb install, the app icon appears in GNOME's app menu.
- **Terminal focus**: uses `wmctrl` or `xdotool` (whichever is available). Install one for session terminal jumping to work: `sudo apt install wmctrl` or `sudo apt install xdotool`.
- **Auto-update**: AppImage and deb installs must still be downloaded manually from GitHub Releases. When running from a cloned repo, "Check for Updates" performs `git pull` + `npm install` (if dependencies changed) and restarts the app automatically.
