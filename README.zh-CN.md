<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd 桌宠</h1>
<p align="center">
  <a href="README.md">English</a>
</p>

一个能实时感知 AI 编程助手工作状态的桌面宠物。Clawd 住在你的屏幕上——你提问时它思考，工具运行时它打字，子代理工作时它杂耍，审批权限时它弹卡片，任务完成时它庆祝，你离开时它睡觉。

> 支持 Windows 11 和 macOS。需要 Node.js。支持 **Claude Code**、**Codex CLI** 和 **Copilot CLI**。

## 功能特性

### 多 Agent 支持
- **Claude Code** — 通过 command hook + HTTP 权限 hook 完整集成
- **Codex CLI** — 自动轮询 JSONL 日志（`~/.codex/sessions/`），无需配置
- **Copilot CLI** — 通过 `~/.copilot/hooks/hooks.json` 配置 command hook
- **多 Agent 共存** — 三个 Agent 可同时运行，Clawd 独立追踪每个会话

### 动画与交互
- **实时状态感知** — 通过 Agent hook 和日志轮询自动驱动动画
- **12 种动画状态** — 待机、思考、打字、建造、杂耍、指挥、报错、开心、通知、扫地、搬运、睡觉
- **眼球追踪** — 待机状态下 Clawd 跟随鼠标，身体微倾，影子拉伸
- **睡眠序列** — 60 秒无活动 → 打哈欠 → 打盹 → 倒下 → 睡觉；移动鼠标触发惊醒弹起动画
- **点击反应** — 双击戳戳，连点 4 下东张西望
- **任意状态拖拽** — 随时抓起 Clawd（Pointer Capture 防止快甩丢失），松手恢复当前动画
- **极简模式** — 拖到右边缘或右键"极简模式"；Clawd 藏在屏幕边缘，悬停探头招手，通知/完成有迷你动画，抛物线跳跃过渡

### 权限审批气泡

<img src="assets/screenshot-permission-bubble.png" width="320" alt="权限气泡">

- **桌面端权限审批** — Claude Code 请求工具权限时，Clawd 弹出浮动卡片，无需切回终端
- **允许 / 拒绝 / 建议** — 一键批准、拒绝，或应用权限规则（如"始终允许 Read"）
- **堆叠布局** — 多个权限请求从屏幕右下角向上堆叠
- **自动关闭** — 如果你先在终端回答了，气泡自动消失

### 会话智能

<img src="assets/screenshot-context-menu.png" width="420" alt="右键菜单与会话列表">

- **多会话追踪** — 多个 Claude Code 会话自动解析到最高优先级状态
- **子代理感知** — 1 个子代理杂耍，2 个以上指挥
- **终端聚焦** — 右键 Clawd → 会话菜单，一键跳转到对应会话的终端窗口；通知/注意状态自动聚焦相关终端
- **进程存活检测** — 检测已崩溃/退出的 Claude Code 进程，10 秒内清理孤儿会话
- **启动恢复** — 如果 Clawd 在 Claude Code 运行期间重启，会保持清醒等待 hook，而不是直接睡觉

### 系统
- **点击穿透** — 透明区域的点击直接穿透到下方窗口，只有角色本体可交互
- **位置记忆** — 重启后 Clawd 回到上次的位置（包括极简模式）
- **单实例锁** — 防止重复启动
- **自动启动** — Claude Code 的 SessionStart hook 可在 Clawd 未运行时自动拉起
- **免打扰模式** — 右键或托盘菜单进入休眠，所有 hook 事件静默，直到手动唤醒
- **系统托盘** — 调大小（S/M/L）、免打扰、语言切换、开机自启、检查更新
- **国际化** — 支持英文和中文界面，右键菜单或托盘切换
- **自动更新** — 检查 GitHub release；Windows 退出时安装 NSIS 更新包，macOS 打开 release 页面

## 状态映射

| Claude Code 事件 | 桌宠状态 | 动画 | |
|---|---|---|---|
| 无活动 | 待机 | 眼球跟踪 | <img src="assets/gif/clawd-idle.gif" width="200"> |
| UserPromptSubmit | 思考 | 思考泡泡 | <img src="assets/gif/clawd-thinking.gif" width="200"> |
| PreToolUse / PostToolUse | 工作（打字） | 打字 | <img src="assets/gif/clawd-typing.gif" width="200"> |
| PreToolUse（3+ 会话） | 工作（建造） | 建造 | <img src="assets/gif/clawd-building.gif" width="200"> |
| SubagentStart（1 个） | 杂耍 | 杂耍 | <img src="assets/gif/clawd-juggling.gif" width="200"> |
| SubagentStart（2+） | 指挥 | 指挥 | <img src="assets/gif/clawd-conducting.gif" width="200"> |
| PostToolUseFailure | 报错 | ERROR + 冒烟 | <img src="assets/gif/clawd-error.gif" width="200"> |
| Stop / PostCompact | 注意 | 开心蹦跳 | <img src="assets/gif/clawd-happy.gif" width="200"> |
| PermissionRequest / Notification | 通知 | 惊叹跳跃 | <img src="assets/gif/clawd-notification.gif" width="200"> |
| PreCompact | 扫地 | 扫帚清扫 | <img src="assets/gif/clawd-sweeping.gif" width="200"> |
| WorktreeCreate | 搬运 | 搬箱子 | <img src="assets/gif/clawd-carrying.gif" width="200"> |
| 60 秒无事件 | 睡觉 | 睡眠序列 | <img src="assets/gif/clawd-sleeping.gif" width="200"> |

### 极简模式

将 Clawd 拖到屏幕右边缘（或右键 →"极简模式"）进入。Clawd 藏在屏幕边缘只露出半身，鼠标悬停时探出来招手。

| 触发 | 极简反应 | |
|---|---|---|
| 默认 | 呼吸 + 眨眼 + 偶尔手臂晃动 + 眼球追踪 | <img src="assets/gif/clawd-mini-idle.gif" width="120"> |
| 鼠标悬停 | 探出身体 + 招手（向屏幕内侧滑出 25px） | <img src="assets/gif/clawd-mini-peek.gif" width="120"> |
| 通知 / 权限请求 | 感叹号弹出 + >< 挤眼 | <img src="assets/gif/clawd-mini-alert.gif" width="120"> |
| 任务完成 | 花花 + ^^ 眯眼 + 星星闪烁 | <img src="assets/gif/clawd-mini-happy.gif" width="120"> |
| Peek 时点击 | 退出极简模式（抛物线跳回） | |

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# 安装依赖
npm install

# 注册 Claude Code hooks
node hooks/install.js

# 启动 Clawd
npm start
```

### macOS 说明

- **源码运行**（`npm start`）：Intel 和 Apple Silicon 均可直接使用。
- **DMG 安装包**：未签名 Apple 开发者证书，macOS Gatekeeper 会拦截。解决方法：
  - 右键点击应用 → **打开** → 在弹窗中点击 **打开**，或
  - 在终端运行 `xattr -cr /Applications/Clawd\ on\ Desk.app`

## 工作原理

```
状态同步（command hook，非阻塞）：
  Claude Code 事件
    → hooks/clawd-hook.js（从 stdin 读取事件名 + session_id）
    → HTTP POST 到 127.0.0.1:23333
    → main.js 状态机（多会话 + 优先级 + 最小显示时长）
    → IPC 到 renderer.js（SVG 预加载 + 交叉淡入切换）

权限审批（HTTP hook，阻塞）：
  Claude Code PermissionRequest
    → HTTP POST 到 127.0.0.1:23333/permission
    → 气泡窗口（bubble.html）显示允许 / 拒绝 / 建议按钮
    → 用户点击 → HTTP 响应 → Claude Code 继续执行
```

Clawd 以透明无边框、始终置顶、不可聚焦的 Electron 窗口运行，透明区域点击穿透到下方窗口。永远不会抢焦点或打断你的工作流。

## 手动测试

```bash
# 触发指定状态
curl -X POST http://127.0.0.1:23333/state \
  -H "Content-Type: application/json" \
  -d '{"state":"working","session_id":"test"}'

# 循环播放所有动画（每个 8 秒）
bash test-demo.sh

# 循环播放极简模式动画
bash test-mini.sh
```

## 项目结构

```
src/
  main.js            # Electron 主进程：状态机、HTTP 服务、窗口管理、托盘、光标轮询
  renderer.js        # 渲染进程：拖拽、点击反应、SVG 切换、眼球跟踪
  preload.js         # IPC 桥接（contextBridge）
  bubble.html        # 权限气泡 UI（工具名、命令预览、允许/拒绝/建议按钮）
  preload-bubble.js  # 气泡窗口 IPC 桥接
  index.html         # 主窗口页面结构
hooks/
  clawd-hook.js      # Claude Code command hook（零依赖，<1s，事件 → 状态 → HTTP POST）
  install.js         # 安全注册 hook 到 ~/.claude/settings.json（追加不覆盖）
  auto-start.js      # SessionStart hook：Clawd 未运行时自动拉起（<500ms）
extensions/
  vscode/            # VS Code 扩展，通过 URI 协议聚焦终端 tab
assets/
  svg/               # 40 个像素风 SVG 动画（含 8 个极简模式，CSS 关键帧驱动）
  gif/               # 录制的 GIF（用于文档展示）
```

## 已知限制

| 限制 | 说明 |
|------|------|
| **Codex CLI：无法跳转终端** | Codex 通过 JSONL 日志轮询，日志中不含终端 PID，点击桌宠无法跳转到 Codex 终端。Claude Code 和 Copilot CLI 正常。 |
| **Codex CLI：Windows hooks 禁用** | Codex 在 Windows 上硬编码禁用了 hooks，因此走日志轮询，延迟约 1.5 秒（hook 方式几乎无延迟）。 |
| **Copilot CLI：需手动配置 hooks** | Copilot 需要手动创建 `~/.copilot/hooks/hooks.json`。Claude Code 和 Codex 开箱即用。 |
| **Copilot CLI：无权限气泡** | Copilot 的 `preToolUse` 只支持拒绝，无法做完整的允许/拒绝审批流。权限气泡仅支持 Claude Code。 |
| **macOS 自动更新** | 无 Apple 代码签名，macOS 用户需从 GitHub Releases 手动下载更新。 |
| **Electron 主进程无自动化测试** | 单元测试覆盖了 agent 配置和日志轮询，但状态机、窗口管理、托盘等 Electron 逻辑暂无自动化测试。 |

### 未来计划

一些我们想探索的方向：

- Codex 终端聚焦（通过 `codex.exe` PID 反查进程树）
- Copilot CLI hooks 自动注册（像 Claude Code 那样开箱即用）
- 状态切换音效（目前被 Electron autoplay policy 阻塞）
- 自定义角色皮肤 / 动画
- Hook 卸载脚本（干净移除应用）

## 参与贡献

Clawd on Desk 是一个社区驱动的项目。欢迎提 Bug、提需求、提 PR —— 在 [Issues](https://github.com/rullerzhou-afk/clawd-on-desk/issues) 里聊或直接提交 PR。

### 贡献者

感谢每一位让 Clawd 变得更好的贡献者：

- [@PixelCookie-zyf](https://github.com/PixelCookie-zyf) — macOS 适配、终端聚焦、权限气泡验证
- [@yujiachen-y](https://github.com/yujiachen-y) — 随 Claude Code 自动启动
- [@AooooooZzzz](https://github.com/AooooooZzzz) — ELECTRON_RUN_AS_NODE 启动修复、Windows 10 兼容
- [@purefkh](https://github.com/purefkh) — macOS Dock 可见性修复

## 致谢

- Clawd 像素画参考自 [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto)
- Clawd 角色设计归属 [Anthropic](https://www.anthropic.com)。本项目为社区作品，与 Anthropic 无官方关联。

## 许可证

MIT
