# Setup Guide

[Back to README](../../README.md)

## Agent Setup

Fresh installs enable and install only Claude Code and Codex by default. For other local agents, open **Settings → Agents** and click **Install** for that agent first; after that, Clawd keeps the hook/plugin/extension synced on launch while the agent remains enabled. Turning an enabled agent off stops event intake but does not uninstall files. **Uninstall** removes only Clawd-managed hook/plugin/extension entries and also disables that agent.

**Claude Code** — works out of the box. Hooks are auto-registered on launch. Versioned hooks (`PreCompact`, `PostCompact`, `StopFailure`) are registered only when Clawd can positively detect a compatible Claude Code version; if detection fails (common for packaged macOS launches), Clawd falls back to core hooks and removes stale incompatible versioned hooks automatically. Beyond watching the directory `~/.claude/settings.json` lives in, Clawd also runs a read-only health check every 5 minutes — this catches the hook script being deleted from somewhere like a system Temp folder even when `settings.json` itself never changes. If the same problem fails to auto-repair 3 times in a row, Clawd stops retrying automatically and Doctor will prompt for a manual Fix; if the currently-installed hook script itself is missing (a broken install), Clawd won't blindly rewrite the config — it'll prompt you to reinstall or re-extract instead.

**Codex CLI** — works out of the box. Clawd auto-registers official Codex hooks in `~/.codex/hooks.json` when Codex is installed, and enables `[features].hooks = true` unless the user explicitly set hooks to `false`. The installer migrates the deprecated `[features].codex_hooks` key to `hooks` while preserving an explicit false value. The official hook path gives live state updates plus real Allow/Deny permission bubbles. JSONL polling of `~/.codex/sessions/` remains as a state/metadata fallback for hook-disabled sessions and events Codex hooks do not cover; approval prompts are no longer inferred from JSONL.

**Copilot CLI** — install it from **Settings → Agents** when you want local Copilot CLI tracking. Once installed and enabled, Clawd auto-registers hooks in `<COPILOT_HOME or ~/.copilot>/hooks/hooks.json` on launch (marker-based merge — your other hook entries and `hooks/*.json` files are preserved). Remote SSH installs are automatic via the in-app **Settings → Remote SSH → One-click deploy**. If `hooks.json` or `settings.json` has `disableAllHooks: true`, doctor reports a warning and skips the Fix button. See [copilot-setup.md](copilot-setup.md) for manual fallback and `COPILOT_HOME` notes.

**Gemini CLI** — hooks live in `~/.gemini/settings.json`. Install it from **Settings → Agents** when you want local Gemini tracking; after that Clawd keeps the hooks synced on launch while Gemini remains enabled. You can also run `npm run install:gemini-hooks` manually.

**Antigravity CLI (agy)** — hooks live in `~/.gemini/config/hooks.json`. Install it from **Settings → Agents** when you want local agy tracking; after that Clawd keeps the hooks synced on launch while agy remains enabled. You can also run `npm run install:antigravity-hooks` manually. Clawd is a **state-only** integration for agy: it reflects working / idle / attention state on the pet but **does not show permission bubbles**. Every Allow / Deny / Always-allow choice happens in agy's own 5-option terminal menu — choose the menu item labeled "Persist to settings.json" when you want a permanent rule. The Clawd-on-top approach was abandoned after dogfooding showed it yielded 8-10 confirmations per task; PreToolUse hook is intentionally not registered.

**Cursor Agent** — hooks live in `~/.cursor/hooks.json`. Install it from **Settings → Agents** when you want local Cursor Agent tracking; after that Clawd keeps the hooks synced on launch while Cursor Agent remains enabled. You can also run `npm run install:cursor-hooks` manually.

**CodeBuddy** — uses Claude Code-compatible hooks in `~/.codebuddy/settings.json`. Install it from **Settings → Agents** when you want local CodeBuddy tracking; after that Clawd keeps the hooks synced on launch while CodeBuddy remains enabled. You can also run `node hooks/codebuddy-install.js` manually.

**Kiro CLI** — install it from **Settings → Agents** when you want local Kiro tracking, or run `npm run install:kiro-hooks` if you want hooks registered before launching Clawd. Kiro's built-in `kiro_default` agent is not backed by an editable JSON file, so Clawd creates a custom `clawd` agent and re-syncs it from the latest `kiro_default` each time Clawd starts after the integration is installed, then appends hooks. Use `kiro-cli --agent clawd` for a new chat, or `/agent swap clawd` inside an existing Kiro session, when you want hooks enabled. On macOS and Windows, state-driven animations have been verified; native terminal permission prompts such as `t / y / n` still need to be answered in the terminal.

**Kimi Code** — Clawd supports both Kimi generations through one integration. The modern Kimi Code (TypeScript CLI) keeps hooks in `~/.kimi-code/config.toml` and the legacy Kimi CLI (Python, discontinued upstream) in `~/.kimi/config.toml`; Clawd installs into whichever directories exist (both, if both are present). Install it from **Settings → Agents**; after that Clawd keeps the hooks synced on launch while Kimi remains enabled. You can also run `npm run install:kimi-hooks` manually. Kimi is hook-only in Clawd: state updates and permission notifications come from hook events, not log polling. On Kimi Code, permission bubbles are driven by the CLI's native `PermissionRequest`/`PermissionResult` hook events — they show the exact command awaiting approval and clear as soon as you answer in the terminal, with no configuration needed. If you migrated from the legacy CLI using Kimi Code's built-in migration, Clawd's next sync automatically upgrades the copied hook entries to the new format (the old env-prefix command style does not execute on Windows). On legacy `~/.kimi` installs the permission cue **defaults to the suspect heuristic**: current kimi-cli versions never emit explicit permission fields on `PreToolUse` (verified on 1.37 and 1.49), so the old explicit-only default meant the cue never fired at all. The installer persists the mode as a `--permission-mode=suspect` flag on each hook `command`; a previously chosen mode — including `explicit` — is always preserved across re-syncs, never flipped (installs made with the retired `CLAWD_KIMI_PERMISSION_MODE=…` env-prefix form are migrated to the flag with their value intact). To opt out, set `CLAWD_KIMI_PERMISSION_MODE=explicit` before running the installer (persists it), or set it at kimi-cli runtime as a temporary override — runtime env vars always beat the persisted flag. Trade-off to know about: with the suspect heuristic, a *pre-approved* gated command that runs longer than ~0.8s briefly shows a false-alarm cue (the card auto-closes after a few seconds; the pet keeps its notification pose until the tool finishes). Turn off Kimi's permission cues entirely from **Settings → Agents** if that bothers you. Heads up: the auto-sync rewrites the `command` field in-place if it diverges from the expected line, so manual edits to that field will be silently restored on the next launch.

**Qwen Code** — hooks live in `~/.qwen/settings.json`. Install it from **Settings → Agents** when you want local Qwen tracking; after that Clawd keeps the hooks synced on launch while Qwen remains enabled. You can also run `npm run install:qwen-hooks` manually. Qwen Code support is hook-only: state updates and blocking `PermissionRequest` approvals come from Qwen hook events. If `disableAllHooks: true` is present in Qwen settings, Clawd can register entries but Qwen will not fire them until the flag is removed.

**CodeWhale** — lifecycle hooks live in `~/.codewhale/config.toml` (`[[hooks.hooks]]` entries). Install it from **Settings → Agents** when you want local CodeWhale tracking; after that Clawd keeps the hooks synced on launch while CodeWhale remains enabled. You can also run `npm run install:codewhale-hooks` manually. Phase 1 is state-only: Clawd drives lifecycle/tool/mode animations but does not show permission bubbles or track subagents. See [codewhale-setup.md](codewhale-setup.md) for details and troubleshooting.

**Reasonix CLI** — hooks live in `<Reasonix home>/settings.json` (`~/.reasonix/settings.json` on macOS/Linux, `%APPDATA%\reasonix\settings.json` on Windows). Install it from **Settings → Agents** when you want local Reasonix tracking; after that Clawd keeps the hooks synced on launch while Reasonix remains enabled. You can also run `npm run install:reasonix-hooks` manually. Phase 1 is state-only: Clawd drives lifecycle, tool, notification, compaction, and subagent-stop animations but leaves permission decisions in Reasonix's own terminal flow.

**opencode** — uses a plugin entry in `~/.config/opencode/opencode.json`. Install it from **Settings → Agents** when you want local opencode tracking; after that Clawd keeps the plugin synced on launch while opencode remains enabled. You can also run `node hooks/opencode-install.js` manually.

**Pi** — uses a global extension directory at `~/.pi/agent/extensions/clawd-on-desk`. Install it from **Settings → Agents** when you want local Pi tracking; after that Clawd keeps the extension synced on launch while Pi remains enabled. You can also run `npm run install:pi-extension` manually. Interactive Pi sessions report lifecycle and tool activity to Clawd, but Pi is state-only: Clawd does not show permission bubbles, does not call Pi terminal confirmation, and preserves Pi's default YOLO execution behavior.

**OpenClaw** — uses a plugin path under `~/.openclaw/openclaw.json`. Install it from **Settings → Agents** when you want local OpenClaw tracking; after that Clawd keeps the plugin synced on launch while OpenClaw remains enabled. You can also run `npm run install:openclaw-plugin` manually to let OpenClaw's CLI handle first-time setup. Phase 1 is state-only and targets local `openclaw tui --local` sessions.

**Hermes Agent** — install Hermes from [hermes-agent.org](https://hermes-agent.org/) or [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), then install the Clawd integration from **Settings → Agents** when you want local Hermes tracking. Once the integration is installed and Hermes exists (`%LOCALAPPDATA%\hermes` on Windows or `~/.hermes` on macOS/Linux), Clawd copies its plugin into Hermes' managed plugin directory and enables it through `hermes plugins enable clawd-on-desk`. You can force a manual sync with `npm run install:hermes-plugin`, or remove Clawd's Hermes plugin with `npm run uninstall:hermes-plugin`.

**Qoder** — hooks live in `~/.qoder/settings.json`. Install it from **Settings → Agents** when you want local Qoder tracking; after that Clawd keeps the hooks synced on launch while Qoder remains enabled. You can also run `npm run install:qoder-hooks` manually. Qoder is **state-only** in Phase 1: the hook always returns `{}`, and `PermissionRequest` / `PermissionDenied` are observed as passive notifications — Clawd never shows permission bubbles or answers permission decisions, so Qoder's native permission flow stays in control. Startup recovery watches only the Qoder CLI processes (`qodercli` / `qoder-cli`), so an already-open idle Qoder IDE is not treated as active agent work.
## Telegram Approval

Clawd can optionally mirror supported permission bubbles to a dedicated Telegram
bot, so you can Allow or Deny from Telegram while the local desktop bubble
remains available. See [telegram-approval.md](telegram-approval.md) for setup,
token ownership, supported agents, and fallback behavior.

## Remote SSH (Claude Code, Codex CLI & Copilot CLI)

<img src="../../assets/screenshot-remote-ssh.png" width="560" alt="Remote SSH — permission bubble from Raspberry Pi">

Clawd can sense AI agent activity on remote servers via SSH reverse port forwarding. Hook events and permission requests travel through the SSH tunnel back to your local Clawd — no code changes needed on the Clawd side.

**Primary flow: in-app Settings → Remote SSH → One-click deploy**

DMG / installer users add a profile under **Settings → Remote SSH** (host
`user@remote-host`, optional private key, forward port), then click
**One-click deploy**. Clawd opens and maintains the `ssh -R` reverse tunnel
and deploys hooks to the remote. Full walkthrough, Doctor boundary, and
troubleshooting (port conflicts, no Node.js, missing remote sessions, etc.)
in the dedicated guide:

**→ [docs/guides/guide-remote-ssh.md](guide-remote-ssh.md)**

**How it works:**
- **Claude Code** — command hooks on the remote server POST state changes to `localhost:23333`, which the SSH tunnel forwards back to your local Clawd. Permission bubbles work too — the HTTP round-trip goes through the tunnel.
- **Codex CLI** — official hooks on the remote server POST state changes and permission requests through the same tunnel. If Codex hooks are unavailable or disabled on the remote install, use the fallback log monitor: `node ~/.claude/hooks/codex-remote-monitor.js --port 23333`
- **Copilot CLI** — one-click deploy writes `~/.copilot/hooks/hooks.json` on the remote (when Copilot CLI is installed, i.e. `~/.copilot/` exists). Hooks POST state and session titles through the same tunnel.

For remote-only Copilot CLI tracking on a fresh local install, turn on **Copilot CLI** in **Settings → Agents** so Clawd accepts those remote hook events. You do not need to click **Install** unless you also want local Copilot hooks on this machine.

Remote hooks run in `CLAWD_REMOTE` mode which skips PID collection (remote PIDs are meaningless locally). Terminal focus is not available for remote sessions.

**Source-checkout fallback:** the older shell script is only needed when
running from a source checkout (`npm start` debugging):

```bash
bash scripts/remote-deploy.sh user@remote-host
```

It copies hooks from the current source tree and prints manual SSH config
suggestions (add `RemoteForward 127.0.0.1:23333 127.0.0.1:23333` to
`~/.ssh/config`). DMG / installer users don't need a source checkout — use
the in-app one-click deploy instead.

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

If you have SSH enabled in WSL, the source-checkout fallback script also works:

```bash
# From Windows (Git Bash / PowerShell):
bash scripts/remote-deploy.sh youruser@localhost
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
node hooks/codebuddy-install.js

# opencode
node hooks/opencode-install.js

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
