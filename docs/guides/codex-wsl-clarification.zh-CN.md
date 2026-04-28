# Codex + WSL 现状说明

最后核实日期：2026-04-26

这份说明专门澄清三个经常被混在一起的问题：

1. OpenAI 官方是否支持 Codex 跑在 WSL 里。
2. Codex hooks 和 `.codex` 状态是否会在 Windows 与 WSL 之间自动共享。
3. Clawd 当前是否能自动感知“跑在 WSL 独立 Linux home 里的 Codex 会话”。

这三件事的答案分别不同。如果不拆开说，很容易把“官方支持 WSL2”和“Clawd 当前默认能不能识别 WSL 里的日志”误听成同一件事。

## TL;DR

- OpenAI 官方支持 Codex 跑在 WSL2 里。
- OpenAI 官方 Hooks 文档当前把 Codex hooks 描述为通过 `[features].codex_hooks = true` 开启的 feature flag。
- Clawd 当前以 Codex official hooks 为主，继续保留 `~/.codex/sessions` JSONL 轮询作为 fallback。
- 2026-04-26 本地已验证 Windows native Codex hooks 可用；Windows hook command 必须使用 PowerShell 的 `&` 调用形式。
- 当 Clawd 跑在 Windows、Codex 跑在 WSL 且仍使用 Linux 默认 home 时，Clawd 默认不会扫到 WSL 里的 `/home/<user>/.codex/sessions`。
- 所以“Codex 不支持 WSL”这个说法不准确。更准确的说法是：“Codex 官方支持 WSL2，但 Windows 上的 Clawd 不会自动修改或轮询 WSL 独立 Linux `~/.codex`；如果希望 WSL 内的 Codex 会话回传，需要在 WSL 里以 remote mode 安装 hooks，或共享 `CODEX_HOME`。”

## 一、OpenAI 官方现状

### 1. Codex 官方支持 WSL2

OpenAI 官方 Windows 文档有单独的 WSL 章节，并且直接给了在 WSL2 中安装和运行 Codex CLI 的步骤：

- 官方文档：<https://developers.openai.com/codex/windows>
- 关键信息：
  - 有 `Windows Subsystem for Linux` 章节。
  - 有 `Use Codex CLI with WSL` 章节。
  - 明确给出 `wsl --install`、在 WSL 里安装 Node.js、`npm i -g @openai/codex`、再运行 `codex` 的流程。

这意味着，从 OpenAI 官方产品层面看，`Codex 支持 WSL2` 是成立的。

### 2. WSL1 已不再支持

OpenAI 官方 Windows 文档同时写明：

- WSL1 支持截止到 Codex `0.114`
- 从 Codex `0.115` 起，由于 Linux sandbox 切到 `bubblewrap`，WSL1 不再支持

参考：

- <https://developers.openai.com/codex/windows>
- <https://developers.openai.com/codex/app/windows>

所以现在准确说法应是“支持 WSL2”，而不是笼统地说“支持 WSL”。

### 3. Codex hooks 仍是 feature flag

OpenAI 官方 Hooks 文档当前写明 hooks 通过下面的 feature flag 开启：

```toml
[features]
codex_hooks = true
```

同一份文档还定义了 `hooks.json`、通用输入字段、`PermissionRequest`、`tool_input.description`，以及当前 `PermissionRequest` 输出里不支持字段会 fail-closed 的行为。

参考：

- <https://developers.openai.com/codex/hooks>

Clawd 的 Codex installer 会写入 `~/.codex/hooks.json`，并在用户没有显式设置 `codex_hooks = false` 时开启这个 feature flag；如果用户主动设置为 false，Clawd 只给 warning，不强行翻转。

### 4. WSL 和 Windows 默认不会共享 `.codex`

OpenAI 官方 Windows app 文档还明确说明了另一个关键点：

- Windows app 使用 `%USERPROFILE%\.codex`
- 如果在 WSL 里跑 Codex CLI，默认会使用 Linux home 下的 `~/.codex`
- 因此它不会自动和 Windows app 共享 configuration、cached auth、session history
- 官方给出的共享方案之一是直接在 WSL 里设置：

```bash
export CODEX_HOME=/mnt/c/Users/<windows-user>/.codex
```

参考：

- <https://developers.openai.com/codex/app/windows>

这说明“WSL 里 Codex 的日志默认写到 Linux home”并不是猜测，而是官方文档已经明确说过的默认行为。

## 二、Clawd 当前实现现状

### 1. Clawd 以 official hooks 为主，JSONL 轮询兜底

当前仓库里，Codex 适配配置写在 [`agents/codex.js`](../../agents/codex.js)：

- `eventSource: "hook+log-poll"`
- `sessionDir: "~/.codex/sessions"`

Official hook 实现在 [`hooks/codex-hook.js`](../../hooks/codex-hook.js)，fallback 监控实现写在 [`agents/codex-log-monitor.js`](../../agents/codex-log-monitor.js)。

运行时：

- official hooks 处理 SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse 和 Stop
- PermissionRequest 默认使用 native 模式：Clawd 只观察事件并返回 no-decision，让 Codex AutoReview / 原生审批继续接管；用户显式切到 intercept 后才会弹出真正的 Clawd Allow/Deny 气泡。
- JSONL 轮询仍保留，用于 hook 被禁用的会话，以及 WebSearch、context compaction、turn aborted 等 official hooks 未覆盖事件

Fallback 监控会把 `~` 展开成当前进程自己的 `os.homedir()`。也就是说：

- 如果 Clawd 跑在 Windows，默认扫的是 `C:\Users\<user>\.codex\sessions`
- 如果 Clawd 跑在 Linux，默认扫的是 `/home/<user>/.codex/sessions`

因此，Windows 上运行的 Clawd 不会自动扫到 WSL Linux home 下的 `/home/<user>/.codex/sessions`。

### 2. Clawd 当前没有自动“安装到 WSL home”的逻辑

当前主进程会为宿主机自己的 home 同步 Codex official hooks，并启动 fallback 轮询。它没有面向用户的 WSL session 目录配置入口，没有默认扫描 `\\wsl$\...`，也不会从 Windows app 自动编辑 `/home/<user>/.codex/hooks.json`。

这意味着：

- `Codex native Windows + Clawd on Windows`：official hooks 开箱即用，JSONL 轮询兜底
- `Codex in WSL2 + Clawd on Windows + Linux 默认 home`：默认不通，除非在 WSL 里以 remote mode 安装 hooks，或启动远端 fallback monitor
- `Codex in WSL2 + 共享到 Windows 的 .codex`：按官方 `CODEX_HOME` 方案推导，可以共享配置和 session 状态

最后这一条是根据 OpenAI 官方的 `CODEX_HOME` 共享方案和 Clawd 当前 hook / fallback 轮询行为推导出的结论。

### 3. Clawd 仓库里有远程/旁路方案，但不是 WSL 开箱即用方案

仓库里已有 [`scripts/remote-deploy.sh`](../../scripts/remote-deploy.sh)，会复制 Codex hook 文件，在远端执行 `node ~/.claude/hooks/codex-install.js --remote`，让 official hooks 通过 SSH 反向隧道带着 `CLAWD_REMOTE=1` POST 回本地 Clawd。

仓库里也保留 [`hooks/codex-remote-monitor.js`](../../hooks/codex-remote-monitor.js)，它会在另一端轮询 `~/.codex/sessions`，再把状态 POST 回本地 Clawd，用于 official hooks 不可用或被禁用时的 fallback。

这个方案当前在文档里主要用于“远程 SSH 模式”，见 [`docs/guides/setup-guide.zh-CN.md`](./setup-guide.zh-CN.md)。

它说明仓库作者已经考虑过“日志在另一端、状态要回传”的场景，但这不等于“Windows 上的 Clawd 已经原生支持 WSL 里的 Codex 会话自动发现”。

## 三、为什么现在的文档会让人误解

### 1. README 的说法容易让人默认联想到“所有 WSL 组合都覆盖了”

中文 README 当前写的是：

- “**Claude Code** 和 **Codex CLI** 开箱即用”
- setup guide “也涵盖远程 SSH、WSL 及平台说明”

参考：

- [`README.zh-CN.md`](../../README.zh-CN.md)

这句话对很多场景是成立的，但没有把“Codex native Windows”和“Codex in WSL2 + 独立 Linux home”区分开来。

### 2. setup guide 的 WSL 章节正文主要在讲 Claude Code

当前中文 setup guide 的 WSL 章节从 [`docs/guides/setup-guide.zh-CN.md`](./setup-guide.zh-CN.md) 开始，正文写的是：

- 在 WSL 里跑 Claude Code
- 在 WSL 里复制 hooks
- 在 WSL 里注册 Claude hooks

而 `Codex CLI` 在这份文档里主要出现在“远程 SSH 模式”部分，通过 `codex-remote-monitor.js` 的方式出现。

结果就是：

- 文档不是完全没提 WSL
- 但文档没有把“Codex + WSL”的支持边界单独讲透
- 读者很容易读完后得出两种相反误解：
  - “是不是文档没写，所以其实不支持”
  - “既然 README 说涵盖 WSL，那 Codex in WSL 应该也开箱即用”

这两种理解都不够准确。

## 四、目前最准确的结论

截至 2026-04-26，更准确的结论是：

1. OpenAI 官方支持 Codex 跑在 WSL2 里。
2. OpenAI 官方把 Codex hooks 记录为 `codex_hooks` feature flag。
3. Clawd 以 Codex official hooks 为主，JSONL 日志轮询为 fallback。
4. Clawd 当前同步 hooks 和 fallback 轮询的目标都是宿主机自己的 `.codex` home。
5. 所以当 Codex 运行在 WSL2 且仍使用 Linux 默认 `~/.codex` 时，Windows Clawd 默认不会自动发现这些会话。
6. 当前文档的主要问题不是“完全没写 WSL”，而是“没有把 Codex + WSL 的边界讲清楚”。

## 五、建议对外表述

如果需要给用户、粉丝或 issue 里的人一个最不容易误解的说法，建议用下面这段：

> OpenAI 官方支持 Codex 跑在 WSL2 里。Clawd 现在通过 Codex official hooks 集成，并保留 JSONL 轮询作为 fallback。如果 Clawd 跑在 Windows、Codex 跑在 WSL 且使用 Linux 默认 home，Clawd 不会自动修改或轮询那份 WSL `~/.codex`；需要在 WSL 里以 remote mode 安装 hooks、共享 `CODEX_HOME`，或运行远端 fallback monitor。当前问题更像是 Clawd 的集成边界和文档没有讲清楚，而不是 Codex 官方不支持 WSL。

## 六、当前可行路径

如果目标是“让 Windows 上的 Clawd 感知 WSL 里的 Codex”，目前可考虑的路径有三类：

1. 按 OpenAI 官方文档，在 WSL 中把 `CODEX_HOME` 指到 Windows 的 `%USERPROFILE%\.codex`。
2. 在 WSL 里执行 `node hooks/codex-install.js --remote`，让 Codex official hooks 通过 WSL localhost 转发回 Windows Clawd。
3. 参考仓库现有的 [`hooks/codex-remote-monitor.js`](../../hooks/codex-remote-monitor.js) 思路，把 WSL 视作“另一端”，主动把状态回传给 Windows 上的 Clawd。
4. 修改 Clawd 自己的 Codex sessionDir 解析逻辑，显式支持 `\\wsl$\...` 路径。

其中：

- 第 1 条是 OpenAI 官方给出的共享方案。
- 第 2 条是 Codex hooks 可用时 Clawd 延迟最低的路径。
- 第 3 条是 official hooks 不可用或被禁用时的 fallback。
- 第 4 条属于 Clawd 侧新增功能，不是当前默认行为。

## 参考资料

OpenAI 官方文档：

- Codex Windows: <https://developers.openai.com/codex/windows>
- Codex Hooks: <https://developers.openai.com/codex/hooks>
- Codex app on Windows: <https://developers.openai.com/codex/app/windows>

仓库内相关文件：

- [`README.zh-CN.md`](../../README.zh-CN.md)
- [`docs/guides/setup-guide.zh-CN.md`](./setup-guide.zh-CN.md)
- [`agents/codex.js`](../../agents/codex.js)
- [`agents/codex-log-monitor.js`](../../agents/codex-log-monitor.js)
- [`hooks/codex-hook.js`](../../hooks/codex-hook.js)
- [`hooks/codex-install.js`](../../hooks/codex-install.js)
- [`hooks/codex-remote-monitor.js`](../../hooks/codex-remote-monitor.js)
