# Copilot CLI Hook 配置

[返回 README](../../README.zh-CN.md) · [English](copilot-setup.md)

> **从 v0.8.x 起 Clawd 默认自动同步 Copilot CLI hooks**——启用 Copilot CLI agent 后无需手动配置，Clawd 启动时会把 `copilot-hook.js` 写入 `<COPILOT_HOME 或 ~/.copilot>/hooks/hooks.json`（marker-based 增量合并，不会覆盖用户其他 hook）。
>
> 本文档保留作为**高级/手动备选**：调试、定制事件子集、离线参考、或测试 Clawd 行为时用。

## 自动同步行为速览

- **触发**：Clawd 启动 + 在 Settings 启用 Copilot CLI agent。
- **目标文件**：`<copilot-home>/hooks/hooks.json`，其中 `<copilot-home>` = `$COPILOT_HOME`（trimmed 非空）或 `~/.copilot`。
- **注册的事件（10 个）**：`sessionStart` / `userPromptSubmitted` / `preToolUse` / `postToolUse` / `sessionEnd` / `errorOccurred` / `agentStop` / `subagentStart` / `subagentStop` / `preCompact`。
- **覆盖范围**：只接管含 `copilot-hook.js` marker 的 entry；用户其他 entry / 其他 `hooks/*.json` 文件原样保留。
- **`disableAllHooks`**：若 `hooks.json` 或 `<copilot-home>/settings.json` 顶层有 `disableAllHooks: true`，doctor 会报 warning 且不挂 Fix 按钮（避免覆盖用户意图）；自动 sync 仍会写入条目，但 Copilot 不会执行。

## 手动配置（备选）

创建 `<copilot-home>/hooks/hooks.json` 并替换 `/path/to/clawd-on-desk` 为实际安装路径：

```json
{
  "version": 1,
  "hooks": {
    "sessionStart":         [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js sessionStart",         "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js sessionStart",         "timeoutSec": 5 }],
    "userPromptSubmitted":  [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js userPromptSubmitted",  "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js userPromptSubmitted",  "timeoutSec": 5 }],
    "preToolUse":           [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js preToolUse",           "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js preToolUse",           "timeoutSec": 5 }],
    "postToolUse":          [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js postToolUse",          "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js postToolUse",          "timeoutSec": 5 }],
    "sessionEnd":           [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js sessionEnd",           "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js sessionEnd",           "timeoutSec": 5 }],
    "errorOccurred":        [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js errorOccurred",        "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js errorOccurred",        "timeoutSec": 5 }],
    "agentStop":            [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js agentStop",            "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js agentStop",            "timeoutSec": 5 }],
    "subagentStart":        [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js subagentStart",        "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js subagentStart",        "timeoutSec": 5 }],
    "subagentStop":         [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js subagentStop",         "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js subagentStop",         "timeoutSec": 5 }],
    "preCompact":           [{ "type": "command", "bash": "node /path/to/clawd-on-desk/hooks/copilot-hook.js preCompact",           "powershell": "node /path/to/clawd-on-desk/hooks/copilot-hook.js preCompact",           "timeoutSec": 5 }]
  }
}
```

`bash` / `powershell` 字段是 Copilot CLI 的官方平台分发机制（参考 [Copilot Hooks Reference](https://docs.github.com/en/copilot/reference/hooks-configuration)）。Copilot 加载 `<copilot-home>/hooks/*.json` 所有 `.json` 文件并 merge，用户可任意命名（如 `clawd.json` / `my-team.json`）；Clawd 选择管理 `hooks.json` 这一个。

## `COPILOT_HOME` 自定义目录

Copilot CLI 支持 `COPILOT_HOME` 环境变量重定向整个配置目录（参考 [Config Directory Reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)）。Clawd 在启动时读取这个 env：

- **Windows**：系统级环境变量自动被 Clawd 看到；用户级在重启后看到。
- **macOS / Linux GUI 启动**：launchd / Finder 启动的 Clawd.app **不继承**用户 shell `.zshrc` / `.bashrc` 设的 env。如要 Clawd 看到 `COPILOT_HOME`：
  - macOS：`launchctl setenv COPILOT_HOME /your/path` 后重启 Clawd
  - Linux：在 `~/.profile` / `/etc/environment` / desktop entry 里设置
- **运行时变更**：descriptor 缓存 doctor 显示路径，改 env 后需重启 Clawd 才能让 doctor 显示新路径；实际 sync 写入会读最新 env，但与 doctor 路径不一致时容易误导。

## Remote SSH

`scripts/remote-deploy.sh user@host` 会自动注册 Copilot CLI hooks：`copilot-hook.js` 复制到远端 `~/.claude/hooks/`，远端 `~/.copilot/hooks/hooks.json` 注册（与 Claude Code / Codex CLI 一致）。无需手动步骤。

若远端未装 Copilot CLI（`~/.copilot/` 缺失），注册步骤跳过并打 warning，部署其余流程继续。

## Session rename

Copilot CLI 把当前会话名存在 `<copilot-home>/session-state/<sessionId>/workspace.yaml`（`name:` 字段）。`copilot-hook.js` 每次事件触发时读该文件，把名字作为会话标题转发给 Clawd，所以 Copilot 里 `/rename` 之后下一次 hook 事件（下条用户消息、tool 运行等）会把新名同步到 Session HUD 和 Dashboard。`COPILOT_HOME` 环境变量也会被 session-state resolver 识别。

自动生成的名字（`user_named: false`）按现状使用，与 Codex thread-name 行为一致。
