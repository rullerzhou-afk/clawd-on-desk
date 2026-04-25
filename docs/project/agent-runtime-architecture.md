# Agent Runtime Architecture

This document holds the deeper runtime and integration notes that were previously in the root `AGENTS.md`.

## Data Flow

```text
Claude Code 状态同步（command hook，非阻塞）：
  Claude Code 触发事件
    → hooks/clawd-hook.js（零依赖 Node 脚本，stdin 读 JSON 取 session_id + source_pid）
    → HTTP POST 127.0.0.1:23333/state { state, session_id, event, source_pid, cwd }
    → src/server.js 路由 → src/state.js 状态机（多会话追踪 + 优先级 + 最小显示时长 + 睡眠序列）
    → IPC state-change 事件
    → src/renderer.js（<object> SVG 预加载 + 淡入切换 + 眼球追踪）

Copilot CLI 状态同步（command hook，非阻塞）：
  Copilot 触发事件
    → hooks/copilot-hook.js（camelCase 事件名 → agents/copilot-cli.js 映射 → HTTP POST）
    → 同上状态机

Cursor Agent 状态同步（command hook，stdin JSON，非阻塞）：
  Cursor IDE 触发事件
    → hooks/cursor-hook.js（hook_event_name → 映射为 PascalCase event + HTTP POST，stdout 返回 allow/continue 以满足 preToolUse 等 hook）
    → 同上状态机（agent_id: cursor-agent）

Codex CLI 状态同步（JSONL 日志轮询，~1.5s 延迟）：
  Codex 写入 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
    → agents/codex-log-monitor.js（增量读取，事件类型 → agents/codex.js 映射）
    → 同上状态机

Gemini CLI 状态同步（session JSON 轮询，~1.5s 延迟 + 4s 完成延迟窗口）：
  Gemini 写入 ~/.gemini/tmp/<project>/chats/session-*.json
    → agents/gemini-log-monitor.js（轮询 JSON，diff 消息数组检测工具调用/完成）
    → 同上状态机（agent_id: gemini-cli）

Kiro CLI 状态同步（per-agent hook，stdin JSON）：
  Kiro CLI 触发事件
    → hooks/kiro-hook.js（camelCase 事件 → agents/kiro-cli.js 映射 → HTTP POST）
    → 同上状态机（agent_id: kiro-cli）
  注意：Kiro 无 global hooks，hooks/kiro-install.js 把 hook 注入到 ~/.kiro/agents/ 下每个
  custom agent 配置里，并额外维护一个 "clawd" agent（继承 kiro_default，启动时从 kiro_default
  重新同步以避免行为漂移）。内置 kiro_default 没有可编辑 JSON，用户需 `kiro-cli --agent clawd`
  或 `/agent swap clawd` 才能启用 hooks。

CodeBuddy 状态同步（Claude Code 兼容 hook，command）：
  CodeBuddy 触发事件
    → hooks/codebuddy-hook.js（PascalCase 事件 → agents/codebuddy.js 映射 → HTTP POST）
    → 同上状态机（agent_id: codebuddy）
  Hook 注册到 ~/.codebuddy/settings.json，格式与 Claude Code 完全兼容。

Kimi Code CLI（Kimi-CLI）状态同步（hook-only，config.toml）：
  Kimi Code CLI（Kimi-CLI）触发事件
    → hooks/kimi-hook.js（hook 事件 → agents/kimi-cli.js 映射 → HTTP POST）
    → 同上状态机（agent_id: kimi-cli）
  Hook 注册到 ~/.kimi/config.toml 的 [[hooks]] 条目；Clawd 启动时会自动同步这些条目。

opencode 状态同步（in-process plugin，~0ms 延迟）：
  opencode 触发事件（session.created / session.status / message.part.updated 等）
    → hooks/opencode-plugin/index.mjs（Bun 运行时，插件跑在 opencode.exe 进程内）
    → translateEvent 映射（opencode v2 事件名 → PascalCase Clawd event 名）
    → fire-and-forget HTTP POST 127.0.0.1:23333/state
    → 同上状态机（agent_id: opencode）

opencode 权限气泡（event hook + 反向 bridge，非阻塞）：
  opencode 请求权限 → event hook 收到 permission.asked
    → plugin POST /permission（带 bridge_url + bridge_token）→ Clawd 立即 200 ACK（不挂连接）
    → Clawd 创建 bubble 窗口 → 用户 Allow/Always/Deny
    → Clawd POST plugin 的反向 bridge → bridge 用 ctx.client._client.post() 调 opencode 内置 Hono 路由 /permission/:id/reply
    → opencode 执行对应行为（once/always/reject）

远程 SSH 状态同步（反向端口转发）：
  远程服务器上的 Claude Code / Codex CLI
    → hooks 通过 SSH 隧道 POST 到本地 127.0.0.1:23333
    → 同上状态机（CLAWD_REMOTE=1 模式跳过 PID 收集）

权限决策流（Claude Code HTTP hook，阻塞）：
  Claude Code PermissionRequest
    → HTTP POST 127.0.0.1:23333/permission { tool_name, tool_input, session_id, permission_suggestions }
    → main.js 创建 bubble 窗口（bubble.html）显示权限卡片
    → 用户点击 Allow / Deny / suggestion → HTTP 响应 { behavior }
    → Claude Code 执行对应行为
```

## Multi-Agent Registry

每个 agent 定义为一个配置模块，导出事件映射、进程名、能力声明（`capabilities` 含 `httpHook` / `permissionApproval` / `sessionEnd` / `subagent`）：

- `agents/claude-code.js` — Claude Code 事件映射 + 能力（hooks、permission、terminal focus）
- `agents/codex.js` — Codex CLI JSONL 事件映射 + 轮询配置
- `agents/copilot-cli.js` — Copilot CLI camelCase 事件映射
- `agents/cursor-agent.js` — Cursor Agent（hooks.json）事件映射
- `agents/gemini-cli.js` — Gemini CLI 事件映射 + JSON 轮询配置
- `agents/kimi-cli.js` — Kimi Code CLI（Kimi-CLI）hook 事件映射 + permission 分类策略
- `agents/kiro-cli.js` — Kiro CLI 事件映射（camelCase），无 HTTP hook / 无权限 / 无 subagent
- `agents/codebuddy.js` — CodeBuddy 事件映射（PascalCase，Claude Code 兼容），支持权限
- `agents/opencode.js` — opencode 事件映射 + 能力（plugin、permission、terminal focus）
- `agents/registry.js` — agent 注册表：按 ID 或进程名查找 agent 配置
- `agents/codex-log-monitor.js` — Codex JSONL 增量轮询器（文件监视 + 增量读取 + 事件去重）
- `agents/gemini-log-monitor.js` — Gemini session JSON 轮询器（消息数组 diff + 4s 完成延迟窗口）

运行时的 agent 启停 / 权限气泡开关通过 `src/agent-gate.js` 读 `prefs.agents[id].enabled` / `.permissionsEnabled`（默认 true，snapshot 缺字段时也 true 以兼容旧版），供 `state.js` 和 `server.js` 判断是否处理该 agent 的事件。

## Hook And Plugin Sync

启动链路会自动补齐缺失集成：

- `main.js` 会先调用 `registerHooks({ silent: true, autoStart: true, port })`
- `server.js` 启动后异步同步 Claude / Gemini / Cursor / CodeBuddy / Kiro / Kimi hooks 和 opencode plugin
- Claude hook 同步时还会扫 `DEPRECATED_CORE_HOOKS`（当前含 `WorktreeCreate`）清掉旧版本留下的过时 clawd hook 条目，仅删 command 指向 `clawd-hook.js` 的那条，用户自己写的同事件 hook 不动

手动安装命令主要用于调试、重装或远程机部署。

## Permission Bubble

- PermissionRequest 必须用 HTTP hook（阻塞式），其他事件用 command hook（非阻塞式）
- `POST /permission` 接收 `{ tool_name, tool_input, session_id, permission_suggestions }`
- 每个权限请求都会创建独立 `BrowserWindow`，多个 bubble 从右下向上堆叠
- bubble 会通过 IPC `bubble-height` 回报真实高度，主进程据此重排
- 支持 Allow / Deny / suggestion 决策，以及 `addRules` / `setMode` suggestion 类型
- DND 只负责“不弹 bubble”，不替用户决定权限：opencode 分支 silent drop，让 TUI 内置权限提示接管；Claude Code 分支 `res.destroy()`，让 CC 回到内置聊天/终端确认
- Codex CLI 没有阻塞式 HTTP hook，只能通过 JSONL 检测 approval 请求并显示通知 bubble
- 涉及 Claude Code 权限 payload 的改动（`permission_suggestions`、`updatedPermissions`、elicitation 输入等）必须至少用一次真实 Claude Code 验证；`curl` 自编请求历史上掩盖过字段结构 bug

## Opencode Notes

opencode 是唯一以 plugin 形式集成的 agent，其他 agent 都是 hook 脚本。

- 进程树 walk 从 `process.pid` 起步，不是 `ppid`
- `task` 工具会直接新建 session，而不是产出 subtask part，所以多会话建筑动画天然成立
- 只有 root session 的 `session.idle` 才映射 `attention/Stop`；子 session 的 idle 会降级为 `sleeping/SessionEnd`
- 由于 `permission.ask` hook 在 opencode 1.3.13 上未被调用，权限只能走 event hook + 反向 bridge
- plugin 内发出的 POST 必须 fire-and-forget，避免拖慢 TUI
- 打包后需要把 `app.asar/` 重写为 `app.asar.unpacked/`

## Terminal Focus And Remote

- hook 脚本通过 `getStablePid()` 遍历进程树定位终端应用 PID（Windows Terminal、VS Code、iTerm2 等）
- 不要用 `process.ppid` 做轻量替代：Claude Code / hook 进程链里它通常只是临时 shell PID，不稳定也不可持久化
- `source_pid` 跟随状态更新送到 `main.js`，用于 Sessions 菜单聚焦
- 右键 Sessions 子菜单点击后，`focusTerminalWindow()` 会用 PowerShell（Windows）或 `osascript`（macOS）聚焦终端
- 远程场景通过 `scripts/remote-deploy.sh` + SSH 反向端口转发，把远端 hook 事件回送到本地 Clawd

## Context Menu Owner Window

- `contextMenuOwner` 必须保留 `parent: win`；没有 parent 再配 `closable: false` 会导致 `app.quit()` 无法正常收尾
- 退出路径依赖 `requestAppQuit()` 先把 `isQuitting = true`，再让 `window-all-closed` 真正走到退出分支；不要绕开这套守卫

## Updating

- Git 模式（非打包，主要是 macOS/Linux 源码运行）会 `git fetch` 比较 HEAD，有更新则 `git pull` + 必要时 `npm install`，然后 `app.relaunch()`
- Windows NSIS 打包模式走 `electron-updater`
- 托盘菜单里的 “Check for Updates” 可以手动触发

## i18n

- 支持 en / zh / ko
- 文案集中在 `src/i18n.js`
- 语言偏好持久化到 `clawd-prefs.json`，启动时通过 `hydrate()` 灌入 controller
