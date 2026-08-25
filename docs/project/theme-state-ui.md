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
- 逻辑 `idle` 与静置视觉分离：Settings 可为当前主题选择一个常驻 idle 变体，但不改变状态优先级；thinking / working / permission / completion / sleep / reaction / roam 仍会覆盖它，结束后再回到所选视觉
- DND 模式：跳过 dozing，直接 yawning → collapsing → sleeping；同时屏蔽 hook 事件
- 隐藏桌宠（petHidden，入口：托盘 / 右键菜单 / 快捷键）：语义是「看不见宠物」而非免打扰——隐藏时收起宠物、Session HUD、update bubble 和当时 pending 的权限气泡（恢复显示时回来），但隐藏期间新到的权限请求仍照常弹气泡，这是有意设计、不要当 bug 修；要连权限气泡都静默是 DND 的职责（它有回终端确认的 fallback）。Allow/Deny 全局快捷键跟随「可见气泡」：隐藏期间只要有可见气泡就保持注册，但只作用于可见的请求，收起的旧气泡不会被盲操作（#601）。petHidden 不持久化，重启恢复显示
- working 子动画：Clawd 主题为 1 个会话 → typing，2 个 → headphones groove，3+ → building；Calico / Cloudling 仍为 typing / juggling / building
- juggling 子动画：1 个 subagent → juggling，2+ → conducting

## Theme System

Clawd 是主题化桌宠：动画资源、计时、hitbox、眼球追踪参数都来自主题配置。

- 内置主题目录：`themes/clawd/`、`themes/calico/`、`themes/cloudling/`；`themes/template/` 是脚手架模板
- 用户主题目录：`<userData>/themes/<id>/theme.json`
- `theme.json` 必需状态：`idle`、`working`、`thinking`
- `states.idle[0]` 是主题默认的 follow-idle；Settings 的“默认待机动画”选项来自该主题声明的 idle 状态与 idle animation pool，并按主题分别持久化到 `prefs.idleVisual`
- 若启用 `eyeTracking.enabled`，`eyeTracking.states` 所列状态中的全部文件都必须是 SVG（`idleAnimations` 池不受此 schema 约束）；实际挂载眼追的文件还必须提供配置对应的追踪目标。逻辑 `idle` 只有 `states.idle[0]` 这个 follow-idle 会挂载眼追（模板的 legacy 目标是 `#eyes-js`），用户选择的非默认静置视觉不启用眼球跟随或 spin-to-dizzy
- 若 `sleepSequence.mode` 为 `full`（默认），需提供 `yawning / dozing / collapsing / waking`；`direct` 可直接进入 `sleeping`
- 若 `miniMode.supported` 为 true，需提供 8 个基础 mini 状态；`mini-working` 是可选增强，缺失时优雅跳过
- 能力缺失时走 `VISUAL_FALLBACK_STATES` 回退链
- 默认配置集中在 `theme-loader.js` 顶部的 `DEFAULT_*` 常量；loader 保持 stateless，`src/theme-runtime.js` 是唯一 active-theme owner，主题 reload/sync/cache 不得另设模块级真相
- 变体是白名单 deep-merge；数组和特定字段会整体替换
- Animation override 是用户 per-slot 覆盖，和作者定义的 variants 正交
- 支持配饰的主题可按主题保存常驻 `petAccessory`；独立的 `holidayAccessoryEnabled` 开关只在万圣节、圣诞节和跨年的短日期窗口临时覆盖当前显示，结束后恢复常驻选择，不回写配饰偏好
- SVG 会经过白名单消毒，阻断脚本、事件属性、外部资源、`javascript:` 和路径穿越
- `trustedRuntime.scriptedSvgFiles` 只对 loader 判定为内置的主题生效；外部主题声明该字段会被忽略
- 支持 SVG / GIF / APNG / WebP / PNG / JPG；动画周期由 `src/animation-cycle.js` 探测
- 更新视觉遵循主题绑定：`checking` 可选走 `theme.updateVisuals.checking`，未声明时回退到当前主题的 `thinking`；发现新版本时会进入 `available -> notification`；`downloading / success / error` 继续分别走 `carrying / attention / error`

主题创建流程见 `docs/guides/guide-theme-creation.md`。

## Settings Panel

Settings 是独立 `BrowserWindow`，采用 5 层结构：

| 层 | 文件 | 职责 |
|---|---|---|
| Schema / 持久化 | `src/prefs.js` | `SCHEMA` 定义；`load/save/migrate/validate`；JSON 损坏自动 `.bak` + fallback；文件本身不可读时进入不覆盖原文件的 read-failure safe mode |
| 内存 store | `src/settings-store.js` | `createStore()` 返回 `{ getSnapshot, subscribe, _commit }`；`_commit` closure-private |
| 控制器 / actions | `src/settings-controller.js` + `src/settings-actions*.js` | controller 是唯一写入者；actions 提供校验、command 与失败可阻止提交的 pre-commit gates |
| 提交后 effects | `src/settings-effect-router.js` | 订阅 committed changes，更新 tray/dock/window/HUD/renderer 等 runtime 状态与广播；失败不得回滚已提交 prefs |
| UI | `src/settings-ui-core.js` + `src/settings-renderer.js` + `src/settings-tab-*.js` + `src/settings.html` + `src/preload-settings.js` | core 持 shared state，renderer 是侧栏/tab shell，各 tab 只通过 preload/IPC 调 controller；新增 tab 还要登记 script 与 icon |

关键取舍：

- `applyUpdate` 和 `applyBulk` 对同步/异步 pre-commit gate 同构
- `hydrate()` 是唯一跳过 pre-commit gate 的入口；post-commit effects 由 router 订阅 store changes
- 设置写入路径只有 `controller → store → subscribers`
- `prefs.load()` 返回 `locked && recovered` 表示文件字节从未成功读取：controller 会在 validator / command / 外部 effect 之前拒绝用户 mutation，agent runtime 的启动同步、monitor、state/permission ingress 与 session recovery 全部 fail closed；修复文件访问并重启后才恢复。可读的 future-version `locked && !recovered` 继续保持既有的当前进程内存可改、磁盘不覆盖语义
- `idleVisual` 是 per-theme 文件映射；缺失键表示使用主题默认，主题升级删除已选文件或删除主题时会安静回退，不改变逻辑状态
- About tab 使用 inline SVG，而不是 `<object>`，因为 `settings.html` CSP 是 `default-src 'none'`

### Bubble display and placement

气泡“是否显示”和“显示在哪里”是两条独立设置轴：

- `hideBubbles`、`permissionBubblesEnabled` 与各类别 auto-close policy 只控制本地气泡显示；不得重置定位偏好或产生权限决定。
- `bubbleFollowPet` 只选择跟随桌宠或固定在主屏，不影响 permission、notification、update 的显示 gate。
- 跟随模式读取 `bubbleFollowPreference=auto|left|right`。`auto` 保持下方优先；左右值是安全偏好，空间不足时按候选顺序回退，绝不强制放到工作区外。
- 固定模式读取 `bubbleFixedCorner=top-left|top-right|bottom-left|bottom-right`，锚定 primary display 的 `workArea`。主屏查询不可用时回退桌宠所在显示器，再失败才使用 synthetic work area。
- permission stack 先定位并避让可见 Session HUD；update bubble 随后读取真实可见 permission/HUD 外窗矩形再定位；Orbit 最后读取更新后的几何。
- 跟随模式使用桌宠所在显示器的 text scale；固定模式使用主屏 text scale。窗口 bounds、CSS px → DIP 与 renderer zoom 必须基于同一个目标显示器。
- 权限气泡默认是约 340 CSS px 的三行摘要卡；普通工具在摘要态保留原有 Allow/Deny、Always/suggestion 和会话授权快捷操作，长正文经「查看详情」进入约 500 CSS px 的详情卡。Plan 摘要同时保留「查看计划」和快速批准，反馈/回终端等次级操作在展开后出现；Ask 摘要只可「回答」。详情正文滚动，标题和全部决定区固定，不提供自由拖拽改尺寸。
- 桌面同时最多一个权限详情卡，切换时其他气泡恢复摘要，但各自 BrowserWindow/DOM 不销毁，因此 Ask 选择、Other 文本、Plan 修改草稿、步骤和滚动位置保留；IME composition 未结束时拒绝切换详情。petHidden 只隐藏窗口，不清空详情 owner 或草稿。
- 多气泡始终保持最老请求在上；详情卡必须完整留在当前目标工作区，摘要兄弟过多时可向工作区外溢，不能把正在阅读的详情压到不可读。macOS IME 编辑中的气泡冻结位置，blur 后只执行一次现有 floating-bubble 重排序列。

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

- working 子动画：Clawd 主题为 1 会话 → typing，2 → headphones groove，3+ → building；Calico / Cloudling 仍为 typing / juggling / building
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
- 普通 idle 只有当前文件等于主题的 `idleFollowSvg` 才挂载眼球追踪；非默认静置视觉跳过 attach/re-attach，mini-idle 仍按自己的能力独立追踪
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

### Test Result Reactions

- Settings → General → Alerts & feedback 的“测试结果动画”是独立 opt-in，默认关闭
- Claude Code（包括 Cursor 导入的兼容 hook）的 Bash `PostToolUse` / `PostToolUseFailure` 只在命令以常见测试 runner 开头、且结果可可靠判断时上报 `pass` / `fail`；命令和测试输出不会传给 renderer，server 也只接受这两个来源的结果标签
- `pass` 在 `#pet-particle-layer` 播放一次像素纸屑，`fail` 只对 `#pet-facing-stage` 使用独立 `translate` / `rotate` 抖动，不覆盖 mini 镜像、漫步位移或跨屏 viewport offset
- DND、隐藏桌宠、mini / mini transition、拖拽和 headless 会话都会压住测试结果动画；状态机本身仍照常处理测试事件

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
- Codex CLI 以 official hooks 为主、JSONL 轮询为 fallback；WebSearch / compaction / abort 等 hook 未覆盖事件仍可能有轮询延迟
- Copilot CLI 自动同步 `<COPILOT_HOME 或 ~/.copilot>/hooks/hooks.json`；`disableAllHooks: true` 时 doctor warning 且不挂 Fix 按钮
- ZCode 自动同步 `~/.zcode/cli/config.json` 的 `hooks.events.*`；显式全局或单项 `enabled:false` 保持不变，doctor warning 且不挂会覆盖用户选择的 Fix 按钮
- Gemini 无权限气泡，除非未来提供兼容的阻塞式审批协议；Cursor 权限走 stdout；Kiro 没有 global hooks；opencode 与 MiMo Code 权限只能走 event hook + bridge
- opencode child / subtask session 只有在 `session.created` 明确带 `event.properties.info.parentID` 时才会被标记为 headless；这类后台 child 不进入 HUD / focus / 多会话 fanout；MiMo Code 与 opencode 同源，child session 行为一致
- 进程存活检测依赖进程名匹配，非标准进程名可能漏检

## Do Not Fix This Again

Language 子菜单底部截断是 Electron 透明窗口 + Windows DWM 的底层兼容问题，不要再尝试通过纯 JS 调整 `alwaysOnTop` 或透明窗策略来修。
