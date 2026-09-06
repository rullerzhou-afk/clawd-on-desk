<p align="center">
  <img src="assets/icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd 桌宠</h1>
<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="README.zh-TW.md">繁體中文</a>
  ·
  <a href="README.ko-KR.md">한국어</a>
  ·
  <a href="README.ja-JP.md">日本語</a>
  ·
  <a href="README.es.md">Español</a>
</p>
<p align="center">
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/releases"><img src="https://img.shields.io/github/v/release/rullerzhou-afk/clawd-on-desk" alt="Version"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
</p>
<p align="center">
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/stargazers"><img src="https://img.shields.io/github/stars/rullerzhou-afk/clawd-on-desk?style=flat&logo=github&color=yellow" alt="Stars"></a>
  <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge-flat.svg" alt="Mentioned in Awesome Claude Code"></a>
</p>

<p align="center">
  <img src="assets/hero.gif" alt="Clawd 桌宠动画演示：像素螃蟹会随 AI 编程助手状态实时切换，在睡觉、思考、工具运行时打字、单个子代理时戴耳机律动、多个子代理并行时三球杂耍、权限请求弹出时提醒、任务完成后庆祝。支持 Claude Code、Codex、Cursor、Copilot、Gemini、Antigravity、Qwen、CodeWhale、Pi、OpenClaw 等。">
</p>

Clawd 住在你的桌面上，实时感知 AI 编程助手正在做什么。发起一个长任务，起身去做点别的，等螃蟹告诉你任务完成了再回来。

你提问时它思考，工具运行时它打字，子代理工作时它会戴耳机律动或三球杂耍，审批权限时它弹卡片，任务完成时它庆祝，你离开时它睡觉。内置三套主题：**Clawd**（像素螃蟹）、**Calico**（三花猫）和 **Cloudling**（云宝），支持自定义主题，也支持导入 Codex Pet 动画包。

> 支持 Windows 11、macOS 和 Ubuntu/Linux。Windows 发布包提供独立的 x64 和 ARM64 安装包。源码运行需要 Node.js。支持 **Claude Code**、**Codex CLI**、**Copilot CLI**、**Gemini CLI**、**Antigravity CLI (agy)**、**Cursor Agent**、**CodeBuddy**、**WorkBuddy**、**Kiro CLI**、**Kimi Code CLI（Kimi-CLI）**、**Qwen Code**、**ZCode**、**CodeWhale**、**opencode**、**MiMo Code**、**Pi**、**OpenClaw**、**Hermes Agent**、**Qoder**、**QoderWork**、**QwenWork（千问办公）**、**Reasonix CLI** 与 **DeepSeek Harness**。

## 功能特性

### 多 Agent 支持
- **Claude Code** — 通过 command hook + HTTP 权限 hook 完整集成
- **Codex CLI** — official hooks 为主、JSONL 日志轮询（`~/.codex/sessions/`）兜底，默认自动同步并支持真实权限气泡
- **Copilot CLI** — 可选 command hook，写入 `~/.copilot/hooks/hooks.json`（从 Settings → Agents 安装；手动 JSON 备选见 Copilot 指南）
- **Gemini CLI** — 可选 command hook，写入 `~/.gemini/settings.json`（从 Settings → Agents 安装，或执行 `npm run install:gemini-hooks`）
- **Antigravity CLI (agy)** — 可选 command hook，写入 `~/.gemini/config/hooks.json`（从 Settings → Agents 安装，或执行 `npm run install:antigravity-hooks`）；**仅状态同步**：Clawd 不会为 agy 弹任何权限气泡，所有 Allow / Deny / Always-allow 都在 agy 自己的终端菜单里完成
- **Cursor Agent** — 可选 [Cursor IDE hooks](https://cursor.com/docs/agent/hooks)，写入 `~/.cursor/hooks.json`（从 Settings → Agents 安装，或执行 `npm run install:cursor-hooks`）
- **CodeBuddy** — 可选 Claude Code 兼容 command hook + HTTP 权限 hook，写入 `~/.codebuddy/settings.json`（从 Settings → Agents 安装，或执行 `node hooks/codebuddy-install.js`）
- **自定义 HTTP Agent** — 在 Settings 注册其他本机可执行文件，再由应用或 adapter 主动向 Clawd 的动态 `/state` 地址上报生命周期事件。“注册”不会安装 hook，也不会让普通应用自动上报；v1 仅支持状态，权限决定留在应用自己的界面中。详见[自定义 HTTP Agent 指南](docs/guides/custom-agent-http.md)。
- **WorkBuddy** — 可选 Claude Code 兼容 command hook，当前写入 `~/.workbuddy-ai/settings.json`，旧版使用 `~/.workbuddy/settings.json`（从 Settings → Agents 安装，或执行 `node hooks/workbuddy-install.js`）。仅状态 + 通知：桌面应用在其原生沙箱与 GUI 中处理权限，因此 Clawd 不为它注册权限 hook
- **Kiro CLI** — 可选 command hooks，注入到 `~/.kiro/agents/` 下的自定义 agent 配置中，并自动创建一个 `clawd` agent；安装集成后 Clawd 会继续从内置 `kiro_default` 同步它，尽量保持与默认 agent 一致。macOS 与 Windows 上状态动效已验证可用；需要时可用 `kiro-cli --agent clawd` 或在会话内执行 `/agent swap clawd` 启用 hooks
- **Kimi Code CLI（Kimi-CLI）** — 可选 command hooks，写入 `~/.kimi/config.toml`（`[[hooks]]` 条目）（从 Settings → Agents 安装，或执行 `npm run install:kimi-hooks`）
- **Qwen Code** — 可选 command hooks，写入 `~/.qwen/settings.json`（从 Settings → Agents 安装，或执行 `npm run install:qwen-hooks`）；支持状态追踪和 Qwen `PermissionRequest` 桌面权限气泡
- **ZCode** — 可选状态 + 阻塞式 `PermissionRequest` hooks，写入 `~/.zcode/cli/config.json` 的 `hooks.events.*`（从 Settings → Agents 安装，或执行 `npm run install:zcode-hooks`）；Clawd 提供人工 Allow/Deny 权限气泡，global 与 per-session 自动审批保持 defer。Clawd 会保留用户显式设置的全局或单项 `enabled:false`，并且不会覆盖第三方 `PermissionRequest` hook
- **CodeWhale** — 可选 state-only lifecycle hooks，写入 `~/.codewhale/config.toml`（`[[hooks.hooks]]` 条目）（从 Settings → Agents 安装，或执行 `npm run install:codewhale-hooks`）；Phase 1 只驱动 idle、thinking、working、sleeping、error、attention、sweeping 等状态动画，不接权限气泡和子代理追踪
- **Reasonix CLI** — 可选 state-only command hooks，写入 `<Reasonix home>/settings.json`（macOS/Linux 为 `~/.reasonix/settings.json`，Windows 为 `%APPDATA%\reasonix\settings.json`；从 Settings → Agents 安装，或执行 `npm run install:reasonix-hooks`）；Phase 1 只驱动生命周期、工具调用、通知、压缩和子代理结束动效，权限决策仍留在 Reasonix 自己的终端流程
- **opencode** — 可选 [plugin 集成](https://opencode.ai/docs/plugins)，写入 `~/.config/opencode/` 下当前生效的文件（`config.json` → `opencode.json` → `opencode.jsonc`，后者优先）（从 Settings → Agents 安装，或执行 `node hooks/opencode-install.js`）；支持零延迟事件流和 Allow/Always/Deny 权限气泡。`task` 工具产生的子会话是 headless，不参与可见的多会话动画聚合
- **MiMo Code** — 可选 [plugin 集成](https://opencode.ai/docs/plugins)，写入 `~/.config/mimocode/` 下当前生效的文件（`config.json` → `mimocode.json` → 默认 `mimocode.jsonc`，后者优先；从 Settings → Agents 安装，或执行 `npm run install:mimocode-plugin`）；与 opencode 共享 `@mimo-ai/plugin` SDK 和权限行为，`task` 子会话同样是 headless
- **Pi** — 可选全局 extension，写入 `~/.pi/agent/extensions/clawd-on-desk`（从 Settings → Agents 安装，或执行 `npm run install:pi-extension`）；仅同步交互式 Pi 会话生命周期和工具活动状态，并保留 Pi 默认 YOLO 行为
- **OpenClaw** — 可选 state-only plugin，写入 `~/.openclaw/openclaw.json`（从 Settings → Agents 安装，或执行 `npm run install:openclaw-plugin`；OpenClaw 还需要已有配置）；Phase 1 面向本地 `openclaw tui --local` 会话，只驱动动画，不接权限气泡和终端聚焦
- **Hermes Agent** — 可选 [plugin 集成](https://hermes-agent.org/)，写入 Hermes 的托管 plugin 目录（从 Settings → Agents 安装，或执行 `npm run install:hermes-plugin`）；支持状态、会话、SessionEnd、终端聚焦和受支持的权限气泡
- **Qoder** — 可选 state-only command hooks，写入 `~/.qoder/settings.json`（从 Settings → Agents 安装，或执行 `npm run install:qoder-hooks`）；Phase 1 只驱动动画，权限请求仅作为通知观察，Clawd 不弹权限气泡也不代答，所有 Allow / Deny 都在 Qoder 自己的权限流程里完成
- **QoderWork** — 可选 state-only command hooks，写入 `~/.qoderwork/settings.json`（从 Settings → Agents 安装，或执行 `npm run install:qoderwork-hooks`）；Phase 1 驱动动画与 Session HUD，权限事件作为正常工作流静默观察（不闪通知），Clawd 不弹权限气泡也不代答，所有 Allow / Deny 都在 QoderWork 自己的权限流程里完成
- **QwenWork（千问办公）** — 可选 hook-only / state-only command hooks，写入 `~/.QwenWorkCN/settings.json`（从 Settings → Agents 安装，或执行 `npm run install:qwenwork-hooks`，卸载用 `npm run uninstall:qwenwork-hooks`）；当前只支持 macOS / Windows 桌面端——[qwenwork.cn/download](https://qwenwork.cn/download) 没有 Linux 客户端，因此也不提供 WSL Pair。Phase 1 驱动动画与 Session HUD；`PermissionRequest` / `PermissionDenied` 仅作观察并映射为 `working`，hook stdout 恒为 `{}`，Clawd 不产生 allow/deny，权限唯一决策者是 QwenWork 原生流程。无 startup recovery：桌面主进程是长驻进程，不代表正在跑任务
- **DeepSeek Harness** — 实验性的 web-profile-only 集成，通过 Clawd 管理的 DSH 进程内插件工作。公开 session 事件按 session 顺序驱动 Clawd 状态，公开的阻塞式 `approval/request` 可显示 Allow Once / Deny 气泡；无决定时始终回到 DSH 原生 web answerer。`ask_user_question` 完全留在 DSH 原生 provider，Clawd 从不读取 DSH projection 存储。详见 [DeepSeek Harness 指南](docs/guides/dsh-setup.md)
- **多 Agent 共存** — 多个 Agent 可同时运行，Clawd 独立追踪每个会话

### 动画与交互
- **实时状态感知** — 通过 Agent hook 和日志轮询自动驱动动画
- **12 种动画状态** — 待机、思考、打字、建造、耳机律动、多子代理三球杂耍、报错、开心、通知、扫地、搬运、睡觉
- **Codex Pet 导入** — 在 `设置…` → `主题` 中导入 Codex Pet zip 包，Clawd 会把 atlas 动画适配成可管理主题
- **眼球追踪** — 待机状态下 Clawd 跟随鼠标，身体微倾，影子拉伸
- **睡眠序列** — 60 秒无活动 → 打哈欠 → 打盹 → 倒下 → 睡觉；移动鼠标触发惊醒弹起动画
- **点击反应** — 双击戳戳，连点 4 下东张西望
- **任意状态拖拽** — 随时抓起 Clawd（Pointer Capture 防止快甩丢失），松手恢复当前动画
- **极简模式** — 拖到右边缘或右键"极简模式"；Clawd 藏在屏幕边缘，悬停探头招手，通知/完成有迷你动画，抛物线跳跃过渡

### 权限审批气泡
- **桌面端权限审批** — 当具备权限能力的集成发出受支持请求时，Clawd 会弹出浮动卡片；仅状态集成仍保留自己的原生权限流程
- **允许 / 拒绝 / Agent 原生扩展项** — 一键批准或拒绝；如果该 Agent 支持，还会显示权限规则 / `Always` 一类的额外操作
- **权限处理模式** — 可选 **每次询问**、经过确认的 **仅提问弹窗**（显式支持 agent 的工具型请求）或 **自动放行**。自动放行会处理 adapter 判定为 automation-eligible 的请求——包括 Claude/Qwen 中名称非空但尚未识别的请求；缺失名称、不受支持的 decision shape，以及 CodeBuddy 的问题/计划仍回到原生流程。它会在重启后降级，每个符合条件的 live session 也可独立选择每次询问或仅工具模式。见[配置指南](docs/guides/setup-guide.zh-CN.md#权限处理自动化)
- **可选远程审批** — Telegram 和飞书 / Lark 可以镜像仍待处理的合格请求，同时保留本地气泡。通道失败不会产生远程决定，更不会自动拒绝：桌面请求继续等待；remote-only 请求只有在所有可用 client 都无决定后才回到 agent 原生流程
- **全局快捷键** — `Ctrl+Shift+Y` 允许、`Ctrl+Shift+N` 拒绝最新的权限气泡（仅在气泡可见时注册）
- **堆叠布局** — 多个权限请求从屏幕右下角向上堆叠
- **自动关闭** — 如果你先在终端回答了，气泡自动消失
- **按 Agent 单独关闭** — 打开 `设置…` → `Agents`，选中对应 Agent，关闭 `显示弹窗`，权限提示就会回到该 Agent 自己的终端 / TUI 里处理

### 远程通知
- **Telegram / 飞书（Lark）** — 交互式远程审批：把权限请求转发到手机，直接远程「允许 / 拒绝」，无需回到桌面
- **Slack** — **仅通知**：通过 Slack Incoming Webhook（或可选的 `xoxb-` Bot Token + 频道 ID）以带 Emoji 的 Block Kit 富文本卡片推送**任务完成**、**错误**和**权限请求**。本版本中 Slack 无法批准或拒绝——权限消息只是播报，仍需回到桌面 App 决定。与 Telegram / 飞书并列在远程审批渠道中配置；密钥保存在配置之外的本地 env 文件中（macOS / Linux 为 `0600`；Windows 无 POSIX 权限位，依赖 AppData 的 ACL），未配置或离线时均优雅降级。消息可能包含会话标题、目录名与主机名，**建议使用私有频道**——参见 [slack-notifications.md](docs/guides/slack-notifications.md)

### 会话智能
- **多会话追踪** — 所有已支持 Agent 的会话统一解析到最高优先级状态
- **子代理感知** — 1 个子代理耳机律动，2 个以上三球杂耍
- **会话 Dashboard + HUD** — 右键或托盘 → `打开 Dashboard` 查看活跃会话、最近事件、别名，并可跳转终端；Clawd 附近的轻量 HUD 会持续显示当前 live session
- **终端聚焦** — Dashboard / HUD 操作可跳转到指定会话的终端窗口；通知/注意状态会自动聚焦相关终端
- **进程存活检测** — 检测已崩溃/退出的受支持 Agent 进程，并在 10 秒内清理孤儿会话
- **启动恢复** — 如果 Clawd 重启时仍有受支持的 Agent 在运行，它会保持清醒等待后续事件，而不是直接睡觉

### 手机伴侣（PWA）
- **手机实时镜像** — 在 `设置…` → `Mobile / PWA` 开启后，用手机打开配对链接，「Clawd Mobile」网页应用就会实时显示各 Agent 会话和它们的状态
- **只读设计** — 局域网桥只向外广播状态，PWA 无法操作你的电脑（LAN PWA 审批仍在路线图上；Telegram 与飞书 / Lark 是另外两条已支持通道）
- **仅限局域网 + 令牌防护** — 配对需要令牌，令牌自动轮换并带宽限期，可一键重新生成或重置访问
- **可安装** — 标准 PWA，添加到主屏幕即可获得类原生体验
> 手机伴侣这条线——从最初原型到令牌轮换——由核心贡献者 [@Bynlk](https://github.com/Bynlk) 一手打造并持续主导，他还维护着自带原生安卓 App 的姊妹项目 [clawd-on-mobile](https://github.com/Bynlk/clawd-on-mobile)。

### 系统
- **点击穿透** — 透明区域的点击直接穿透到下方窗口，只有角色本体可交互
- **位置记忆** — 重启后 Clawd 回到上次的位置（包括极简模式）
- **单实例锁** — 防止重复启动
- **自动启动** — Claude Code 的 SessionStart hook 可在 Clawd 未运行时自动拉起
- **免打扰模式** — 右键或托盘菜单进入休眠，桌宠停止反应，直到手动唤醒。免打扰屏蔽的是「需要你处理」的事，不是状态播报：远程**完成通知**（Telegram / Slack）仍会送达，因为那正是你离开桌面的意义。免打扰期间不弹权限气泡——Codex、opencode 和 MiMo Code 会回退到原生命令行确认，Claude Code 和 CodeBuddy 会回退到各自内置的权限确认流程。WorkBuddy 仅同步状态与通知；Antigravity 和 Pi 都是仅状态同步集成
- **提示音效** — 任务完成和权限请求时播放短音效（可从系统托盘或设置中开关；10 秒冷却，免打扰模式自动静音）
- **系统托盘** — 免打扰、开机自启、检查更新
- **国际化** — 支持英文、简体中文、繁体中文、韩文、日文、Português (Brasil) 和 Español 界面，可在设置 → 通用中切换
- **自动更新** — 检查 GitHub release；Windows 退出时安装 NSIS 更新包，macOS/Linux 源码运行时通过 `git pull` + 重启自动更新

## 动画一览

<table>
  <tr>
    <td align="center"><img src="assets/gif/clawd-idle.gif" width="100"><br><sub>待机</sub></td>
    <td align="center"><img src="assets/gif/clawd-thinking.gif" width="100"><br><sub>思考泡泡</sub></td>
    <td align="center"><img src="assets/gif/clawd-typing.gif" width="100"><br><sub>打字</sub></td>
    <td align="center"><img src="assets/gif/clawd-building.gif" width="100"><br><sub>建造</sub></td>
    <td align="center"><img src="assets/gif/clawd-headphones-groove.gif" width="100"><br><sub>耳机律动</sub></td>
    <td align="center"><img src="assets/gif/clawd-juggling.gif" width="100"><br><sub>三球杂耍</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/calico-idle.gif" width="80"><br><sub>三花待机</sub></td>
    <td align="center"><img src="assets/gif/calico-thinking.gif" width="80"><br><sub>三花思考</sub></td>
    <td align="center"><img src="assets/gif/calico-typing.gif" width="80"><br><sub>三花打字</sub></td>
    <td align="center"><img src="assets/gif/calico-building.gif" width="80"><br><sub>三花建造</sub></td>
    <td align="center"><img src="assets/gif/calico-juggling.gif" width="80"><br><sub>三花杂耍</sub></td>
    <td align="center"><img src="assets/gif/calico-conducting.gif" width="80"><br><sub>三花指挥</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/cloudling-idle.gif" width="120"><br><sub>云宝待机</sub></td>
    <td align="center"><img src="assets/gif/cloudling-thinking.gif" width="120"><br><sub>云宝思考</sub></td>
    <td align="center"><img src="assets/gif/cloudling-typing.gif" width="120"><br><sub>云宝打字</sub></td>
    <td align="center"><img src="assets/gif/cloudling-building.gif" width="120"><br><sub>云宝建造</sub></td>
    <td align="center"><img src="assets/gif/cloudling-juggling.gif" width="120"><br><sub>云宝杂耍</sub></td>
    <td align="center"><img src="assets/gif/cloudling-conducting.gif" width="120"><br><sub>云宝指挥</sub></td>
  </tr>
</table>

完整事件映射表、极简模式、点击彩蛋见：**[docs/guides/state-mapping.zh-CN.md](docs/guides/state-mapping.zh-CN.md)**

## 多显示器支持

Clawd 适配多显示器场景：按启动时所在显示器做等比缩放，竖屏显示器有尺寸加成防止宠物过小，也可以跨屏拖动。

<p align="center"><sub>想看多显示器下的实际效果？可以<a href="assets/videos/clawd-multi-monitor-demo.mp4">打开仓库里的演示视频</a>。</sub></p>

## 快速开始

普通用户建议直接从 **[GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest)** 下载最新预构建安装包：

- **Windows**：`Clawd-on-Desk-Setup-<version>-x64.exe` 或 `Clawd-on-Desk-Setup-<version>-arm64.exe`
- **macOS**：`.dmg`
- **Linux**：`.AppImage` 或 `.deb`

macOS 以及 Linux x86_64 也可以用 Homebrew 安装：

```bash
brew install --cask clawd-on-desk
```

安装后启动 Clawd。全新安装只会自动同步 Claude Code 和 Codex；其他本机 agent 需要用到时，再到 **Settings → Agents** 安装对应集成。

只有在参与开发、测试未发布代码或调试集成时，才建议从源码运行。源码安装会下载 Electron / 打包工具，并生成较大的 `node_modules`。

```bash
# 克隆仓库
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# 安装依赖
npm install

# 启动 Clawd（启动时会自动注册 Claude Code 和 Codex hooks；如需预先手动注册 Claude，可单独执行 `node hooks/install.js`）
npm start
```

**Claude Code**、**Codex CLI** 会自动注册 hooks，开箱即用。**Copilot CLI**、**Gemini CLI**、**Antigravity CLI (agy)**、**Cursor Agent**、**CodeBuddy**、**WorkBuddy**、**Kiro CLI**、**Kimi Code CLI（Kimi-CLI）**、**Qwen Code**、**ZCode**、**CodeWhale**、**opencode**、**MiMo Code**、**Pi**、**OpenClaw**、**Hermes Agent**、**Qoder**、**QoderWork**、**QwenWork（千问办公）**、**Reasonix CLI**、**DeepSeek Harness** 需要先在 **Settings → Agents** 安装对应集成；安装且启用后，Clawd 才会在启动时继续同步。也涵盖远程 SSH、WSL 及平台说明（macOS / Linux）：**[docs/guides/setup-guide.zh-CN.md](docs/guides/setup-guide.zh-CN.md)**

想在远程服务器上跑 Claude Code / Codex CLI 并把状态和权限气泡转发到本地 Clawd？请使用应用内 **Settings → 远程 SSH → 部署 / 修复 Hook**。完整步骤、共享服务器隔离边界、Doctor 边界和 FAQ 见：**[docs/guides/guide-remote-ssh.zh-CN.md](docs/guides/guide-remote-ssh.zh-CN.md)**

关于 `Codex + WSL` 的官方现状、Clawd 当前实现边界、以及为什么容易被误解，见：**[docs/guides/codex-wsl-clarification.zh-CN.md](docs/guides/codex-wsl-clarification.zh-CN.md)**

## 已知限制

部分 Agent 存在功能差异（无权限气泡、轮询延迟、无法跳转终端等）。完整列表见：**[docs/guides/known-limitations.zh-CN.md](docs/guides/known-limitations.zh-CN.md)**

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

详见 [docs/guides/guide-theme-creation.md](docs/guides/guide-theme-creation.md)（主题创作完整指南，含入门/进阶/高级路径、theme.json 字段说明、素材规范）。

> 第三方 SVG 文件会被自动消毒，确保安全。

### 未来计划

一些我们想探索的方向：

- Codex 终端聚焦（通过 `codex.exe` PID 反查进程树）
- 主题注册表 + 应用内下载
- Hook 卸载脚本（干净移除应用）
- LAN PWA 手机伴侣：在浏览器中远程审批权限（推进中，由 [@Bynlk](https://github.com/Bynlk) 主导）；Telegram 与飞书 / Lark 是另外两条已支持的远程审批通道

## 参与贡献

Clawd on Desk 是一个社区驱动的项目。欢迎提 Bug、提需求、提 PR —— 在 [Issues](https://github.com/rullerzhou-afk/clawd-on-desk/issues) 里聊或直接提交 PR。

### 维护者

<table>
  <tr>
    <td align="center" valign="top" width="140"><a href="https://github.com/rullerzhou-afk"><img src="https://github.com/rullerzhou-afk.png" width="72" style="border-radius:50%" /><br /><sub><b>@rullerzhou-afk</b><br />鹿鹿 · 创建者</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="72" style="border-radius:50%" /><br /><sub><b>@YOIMIYA66</b><br />维护者</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/Bynlk"><img src="https://github.com/Bynlk.png" width="72" style="border-radius:50%" /><br /><sub><b>@Bynlk</b><br />核心贡献者 · Mobile / PWA</sub></a></td>
  </tr>
</table>

### 贡献者

感谢每一位让 Clawd 变得更好的贡献者：

<a href="https://github.com/PixelCookie-zyf"><img src="https://github.com/PixelCookie-zyf.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/yujiachen-y"><img src="https://github.com/yujiachen-y.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/AooooooZzzz"><img src="https://github.com/AooooooZzzz.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/purefkh"><img src="https://github.com/purefkh.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Tobeabellwether"><img src="https://github.com/Tobeabellwether.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Jasonhonghh"><img src="https://github.com/Jasonhonghh.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/crashchen"><img src="https://github.com/crashchen.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/hongbigtou"><img src="https://github.com/hongbigtou.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/InTimmyDate"><img src="https://github.com/InTimmyDate.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/NeizhiTouhu"><img src="https://github.com/NeizhiTouhu.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/xu3stones-cmd"><img src="https://github.com/xu3stones-cmd.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Ye-0413"><img src="https://github.com/Ye-0413.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/WanfengzzZ"><img src="https://github.com/WanfengzzZ.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/androidZzT"><img src="https://github.com/androidZzT.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/TaoXieSZ"><img src="https://github.com/TaoXieSZ.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/ssly"><img src="https://github.com/ssly.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/stickycandy"><img src="https://github.com/stickycandy.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Rladmsrl"><img src="https://github.com/Rladmsrl.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Kevin7Qi"><img src="https://github.com/Kevin7Qi.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/sefuzhou770801-hub"><img src="https://github.com/sefuzhou770801-hub.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Tonic-Jin"><img src="https://github.com/Tonic-Jin.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/seoki180"><img src="https://github.com/seoki180.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/sophie-haynes"><img src="https://github.com/sophie-haynes.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/PeterShanxin"><img src="https://github.com/PeterShanxin.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/CHIANGANGSTER"><img src="https://github.com/CHIANGANGSTER.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/JaeHyeon-KAIST"><img src="https://github.com/JaeHyeon-KAIST.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/hhhzxyhhh"><img src="https://github.com/hhhzxyhhh.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/TVpoet"><img src="https://github.com/TVpoet.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/zeus6768"><img src="https://github.com/zeus6768.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/anhtrinh919"><img src="https://github.com/anhtrinh919.png" width="50" style="border-radius:50%" /></a>
<sub>tomaioo</sub>
<a href="https://github.com/v-avuso"><img src="https://github.com/v-avuso.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/livlign"><img src="https://github.com/livlign.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/tongguang2"><img src="https://github.com/tongguang2.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Ziy1-Tan"><img src="https://github.com/Ziy1-Tan.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/tatsuyanakanogaroinc"><img src="https://github.com/tatsuyanakanogaroinc.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/yeonhub"><img src="https://github.com/yeonhub.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/joshua-wu"><img src="https://github.com/joshua-wu.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/nmsn"><img src="https://github.com/nmsn.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/sunnysonx"><img src="https://github.com/sunnysonx.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/YuChenYunn"><img src="https://github.com/YuChenYunn.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/jhseo-b"><img src="https://github.com/jhseo-b.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Hwasowl"><img src="https://github.com/Hwasowl.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/XiangZheng2002"><img src="https://github.com/XiangZheng2002.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/keiyo118"><img src="https://github.com/keiyo118.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/pan93412"><img src="https://github.com/pan93412.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/taehwanis"><img src="https://github.com/taehwanis.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/linnin233"><img src="https://github.com/linnin233.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/xiyouMc"><img src="https://github.com/xiyouMc.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Bynlk"><img src="https://github.com/Bynlk.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/zxypro1"><img src="https://github.com/zxypro1.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/NeroAyase"><img src="https://github.com/NeroAyase.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/divergentD"><img src="https://github.com/divergentD.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Ne9roni"><img src="https://github.com/Ne9roni.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/QingXB"><img src="https://github.com/QingXB.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/29206394"><img src="https://github.com/29206394.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Tsdsj"><img src="https://github.com/Tsdsj.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/godlockin"><img src="https://github.com/godlockin.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/sLingli"><img src="https://github.com/sLingli.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/ustin-star"><img src="https://github.com/ustin-star.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/cod3hulk"><img src="https://github.com/cod3hulk.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/lxgxhsy"><img src="https://github.com/lxgxhsy.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/rebootcrab-blip"><img src="https://github.com/rebootcrab-blip.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/zhaoxv210"><img src="https://github.com/zhaoxv210.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/serenNan"><img src="https://github.com/serenNan.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/IatomicreactorI"><img src="https://github.com/IatomicreactorI.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/quantai1314"><img src="https://github.com/quantai1314.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Git-creat7"><img src="https://github.com/Git-creat7.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/undownding"><img src="https://github.com/undownding.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/chrono-meta"><img src="https://github.com/chrono-meta.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Yike-Ye"><img src="https://github.com/Yike-Ye.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/xiaoshidefeng"><img src="https://github.com/xiaoshidefeng.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/yanguibao1997"><img src="https://github.com/yanguibao1997.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/JasonZH6600"><img src="https://github.com/JasonZH6600.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/V1staz"><img src="https://github.com/V1staz.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/royhuang91"><img src="https://github.com/royhuang91.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Schlaflied"><img src="https://github.com/Schlaflied.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/KaiC5504"><img src="https://github.com/KaiC5504.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/jiaxuan1101"><img src="https://github.com/jiaxuan1101.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/kkirito16"><img src="https://github.com/kkirito16.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/200780381"><img src="https://github.com/200780381.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Dxy2326"><img src="https://github.com/Dxy2326.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/lurui1997"><img src="https://github.com/lurui1997.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/JesmonX"><img src="https://github.com/JesmonX.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/chen86860"><img src="https://github.com/chen86860.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/LinYsssss"><img src="https://github.com/LinYsssss.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/He-wei-gui"><img src="https://github.com/He-wei-gui.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/liugou27"><img src="https://github.com/liugou27.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/YOOGOMJA"><img src="https://github.com/YOOGOMJA.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/anupamme"><img src="https://github.com/anupamme.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/anthonyonazure"><img src="https://github.com/anthonyonazure.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/weed33834"><img src="https://github.com/weed33834.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/arismarioneves"><img src="https://github.com/arismarioneves.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/wang4433"><img src="https://github.com/wang4433.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/shengmai-justin"><img src="https://github.com/shengmai-justin.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/aaronWool"><img src="https://github.com/aaronWool.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Zamaniego"><img src="https://github.com/Zamaniego.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/CheeseAgent"><img src="https://github.com/CheeseAgent.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/RS-Nocsi"><img src="https://github.com/RS-Nocsi.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Cobb04"><img src="https://github.com/Cobb04.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/eugenewang5425"><img src="https://github.com/eugenewang5425.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/draintovmasyan783-creator"><img src="https://github.com/draintovmasyan783-creator.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Yueh-H"><img src="https://github.com/Yueh-H.png" width="50" style="border-radius:50%" /></a>

## 致谢

- Clawd 像素画参考自 [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto)
- 本项目在 [LINUX DO](https://linux.do/) 社区推广

## 许可证

源代码基于 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0）开源。

**美术素材和内置主题素材（包括 `assets/` 与 `themes/*/assets/`）不适用 AGPL-3.0 许可。** 所有权利归各自版权持有人所有，详见 [assets/LICENSE](assets/LICENSE) 及下列说明。

- **Clawd** 角色设计归属 [Anthropic](https://www.anthropic.com)。本项目为非官方粉丝作品，与 Anthropic 无官方关联。
- **三花猫** 素材由 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) 创作，保留所有权利。
- **Cloudling（云宝）** 素材由 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) 创作，保留所有权利。云宝的视觉方向包含对 OpenAI Codex logo 的致敬；Codex / OpenAI 相关标识仍归 OpenAI 所有，本项目与 OpenAI 无官方关联，也未获 OpenAI 背书。
- **第三方画师作品**：版权归各自作者所有。
