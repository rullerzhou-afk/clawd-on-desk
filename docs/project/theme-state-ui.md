# Theme, State, And UI Notes

This document holds the state machine, theme system, UI runtime, and platform caveats that were previously embedded in the root `AGENTS.md`.

## Dual-Window Model

桌宠使用两个独立的顶层窗口：

- 渲染窗口（`win`）：透明大窗口，永久 `setIgnoreMouseEvents(true)`，只负责显示 SVG 动画和眼球追踪
- 输入窗口（`hitWin`）：小矩形窗口，`transparent: true` + `setShape` 覆盖 hitbox 区域，Linux 与原生 activation controller 可用的 Windows 以 Electron `focusable: false` 创建；Windows controller 不可用时回退为 `focusable: true`。窗口永久 `setIgnoreMouseEvents(false)`，接收所有 pointer 事件

输入事件流：`hitWin renderer → IPC → main → renderWin renderer`

Windows 的 hit window 在原生 activation controller 可用时按前台全屏状态切换 `WS_EX_NOACTIVATE`：非全屏时清除该扩展样式，全屏时重新设置以避免点击和拖拽把前台切到 Clawd。Electron 内部保持 non-focusable；首次显示前安装的 `WM_MOUSEACTIVATE` hook 通过一次性 `Chrome.IgnoreMouseActivate` 属性让 Chromium 对该消息返回 `MA_NOACTIVATE`（不因这条消息激活窗口，也不丢弃鼠标输入），避免 `MA_NOACTIVATEANDEAT` 吞掉点击。该消息的返回值不保证普通桌面点击始终保持 OS 前台归属，相关限制见 Known Limits。输入窗口仍和渲染窗口分离，并永久接收 mouse events。

## State Machine

- 多会话追踪：`sessions` Map 按 `session_id` 独立记录状态，`resolveDisplayState()` 取最高优先级
- 状态优先级：`error(8) > notification(7) > sweeping(6) > attention(5) > carrying/juggling(4) > working(3) > thinking(2) > idle(1) > sleeping(0)`
- 最小显示时长：防止快速闪切（`error=5s`、`attention/notification=4s`、`carrying=3s`、`sweeping=2s`、`working/thinking=1s`）
- 一次性状态：`attention/error/sweeping/notification/carrying` 显示后自动回退（`AUTO_RETURN_MS`）
- 睡眠序列：20s 鼠标静止 → idle-look → 60s → yawning(3s) → dozing → 10min → collapsing(0.8s) → sleeping；鼠标移动触发 waking(1.5s) → 恢复
- 逻辑 `idle` 与静置视觉分离：Settings 可为当前主题选择一个常驻 idle 变体，但不改变状态优先级；thinking / working / permission / completion / sleep / reaction / roam 仍会覆盖它，结束后再回到所选视觉
- 逻辑状态与真正显示的视觉也彼此分离：所有 state、reaction、随机 idle、低功耗替换和回退都先生成带 `visualGeneration` 的显示请求；renderer 结算后，main 才提交 `{ displayState, file, hitBox, source, visualGeneration }`。原生 hit window、配饰投影与 Presence 只读这份 committed visual，输入窗口仍即时读取逻辑状态做反应门控
- DND 模式：跳过 dozing，直接 yawning → collapsing → sleeping；同时屏蔽 hook 事件
- 隐藏桌宠（petHidden，入口：托盘 / 右键菜单 / 快捷键）：语义是「看不见宠物」而非免打扰——隐藏时收起宠物、Session HUD、update bubble 和当时 pending 的权限气泡（恢复显示时回来），但隐藏期间新到的权限请求仍照常弹气泡，这是有意设计、不要当 bug 修；要连权限气泡都静默是 DND 的职责（它有回终端确认的 fallback）。Allow/Deny 全局快捷键跟随「可见气泡」：隐藏期间只要有可见气泡就保持注册，但只作用于可见的请求，收起的旧气泡不会被盲操作（#601）。petHidden 不持久化，重启恢复显示
- Windows 全屏自动隐藏会同时收起桌宠与浮层，并压住全屏期间新到的本地权限请求；退出全屏只恢复仍 pending 且未被其他隐藏条件排除的请求。它不同于手动 petHidden 的新请求例外。隐藏本身不产生决定，远程审批通道与用户配置的 auto-close 仍按原合同运行。
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
- 配饰是两个独立的主题级槽：`petAccessory` 对应 head，`petMouthAccessory` 对应 mouth。renderer 中两者都是 pet media 的外部兄弟层，固定顺序为 `pet media → head → mouth`，因此 pet tint 不会染到配饰，mouth 也能稳定画在手或 head 配饰之上
- head / mouth 选择以一个 `{ themeId, payloads, accessoryGeneration }` 快照原子投递；main 仅在发送成功后提交为权威值（send-gated commit），没有独立的 renderer 接收 ACK。同内容重投递可复用 generation；内容变化才推进 generation，旧消息不得覆盖新选择。这与 displayed-visual 的终结 ACK 是不同合同
- 独立的 `holidayAccessoryEnabled` 开关只在万圣节、圣诞节和跨年的短日期窗口临时覆盖 head 槽；mouth 槽保持用户选择。日期窗口结束后恢复常驻 head 选择，不回写任一配饰偏好
- `idleEasterEggs` 是条件式 idle 彩蛋池：每项声明文件、时长、概率、冷却时间和 head / mouth 的精确配饰组合。只有普通 idle、窗口可见、非 mini / roam / drag / 菜单 / 低功耗且两个槽仍匹配时才参与抽签；只有 renderer 确认该逻辑视觉最终 committed 后才从实际显示时刻开始计时长和冷却
- 用户主题 SVG 会经过白名单消毒，阻断脚本、事件属性、外部资源、`javascript:` 和路径穿越；内置 SVG 不走运行时 sanitizer，必须由仓库测试做静态安全审计
- `rendering.objectChannelFiles` 可按 SVG basename 把需要 `contentDocument` 控制、且经逐素材 Electron 验证的少量精灵切到 document-backed `<object>` 通道；普通 CSS / SMIL 动画仍优先使用 `<img>`。这些文件同时进入 required-assets 集合并使主题采用较高功耗档。外部主题仍先走 SVG sanitizer（含动态 SMIL 属性值），该字段不授予脚本能力
- `trustedRuntime.scriptedSvgFiles` 只对 loader 判定为内置的主题生效；外部主题声明该字段会被忽略
- 支持 SVG / GIF / APNG / WebP / PNG / JPG；动画周期由 `src/animation-cycle.js` 探测
- 更新视觉遵循主题绑定：`checking` 可选走 `theme.updateVisuals.checking`，未声明时回退到当前主题的 `thinking`；发现新版本时会进入 `available -> notification`；`downloading / success / error` 继续分别走 `carrying / attention / error`

主题创建流程见 `docs/guides/guide-theme-creation.md`。

### Displayed visual settlement

main 中的 displayed-visual projection 是文件、hitbox 和视觉来源的唯一权威。renderer 对每个仍有效的 request 恰好返回一个终结结果：正常加载为 `swapped`，当前文件已经显示为 `already-displayed`，实际显示了可投影的替代文件为 `fallback`，无法验证则为 `failed`；被后续请求取代的 generation 由 main 标为 `superseded`，renderer 不伪造 ACK。

- renderer 的 object → img → accessory-settle 回退链必须先自行走完；main 的 9750ms settlement deadline 只是无 ACK 兜底
- 同一 logical visual 最多自动 re-request 一次；连续两个 request 都没有 ACK 时，同一 displayed-visual projection 实例最多尝试 reload 一次，失败也消耗预算。当前 main 只创建一个实例，因此该预算覆盖当前主进程寿命，不随 renderer reload 重置；独立 crash recovery 有自己的限制。visual timeout 本身不得循环 reload
- 只有 `verified: true` 且实际 basename 合法的结果可提交；不可投影的 fallback 以 failed 终结，保留上一份 committed visual
- reaction 也走 generation 合同，但不广播到 Presence；hit renderer 继续即时消费 logical state，不等待视觉 ACK
- committed visual 到达后触发原生 hit-window 同步。拖拽锁、窗口未 live 或 Linux sliver 导致的 deferred sync，由 drag release、窗口恢复和现有 transition-end sweep 补做

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
- `shortcuts` 使用 Electron accelerator token；prefs v15 → v16 会先把旧配置中的字面 `Control` 迁移为 `CommandOrControl`，再允许新录制的 macOS 原生 `⌃ Control` 保持为独立 token。Windows/Linux 会在危险组合检查、加载去重、设置冲突和显示时把两者视为同一个实体 Control 键，macOS 则始终保持 ⌘ / ⌃ 独立
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
- 多气泡在当前工作区安全容纳时始终保持原来的逐窗栈与最老请求在上；一旦真实窗口几何无法完整落在工作区并避开 HUD，就按 agent + session 保留每个会话的代表卡，把其余请求收入一个固定高度的「还有 N 个待处理」入口。代表卡仍不够放时只继续减少非保护代表，已展开、正在输入/IME composition 或用户刚选中的请求不得被折叠。
- 队列入口展开为单独的导航抽屉：抽屉打开时它是唯一可见的 permission surface，只列工具、摘要和「查看/回答/查看计划」，不承载 Allow/Deny。选择一项会恢复该请求原来的 BrowserWindow/DOM；IME composition 未结束时禁止打开抽屉或切换。主进程必须等待抽屉 renderer 对当前 revision 的 ACK 后才隐藏请求窗口；加载、崩溃或 ACK 超时均回退到原逐窗栈，不能产生权限决定。
- petHidden 以隐藏动作当时的请求序号为切点：旧请求（包括队列）保持收起，隐藏期间的新请求仍可用同一套 overflow/queue 规则出现；恢复桌宠后再合并全部 pending。任意 permission surface 可见时自由漫游暂停，surface 消失后重新等待完整 8 秒，不能沿用拖拽已消耗的 4 秒阶段。macOS IME 编辑中的可见气泡冻结位置，blur 后只执行一次现有 floating-bubble 重排序列。

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

### Session History（本机 Claude 手动继续）

- 普通 Dashboard 在 live cards 下方展示独立历史区，最多 25 条；历史不参与 quick-select 数字映射。显示标题 / session ID、目录 basename、最近时间与可选中断 / transcript 缺失提示，不展示完整路径或对话内容。有历史但无 live 会话时空状态改为紧凑布局，不能占满整屏把恢复按钮推到首屏之外。
- 恢复中禁点由 main 持有，页面缓存只负责显示；提交终端后继续等待真实 live snapshot，不立即移除卡片或声称成功。30 秒未观察到会话时提示先检查终端，并允许手动重试；已知启动失败立即显示错误且保留原卡。
- 历史在初始加载和 live 集合变化时重读，1 秒 UI tick 不读磁盘。加载期间的新失效通知必须排队重读；渲染时再次过滤当前本机 live ID，避免迟到历史回包让已恢复的卡片复活。存储、隐私与运行时边界见 `agent-runtime-architecture.md` 的 Local Claude Session History。

### Session Quick Select（Dashboard 临时键盘模式）

平台范围：**macOS / Windows only。Linux 本轮 NOT SUPPORTED**——不是“未验证”，而是明确不开放；Linux 保留原有桌宠、普通 Dashboard 和既有快捷键。

- Settings → Shortcuts 的“快速选择会话”默认未分配。快捷键打开的是**完整 Dashboard 本身**的一个临时键盘模式，不是第二套 UI：同一份 `dashboard.html` / preload / renderer / 页面状态，卡片、group、quota、alias、automation 全部保留。
- 平台 gate 的唯一真相是 `shortcut-actions.js` 的 `SHORTCUT_ACTIONS.quickSelectSession.supportedPlatforms`，由 `isShortcutActionSupported()` 统一判定。Linux：Settings 不渲染该行、`globalShortcut` 不注册、录制被拒、绕过 UI 的 `registerShortcut` / `resetShortcut` 明确报错。预览版遗留的 `shortcuts.quickSelectSession` 值**原样保留在 prefs**，只是不执行、不占用冲突位，也不会被 Reset All 改写。
- **不支持的平台上这套 IPC 根本不注册**：`session-ipc.js` 只在 `quickMode.isSupported()` 时注册 `dashboard:quick-*`，`preload-dashboard.js` 也只在 darwin/win32 暴露对应方法并订阅对应通道，renderer 按方法是否存在做特性检测。因此 Linux 上不存在“可以调用但回 unsupported”的能力面，也不会调用未注册通道。
- `src/dashboard.js` 是唯一 owner。darwin/win32 的普通宿主是 `BaseWindow + WebContentsView`（`src/dashboard-host.js`），Linux 仍是 `BrowserWindow`。BaseWindow **不会**触发 `ready-to-show`，首次显示由该 view 真实 `webContents` 的 load 事件驱动；页面的 `webContents` 只能从 owner 取，不能走 `window.webContents` 或 `BrowserWindow.fromWebContents()`。
- quick 宿主（`src/dashboard-quick-mode.js`）懒创建：macOS `type:"panel"`，Windows `type:"toolbar" + skipTaskbar`。尺寸取普通宿主的 `getNormalBounds()` 并按当前 workArea 钳制——**不得沿用全屏 / maximized / macOS Zoom 的 transient rect**，否则 panel 会铺满整屏挡住来源窗口。
- 借用规则按真机结论固定：**禁止 `hide()` + `showInactive()` 归还**（实测归还时会把普通 Dashboard 抬到来源窗口之上）。可见但非前台的普通宿主改为 `opacity=0` + `setIgnoreMouseEvents(true)`，原值捕获一次、任何退出路径幂等恢复（恢复的是捕获值，不是硬编码 1）。`setIgnoreMouseEvents(true)` **不挡键盘**，所以被停放的宿主绝不能持有焦点。冷启动 / 隐藏 / 最小化的普通宿主不 park、不 show、不 restore。普通 Dashboard 已聚焦时只就地进入数字模式，不借用、不改任何宿主旗标。
- **统一 busy gate**：renderer 存在 activeEdit / composing / 聚焦的 native select 或 editable 元素时，本次数字模式与转移**整体拒绝**——不保留数字映射、不 force render、不取消编辑、不 commit、不吞按键，只在固定的模式提示节点提示“先结束编辑”。判定发生在任何原生动作之前，因为 detach 本身就会让别名输入框 blur 并提交半截草稿；`dashboard-renderer.js` 的 forced 重绘还会在 rAF 里重新 `focus()` + `select()` 整段草稿。**busy 在 `enter` 与 `ready` 两个时刻都要判**：等待 `enter` 回包期间用户开始编辑时，renderer 以 `ready{busy:true}` 让 main 放弃本次数字轮，绝不转移。结束编辑后需要再次明确按快捷键才进入，不会暗中 armed。
- **重开先撤销数字权限，不能先结束物理借用**：Windows 在 `2ca873f9` 实测 quick 内编辑 / IME 期间再次快捷键会先 `dismiss(reenter)` → 转移 view → input blur 提交草稿，随后才返回 busy。现在 `show()` 同步废除旧 active/ready/mapping，使旧数字与迟到 IPC 立即失效，但保留 view、宿主、parking 和输入焦点，先进行新轮 enter / ready 协商。已有 quick 宿主在接受后直接复用，不为替换数字而重挂 / 重定位；需要回普通宿主时也只能在两次 busy 检查后移动。
- **busy 后可保留借出的编辑器，但不能保留数字权限**：`retainedBorrow` 只说明原来的物理借用仍在；main 的 active/ready/pending 均清零，不接受迟到 ready 自动恢复。renderer 用独立 cancel-only 标志允许编辑结束后的 Esc / Tab 退出，main 仅允许仍有物理借用且精确匹配最后签发 revision 的取消。固定容器 class 让旧数字徽标不可见，不重建输入框或改变卡片几何。后续 blur、普通打开、导航、页面消失、退出仍归还 view 并通知该 revision；迟到 busy 回包不得复活已结束的借用，也不能关闭新轮。此 F3 修复已有主进程＋真实 renderer 处理器的联动模型测试，新增真机证据仍待复验。
- 轮次身份：main 持有单调 revision，**只有 main 签发的新 intent 可以推进轮次**；renderer→main 的 ready / activate / dismiss 必须携带精确当前 revision，`dismissed` 携带**被结束轮**的 revision。旧轮既不能激活也不能取消新轮。renderer 侧另有一个 round 序号：dismiss / ordinary open / 失效都会推进它，因此**在途的 `enter` / `ready` 回包无法复活已经结束的轮**（只比 revision 不够——dismiss 不改 revision）。
- **accepted ≠ armed**：`enter()` 只冻结候选，必须等 `ready()` 把页面放到一个真实持有焦点的宿主上，`activate` 才可能成功（`round-not-ready`）；就地（已聚焦普通宿主）那一轮同样要走 `ready()`。
- 页面 main-frame 导航 / reload / 加载失败 / WebContents 销毁 / 崩溃一律作废当前轮并归还页面；就地轮由普通宿主 blur 结束，而**借用轮的普通宿主 blur 是预期的、不算退出**。owner 自己触发的 focus/blur（detach、attach、show、hide）不当作用户切换。
- Windows 连续按快捷键仍作废旧 revision，但**同一次未提交、且原生前台仍属于 quick 宿主的物理借用**保留最初来源，直到新轮完成 capture。连续 pending、已 enter 但未 ready 的替换也遵守这条；原生前台换成其他窗口时重新捕获新来源。busy 若保留原编辑器，也只保留同一次借用的取消来源；它不是一次已退出的借用，不能为了清来源而提前 blur 草稿。普通打开、外部 blur、已提交跳转、就地轮和其他实际退出不继承旧来源；来源的可见、未最小化、PID 不变校验仍由 restore 执行。`2ca873f9` 的 Windows 8 组主路径已有真机 PASS，enter-not-ready 仍未原生命中；本轮 F3 改动不能自动继承那些 PASS。
- **作废一轮不等于把键盘还回去**：Windows 实测 reload 后 quick 宿主已 `visible=false`，却仍是 GetForegroundWindow 与 GUI focus root，普通 Dashboard `document.hasFocus()=false`、来源窗口再也收不到键。因此页面失效（导航 / reload / 加载失败 / 页面消失）与显式取消走同一条归还路径：本轮没有 submitted 时才尝试归还来源（`restore` 自己校验「此刻前台仍是本窗口」）。来源已销毁 / 最小化 / PID 不匹配而归还失败时，退而把键盘交给**成功归还页面且可见**的普通宿主，但这一步必须在 `hide()` **之后**重新验证前台仍然是本 quick host——hide 可能把前台交给系统挑中的另一个窗口，那是用户的去处，不能拿 hide 之前的旧查询当授权。绝不 show/restore 用户没有打开的窗口、不激活无关窗口，页面已销毁时不 focus 普通宿主。blur、外部点击、真实跳转和用户重新激活普通宿主都不触发归还——那已经是用户自己选的去处。
- **两个回退目标都不可用时，只回收已空的 quick 宿主**：`145e2613` Windows 原生验收记录了「普通宿主隐藏＋来源最小化」时 Esc 仍留下隐藏前台 HWND。Windows 的显式取消／页面失效在归还失败后，先确认 view 归还成功、quick 已隐藏且 `contentView.children` 确实为空，再于普通 fallback 之后重查原生前台仍是该 quick HWND，才销毁这个临时 `BaseWindow`，由系统选择下一个窗口。不主动销毁／重载共享页面，不恢复最小化窗口，不枚举或强行激活第三方应用；页面仍存活时，下次快捷键只新建空壳并借入原页面，旧宿主的迟到事件不能影响新宿主。活页面归还失败、残留 child view、hide 失败、原生探针未知／前台已换、已提交跳转、真实 blur、普通打开、app quit 和 macOS 均不走此回收。原生销毁抛错时保留已追踪句柄，不假装销毁成功；系统最终选择及真实收键仍需 Windows 验证。
- **已销毁页面不等于归还失败的活页面**：`a7b11a15` Windows 实测 WC 真正销毁后，两个宿主都已空，但 quick 隐藏前台仍持续约 96 秒。本地反例覆盖了已毁 view 重新挂载失败的路径（原生 `attachViewTo` 返回值尚未记录）；为处理这条失败路径，回收允许 owner 明确确认当前原始 `WebContents.isDestroyed() === true` 时免除「归还成功」前提。`getWebContents() === null`、renderer crash、缺失／抛错／非 true 的探针均不能冒充这个证明。已隐藏、空 children、最终原生所有权等其余门不变，不聚焦死页，也不在此分支自动重建页面。模型必须覆盖死 view 挂载失败与活 view 挂载失败两个不同情形；修复后的原生键盘归还仍待 Windows 复验。
- **普通宿主被真正重新激活时，归还 view 之后必须显式 focus 那个 owned WebContents**：窗口拿到原生焦点不等于页面拿到键盘，真机上会出现「普通窗 focused=true、轮次已结束、`document.hasFocus()` 仍为 false」。`BrowserWindow` 本来会隐式做这件事，`BaseWindow + WebContentsView` 必须显式补上。
- **「是否刚结束借用」和「是否该把键盘交给页面」是两个独立判断，不能用前者门控后者。** Electron 41.10.4 已实测 quick 宿主先 blur（借用已在那时结束、view 已归还），普通 focus 随后到达时已无借用可结束；测试另覆盖普通 focus 先到、借用仍在的顺序，不把该模拟顺序宣称为已完成真机验证。若按「本次事件是否结束了借用」门控，已实测的前一种次序会被整个跳过。因此 handler 先无条件调 `handleNormalHostFocus()` 结束仍存活的借用，再独立判断该窗口此刻是否真的是持有页面的 key host。
- Windows 另有已实测的分歧：来源窗口自然最小化后，普通 HWND 已成为 `GetForegroundWindow` / GUI focus root，但 Electron `isFocused()` 仍为 false，页面收不到键。新补丁在 blur / normal-host-focus 结束借用时，以及搁浅 quick 空壳回收后，必须等 view **成功**归还、unpark、hide 与缩放完成后，重新用现有原生探针确认前台确属这个可见、未最小化的普通宿主，才补 focus 它的 owned WebContents；不依赖再来一个 Electron focus 事件，也不调用窗口 focus/raise。探针失败、页面销毁/崩溃、归还失败或退出中都不做；此补偿仅限 Windows。旧报告未记录精确原生 focus 回调顺序，因此新补丁的触发时机和真实按键接收仍须 Windows 复验，模型测试通过不等于真机修复通过。
- **普通 Dashboard 关闭才结束页面寿命**：ordinary owner 的 `closed` 先结束借用、关闭其 WebContents，再 dispose 这个 Dashboard 的 quick 宿主；不能复用夹着已关闭旧 view 的空壳。此为整个 Dashboard 的明确关闭清理，区别于 Esc / 页面失效时仅回收已空壳、保留共享页面。下次普通打开／快捷键按需创建新的 Dashboard 页面和宿主，已关闭页面不再加入新宿主。
- 交出键盘的前置条件只看「页面和原生焦点现在在哪」：owner 自己正在移动焦点（`isSelfFocusing()`）、页面还在 quick 宿主（`isShown()`）、普通宿主处于 parked（透明且不收输入）、或该窗口并未真正持有原生焦点时，一律不交。只 focus 页面、不再 focus 窗口（会重入自己的 focus handler），并有重入标志兜底；不抢其他 app 的前台，不用 timer / Dock 切换 / `showInactive`。
- 就地（in-place）轮在普通宿主上：原生 focus **可以**把键盘交给页面，但**不得**因此结束本轮；没有任何轮次时，普通宿主获焦同样应该让它自己的页面拿到键盘（这是正常行为，不是需要阻止的情况）。
- 转移失败要**整体回滚**：`attachViewTo` 失败先把 view 挂回普通宿主（避免页面无父），再恢复 opacity/input，再作废该轮；`show()`/`focus()` 抛错同样走这条回滚，不能只 unpark 就返回。
- 数字是本轮的 **ID 所有权**，不是 snapshot 下标：明确进入时冻结前九个 `canFocus` 候选。
- **进入模式不重排用户已经在看的 Dashboard**：renderer 在本轮开始时抓一份小型 *presentation skeleton*（哪个 group 装了哪些 id、什么顺序），整轮按它渲染。原有 local / remote 分组、分组内卡片位置与 scroll 全部保持，活着的会话仍用完整 `createCard`（管理按钮一个不少），live 字段照常每秒更新。snapshot 重排不会让任何数字换行；编号会话消失时**在它原来的分组、原来的位置**留下不可用 tombstone，下方不上移；轮次中新出现的会话按稳定规则追加在该组冻结卡片之后，全新分组追加在末尾，都不补编号、不重复。退出该轮丢弃 skeleton，列表立刻恢复按 snapshot 自身排序。**不设置顶 quick 分组，不复制页面、不引入通用 layout 框架。**
- **scroll 位置由页面自己跨宿主保住**。Windows 实测借出/归还后 `#content` 偏移变成 0，但 WebContents、document token、卡片顺序与 `scrollHeight` 不变。触发层**仍未定位**：`replaceChildren` 重建、view 重挂、尺寸或焦点变化均不能排除。当前是窄恢复：只在转移可能发生的窗口内、偏移恰为 0、内容仍可滚动时恢复用户位置，并按当前上限 clamp；不声称已经预防了底层丢失。
- 滚轮/页面滚动键的一次 gesture 可以产生多帧 scroll，到 `scrollend` 或方向反转才结束，用户滚到顶同样有效。**pointer hold 与 gesture 分开**：pointerdown 只标记 held，pointerup/cancel 在清除 held 前读取最终实际位置（最后一个 scroll 事件可能尚未投递）；普通点击不会留下等待 scrollend 的假手势，也不清掉独立的滚轮动画。document capture 能识别落在 body 上的滚动键，但编辑控件/activeEdit 的光标操作、composition 按键以及按钮的 Space 不算 `#content` 滚动意图。一个已实测的原生语义例外是 **Mac 输入框中的无修饰 Home**：它会滚动页面而不是移动光标，必须保留到顶行为；Windows input Home 与 Mac input 方向键不继承此例外。renderer 的平台识别仅决定这一键盘语义，不替代原有唯一 feature gate。
- 归还转移由 main 先挂回 view、再发 `dashboard:quick-dismissed`，所以 armed 窗口覆盖整轮并延续到结束后的第一个信号（scroll / ResizeObserver / 下一次 1 秒 render），**不是收到通知才开始记**。全程不用额外 timer 或盲目重试。无 scrollend 时的方向判定仍是退路，不保证识别所有转移/手势时序；Windows 真机仍须复验。
- 空候选**同样开完整 Dashboard**（原空态 + 简短提示），只是不捕获数字：`activate` 返回 `no-candidates`，Esc / blur / ordinary open 一样收束该轮。快捷键绝不允许表现为“毫无反应”。
- 输入：主键区与小键盘按 `event.code` 分别跟踪物理键；全部数字键释放后静默 120ms 才提交，按住 / 连按只提交一次，auto-repeat 不改目标。静默期内的 `focusin`（进入可编辑元素）、`input`、`compositionstart/update` 与真实页面 blur 都取消待发跳转，且**提交前会再判一次 safe state**，避免在输入法/输入框拿到焦点后仍然跳走。Esc / Tab / Shift+Tab、外部点击、再次快捷键与普通 `showDashboard()` 都取消未提交的跳转。带修饰键、composing 中、或落在输入控件上的按键一律不拦截。
- IPC：`dashboard:quick-pending / enter / ready / activate / dismiss` 全部检查**唯一 owned WC + 当前真实 mainFrame + 精确 `dashboard.html` URL**。`activate` 只接受严格 `{ sessionId, revision }`（精确键集 + 合法整数），主进程再校验当前轮、宿主确实持有原生焦点、映射成员身份和最新 `canFocus`，并有 round 级 submitted once-guard。Kimi 手动配额的可信判定同样改走 owner 的真实 WC，**不放宽**。
- `submitted` 仅表示已交给现有 focus 路径，不代表已确认前台，也不 ack completion（数字路径禁止模拟点击带 ack 的按钮）。提交后不提前 hide/destroy，等原生 blur 完成交接。Windows 只在显式取消或页面失效时才由 `quick-select-origin-focus.js` 尝试归还来源前台（它自己校验「本窗口仍是前台」「来源可见、未最小化、PID 未变」）；失焦、外部点击和真实跳转都不执行该恢复。
- automation 警告等管理类 modal 必须先结束借用、把 Dashboard 提升为真正的普通窗口再创建，parent 由 owner 识别，不回落到置顶桌宠（在 Windows 上会变成可见但不可交互）。
- 借用期间的移动 / resize / scale 不写 `dashboardWindowBounds`，不污染 pendingUserBounds / retry debt（普通宿主此时是停放的空壳，它的几何事件不代表用户意图，连 debounce 都不排）。**普通宿主的 resize 也不得重排已借走的页面**：`dashboard-host.js` 记录当前持有 view 的窗口，布局只跟随它。主题背景色变化同时同步到 quick 宿主，避免下次借用闪出另一套配色。
- **页面缩放跟随 active host 的显示器**：quick 宿主的 `move` / `resize` 都会按它当前的 bounds 重算页面 scale；借用期间 Settings 触发的 `applyTextScaleToWindow()` 同样用 active host 解析页面 scale，不会把借出的页面按停放中的普通窗（或 default bounds）重新缩放。窗口的 minimum size、programmatic baseline 与 pendingUserBounds/retry debt 仍然只针对普通宿主，不写 quick bounds；退出借用按普通宿主的显示器恢复 scale。renderer 崩溃、页面关闭、ordinary open、dispose、应用退出都必须归还 view 并恢复 opacity/input，唯一的 webContents 恰好关闭一次。
- **quick 宿主的 close handler 不得拦下应用退出**：它平时无条件 `preventDefault()`（关掉的只是借用外壳，不该销毁 Dashboard），但 Electron 在 `will-quit` **之前**关闭所有窗口，所以只在 `will-quit` dispose 会把正常 Quit 卡死——Windows 实测菜单 Quit 后进程仍在，只剩一个隐藏的 quick BaseWindow。`main.js` 因此在 `before-quit` 就 dispose（`will-quit` 保留为幂等兜底），并把「应用正在退出」传给 owner，让 close handler 在退出中直接归还页面、放行关闭。用户自己关 quick 宿主仍然只是取消该轮并归还页面，不销毁普通 Dashboard。该 handler 与平台无关，macOS 的菜单 Quit 同样要真机复验。
- 两种 Dock 设置下的数字输入、取消、Terminal / Codex task 返回，以及 Windows Alt+Tab 与 cancel 归还，都必须真机验收，**不能从 unit tests 推断**。「普通 Dashboard 当前聚焦 + 数字 → 真实目标 → 返回」是独立一条 gate。

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
- Windows `hitWin`：原生 activation controller 可用时 Electron 始终 non-focusable；仅在非全屏前台时清除 `WS_EX_NOACTIVATE`，全屏时重新设置。生命周期内的 mouse-activation hook 防止 Chromium 返回 `MA_NOACTIVATEANDEAT`。controller / Koffi 或首次 hook 准备不可用时回退到旧的 Electron focusable 路径，优先保住桌面点击与拖拽，但不承诺全屏防抢焦点
- `win.showInactive()`：显示时不打断用户输入
- 渲染 / 输入窗口都依赖 `backgroundThrottling: false`；unfocused 节流会放大眼球追踪和输入恢复的时序问题
- 路径统一用 `path.join(__dirname, ...)`
- 透明无边框浮窗：`frame: false`, `transparent: true`, `alwaysOnTop: true`
- 使用单实例锁：`app.requestSingleInstanceLock()`
- 位置持久化到 `clawd-prefs.json`
- 多显示器钳制走 `clampToScreen()` + `getNearestWorkArea()`

## Known Limits

- Windows 原生 activation controller 依赖打包目标内的 Koffi；不可用时不调用会扰动前台的 Electron `setFocusable(false)`，而以旧的 focusable 输入窗降级，桌面交互仍可用但全屏点击可能短暂抢前台
- Windows 非全屏态会清除输入窗的 `WS_EX_NOACTIVATE`；点击桌宠可能短暂把 OS 前台归属切到 Clawd，即使 Electron `win.isFocused()` 仍为 false。mouse-activation hook 不消除这项既有的普通桌面限制
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
