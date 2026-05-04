# Setup Guide

[Back to README](../README.md)

## Agent Setup

**Claude Code** — works out of the box. Hooks are auto-registered on launch. Versioned hooks (`PreCompact`, `PostCompact`, `StopFailure`) are registered only when Clawd can positively detect a compatible Claude Code version; if detection fails (common for packaged macOS launches), Clawd falls back to core hooks and removes stale incompatible versioned hooks automatically.

**Codex CLI** — works out of the box. Clawd auto-registers official Codex hooks in `~/.codex/hooks.json` when Codex is installed, and enables `[features].codex_hooks = true` unless the user explicitly set it to `false`. The official hook path gives live state updates plus real Allow/Deny permission bubbles. JSONL polling of `~/.codex/sessions/` remains as a fallback for hook-disabled sessions and events Codex hooks do not cover.

**Copilot CLI** — the one supported agent that still requires manual hook setup. See [copilot-setup.md](copilot-setup.md) for instructions.

**Gemini CLI** — hooks live in `~/.gemini/settings.json`. Clawd auto-registers them on launch when Gemini is installed, or you can run `npm run install:gemini-hooks` manually.

**Cursor Agent** — hooks live in `~/.cursor/hooks.json`. Clawd auto-registers them on launch when Cursor is installed, or you can run `npm run install:cursor-hooks` manually.

**CodeBuddy** — uses Claude Code-compatible hooks in `~/.codebuddy/settings.json`. Clawd auto-registers them on launch when CodeBuddy is installed, or you can run `node hooks/codebuddy-install.js` manually.

**Kiro CLI** — run `npm run install:kiro-hooks` if you want hooks registered before launching Clawd. Kiro's built-in `kiro_default` agent is not backed by an editable JSON file, so Clawd creates a custom `clawd` agent and re-syncs it from the latest `kiro_default` each time Clawd starts, then appends hooks. Use `kiro-cli --agent clawd` for a new chat, or `/agent swap clawd` inside an existing Kiro session, when you want hooks enabled. On macOS and Windows, state-driven animations have been verified; native terminal permission prompts such as `t / y / n` still need to be answered in the terminal.

**Kimi Code CLI (Kimi-CLI)** — hooks live in `~/.kimi/config.toml` (`[[hooks]]` entries). Clawd auto-registers them on launch when Kimi is installed, or you can run `npm run install:kimi-hooks` manually. Kimi is hook-only in Clawd: state updates and permission notifications come from hook events, not log polling. To make a permission-classification choice persist across restarts, set `CLAWD_KIMI_PERMISSION_MODE=explicit` (default) or `CLAWD_KIMI_PERMISSION_MODE=suspect` before running the installer — the value gets written into the `command` field for every Kimi hook so subsequent Clawd auto-syncs preserve it. Heads up: the auto-sync also rewrites the `command` field in-place if it diverges from the expected line, so manual edits to that field will be silently restored on the next launch.

**opencode** — uses a plugin entry in `~/.config/opencode/opencode.json`. Clawd auto-registers it on launch when opencode is installed, or you can run `node hooks/opencode-install.js` manually.

## Remote SSH (Claude Code & Codex CLI)

<img src="../assets/screenshot-remote-ssh.png" width="560" alt="Remote SSH — permission bubble from Raspberry Pi">

Clawd can sense AI agent activity on remote servers via SSH reverse port forwarding. Hook events and permission requests travel through the SSH tunnel back to your local Clawd — no code changes needed on the Clawd side.

**One-click deploy:**

```bash
bash scripts/remote-deploy.sh user@remote-host
```

This copies hook files to the remote server, registers Claude Code hooks and Codex official hooks in remote mode, and prints SSH configuration instructions.

**SSH configuration** (add to your local `~/.ssh/config`):

```
Host my-server
    HostName remote-host
    User user
    RemoteForward 127.0.0.1:23333 127.0.0.1:23333
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

**How it works:**
- **Claude Code** — command hooks on the remote server POST state changes to `localhost:23333`, which the SSH tunnel forwards back to your local Clawd. Permission bubbles work too — the HTTP round-trip goes through the tunnel.
- **Codex CLI** — official hooks on the remote server POST state changes and permission requests through the same tunnel. If Codex hooks are unavailable or disabled on the remote install, use the fallback log monitor: `node ~/.claude/hooks/codex-remote-monitor.js --port 23333`

Remote hooks run in `CLAWD_REMOTE` mode which skips PID collection (remote PIDs are meaningless locally). Terminal focus is not available for remote sessions.

> Thanks to [@Magic-Bytes](https://github.com/Magic-Bytes) for the original SSH tunneling idea ([#9](https://github.com/rullerzhou-afk/clawd-on-desk/issues/9)).

## WSL (Windows Subsystem for Linux)

> This section mainly covers Claude Code and other hook-based agents inside WSL. For the official `Codex CLI + WSL` status, Codex hook feature-flag behavior, and why Clawd does not auto-detect Codex logs under WSL's Linux home by default, see: [codex-wsl-clarification.md](codex-wsl-clarification.md)

If you run Claude Code inside WSL while Clawd runs on the Windows host, hooks can POST directly to `127.0.0.1:23333` — no SSH tunnel needed, because WSL2 shares localhost with Windows by default.

**Setup:**

```bash
# Inside your WSL shell:
mkdir -p ~/.claude/hooks

# Copy hook files from the Windows-side repo (adjust the /mnt/ path to your Clawd location)
cp /mnt/d/animation/hooks/{server-config,json-utils,shared-process,clawd-hook,install,codex-hook,codex-install,codex-install-utils,codex-remote-monitor,codex-session-index,codex-subagent-fields}.js ~/.claude/hooks/

# Register Claude hooks in remote mode
node ~/.claude/hooks/install.js --remote

# Register Codex official hooks in remote mode when Codex CLI is installed in WSL
node ~/.claude/hooks/codex-install.js --remote
```

If you have SSH enabled in WSL, the one-click deploy script also works:

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

# Cursor Agent
node hooks/cursor-install.js

# Gemini CLI
node hooks/gemini-install.js

# CodeBuddy
node hooks/codebuddy-install.js

# opencode
node hooks/opencode-install.js
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
