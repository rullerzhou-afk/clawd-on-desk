<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
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
  <img src="assets/hero.gif" alt="Clawd 桌宠动画演示：像素螃蟹会随 AI 编程助手状态实时切换，在睡觉、思考、工具运行时打字、单个子代理时戴耳机律动、多个子代理并行时三球杂耍、权限请求弹出时提醒、任务完成后庆祝。支持 Claude Code、Codex、Cursor、Copilot、Gemini、Pi、OpenClaw 等。">
</p>

Clawd 住在你的桌面上，实时感知 AI 编程助手正在做什么。发起一个长任务，起身去做点别的，等螃蟹告诉你任务完成了再回来。

你提问时它思考，工具运行时它打字，子代理工作时它会戴耳机律动或三球杂耍，审批权限时它弹卡片，任务完成时它庆祝，你离开时它睡觉。内置三套主题：**Clawd**（像素螃蟹）、**Calico**（三花猫）和 **Cloudling**（云宝），支持自定义主题，也支持导入 Codex Pet 动画包。

> 支持 Windows 11、macOS 和 Ubuntu/Linux。Windows 发布包提供独立的 x64 和 ARM64 安装包。源码运行需要 Node.js。支持 **Claude Code**、**Codex CLI**、**Copilot CLI**、**Gemini CLI**、**Cursor Agent**、**CodeBuddy**、**Kiro CLI**、**Kimi Code CLI（Kimi-CLI）**、**opencode**、**Pi**、**OpenClaw** 与 **Hermes Agent**。

## 功能特性

### 多 Agent 支持
- **Claude Code** — 通过 command hook + HTTP 权限 hook 完整集成
- **Codex CLI** — official hooks 为主、JSONL 日志轮询（`~/.codex/sessions/`）兜底，自动注册并支持真实权限气泡
- **Copilot CLI** — 通过 `~/.copilot/hooks/hooks.json` 配置 command hook
- **Gemini CLI** — 通过 `~/.gemini/settings.json` 配置 command hook（Clawd 启动时自动注册，或执行 `npm run install:gemini-hooks`）
- **Antigravity CLI (agy)** — 通过 `~/.gemini/config/hooks.json` 配置 command hook（已有 Antigravity 配置时 Clawd 启动会自动注册，或执行 `npm run install:antigravity-hooks`）；**仅状态同步**：Clawd 不会为 agy 弹任何权限气泡，所有 Allow / Deny / Always-allow 都在 agy 自己的终端菜单里完成
- **Cursor Agent** — [Cursor IDE hooks](https://cursor.com/docs/agent/hooks)，配置在 `~/.cursor/hooks.json`（Clawd 启动时自动注册，或执行 `npm run install:cursor-hooks`）
- **CodeBuddy** — 通过与 Claude Code 兼容的 command hook + HTTP 权限 hook 集成，配置写入 `~/.codebuddy/settings.json`（Clawd 启动时自动注册，或执行 `node hooks/codebuddy-install.js`）
- **Kiro CLI** — command hooks 注入到 `~/.kiro/agents/` 下的自定义 agent 配置中，并自动创建一个 `clawd` agent；Clawd 每次启动时都会重新从内置 `kiro_default` 同步它，尽量保持与默认 agent 一致。macOS 与 Windows 上状态动效已验证可用；需要时可用 `kiro-cli --agent clawd` 或在会话内执行 `/agent swap clawd` 启用 hooks（Clawd 启动时自动注册，或执行 `npm run install:kiro-hooks`）
- **Kimi Code CLI（Kimi-CLI）** — 通过 `~/.kimi/config.toml`（`[[hooks]]` 条目）配置 command hooks（Clawd 启动时自动注册，或执行 `npm run install:kimi-hooks`）
- **opencode** — [plugin 集成](https://opencode.ai/docs/plugins)，写入 `~/.config/opencode/opencode.json`（Clawd 启动时自动注册）；零延迟事件流、Allow/Always/Deny 权限气泡、`task` 工具分派并行子代理时自动播放建筑动画
- **Pi** — 通过全局 extension 集成，写入 `~/.pi/agent/extensions/clawd-on-desk`（Clawd 启动时自动注册，或执行 `npm run install:pi-extension`）；仅同步交互式 Pi 会话生命周期和工具活动状态，并保留 Pi 默认 YOLO 行为
- **OpenClaw** — 通过 `~/.openclaw/openclaw.json` 中的 plugin 路径做状态感知（OpenClaw 配置已存在时 Clawd 启动会自动注册，或执行 `npm run install:openclaw-plugin`）；Phase 1 面向本地 `openclaw tui --local` 会话，只驱动动画，不接权限气泡和终端聚焦
- **Hermes Agent** — [plugin 集成](https://hermes-agent.org/)，写入 Hermes 的托管 plugin 目录（检测到 Hermes 后 Clawd 启动时自动注册，或执行 `npm run install:hermes-plugin`）；支持状态、会话、SessionEnd 和终端聚焦
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
- **桌面端权限审批** — 当 Claude Code、Codex CLI、CodeBuddy 或 opencode 请求受支持的工具权限时，Clawd 会弹出浮动卡片，无需切回终端
- **允许 / 拒绝 / Agent 原生扩展项** — 一键批准或拒绝；如果该 Agent 支持，还会显示权限规则 / `Always` 一类的额外操作
- **全局快捷键** — `Ctrl+Shift+Y` 允许、`Ctrl+Shift+N` 拒绝最新的权限气泡（仅在气泡可见时注册）
- **堆叠布局** — 多个权限请求从屏幕右下角向上堆叠
- **自动关闭** — 如果你先在终端回答了，气泡自动消失
- **按 Agent 单独关闭** — 打开 `设置…` → `Agents`，选中对应 Agent，关闭 `显示弹窗`，权限提示就会回到该 Agent 自己的终端 / TUI 里处理

### 会话智能
- **多会话追踪** — 所有已支持 Agent 的会话统一解析到最高优先级状态
- **子代理感知** — 1 个子代理耳机律动，2 个以上三球杂耍
- **会话 Dashboard + HUD** — 右键或托盘 → `打开 Dashboard` 查看活跃会话、最近事件、别名，并可跳转终端；Clawd 附近的轻量 HUD 会持续显示当前 live session
- **终端聚焦** — Dashboard / HUD 操作可跳转到指定会话的终端窗口；通知/注意状态会自动聚焦相关终端
- **进程存活检测** — 检测已崩溃/退出的受支持 Agent 进程，并在 10 秒内清理孤儿会话
- **启动恢复** — 如果 Clawd 重启时仍有受支持的 Agent 在运行，它会保持清醒等待后续事件，而不是直接睡觉

### 系统
- **点击穿透** — 透明区域的点击直接穿透到下方窗口，只有角色本体可交互
- **位置记忆** — 重启后 Clawd 回到上次的位置（包括极简模式）
- **单实例锁** — 防止重复启动
- **自动启动** — Claude Code 的 SessionStart hook 可在 Clawd 未运行时自动拉起
- **免打扰模式** — 右键或托盘菜单进入休眠，所有 hook 事件静默，直到手动唤醒。免打扰期间不弹权限气泡——Codex 和 opencode 会回退到原生命令行确认，Claude Code 和 CodeBuddy 会回退到各自内置的权限确认流程。Antigravity 和 Pi 都是仅状态同步集成
- **提示音效** — 任务完成和权限请求时播放短音效（右键菜单可开关；10 秒冷却，免打扰模式自动静音）
- **系统托盘** — 调大小（S/M/L）、免打扰、语言切换、开机自启、检查更新
- **国际化** — 支持英文、简体中文、繁体中文、韩文和日文界面，右键菜单或托盘切换
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

安装后启动 Clawd；支持的 agent hooks / plugins 会在启动时自动同步。

只有在参与开发、测试未发布代码或调试集成时，才建议从源码运行。源码安装会下载 Electron / 打包工具，并生成较大的 `node_modules`。

```bash
# 克隆仓库
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# 安装依赖
npm install

# 启动 Clawd（启动时会自动注册 Claude Code hooks；如需预先手动注册，可单独执行 `node hooks/install.js`）
npm start
```

**Claude Code** 和 **Codex CLI** 会自动注册 hooks，开箱即用。**Gemini CLI**、**Cursor Agent**、**CodeBuddy**、**Kiro CLI**、**Kimi Code CLI（Kimi-CLI）**、**opencode**、**Pi**、**OpenClaw**、**Hermes Agent** 在已安装前提下会在 Clawd 启动时自动同步（OpenClaw 还需要已有配置）；**Copilot CLI** 仍需一次性手动配置 hooks。也涵盖远程 SSH、WSL 及平台说明（macOS / Linux）：**[docs/guides/setup-guide.zh-CN.md](docs/guides/setup-guide.zh-CN.md)**

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
- Copilot CLI hooks 自动注册（像 Claude Code 那样开箱即用）
- 主题注册表 + 应用内下载
- Hook 卸载脚本（干净移除应用）

## 参与贡献

Clawd on Desk 是一个社区驱动的项目。欢迎提 Bug、提需求、提 PR —— 在 [Issues](https://github.com/rullerzhou-afk/clawd-on-desk/issues) 里聊或直接提交 PR。

### 维护者

<table>
  <tr>
    <td align="center" valign="top" width="140"><a href="https://github.com/rullerzhou-afk"><img src="https://github.com/rullerzhou-afk.png" width="72" style="border-radius:50%" /><br /><sub><b>@rullerzhou-afk</b><br />鹿鹿 · 创建者</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="72" style="border-radius:50%" /><br /><sub><b>@YOIMIYA66</b><br />维护者</sub></a></td>
  </tr>
</table>

### 贡献者

感谢每一位让 Clawd 变得更好的贡献者：

<details>
<summary>展开全部 48 位贡献者</summary>

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
<a href="https://github.com/tomaioo"><img src="https://github.com/tomaioo.png" width="50" style="border-radius:50%" /></a>
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

</details>

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
