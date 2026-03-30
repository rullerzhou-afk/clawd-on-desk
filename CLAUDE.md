# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Clawd 桌宠 — 一个 Electron 桌面宠物，通过 hook 系统和日志轮询实时感知 AI coding agent 的工作状态并播放对应的像素风 SVG 动画。支持 **Claude Code**（command + HTTP hook）、**Codex CLI**（JSONL 日志轮询）、**Copilot CLI**（command hook）三个 agent 同时运行。支持 Windows、macOS 和 Linux。

## 常用命令

```bash
npm start              # 启动 Electron 应用（开发模式）
npm run build          # electron-builder 打包 Windows NSIS 安装包
npm run build:mac      # electron-builder 打包 macOS DMG（x64 + arm64）
npm run build:linux    # electron-builder 打包 Linux AppImage + deb
npm run build:all      # 同时打包 Windows + macOS + Linux
npm install            # 安装依赖（electron + electron-builder）
node hooks/install.js  # 注册 Claude Code hooks 到 ~/.claude/settings.json
npm test               # 运行单元测试（node --test test/*.test.js）
```

手动测试状态切换：
```bash
curl -X POST http://127.0.0.1:23333/state \
  -H "Content-Type: application/json" \
  -d '{"state":"working","svg":"clawd-working-building.svg"}'
```

Shell 测试脚本（仅开发用，不随仓库分发）：
```bash
bash test-demo.sh [秒] # 逐个播放所有 SVG 动画（默认每个 8 秒）
bash test-mini.sh [秒] # 逐个播放极简模式 SVG 动画（默认每个 6 秒）
bash test-sleep.sh     # 缩短睡眠超时快速测试睡眠序列
bash test-bubble.sh    # 发送模拟权限请求测试气泡堆叠
bash test-macos.sh     # macOS 适配测试（需先 npm start）
```

单元测试覆盖 agents/、hook 注册和端口发现逻辑（`test/registry.test.js`、`test/codex-log-monitor.test.js`、`test/install.test.js`、`test/server-config.test.js`），使用 Node.js 内置 test runner。Electron 主进程（状态机、窗口、托盘）无自动化测试，依赖手动 + shell 脚本验证。

## 架构与数据流

```
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

Codex CLI 状态同步（JSONL 日志轮询，~1.5s 延迟）：
  Codex 写入 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
    → agents/codex-log-monitor.js（增量读取，事件类型 → agents/codex.js 映射）
    → 同上状态机

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

### 双窗口架构（输入/渲染分离）

桌宠使用两个独立的顶层窗口：
- **渲染窗口（win）**：透明大窗口，永久 `setIgnoreMouseEvents(true)`（click-through），只负责显示 SVG 动画和眼球追踪
- **输入窗口（hitWin）**：小矩形窗口，`transparent: true` + `setShape` 覆盖 hitbox 区域，`focusable: true`，永久 `setIgnoreMouseEvents(false)`，接收所有 pointer 事件

输入事件流：hitWin renderer → IPC → main（移动两个窗口 + relay）→ renderWin renderer（播放反应动画）

这个架构解决了 Windows 上的拖拽失效 bug：`WS_EX_NOACTIVATE`（`setFocusable(false)`）+ layered window + Chromium child HWND 的组合，在 z-order 变化后会导致 click 走 WM_MOUSEACTIVATE 激活死路径。分离后输入窗口 `focusable: true` 避免了这个问题。

### 多 Agent 架构（agents/）

每个 agent 定义为一个配置模块，导出事件映射、进程名、能力声明：
- `agents/claude-code.js` — Claude Code 事件映射 + 能力（hooks、permission、terminal focus）
- `agents/codex.js` — Codex CLI JSONL 事件映射 + 轮询配置
- `agents/copilot-cli.js` — Copilot CLI camelCase 事件映射
- `agents/registry.js` — agent 注册表：按 ID 或进程名查找 agent 配置
- `agents/codex-log-monitor.js` — Codex JSONL 增量轮询器（文件监视 + 增量读取 + 事件去重）

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/main.js` | Electron 主进程胶水：窗口创建、ipcMain 分发、ctx 组装、app 生命周期、偏好持久化、屏幕工具、HWND 恢复 |
| `src/state.js` | 状态机核心：setState/applyState、多会话追踪、resolveDisplayState、DND、wake poll、进程存活检测、session submenu |
| `src/server.js` | HTTP 服务：/state（GET 健康检查 + POST 状态更新）、/permission（权限 hook）、端口发现、hook 注册 |
| `src/permission.js` | 权限气泡：BrowserWindow 创建/堆叠/销毁、allow/deny/suggestion 决策、PASSTHROUGH_TOOLS |
| `src/updater.js` | 自动更新：electron-updater 懒加载、GitHub API 版本检查、更新对话框、菜单状态标签 |
| `src/focus.js` | 终端聚焦：持久 PowerShell 进程 + C# FFI（Windows）、osascript 序列化（macOS）、VS Code tab 聚焦 |
| `src/mini.js` | 极简模式：边缘吸附、螃蟹步入场、抛物线跳跃、peek hover、窗口滑动动画 |
| `src/menu.js` | 菜单系统：i18n（en/zh）、右键菜单、系统托盘、contextMenuOwner、语言切换、窗口缩放 |
| `src/tick.js` | 主循环（50ms）：光标轮询、mouseOverPet 计算、mini peek、idle→sleep 序列、眼球位置计算 + dedup |
| `src/renderer.js` | 渲染进程（纯 view）：SVG 切换（预加载防闪烁）、眼球 DOM 挂接、接收 IPC 触发的反应动画 |
| `src/hit.html` | 输入窗口 HTML：透明 + setShape 的小矩形，覆盖 hitbox 区域 |
| `src/hit-renderer.js` | 输入窗口渲染进程：pointer capture、拖拽（delta-based + 节流）、点击检测（多击反应）、右键菜单 |
| `src/preload-hit.js` | 输入窗口 contextBridge（dragLock、moveWindowBy、dragEnd、focusTerminal、reaction triggers、state sync） |
| `src/preload.js` | 渲染窗口 contextBridge（onStateChange、onEyeMove、reaction 接收、pauseCursorPolling） |
| `src/bubble.html` | 权限气泡 UI：工具名 pill + 命令预览 + Allow/Deny 按钮 + suggestion 按钮，支持 light/dark 主题 |
| `src/preload-bubble.js` | bubble 窗口的 contextBridge（permission-show、permission-decide、bubble-height） |
| `hooks/clawd-hook.js` | Claude Code command hook：事件名 → 状态映射 → HTTP POST，零依赖 |
| `hooks/copilot-hook.js` | Copilot CLI command hook：camelCase 事件名，与 clawd-hook.js 相同架构 |
| `hooks/install.js` | 安全注册 hooks 到 settings.json（command + HTTP），逐事件追加不覆盖，导出 `registerHooks()` 供 main.js 启动时自动注册 |
| `hooks/auto-start.js` | SessionStart hook：检测 Electron 是否在运行，未运行则 detached 启动，<500ms 退出 |
| `hooks/server-config.js` | 共享工具：端口常量、运行时配置读写、HTTP helper、服务发现 |
| `hooks/codex-remote-monitor.js` | 远程 Codex 监控：独立守护进程，通过 SSH 隧道轮询 JSONL 日志并 POST 状态变更 |
| `launch.js` | 启动器：清除 `ELECTRON_RUN_AS_NODE` 环境变量后 spawn Electron |
| `extensions/vscode/` | VS Code 扩展（clawd-terminal-focus）：通过 `onUri` 协议聚焦正确的终端 tab |

### 状态机关键机制（state.js）

- **多会话追踪**：`sessions` Map 按 session_id 独立记录状态，`resolveDisplayState()` 取最高优先级
- **状态优先级**：error(8) > notification(7) > sweeping(6) > attention(5) > carrying/juggling(4) > working(3) > thinking(2) > idle(1) > sleeping(0)
- **最小显示时长**：防止快速闪切（error 5s、attention/notification 4s、carrying 3s、sweeping 2s、working/thinking 1s）
- **单次性状态**：attention/error/sweeping/notification/carrying 显示后自动回退（AUTO_RETURN_MS）
- **睡眠序列**：20s 鼠标静止 → idle-look → 60s → yawning(3s) → dozing → 10min → collapsing(0.8s) → sleeping；鼠标移动触发 waking(1.5s) → 恢复
- **DND 模式**：右键菜单 / 托盘"休眠（免打扰）"→ 跳过 dozing 直接 yawning → collapsing → sleeping，屏蔽所有 hook 事件；唤醒后播放 waking 动画
- **working 子动画**：1 个会话 → typing，2 个 → juggling，3+ → building
- **juggling 子动画**：1 个 subagent → juggling，2+ → conducting

### Permission Bubble 系统（permission.js + server.js → bubble.html 渲染）

- **HTTP hook**：PermissionRequest 事件使用 `type: "http"` hook（阻塞，600s 超时），而非 command hook
- **`POST /permission`** 端点接收 `{ tool_name, tool_input, session_id, permission_suggestions }`
- **气泡窗口**：每个权限请求创建独立的 `BrowserWindow`（透明、无边框、alwaysOnTop），加载 `bubble.html`
- **堆叠布局**：多个权限请求从屏幕右下角向上堆叠，`repositionBubbles()` 管理位置
- **动态高度**：bubble 通过 IPC `bubble-height` 上报实际渲染高度，主进程据此精确堆叠
- **决策选项**：Allow（允许）、Deny（拒绝）、suggestion 按钮（如"始终允许"、"自动接受编辑"）
- **客户端断连**：`res.on("close")` 检测 Claude Code 超时或用户在终端回答，自动清理气泡
- **DND 模式**：休眠时自动 deny 所有权限请求，不弹气泡
- **suggestion 格式**：支持 `addRules`（权限规则）和 `setMode`（切换模式）两种类型
- **Codex 通知气泡**：Codex CLI 无法使用阻塞式 HTTP hook，通过 JSONL 日志检测 `exec_approval_request` / `apply_patch_approval_request` 触发通知气泡，仅提供 Dismiss 按钮（无 Allow/Deny），30 秒自动过期

### 终端聚焦系统

- hook 脚本通过 `getStablePid()` 遍历进程树找到终端应用 PID（Windows Terminal、VS Code、iTerm2 等）
- `source_pid` 随状态更新发送到 main.js，存入 session 记录
- 右键菜单 Sessions 子菜单点击 → `focusTerminalWindow()` 用 PowerShell（Win）/ osascript（Mac）聚焦终端窗口
- 通知状态（attention/notification）自动聚焦对应会话的终端

### i18n 国际化

- 支持英文（en）和中文（zh），通过右键菜单 / 托盘菜单 Language 切换
- 语言偏好持久化到 `clawd-prefs.json`
- 权限气泡的按钮文案跟随语言设置

### 自动更新

- 使用 `electron-updater`，Windows 下载安装 NSIS 更新包，macOS 打开 GitHub release 页面
- 托盘菜单"Check for Updates"手动触发，`autoInstallOnAppQuit = true`

### 眼球追踪系统（tick.js 计算 → renderer.js 渲染）

- tick.js 每 50ms（~20fps）轮询光标位置，计算眼球偏移量（MAX_OFFSET=3px，量化到 0.5px 像素网格）
- 通过 IPC `eye-move` 发送 `{dx, dy}` 到 renderer
- renderer 操作 SVG 内部 DOM：`#eyes-js` translate + `#body-js` 轻微偏移 + `#shadow-js` 拉伸
- **dedup 优化**：鼠标未移动时跳过发送；但从 idle-look 返回 idle-follow 时需要 `forceEyeResend` 旁路，否则眼球位置不会重新同步

### 点击反应系统（hit-renderer.js 检测 → main relay → renderer.js 播放）

- 双击 → 戳反应（左/右方向检测，2.5s，react-left/react-right SVG）
- 4 连击 → 双手拍反应（3.5s，react-double SVG）
- 拖拽 → 拖拽反应（持续到松手）
- 拖拽判定：鼠标位移 > 3px（DRAG_THRESHOLD），否则视为点击
- 输入检测在 hitWin，反应动画在 renderWin，通过 main IPC relay
- 反应期间 detach 眼球追踪，结束后 reattach

### 极简模式（Mini Mode）

角色藏在屏幕右边缘，窗口一半推到屏幕外，屏幕边缘自然遮住另一半身体。

**进入方式**：
- 拖拽到右边缘（SNAP_TOLERANCE=30px）→ 快速滑入 + mini-enter 动画
- 右键菜单"Mini Mode" → 螃蟹步走到边缘 → 抛物线跳入 → 探头入场

**核心机制**（mini.js + main.js）：
- `miniMode` 顶层标志，`applyState()` 拦截 notification → mini-alert, attention → mini-happy，其他状态静默
- `miniTransitioning` 过渡保护，螃蟹步/入场期间屏蔽 hook 事件和 peek
- `checkMiniModeSnap()` 遍历所有显示器右边缘 + 中心点 XY 范围检查
- Peek hover：`startMainTick()` 检测 `mouseOverPet` + `currentState === "mini-peek"` 控制滑出/滑回
- `miniIdleNow` 独立于 `idleNow`，仅走眼球追踪，跳过 idle-look/sleep 序列
- 窗口动画：`animateWindowX()`（滑动）+ `animateWindowParabola()`（抛物线跳跃，用 `setPosition()` 避免 DPI 漂移）
- 持久化：`savePrefs()` 存 miniMode/preMiniX/preMiniY，启动时恢复 + Y 轴 clamp

**Mini 状态 → SVG 映射**：
| 状态 | SVG | 用途 |
|------|-----|------|
| mini-idle | clawd-mini-idle.svg | 待机：呼吸+眨眼+手臂晃动+眼球追踪 |
| mini-enter | clawd-mini-enter.svg | 入场：一次性滑入弹跳→手臂伸出→静止 |
| mini-peek | clawd-mini-peek.svg | Hover 探头：快速招手 3 下 |
| mini-alert | clawd-mini-alert.svg | 通知：感叹号弹出 + >< 挤眼 |
| mini-happy | clawd-mini-happy.svg | 完成：花花 + ^^ 眯眼 + 星星 |
| mini-crabwalk | clawd-mini-crabwalk.svg | 右键进入时的螃蟹步 |
| mini-enter-sleep | clawd-mini-enter-sleep.svg | DND 状态下进入 mini 的入场动画 |
| mini-sleep | clawd-mini-sleep.svg | DND 休眠：Zzz + hover 可探头（不唤醒） |

## 状态 → 动画映射

所有 agent 的事件最终映射到相同的状态和动画：

| Agent 事件 | 桌宠状态 | 动画 SVG |
|------------------|---------|----------|
| SessionStart | idle | clawd-idle-follow.svg（眼球追踪） |
| 无活动 | idle | clawd-idle-follow.svg / clawd-idle-living.svg（随机） |
| 20s 鼠标静止 | idle | clawd-idle-look.svg（四处张望） |
| UserPromptSubmit | thinking | clawd-working-thinking.svg |
| PreToolUse / PostToolUse（1 会话） | working | clawd-working-typing.svg |
| PreToolUse / PostToolUse（2 会话） | working | clawd-working-juggling.svg |
| PreToolUse / PostToolUse（3+ 会话） | working | clawd-working-building.svg |
| SubagentStart（1 个） | juggling | clawd-working-juggling.svg |
| SubagentStart（2+） | juggling | clawd-working-conducting.svg |
| SubagentStop | working | （回退到 working 子动画） |
| Stop / PostCompact | attention | clawd-happy.svg |
| PostToolUseFailure / StopFailure | error | clawd-error.svg |
| Notification / Elicitation | notification | clawd-notification.svg |
| PermissionRequest | notification + 权限气泡 | clawd-notification.svg + bubble.html 弹窗 |
| PreCompact | sweeping | clawd-working-sweeping.svg |
| WorktreeCreate | carrying | clawd-working-carrying.svg |
| SessionEnd | sleeping | （触发睡眠序列） |
| 60s 无事件 | sleeping | clawd-sleeping.svg（经 yawning → dozing → collapsing 序列） |
| 鼠标移动唤醒 | waking | clawd-wake.svg（1.5s 后恢复） |
| DND 休眠 | collapsing | clawd-collapse-sleep.svg → clawd-sleeping.svg |

## 素材规则

- 项目使用的 SVG 在 `assets/svg/`（36 个，含 8 个 mini mode），GIF 在 `assets/gif/`（文档展示用）
- 需要编辑的素材复制到 `assets/source/` 再修改
- SVG 用 `<object type="image/svg+xml">` 渲染——因为需要访问 SVG 内部 DOM（眼球追踪），`<img>` 无法做到
- SVG 内部约定 ID：`#eyes-js`（眼球）、`#body-js`（身体）、`#shadow-js`（影子）供 JS 操作

## 关键 Electron 配置

- `win.setFocusable(false)` — 渲染窗口永不抢焦点
- `hitWin.focusable: true` — 输入窗口允许激活（修复拖拽 bug 的关键，副作用是点击会短暂抢焦点）
- `win.showInactive()` — 显示时不打断用户输入
- 资源路径始终用 `path.join(__dirname, ...)` — 确保打包后不丢文件
- 透明无边框浮窗：`frame: false`, `transparent: true`, `alwaysOnTop: true`
- 单实例锁：`app.requestSingleInstanceLock()` 防止重复启动
- 位置持久化：窗口坐标 + 尺寸存入 `clawd-prefs.json`
- 多显示器边界钳制：`clampToScreen()` 用 `getNearestWorkArea()` 查找最近显示器工作区

## 开发规范

- 敏感信息只放 `.env`，禁止硬编码
- 注册 Claude Code hook 时必须**追加**到已有 hook 数组，不能覆盖
- HTTP 服务端口范围 `127.0.0.1:23333-23337`，运行时端口写入 `~/.clawd/runtime.json`，退出时清理；全部占用时降级为 idle-only 模式
- hook 脚本仅依赖 Node 内置模块 + 同目录的 `server-config.js`（端口发现/签名验证），禁止引入三方包
- main.js 启动时自动调用 `registerHooks({ silent: true })` 注册缺失的 hooks
- PermissionRequest 必须用 HTTP hook（阻塞式），其他事件用 command hook（非阻塞式）
- 极简模式动画期间（`miniTransitioning`），所有窗口定位路径（`always-on-top-changed`、`display-metrics-changed`、`display-removed` 等）都必须检查此标志，否则并发定位会导致 `setPosition()` 崩溃

## 已知限制

- **hitWin 点击会抢焦点**：输入窗口 `focusable: true` 是修复拖拽 bug 的关键（去掉 WS_EX_NOACTIVATE），但副作用是点击桌宠会短暂抢走编辑器焦点。目前认为可接受，暂不处理。
- **启动恢复**：桌宠在 agent 会话中途启动时，`detectRunningClaudeProcesses()` 会检测已运行的 Claude 进程并激活 `startupRecoverActive` 标志，抑制 idle→sleep 序列，保持 idle-follow 等待 hook 到来；若未检测到进程则保持 idle 直到下一个 hook 事件触发
- **Windows 前台窗口锁**：Windows 11 不允许后台进程对已可见（非最小化）窗口调用 `SetForegroundWindow`，终端聚焦只能可靠地激活最小化窗口。这是 OS 层面限制，无法绕过
- hook 脚本依赖 Node.js 可用
- Windows 终端聚焦依赖 `koffi`（FFI 调用 `user32.dll AllowSetForegroundWindow`），macOS 用 `osascript`
- Codex CLI：JSONL 轮询有 ~1.5s 延迟；无终端聚焦（日志不含终端 PID）；Windows 下 hooks 被 Codex 硬编码禁用
- Copilot CLI：需手动创建 `~/.copilot/hooks/hooks.json`；无权限气泡（仅支持 deny）
- 进程存活检测：main.js 定期检查 agent 进程是否存活，清理孤儿会话；但依赖进程名匹配，非标准进程名可能漏检

## ⚠️ 不要再修 Language 子菜单截断 bug

右键菜单的 Language 子菜单底部被截掉一小条（约 2-4px）。这是 Electron transparent + alwaysOnTop 窗口与 Windows DWM 菜单渲染的底层兼容问题，**不影响使用**。

已花费 3+ 小时尝试多种方案全部失败。结论：截断的不是某个菜单项，而是"菜单底部"这个位置。win 的透明矩形 bounds 在 DWM z-order 中遮住了菜单底边一小条。这是 Electron + Windows DWM 的底层行为，纯 JS 层面无法解决。

**绝对不要碰 `win.setAlwaysOnTop(false)`：** 这个窗口是 transparent + unfocusable + skipTaskbar 的，一旦掉出 topmost 就沉到桌面底层，看不见也关不掉。
