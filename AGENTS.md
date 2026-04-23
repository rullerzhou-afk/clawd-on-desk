# AGENTS.md

This file is the entry point for coding agents working in this repository. Keep it short and operational. Deep background lives in `docs/project/`.

## Project Overview

Clawd 是一个 Electron 桌宠：通过 hook、日志轮询和 plugin 感知 AI coding agent 的工作状态，并播放像素风动画。当前支持 Claude Code、Codex CLI、Copilot CLI、Cursor Agent、Gemini CLI、Kiro CLI、CodeBuddy、opencode；内置 Clawd / Calico 两套主题，支持用户主题；平台覆盖 Windows、macOS、Linux，UI 支持 en / zh / ko。

## Common Commands

```bash
npm start
npm run build
npm run build:mac
npm run build:linux
npm run build:all
npm install
npm test
npm run create-theme

npm run install:claude-hooks
npm run uninstall:claude-hooks
npm run install:cursor-hooks
npm run install:gemini-hooks
npm run install:kiro-hooks
node hooks/codebuddy-install.js
node hooks/opencode-install.js

bash scripts/remote-deploy.sh user@host
bash test-demo.sh [seconds]
bash test-mini.sh [seconds]
bash test-macos.sh
bash test-oneshot-gate.sh [state] [seconds]
```

正常启动时，Clawd 会自动同步 Claude / Gemini / Cursor / CodeBuddy / Kiro hooks 和 opencode plugin。手动安装命令主要用于调试、重装或远程部署。
Copilot CLI 是唯一仍需手动配置 hooks 的受支持 agent；见 `docs/guides/copilot-setup.md`。

## Read These Docs

- `docs/project/project-introduction.md`：5 分钟了解项目定位、状态映射和目录结构
- `docs/project/agent-runtime-architecture.md`：集成方式、数据流、多 agent、permission bubble、opencode、终端聚焦、自动同步
- `docs/project/project-architecture.md`：更完整的模块边界和启动/运行时分层
- `docs/project/theme-state-ui.md`：状态机、主题系统、settings、mini mode、素材规则、平台限制
- `docs/guides/copilot-setup.md`：Copilot CLI 手动 hook 配置
- `docs/guides/state-mapping.md`：状态 → 动画权威表
- `docs/guides/guide-theme-creation.md`：主题作者指南
- `docs/guides/setup-guide.md`：安装、远程 SSH、各 agent 接入
- `docs/guides/known-limitations.md`：用户向已知限制
- `docs/guides/codex-wsl-clarification.md`：Codex / WSL 路径与 Node 说明

## Runtime Summary

- 事件主路径：hook / log monitor → `src/server.js` → `src/state.js` → IPC → `src/renderer.js`
- 桌宠采用双窗口模型：渲染窗口只负责显示；输入窗口负责 pointer 事件和拖拽
- `src/server.js` 启动后会异步同步缺失 hooks / plugins
- `src/server.js` 还会 watch `~/.claude/settings.json` 被外部工具覆盖的场景，并在 hook 被抹掉时自动重装
- `src/agent-gate.js` 控制各 agent 的启用状态和权限气泡开关
- 设置系统主链路是 `src/prefs.js` → `src/settings-controller.js` → `src/settings-store.js`
- 启动时还会尝试自动安装 VS Code / Cursor terminal-focus extension，并初始化 updater
- 远程场景依赖 `scripts/remote-deploy.sh` 和 SSH 反向端口转发

## Core Files

更细的背景见 `docs/project/agent-runtime-architecture.md` 和 `docs/project/theme-state-ui.md`。

| File | Responsibility |
|------|------|
| `src/main.js` | Electron 主进程胶水，窗口、IPC、生命周期、上下文组装 |
| `src/server.js` | `/state`、`/permission`、端口发现、hook/plugin 自动同步 |
| `src/state.js` | 状态机、多会话合并、优先级、自动回退、睡眠/DND |
| `src/renderer.js` | 动画切换、SVG 预加载、眼球追踪渲染 |
| `src/permission.js` | 权限气泡创建、堆叠、决策回包 |
| `src/theme-loader.js` | 主题加载、能力校验、变体 merge、SVG 消毒 |
| `src/prefs.js` | 偏好 schema、load/save/migrate/validate，设置持久化入口 |
| `src/settings-controller.js` | 设置系统唯一写入者 |
| `src/settings-store.js` | 不可变 snapshot store |
| `src/settings-renderer.js` | Settings UI 主逻辑 |
| `src/menu.js` | 托盘 / 右键菜单，串起设置、语言、mini mode、更新入口 |
| `src/mini.js` | 极简模式入场、滑动、peek、状态映射 |
| `src/tick.js` | 主循环、鼠标轮询、眼球和 idle/sleep 逻辑 |
| `src/drag-position.js` | 拖拽落点规范化与跨显示器钳制 |
| `src/visible-margins.js` | 可视角色边距与 edge pinning 规则 |
| `src/updater.js` | Git 模式 / `electron-updater` 双路径更新逻辑 |
| `src/focus.js` | 终端聚焦 |
| `src/hit-renderer.js` + `src/hit-geometry.js` | 输入窗口命中、拖拽、连击反应 |
| `agents/registry.js` | agent 注册表 |
| `agents/codex-log-monitor.js` | Codex JSONL 轮询 |
| `agents/gemini-log-monitor.js` | Gemini session JSON 轮询 |
| `hooks/clawd-hook.js` + `hooks/copilot-hook.js` | Claude Code / Copilot CLI 状态上报脚本 |
| `hooks/install.js` | Claude hook 注册 / 卸载 |
| `hooks/auto-start.js` | Claude `SessionStart` 自动拉起 Clawd 的 hook |
| `hooks/cursor-install.js` / `gemini-install.js` / `kiro-install.js` / `codebuddy-install.js` / `opencode-install.js` | 各 agent 集成安装逻辑 |
| `hooks/codex-remote-monitor.js` | 远程 Codex JSONL 轮询并通过 SSH 隧道回传 |
| `extensions/vscode/extension.js` | VS Code / Cursor 终端 tab 聚焦辅助扩展 |

## Constraints

- Claude Code / CodeBuddy 的阻塞式权限审批走 `POST /permission` HTTP hook；普通状态事件走 command hook
- hook 脚本只允许依赖 Node 内置模块，以及同目录的 `server-config.js`、`shared-process.js`、`json-utils.js`
- hook 脚本需要稳定终端 PID 时，必须走 `getStablePid()` 进程树解析；不要用 `process.ppid` 做简化替代
- opencode 权限不走 `permission.ask` hook，而是 event hook + reverse bridge
- HTTP 服务端口范围固定为 `127.0.0.1:23333-23337`；运行时端口写入 `~/.clawd/runtime.json`
- 注册 Claude Code hook 时只能追加，不能覆盖用户已有 hook 数组
- Copilot CLI 是唯一不自动同步的 agent；仅支持手动配置 `~/.copilot/hooks/hooks.json`
- 资源路径统一用 `path.join(__dirname, ...)`
- 需要编辑发布素材时，先复制到 `assets/source/` 再改，不要直接改工作素材来源不明的文件
- 主题状态、sleep/DND、mini mode、状态映射的细节在 `docs/project/theme-state-ui.md`
- Settings 体系里，store 是唯一真相，controller 是唯一写入者；不要绕开 `settings-controller.js`

## Testing

- 自动化测试使用 Node 内置 test runner：`npm test`
- 当前 `test/*.test.js` 已覆盖 hooks/installers、agent registry、server state/permission 路由、state、theme-loader / overrides、settings、menu、tick、update bubble、updater、remote-deploy、work-area / visible margins 等纯逻辑模块
- 当前开发环境是 Windows-first；macOS 特定路径无法在这里手动 QA，改到 mac 逻辑时要用 code-review-first 的方式说明行为变化和残余风险
- 涉及 Claude Code hook payload 的改动（尤其 `/permission`、`permission_suggestions`、`updatedPermissions`、elicitation 输入）至少用一次真实 Claude Code 验证；`curl` 自编 payload 不够
- 透明窗口、托盘、真实拖拽、跨平台前台聚焦等 Electron 行为仍以手动验证为主

## High-Risk Gotchas

- `hitWin.focusable = true` 是修复 Windows 拖拽 bug 的关键，不要轻易改回去
- `miniTransitioning` 期间，所有窗口定位路径都必须先检查保护标志，否则 `setPosition()` 可能并发崩
- DND 会屏蔽 hook 事件并压住 bubble，但**不应替用户做权限决定**：opencode 走 silent drop 回到 TUI 提示，Claude Code / CodeBuddy 走断连回到内置聊天/终端确认
- `mini-working` 是可选主题能力，缺失时必须优雅降级
- `contextMenuOwner` 必须保留 `parent: win`；配合 `closable:false` 才不会把退出流程卡死
- Windows 前台窗口锁依赖 ALT trick + `koffi` FFI；相关回归通常不是单点逻辑 bug
- `~/.claude/settings.json` 的 hook 恢复 watcher 必须盯目录而不是文件；原子替换会让文件级 watch 在 Windows 上静默失效
- opencode 的 `permission.ask` hook 目前不可用，权限只能走 event hook + bridge
- Codex CLI 只有 JSONL 轮询，约 1.5s 延迟，且 Windows 下 hooks 被 Codex 禁用
- Kiro 没有 global hooks，只能注入到 `~/.kiro/agents/*.json`
- `src/renderer.js` 里给 `<img>` SVG 追加的 `?_t=` cache-bust query 不能删；Chromium 会复用同 URL SVG 的动画时间线，一次性动画会停在末帧

## Do Not Revisit

Language 子菜单底部截断是 Electron 透明窗口 + Windows DWM 的底层兼容问题。不要再尝试通过切换 `alwaysOnTop`、透明窗策略或 JS 菜单布局修它。
