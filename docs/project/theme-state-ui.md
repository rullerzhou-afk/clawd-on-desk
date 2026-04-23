# Theme, State, And UI Notes

This document holds the state machine, theme system, UI runtime, and platform caveats that were previously embedded in the root `AGENTS.md`.

## Dual-Window Model

桌宠使用两个独立的顶层窗口：

- 渲染窗口（`win`）：透明大窗口，永久 `setIgnoreMouseEvents(true)`，只负责显示 SVG 动画和眼球追踪
- 输入窗口（`hitWin`）：小矩形窗口，`transparent: true` + `setShape` 覆盖 hitbox 区域，`focusable: true`，永久 `setIgnoreMouseEvents(false)`，接收所有 pointer 事件

输入事件流：`hitWin renderer → IPC → main → renderWin renderer`

这个架构解决了 Windows 上的拖拽失效 bug：`WS_EX_NOACTIVATE` + layered window + Chromium child HWND 的组合在 z-order 变化后会走进激活死路径。分离后输入窗口保持 `focusable: true`，避开了这个问题。

## State Machine

- 多会话追踪：`sessions` Map 按 `session_id` 独立记录状态，`resolveDisplayState()` 取最高优先级
- 状态优先级：`error(8) > notification(7) > sweeping(6) > attention(5) > carrying/juggling(4) > working(3) > thinking(2) > idle(1) > sleeping(0)`
- 最小显示时长：防止快速闪切（`error=5s`、`attention/notification=4s`、`carrying=3s`、`sweeping=2s`、`working/thinking=1s`）
- 一次性状态：`attention/error/sweeping/notification/carrying` 显示后自动回退（`AUTO_RETURN_MS`）
- 睡眠序列：20s 鼠标静止 → idle-look → 60s → yawning(3s) → dozing → 10min → collapsing(0.8s) → sleeping；鼠标移动触发 waking(1.5s) → 恢复
- DND 模式：跳过 dozing，直接 yawning → collapsing → sleeping；同时屏蔽 hook 事件
- working 子动画：1 个会话 → typing，2 个 → juggling，3+ → building
- juggling 子动画：1 个 subagent → juggling，2+ → conducting

## Theme System

Clawd 是主题化桌宠：动画资源、计时、hitbox、眼球追踪参数都来自主题配置。

- 内置主题目录：`themes/clawd/`、`themes/calico/`、`themes/template/`、`themes/static-test/`、`themes/pr4-*`
- 用户主题目录：`<userData>/themes/<id>/theme.json`
- `theme.json` 必需状态：`idle`、`working`、`thinking`
- 若启用 `eyeTracking.enabled`，idle 资源必须是 SVG 且包含 `#eyes-js`
- 若声明 `fullSleep`，需提供 `yawning / dozing / collapsing / waking`
- 若声明 `miniMode`，需提供 mini 状态资源
- 能力缺失时走 `VISUAL_FALLBACK_STATES` 回退链
- 默认配置集中在 `theme-loader.js` 顶部的 `DEFAULT_*` 常量
- 变体是白名单 deep-merge；数组和特定字段会整体替换
- Animation override 是用户 per-slot 覆盖，和作者定义的 variants 正交
- SVG 会经过白名单消毒，阻断脚本、事件属性、外部资源、`javascript:` 和路径穿越
- 支持 SVG / GIF / APNG / WebP / PNG / JPG；动画周期由 `src/animation-cycle.js` 探测
- 更新视觉遵循主题绑定：`checking` 可选走 `theme.updateVisuals.checking`，未声明时回退到当前主题的 `thinking`；发现新版本时会进入 `available -> notification`；`downloading / success / error` 继续分别走 `carrying / attention / error`

主题创建流程见 `docs/guides/guide-theme-creation.md`。

## Settings Panel

Settings 是独立 `BrowserWindow`，采用 4 层结构：

| 层 | 文件 | 职责 |
|---|---|---|
| Schema / 持久化 | `src/prefs.js` | `SCHEMA` 定义；`load/save/migrate/validate`；坏文件自动 `.bak` + fallback |
| 内存 store | `src/settings-store.js` | `createStore()` 返回 `{ getSnapshot, subscribe, _commit }`；`_commit` closure-private |
| 控制器 | `src/settings-controller.js` | 唯一写入者；`applyUpdate` / `applyBulk` / `applyCommand` / `hydrate`；pre-commit effect gate |
| UI | `src/settings-renderer.js` + `settings.html` + `preload-settings.js` | 主题卡片、animation overrides、agent 开关、诊断；只通过 IPC 调 controller |

关键取舍：

- `applyUpdate` 和 `applyBulk` 对同步/异步 effect 同构
- `hydrate()` 是唯一跳过 effect 的入口
- 设置写入路径只有 `controller → store → subscribers`
- About tab 使用 inline SVG，而不是 `<object>`，因为 `settings.html` CSP 是 `default-src 'none'`

## Mini Mode

角色藏在屏幕右边缘，窗口一半推到屏幕外，由屏幕边缘自然遮挡。

进入方式：

- 拖拽到右边缘（`SNAP_TOLERANCE=30px`）→ 快速滑入 + `mini-enter`
- 右键菜单 “Mini Mode” → 螃蟹步走到边缘 → 抛物线跳入 → 探头入场

核心机制：

- `miniMode` 拦截常规状态，把 notification / attention 映射为 mini 对应状态
- `miniTransitioning` 在入场期间屏蔽 hook 事件和 peek
- `checkMiniModeSnap()` 检查所有显示器右边缘
- `miniIdleNow` 独立于 `idleNow`，只走眼球追踪，不走睡眠序列
- `animateWindowX()` + `animateWindowParabola()` 负责滑动与抛物线动画
- `savePrefs()` 会持久化 `miniMode/preMiniX/preMiniY`

Mini 状态映射：

| 状态 | SVG | 用途 |
|------|-----|------|
| `mini-idle` | `clawd-mini-idle.svg` | 待机：呼吸、眨眼、手臂晃动、眼球追踪 |
| `mini-enter` | `clawd-mini-enter.svg` | 一次性滑入弹跳 |
| `mini-peek` | `clawd-mini-peek.svg` | Hover 探头 |
| `mini-alert` | `clawd-mini-alert.svg` | 通知 |
| `mini-happy` | `clawd-mini-happy.svg` | 完成 |
| `mini-crabwalk` | `clawd-mini-crabwalk.svg` | 右键进入时的螃蟹步 |
| `mini-enter-sleep` | `clawd-mini-enter-sleep.svg` | DND 下入场 |
| `mini-sleep` | `clawd-mini-sleep.svg` | DND 休眠 |
| `mini-working` | 主题可选 | 1 会话 mini typing；缺失则静默跳过 |

## State To Animation Mapping

权威表格见 `docs/guides/state-mapping.md`。这里只保留实现层面的补充：

- working 子动画：1 会话 → typing，2 → juggling，3+ → building
- juggling 子动画：1 subagent → juggling，2+ → conducting
- mini 状态有独立动画槽；`mini-working` 是可选能力
- 睡眠序列和 DND 行为见上面的 State Machine
- `attention / error / sweeping / notification / carrying` 是一次性状态，显示后按 `autoReturn` 回退

## Assets

- 素材按主题组织：每个主题目录自带 `assets/`
- `assets/svg/` 与 `assets/gif/` 是默认 Clawd 主题使用的公共根路径
- 文档预览 GIF 放在 `assets/gif/`，运行时不直接读
- 需要编辑的源素材先复制到 `assets/source/`
- SVG 运行时用 `<object type="image/svg+xml">`，其他位图格式走 `<img>`
- 默认 SVG 内部 ID：`#eyes-js`、`#body-js`、`#shadow-js`、`#eyes-doze`

## Runtime UI Systems

### Sound

- `app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required")` 要在窗口创建前设置
- `main.js` 里的 `playSound(name)` 会检查 `soundMuted`、`doNotDisturb` 和 cooldown
- `renderer.js` 用 `_audioCache` 缓存 `Audio` 对象
- `attention/mini-happy` 播放 complete，`notification/mini-alert` 播放 confirm

### Eye Tracking

- `tick.js` 每 50ms 轮询鼠标
- 眼球位移量量化到 0.5px 像素网格
- 鼠标没动时会 dedup 跳过发送
- 从 `idle-look` 返回 `idle-follow` 时需要 `forceEyeResend`
- 当前实现**故意不用**跨进程“renderer ready”握手；主进程持续发 `eye-move`，恢复靠延迟 `forceEyeResend` 和 renderer 侧的自检重挂载
- 任何 `!moved` / dedup 优化都必须保留 `forceEyeResend` 旁路，否则 idle-look 结束后的眼球重定位会被吞掉

### Animated SVG Through `<img>`

- `renderer.js` 里给 `<img>` SVG 追加的 `?_t=` cache-bust query 是必需的
- 原因不是 HTTP 缓存，而是 Chromium 会复用同 URL SVG 的文档与 CSS 动画时间线；`forwards` 的一次性动画第二次加载时会直接停在末帧
- 相关 dedup 逻辑必须比较规范化后的文件名，而不是带 query 的最终 URL

### Click Reactions

- 双击 → 左/右戳反应
- 4 连击 → 双手拍反应
- 拖拽 → 持续拖拽反应
- 反应动画期间会暂时 detach 眼球追踪

## Electron And Platform Notes

- `win.setFocusable(false)`：渲染窗口永不抢焦点
- `hitWin.focusable: true`：输入窗口允许激活，这是修复拖拽 bug 的关键
- `win.showInactive()`：显示时不打断用户输入
- 渲染 / 输入窗口都依赖 `backgroundThrottling: false`；unfocused 节流会放大眼球追踪和输入恢复的时序问题
- 路径统一用 `path.join(__dirname, ...)`
- 透明无边框浮窗：`frame: false`, `transparent: true`, `alwaysOnTop: true`
- 使用单实例锁：`app.requestSingleInstanceLock()`
- 位置持久化到 `clawd-prefs.json`
- 多显示器钳制走 `clampToScreen()` + `getNearestWorkArea()`

## Known Limits

- `hitWin` 点击会短暂抢焦点，这是当前可接受代价
- 当前开发环境没有 macOS 手测机；所有 macOS 特定路径都只能做 code review + best-effort 推断，真正行为变化需要额外人工验证
- 启动恢复依赖 `detectRunningClaudeProcesses()` 与后续 hook 事件
- Windows 前台窗口锁通过 ALT trick + `koffi` FFI 绕过，仍有边缘失败可能
- hook 脚本依赖 Node.js
- Windows 终端聚焦依赖 `koffi`；macOS 依赖 `osascript`
- Codex CLI 只有 JSONL 轮询，约 1.5s 延迟，且 Windows 下 hooks 被硬编码禁用
- Copilot CLI 需要手动创建 `~/.copilot/hooks/hooks.json`
- Gemini 无权限气泡；Cursor 权限走 stdout；Kiro 没有 global hooks；opencode 权限只能走 event hook + bridge
- opencode 子会话会短暂出现在 Sessions 菜单里
- 进程存活检测依赖进程名匹配，非标准进程名可能漏检

## Do Not Fix This Again

Language 子菜单底部截断是 Electron 透明窗口 + Windows DWM 的底层兼容问题，不要再尝试通过纯 JS 调整 `alwaysOnTop` 或透明窗策略来修。
