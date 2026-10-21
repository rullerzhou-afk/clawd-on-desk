# 功能特性

[返回 README](../../README.zh-CN.md)

## 动画与交互

- **实时状态感知** — 通过 Agent hook 和日志轮询自动驱动动画
- **12 种动画状态** — 待机、思考、打字、建造、耳机律动、多子代理三球杂耍、报错、开心、通知、扫地、搬运、睡觉
- **Codex Pet 导入** — 在 `设置…` → `主题` 中导入 Codex Pet zip 包，Clawd 会把 atlas 动画适配成可管理主题
- **眼球追踪** — 待机状态下 Clawd 跟随鼠标，身体微倾，影子拉伸
- **睡眠序列** — 60 秒无活动 → 打哈欠 → 打盹 → 倒下 → 睡觉；移动鼠标触发惊醒弹起动画
- **点击反应** — 双击戳戳，连点 4 下东张西望
- **任意状态拖拽** — 随时抓起 Clawd（Pointer Capture 防止快甩丢失），松手恢复当前动画
- **极简模式** — 拖到右边缘或右键"极简模式"；Clawd 藏在屏幕边缘，悬停探头招手，通知/完成有迷你动画，抛物线跳跃过渡

## 权限审批气泡

- **桌面端权限审批** — 当具备权限能力的集成发出受支持请求时，Clawd 会弹出浮动卡片；仅状态集成仍保留自己的原生权限流程
- **允许 / 拒绝 / Agent 原生扩展项** — 一键批准或拒绝；如果该 Agent 支持，还会显示权限规则 / `Always` 一类的额外操作
- **权限处理模式** — 可选 **每次询问**、经过确认的 **仅提问弹窗**（显式支持 agent 的工具型请求）或 **自动放行**。自动放行会处理 adapter 判定为 automation-eligible 的请求——包括 Claude/Qwen 中名称非空但尚未识别的请求；缺失名称、不受支持的 decision shape，以及 CodeBuddy 的问题/计划仍回到原生流程。它会在重启后降级，每个符合条件的 live session 也可独立选择每次询问或仅工具模式。见[配置指南](setup-guide.zh-CN.md#权限处理自动化)
- **可选远程审批** — Telegram 和飞书 / Lark 可以镜像仍待处理的合格请求，同时保留本地气泡。通道失败不会产生远程决定，更不会自动拒绝：桌面请求继续等待；remote-only 请求只有在所有可用 client 都无决定后才回到 agent 原生流程
- **全局快捷键** — `Ctrl+Shift+Y` 允许、`Ctrl+Shift+N` 拒绝最新的权限气泡（仅在气泡可见时注册）
- **堆叠布局** — 多个权限请求从屏幕右下角向上堆叠
- **自动关闭** — 如果你先在终端回答了，气泡自动消失
- **按 Agent 单独关闭** — 打开 `设置…` → `AI 编程工具`，选中对应 Agent，关闭 `显示弹窗`，权限提示就会回到该 Agent 自己的终端 / TUI 里处理

## 远程通知

- **Telegram / 飞书（Lark）** — 交互式远程审批：把权限请求转发到手机，直接远程「允许 / 拒绝」，无需回到桌面
- **Slack** — **仅通知**：通过 Slack Incoming Webhook（或可选的 `xoxb-` Bot Token + 频道 ID）以带 Emoji 的 Block Kit 富文本卡片推送**任务完成**、**错误**和**权限请求**。本版本中 Slack 无法批准或拒绝——权限消息只是播报，仍需回到桌面 App 决定。与 Telegram / 飞书并列在远程审批渠道中配置；密钥保存在配置之外的本地 env 文件中（macOS / Linux 为 `0600`；Windows 无 POSIX 权限位，依赖 AppData 的 ACL），未配置或离线时均优雅降级。消息可能包含会话标题、目录名与主机名，**建议使用私有频道**——参见 [slack-notifications.md](slack-notifications.md)

## 会话智能

- **多会话追踪** — 所有已支持 Agent 的会话统一解析到最高优先级状态
- **子代理感知** — 1 个子代理耳机律动，2 个以上三球杂耍
- **会话 Dashboard + HUD** — 右键或托盘 → `打开 Dashboard` 查看活跃会话、最近事件、别名，并可跳转终端；Clawd 附近的轻量 HUD 会持续显示当前 live session
- **终端聚焦** — Dashboard / HUD 操作可跳转到指定会话的终端窗口；通知/注意状态会自动聚焦相关终端
- **进程存活检测** — 检测已崩溃/退出的受支持 Agent 进程，并在 10 秒内清理孤儿会话
- **启动恢复** — 如果 Clawd 重启时仍有受支持的 Agent 在运行，它会保持清醒等待后续事件，而不是直接睡觉

## 手机伴侣（PWA）

- **手机实时镜像** — 在 `设置…` → `Mobile / PWA` 开启后，用手机打开配对链接，「Clawd Mobile」网页应用就会实时显示各 Agent 会话和它们的状态
- **只读设计** — 局域网桥只向外广播状态，PWA 无法操作你的电脑（LAN PWA 审批仍在路线图上；Telegram 与飞书 / Lark 是另外两条已支持通道）
- **仅限局域网 + 令牌防护** — 配对需要令牌，令牌自动轮换并带宽限期，可一键重新生成或重置访问
- **可安装** — 标准 PWA，添加到主屏幕即可获得类原生体验
> 手机伴侣这条线——从最初原型到令牌轮换——由核心贡献者 [@Bynlk](https://github.com/Bynlk) 一手打造并持续主导，他还维护着自带原生安卓 App 的姊妹项目 [clawd-on-mobile](https://github.com/Bynlk/clawd-on-mobile)。

## 系统

- **点击穿透** — 透明区域的点击直接穿透到下方窗口，只有角色本体可交互
- **位置记忆** — 重启后 Clawd 回到上次的位置（包括极简模式）
- **单实例锁** — 防止重复启动
- **自动启动** — Claude Code 的 SessionStart hook 可在 Clawd 未运行时自动拉起
- **免打扰模式** — 右键或托盘菜单进入休眠，桌宠停止反应，直到手动唤醒。免打扰屏蔽的是「需要你处理」的事，不是状态播报：远程**完成通知**（Telegram / Slack）仍会送达，因为那正是你离开桌面的意义。免打扰期间不弹权限气泡——Codex、opencode 和 MiMo Code 会回退到原生命令行确认，Claude Code 和 CodeBuddy 会回退到各自内置的权限确认流程。WorkBuddy 仅同步状态与通知；Antigravity 和 Pi 都是仅状态同步集成
- **提示音效** — 任务完成和权限请求时播放短音效（可从系统托盘或设置中开关；10 秒冷却，免打扰模式自动静音）
- **系统托盘** — 免打扰、开机自启、检查更新
- **国际化** — 支持英文、简体中文、繁体中文、韩文、日文、Português (Brasil) 和 Español 界面，可在设置 → 通用中切换
- **自动更新** — 检查 GitHub release；Windows 退出时安装 NSIS 更新包，macOS/Linux 源码运行时通过 `git pull` + 重启自动更新

## 多显示器支持

Clawd 适配多显示器场景：按启动时所在显示器做等比缩放，竖屏显示器有尺寸加成防止宠物过小，也可以跨屏拖动。

<p align="center"><sub>想看多显示器下的实际效果？可以<a href="../../assets/videos/clawd-multi-monitor-demo.mp4">打开仓库里的演示视频</a>。</sub></p>

## 自定义主题

Clawd 支持自定义主题——用你自己的角色和动画替换默认的螃蟹。如果你已有 Codex Pet 包，也可以在 `设置…` → `主题` → `导入宠物 zip` 直接导入，Clawd 会自动把 atlas 转成托管主题。

**快速开始：**
1. 先生成一个主题骨架：
   ```bash
   node scripts/create-theme.js my-theme
   # 或
   npm run create-theme -- my-theme
   ```
   不传参数也可以，脚手架会自动在你的用户主题目录里生成下一个可用的 `my-theme`。
2. 编辑 `theme.json`，创建你的素材（SVG、GIF、APNG、WebP、PNG、JPG 或 JPEG）
3. 重启 Clawd，或打开 `设置…` → `主题` 选择你的主题

**最小可用主题：** 1 个 SVG（带眼球追踪的 idle）+ 7 个 GIF/APNG 文件（thinking、working、error、happy、notification、sleeping、waking）。关闭眼球追踪后所有状态都可以用任意格式。

校验主题：
```bash
node scripts/validate-theme.js path/to/your-theme
```

`设置…` → `主题` 里的主题卡现在会显示能力角标，例如 `Tracked idle`、`静态主题`、`Mini`、`直睡`、`无 reactions`，方便用户在切换前看出主题差异。

详见 [docs/guides/guide-theme-creation.md](guide-theme-creation.md)（主题创作完整指南，含入门/进阶/高级路径、theme.json 字段说明、素材规范）。

> 第三方 SVG 文件会被自动消毒，确保安全。

## 未来计划

一些我们想探索的方向：

- Codex 终端聚焦（通过 `codex.exe` PID 反查进程树）
- Hook 卸载脚本（干净移除应用）
- LAN PWA 手机伴侣：在浏览器中远程审批权限（推进中，由 [@Bynlk](https://github.com/Bynlk) 主导）；Telegram 与飞书 / Lark 是另外两条已支持的远程审批通道
