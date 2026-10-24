# AutoClaw E1 真机证据记录（2026-10-21 / 10-22）

AutoClaw（智谱）桌面端接入 Clawd 的真机调查与验证记录。接入形态：**内嵌 OpenClaw gateway 的 state-only plugin**，与既有 OpenClaw 集成同合约、独立 agent id（`autoclaw`），插件以 marker-owned 拷贝物化进 AutoClaw 的用户 extensions 目录。

## 产品形态（AutoClaw 1.20.0，macOS arm64 实测）

- AutoClaw 是 Electron 桌面应用（`/Applications/AutoClaw.app`，官方文档 https://autoclaw.zhipuai.cn/docs/ 自述“首个一键安装的本地 OpenClaw 应用”），无 CLI（`which autoclaw` 无结果）。
- 应用自带 OpenClaw gateway：`Contents/Resources/gateway/openclaw`（package.json `name: openclaw, version: 2026.6.8`），首次启动时物化到 `~/Library/Application Support/autoclaw/embedded-gateway-runtime/<fingerprint>/`（自带 `node/` 二进制 + `gateway/openclaw`，`.ready.json` 记录 fingerprint/appVersion）。
- 运行中的 gateway（ps + lsof 实证）是 AutoClaw app 的子进程，用内嵌 node 跑 `openclaw gateway --port 18789`，监听 `127.0.0.1:18789`；AutoClaw 桌面壳的 `settings.json` 指向 `ws://127.0.0.1:18789`。**完整退出 AutoClaw（Cmd+Q / AppleScript quit）会连带结束 gateway，重开 app 会重新生成配置并重启 gateway。**
- **gateway 的 OpenClaw state 目录是 `~/.openclaw-autoclaw/`**（app.asar 内常量 `OPENCLAW_HOME_DIR = ".openclaw-autoclaw"`；`im/runtime-registry.json` 的 workspaceDir、`lsof` 打开 `~/.openclaw-autoclaw/state/openclaw.sqlite` 均为实证）。
- 配置文件三份：`openclaw.json`（app 维护的权威配置）、`openclaw.runtime.json`（**gateway 实际读取的文件**，lsof 实证；每次 app 启动时由 openclaw.json 生成）、`openclaw.json.known-good`。三者均为严格 JSON，含标准 OpenClaw `plugins.load.paths` + `plugins.entries` 键；内置插件从 `Contents/Resources/extensions` 加载（11 个目录，与共享 OpenClaw 相同的 `openclaw.plugin.json` + package.json `openclaw.extensions` manifest 格式）。
- 本机同时装有独立 OpenClaw（`~/.openclaw/openclaw.json`，gateway 同样配 18789 但被 AutoClaw 内嵌 gateway 占用，独立 gateway 进程反复重启绑定失败——两套配置互不影响）。

## 第一版方案失败：linked load path 被 GatewayManager 作废

第一版沿用 openclaw 安装器的做法，把 `hooks/autoclaw-plugin` 源码目录写进 `plugins.load.paths` 并写 `plugins.entries["clawd-on-desk"]`。真机结果：gateway 自带 CLI `plugins list`（静态读配置）显示 enabled，但 **运行中的 gateway 从未装载它**（启动日志 `http server listening (15 plugins: …)` 不含 clawd-on-desk），用户测试无反应。

根因在 AutoClaw 自己的日志 `~/.openclaw-autoclaw/logs/autoclaw-dev.log`：

```
[GatewayManager] Removing unknown plugin entry: clawd-on-desk
[GatewayManager] plugins config mutated while gateway is alive (entries-[clawd-on-desk]) — running process diverges from config until next restart
gateway.config.plugins_mutated_while_alive {"entriesRemoved":["clawd-on-desk"],"loadPathsBefore":2,"loadPathsAfter":2,...}
```

app.asar 中的逻辑（`remote_config.refresh` 时执行）：

```js
for (const key of Object.keys(config.plugins.entries)) {
  const pkg = entry?.package || key;
  const shortKey = key.replace(/^@[^/]+\//, "").replace(/^plugin-/, "");
  if (availablePlugins.size > 0 && !availablePlugins.has(key) && !availablePlugins.has(pkg) && !availablePlugins.has(shortKey)) {
    events?.onLog?.(`[GatewayManager] Removing unknown plugin entry: ${key}`);
    delete config.plugins.entries[key];
  }
}
```

`availablePlugins` 只来自三个扫描根：gateway 自带 `dist/extensions`（stock）、app 的 `Contents/Resources/extensions`（bundled）、以及 **`path.join(homedir(), ".openclaw-autoclaw", "extensions")`（source: "user"）**。`registerExtensionPlugin` 对每个带 `openclaw.plugin.json` 的子目录把**目录名和 manifest id** 都加入集合。`plugins.load.paths` 不参与可用性判定、也不会被删——所以 linked load path 会永远留下一个“已发现但无 entry、不启用”的插件。

## 最终方案（真机验证）

- 安装器把插件的 3 个文件（`index.js` / `package.json` / `openclaw.plugin.json`）拷贝到 `~/.openclaw-autoclaw/extensions/clawd-on-desk/`，附 `.clawd-managed.json` 所有权标记（owner/pluginId/agentId/sourceDir/filesSha256）；staging 放在 state 目录根下（`.clawd-autoclaw-staging-*`，extensions/ 内的半成品会被扫描成插件），再原子 rename 进位；替换时旧目录先挪到 `.clawd-autoclaw-removing-*` 再删。
- 配置只写 `plugins.entries["clawd-on-desk"] = {enabled: true, hooks: {allowConversationAccess: false}}`，**不写 load.paths**（否则 gateway 会看到同一 id 两份），并清掉第一版遗留的 `autoclaw-plugin` basename load path。
- 所有权：目录缺失/空 → 创建；标记合法 → 按文件字节比对决定是否重物化；无标记或标记损坏 → `extension-dir-foreign` fail closed（配置也不写，避免用我们的 id 启用外来代码）。卸载只删标记合法的目录（先挪出 extensions/ 再删），外来目录原样保留并返回 warning。
- gateway 日志（2026-10-22 01:37，AutoClaw 1.20.0 / gateway 2026.6.8）：
  - `[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load: clawd-on-desk (/Users/cw/.openclaw-autoclaw/extensions/clawd-on-desk)`
  - `plugins.gateway-load.plugin.clawd-on-desk loadMs=6.9 loadFailedCount=0.0` / `registerFailedCount=0.0`
  - `http server listening (16 plugins: …, clawd-on-desk, …)`
  - `clawd-on-desk: loaded without install/load-path provenance; treat as untracked local code and pin trust via plugins.allow or install records`（信息性提示，不影响装载）
  - 重启时 GatewayManager 只删了它自己 feature-flag 关闭的 `evolution-proposal` / `autoclaw-evolution-write-guard`，`clawd-on-desk` entry 在 openclaw.json 与 openclaw.runtime.json 中均保留。
- 安装器从干净状态执行一次即得到上述布局；再次执行幂等（文件与注册均 "already current"）；无 staging/removing 残留。
- Doctor 走独立的 `autoclaw-extension` configMode：校验配置可解析、entry 存在且 enabled、extensions 拷贝存在且标记归属 Clawd、manifest 合约（复用 `openclaw-entry-validator`）、文件与当前源一致（不一致报 needs-review，Repair 重物化并提示重启）。

## 残余风险 / 待办

- **真实会话 `/state` 往返（macOS 已验证）**：2026-10-22 用户在 AutoClaw 发送真实消息，Clawd 桌宠/HUD 正常响应——插件装载之外的最后一环在 macOS 闭环。
- **Windows 未验证**：代码与 macOS 共用同一份（安装器/插件均为平台无关 Node），无需另写 Windows 版本；待验证的只有 Windows 上的路径布局（预期 `%USERPROFILE%\.openclaw-autoclaw\`，app.asar 的 `OPENCLAW_HOME_DIR` 常量与 macOS 同源）与 GatewayManager 行为（同一份 asar 代码，预期一致）。
- **`plugins.allow`**：当前 AutoClaw 不设置 `plugins.allow`（日志 "plugins.allow is empty"），非内置插件自动装载。若未来版本启用 allow 列表，我们的插件需被列入（GatewayManager 的 `sanitizePluginAllowlist` 以 availablePlugins 为准，我们的 id 可用，但 Clawd 不主动写 allow——写了会让 gateway 只装 allow 内的插件，可能破坏 AutoClaw 自身插件）。
- **gateway 只在启动时读插件集**：安装/更新后必须重启 AutoClaw（完整退出）。Settings/Doctor 目前只在安装器 stdout 和 Doctor 文案里提示，没有像 DSH 那样的常驻提示。
- 图标为 AutoClaw.app 自带 `icon.icns` 提取（128px），非独立授权品牌素材；`fallback: false`，provenance 记录在 `assets/source/agent-icons/source-manifest.json`。
- 用内嵌 gateway CLI 做诊断时必须显式 `OPENCLAW_STATE_DIR=~/.openclaw-autoclaw`，否则它默认读 `~/.openclaw`（独立 OpenClaw 的配置）。

## AutoClaw 2.x（zwork harness）调查与轮询集成（2026-10-24）

用户更新后跑的是独立 app `/Applications/AutoClaw2.app`（bundle id `com.zhipuai.autoclaw2`，v2.2.0，内部代号 **zwork**；userData `~/Library/Application Support/AutoClaw-official`，`~/.config/Zwork/` 仅办公插件桥发现文件）。v2.0.0 changelog"全新 Harness，不再断连"对应架构重写：

- **1.x 的内嵌 OpenClaw gateway 被整体移除**：旧 gateway（openclaw 2026.6.8，18789）在 2.x 启动时干净退出（gateway.log `EXIT`）且不再被拉起；新版 bundle（`Contents/Resources/app/dist/main.cjs`，未打包 asar）中 `openclaw.plugin.json` / `plugins.entries` / `GatewayManager` / extensions 扫描关键词计数全为 0；`node_modules` 仅 @img；`vendor/` 为 bun/dotnet/node/ripgrep。agent 引擎直接跑在 Electron 主进程内（日志 `zwork.model.request.*`），18432 端口是 token/auth helper（`/get_token`、`/legal-jianwei-pdf`）。
- 引擎是 Pi 系：harness 选项含 `piAgentDir`（默认 `~/.pi/agent`）、`piCompaction`、`sharedPiSkillsDir`（默认 `~/.agents/skills`，本机真实存在且被读取）、env `ZWORK_HARNESS_PI_USER_AGENT_DIRECTORY` 可覆盖。但**没有 Pi 式 extension 加载器**（无 jiti/.ts 加载特征）——不能复用 Pi extension 集成。
- **可观测面**：主进程全程持写句柄的 `accounts/<hash>/runtime/runtime.sqlite`（WAL）。表结构（实测 schema）：`work_sessions`（session_id/title/workspace_id/updated_at/deleted_at/archived_at）、`work_runs`（run_id/session_id/status/created_at/updated_at；status 枚举 queued/running/waiting_approval/completed/failed/interrupted/stopping/stopped/cancelled/merged）、`work_events`（cursor 自增，type 如 run.started/run.completed/egress.decision）、`work_workspaces`（root_path→cwd）、`schema_migrations`。`work_runs.text`/`answer_preview`、`work_sessions.draft`、`work_events.payload_json` 是内容列，轮询一律不 SELECT。
- **集成实现**：`agents/autoclaw-runtime-monitor.js` 只读轮询（`node:sqlite` readOnly；Electron 41 / Node 22.22 实测可用），SQL 白名单 + PRAGMA 门禁 + 纯函数状态机；接线 `src/agent-runtime-main.js`（`startAutoClawRuntimeMonitor`，gate `enabled` 启停）与 `src/main.js` 启动调用。session id `autoclaw2:<uuid>`，与 1.x 共用 agent id `autoclaw`。
- **本机真机验证（2026-10-24）**：真实 DB 冒烟——inspect `{found:1, supported:true}`；首次 poll 对历史 completed 会话（"问候"）零事件（bootstrap 静默生效），cwd 正确取到 workspace root_path；单测 19 项状态机/发现/隐私全过；Clawd 重启后 monitor 静默启动（无 warn）。**端到端（用户发消息 → 桌宠动画/HUD）待用户确认。**
- 已知限制：`waiting_approval` 无审批语义（state-only）；轮询延迟 ~1.5s；无工具级事件（`work_events` 样本尚少，后续真实使用中出现 tool 级 type 时可加粒度）；schema 私有无契约，版本漂移时 fail closed 跳过；Windows userData 名（预期 `%APPDATA%\AutoClaw-official`）未真机验证。
