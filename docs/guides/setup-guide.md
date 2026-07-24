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

### Claude Code subscription quota: official status line, not scraping

Local Claude quota collection is **off by default**. You can opt in under **Settings → General → Quota ring → Collect local Claude quota**. Enabling it adds Clawd's visible `statusLine.command` to `~/.claude/settings.json`.

This uses Claude Code's documented extension mechanism, not a private or reverse-engineered endpoint. Claude Code's [official status-line documentation](https://code.claude.com/docs/en/statusline) explicitly provides `rate_limits.five_hour` and `rate_limits.seven_day` in the JSON sent to a status-line command, includes an example that displays those limits, and states that the command runs locally without consuming API tokens.

The data path is:

1. After a normal Claude Code interaction, Claude Code itself sends its documented status-line JSON to the configured command over stdin.
2. Clawd reads the reported percentage/reset fields and renders a short, visible terminal status line.
3. Clawd sends the normalized quota snapshot only to its own loopback service at `127.0.0.1:23333-23337`. For an explicitly deployed SSH profile, that loopback connection travels through the user-configured reverse SSH tunnel back to the local Clawd app.

For this feature, Clawd does **not** make an additional request to Anthropic, scrape `claude.ai`, invoke `/usage`, or read Claude authentication cookies/tokens. The quota cache itself contains normalized usage percentages, reset times, and the reporting source—not prompt or transcript content. Availability still follows Claude Code's contract: `rate_limits` appears only for eligible Claude.ai subscriptions and only after the first API response in a session.

Clawd is only a viewer of values reported by Claude Code. It does not calculate, change, bypass, or enforce Anthropic subscription limits. If a quota window is absent, delayed, or changes semantics upstream, Clawd can only omit or display the data Claude Code supplied; it is not the source of the account limit.

The status line is visible and Claude Code provides a single user-level slot. Clawd therefore never silently replaces an existing custom local status line: enabling collection fails safely and leaves the existing command unchanged. Turning collection off removes only a command carrying Clawd's ownership marker. Running `npm run install:claude-hooks` for a local hook repair does not opt in to quota collection; the explicit debug form is `npm run install:claude-hooks -- --statusline`. Remote SSH deployment is an explicit action; when a remote already has its own status line, select **Chain into an existing statusline on deploy** to preserve and restore that registration.

**Codex CLI** — works out of the box. Clawd auto-registers official Codex hooks in `~/.codex/hooks.json` when Codex is installed, and enables `[features].hooks = true` unless the user explicitly set hooks to `false`. The installer migrates the deprecated `[features].codex_hooks` key to `hooks` while preserving an explicit false value. The official hook path gives live state updates plus real Allow/Deny permission bubbles. JSONL polling of `~/.codex/sessions/` remains as a state/metadata fallback for hook-disabled sessions and events Codex hooks do not cover; approval prompts are no longer inferred from JSONL. Codex `request_user_input` calls are detected from that transcript stream: Clawd plays the notification reaction and shows a read-only preview of the questions/options. Answer in Codex itself; the card never injects a choice and closes when the matching tool output is recorded.

**Copilot CLI** — install it from **Settings → Agents** when you want local Copilot CLI tracking. Once installed and enabled, Clawd auto-registers hooks in `<COPILOT_HOME or ~/.copilot>/hooks/hooks.json` on launch (marker-based merge — your other hook entries and `hooks/*.json` files are preserved). Remote SSH installs are automatic via the in-app **Settings → Remote SSH → Deploy / Repair Hooks**. If `hooks.json` or `settings.json` has `disableAllHooks: true`, doctor reports a warning and skips the Fix button. See [copilot-setup.md](copilot-setup.md) for manual fallback and `COPILOT_HOME` notes.

**Gemini CLI** — hooks live in `~/.gemini/settings.json`. Install it from **Settings → Agents** when you want local Gemini tracking; after that Clawd keeps the hooks synced on launch while Gemini remains enabled. You can also run `npm run install:gemini-hooks` manually.

**Antigravity CLI (agy)** — hooks live in `~/.gemini/config/hooks.json`. Install it from **Settings → Agents** when you want local agy tracking; after that Clawd keeps the hooks synced on launch while agy remains enabled. You can also run `npm run install:antigravity-hooks` manually. Clawd is a **state-only** integration for agy: it reflects working / idle / attention state on the pet but **does not show permission bubbles**. Every Allow / Deny / Always-allow choice happens in agy's own 5-option terminal menu — choose the menu item labeled "Persist to settings.json" when you want a permanent rule. The Clawd-on-top approach was abandoned after dogfooding showed it yielded 8-10 confirmations per task; PreToolUse hook is intentionally not registered.

**Cursor Agent** — hooks live in `~/.cursor/hooks.json`. Install it from **Settings → Agents** when you want local Cursor Agent tracking; after that Clawd keeps the hooks synced on launch while Cursor Agent remains enabled. You can also run `npm run install:cursor-hooks` manually.

**CodeBuddy** — uses Claude Code-compatible hooks in `~/.codebuddy/settings.json`. Install it from **Settings → Agents** when you want local CodeBuddy tracking; after that Clawd keeps the hooks synced on launch while CodeBuddy remains enabled. The PermissionRequest entry uses the versioned marker `clawd-on-desk.permission.v1`; registration and uninstall leave unrelated HTTP hooks—including a third-party hook named only `clawd`—untouched. Bare `node hooks/codebuddy-install.js` preserves an existing marker-owned custom permission URL. Use `--permission-url local` to explicitly restore the local Clawd endpoint, or `--permission-url https://example/permission` to explicitly set a custom HTTP(S) endpoint.

**WorkBuddy** — uses Claude Code-compatible hooks in `~/.workbuddy-ai/settings.json` (current WorkBuddy AI) or `~/.workbuddy/settings.json` (legacy builds). Install it from **Settings → Agents** when you want local WorkBuddy tracking; after that Clawd keeps the hooks synced on launch while WorkBuddy remains enabled. You can also run `node hooks/workbuddy-install.js` manually. WorkBuddy is a macOS/Windows Electron desktop app with no standalone Linux/WSL CLI; state-driven animations have been verified on macOS. Integration is **state + Notification only**: the desktop app always handles permission approval inside its own native sandbox and GUI confirmation cards, so Clawd never registers a `/permission` HTTP hook. A permission prompt reaches Clawd only as a waiting-for-confirmation Notification carrying its `session_id` — the bell/attention cue works (verified on Windows), but the approve/deny decision stays inside WorkBuddy.

**Kiro CLI** — install it from **Settings → Agents** when you want local Kiro tracking, or run `npm run install:kiro-hooks` if you want hooks registered before launching Clawd. Kiro's built-in `kiro_default` agent is not backed by an editable JSON file, so Clawd creates a custom `clawd` agent and re-syncs it from the latest `kiro_default` each time Clawd starts after the integration is installed, then appends hooks. Use `kiro-cli --agent clawd` for a new chat, or `/agent swap clawd` inside an existing Kiro session, when you want hooks enabled. On macOS and Windows, state-driven animations have been verified; native terminal permission prompts such as `t / y / n` still need to be answered in the terminal.

**Kimi Code** — Clawd supports both Kimi generations through one integration. The modern Kimi Code (TypeScript CLI) keeps hooks in `~/.kimi-code/config.toml` and the legacy Kimi CLI (Python, discontinued upstream) in `~/.kimi/config.toml`; Clawd installs into whichever directories exist (both, if both are present). Install it from **Settings → Agents**; after that Clawd keeps the hooks synced on launch while Kimi remains enabled. You can also run `npm run install:kimi-hooks` manually. Kimi is hook-only in Clawd: state updates and permission notifications come from hook events, not log polling. On Kimi Code, permission bubbles are driven by the CLI's native `PermissionRequest`/`PermissionResult` hook events — they show the exact command awaiting approval and clear as soon as you answer in the terminal, with no configuration needed. If you migrated from the legacy CLI using Kimi Code's built-in migration, Clawd's next sync automatically upgrades the copied hook entries to the new format (the old env-prefix command style does not execute on Windows). On legacy `~/.kimi` installs the permission cue **defaults to the suspect heuristic**: current kimi-cli versions never emit explicit permission fields on `PreToolUse` (verified on 1.37 and 1.49), so the old explicit-only default meant the cue never fired at all. The installer persists the mode as a `--permission-mode=suspect` flag on each hook `command`; a previously chosen mode — including `explicit` — is always preserved across re-syncs, never flipped (installs made with the retired `CLAWD_KIMI_PERMISSION_MODE=…` env-prefix form are migrated to the flag with their value intact). To opt out, set `CLAWD_KIMI_PERMISSION_MODE=explicit` before running the installer (persists it), or set it at kimi-cli runtime as a temporary override — runtime env vars always beat the persisted flag. Trade-off to know about: with the suspect heuristic, a *pre-approved* gated command that runs longer than ~0.8s briefly shows a false-alarm cue (the card auto-closes after a few seconds; the pet keeps its notification pose until the tool finishes). Turn off Kimi's permission cues entirely from **Settings → Agents** if that bothers you. Heads up: the auto-sync rewrites the `command` field in-place if it diverges from the expected line, so manual edits to that field will be silently restored on the next launch.

**Qwen Code** — hooks live in `~/.qwen/settings.json`. Install it from **Settings → Agents** when you want local Qwen tracking; after that Clawd keeps the hooks synced on launch while Qwen remains enabled. You can also run `npm run install:qwen-hooks` manually. Qwen Code support is hook-only: state updates and blocking `PermissionRequest` approvals come from Qwen hook events. If `disableAllHooks: true` is present in Qwen settings, Clawd can register entries but Qwen will not fire them until the flag is removed.

**CodeWhale** — lifecycle hooks live in `~/.codewhale/config.toml` (`[[hooks.hooks]]` entries). Install it from **Settings → Agents** when you want local CodeWhale tracking; after that Clawd keeps the hooks synced on launch while CodeWhale remains enabled. You can also run `npm run install:codewhale-hooks` manually. Phase 1 is state-only: Clawd drives lifecycle/tool/mode animations but does not show permission bubbles or track subagents. See [codewhale-setup.md](codewhale-setup.md) for details and troubleshooting.

**Reasonix CLI** — hooks live in `<Reasonix home>/settings.json` (`~/.reasonix/settings.json` on macOS/Linux, `%APPDATA%\reasonix\settings.json` on current Windows releases). On Windows, Clawd also follows Reasonix's compatibility fallback to the legacy `~/.reasonix/settings.json`; uninstall removes only Clawd-managed entries from both locations. Install it from **Settings → Agents** when you want local Reasonix tracking; after that Clawd keeps the active hooks synced on launch while Reasonix remains enabled. You can also run `npm run install:reasonix-hooks` manually. Phase 1 is state-only: Clawd drives lifecycle, tool, notification, compaction, and subagent-stop animations but leaves permission decisions in Reasonix's own terminal flow.

**opencode** — uses a plugin entry in `~/.config/opencode/opencode.json`. Install it from **Settings → Agents** when you want local opencode tracking; after that Clawd keeps the plugin synced on launch while opencode remains enabled. You can also run `node hooks/opencode-install.js` manually.

**MiMo Code** — uses a plugin entry in `~/.config/mimocode/mimocode.jsonc`. Install it from **Settings → Agents** when you want local MiMo Code tracking; after that Clawd keeps the plugin synced on launch while MiMo Code remains enabled. You can also run `node hooks/mimocode-install.js` manually. MiMo Code shares the same `@mimo-ai/plugin` SDK, zero-latency event streaming, and Allow/Always/Deny permission behavior as opencode. In both integrations, child sessions spawned by the `task` tool are headless and do not participate in the visible multi-session animation fanout.

**Pi** — uses a global extension directory at `~/.pi/agent/extensions/clawd-on-desk`. Install it from **Settings → Agents** when you want local Pi tracking; after that Clawd keeps the extension synced on launch while Pi remains enabled. You can also run `npm run install:pi-extension` manually. Interactive Pi sessions report lifecycle and tool activity to Clawd, but Pi is state-only: Clawd does not show permission bubbles, does not call Pi terminal confirmation, and preserves Pi's default YOLO execution behavior.

**OpenClaw** — uses a plugin path under `~/.openclaw/openclaw.json`. Install it from **Settings → Agents** when you want local OpenClaw tracking; after that Clawd keeps the plugin synced on launch while OpenClaw remains enabled. You can also run `npm run install:openclaw-plugin` manually to let OpenClaw's CLI handle first-time setup. Phase 1 is state-only and targets local `openclaw tui --local` sessions.

**Hermes Agent** — install Hermes from [hermes-agent.org](https://hermes-agent.org/) or [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), then install the Clawd integration from **Settings → Agents** when you want local Hermes tracking. Once the integration is installed and Hermes exists (`%LOCALAPPDATA%\hermes` on Windows or `~/.hermes` on macOS/Linux), Clawd copies its plugin into Hermes' managed plugin directory and enables it through `hermes plugins enable clawd-on-desk`. You can force a manual sync with `npm run install:hermes-plugin`, or remove Clawd's Hermes plugin with `npm run uninstall:hermes-plugin`.

**Qoder** — hooks live in `~/.qoder/settings.json`. Install it from **Settings → Agents** when you want local Qoder tracking; after that Clawd keeps the hooks synced on launch while Qoder remains enabled. You can also run `npm run install:qoder-hooks` manually. Qoder is **state-only** in Phase 1: the hook always returns `{}`, and `PermissionRequest` / `PermissionDenied` are observed as passive notifications — Clawd never shows permission bubbles or answers permission decisions, so Qoder's native permission flow stays in control. Startup recovery watches only the Qoder CLI processes (`qodercli` / `qoder-cli`), so an already-open idle Qoder IDE is not treated as active agent work.
## Telegram Approval

Clawd can optionally mirror supported permission bubbles to a dedicated Telegram
bot, so you can Allow or Deny from Telegram while the local desktop bubble
remains available. See [telegram-approval.md](telegram-approval.md) for setup,
token ownership, supported agents, and fallback behavior.

## Feishu / Lark Approval

Clawd can also mirror permission bubbles to a Feishu (China) or Lark
(International) self-built app as an interactive card. Pick the platform in
**Settings → Remote Approval → Feishu / Lark**; both are the same channel, so
existing Feishu users keep their credentials and stay on Feishu by default. See
[feishu-lark-remote-approval.md](feishu-lark-remote-approval.md) for the
platform choice, permission scope, `open_id` / `union_id` / `user_id`
differences, and card language.

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

**How it works:**
- **Claude Code** — command hooks and the static PermissionRequest URL use the profile's exact forward port. The dedicated local ingress validates a routing nonce before forwarding state or a decision.
- **Codex CLI** — official hooks and the layout-scoped fallback monitor use the same pinned transport. Because Clawd cannot focus a window on the remote host, `request_user_input` cards tell you to return to the remote Codex terminal.
- **Copilot CLI** — deploy writes the resolved `<COPILOT_HOME>/hooks/hooks.json` when Copilot CLI is present. Its hooks use the same pinned, identity-checked transport.

**Subscription quota from remote machines:**
- **Claude Code** — deploy also registers Clawd's statusline on the remote (`~/.claude/settings.json` `statusLine`), so the Pro/Max `rate_limits` it reports flow through the tunnel into the Dashboard's account-usage bars. This is the same [official, local status-line mechanism described above](#claude-code-subscription-quota-official-status-line-not-scraping), not an extra Anthropic request. By default, local, WSL, and each SSH source stay as separate rows/Orbit coins. If you explicitly enable **Merge quota from multiple machines** in Settings, each quota window uses the freshest reporter instead. The slot is only taken when it is empty or already Clawd's — if you run your own statusline on the remote, enable **"Chain into an existing statusline on deploy"** on the profile: your statusline keeps rendering (its original registration is preserved in `~/.claude/hooks/clawd-statusline-chain.json` and restored on uninstall) while Clawd only siphons the quota numbers.
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

If you run Claude Code inside WSL while Clawd runs on the Windows host, hooks can POST directly to `127.0.0.1:23333` — no SSH tunnel needed, because WSL2 shares localhost with Windows by default.

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

For Codex in WSL, official hooks work when Codex runs inside the WSL environment and `~/.codex` exists there. If you prefer sharing the Windows Codex home, set `CODEX_HOME=/mnt/c/Users/<windows-user>/.codex` inside WSL before running Codex.

> **Note:** WSL2 localhost forwarding requires Windows 10 build 18945+ (enabled by default). If it doesn't work, check that `localhostForwarding=true` is not disabled in `%USERPROFILE%\.wslconfig`.

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
node hooks/mimocode-install.js

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
- **DMG installer**: the app is not signed with an Apple Developer certificate, so macOS Gatekeeper will block it. To open:
  - Right-click the app → **Open** → click **Open** in the dialog, or
  - Run `xattr -cr /Applications/Clawd\ on\ Desk.app` in Terminal.

## Linux Notes

- **From source** (`npm start`): the Electron sandbox is enabled by default. If your Linux dev environment still fails chrome-sandbox initialization, use `CLAWD_DISABLE_SANDBOX=1 npm start` as a temporary workaround.
- **Packages**: AppImage and `.deb` are available from [GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases). After deb install, the app icon appears in GNOME's app menu.
- **Terminal focus**: uses `wmctrl` or `xdotool` (whichever is available). Install one for session terminal jumping to work: `sudo apt install wmctrl` or `sudo apt install xdotool`.
- **Auto-update**: when running from a cloned repo, "Check for Updates" performs `git pull` + `npm install` (if dependencies changed) and restarts the app automatically.
