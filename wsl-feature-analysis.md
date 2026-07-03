# Clawd on Desk — WSL 自动发现 & 多来源 Session 区分 & 一键配对

## 项目地址

https://github.com/rullerzhou-afk/clawd-on-desk

---

## 1. 优化后的方案总览

### 核心理念：Windows 是控制中心，WSL 无需 clone 完整仓库

**现状痛点：**
- 用户需要在 WSL 里 `git clone` 整个 repo → 手动 `cp` hook 文件 → 手动跑 `node hooks/install.js`
- 不会自动发现 WSL 里已安装的 Claude
- 开了多个 Claude（Windows CLI / WSL Ubuntu / WSL Debian / VS Code 终端 / Cursor 终端）时，Dashboard 只能看到一堆 "local"，无法区分来源

**优化后体验：**

```
Clawd 启动（Windows）
 │
 ├─ 自动扫描 Windows 本地 agent  ──────────────┐
 ├─ 自动扫描 WSL 发行版中 agent  ──────────────┤  无感知
 ├─ 自动扫描 VS Code / Cursor 终端 ────────────┘
 │
 └─ 用户打开 Settings → Agents
    ┌──────────────────────────────────────────────┐
    │ Claude Code                         (已连接) │
    │   ├─ Windows CLI ✅                         │
    │   └─ WSL:Ubuntu ⚠  需安装 → [一键配对]      │
    │                                              │
    │ Codex CLI                           (已连接) │
    │   └─ WSL:Ubuntu ⚠  需安装 → [一键配对]      │
    └──────────────────────────────────────────────┘

用户点 [一键配对] → Clawd 自动：
  1. 通过 wsl.exe 把 hook 文件写入 WSL 内 ~/.claude/hooks/
  2. 执行 node ~/.claude/hooks/install.js
  3. 显示结果：WSL:Ubuntu ✅

此后：
  - Windows CLI Claude → Dashboard 显示 "🖥 Windows CLI"
  - WSL Ubuntu Claude   → Dashboard 显示 "🐧 WSL:Ubuntu"
  - VS Code 里的 Claude → Dashboard 显示 "📝 VSCode"
```

---

## 2. 关键实现细节

### 2.1 一键配对（One-Click Pairing）— 替代 repo clone

**原理：** Clawd Windows 端已经持有所有 hook JS 文件（打包在 asar 里），不需要用户在 WSL 里单独 clone 仓库。

**实现方式：** 新建 `src/wsl-deploy.js`

```
wsl-deploy.js
├─ deployToWsl(distro, agentDescriptor)
│   ├─ step 1: 检测 WSL 内 Node.js 是否存在
│   │   wsl -d <distro> -- bash -c "command -v node || which node"
│   │
│   ├─ step 2: 在 WSL 内创建 ~/.claude/hooks/ 目录
│   │   wsl -d <distro> -- mkdir -p ~/.claude/hooks/
│   │
│   ├─ step 3: 将 hook 文件从 Windows 侧传入 WSL
│   │   方式 A（推荐）: 把文件内容 base64 → wsl 内解码写入
│   │     wsl -d <distro> -- bash -c "echo 'BASE64CONTENT' | base64 -d > ~/.claude/hooks/clawd-hook.js"
│   │   方式 B（备选）: 利用 WSL2 共享挂载 /mnt/<drive>/...
│   │     把 hook 文件先写到 C:\Users\<User>\AppData\Local\Temp\clawd-wsl-hooks\
│   │     wsl -d <distro> -- cp /mnt/c/Users/.../Temp/clawd-wsl-hooks/*.js ~/.claude/hooks/
│   │
│   ├─ step 4: 执行 install.js（本地模式，因为 WSL localhost 可直达 Windows）
│   │   wsl -d <distro> -- bash -c "cd ~/.claude/hooks && node install.js"
│   │   注意：不传 --remote，WSL 内 localhost 直连 Windows，PID 收集有意义
│   │
│   └─ 进度事件:
│       runtime.emit("wsl-deploy-progress", { distro, step, status, message })
│
├─ 需要的 hook 文件列表（最小集合）:
│   server-config.js
│   json-utils.js
│   shared-process.js
│   clawd-hook.js
│   context-usage.js          ← clawd-hook.js require 的
│   install.js
│   codex-hook.js
│   codex-install.js
│   codex-install-utils.js
│   codex-remote-monitor.js
│   codex-session-index.js
│   codex-subagent-fields.js
│   copilot-hook.js
│   copilot-install.js
│   以及各 agent 的 install 脚本（按需）
│
└─ WSL 内 Node.js 路径解析:
    wsl -d <distro> -- bash -lic "command -v node"
    install.js 生成的 hook command 需要 embed 绝对路径，因为 hook runner 的 PATH 可能很受限（与 resolveNodeBin 同理）
```

**为什么不用 --remote 模式：**
- `--remote` 抑制了 PID/editor/pidChain/tmux 收集 (clawd-hook.js L424-443)
- WSL 内 PID 对 Windows 无意义，但可以通过 `wsl.exe` 关联到 Windows 侧的进程
- 更好的做法：hook 是非 remote 模式但标记 host_type，PID 收集在 WSL 内仍然有价值

**实际上应该怎么做：**
- hook 安装时注入环境变量 `CLAWD_WSL_DISTRO=Ubuntu`
- `clawd-hook.js` 在 `!process.env.CLAWD_REMOTE` 分支里检查 `process.env.CLAWD_WSL_DISTRO`
- 如果存在：照常收集 WSL 内部 PID，同时设置 `body.wsl_distro` 和调整 `body.host`
- 如果不存在：现有的 Windows/macOS 逻辑不变

### 2.2 自动发现所有 Agent 实例

#### 2.2.1 WSL 发行版枚举 + Agent 检测

```
src/wsl-utils.js（新建）
├─ getWslDistributions()
│   执行: wsl.exe -l -q
│   返回: [{ name: "Ubuntu", default: true, running: true }, ...]
│   注意:
│   - 去掉空行、\r\n 换行符
│   - 过滤掉 "docker-desktop" 等非用户发行版（可选，加个 exclude 列表）
│   - wsl.exe 路径: C:\Windows\System32\wsl.exe（通过 which/where 解析）
│
├─ execInWsl(distro, command, opts?)
│   执行: wsl.exe -d <distro> -- bash -c "<command>"
│   封装 spawnAndWait（复用 remote-ssh-deploy.js 的模式）
│   返回: { code, stdout, stderr }
│
├─ resolveWslNodePath(distro)
│   执行: wsl -d <distro> -- bash -lic "command -v node"
│   返回: node 绝对路径或 null
│
└─ getWslHomeDir(distro)
    执行: wsl -d <distro> -- bash -c "echo \$HOME"
    返回: WSL 内的 home 路径
```

#### 2.2.2 扩展 agent-installation-detector.js

```
detectAgentInstallations() 扩展:
├─ 原有逻辑: 检测 Windows 本地 agent（不变）
│
└─ 新增: detectWslAgentInstallations()
    ├─ 调用 getWslDistributions() 获取发行版列表
    ├─ 对每个 distro × 每个 agent descriptor:
    │   ├─ 构造 WSL 内的路径:
    │   │   homeDir = getWslHomeDir(distro)
    │   │   parentDir = path.join(homeDir, ".claude")  (以 Claude Code 为例)
    │   │
    │   ├─ 检查 agent 是否安装在 WSL 内:
    │   │   方式 A: 检查 WSL 内 parentDir 是否存在
    │   │     wsl -d <distro> -- bash -c "test -d ~/.claude && echo yes"
    │   │   方式 B: 检查 WSL 内是否有 claude 命令
    │   │     wsl -d <distro> -- bash -c "command -v claude"
    │   │
    │   └─ 返回: { distro, agentId, agentName, detectedInstalled, confidence, ... }
    │
    └─ 返回结构合并到 detection.wslAgents[]

扩展到更多来源（后续 Phase 可做）:
├─ detectVsCodeClaudeInstances()
│   检查 ~/.vscode/extensions/ 是否有相关扩展
│   检查 VS Code 终端进程是否有 claude 子进程
│
└─ detectWindowsTerminalInstances()
    检查 wt.exe 子进程中是否有 claude
```

### 2.3 多来源 Session 区分

#### 2.3.1 Hook 脚本层：注入来源标记

```
Hook 安装时（install.js）:

Windows 本地安装:
  command: "node ~/.claude/hooks/clawd-hook.js"
  → clawd-hook.js 通过 process.platform + PID 分析自动判断为 "windows-local"

WSL 安装（通过 wsl-deploy.js）:
  command: "CLAWD_WSL_DISTRO=Ubuntu CLAWD_HOST_TYPE=wsl node ~/.claude/hooks/clawd-hook.js"
  → clawd-hook.js 读取 CLAWD_WSL_DISTRO / CLAWD_HOST_TYPE
  → POST body 增加 { wsl_distro: "Ubuntu", host_type: "wsl" }

VS Code 终端（自动检测或手动安装）:
  扩展 extensions/vscode/extension.js 注入环境变量
  或在 hook command 前加 CLAWD_EDITOR=vscode
  → POST body 增加 { editor: "vscode" }
```

#### 2.3.2 状态路由层：解析来源

```
server-route-state.js handleStatePost:
  已有字段:
    data.host     → 字符串，用于 SSH remote 场景
    data.editor   → "code" 或 "cursor"，已有逻辑 (L124)
    data.platform → mac/linux/win32，已有逻辑 (L134)

  新增解析:
    data.wsl_distro  → 字符串，如 "Ubuntu"
    data.host_type   → 字符串，如 "wsl" / "local" / "ssh"

  host 字段合成规则:
    if data.host_type === "wsl" && data.wsl_distro:
      effectiveHost = `wsl:${data.wsl_distro}`
    elif data.host_type === "ssh" && data.host:
      effectiveHost = data.host           // 已有逻辑
    else:
      effectiveHost = "local"             // 已有逻辑
```

#### 2.3.3 Session 标识层：记录来源

```
session-alias.js:
  sessionAliasKey(host, agentId, sessionId, options)
  已有: parts = [host, agentId, sessionId]
  新增: 无需改动，host 已经包含来源信息

  Dashboard/HUD 渲染:
  session 标签可以从 key 中解析:
    "wsl:Ubuntu|claude-code|abc123" → 🐧 WSL:Ubuntu · Claude Code
    "local|claude-code|def456"      → 🖥 Windows · Claude Code
    "local|claude-code|def456" + editor=vscode → 📝 VSCode · Claude Code
    "raspberrypi|claude-code|ghi789" → 🔗 pi · Claude Code (已有)
```

### 2.4 VS Code / Cursor 终端来源识别

**已有机制：**
- `extensions/vscode/extension.js` 已存在，目前只做终端聚焦
- `clawd-hook.js` 的 `createPidResolver` 已经检测 `detectedEditor`（通过进程树分析）
- `server-route-state.js` L124 已解析 `data.editor`

**增强方案：**
```
扩展 VS Code 扩展功能（低优先级，可选 Phase 3）:
  1. 在 VS Code 终端打开时自动注入环境变量 CLAWD_EDITOR=vscode
  2. VS Code 扩展监听终端创建事件 → writeTerminalEnv()
  3. 或者在 clawd-hook.js 中增强 detectedEditor 的检测逻辑

简化的版本（已有的 PID 树分析就够了）:
  clawd-hook.js 的 createPidResolver 已经通过进程树分析
  检测到 code.exe/cursor.exe，并设置 detectedEditor
  这个能力已经 buildStateBody 在 L429 使用！
  所以 VS Code 里的 Claude 已经是自动识别的 — 只是 Dashboard 展示时可以优化
```

---

## 3. 实施路线（按 PR 粒度拆分）

### Phase 1（第一个 PR）：WSL 自动发现 + 一键配对

**范围：** 只做核心，不碰 session 标记

**改动文件：**

| 文件 | 操作 | 内容 |
|------|------|------|
| `src/wsl-utils.js` | **新建** | `getWslDistributions()`, `execInWsl()`, `resolveWslNodePath()`, `getWslHomeDir()` |
| `src/wsl-deploy.js` | **新建** | `deployToWsl(distro, agentDescriptor)`, 文件 base64 传输 + install.js 执行 |
| `src/agent-installation-detector.js` | **修改** | 新增 `detectWslAgentInstallations()` 函数，`detectAgentInstallations()` 返回新增 `wslAgents` 字段 |
| `src/main.js` | **修改** | 调 `detectWslAgentInstallations()`，结果传给 settings UI；`wsl-deploy.js` 暴露给 renderer |
| `src/settings-tab-agents.js` | **修改** | WSL agent 行增加 distro 标记 + 安装按钮 |
| `test/` | **新建测试** | `test-wsl-utils.js`, `test-wsl-agent-detection.js` |

**出 PR 时不会引入破坏性变更：** 只是新增字段和 UI 元素，不影响现有功能。

### Phase 2（第二个 PR）：WSL Session 来源标记

**改动文件：**

| 文件 | 操作 | 内容 |
|------|------|------|
| `src/wsl-deploy.js` | **修改** | hook 安装时注入 `CLAWD_WSL_DISTRO` 环境变量 |
| `hooks/clawd-hook.js` | **修改** | `buildStateBody()` 读取 `CLAWD_WSL_DISTRO`，写入 `body.wsl_distro` 和 `body.host_type` |
| `src/server-route-state.js` | **修改** | 解析 `data.wsl_distro`、`data.host_type`，合成 host 字符串 |
| `src/session-alias.js` | **修改** | `normalizeSessionHost()` 支持 `wsl:` 前缀 |
| Dashboard/HUD 渲染 | **修改** | session 标签区分来源图标 |

### Phase 3（第三个 PR，可选）：VS Code 标记优化

**改动文件：**

| 文件 | 操作 | 内容 |
|------|------|------|
| `extensions/vscode/extension.js` | **修改** | 终端创建时注入 `CLAWD_EDITOR` 环境变量 |
| 状态路由/HUD | **修改** | 编辑器标记展示 |

---

## 4. 注意事项 & 边界情况

### WSL 相关
- **WSL2 localhost 转发** vs **mirrored 模式**：两种模式都需要测试
- **多个 WSL 发行版**：用户可能同时有 Ubuntu/Debian，每个都要独立检测
- **WSL 内 Node 版本**：hook 脚本需要 Node，install.js 需要 Node 写 settings.json
- **wsl.exe 路径**：有时在 `C:\Windows\System32\wsl.exe`，有时在 `C:\Windows\SysWOW64\wsl.exe`（32 位进程），直接调 `wsl.exe` 让系统解析即可
- **WSL 发行版名称**：可能含空格或中文，shell 参数需要处理
- **wsl.exe 首次调用延迟**：WSL 未运行时首次调用有时慢（冷启动），需要合理 timeout
- **docker-desktop / docker-desktop-data**：应过滤掉这类非交互发行版

### Hook 脚本层
- **`clawd-hook.js` 修改要小**：hook 脚本只依赖 Node 内置模块 + 同目录 JS 文件，不要引入外部依赖
- **环境变量注入**：`install.js` 的 `buildCommandHookSpec()` 已支持 `CLAWD_REMOTE=1 cmd` 模式，WSL 同理加 `CLAWD_WSL_DISTRO=Ubuntu`
- **Node 路径硬编码**：`install.js` 会 `resolveNodeBin()` 把 Node 绝对路径写入 hook command，WSL 安装时也需要做同样的解析

### 文件传输
- **BASE64 编码** 是最可靠的方式：不依赖 WSL 挂载点路径（/mnt/c 可能被用户自定义）
- **文件大小**：hook JS 单个文件最大 ~30KB，BASE64 后 ~40KB，wsl bash -c 可以承受
- **临时文件清理**：base64 解码的临时文件在安装后应清理

### 权限
- **非管理员 wsl.exe 调用**：`wsl -d <distro> -- <cmd>` 以 WSL 默认用户身份执行，文件会写入 WSL 用户的 home
- **Windows 杀毒软件**：动态写入文件到 WSL 文件系统不应该触发杀毒

---

## 5. Fork & 提 PR 操作指南（写给第一次发 PR 的你）

### 5.1 准备工作：Fork 仓库

```
1. 打开 https://github.com/rullerzhou-afk/clawd-on-desk
2. 点击右上角 Fork 按钮
   - Owner: 选择你自己的 GitHub 账号
   - Repository name: 保持 clawd-on-desk（不需要改）
   - 取消勾选 "Copy the main branch only"（保留所有分支）
   - 点击 Create fork
3. 等待几秒钟，Fork 完成
4. 现在你有: https://github.com/<你的用户名>/clawd-on-desk
```

### 5.2 本地配置：添加你的 Fork 作为 remote

```bash
# 进入你已经 clone 的本地仓库
cd /home/v1staz/workspace/clawd-on-desk

# 确认当前 remote
git remote -v
# origin  https://github.com/rullerzhou-afk/clawd-on-desk.git (fetch)
# origin  https://github.com/rullerzhou-afk/clawd-on-desk.git (push)

# 把你的 Fork 添加为新的 remote（叫 "fork" 或 "my" 都行）
git remote add fork https://github.com/<你的用户名>/clawd-on-desk.git

# 验证
git remote -v
# fork   https://github.com/<你的用户名>/clawd-on-desk.git (fetch)
# fork   https://github.com/<你的用户名>/clawd-on-desk.git (push)
# origin https://github.com/rullerzhou-afk/clawd-on-desk.git (fetch)
# origin https://github.com/rullerzhou-afk/clawd-on-desk.git (push)

# 把上游仓库（原始仓库）也加上，方便后续同步
git remote add upstream https://github.com/rullerzhou-afk/clawd-on-desk.git
```

### 5.3 创建功能分支

```bash
# 确保在 main 分支且是最新
git checkout main
git pull upstream main          # 拉上游最新代码

# 创建功能分支（用描述性命名）
git checkout -b feat/wsl-auto-discovery-and-pairing

# 或者按项目分支命名惯例：
# git checkout -b feat/wsl-one-click-pairing
```

**项目分支命名惯例**（从现有分支观察到的）：
- `feat/<feature-name>` — 新功能
- `fix/<issue-name>` — Bug 修复
- `docs/<doc-name>` — 文档
- `ci/<task-name>` — CI/构建
- `<agent>/<feature>` — 按 agent 分类（如 `codex/fix-low-power-resume-recovery`）

### 5.4 开发 & 提交

```bash
# 日常开发流程
git status                       # 看改了哪些文件
git diff                         # 看具体改动内容

# 添加文件到暂存区
git add src/wsl-utils.js         # 新增的文件
git add src/wsl-deploy.js
git add src/agent-installation-detector.js   # 修改的文件
# ... 等等

# 提交（commit message 格式参考项目惯例）
git commit -m "Add WSL auto-discovery and one-click hook pairing

- Add wsl-utils.js for WSL distribution enumeration and command execution
- Add wsl-deploy.js for one-click hook deployment into WSL distros
- Extend agent-installation-detector.js with WSL agent detection
- Show WSL agents in Settings → Agents panel with install button

Co-Authored-By: Claude <noreply@anthropic.com>"
```

**Commit message 惯例**（从项目历史观察到的）：
- 第一行：简短摘要（50-72 字符）
- 空一行
- 用 `- ` 列出具体改动
- 最后一行：`Co-Authored-By: Claude <noreply@anthropic.com>`

### 5.5 保持分支与上游同步

```bash
# 如果你的开发周期较长，上游可能有新提交
git checkout main
git pull upstream main           # 拉上游最新
git checkout feat/wsl-auto-discovery-and-pairing
git rebase main                  # 把你的改动 rebase 到最新 main 上

# 如果有冲突，解决后：
git add <冲突文件>
git rebase --continue
```

### 5.6 推到你的 Fork 并创建 PR

```bash
# 推到你自己的 Fork
git push fork feat/wsl-auto-discovery-and-pairing

# 如果是第一次推这个分支：
git push -u fork feat/wsl-auto-discovery-and-pairing
```

然后：
```
1. 打开 https://github.com/<你的用户名>/clawd-on-desk
2. GitHub 通常会弹出一个黄色横幅：
   "feat/wsl-auto-discovery-and-pairing had recent pushes less than a minute ago"
   点击旁边的 "Compare & pull request" 按钮

3. 如果没有横幅：
   - 点击 "Pull requests" tab
   - 点击 "New pull request" 按钮
   - base repository: rullerzhou-afk/clawd-on-desk  base: main
   - head repository: <你的用户名>/clawd-on-desk  compare: feat/wsl-auto-...
   - 点击 "Create pull request"

4. 填写 PR 描述：
   标题: 简短描述功能（如 "Add WSL auto-discovery and one-click hook pairing"）
   正文:
     ## What
     简要描述做了什么

     ## Why
     为什么需要这个功能

     ## How
     - 新增文件: xxx
     - 修改文件: xxx
     - 技术决策: 为什么选择这种方式

     ## Testing
     如何测试

     ## Screenshots (if applicable)
     截图

     🤖 Generated with [Claude Code](https://claude.com/claude-code)

5. 点击 "Create pull request"
```

### 5.7 PR 提交后的注意事项

```
- 项目维护者会 Review 你的代码
- 如果有修改意见，在本地改好后：
    git add <修改的文件>
    git commit -m "Address review feedback: <简述>"
    git push fork feat/wsl-auto-discovery-and-pairing
  PR 会自动更新

- 如果 Review 要求 squash/fixup：
    git rebase -i main     # 交互式 rebase 合并 commit
    git push --force-with-lease fork feat/wsl-auto-discovery-and-pairing

- 保持礼貌和耐心
- Review 意见是正常的，不代表你的代码不好
```

### 5.8 完整操作流程速查表

```bash
# ========== 一次性设置 ==========
# 1. GitHub 网页上 Fork rullerzhou-afk/clawd-on-desk
# 2. 本地添加 remote
git remote add fork https://github.com/<你的用户名>/clawd-on-desk.git
git remote add upstream https://github.com/rullerzhou-afk/clawd-on-desk.git

# ========== 每个 PR ==========
# 3. 同步上游
git checkout main
git pull upstream main

# 4. 创建分支
git checkout -b feat/<功能名>

# 5. 写代码...

# 6. 提交
git add -A                           # 或逐个 add
git commit -m "<标题>" -m "<详细描述>"

# 7. Push
git push -u fork feat/<功能名>

# 8. 在 GitHub 网页上创建 PR
#    从 <你的用户名>/clawd-on-desk:feat/<功能名>
#    到 rullerzhou-afk/clawd-on-desk:main

# ========== 后续 sync ==========
git checkout main
git pull upstream main
git checkout feat/<功能名>
git rebase main
```

---

## 6. 项目模块速查（开发参考）

### 数据流全景

```
Agent CLI (claude, codex, ...)
  │
  ├─ Hook 触发（SessionStart, PreToolUse, PostToolUse, Stop, ...）
  │
  ├─ hook 脚本 (hooks/clawd-hook.js)
  │   ├─ 读取 stdin JSON（来自 agent 的 hook payload）
  │   ├─ 构建 POST body (buildStateBody)
  │   └─ POST 到 127.0.0.1:23333/state
  │
  └─ Clawd HTTP Server (src/server.js)
      │
      ├─ /state  → src/server-route-state.js
      │   ├─ resolveHookAgentId() → 判断是哪个 agent
      │   ├─ 解析 host/editor/wsl_distro/...
      │   └─ ctx.updateSession() → src/state.js
      │
      ├─ /permission → src/server-route-permission.js
      │
      └─ src/state.js
          ├─ 状态机: idle/thinking/typing/building/...
          ├─ 多 session 管理
          └─ → 驱动 Electron 窗口动画
```

### 关键文件和预估改动量

| 文件 | 当前行数 | 预估改动 | 复杂度 |
|------|---------|---------|--------|
| `src/wsl-utils.js` | 0 (新建) | ~120 行 | 🟡 中等 |
| `src/wsl-deploy.js` | 0 (新建) | ~200 行 | 🟡 中等 |
| `src/agent-installation-detector.js` | 398 | +60 行 | 🟢 简单 |
| `src/main.js` | 3811 | +30 行 | 🟢 简单 |
| `src/settings-tab-agents.js` | 960 | +50 行 | 🟡 中等 |
| `hooks/clawd-hook.js` | 484 | +10 行 | 🟢 简单 |
| `src/server-route-state.js` | 311 | +15 行 | 🟢 简单 |
| `src/session-alias.js` | 126 | +5 行 | 🟢 简单 |

### 可复用的现有模块

- **`src/remote-ssh-deploy.js`** → `spawnAndWait()` 模式可直接复用 WSL 命令执行
- **`hooks/server-config.js`** → `resolveNodeBin()` 已有 Node 路径解析，WSL 需要类似逻辑
- **`hooks/install.js`** → `buildCommandHookSpec()` 已支持环境变量注入 (`CLAWD_REMOTE=1`)
- **`src/settings-tab-agents.js`** → Install 按钮、hint banner 已有完整 UI 模式

---

## 7. Windows 测试步骤（详细）

### 7.0 前提条件

- Windows 10/11，已安装 WSL2 并至少有一个发行版（如 Ubuntu）
- WSL 发行版内已安装 Node.js（`command -v node` 要有输出）
- 你的 WSL 发行版里有 Claude Code 可运行（至少 `~/.claude/` 目录存在）
- Windows 上已有 Clawd 正常运行过（或至少 Node.js 可用）

### 7.1 关闭正在运行的 Clawd

```powershell
# 系统托盘找到 Clawd 图标 → 右键 → Quit
# 或者强制关闭：
taskkill /f /im "Clawd on Desk.exe"
```

确认进程已关闭后继续。

### 7.2 从源码启动开发版本

```powershell
# 进入你的 clone 目录
cd D:\path\to\clawd-on-desk

# 确认在正确的分支上
git branch
# 应该显示: * feat/wsl-auto-discovery-and-pairing

# 安装依赖（如果之前没装过）
npm install

# 启动开发版
npm start
```

Clawd 宠物应该出现在桌面上。

### 7.3 测试 1：Settings → Agents 面板中显示 WSL 发现结果

1. 右键点击桌宠 → **Settings**
2. 切换到 **Agents** 标签页
3. 找到 **Claude Code**（或其他你在 WSL 中安装了的 agent）
4. 点击 Claude Code 行展开（如果可折叠的话）
5. **预期看到：**
   - agent 开关和 Install 按钮（和以前一样）
   - 展开后出现 "INSTANCES" 区域
   - 下面列出检测到的 WSL 实例，如 `WSL: Ubuntu` + **Pair** 按钮

**如果没有看到 WSL 实例：**
```powershell
# 手动验证 WSL 检测
wsl -l -q
# 应该列出你的发行版名称

# 验证 WSL 内有 agent
wsl -d Ubuntu -- bash -c "test -d ~/.claude && echo 'found' || echo 'not found'"
```

### 7.4 测试 2：一键配对（Pair 按钮）

1. 在 Settings → Agents → Claude Code → Instances 区域
2. 点击 WSL 实例旁边的 **Pair** 按钮
3. 按钮文字应该变为 **"Pairing..."**
4. 等待几秒后：
   - **成功**：按钮恢复，可能变为 "Paired" 状态，控制台有进度日志
   - **失败**：按钮恢复，控制台有错误信息

**手动验证部署结果：**
```bash
# 在 WSL 终端里
ls ~/.claude/hooks/clawd-hook.js
# 应该能看到文件

cat ~/.claude/settings.json | grep clawd-hook
# 应该能看到 hook 注册信息
```

### 7.5 测试 3：WSL 中的 Claude Code → 桌宠反应

1. 确保 Clawd 开发版正在 Windows 上运行
2. 打开 WSL 终端，进入一个项目目录
3. 运行 Claude Code：
   ```bash
   claude
   ```
4. **预期看到：**
   - 桌宠从 sleeping → idle → thinking（当你输入 prompt 时）
   - 桌宠变为 working/building（当 Claude 执行命令时）
   - 右键桌宠 → Dashboard 能看到 session

**如果没有反应：**
```bash
# 在 WSL 里检查 hook 是否能连通 Clawd
curl -s http://127.0.0.1:23333/state
# 应该返回 {"ok":true,"app":"clawd-on-desk",...}
```

### 7.6 测试 4：Dashboard Session 来源标记

1. 让 WSL 里的 Claude 保持运行（idle 或 working 状态）
2. 右键桌宠 → **Dashboard**（或点击桌宠打开 Dashboard）
3. **预期看到：**
   - Session 卡片出现
   - 卡片 meta 行显示 agent 名称、状态标签、时间
   - **来源标签**：如果 session 来自 WSL，应该显示绿色的 `WSL: Ubuntu`
   - 如果同时有 Windows CLI 的 session，Windows 的不显示额外标签

### 7.7 测试 5：HUD 悬浮窗来源标记

1. 鼠标悬停在桌宠上
2. **预期看到：**
   - HUD 弹出 session 列表
   - WSL 来源的 session 行在 agent 图标旁有一个 🐧 符号
   - 鼠标悬停在 🐧 上看到 tooltip: "WSL: Ubuntu"

### 7.8 测试 6：多个 WSL 发行版

如果你有多个 WSL 发行版（如 Ubuntu + Debian），每个都装了 Claude：

1. Settings → Agents → Claude Code 展开
2. **预期看到：** 两个实例行：
   - `WSL: Ubuntu` + Pair 按钮
   - `WSL: Debian` + Pair 按钮

### 7.9 回归测试：Windows 本地功能不受影响

1. 在 Windows 上正常运行 Claude Code（PowerShell / CMD / Git Bash）
2. **预期：** 和之前完全一样，没有任何变化
3. Dashboard 中本地 session 不显示额外来源标签（或显示为空）

### 7.10 清理：恢复原版 Clawd

```powershell
# 关闭开发版 (Ctrl+C 在 npm start 终端)
# 重新打开正式安装的 Clawd on Desk
# 一切应该和之前一样
```

---

### 如果测试中遇到问题

**问题：WSL 实例没出现**

检查控制台日志（npm start 的输出），搜索 `WSL` 关键词。

**问题：Pair 失败，提示 Node.js not found**

```bash
# 在 WSL 里安装 Node.js
wsl -d Ubuntu -- bash -c "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
```

**问题：Pair 成功但没有看到 hook 文件**

检查 WSL 内的 home 目录和文件权限：
```bash
wsl -d Ubuntu -- bash -c "ls -la ~/.claude/hooks/"
```

**问题：npm start 报错**

确认依赖已安装：
```powershell
npm install
```

**问题：端口冲突**

确认没有其他 Clawd 实例在运行：
```powershell
netstat -ano | findstr :23333
```
