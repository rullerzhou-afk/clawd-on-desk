# 配置指南

[返回 README](../README.zh-CN.md)

## Agent 配置说明

**Claude Code** — 开箱即用。Clawd 启动时会自动注册 hooks。只有在确认 Claude Code 版本兼容时才会注册 versioned hooks（`PreCompact`、`PostCompact`、`StopFailure`）；如果版本无法确认，会自动回退到核心 hooks，并清理旧的不兼容条目。

**Codex CLI** — 开箱即用。Clawd 会自动轮询 `~/.codex/sessions/` 下的 JSONL 日志。

**Copilot CLI** — 目前唯一仍需手动配置 hooks 的受支持 Agent。请参考 [copilot-setup.md](copilot-setup.md)。

**Gemini CLI** — hooks 配置在 `~/.gemini/settings.json`。如果本机已安装 Gemini，Clawd 启动时会自动注册；也可以手动执行 `npm run install:gemini-hooks`。

**Cursor Agent** — hooks 配置在 `~/.cursor/hooks.json`。如果本机已安装 Cursor，Clawd 启动时会自动注册；也可以手动执行 `npm run install:cursor-hooks`。

**CodeBuddy** — 使用与 Claude Code 兼容的 hooks，配置写入 `~/.codebuddy/settings.json`。如果本机已安装 CodeBuddy，Clawd 启动时会自动注册；也可以手动执行 `node hooks/codebuddy-install.js`。

**Kiro CLI** — 如果你想在启动 Clawd 前先注册 hooks，可先执行 `npm run install:kiro-hooks`。Kiro 内置的 `kiro_default` 不是一个可编辑的 JSON agent，所以 Clawd 会维护一个自定义 `clawd` agent，并在每次启动时先同步最新的 `kiro_default` 配置，再追加 hooks。需要 hooks 时，请用 `kiro-cli --agent clawd` 新开会话，或者在现有会话里执行 `/agent swap clawd`。目前在 macOS 与 Windows 上，状态类动效已验证可用；但涉及终端里 `t / y / n` 的原生权限确认，仍然只能在终端处理。

**Kimi Code CLI（Kimi-CLI）** — hooks 配置在 `~/.kimi/config.toml`（`[[hooks]]` 条目）。如果本机已安装 Kimi，Clawd 启动时会自动注册；也可以手动执行 `npm run install:kimi-hooks`。在 Clawd 中 Kimi 采用 hook-only 集成：状态和权限提示都来自 hook 事件，不再依赖日志轮询。如果想让权限分类策略在重启后仍然生效，请在执行安装命令之前设置环境变量 `CLAWD_KIMI_PERMISSION_MODE=explicit`（默认）或 `CLAWD_KIMI_PERMISSION_MODE=suspect`，安装脚本会把这个值写进 `~/.kimi/config.toml` 中每条 Kimi hook 的 `command` 字段，后续 Clawd 自动同步也会保留它。注意：自动同步会按预期行重写 `command` 字段，所以你对该字段的手工修改会在下次启动时被静默还原。

**opencode** — 使用 `~/.config/opencode/opencode.json` 里的 plugin 配置。如果本机已安装 opencode，Clawd 启动时会自动注册；也可以手动执行 `node hooks/opencode-install.js`。

## 远程 SSH 模式（Claude Code & Codex CLI）

<img src="../assets/screenshot-remote-ssh.png" width="560" alt="远程 SSH — 来自树莓派的权限气泡">

Clawd 支持通过 SSH 反向端口转发感知远程服务器上的 AI Agent 状态。Hook 事件和权限请求通过 SSH 隧道传回本地 Clawd，无需修改 Clawd 本体代码。

**一键部署：**

```bash
bash scripts/remote-deploy.sh user@远程主机
```

脚本会将 hook 文件复制到远程服务器，以远程模式注册 Claude Code hooks，并打印 SSH 配置指引。

**SSH 配置**（添加到本地 `~/.ssh/config`）：

```
Host my-server
    HostName 远程主机
    User user
    RemoteForward 127.0.0.1:23333 127.0.0.1:23333
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

**工作原理：**
- **Claude Code** — 远程 hook 将状态 POST 到 `localhost:23333`，SSH 隧道转发回本地 Clawd。权限气泡也能正常弹出——HTTP 往返通过隧道完成。
- **Codex CLI** — 独立的日志监控脚本（`codex-remote-monitor.js`）在远程轮询 JSONL 文件，通过同一隧道 POST 状态变化。在远程启动：`node ~/.claude/hooks/codex-remote-monitor.js --port 23333`

远程 hook 以 `CLAWD_REMOTE` 模式运行，跳过 PID 采集（远程 PID 在本地无意义）。远程会话不支持终端聚焦。

> 感谢 [@Magic-Bytes](https://github.com/Magic-Bytes) 提出 SSH 隧道方案（[#9](https://github.com/rullerzhou-afk/clawd-on-desk/issues/9)）。

## WSL（Windows Subsystem for Linux）

> 本节的主线是 Claude Code / 其他 hook 型 agent 的 WSL 配置。关于 `Codex CLI + WSL` 的官方支持现状、Windows hooks 状态、以及 Clawd 当前为什么默认扫不到 WSL Linux home 下的 Codex 日志，见：[codex-wsl-clarification.zh-CN.md](codex-wsl-clarification.zh-CN.md)

如果你在 WSL 里跑 Claude Code，而 Clawd 跑在 Windows 宿主上，hook 可以直接 POST 到 `127.0.0.1:23333` —— 不需要 SSH 隧道，因为 WSL2 默认与 Windows 共享 localhost。

**配置步骤：**

```bash
# 在 WSL shell 中执行：
mkdir -p ~/.claude/hooks

# 从 Windows 侧的 Clawd 仓库复制 hook 文件（按实际路径调整 /mnt/ 前缀）
cp /mnt/d/animation/hooks/{server-config,json-utils,shared-process,clawd-hook,install}.js ~/.claude/hooks/

# 以远程模式注册 hooks
node ~/.claude/hooks/install.js --remote
```

如果你的 WSL 里开启了 SSH 服务，也可以用一键部署脚本：

```bash
# 从 Windows 侧执行（Git Bash / PowerShell）：
bash scripts/remote-deploy.sh 你的用户名@localhost
```

配置完成后，在 Windows 上启动 Clawd，在 WSL 里运行 Claude Code —— Clawd 会自动感知你的会话。权限气泡也能正常弹出。

> **注意：** WSL2 的 localhost 转发需要 Windows 10 build 18945+（默认开启）。如果不生效，检查 `%USERPROFILE%\.wslconfig` 中 `localhostForwarding=true` 是否被禁用。

### WSL 网络与 Hook 注册（替代方案）

Clawd 跑在 Windows 的 Electron 应用里，而你的 AI 编程助手（Claude Code、Kiro CLI 等）可能跑在 WSL 里。WSL 中的 hook 脚本会把 HTTP 请求发到 `127.0.0.1:23333`，所以 WSL 和 Windows 必须共享同一个 localhost。

- **WSL1** — 开箱即用。WSL1 天然与 Windows 共享 localhost，无需额外配置。
- **WSL2** — 需要镜像网络模式。WSL2 默认拥有独立网络栈，`127.0.0.1` 指向 WSL 自身而不是 Windows。请在 `%USERPROFILE%\.wslconfig` 中启用镜像模式（文件不存在就新建），然后执行 `wsl --shutdown` 重启 WSL：

```ini
[wsl2]
networkingMode=mirrored
```

**在 WSL 中手动注册 hooks：**

Clawd 在 Windows 启动时会自动注册 Claude Code hooks 到 `~/.claude/settings.json`。但如果你的 Agent 跑在 WSL 里，hooks 需要注册到 WSL 自己的 home 目录。请在 WSL 中执行：

```bash
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# Claude Code
node hooks/install.js

# Kiro CLI - 会将 hooks 注册到 ~/.kiro/agents/ 下所有自定义 agent，
# 并自动创建一个 clawd agent
node hooks/kiro-install.js

# Kimi Code CLI（Kimi-CLI）
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

> 提示：如果仓库克隆在 WSL 内（如 `~/clawd-on-desk`），hook 脚本会自动使用 WSL 的 Node.js 路径。如果仓库放在 Windows 盘里（如 `/mnt/c/...`），请确保 WSL 的 PATH 中有 `node`。

## macOS 说明

- **源码运行**（`npm start`）：Intel 和 Apple Silicon 均可直接使用。
- **DMG 安装包**：未签名 Apple 开发者证书，macOS Gatekeeper 会拦截。解决方法：
  - 右键点击应用 → **打开** → 在弹窗中点击 **打开**，或
  - 在终端运行 `xattr -cr /Applications/Clawd\ on\ Desk.app`

## Linux 说明

- **源码运行**（`npm start`）：默认启用 Electron sandbox。如果你的 Linux 开发环境仍然遇到 chrome-sandbox 初始化失败，可临时使用 `CLAWD_DISABLE_SANDBOX=1 npm start` 作为兼容方案。
- **安装包**：AppImage 和 `.deb` 可从 [GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases) 下载。deb 安装后应用图标会出现在 GNOME 应用菜单。
- **终端聚焦**：依赖 `wmctrl` 或 `xdotool`（有一个就行）。安装：`sudo apt install wmctrl` 或 `sudo apt install xdotool`。
- **自动更新**：源码运行时，"检查更新"会执行 `git pull` + `npm install`（依赖有变化时）并自动重启。
