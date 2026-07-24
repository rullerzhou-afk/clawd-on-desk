# Issue #513 Remote SSH 多用户隔离 — 方案

制定日期: 2026-07-24(v2-v11 同日修订)
Issue: [#513 远程SSH情况下会出现其他人的codex会话](https://github.com/rullerzhou-afk/clawd-on-desk/issues/513)(报告人 @Sympathyzzk,2026-06-17)
关联: #512(远程环境架构重构,**隔离主线与其解耦先行;但 profileId namespace 按 B3 收回 Phase 1**)
状态: **v11,实现分支 `fix/issue-513-remote-ssh-isolation` 已完成 Claude 对 v8 的 P0-P3 对抗审查修复、本地回归、真实双 Unix 账号 smoke 与同一 Unix 账号双 profile-isolated 的无登录 smoke；完整真实 CLI/auth/GUI 矩阵仍未完成。** Phase 1 的 B1-B6/X1、脚本停用、双语文档与 Phase 2 的 profile-isolated layout/wrapper/激活门均已实现；Phase 2 产品入口由 `CLAWD_ENABLE_EXPERIMENTAL_REMOTE_ISOLATION=1` 隐藏，并同时受既有 isolated evidence 与真实 CLI 版本/产物能力门约束，P2V1-P2V10 真机通过前不得作为受支持能力发布。实现中另补齐 runtime-mode 持久事务、bootstrap ownership 与中断续跑：cleanup/bootstrap 后本地落盘失败时只 resume 同一个 runtimeKey，不生成第二套 root。v10 在 AWS Lightsail Ubuntu 24.04 上以两个临时 Unix 账号、23333/23334、真实 `ssh -R`、真实 secure deploy/install/read-back 与受控 Claude/Codex hook payload 验证了双向路由隔离、同 raw session 分离、wrong nonce 404、离线 profile 不扫描邻居、A cleanup 不影响 B；真机过程另暴露并修复 secure scp target quoting、带引号 env read-back、Copilot `bash` 字段 read-back 三个缺口。v11 复用其中一个临时 Unix 账号，在同一 HOME 下建立两个不同 runtimeKey/runtimeRoot，以三个不联网、不登录、不调用模型的假 CLI 驱动真实 capability probe、wrapper、artifact activation、secure deploy、双隧道、同 raw session 与 ownership cleanup；两套 Claude/Codex/Copilot 用户级 root、路由与保留数据均互不影响。该轮另发现并修复 capability probe 内 `"$1"` 被远端双引号 shell 提前展开为空、导致 isolated mode 永远不能激活的真实阻断。最新证据为 `test/remote-ssh-deploy.test.js` **50/50 通过**、重放到 `origin/main@37be12d` 后仓库全量 **6046 项中 6028 通过/0 失败/18 个平台条件跳过**、改动 JavaScript 语法检查通过且 `git diff --check` 无错误。两轮 smoke 均使用受控 hook payload/HTTP permission 请求，**不等于 V5 真实 Claude 批准/拒绝/600s 超时，不等于真实三套 CLI 登录、auth/resume/实际写入清单，也不覆盖完整 Phase 2 P2V1-P2V10**。云宝三轮阻断已按原文写成 **Phase 1 强制不变量 B1-B6**(§2.0),并在后续复核中补齐独立 secure marker、锁 fencing、canonical action ID、可选组件事务语义、旧 nonce 到期/紧急吊销、锁内 cleanup、installation binding 持久化、WSL/SSH marker 解耦、clone cleanup 授权、monitor 整段 fence 与 Codex official-turn namespace 等闭环。v6 把**远端所有权从 Unix HOME 提升为 `runtimeKey + remote layout`**;v7 经对抗复核再补齐 layout 外共享 live 文件、可克隆本机身份、远端模块加载期 HOME 硬编码三处真实阻断,并订正两项错误前提:`CLAUDE_CONFIG_DIR` 在当前 Claude Code 2.1.211 实测会承载 `.claude.json`,`COPILOT_HOME` 是 GitHub Copilot CLI 官方契约。macOS Claude subscription OAuth 仍由 Keychain 按 OS 用户共享,因此 Phase 2 只承诺配置/会话/Clawd 路由隔离,不得把新 root 等同于独立 Claude 登录。**Phase 1 合并条件仍为 B1-B6 + X1;Phase 2 未过 P2V1-P2V10 前不得宣称支持同 Unix 账号隔离。** 对照表见 §9,复核记录见 §10。
代码基准: main @ `6d4041d`(2026-07-24)。本文所有行号对应此基准。

---

## 0. 一句话结论

远端 hook 靠**无身份的端口扫描**(23333→23337 先应答先得)找隧道、本地服务器**无校验照单全收**,两个缺口叠加导致共享服务器上的会话/权限事件串进别人的 HUD。修法是三件套:**每个 Remote SSH profile 一个本机专用 ingress(隧道只落这里,主入口永不暴露给隧道)+ 远端只打精确端口(废除扫描,身份缺失/损坏一律 fail closed)+ 部署时下发 routingNonce 身份文件(ingress 验不过一律拒收,无宽限)**;并由 **B1-B6 六条强制不变量**(§2.0)封住旁路、并发、状态层碰撞、split-brain、事务半完成、越权清理六个闭环缺口。所有远端路径从 Phase 1 起统一经 `runtimeKey → remote layout` 解析:Phase 1 的 `account-default` layout 修复不同 Unix 账号;Phase 2 的 `profile-isolated` layout 再把同一 Unix 账号下各 profile 的 Claude 配置、Codex HOME/sessions 与 Clawd runtime 分开。后者解决合作使用下的误串台,**不把同一 Unix UID 伪装成操作系统安全边界**。

---

## 1. 问题复述与根因

### 1.1 报告场景

两位用户共用同一台服务器,各自在自己电脑上开 clawd 的 Remote SSH。两人在 HUD 上互相看到对方的会话状态;**改成不同的 `remoteForwardPort` 也无效**。

### 1.2 根因一:远端发现机制无身份,先应答先得

- 远端没有 `~/.clawd/runtime.json`,hook 的候选端口就是 `SERVER_PORTS = [23333..23337]` 全量顺序扫描([server-config.js:8-10](../../hooks/server-config.js),`getPortCandidates` :200-220)。
- 应答判定 `isClawdResponse`(:282-291)只认固定 header `x-clawd-server: clawd-on-desk` —— **每个用户的隧道应答完全相同,无法区分**。
- A 绑 23333、B 被 `ExitOnForwardFailure` 挤到 23334 后,B 的 hook 依然从 23333 开始扫,第一个命中的就是 A 的隧道。`remoteForwardPort` 只挪隧道绑定位置,不影响扫描顺序 —— 这就是"改端口无效"的直接原因。
- Claude 实时 hook 连 `preferredPort` 都不传([clawd-hook.js:622](../../hooks/clawd-hook.js));Codex official hook 的 `preferredPort` 来自读远端不存在的 runtime.json,恒为 null([codex-hook.js:415-449](../../hooks/codex-hook.js)),**state 和 permission 双双落入纯扫描**。

### 1.3 根因二:本地接收无校验

`POST /state`([server-route-state.js:116](../../src/server-route-state.js))与 `POST /permission`([server.js:614](../../src/server.js))没有任何 token / profile 绑定,到达即写入会话表;`host` 字段是客户端自报的展示标签,代码注释自己就声明了不可溯源(server-route-state.js:292-296)。

### 1.4 严重性升级(本轮核实新发现):权限决策也会跨用户

远端部署调用 `install.js --remote` 时**不传端口**([remote-ssh-deploy.js:295-299](../../src/remote-ssh-deploy.js)),`install.js` 也**根本没有 `--port` CLI 参数**;远端无 runtime.json,于是 `hookPort = 23333` 兜底(install.js:735,:842)。结果:**远端 Claude 的 PermissionRequest HTTP hook URL 永远是 `http://127.0.0.1:23333/permission`**(HTTP_HOOKS 定义 install.js:741-750,URL 生成 :1013),连 `remoteForwardPort` 都不看。

也就是说共享服务器上只要你的端口不是 23333,你的 Claude 权限气泡会**确定性地弹到持有 23333 的那个人的桌面上,由 ta 批准/拒绝你的工具调用**。这不只是"看见别人会话"的可见性问题,而是**控制流跨用户**。#513 必须按安全缺陷处理,不是纯 UX 缺陷。

### 1.5 受影响的完整客户端清单(远端会发事件的所有路径)

command/statusline/monitor 客户端经 `hooks/server-config.js` 的 `postStateToRunningServer` / `postPermissionToRunningServer` / `discoverClawdPort` 收敛,但有两个不能假装“自动继承”的例外:**Claude PermissionRequest 是 settings.json 静态 HTTP URL,由 install.js 生成;app 隧道探针由 remote-ssh-runtime.js 自己构造**。因此客户端堵点是 `server-config.js + install.js URL + runtime probe` 三处,缺一不可。远端部署(HOOK_FILES 清单 [remote-ssh-deploy.js:51-79](../../src/remote-ssh-deploy.js))覆盖:

| 客户端 | 文件 | 通道 | 现状端口行为 |
|---|---|---|---|
| Claude command hook | clawd-hook.js:622 | POST /state | 纯扫描 |
| Claude PermissionRequest | install.js 写入的 HTTP hook | POST /permission | **硬编码 23333** |
| Claude statusline(quota/rate_limits,PR #660 线) | claude-statusline.js:113 + claude-rate-limits.js / quota-bucket.js | POST /state | 纯扫描 |
| Codex official hook(state+permission) | codex-hook.js:415-449 | POST /state、/permission | 纯扫描(远端 preferredPort=null) |
| Codex JSONL fallback monitor | codex-remote-monitor.js | POST /state | `--port` 直投,**miss 后仍回落扫描** |
| Copilot hook(state+permission) | copilot-hook.js:505,:540 | POST /state、/permission | 纯扫描 |
| App 自身隧道探针 | remote-ssh-runtime.js:277-295 buildProbeCommand | GET /state | 只验固定 header |

(codebuddy/gemini/kimi 等其余 hook 不在远端 HOOK_FILES 清单里,仅本地,不受本次影响;但因堵点在 server-config.js,它们将来若上远端自动继承同一机制。)

---

## 2.0 Phase 1 强制不变量(B1-B6)

以下 6 条是云宝三轮阻断的原文落地,**全部为 Phase 1 硬性约束**。下文所有 D 条款(D1-D12)是它们的展开;凡与本节冲突处,以本节为准。v6 新增跨阶段架构约束 X1(本节末尾):它不改变 B1-B6 的安全语义,但要求 Phase 1 不得把这些语义继续焊死在 Unix HOME 上。B1-B6 或 X1 任一未实现/未验证 → Phase 1 不合并。

**B1 — Remote SSH 使用独立于 WSL 的 secure marker;secure 模式 fail closed。**
Remote SSH 的安全模式由**独立且非秘密的专属 marker** 判定,不复用 WSL 检测(`CLAWD_REMOTE` / `WSL_DISTRO_NAME` / `/proc/version`,[server-config.js:30-62](../../hooks/server-config.js)),也不允许让 identity 文件自身兼任 marker。WSL 与 Remote SSH 是正交维度,共享同一个开关会让 WSL-in-remote、remote-in-WSL 两种组合互相污染判定。定案:
- 远端落非秘密 marker `layout.secureMarkerFile`;`account-default` layout 下仍解析为 `~/.claude/hooks/clawd-ssh-secure-v1`,`profile-isolated` 下解析到该 profile 的 Claude hook 目录。所有 Remote SSH command/statusline/Codex/Copilot/monitor 注册同时显式携带 `CLAWD_SSH_REMOTE=1`;`server-config.js` 优先以自身 `__dirname` 定位同目录 marker/identity,注册命令另带非秘密路径 env 作为显式覆盖。secure 判据为 **`CLAWD_SSH_REMOTE=1` 或 marker 存在或 identity 路径存在三者任一成立**。三重判据用于防单个载体被误删后退化回扫描;普通 WSL 只保留既有 `CLAWD_REMOTE=1`,不写 marker、不带 `CLAWD_SSH_REMOTE`;
- secure 模式下 identity **缺失、损坏(JSON 解析失败 / 字段缺失 / 版本不识别)、读取失败(EACCES 等)一律 fail closed —— 丢弃事件,绝不回退端口扫描**。identity 不得兼任 marker:否则文件一旦缺失,hook 无从知道自己曾是 Remote SSH,上述 fail-closed 承诺逻辑上无法成立;
- 首次安全迁移顺序锁定为:**原子落 identity → 原子落 secure marker → 部署并校验新版 hook files → 运行 installers**。旧 hook 在新版 `server-config.js` 切入前仍属于 legacy、不宣称已隔离;新版 transport 一旦生效即能看到 marker+完整 identity。cleanup 反向执行:先移除 managed registrations/hooks,再删 identity,**marker 最后删除**;中间失败时 marker 留存,残余 hook 只会 fail closed。
`scripts/remote-deploy.sh`(320 行,手工部署脚本)**是正式旁路**:它做本地端口探测后写 `RemoteForward 127.0.0.1:23333`(:169-184、:294)、直接调 `install.js --remote`(:260-270),完全绕过 profile / 身份文件 / ingress。二选一,**不允许保留现状**:①完整升级到同一安全模型(生成身份文件、pin 端口、走 ingress);②**明确停用**(脚本首行 fail-fast 报错并指向 app 内 Remote SSH 设置)。推荐 ②,理由是该脚本无 profile 概念、无本地 prefs 可写、无法参与 D9 事务与 B5 恢复,升级等于在 shell 里重造一遍 controller。
身份文件写入必须**临时文件 + 原子 rename**(`cat > tmp && mv -f tmp target`,配合 `umask 077`),杜绝半写文件被 hook 读到——半写 JSON 在 secure 模式下会触发 fail closed,静默掐断该 profile 全部上报。

**B2 — 所有远端 mutation 前必须获取原子部署锁。**
hook 文件 staging/promotion、身份/marker 写入、`install.js --remote` / `codex-install.js` / `copilot-install.js` 注册、monitor PID pre-kill、cleanup/uninstall —— **任何 live remote mutation 之前**,必须先在远端以 `mkdir layout.deployLockDir` 取得该 `runtimeKey` 的原子锁。锁 owner 写 `{leaseId, installId, profileId, runtimeKey, layoutVersion, acquiredAt}`;`leaseId` 为每次操作新生成的随机值,PID 只可做日志信息、**不得用于远端存活判定**(本机 PID 在远端无意义,短命 SSH shell PID 又会立即退出)。**拿到锁之后必须重新执行 ownership preflight**(D6 全部判据),因为 preflight 与 mutation 之间存在 TOCTOU 窗口。**同一 runtimeKey 未拿到锁 → 零 live 写入退出**,报"另一台 Clawd 正在部署到该远端 runtime,请稍后重试",不排队、不强夺。不同 runtimeKey 的 isolated roots 不共享 live 文件,允许各自持锁并发;`account-default` 只有一个 runtimeKey,所以 Phase 1 行为仍是账号级串行。
所有 live mutation 命令必须携带期望 `leaseId` 并在同一远端命令内先执行 `assertLease(leaseId)`;hook files 先上传到 lease 专属 staging 目录,只有持有当前 lease 的 promotion 命令才能替换 live 文件。释放锁也必须核对 owner 中的 `leaseId`,旧持有者的 finally **不得删除新持有者的锁**。Phase 1 **不提供应用内陈旧锁接管**:锁超时只显示诊断与人工恢复说明,要求确认所有相关 Clawd/部署进程已停止后手工删除精确锁路径。这样避免网络分区中的旧持有者恢复后与新持有者并行写;若未来要做在线破锁,必须另引入单调 fencing token,不在本 PR 偷渡。
**删除 v3 的"最后写者胜可接受"设计** —— 并发部署下 last-writer-wins 意味着输者的 hooks 带着已失效 nonce 继续运行、赢者以为自己独占,两边都不知情;这正是"错误接管"的一种形态。

**B3 — profileId namespace 进入 Phase 1,不留给 #512。**
内部 canonical session key **必须包含 profileId**,`rawSessionId` 仅用于可见文字。禁止用可碰撞的裸分隔符拼接再反向解析;统一 helper 生成 opaque canonical key,session 记录单独保存 `{profileId, rawSessionId}`。snapshot/API 契约拍板为:**`session.id` 始终是 canonical action ID**,供 HUD/Dashboard 的去重、focus/hide/ack/open-folder 等操作使用;另发 `session.rawSessionId` / `displayTitle` 供界面显示,绝不把 raw id 当操作主键。覆盖面为全部会话态通道:
- `/state` 会话表(`sessions` Map,[state.js:1333](../../src/state.js) `updateSession` 及全部 `sessions.get/set/delete` 调用点);
- `/permission` 的 `ctx.pendingPermissions` 与气泡关联([server-route-permission.js:362](../../src/server-route-permission.js));
- Codex turn 跟踪(`codexOfficialTurns` Map,[server.js:88](../../src/server.js));
- Codex user-input 气泡(`clearCodexUserInputBubbles`,[permission.js:2459](../../src/permission.js));
- 会话清理/淘汰路径(`state-stale-cleanup.js`、state.js:1062 的 LRU 淘汰、:1688 的 subagent 删除)。
- snapshot/renderer/action/alias 路径(`state-session-snapshot.js`、Dashboard/HUD renderer、session IPC、focus/open-folder、`session-alias.js`);alias key 必须包含 profileId,并对旧 host/agent/raw key 只读 fallback。
理由是**不做 namespace 则隔离闭环不成立**:两个远端的 session id 可以相同(同一份 `~/.codex/sessions` 复制、同一工具链生成、或恶意构造),ingress 校验通过后若仍写进同一个扁平 key,B 的会话照样覆盖 A 的条目、A 的 stop 事件照样清掉 B 的气泡——**入口隔离了,状态层没隔离,等于没隔离**。canonical key 必须由统一 helper 做碰撞安全编码,不得靠裸分隔符拆回 raw;raw 永远来自 session 元数据。

**B4 — 目标 runtime 与远端本地 Clawd 共用配置域 → 直接阻止部署。**
Phase 1 只有 `account-default` layout:preflight 探到远端 `~/.clawd/runtime.json` 存在且 ownerPid 存活 → **阻止部署,不提供确认继续**。v3 的"确认提示 + 活 runtime 优先"方案**作废**:Claude 的 PermissionRequest 是写死在 settings.json 里的**静态 URL**(install.js:741-750、:1013),在共用配置域内部署一旦发生,该机器上 Claude 的权限请求就被永久指向部署者的隧道——**没有任何运行时优先级能挽回**,因为根本不存在"运行时选择"这一步,URL 就是终点。命令 hook 侧即使做到"活 runtime 优先",permission 侧仍然是 split-brain:状态归本地、审批归远端部署者。split-brain 不可接受,唯一正确处置是不让重叠发生。
Phase 2 的 `profile-isolated` layout 与默认本地 Claude/Codex 配置域不重叠时,允许与远端本地 Clawd 并存;但必须通过 P2V6 证明 isolated wrapper 的 settings/hooks/session roots 与默认 layout 完全分离,否则仍按 B4 阻止。Phase 1 文案明示:"该远端机器正在运行 Clawd 桌面版,默认 Remote SSH 配置域会与它冲突;请使用未运行 Clawd 的账号/机器。共享账号隔离模式将在 Phase 2 提供。"

**B5 — nonce 轮换必须有可持久恢复的 transaction phase。**
轮换是一次 **A→B 事务**,状态机持久化在 prefs(经 settings-controller command):`{runtimeKey, layoutVersion, phase, fromNonce, toNonce, startedAt, previousExpiresAt, steps:{identity, secureMarker, hookFiles, installClaude, installCodex, installCopilot, claudePermission, codexMonitor}}`。事务从开始到 commit 必须绑定同一 immutable runtime layout;切换 `runtimeMode/runtimeKey` 不是 nonce 轮换,必须先按旧 layout 做 ownership-checked cleanup,再对新 layout 开新事务。每个 step 状态为 `pending | done | not-applicable | failed`;`not-applicable` 必须带可复验原因(例如远端未安装该 agent、monitor 未启用、Claude permission 已安全回落 native),不能拿"命令 exit 0"冒充完成。规则:
- 失败重试**只能 resume 当前 A→B 事务**(继续未完成的 step),**绝不允许 mint 一个新的 C** —— mint C 会让远端某些组件停在 B、某些停在 A,而本地只认 C 和 previous(=B),停在 A 的组件全部被拒且无人知道,这正是"无法撤销旧凭证"与"继续串台"的合流点;
- **只有 identity、secure marker、hookFiles 安全版本、全部适用 installers、Claude permission 形状、适用的 Codex monitor 全部 `done` 或经复验为 `not-applicable` 之后,才允许正常 commit 并清 previousNonce**。`hookFiles` 必须按部署 manifest/version 或 hash 读回验证,尤其要证明远端 `server-config.js` 已是 fail-closed 版本;任一必需组件未确认 → previous 暂留、事务保持未完成态、UI 显性化"轮换未完成";
- 事务未完成期间**禁止普通路径发起新的轮换**(含 D8 自动 repair),避免事务嵌套;只有 B5 明定的安全紧急吊销可以中止旧事务;
- A 的接受期必须有硬上限:`previousExpiresAt` 默认 `startedAt + 15min`;到期后 ingress **无条件拒绝 A**,即使事务仍未完成,以可见的事件丢失换取旧凭证不无限续命。另提供显式 **Force revoke old identity**:可在未完成事务中立即清 A、将仍依赖 A 的 step 标为需 repair;若怀疑 B 也泄漏,允许安全优先地 abort 当前事务、停止 ingress 接受 A/B、mint C 后从头部署。该紧急路径是“禁止嵌套轮换”的唯一显式例外,必须二次确认并明示远端上报会中断;
- 逐组件验证手段:identity/marker=写后读回比对;hookFiles=manifest/version/hash;installers=读回 settings/hooks.json 断言 managed marker 与安全命令形状;permission=URL 中 nonce 为 B,或验证 managed remote PermissionRequest 已不存在并记录 native fallback;monitor=启用时 PID 存活、启动时间晚于 `startedAt` 且进程使用安全 transport,未启用时复验 `not-applicable`。

**B6 — cleanup/uninstall 前必须重新读取远端 identity 并精确匹配。**
`cleanupRemote` / profile 删除 / `stopCodexMonitor` / hooks 卸载 / 身份文件删除 —— 唯一允许的顺序为:**先取得目标 `runtimeKey` 的 B2 lease → 在锁内重新读取 `layout.identityFile` → 精确匹配 `installId` + `profileId` + `runtimeKey` + `layoutVersion` → 才允许清理**。锁外读取只能用于 UI 预览,不得作为授权判据:
- 锁内匹配 → 按序执行(stop monitor → 卸载 hooks/registrations → 删身份文件 → 最后删 secure marker),全程每个 live mutation 都 assert 当前 lease;
- **缺失或不匹配 → 全部跳过,报 ownership conflict**,一个字节都不改。
现状 [remote-ssh-deploy.js:383-430](../../src/remote-ssh-deploy.js) 的 `stopCodexMonitor` 无条件 `kill $(cat ~/.clawd-codex-monitor.pid)`、cleanup 无条件卸载 hooks——共享 HOME 下这是**用删除权限踩别人**:A 删自己的 profile 会杀掉 B 的 monitor、卸掉 B 的 hooks。这条不修,#513 会以"对方把我的部署删了"的形态继续存在。

**X1 — Phase 1 必须落地 `runtimeKey → remote layout` 单一解析层,不得继续散落 HOME 假设。**
新增纯函数/纯数据 helper `resolveRemoteRuntimeLayout({runtimeMode, runtimeKey, remoteHome})`,一次性产出并校验所有远端路径:`runtimeRoot`、`claudeConfigDir`、`claudeHooksDir`、`claudeSettingsFile`、`codexHome`、`codexSessionsDir`、`copilotHome`、`clawdStateDir`、`identityFile`、`secureMarkerFile`、`hostPrefixFile`、`statuslineSidecarFile`、`lastLogFile`、`deployLockDir`、`deployStagingDir`、`monitorPidFile`、`legacyMonitorPidFile`。`hostPrefixFile` / `statuslineSidecarFile` 必须从该 layout 的 `claudeHooksDir` 派生,不得再由远端模块用 `os.homedir()` 解析;`legacyMonitorPidFile` 仅在 `account-default` 返回旧 `$HOME/.clawd-codex-monitor.pid`,isolated layout 必须为 `null` 且不得触碰。identity 与锁 owner 同时记录 `runtimeKey + layoutVersion`;任何两个 layout 只要会读写同一份 live 文件,就**必须解析成同一个 runtimeKey/lock**,反之才允许并发。字段表必须覆盖 deploy、installer、hook、statusline、monitor、cleanup 读写的**每一个**远端 live 文件;新增远端文件必须同步进入 layout/path-set 测试。
- `account-default`(Phase 1 唯一可选模式):`runtimeKey` 强制规范化为固定保留值 `account-default`,不得按 profile 随机生成;Claude/Codex/Copilot 用户目录仍为 `$HOME/.claude`、`$HOME/.codex`、`$HOME/.copilot`,所有本地 Clawd/profile 因而竞争同一个 lock/ownership domain。共享账号仍按 D6 阻断,行为不缩水;
- `profile-isolated`(Phase 2 启用):`runtimeRoot=$HOME/.clawd/profiles/<runtimeKey>`,`claudeConfigDir=$runtimeRoot/claude`,`codexHome=$runtimeRoot/codex`,`copilotHome=$runtimeRoot/copilot`,`clawdStateDir=$runtimeRoot/clawd`;hook/identity/marker、锁/staging/PID、Claude/Codex/Copilot 用户级配置与 monitor sessions 全部从这些根继续派生,不得回退读取账号默认目录;
- isolated `runtimeKey` 才是本地为 profile 生成并持久化的 opaque stable ID,只允许安全字符且不得由 hostname/username/raw path 直接拼接;迁移/导入 prefs 时发现重复 key 必须阻止激活,不得让两个 profile 静默共用一个 isolated root;
- **`installId` 的授权来源不得随 prefs 复制**:本机生成 256-bit installation binding secret,优先用 Electron `safeStorage` 的非 `basic_text` 后端加密,独立保存在不参与 prefs export/sync 的 installation identity record;`installId = SHA-256(bindingSecret)`(编码为稳定 opaque ID),prefs 最多缓存其公开 ID、绝不作为授权真相。record 缺失、解密失败、公开 ID 不一致或导入 prefs 未带有效 binding 时,必须重新 mint,清空/禁用复制来的 `routingNonce`、`previousNonce`、未完成 txn 与 isolated-active 标志,并让全部导入 profile 进入 D6 ownership conflict/显式重新部署流程,**在解决前不得启动隧道或 ingress**。Linux 若 `safeStorage` 仅为 `basic_text`，仍把 record 排除在 prefs 导出之外并在 UI/文档声明“不防完整 userData/整机镜像克隆”;完整 OS/VM 连同凭据存储一起复制属于无法由进程自证区分的同一机器身份边界,不得虚假宣称可检测;
- Phase 1 的 deploy/runtime/cleanup/probe/installer/monitor 代码**只能消费 layout 对象,不得自行拼 `~/.claude`、`~/.codex`、`~/.clawd-codex-monitor.pid` 或全局 lock**。默认本地路径只能在获准的单一 resolver 内按调用时解析;remote-capable 模块不得保留 agent/Clawd mutable path 的模块加载期 `os.homedir()` 常量。Phase 1 UI 暂不开放 isolated mode,但 V31 必须以 synthetic isolated layout 实际执行远端入口并验证命令、模块解析、锁、identity、cleanup 和 monitor 路径均不泄回 poison HOME。这样 Phase 2 是打开第二种 layout + 启动器/迁移 UX,而不是推翻 B1-B6。

---

## 2. 设计总览

```
远端(共享服务器;图示 account-default)      本机(用户 A 的 clawd)
┌────────────────────────────┐            ┌─────────────────────────────┐
│ ~/.claude/hooks/           │            │ 主入口 127.0.0.1:23333       │
│   clawd-remote.json (600)  │            │  /state /permission          │
│   {version, profileId,     │            │  ← 仅本地 hooks,行为完全不变 │
│    installId, remotePort,  │            │  ← 永不再作为 -R 转发目标    │
│    routingNonce, deployedAt}│           ├─────────────────────────────┤
│                            │            │ profile A 专用 ingress       │
│ hooks 读文件 → 只打         │  ssh -R    │  127.0.0.1:<ephemeral>       │
│ 127.0.0.1:<remotePort>     │═══════════▶│  仅 /state /permission[/n]   │
│ 带 nonce;打不通/验不过 →    │  隧道      │  nonce 必验,验不过一律拒     │
│ 丢弃,绝不扫别的端口         │            │  (404,无 clawd header)      │
└────────────────────────────┘            └─────────────────────────────┘
```

### 拍板决策

**D1 — 每个 profile 一个本机专用 ingress,主入口退出隧道。**
新建每 profile 一个 HTTP listener,绑 `127.0.0.1:0`(临时端口,连接时创建、断开时销毁,无端口管理负担)。`ssh -R` 的本地目标从 `getHookServerPort()`([remote-ssh-runtime.js:448](../../src/remote-ssh-runtime.js))改为该 ingress 端口。**主入口(23333)从此永不被隧道暴露**,本地 hooks 的零信任现状原样保留、完全不受影响 —— 这就消解了"无 token 请求分不出本地还是隧道"的死结:隧道来的流量物理上只会落在 ingress 上,而 ingress 无一例外要验身份。

**D2 — 远端只打精确端口,废除扫描;打不通宁可丢弃。**(B1 的展开)
secure 模式按 B1 的三重判据(`CLAWD_SSH_REMOTE=1` / `layout.secureMarkerFile` / `layout.identityFile` 任一)进入,**独立于 WSL 检测与既有 `CLAWD_REMOTE`**;secure 模式下只有完整合法 identity 才能让 `getPortCandidates` 返回 `[remotePort]`,`postStateToRunningServer` / `postPermissionToRunningServer` / `discoverClawdPort` **不做任何 fallback 扫描**。连接失败、身份缺失/损坏/读取失败 → **一律 fail closed 丢弃事件**。**失败日志必须有界**:statusline 等高频客户端每次调用都是新进程,进程内去重无效,改用 `layout.lastLogFile` 的 mtime(同类失败 ≥5 分钟才写一行 stderr);持续性诊断交给本地侧(app 自己知道隧道死活 + ingress 拒收计数进 Doctor,见 D5)。nonce 是"验证目标"的凭证,**不是"扫描选目标"的钥匙** —— 拿着 nonce 挨个敲门本身就是把探测面暴露给所有邻居。核心不变量:**A 的端口不可用时,A 宁可不上报,也绝不出现在 B 的 HUD 上。**
**Env 门控审计**:`CLAWD_REMOTE` 继续用于 timeout 放宽、host 标注、跳过远端 PID 解析,并且是 `session-recovery-lease.js` 阻止在远端共享 `$HOME/.clawd/session-recovery-v1` 落 profile 无关 lease 的既有护栏;Remote SSH secure 注册**必须同时保留 `CLAWD_REMOTE=1` 并新增 `CLAWD_SSH_REMOTE=1`**,不得以“secure 判据解耦”为由只留新变量。普通 WSL 保持不变;新 `CLAWD_SSH_REMOTE=1` 只由 app 内 Remote SSH 部署写入 command/statusline/Codex/Copilot/monitor 注册。command hook 走 env 前缀(install.js buildCommandHookSpec :504-510)、statusline 走 [install.js:1629](../../hooks/install.js)、Codex 走 commandEnv([codex-install-utils.js:477-480](../../hooks/codex-install-utils.js));Copilot 与 monitor 的新 marker传递列为实现/测试必查项。即使某条新 env 链断裂,远端 marker 或 identity 路径仍使新版 transport fail closed,不得退化成扫描;V31/V33 必须触发一次真实 hook state 路径并断言 recovery lease 未落远端 HOME。
**混合桌面不做优先级,直接阻止部署**:v3 的"存活本地 runtime > 身份文件"优先级方案**已按 B4 作废** —— Claude permission 是静态 URL,不存在运行时择优的时机,任何优先级设计都救不了 permission 侧的 split-brain。远端探到存活的本地 clawd → preflight 阻止部署(B4/D6),不确认、不继续。

**D3 — 身份文件 `layout.identityFile`,0600,stdin 写入,秘密永不进 argv。**
字段 `{version: 2, layoutVersion, runtimeKey, profileId, installId, remotePort, routingNonce, deployedAt}`:
- `routingNonce`:`crypto.randomBytes(16).toString("hex")`,每 profile 持久化在本地 prefs,每次 deploy 轮换(重部署即吊销旧凭证);**轮换的双写一致性按 D9 的两阶段事务执行**,不允许"本地或远端单边先行"的裸写;
- `installId`:由 X1 的 installation binding secret 派生,installation identity record 才是本机授权真相;prefs 只缓存公开 ID。启动时 record 缺失/不可解/与缓存不符必须先执行 clone recovery(重 mint + 吊销本地复制 nonce/txn/active),不得用 prefs 中的旧 ID/nonce 建 ingress 或隧道 —— 用于共享 HOME 冲突判定(D6);
- 写入复用 host-prefix 的 stdin 管道模式([remote-ssh-deploy.js:270-287](../../src/remote-ssh-deploy.js)),但目标必须来自 layout,并以**同目录临时文件 + 原子 rename**落地(B1):`umask 077 && cat > "$identityTmp" && mv -f "$identityTmp" "$identityFile"`。路径由本地严格生成并经现有 SSH quoting helper 传入,不得接受远端 payload 回传的任意 path。**nonce 走 stdin,绝不出现在 ssh argv**(共享服务器上 argv 对所有用户可见,`ps` 即泄漏);半写文件在 secure 模式下会 fail closed 掐断上报,原子 rename 是必需项不是优化;
- secure marker 同样以临时文件 + 原子 rename 落地,内容只含协议版本、不含 nonce;identity 与 marker 都必须在新版 `server-config.js` promotion 前就绪(B1);
- 同理:探针脚本和 codex monitor 的 nonce 都**在远端自行读文件**,不经命令行传参;
- ⚠️ 0600 身份文件**不是 nonce 的唯一载体**(D4 的 URL、安装备份、日志都是),全部载体与处置见"秘密卫生"小节 —— v1 在此处的"秘密只存 0600 文件"是过度声明,已撤回。

**D4 — nonce 双通道:header 为主,URL 路径段专供 Claude HTTP hook。**
- command hook / statusline / monitor / 探针:请求头 `x-clawd-routing-nonce`(server-config.js `postStateToPort` :350-386、`postPermissionToPort` :463-502 统一附加);
- Claude PermissionRequest 是 HTTP hook,配置结构只有 `{type, url, timeout}`(install.js:741-750),**仓库内无任何自定义 header 支持的证据** —— nonce 嵌 URL:`http://127.0.0.1:<remotePort>/permission/<nonce>`。ingress 的 /permission 路由同时接受 header 与路径段两种携带方式;
- `install.js --remote` 改为从 clawd-remote.json 读 `{remotePort, routingNonce}` 生成 URL(部署顺序保证文件先落地,见 §3 步骤 4);`isPermissionUrl` 识别器(server-config.js:257-268)同步扩展识别新形状,避免安装器反复 churn;
- ⚠️ **必须真实 Claude 验证**带路径段的 URL 端到端可用(批准/拒绝/超时三态),这是验证矩阵的不可跳过项(§4 V5);
- **最终 fallback:path 与 query 都不可用时,不注册远程 PermissionRequest,回落 Claude 原生审批。** 不再造第三种"秘密路径"变体 —— 任何无凭证的 permission 入口都是 #513 的原始泄漏面,宁可远端权限气泡功能不可用(用户在远端终端里用 Claude 自己的审批 UI),也不开一个无法验证归属的入口。该情形下 UI 明示"该远端不支持权限气泡,请在远端终端内审批",其余通道(state/quota)不受影响。

**D5 — 无宽限:ingress 对无 nonce / 错 nonce 一律拒收。**
拒收响应为 404、**不带** `x-clawd-server` header、通用 body —— 对旧版扫描 hook 呈现为"这里没有 clawd",该端口**绝不会被计为投递成功**。旧 hook 随后仍可能继续扫描并命中邻居的旧版无认证主入口,所以这里只承诺保护本 ingress 的 inbound,不谎称旧 hook 已获得 outbound 隔离(见兼容矩阵)。比较用 `crypto.timingSafeEqual`。被拒事件在本地累计计数并在 Doctor 面板给出提示("检测到被拒绝的远端事件 —— 远端 hooks 版本过旧或存在他人部署"),把静默失败变成可见信号;计数数字本体为 Phase 1 MUST,V20/O1 只允许后置文案打磨。
明确否决首版方案的"无 token 宽限照收":隧道流量落到本机后源地址同样是 127.0.0.1,服务端无法区分"本地 hook"与"旧远端 hook",宽限=泄漏原样保留。**单用户旧模式的兼容靠"主入口不变"实现,不靠 ingress 放水。**

**D6 — 部署 ownership preflight:以 runtimeKey 为域,锁内复检,冲突分类处置。**(B2/B4/X1 的展开)
preflight **必须前置于一切破坏性步骤**——scp 覆盖 hook 文件、身份文件写入、codex monitor 的 PID pre-kill(`startCodexMonitor` 现状会先杀账号级 `~/.clawd-codex-monitor.pid` 里记录的旧进程,[remote-ssh-deploy.js:343-381](../../src/remote-ssh-deploy.js);共享 HOME 下这一步直接杀掉对方的 monitor)。且按 **B2:先取 `layout.deployLockDir`,拿锁后重新跑一遍完整 preflight**(TOCTOU 窗口),未拿到锁则零写入退出。判据只针对所选 runtime layout,不得扫描别的 isolated root 并把“存在”误判为冲突:
- `layout.identityFile` 不存在且该 layout 无任何 clawd 痕迹 → 正常部署;文件存在且 `(installId, profileId, runtimeKey, layoutVersion)` 均为本机本 profile → 正常重部署(按 D9/B5 轮换 nonce);
- **目标配置域与远端存活的本地 clawd 重叠** → **直接阻止部署,无确认继续选项**(B4)。Phase 1 的 account-default 一律视为重叠;Phase 2 只有完整验证过的 profile-isolated layout 才可判为不重叠。Claude permission 是静态 URL,在重叠配置域内部署即永久改写该机器的审批去向,不存在运行时优先级可挽回;split-brain 不接受;
- **遗留部署或 identity 缺失**:无 identity 但有 secure marker、clawd-host-prefix、hook 文件、monitor PID 文件、settings.json 我方 MARKER 条目任一存在 → **一律要求用户显式 Deploy / Repair**。`lastDeployedAt` 或 `managedDeployTargets` 只能证明本机过去写过,不能证明远端当前仍属于本 profile,不得作为无人值守 mutation 的授权;确认前 secure transport 保持 fail closed;
- 同一 `runtimeKey` 下 `installId` 等于本机但 `profileId` 不同 → 本机的另一个 profile 已管理该 runtime,**须显式选择"移交给新 profile"**,不静默覆盖(否则旧 profile 隧道空转、事件全走新 profile、host 标签错乱);
- 同一 `runtimeKey` 下 `installId` 不同 → **无条件阻止自动路径**。account-default 文案明示"该远端账号的默认 runtime 已由另一台 Clawd 实例管理(部署于 <deployedAt>);请等待共享账号隔离模式或改用各自系统账号"。接管**只能由用户在 UI 显式确认**,带响亮警告("接管后,该 runtime 下其他人的 agent 会话将全部路由到你的桌面"),**不提供无人值守接管** —— "对方端口无活隧道 = 遗留"的判定不可靠(对方可能只是合盖离线),自动接管会把 #513 的泄漏以**带有效凭证**的形式重新造出来;
- **同账号内 0600 不设防**:文件属主就是共享账号本身,账号内任何人都读得到 nonce、伪造得了事件。nonce 的隔离力**只存在于账号之间**;账号内多人 = 不支持安全自动隔离,如实写进 UI 与文档;
- JSONL fallback 边界照实陈述:account-default 的 `layout.codexSessionsDir=~/.codex/sessions` 按账号共享,所以 Phase 1 遇同账号冲突必须阻断;profile-isolated monitor 只允许读取自己的 `layout.codexSessionsDir`,**不得同时或失败后回落扫描 `~/.codex/sessions`**。

**D7 — profileId namespace:canonical key 必须含 profileId(Phase 1 MUST)。**(B3 的展开,v3 的 SHOULD 定级作废)
ingress 校验通过后把 `profileId` 注入下游上下文。统一 `makeSessionKey({profileId, rawSessionId})` 产生碰撞安全的 opaque canonical key(编码或长度前缀,**不以 `::` 裸拼并反向 split**);本地 scope 使用保留值 `local`,远端 scope 使用受信 profileId。session 记录同时保存 `profileId` 与 `rawSessionId`;snapshot 中 `session.id` 仍为 canonical action ID,`rawSessionId` / `displayTitle` 才用于可见文字。落点:
- `/state` 会话表:[state.js:1333](../../src/state.js) `updateSession` 及全部 `sessions.get/set/delete`(:836/:881/:1087/:1110/:1447/:1509/:1685-1688 等),LRU 淘汰 :1062,元数据更新 :1143/:1168;
- `/permission`:`ctx.pendingPermissions` 入队与查找([server-route-permission.js:362](../../src/server-route-permission.js)、:370);
- Codex turn 跟踪:`codexOfficialTurns` Map([server.js:88](../../src/server.js),消费点 server-route-state.js:356);
- Codex user-input 气泡:`clearCodexUserInputBubbles`([permission.js:2459](../../src/permission.js),调用点 agent-runtime-main.js:230、server-route-state.js:305);
- 会话清理:`state-stale-cleanup.js` 全路径、subagent 恢复/删除(state.js:1685-1688)。
- snapshot 与 UI action:`state-session-snapshot.js` 输出 canonical `id` + raw 字段;HUD/Dashboard 以 canonical `id` 做 Map/反馈/IPC 参数,仅渲染 raw/displayTitle;`session-ipc.js`、focus、open-folder、ack/hide 路径继续按 canonical ID 回查;
- alias:`session-alias.js` 的 key 加 profileId scope;旧 host/agent/raw key 只读 fallback,新写入只用 profile-scoped key。
- trusted source stamping:ingress 传入的 `remoteProfile` 覆盖客户端自报 `host`,session 记录保存可信 `profileId` 与配置的 display host。`metadata_only` quota 虽不属于 session Map,也必须用稳定 `remote:<profileId>` 作内部 source key、另存 displayHost;不能继续只按可重复/可伪造的 host 字符串覆盖(`state-account-quota.js`)。旧 quota 持久化记录可读迁移,新写入用 source key。
**不做 namespace 则隔离闭环不成立**:session id 可跨远端重复(同一份 `~/.codex/sessions` 复制、同工具链生成、或恶意构造),入口验过了但状态层仍是扁平 key 时,B 的会话照样覆盖 A 的条目、A 的 stop 照样清掉 B 的气泡。同时它是 #512 "本地/远程并列建模"的地基 —— 但**不因此后置**。

**D8 — 迁移:连接时检测远端身份漂移;缺失身份不自动写。**
tunnel 建立后 app 的探针改为 nonce 化(探针 JS 在远端读 secure marker / identity 后带 header 请求,exit code 区分"安全身份缺失/损坏"、"nonce 不符"与"身份属他人")。自动 repair **只允许**远端 identity 仍精确匹配本机 `installId + profileId`、没有未完成 B5 事务,且仅安全版本/端口发生可证明的无冲突漂移;此时复用现有 backoff,单连接周期至多一次。identity 缺失时没有现时 ownership 证据,即使本地有 `lastDeployedAt` 也只能亮"需要显式 Deploy / Repair",**绝不自动 mutation**。探到外来 installId/profileId 时同样转 D6 冲突 UI 并停止本 profile 上报。发版说明必须写清:隔离以远端新 hooks **成功重部署并通过安全 cutover 验证**为准;升级本地 app 或仅建立连接都不等于已隔离。

**D9 — 身份事务:持久化的 A→B transaction,只 resume 不 mint C。**(B5 的展开)
nonce 轮换是本地 prefs 与远端多组件的多写,任何单一顺序都有中途失败导致自我拒收(self-DoS)的窗口。定案:轮换建模为**一次持久化的 A→B 事务**,状态存 prefs(经 settings-controller command):

```
{ runtimeKey, layoutVersion,
  phase: "idle" | "rotating" | "verifying" | "committed",
  fromNonce: A, toNonce: B, startedAt, previousExpiresAt,
  steps: { identity, secureMarker, hookFiles,
           installClaude, installCodex, installCopilot,
           claudePermission, codexMonitor }
  // 每项 pending|done|not-applicable|failed,not-applicable 必须带 evidence
}
```

- 正常过渡期内 ingress **同时接受 A 与 B**(timingSafeEqual 各比一次),但只到 `previousExpiresAt`(默认 15 分钟);到期后无条件拒绝 A。首次 legacy→secure 部署的 A 为空,旧无凭证 hook 在 cutover 完成前可能丢事件/继续执行 legacy 扫描,**不宣称 V14 的 secure A→B 零拒收性质适用于首次迁移**;
- **失败重试只能 resume 当前事务**——继续跑 `steps` 里未 `done/not-applicable` 的项,目标 nonce 恒为 B。**绝不允许普通路径 mint 一个新的 C**(B5):mint C 会让远端组件散落在 A/B/C 三代,而本地只认 C 与 previous,停在 A 的组件被静默拒收且无人知晓;
- **正常清 previousNonce(=A)的唯一条件:identity + secure marker + hookFiles + 全部适用 installers + Claude permission + 适用 monitor 均 `done`,或以可复验证据标为 `not-applicable`**。任一必需项未确认 → `phase` 停在 `verifying`、UI 显性化"轮换未完成,点击继续";但 A 到期后仍拒绝,不以 availability 为由无限续凭证;
- 逐项验证手段:identity/marker=写后读回比对;hookFiles=部署 manifest/version/hash,至少覆盖 `server-config.js`;installers=读回 settings.json / hooks.json 断言 managed marker 与安全命令形状;permission=解析出的 nonce 等于 B,或确认 managed remote PermissionRequest 不存在(native fallback);monitor=启用时 PID/启动时间/安全 transport 都匹配,未启用时记录 `not-applicable` evidence;
- 事务未完成期间**禁止普通路径发起新轮换**(含 D8 自动 repair),避免事务嵌套;
- **显式撤销路径**分两级:普通"继续/重置远端身份"只 resume 当前 A→B 并完成 commit;安全紧急项"立即吊销旧身份"可清 A,仍依赖 A 的组件 fail closed。若 B 也疑似泄漏,二次确认后允许 abort 当前事务、停止 ingress 接受 A/B、mint C 并从头部署;这是禁止嵌套轮换的唯一例外,宁可中断上报也要立即吊销泄漏凭证;
- 身份的 mint / persist / push / verify / commit / revoke / resume 全生命周期收进单一 controller(§3 落点 2),**持久化一律经 settings-controller 专用 command**,deploy 与 connect 只调用 controller,不各自摸 prefs。

并发部署由 **B2 的原子部署锁**排他,**v3 的"最后写者胜可接受"已删除** —— last-writer-wins 下输者带着失效 nonce 继续运行、赢者以为独占,双方都不知情。

**D10 — permission 在途请求的生命周期。**
/permission 是长挂请求:本地 `ctx.pendingPermissions` 持有打开的 res,气泡决策后才应答;abort 机制**已存在**([server-route-permission.js:317](../../src/server-route-permission.js)、:663 的 `res.on("close", abortHandler)`,语义为 PR #643 的 no-decision)。ingress 的职责是正确触发这套机制,而不是绕过它:
- **隧道死亡**(ssh 进程退出):本地 ssh 进程持有的到 ingress 的 TCP 随进程消亡 → res close → 既有 abort 路径收走 pendingPermissions 条目并撤气泡 —— 与今日主端口的断线行为同构,实现上只需验证不需新逻辑;
- **ingress 主动关闭**(disconnect / app 退出 / profile 删除):`http.Server.close()` 只停新连接、不断在途,长挂 res 会悬到远端 600 秒超时。必须调 `closeAllConnections()`(Node ≥18.2,Electron 主进程满足)强制断开,让每个在途 res 走同一条 abort 路径,**本地气泡随之撤回**,不留"批准进虚空"的悬挂气泡;
- **nonce 轮换期**的在途请求:挂起时已通过校验,轮换不追溯打断;新请求按 D9 双代校验;
- 远端侧:连接被断后 Claude 的 HTTP hook 得到传输错误,按其自身语义处理(等价 no-decision),600 秒超时上限不变(install.js:747)。

**D11 — runtime-scoped 原子部署锁。**(B2/X1 的展开)
锁对象:`layout.deployLockDir`,以 `mkdir`(POSIX 原子)获取,目录内写 `owner` 文件记 `{leaseId, installId, profileId, runtimeKey, layoutVersion, acquiredAt}`。覆盖该 runtime 的**全部 live remote mutation**:hook files promotion、身份/marker 写入、三个 installer、monitor pre-kill/启动、cleanup/uninstall。规则:
- 获取失败 → **零写入退出**,报"另一台 Clawd 正在部署到该远端(<owner 摘要>),请稍后重试";不排队、不强夺;
- `mkdir` 成功后必须在同一 SSH shell 立即原子写 owner;写 owner 失败时该 shell 仅按当前 leaseId 尽力删除自己刚建的空锁并退出。进程在 `mkdir` 后、owner 落盘前崩溃仍可能留下 ownerless lock:后续获取者必须把“锁目录存在但 owner 缺失/损坏”识别成独立诊断态,继续零写入、不自动破锁,UI 展示精确 `layout.deployLockDir` 与 D11 手工恢复步骤;不得把无 owner 当成无锁;
- 获取成功 → **重新执行完整 D6 preflight**(TOCTOU),再进入 mutation;
- 每个 live mutation 前在同一 SSH 命令中核验 `leaseId + runtimeKey + layoutVersion`;hook files 的 scp 只写 `layout.deployStagingDir/<leaseId>/`,真正替换 live hooks 的 promotion 必须先 assert lease。staging 残留不参与运行,可在持锁时按年龄清理;
- 释放:正常结束、失败中止、进程退出(尽力 finally)三条路径都调用 `releaseDeployLock(expectedLeaseId)`,**只有 owner leaseId 匹配才能删除**;旧 finally 对新锁必须是 no-op;
- `acquiredAt` 超时或 ownerless/corrupt owner 只触发诊断,Phase 1 不在 app 内自动或确认后破锁。恢复说明要求先停止所有相关 Clawd/部署进程,再手工删除精确锁目录;未来在线接管必须另做单调 fencing token;
- 锁的持有者信息用于诊断,**不作为 ownership 判据**——ownership 一律以身份文件为准(D6/B6)。

**D12 — cleanup/uninstall 的 runtime ownership 门。**(B6/X1 的展开)
现状 [remote-ssh-deploy.js:383-430](../../src/remote-ssh-deploy.js) 的 `stopCodexMonitor` 无条件 `kill $(cat ~/.clawd-codex-monitor.pid)`、`cleanupRemote` 无条件卸载 hooks —— 共享 HOME 下 A 删自己的 profile 会杀掉 B 的 monitor、卸掉 B 的 hooks。定案:任何清理动作前**按本地持久化信息解析 immutable layout,再锁内读取 `layout.identityFile`,精确匹配 `installId + profileId + runtimeKey + layoutVersion`**:
- 固定顺序:**解析 immutable layout → 获取该 `runtimeKey` 的 D11 lease → 在锁内重新读取 `layout.identityFile` → 匹配 installId/profileId/runtimeKey/layoutVersion → stop `layout.monitorPidFile` 对应进程 → 仅卸载该 layout 的 hooks/registrations(Claude/Codex/Copilot + statusline 还原)→ 清该 layout 的 `hostPrefixFile` / 已消费的 `statuslineSidecarFile` / log 与安全 staging → 删身份文件 → 最后删 secure marker → 按 leaseId/runtimeKey 条件释放**。锁外预读只供 UI 展示,绝不授权;`legacyMonitorPidFile` 不属于普通 isolated cleanup,只按残留清单的 account-default Repair/cutover 门处理;
- **缺失或任一字段不匹配 → 全部跳过,报 ownership conflict**,一个字节都不改;UI 明示"该远端当前由其他 Clawd 实例/profile 管理,已跳过清理;如确需清理请在那台机器上操作或手动清理远端";
- profile 删除时若清理被跳过,本地 profile 仍可删除(本地状态用户有权处置),但必须提示远端残留未清。

### 秘密卫生:nonce 的全部载体与处置

nonce 不只活在 0600 身份文件里(v1 的表述过度声明),逐载体列全:

| 载体 | 成因 | 处置 |
|---|---|---|
| `layout.identityFile` | 主载体 | 0600 + stdin 写入(D3) |
| 远端 `layout.claudeSettingsFile` 的 permission URL | D4 的 URL 路径段是结构性必然 | 安装器写入后对该文件 chmod 600(尽力;Claude Code 后续重写不保证保持);Doctor 增加远端文件权限检查项(SHOULD) |
| settings.json 的**安装备份** | install.js 写前快照([install.js:1039-1047](../../hooks/install.js) writeJsonAtomicWithBackup) | 备份文件同 chmod 600;备份里的旧 nonce 在 D9 commit、`previousExpiresAt` 到期或显式紧急吊销三者最早发生时失效(默认过渡窗 ≤15min)。**审计口径:备份允许含"已失效"的 nonce,不承诺不含**(V17) |
| deploy 进度 / Doctor / console / hook stderr 日志 | 打印 hook URL 或身份文件内容时 | **一律脱敏**:URL 打印统一掩码 nonce 段(`/permission/****`),身份文件内容永不整体打印;脱敏进测试断言(V17) |
| uninstall / cleanup 路径 | 旧版卸载不认识新 URL 形状会漏删 | `isPermissionUrl` 扩展(§3 落点 7)同时覆盖安装同步与卸载识别;cleanup 删身份文件(§3 落点 5) |
| 同账号其他人 | 0600 对同 owner 不设防 | Phase 2 可用独立 roots 防止合作使用时误读/误写,但同 UID 仍能主动读取或伪造;UI/文档明确其不是 OS 安全边界(D6/§5) |

### 旧部署残留清单

| 残留物 | 生命周期 | 归宿 |
|---|---|---|
| **孤儿 codex-remote-monitor** | `nohup` 启动([remote-ssh-deploy.js:376](../../src/remote-ssh-deploy.js)),**ssh 断开后长存**;老代码 direct-miss 后回落扫描;旧 PID 位于账号级 `$HOME/.clawd-codex-monitor.pid` | **从不重连的旧部署留下的孤儿是 old→old 泄漏长尾**——它扫到谁的旧版隧道就投给谁。新版收敛:新 monitor 去回落(§3 落点 8)+ 新 ingress 拒收;PID/日志/会话根全部 layout-scoped;`legacyMonitorPidFile` 只归 account-default cutover。Repair 处理旧 PID 前必须持 account-default lease、满足 D6 ownership/显式遗留确认,并核验 PID 的真实 command line 确为预期 `codex-remote-monitor.js`;PID 缺失、复用或命令不符一律不 kill。isolated layout 不读取/删除旧 PID。再加自退出保险(连续 N 小时投递失败即 exit,SHOULD,O3);发版说明明示"不再使用的远端请清理或至少重部署一次" |
| 旧 permission URL(硬编码 23333) | 存于远端 settings.json | 重部署时被安装器重写为 pin+nonce 形状 ✓ |
| 旧 hook 文件 | account-default 下为 `~/.claude/hooks/*.js` | scp 同名覆盖 ✓(HOOK_FILES 清单);profile-isolated 只写自己的 `layout.claudeHooksDir` |
| settings.json 旧备份 | 见秘密卫生表 | nonce 轮换后失效 ✓ |
| 版本回退(装过新版再退回旧版) | 旧版 `isPermissionUrl` 不识别 nonce 形状,同步/卸载会漏改新条目([install.js:708-733](../../hooks/install.js) syncHttpHook 按识别器原位改写,升级方向 ✓,回退方向识别不到) | 不支持回退;文档写明回退后需重装 hooks 或手动清理 settings.json 条目 |

### 一图流兼容矩阵(v7:升级本地 app 不等于隔离)

**隔离能力由远端 hooks 的版本决定,不由本地 app 的版本决定。** 本地升级只带来 **inbound** 防护(自己的 ingress 不再收别人的事件);**outbound 隔离(自己的会话不再泄给邻居)只有在成功重部署新 hooks 之后才具备**。

| 本地 app | 远端 hooks | inbound(别人进得来吗) | outbound(自己漏出去吗) |
|---|---|---|---|
| 新 | 新(重部署成功) | 拒收非法 nonce ✅ | pin+nonce,只打自己的 ingress ✅ **完全隔离** |
| 新 | 旧(未重部署) | 自己的 ingress 拒收 ✅ | ❌ **仍会泄漏**:旧 hook 继续扫描 23333-23337,**扫到邻居仍在运行的旧版主入口就投进去**(邻居旧 app 的主入口不验 nonce、照单全收)。自己的 HUD 看不到数据 ≠ 数据没跑出去 |
| 旧 | 旧 | ❌ 照收 | ❌ 泄漏(含孤儿 monitor 长尾) |
| 旧 | 新 | ❌ 主入口不验、照收 | 新 hook 会打 pinned remotePort;若旧 SSH 配置仍把该端口转到旧 app 主入口则可用但**没有 inbound 鉴权**,若无对应转发则投递失败。此组合不提供完整隔离保证 |

**结论写进发版说明**:①"我升级了"不代表"我不再泄漏",必须**显式重部署成功并通过安全 cutover**;②在同一台共享服务器上,只要还有任何一位用户跑着旧版 app + 旧 hooks,ta 的主入口就是一个无凭证收集点,其他人的旧 hooks 会继续投进去 —— 完全消除需要该服务器上所有用户都升级并重部署;③D8 对 identity 缺失/旧部署不自动写,不能假设"连一次就自动修好"。

**锁的混合版本边界**:B2 lease 只能约束新版 controller;旧 app/旧 `scripts/remote-deploy.sh` 不取新锁,仍可在新版持锁期间写 account-default live 文件。因此安全 cutover/Repair 前必须检测可见的旧 runtime/legacy mutation 痕迹并阻止或要求先升级停用;无法检测另一台离线/瞬时旧 controller 时,发版说明必须明示“所有可能部署该远端账号的 Clawd 都升级并停用旧脚本前,并发 mutation 互斥不成立”。isolated root 不被旧版识别,但从 account-default 迁移时旧域 cleanup 仍受此边界。

本矩阵描述 Phase 1 的 `account-default` mode。Phase 2 的同账号隔离另有一个额外硬门:**只有经 profile 专属 wrapper 启动、远端 deploy transaction 验证 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 与 layout 一致后,才标记 profile-isolated active**。仅创建目录、仅升级 app、仅重部署 hooks 或继续直接运行裸 `claude` / `codex`,都不算同账号隔离完成。

另一个不可探测边界是**同一 Unix 账号的另一位使用者完全不运行 Clawd**:account-default hooks 仍是账号级配置,会观察该账号下所有相关 CLI 会话,不会凭空出现 ownership 冲突信号。Phase 1 从未支持此场景;UI/文档必须直说“只要 Unix 账号由多人共享,即使只有一人安装 Clawd,也必须等待/启用 Phase 2 profile-isolated wrapper”,不得把“只装了一份 Clawd”写成安全条件。

---

## 3. 实现落点(文件 × 改动)

**实现顺序**:⓪ remote layout helper/X1 + installation binding(落点 0/2,先消灭新代码里的 HOME 拼接与可克隆身份)→ ①身份 controller/事务模型(落点 2)→ ②profileId namespace(落点 9b,B3;先于 ingress,因为它改的是下游 key 契约)→ ③ingress 与 permission teardown(落点 3、4、9)→ ④runtime-scoped 部署锁与 ownership 门(落点 5,B2/B6)→ ⑤迁移、脚本停用、CLI/WSL(落点 5-8、11 与 D8)→ ⑥V1-V33 真机/自动化矩阵(§4)。

按数据流顺序:

0. **`src/remote-ssh-layout.js`(新文件)** — X1 唯一 remote path resolver:`resolveRemoteRuntimeLayout({runtimeMode,runtimeKey,remoteHome})`;严格校验 mode/key/home,返回冻结对象与 shell-safe 的逻辑路径字段,自身不执行远端命令。account-default 与 synthetic profile-isolated 两套 fixture 必须逐字段测试,包括 co-located `hostPrefixFile` / `statuslineSidecarFile` 与 account-default-only `legacyMonitorPidFile`;其余模块不得复制路径规则。installer/hook 侧以 `__dirname` + 显式 env 解析 co-located identity/marker/host-prefix/statusline sidecar,与 app layout 互证。
1. **`src/remote-ssh-profile.js`** — schema 增加 `runtimeMode`、`runtimeKey`、`layoutVersion`:account-default 永远归一化为保留 key `account-default`;profile-isolated 才生成 stable opaque per-profile key,并做 prefs 全局重复检测。Phase 1 只允许 `account-default` active;`profile-isolated` 值仅供迁移/feature gate 后启用。另增加 `routingNonce` / `previousNonce` / `previousExpiresAt` 与完整 txn 状态校验、sanitize 保留;`REMOTE_FORWARD_PORTS` 保持不变但**改写 :27-34 的设计注释**(约束理由从"保证扫描能扫到"改为"pin 端口的取值域 + 旧版共存期的可预期性")。
2. **`src/remote-ssh-identity.js`(新文件)+ `src/settings-controller.js` + `src/prefs.js`** — D9/B5 身份 controller:mint / persist / push / verify(适用组件逐项)/ commit / revoke / force-revoke / **resume** 全生命周期单点收口,并管理 X1 installation binding record。record 固定为 `path.join(app.getPath("userData"), "clawd-installation-identity.json")`,独立于 `clawd-prefs.json` 的 export/sync,保存 `{version, encryptedBindingSecret, installId, storageBackend, createdAt}`;写入 0600 + 临时文件原子 rename。可用强 `safeStorage` 时必须加密,不可用或为 Linux `basic_text` 时降级边界要显式暴露。**prefs 持久化一律经 settings-controller 的专用 command**(如 `applyCommand("commitRemoteIdentity", …)`)—— settings-controller 是 prefs 快照的唯一写入者([main.js:247-250](../../src/main.js)),identity 模块不绕过 controller 修改 prefs;prefs 归一化(:375-378 一带)透传 `{runtimeKey, runtimeMode, layoutVersion, routingNonce, previousNonce, previousExpiresAt, txn:{runtimeKey,layoutVersion,phase,fromNonce,toNonce,startedAt,previousExpiresAt,steps}}` 与公开 `remoteSsh.installId` 缓存。启动必须先验证 binding 再启动 Remote SSH runtime;clone recovery 经专用 command 原子清掉复制 nonce/txn/active 并重 mint。事务 resume 时 layout 任一字段不一致必须停止并要求显式恢复,不得把 A→B 续到另一目录。
3. **`src/remote-ssh-ingress.js`(新文件)** — `createRemoteIngress({profileId, currentNonce, previousNonce, previousExpiresAt, handlers})`:绑 `127.0.0.1:0`;路由仅 `GET /state`(验 nonce 后回健康应答,供探针)、`POST /state`、`POST /permission` 与 `/permission/<nonce>`;nonce 经 header 或路径段,timingSafeEqual,仅在未过 `previousExpiresAt` 时接受旧代;验不过 → 404 无 clawd header + 计数;验过 → 原样复用 `handleStatePost` / `handlePermissionPost`(注入 profileId,D7)。`close()` 内部必须 `closeAllConnections()`,保证在途 /permission 长挂 res 走既有 abort 路径(D10)。返回 `{port, close, rejectCount}`。
4. **`src/remote-ssh-runtime.js`** — `connect()`:先建 ingress,`forwardOpt` 的本地端(:472-479)指向 ingress 端口;断开/异常路径销毁 ingress;`buildProbeCommand`(:277-295)改为远端读 clawd-remote.json 附 nonce 请求,exit code 新增"身份不符"分支;连接后触发 D8 漂移检测。
5. **`src/remote-ssh-deploy.js`** — 所有入口先拿 profile 对应的 frozen layout 并向下传,不得自行拼 HOME 路径。**B2 部署 lease**:`acquireDeployLock(layout)` / `assertLease(layout, leaseId)` / `releaseDeployLock(layout, leaseId)`(mkdir 原子 + 随机 leaseId + runtimeKey 条件释放,无 app 内 stale takeover),包住该 runtime 全部 live mutation;hook files 先 scp 到 `layout.deployStagingDir/<leaseId>`,持当前 lease/runtimeKey 的 promotion 才替换 `layout.claudeHooksDir` 并按 manifest/hash 验证;**D6 preflight 拿锁后完整执行**;首次 cutover 按 B1 顺序原子写 identity、原子写 secure marker、promotion 安全 hook files、写 layout-scoped host prefix、再跑 installers;monitor 启动(:376)显式带 `--codex-home` / identity path / pinned port,nonce 由 monitor 自读文件;PID 写 `layout.monitorPidFile`;deploy 进度日志全程 nonce 掩码;legacy monitor 只在 account-default 显式 Repair/cutover 中、经 ownership/进程命令行双重核验后处理,不得因存在旧 PID 文件就 blind kill;**B6 cleanup** 固定为拿 layout lease → 锁内重读并四字段匹配 identity → 仅清该 layout → identity 删除 → marker 最后删除 → leaseId/runtimeKey 条件释放。
6. **`hooks/server-config.js`(客户端核心堵点)** — 新增 `isSshSecureMode()`(`CLAWD_SSH_REMOTE=1` / co-located secure marker / co-located identity 三重判据)与 `readRemoteIdentity()`;默认从 `__dirname` 解析 identity/marker/host prefix,允许 installer 写入的受控 env 显式覆盖,不再用模块加载期 `os.homedir()+".claude/hooks"` 常量。现有 `RUNTIME_CONFIG_PATH` 同样移出模块加载期常量,改为获准的 local/account-default 调用期 resolver(`options.runtimeConfigPath` 优先,否则调用时解析 `homeDir/.clawd/runtime.json`);secure 模式不得读取本地 runtime.json,不能为它给 V31 增加宽泛 HOME 豁免。secure 模式独立于 WSL 检测与既有 `CLAWD_REMOTE`,且只有完整合法 identity 才能返回 pinned port;secure 下 post/discover 全家附 `x-clawd-routing-nonce`、**删除 fallback 扫描路径**、**身份缺失/损坏/读失败一律 fail closed 丢弃**;`buildPermissionUrl(port, nonce)` 支持路径段;`isPermissionUrl` 识别新旧两种形状。所有 server-config 客户端继承 transport 规则,但每种 installer 仍须验证 `CLAWD_REMOTE=1` + `CLAWD_SSH_REMOTE=1` 与 layout path env 实际抵达。host 仍由 ingress 按 D7 trusted profile 覆盖,host-prefix 文件不得成为身份或路由依据。
7. **`hooks/install.js` / `hooks/codex-install-utils.js` / `hooks/copilot-install.js` / statusline 注册** — 接受 app 传入的显式 layout paths;默认行为保持现状,但不得在 remote secure 分支重新回退 `os.homedir()/.claude|.codex`。`codex-install-utils.js:getCodexPaths` 统一使用显式 `codexDir`/`CODEX_HOME` resolver,删除模块加载期默认路径常量;`install.js` 的 `unregisterAutoStart` / `isAutoStartRegistered` 补 `settingsPath`/`homeDir` 覆盖口;`claude-statusline.js` 的 chain sidecar 改为 `__dirname` co-located 或显式注入,不得保留模块加载期 HOME 常量。app Remote SSH secure 模式的注册同时带 `CLAWD_SSH_REMOTE=1` 与受控 identity/marker path;普通 WSL `--remote` 不带该 marker、继续旧本地互通语义。Claude HTTP hook URL 从合法 identity 取 port+nonce;remote secure 模式写 `layout.claudeSettingsFile` 及其备份时 chmod 600;Codex installer 写 `layout.codexHome`;console URL 掩码;`isPermissionUrl` 扩展新形状;path/query 均不可用时验证 managed remote PermissionRequest 已移除并把 step 标为 native fallback。auto-start 在 Remote SSH secure 模式禁止 spawn 远端桌面 app。本地安装和 WSL 本地 hook 路径零改动。
8. **`hooks/codex-remote-monitor.js` + `hooks/codex-session-index.js`** — monitor 接受并验证显式 `--codex-home` / identity path;session root 只取 `layout.codexSessionsDir`,不得用模块加载期 `os.homedir()/.codex/sessions` 常量或失败回退;`--port` 与 identity 不一致时以 identity 为准并告警;去除 direct-miss 后的扫描回落(:156-189 一带);PID 由 deploy 写在 layout 路径;增加自退出保险:连续投递失败超过阈值(建议 24h,O3)即 exit,收孤儿长尾。`codex-session-index.js` 已有 `options.codexDir` seam,不得误写成缺失;实现要把它与 installer/monitor 统一到同一 resolver,避免 thread name 与 hooks/sessions 读不同 root。
9. **`src/server.js` / `src/server-route-state.js` / `src/server-route-permission.js`** — 主入口路由不变;handleStatePost/handlePermissionPost 接受受信 `remoteProfile` 上下文并据此构造 canonical key、覆盖客户端自报 host;metadata-only quota 传稳定 profile source key + displayHost;Doctor 数据源加 ingress 拒收计数(**数字本体随 Phase 1**,O1 只剩文案)。
9b. **profileId namespace(B3,跨文件)** — 新增碰撞安全、无需反向解析 raw 的 session identity helper;覆盖 `src/state.js` 全部 sessions 读写、`src/state-stale-cleanup.js`、`src/state-session-events.js`、`src/state-session-dedupe.js`、`src/server.js:88` codexOfficialTurns、`src/server-route-permission.js` pendingPermissions、`src/permission.js` Codex user-input/notify 清理,以及 **`src/state-session-snapshot.js`、`src/session-alias.js`、Dashboard/HUD renderer、`src/session-ipc.js`、focus/open-folder/ack/hide 调用链**。snapshot 发 canonical `session.id` + raw/display 字段;renderer action 一律回传 canonical ID,只把 raw/displayTitle 画给用户。`src/state-account-quota.js` 另将内部 source key 改为 profileId scope,displayHost 与 key 分离,补旧持久化格式兼容。
10. **文档** — `docs/guides/guide-remote-ssh.md`(+ zh-CN)、`docs/guides/setup-guide.md`、`AGENTS.md` Common Commands:多用户章节、Phase 1/2 能力边界、**升级≠隔离,必须显式重部署成功**、安全 cutover 前仍属 legacy、同账号 isolated mode 必须通过 wrapper 启动、同 UID 非安全边界、脚本停用与替代入口。
11. **`scripts/remote-deploy.sh`(B1)** — **明确停用**:保留 shebang,紧随其后 fail-fast 报错并指向 app 内 Remote SSH 设置,不得产生任何本地探测或远端写入;删除其端口探测与 `RemoteForward 127.0.0.1:23333` 指引。理由:该脚本无 profile 概念、无本地 prefs 可写、无法参与 D9/B5 事务与 B2 lease,升级等于在 shell 里重造一遍 controller。

测试:`test/remote-ssh-{profile,runtime,deploy,ipc,node}.test.js` 全部涉及;新增 `test/remote-ssh-layout.test.js`(account-default + synthetic profile-isolated 全字段/路径逃逸/poison HOME/双 runtime path-set 交集)、`test/remote-ssh-ingress.test.js`、`test/remote-ssh-identity.test.js`(installation binding/clone recovery + layout 绑定+事务/resume/expiry/force-revoke/适用组件 commit 门)、`test/remote-ssh-deploy-lock.test.js`(runtimeKey scope/leaseId/条件释放/旧 finally/staging promotion/ownerless+corrupt lock);`state`/`permission`/snapshot/HUD/Dashboard/session-alias 测试补 canonical action ID 与同 raw 双 profile 交互;`server-config` 补三重 secure 判据、co-located identity/marker/host-prefix、pin/no-scan/fail-closed/nonce;各 installer 补 `CLAWD_SSH_REMOTE` + layout env 抵达、URL 形状与 native fallback;statusline/codex installer/session-index/monitor 补显式 root 与去模块加载期 HOME 常量。另加 remote-path 静态 guard + child-process 执行审计,不能只 grep 生成命令。**要求含变异验证**(把 nonce 校验改错、no-scan 改回扫描、secure marker 删掉、任一 remote 模块重新写死默认 HOME、让 host-prefix/statusline sidecar 逃出 layout、让克隆 prefs 继续复用 binding/nonce、commit 门提前清 previous、previous expiry 失效、lease 条件释放删掉、ownerless lock 当无锁、ownership 门挪到锁外,逐个断言测试真的红)。

### 3.1 Phase 2 追加实现:同 Unix 账号 profile-isolated runtime

Phase 2 复用 Phase 1 已落地的 B1-B6/X1,不另造第二套 deploy controller。能力依据使用 CLI 的专用 root 契约而非篡改完整 HOME:Claude Code 官方定义 [`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars) 可覆盖默认 `~/.claude`,其 settings/session history/plugins 等随该目录迁移,credentials 仅在 Linux/Windows 随 root 迁移、macOS 留在 Keychain;本机 Claude Code 2.1.211 以分离 `HOME`/`CLAUDE_CONFIG_DIR` 运行无模型调用 `claude doctor` 时,`.claude.json` 与 backup 实际创建在 config dir,**所以不得把 `.claude.json` 写成已知共享例外**,但仍须由 P2V10 用真实 session 复验支持版本的完整写入清单。Codex 官方定义 [`CODEX_HOME`](https://learn.chatgpt.com/docs/windows/windows-app#share-config-auth-and-sessions-with-wsl) 可重定向 config/auth/session history,本地 transcript 也位于 [`CODEX_HOME`](https://learn.chatgpt.com/docs/config-file/config-advanced#history-persistence);GitHub Copilot CLI 官方定义 [`COPILOT_HOME`](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference#changing-the-location-of-the-configuration-directory) 替换整个默认 `~/.copilot`(config/session/hooks/permissions 等;cache 另受 `COPILOT_CACHE_HOME` 控制)。新增范围:

1. **Profile/UI 开关** — Remote SSH profile 增加 opt-in “共享 Unix 账号隔离模式”。启用前展示将使用的 `runtimeRoot`、专属启动命令与逐 CLI/OS capability:哪些配置/会话/auth 会隔离、哪些仍共享;不得用笼统“各 CLI 都需独立登录”。切换 mode 必须先完成旧 layout 的 ownership-checked cleanup,不能原地把旧 nonce/identity 指向新目录。
2. **专属目录** — 创建 `runtimeRoot/{claude,codex,copilot,clawd,bin}`,权限默认 0700;Claude hooks/settings 只写 `claudeConfigDir`,Codex hooks/config/sessions 只写 `codexHome`,Copilot hooks/state 只写 `copilotHome`,Clawd identity/marker/locks/staging/PID 只写对应 layout。任何读取失败都 fail closed,**绝不 fallback 到 `$HOME/.claude` / `$HOME/.codex` / `$HOME/.copilot`**。
3. **专属启动器** — 在 `runtimeRoot/bin` 生成 profile 命名的 Claude/Codex/Copilot wrapper,分别 export `CLAUDE_CONFIG_DIR=<layout.claudeConfigDir>`、`CODEX_HOME=<layout.codexHome>`、`COPILOT_HOME=<layout.copilotHome>`,再 exec 部署时解析并记录的 agent 可执行文件绝对路径;Repair 重新探测/生成 wrapper。Settings 按已安装 agent 提供 “Copy … command”,**不自动修改共享的 `.bashrc` / `.zshrc`,不抢占裸 `claude` / `codex` / `copilot` 命令**。
4. **fresh-root 原则** — 初次启用不自动复制账号默认 `~/.claude` / `~/.codex` / `~/.copilot`;每个 isolated root 自行配置。Linux/Windows 上 Claude 与已验证随 root 迁移的 CLI auth 应要求在新 root 独立登录;**macOS Claude subscription OAuth 会从 Keychain 继承,新 root 不出现登录提示是已知平台行为,不得把它误判成“auth 已隔离”或部署失败**。自动复制会把旧 hooks、permission URL、可迁移 auth 和 sessions 一并带入,直接破坏隔离。未来若做导入,必须是用户显式选择、按白名单字段迁移的独立功能。
5. **激活门** — “isolated active” 只有在 identity/marker/hook manifest/installers/permission/monitor 均通过 B5 验证,且各适用 wrapper 的实际环境探针分别证明 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `COPILOT_HOME` 等于 layout、**CLI 自身也确实在对应 isolated root 产生受控产物**时才能置位。仅 env 相等、目录存在或 deploy exit 0 都不算完成;某 CLI 未采纳 root 变量时必须把该 CLI 明确排除并保持 native/default 行为,不得静默标 active。裸命令产生的默认-root 会话不归这个 profile 接收。
6. **删除语义** — 删除 Remote SSH profile 默认只 ownership-checked 卸载 Clawd managed hooks/monitor/identity,**保留 isolated Claude/Codex/Copilot config、auth 与 sessions/state**。删除整个 `runtimeRoot` 是独立的破坏性操作,必须列出精确路径与内容类别并再次确认;不得和普通 profile 删除捆绑。
7. **共享项目目录边界** — `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 隔离的是用户级配置和会话根;若两人还共用同一工作树,仓库内 `.claude/` / `.codex/` 仍是共同文件。Clawd 不自动改这些 project files;文档说明 project-level Clawd hook 条目仍可能造成重复上报,Doctor 在已知 cwd 上检测并提示。
8. **安全边界用语** — 本模式承诺“合作使用同一 Unix 账号时不会因默认路径共享而误串台”,不承诺抵抗同 UID 主动读取/篡改另一个 runtimeRoot 或伪造 nonce。这里的“账号”专指 Unix account,**不等于每个 profile 拥有独立 Claude/Codex/Copilot subscription identity**;需要 OS 级互不信任时仍以不同 Unix 账号/容器为边界;这是能力定义,不是用警告替代技术隔离。
9. **macOS Claude auth 能力边界** — 远端为 macOS 时,profile-isolated 仍可提供 Claude settings/hooks/transcript/history 与 Clawd 路由隔离,但 subscription OAuth 按 OS 用户共享 Keychain。Phase 2 v1 UI 必须显示 `Claude config/session: isolated; Claude subscription auth: shared by macOS Keychain`,不得宣称独立 Claude 登录/账号;若未来支持每 profile 的 `CLAUDE_CODE_OAUTH_TOKEN` / API key / `apiKeyHelper`,必须另做不把 secret 写进 wrapper/argv/log 的凭据设计与真机验证,不在本次暗示支持。
10. **CLI 版本与写入清单门** — activation 记录并校验各远端 CLI version;Claude isolated 初始已知基线为 2.1.211,低于或不在已验证范围的版本必须先跑只读/preflight 后阻止 active,不能靠环境变量存在放行。P2V10 以真实 CLI/session 记录 config root、账号 HOME、project root、OS credential store/cache 四类写入/读取边界;清单发现新的共享 live state 时必须回写 X1/B4/能力文案并重新评估发布门。

---

## 4. 验证矩阵(合并前钉死,逐项打勾)

| # | 场景 | 手段 | 通过标准 |
|---|---|---|---|
| V1 | 双新用户隔离:同服务器两个 Unix 账号,A=23333、B=23334,各自跑 Claude+Codex | **真机**(两台本地机或双 app 实例) | 双向零串台;各自 HUD 只见自己 |
| V2 | 旧 hook → 新 ingress | 真机或本地模拟(起旧版 postState 直打 ingress) | 拒收、不入会话表、hook 判定未投递;Doctor 显示拒收计数 |
| V3 | **核心断言:A 隧道断开/端口被 B 占用,A 的远端 hook 发事件** | 本地模拟 + 真机各一遍 | A 的事件全部丢弃;**B 的 HUD 永不出现 A**;A 侧探针/UI 显示断连 |
| V4 | 手工伪造:无 nonce / 错 nonce / 空 body 直打 ingress(curl) | 单测 + curl | 404、无 `x-clawd-server` header、会话表零写入 |
| V5 | **真实 Claude PermissionRequest 经隧道 URL-nonce 全流程**(批准/拒绝/600s 超时三态) | **真机,不可跳过** | 气泡只弹属主桌面;决策正确回传;超时不悬挂 |
| V6 | Codex official hook 远端 state+permission | 真机 | 归属正确,permission 同 V5 标准 |
| V7 | Copilot 远端 state+permission | 真机(至少受控注入) | 同上 |
| V8 | statusline/quota:两个 profile 刻意使用相同 display host 上报不同 rate_limits | 真机 + 单测 | quota 内部按 profileId source key 保持两条独立记录,display host 可相同但互不覆盖;客户端伪造 host 被 ingress trusted profile 覆盖 |
| V9 | codex-remote-monitor JSONL fallback pin+nonce,direct miss 不回落 | 单测 + 真机 | miss=丢弃不扫描 |
| V10 | account-default runtime 冲突全类:外来身份阻止 / 遗留部署确认门 / 本机他 profile 移交门 / 手动接管完整警告流 | 本地模拟(伪造 installId/runtimeKey、遗留痕迹 + 探针桩)+ 真机 | account-default 必归一化为同一个保留 runtimeKey,每类冲突都停在显式确认且**无任何自动接管路径**;另一个 synthetic isolated runtimeKey 不得被误判成同一 ownership domain |
| V11 | 单用户回归:本地 hooks 零变化;单 profile 远程全功能 | 全量测试套 + 真机 | 与今日行为逐项一致 |
| V12 | 升级迁移:新 app 连接旧部署(无 secure identity/marker) | 真机 | UI 明示"尚未隔离"并要求显式 Deploy/Repair;成功 cutover 前不承诺 outbound 安全、建议停止 agent;identity+marker+安全 hook files 验证完成后才显示"已隔离",其后零扫描 |
| V13 | 孤儿 monitor 治理:account-default Repair/cutover 遇到 legacy PID 的合法进程/复用 PID/命令不符/isolated layout 四态;新 monitor direct-miss 不回落;自退出阈值生效 | 真机 + 单测 | 仅在 account-default lease + ownership/显式遗留确认 + command line 匹配时终止旧 monitor;复用/不符/isolated 全部不 kill;远端最终仅存预期新版 monitor;miss=丢弃不扫描 |
| V14 | secure A→B 身份事务断点:在每个适用 step 前后人为中断,再重试 | 单测(全部 step 断点)+ 真机一遍 | 到 `previousExpiresAt` 前双代兜底;**重试恒 resume 同一 A→B、绝不 mint C**;必需项未全完成不正常 commit。首次 legacy 迁移另由 V12 验,不套用"全程零拒收" |
| V15 | 外来身份:连接/探针探到他人 installId | 本地模拟 | **绝不自动重部署**;冲突 UI 呈现;本 profile 停止上报;手动接管需显式确认且警告文案完整 |
| V16 | 在途 permission 收尾:①杀 ssh 进程 ②ingress 主动 close 两条路径 | 单测 + 真机 | 本地气泡撤回、pendingPermissions 清空(走既有 abort 路径);远端 hook 得到传输错误(no-decision 语义),无 600s 悬挂 |
| V17 | 秘密卫生审计:我方全部日志/输出通道 nonce 掩码;settings.json 与备份 600 权限;轮换/重置后旧 nonce 全部失效;uninstall 识别新 URL 形状 | 单测 + 人工审计清单 | 日志 grep 不到明文 nonce;**备份允许含已失效 nonce**(与秘密卫生表口径一致),残存者验证均已失效 |
| V18 | Phase 1 account-default 混合桌面:远端机器同时跑着本地 clawd(runtime.json 活) | 真机或受控模拟 | **部署被直接阻止,无"继续"选项**(B4);文案指向配置域冲突及 Phase 2 isolated mode;远端 settings.json 零改动 |
| V19 | 升级路径:旧版部署痕迹(无身份文件)上部署 | 本地模拟 + 真机 | **无论本机是否留有 `lastDeployedAt` / managed target,都必须经过显式 legacy migration 确认门**;本地时间戳不是远端所有权凭证。确认后 permission 旧 URL 条目被原位改写,无双条目双发(install.js:708-733) |
| V20 | Doctor 拒收计数最小实现随 Phase 1 可见 | 单测 + 人工 | V2 的拒收在 Doctor 有数字可查(O1 仅剩文案打磨) |
| V21 | **B1 fail-closed**:①仅 `CLAWD_SSH_REMOTE=1` ②仅 secure marker ③仅 identity 路径三种 secure 判据下,分别制造 identity 缺失 / 截断 JSON / 字段缺失 / 版本不识别 / chmod 000 | 单测(判据×坏态)+ 真机抽验 | 所有组合**全部丢弃事件**,零端口扫描;普通 WSL 只有 `CLAWD_REMOTE=1` 且无三种 secure 判据时保持既有行为 |
| V22 | **B1 脚本旁路**:`scripts/remote-deploy.sh` | 人工执行 | 停用态 fail-fast 且不产生任何远端写入;(若选升级则须 B1-B6 全过) |
| V23 | **B1 原子落地/cutover**:layout identity 或 marker 写入中途断开 ssh,以及 hook files promotion 前中断 | 单测 + 真机 | identity/marker 要么完整旧版、要么完整新版,永不半写;新版 transport 生效时 marker+完整 identity 已就绪;残留 tmp/staging 不参与运行且不跨 runtimeKey |
| V24 | **B2 并发与 fencing**:两台 app 对同一 runtimeKey 同时部署;模拟旧持有者 finally 晚到;模拟 lease 丢失后旧 staging 完成;模拟 `mkdir` 后 owner 写前崩溃/owner 损坏;另测不同 runtimeKey 并发 | 单测(锁桩)+ 真机双机一遍 | 同 runtimeKey 一方成功、另一方零 live 写入退出;旧 finally 不删除新锁;失去 lease 的 staging 永不 promotion;ownerless/corrupt lock 显示独立诊断与精确手工恢复路径、绝不当无锁/自动破锁;释放匹配 leaseId+runtimeKey;不同 runtimeKey 互不阻塞/覆盖 |
| V25 | **B2 TOCTOU**:preflight 通过后、mutation 前注入"他人已完成部署" | 单测(注入) | 锁内复检捕获冲突,**零写入**中止 |
| V26 | **B3 canonical key/action ID**:两个 profile 使用相同 rawSessionId 跑 start/update/permission/user-input/stop/stale,并分别执行 HUD/Dashboard focus/hide/ack/open-folder/alias | 单测(必做)+ 真机(两远端造同 id) | 两行同时存在且可见文字只显示 raw/displayTitle;`session.id`/IPC action 保持 canonical,每个操作只命中目标 profile;alias 互不覆盖 |
| V27 | **B5 组件级 commit 门**:让 identity/marker/hookFiles/各 installer/permission/monitor 的适用项逐个失败,并覆盖 agent 未安装、monitor 关闭、native permission fallback、事务中途 layout 改变 | 单测(每项各一次) | 必需失败项阻止 commit;安全 N/A 有证据且不阻塞;旧 `server-config.js` 或未验证 hook manifest 绝不能 commit;runtimeKey/layoutVersion 改变必须停止而非跨目录 resume |
| V28 | **B6 ownership/TOCTOU 门**:身份缺失/installId/profileId/runtimeKey/layoutVersion 任一不符执行三类 cleanup;另在锁外预读后、拿锁前注入他人接管 | 单测(五态 × 三入口 + 接管注入)+ 真机 | 先拿 runtime lease 再锁内读取;任一不匹配全部跳过零 live 改动;接管注入被锁内复检捕获;对方 monitor/hooks/identity/marker完好 |
| V29 | **D4 最终 fallback**:模拟 path 与 query 均不可用 | 单测 + 真机(若 V5 失败则强制走此路径) | **不注册远程 PermissionRequest**;远端回落 Claude 原生审批;state/quota 通道不受影响;不存在任何无凭证 permission 入口 |
| V30 | **B5 旧凭证到期与紧急吊销**:事务卡在每类必需 step 超过 `previousExpiresAt`;分别执行 force-revoke A 与 abort A/B→C | fake clock 单测 + 真机受控验证 | A 到期后必拒;卡住事务不能无限延长旧凭证;force-revoke 后依赖 A 的组件 fail closed 且 UI 可见;紧急 C 路径不接受 A/B |
| V31 | **X1 remote layout seam**:以 account-default 与 synthetic profile-isolated layout 做三层审计:①静态 guard 远端参与模块的 mutable path 模块常量/旁路 resolver ②`HOME` 指向 poison 临时目录并以 synthetic layout 在 child process 实际执行 installer/hook/statusline/monitor/cleanup 的路径解析 ③生成 deploy/probe/install/monitor/cleanup 命令;另做路径逃逸与恶意 runtimeKey | 静态断言 + 执行审计 + 生成命令审计 | 默认 HOME 只允许在单一 resolver 的 local/account-default fallback 中按调用时解析;remote-capable 模块无 agent/Clawd mutable path 的模块加载期 `os.homedir()` 常量;synthetic isolated 的 identity/marker/host-prefix/statusline sidecar/settings/Codex sessions/lock/staging/PID 全落自己的 root,poison HOME 零读写;非法 key/path 在任何 SSH 写入前被拒 |
| V32 | **installation identity 克隆**:只复制整份 prefs 到第二个 app 实例,保留相同公开 installId/profileId/runtimeKey/nonce/txn;再覆盖 record 缺失、不可解、公开 ID 不符、Linux `basic_text` 边界 | 单测 + 双实例真机 | 第二实例在任何 tunnel/ingress/deploy 前重新 mint binding/installId,原子清掉复制 nonce/previous/txn/active,进入 D6 ownership conflict;绝不落入正常重部署或用克隆 nonce 收事件;强 safeStorage 后端的密文跨机不可解;降级边界在 UI/文档可见 |
| V33 | **layout 外共享 live 文件**:收集两个 synthetic isolated runtimeKey 的 deploy/installer/hook/statusline/monitor/cleanup 全部远端读写 path set,各做完整 deploy + 至少一次 hook state 事件 + cleanup | 单测 + 执行路径审计 | 两套 live path set 交集为空,覆盖 hostPrefixFile/statuslineSidecarFile/PID/log/identity/marker/settings/sessions/lock/staging;远端 hook 同时携带 `CLAWD_REMOTE=1` + `CLAWD_SSH_REMOTE=1`,state 事件不在 poison HOME 产生 session-recovery lease/PID cache;A cleanup 不读写 B;`legacyMonitorPidFile` 仅 account-default 非空,isolated 永不触碰 |

真机基准按 [[verify-platform-fixes-on-real-hardware]]:V1/V3/V5 三项没过,**不合并**;**V21-V30 是 B1-B6 的强制回归,V31-V33 是 X1/installation binding/layout 完整性的强制回归**,与 V10/V13-V16/V18/V19 一并逐项打勾方可合并(手段栏标"单测"的部分允许以单测+受控模拟收口,但 B1-B6/X1 不接受"仅代码审阅"结案)。

### Phase 2 验证矩阵(同账号能力发布门)

| # | 场景 | 手段 | 通过标准 |
|---|---|---|---|
| P2V1 | 两台本地 Clawd 连接同一 host+同一 Unix 账号,各自启用 profile-isolated,同时跑 Claude+Codex+适用的 Copilot | **真机双实例/双机** | 两套 runtimeRoot、端口、nonce、HUD、permission 完全分离;双向零串台 |
| P2V2 | Claude wrapper 启动、auth、session/resume、hooks、PermissionRequest;至少 Linux 与 macOS 两个 OS 维度 | **真实 Claude Code/SSH**,初始基线 ≥2.1.211 | 实际进程 `CLAUDE_CONFIG_DIR` 精确等于 layout且 CLI 自身在该 root 产生 settings/`.claude.json`/hooks/transcript/history;Linux/Windows 新 root 的 auth 按官方契约独立,macOS 明确观察 Keychain 继承且 UI 只标 config/session isolated、auth shared;批准/拒绝只到属主桌面 |
| P2V3 | Codex wrapper 启动、登录、official hooks、JSONL fallback、resume;Copilot wrapper/home/hook smoke | **真实 Codex CLI + 真实 Copilot CLI**,不可用仅设置 env/自编配置替代 | Codex 实际进程 `CODEX_HOME` 精确等于 layout且 config/auth/sessions/monitor 只读写 isolated root;Copilot CLI 自身在 `COPILOT_HOME` 创建/读取 config/session/hooks/permissions 产物,Clawd hook 实际触发;相同 raw session id 仍由 B3 分开 |
| P2V4 | isolated mode 部署后分别直接运行裸 `claude` / `codex` / `copilot` | 真机 | 裸命令继续使用账号默认 root,不会被错误标记或吸入任一 isolated profile;Settings 明示专属启动命令才受隔离保证 |
| P2V5 | 两个不同 runtimeKey 并发 Deploy/Repair/Cleanup;同 runtimeKey 再做并发 | 单测 + 真机双机 | 不同 root 可并发且零互写;同 root 仍受 B2 fencing;任一 finally 不影响另一个 root |
| P2V6 | 远端本地 Clawd 使用默认 root,同时两个 SSH profile 使用 isolated roots | **真机** | 本地状态/permission 留本地 Clawd;两个 remote profile 各归属自己的桌面;不存在静态 permission URL split-brain |
| P2V7 | 删除 A profile、卸载 A hooks、停止 A monitor,随后显式检查数据保留 | 单测 + 真机 | B 与默认 root 完好;A 的 Clawd managed 组件被移除但 A 的 config/auth/sessions 默认保留;未二次确认绝不删除 runtimeRoot |
| P2V8 | 从已有共享 `~/.claude` / `~/.codex` / `~/.copilot` 首次启用 isolated mode;同工作树含 project `.claude/.codex` | 真机 + 人工审计 | 不自动复制旧 auth/hooks/sessions;Linux/Windows 对随 root 迁移的 auth 要求独立登录,macOS Claude Keychain 继承按 capability 明示;用户级 roots 分离;共享 project 配置边界在 UI/Doctor/文档可见且不被 Clawd 擅自改写 |
| P2V9 | account-default → profile-isolated 切换,在 cleanup/deploy/验证各断点中断并恢复;wrapper 目标升级后 Repair | 单测(全断点)+ 真机 | 旧 layout 只经 ownership 门清理;新 layout 事务只 resume 同一 runtimeKey;失败不出现双 active;Repair 重探可执行文件且不改变 config/session root |
| P2V10 | **CLI 实际写入边界/版本门**:在空 isolated roots 用真实 Claude/Codex/Copilot 启动受控 session,记录 config root、账号 HOME、project root、OS credential store/cache 四类实际产物;Claude 覆盖 2.1.211 基线与支持版本 | **真实 CLI/SSH**,不可用自编 payload | `.claude.json` 实际归属以观测为准且当前基线应在 `CLAUDE_CONFIG_DIR`;三 CLI 的 root 内产物与已声明共享项逐项一致;新共享 live state 会阻止 active 并回写 X1/B4/能力文案;低于/未验证版本不会被静默标 active |

**Phase 2 发布门:**P2V1-P2V10 全部通过前,产品文案只能说“Phase 1 会阻止可检测的同 Unix 账号冲突”,不得说“支持同 Unix 账号隔离”。P2V1/P2V2/P2V3/P2V6/P2V10 必须是真实 CLI/SSH 环境,不能用自编 payload、仅 env 相等或伪配置代替。

---

## 5. 明确不做 / 边界

1. **Phase 1 不开放同账号 isolated mode**:它先以 account-default 修复不同 Unix 账号,并在检测到同账号 ownership 冲突时阻止部署;但 X1 必须同时落地,不能以“Phase 2 才用”为由继续写死 HOME。
2. **Phase 2 是同 UID 下的误串台隔离,不是 OS 安全隔离**:独立 config/session/runtime roots 能阻止正常使用时互相覆盖和 monitor 误扫;同一 Unix UID 仍能主动读取/篡改另一个 root、nonce 或 wrapper。产品文案不得使用“安全沙箱”“互不可信租户”等表述。
3. **不虚拟化完整 `HOME`**:不通过 wrapper 改 `$HOME`,避免连带改变 SSH、Git、shell 配置与各类缓存;只使用各 CLI 的专用 root 契约 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `COPILOT_HOME`。若未来要提供完整用户环境,应作为容器/系统账号能力另案设计。
4. **不隔离共享工作树内的 project 配置**:同一仓库里的 `.claude/` / `.codex/` 仍由共同文件系统决定;Phase 2 隔离用户级配置、sessions 与 Clawd runtime,auth 是否隔离按 CLI/OS capability 声明(macOS Claude subscription OAuth 不隔离)。Clawd 不自动复制或改写 project files。
5. **本地互信模型不变**:本机任意进程今天就能 POST 主入口,本次不引入本地鉴权(超出 #513,且会破坏全部本地 hook 兼容)。
6. **不改 REMOTE_FORWARD_PORTS 取值域**:pin 化后理论上可放开 1024-65535,但旧版共存期保留原约束更可预期,放开留给 #512。
7. **#512 的"本地/远程并列建模"整体不在本次**,但 **profileId namespace 已按 B3 收回 Phase 1**,remote layout seam 已按 X1 收回 Phase 1;两者都是隔离闭环/后续 isolated mode 的必要地基。

## 6. 风险与开放问题

- **R1(高,已列 V5)**: Claude Code 对带路径段的 HTTP hook URL 的真实行为只有真机能证实。退路只有两级:①path 段 → ②query `?nonce=`;**两者都不可用时,不注册远程 PermissionRequest,回落 Claude 原生审批**(D4/V29)。**不再造第三种"秘密路径"变体** —— 任何无凭证的 permission 入口都是原始泄漏面。
- **R2(中)**: D8 自动 repair 只覆盖远端 identity 精确匹配本 install/profile 的安全版本/端口漂移;复用现有 backoff(runtime.js BACKOFF_SCHEDULE_MS),单连接周期至多一次。identity 缺失、损坏或 ownership 不明只提示显式 Repair,不自动写。
- **R3(低)**: ingress 数量 = 已连接 profile 数。**profile 总数没有上限**(v2 的"≤5"有误:5 是单个远端 host 的转发端口取值域,即同一 host 至多 5 份并存部署,跨 host 不受限;remote-ssh-profile.js 无 MAX profiles 约束)——每 profile 一个 http.Server,数十量级仍可忽略;断开即销毁,不做池化。
- **R4(低)**: `closeAllConnections` 需 Node ≥18.2 —— Electron 主进程满足;ingress 单测需覆盖"在途连接强断→abort 触发"路径(V16)。
- **R5(高,Phase 2)**: Clawd 不负责启动用户手工打开的远端 Claude/Codex/Copilot,无法给既有进程补环境变量。isolated 能力必须以专属 wrapper 为入口;P2V4 要证明裸命令不会被误归属,UI 不能把“目录已创建”显示成“隔离已生效”。
- **R6(中,Phase 2)**: `CLAUDE_CONFIG_DIR` 会隔离 Claude 用户级 settings/history/plugins 与当前 2.1.211 实测的 `.claude.json`(Linux/Windows 也含 credentials),但 macOS subscription OAuth 在 Keychain 共享;`CODEX_HOME` 与 `COPILOT_HOME` 分别是官方 root 契约。CLI 升级可能改变目录内容,不能只依赖环境变量名不变:P2V10 的真实写入清单与版本门必须随支持版本升级回归。
- **R7(中,Phase 1)**: installation binding 防的是 prefs 导入/同步、跨机复制与 OS 凭据不可解,不是声称能识别完整 OS/VM 连同 keyring/DPAPI/Keychain 的位级克隆。强 `safeStorage` 可用时必须使用;Linux `basic_text` 降级与完整镜像边界在 UI/文档明示。无论后端如何,record 异常都必须先禁用复制 nonce/active,不能把检测不足转化为静默接管。
- **O1**: 拒收计数的 Doctor **数字本体随 Phase 1 落地**(与 V2/V20 绑定,不后置);仅展示文案与阈值打磨可进 follow-up —— v2 把整项标 SHOULD 与 V2 要求矛盾,已修正。
- **O2**(已关闭): D7 profileId 定级问题 —— 按 B3 收进 Phase 1 MUST,无可选项。
- **O3**: 孤儿 monitor 自退出的失败时长阈值(建议 24h;进主线,阈值可调)。
- **O4(已关闭)**: 会话 Map 是进程内存态,无需磁盘迁移;但 `state-session-snapshot.js` 是 renderer/API action identity 的生产者而非可忽略的“恢复文件”,已按 B3 强制纳入 Phase 1。snapshot 保留 canonical `id`,新增 raw/display 字段;session alias 持久化需 profile-scoped 新 key + 旧 key 只读 fallback。

## 7. 工作量

**Phase 1(v7)**:约 23-28 个源文件(4-6 新增:layout、ingress、identity/binding、session-identity、deploy-lock 或并入 deploy)+ 16-20 个测试文件(5-7 新增)+ 双语文档 + AGENTS 命令更新 + 脚本停用。B3 的 canonical action ID 横跨 state/permission/snapshot/renderer/IPC/alias;X1 要把 deploy/runtime/install/monitor/cleanup 的散落 HOME 假设和 host-prefix/statusline sidecar 收口;锁还需 runtime-scoped lease staging/promotion,identity 还需 safeStorage/clone recovery。实现约 9-12 天,真机矩阵 2-3 天(V24 需双机并发/ownerless lock、V26 需构造同 id、V28 需五态 × 三入口、V30 需受控凭证过期、V31/V33 需路径执行审计、V32 需双实例克隆)。

**Phase 2 追加量**:主要是 profile/UI mode、wrapper 生成与 repair、fresh-root/artifact/版本激活门、macOS Claude auth capability、保留数据的 cleanup UX,以及 Claude/Codex/Copilot 同账号矩阵;预计再涉及约 8-12 个源文件、7-10 个测试文件,实现 5-8 天,真机 3-4 天(P2V2 需 Linux+macOS,P2V10 需三套真实 CLI 写入清单)。该估算不包含未来的选择性旧配置导入、macOS per-profile Claude 凭据或完整 HOME/容器能力。

---

## 8. 分阶段落地

- **Phase 1(PR 1,基础隔离)**: **B1-B6 全部 + X1**、D1-D12 全量、V1-V33、文档/AGENTS、脚本停用;UI 只启用 account-default,同账号冲突继续显式阻断。本 plan 已加入 .gitignore 白名单(`!docs/plans/`,:39 一带),随实现 PR 入库供审计。**合并门槛 = B1-B6/X1 逐条实现且 V21-V33 逐项打勾 + V1/V3/V5 真机通过 + V10/V13-V16/V18/V19 打勾。**
- **Phase 2(PR 2,共享 Unix 账号隔离)**:复用同一 controller/layout/lock/identity,开放 profile-isolated mode,完成 §3.1 全量与 P2V1-P2V10。它不是无限期 follow-up:在本总方案里与 Phase 1 连续实施,但保持独立合并/回滚。**PR 2 未合并前,#513 可宣称“同服务器不同 Unix 账号已修复”;不得宣称“同 Unix 账号已支持”。PR 2 合并后也只能按 CLI/OS capability 宣称 config/session/auth 范围,macOS Claude subscription auth 明示共享。**
- **后续维护(不阻塞两 PR)**:O1 Doctor 文案打磨、O3 孤儿 monitor 阈值调优、#512 更大范围的本地/远程并列建模。profileId 与 remote layout 地基已在 Phase 1 就位。

---

## 9. 阻断项 → 设计条款 → 实现文件 → 验证用例 对照表

| 阻断 | 要求摘要 | 设计条款 | 实现文件(§3 落点) | 验证用例 |
|---|---|---|---|---|
| **B1** | Remote SSH 用独立 env+file secure marker;identity 不兼任 marker;secure 下 identity 缺失/损坏/读失败 fail closed;identity/marker 原子 cutover;停用旧脚本 | D2(三重判据+fail closed)、D3(原子落地)、§3 落点 6/7/11 | `hooks/server-config.js`(`__dirname`/显式 path)、各 installer/statusline/monitor marker 传递、`src/remote-ssh-deploy.js`(identity→marker→hook promotion)、`scripts/remote-deploy.sh` | **V21**(判据×坏态零扫描)、**V22**、**V23**、V3 |
| **B2** | 同 runtimeKey 的 live mutation 前取 lease;锁内 preflight;leaseId+runtimeKey 条件释放;旧 finally/失锁 staging 不得影响新持有者;ownerless/corrupt lock 不当无锁且不自动破;不同 isolated runtime 不共享锁/live 路径 | D11、D6、X1 | `src/remote-ssh-layout.js`、`src/remote-ssh-deploy.js`(layout-scoped acquire/assert/release、lease staging/promotion、ownerless 诊断、锁内 preflight,包住 identity/marker/installers/monitor/cleanup) | **V24**(同/异 runtime 并发+fencing+ownerless)、**V25**(TOCTOU)、V10、V31 |
| **B3** | profileId 进 Phase 1;canonical action ID 覆盖 state/permission/Codex/cleanup/snapshot/renderer/IPC/alias;raw 只作可见文字;quota source 同样使用 trusted profile scope | D7(MUST+数据契约+source stamping) | session identity helper、`src/state.js`、state helpers、server routes、permission、`state-session-snapshot.js`、`session-alias.js`、HUD/Dashboard renderer、session IPC/focus/open-folder、`state-account-quota.js` | **V26**(同 raw 双 profile 生命周期+全部 UI actions)、V8、V1、V6 |
| **B4** | 目标配置域与远端本地 Clawd 重叠 → 直接阻止;Phase 1 account-default 必阻止;Phase 2 只有经验证不重叠的 isolated layout 才可并存 | D6(阻止分支)、D2(删除优先级方案)、§3.1 | `src/remote-ssh-deploy.js`(preflight 探 runtime.json + ownerPid + layout overlap)、`src/settings-tab-remote-ssh.js`(文案) | **V18**(Phase 1 无继续)、**P2V6**(isolated 并存) |
| **B5** | 持久且绑定 runtimeKey/layoutVersion 的 A→B transaction;只 resume;identity/marker/hook manifest/适用组件逐项验证;N/A 有证据;旧代有 TTL 与紧急 force-revoke | D9(事务/commit/expiry/revoke)、X1 | `src/remote-ssh-identity.js`、`src/settings-controller.js`、`src/prefs.js`、`src/remote-ssh-profile.js`、`src/remote-ssh-deploy.js`、ingress expiry | **V27**(必需失败+layout 改变+合法 N/A)、**V14**(断点 resume)、**V30**(到期/紧急吊销)、P2V9 |
| **B6** | 先取 runtime lease,再锁内重读 identity 并匹配 installId/profileId/runtimeKey/layoutVersion;不匹配全跳过;identity 后删、marker 最后删 | D12、X1 | `src/remote-ssh-deploy.js` layout cleanup/stop、`src/remote-ssh-ipc.js` profile 删除、D11 lease helpers | **V28**(五态×三入口+锁前接管注入)、P2V7 |
| **X1** | Phase 1 落地 runtimeKey→layout 唯一路径解析;host-prefix/statusline sidecar 等每个 live 文件都纳入;remote deploy/runtime/install/monitor/cleanup 不散落模块加载期 HOME 常量;isolated mode 可在 Phase 2 直接启用 | §2.0 X1、D3/D6/D11/D12、§3 落点 0/5-8 | `src/remote-ssh-layout.js`、profile/identity/deploy/runtime、全部 remote installers、`hooks/server-config.js`、Claude statusline、Codex installer/session-index/monitor | **V31**(静态+执行+命令)、**V33**(双 path set)、V24、V27、V28 |
| **installation binding** | prefs 公开 installId/nonce 不得成为可复制授权;record 异常先重 mint 并禁用复制 nonce/txn/active,解决冲突前不启动 ingress/tunnel;强 safeStorage 优先、降级边界明示 | X1 installId bullet、D3、R7、§3 落点 2 | `src/remote-ssh-identity.js`、`src/settings-controller.js`、`src/prefs.js`、Remote SSH startup gate/UI | **V32**(prefs 克隆/record 四态)、V10、V15 |
| **兼容矩阵订正** | 不得宣称"新 app + 旧 hooks 无泄漏";outbound 隔离以显式重部署和安全 cutover 成功为准;旧 controller 不取 B2 锁;同 Unix 账号即使只有一人装 Clawd 仍须 isolated wrapper | §2 兼容矩阵(v7)、§3.1 | Remote SSH/setup 双语文档 + AGENTS + 发版说明 | V12、V19、V2、P2V4 |
| **permission 最终 fallback** | path/query 都不可用 → 不注册远程 PermissionRequest,回落 Claude 原生审批;不再造 secret path | D4(第三条)、R1 | `hooks/install.js`(7:remote 模式跳过注册)、`src/settings-tab-remote-ssh.js`(文案) | **V29**、V5 |
| **Phase 2 同 Unix 账号交付** | profile-isolated roots + Claude/Codex/Copilot wrapper + CLI 产物/版本激活门 + 数据保留 cleanup;同 UID 与 macOS Claude Keychain auth 边界如实声明;`.claude.json` 当前基线归 config dir,Copilot `COPILOT_HOME` 为官方契约 | §3.1、§5、§8 | profile/UI、layout/deploy、installers、monitor、wrapper generator、Doctor、双语文档 | **P2V1-P2V10** |

## 10. 复核记录

- 2026-07-24 我方全代码核实(Explore 扫描 + 逐条 file:line 亲读):根因链、客户端清单、部署步骤、监听结构全部与本文一致;**新增发现** §1.4(remote PermissionRequest URL 硬编码 23333,install.js 无 --port 参数,deploy 不传端口——三点互证)。
- 2026-07-24 云宝(Codex)独立复核对首版方案的修正,经真代码验证全部成立并已吸收:①宽限照收=泄漏保留(否决,→D5);②token 不用于扫描选目标(→D2);③客户端清单低估:codex-hook.js:415、codex-install-utils.js:477、copilot、statusline、/permission 路由、隧道目标(→§1.5/§3);④HTTP hook 无 header 证据(install.js:741-750 仅 type/url/timeout,→D4)。
- 我方对云宝结构的两点细化:ingress 用临时端口而非固定分配(免端口管理);nonce 传输禁 argv(共享机 `ps` 可见,→D3),"共享账号禁用 JSONL fallback"落地为 D6 的冲突阻断+明示(账号内多人本就不可检测,禁用无从触发)。
- 2026-07-24 云宝二轮 Request Changes(6 项合并阻断),我方逐条对真代码核实**全部成立**,吸收为 v2:
  1. **旧部署旁路** → 孤儿 monitor `nohup` 长存且老代码带回落扫描(deploy.js:376);核实收窄:重连/重部署路径**已有** PID pre-kill(deploy.js:343-381),真实长尾是"从不重连的旧部署" = 残留清单 + 新 monitor 去回落 + 自退出 + V13;
  2. **身份事务** → 单顺序双写必有 self-DoS 断点 = D9 两阶段双代 + identity controller + V14;
  3. **共享 HOME 接管** → 自动接管以有效凭证复刻 #513 泄漏;并暴露 v1 自伤漏洞:D8"nonce 验不过即自动重部署"× D6"死身份自动接管" = 自动接管战 = D6 手动化 + D8 收紧 + V15;
  4. **权限生命周期** → pendingPermissions 长挂 res 与既有 abort 机制(server-route-permission.js:317/:663,PR #643 no-decision 语义)核实可复用;缺口是 `Server.close()` 不断在途 = D10 closeAllConnections + V16;
  5. **nonce 二载体** → 远端 settings.json URL 与安装备份(install.js:1039-1047 writeJsonAtomicWithBackup)戳破"0600 唯一载体"声明 = 秘密卫生表 + V17;
  6. **stderr 放大** → statusline 每次调用都是新进程,进程内去重无效 = D2 改 marker 文件限频。
  实现顺序按云宝建议锁定(§3 首段);状态退回"复核中",待三轮复核通过进入实现。
- 2026-07-24 云宝三轮(对 v2):仍 Request Changes。**6 项内部不一致我方逐条核实全部属实,已修正**:①V10 措辞与 D6 手动接管对齐;②V17 与"备份含旧 nonce"的自相矛盾改为"失效审计"口径(允许含已失效 nonce);③V2/O1 矛盾拆解(计数数字本体 Phase 1 必落,打磨后置);④R3 profile 数订正(5 是单 host 端口域,profile 总数无上限,remote-ssh-profile.js 无 MAX 佐证);⑤nonce 持久化改走 settings-controller 专用 command(main.js:247-250 单一写入者架构);⑥plan 文档受 .gitignore `docs/**`(:18)忽略属实、plans 目录无白名单,已加 `!docs/plans/` 白名单条目。
  三轮的 **6 项闭环阻断原文未同步到本文**,按"继续串台 / 错误接管 / 无法撤销旧凭证"三类后果独立逆推,关闭 4 个核实为真的缺口:①previousNonce 无限期有效 = 无法撤销(D9 改 verify 即清 + TTL + 显式"重置远端身份");②遗留部署(无身份文件)静默劫持 = 错误接管(D6 遗留痕迹确认门 + V19);③混合桌面 pin 回归 = 劫持本地会话(D2 优先级规则"活 runtime > 身份文件" + D6 确认 + V18);④本机跨 profile 静默夺取(D6 移交门)。逆推中排除一个假警报:statusline 注册**已**带 `CLAWD_REMOTE=1`(install.js:1629),env 门控链完整;另发现版本回退方向的双条目残留(残留清单新行)。
- **2026-07-24 v4(云宝三轮阻断原文到位)**:6 条原样写成 Phase 1 强制不变量 **B1-B6**(§2.0),**不缩窄、不以确认提示替代阻断、不降级 SHOULD**。v3 中被逆推方案覆盖但**方向错误**的三处已推翻重写:
  - v3 用"活 runtime 优先 + 确认提示"处理混合桌面 → **错**,Claude permission 是静态 URL,不存在运行时择优时机,优先级救不了 permission 侧 split-brain;改为 **B4 直接阻止部署**;
  - v3 的"并发部署不做锁,最后写者胜可见即可" → **错**,输者带失效 nonce 继续跑、赢者以为独占,双方都不知情;改为 **B2 原子锁 + 锁内复检 + 零写入退出**;
  - v3 把 profileId 盖章标 SHOULD、留给 #512 → **错**,入口验过而状态层仍是扁平 key 时 session id 可跨远端碰撞,B 覆盖 A 的条目、A 的 stop 清 B 的气泡,**隔离闭环不成立**;改为 **B3 Phase 1 MUST**,横跨 state/permission/codex-turn/user-input/cleanup 五条链。
  另新增:B1 secure marker 与 WSL 解耦 + fail closed + `scripts/remote-deploy.sh`(实测存在,320 行,:169-184 探本地端口、:260-270 直调 installer、:294 指引 `RemoteForward 23333`,确系正式旁路)停用、identity 原子 rename;B5 事务改为**六组件 step 级持久化 + 只 resume 不 mint C + 全部验证成功才清 previous**(v3 的"verify 通过即清 + TTL"仍不够:verify 只验了 identity,没验 installers/permission URL/monitor);B6 cleanup ownership 门(deploy.js:383-430 现状无条件 kill+卸载,共享 HOME 下等于用删除权限踩别人)。
  兼容矩阵按订正重写:**新 app + 旧 hooks 不再宣称"无泄漏"** —— 旧 hook 仍会扫进邻居仍在运行的旧版主入口,outbound 隔离**以重部署成功为准**;完全消除需要该服务器上所有用户都升级并重部署。permission 最终 fallback 定为**不注册远程 PermissionRequest、回落 Claude 原生审批**,不再造第三种 secret path。
  验证矩阵扩至 V29(新增 V21-V29 对应 B1-B6 与 fallback);工作量上修至 18-20 源文件 / 6-8 天实现 + 2-3 天真机。对照表见 §9。**下一步:按 §3 实现顺序开工前,先请云宝对 §9 对照表逐行确认覆盖无缺。**
- **2026-07-24 v5(云宝直接修订 plan)**:在不改 B1-B6 方向的前提下补齐实现闭环:
  1. B1 不再让 identity 自己兼任 marker;改为 `CLAWD_SSH_REMOTE=1` + `clawd-ssh-secure-v1` + identity 路径三重判据,并锁定 identity→marker→安全 hook files 的首次 cutover 与 marker-last cleanup 顺序;
  2. B2 锁改为随机 `leaseId`、条件释放、lease staging/promotion;PID 不作远端存活依据,Phase 1 不做 app 内 stale takeover,避免旧 finally 删除新锁或网络分区后双写;
  3. B3 明确 snapshot/API 双身份契约:`session.id` 是 canonical action ID,`rawSessionId/displayTitle` 只用于可见文字;补齐 snapshot、renderer、IPC、focus/open-folder、alias 落点与交互测试;
  4. B5 transaction 增加 secureMarker/hookFiles step、`not-applicable + evidence`、`previousExpiresAt`、force-revoke 与 A/B→C 安全紧急路径;安全 transport 文件未验证不得 commit,可选 agent/monitor 不再把事务永久卡死;
  5. B6 固定为先取 lease、再锁内读 identity 和授权 cleanup,identity 后删、secure marker 最后删;V28 增加锁前接管 TOCTOU 注入;
  6. D8 删除 identity 缺失时的自动重部署授权;V12 改为显式迁移与明确 cutover 边界,不再宣称旧 hook 升级过程天然“无泄漏窗口”。验证矩阵扩至 V30,对照表同步更新。
- **2026-07-24 v6(同账号能力纳入同一总方案)**:推翻 v5“同一 Unix 账号架构上无法隔离、只阻断”的绝对结论,改为区分两个技术边界:
  1. Claude Code 的 `CLAUDE_CONFIG_DIR`、Codex 的 `CODEX_HOME` 与仓库现有 Copilot `COPILOT_HOME` 契约能把用户级 config/auth/sessions/state 分到 profile 专属目录,所以合作使用同一账号时的路径误串台**可以解决**;
  2. 同一 Unix UID 仍可主动读取/篡改其他目录,所以该模式不是 OS 安全边界;完整 HOME 虚拟化不纳入 Clawd。
  交付拍板为**一个总方案、两个连续 PR**:Phase 1 保留 B1-B6 全量,新增强制 X1,把 identity/marker/lock/staging/PID/install/monitor/cleanup 全部改为 `runtimeKey → layout`;Phase 2 只在这条地基上启用 profile-isolated roots、专属 wrapper、fresh-root/独立登录、激活门与保留数据 cleanup。B4 从“发现任何本地 Clawd 都阻止”收窄为“配置域重叠才阻止”,但 Phase 1 只有 account-default,因此原有强阻断不缩水。新增 V31 与 P2V1-P2V9,并明确 PR 2 未过真机门前不得宣称支持同账号隔离。
- **2026-07-24 v7(对 v6 的对抗复核订正)**:外部审查报 6 项 blocker,云宝锁定 HEAD `6d4041d`、逐条回代码/官方契约并用 Claude Code 2.1.211 做无模型调用路径探针后,结论为 **4 项成立、2 项被证据推翻**:
  1. **成立 — layout 外共享 live 文件**:`hooks/server-config.js:22` 与 deploy 仍读写 `$HOME/.claude/hooks/clawd-host-prefix`,`claude-statusline.js:39` 还有 HOME sidecar;X1 增 `hostPrefixFile/statuslineSidecarFile/account-default-only legacyMonitorPidFile`,V31 改为静态+child-process 执行+生成命令三层审计,V33 强制双 isolated path set 零交集。外部审查所称“全部 HUD 必错标”被 D7 trusted stamping 收窄,但共享文件/cleanup 破坏本身足以阻断;
  2. **成立 — prefs 克隆绕过 ownership**:prefs 内四字段与 nonce 可整套复制;不采纳“再放一个普通 fingerprint 文件”作为充分修复,改为 prefs 外 installation binding secret + 强 `safeStorage` 优先 + `installId=hash(secret)` + clone recovery 在任何 tunnel/ingress 前清复制 nonce/txn/active,V32 覆盖。完整 OS/VM 连凭据存储位级克隆明确不作虚假可检测承诺;
  3. **成立 — V31 方法抓不到远端模块常量**:`server-config`、Claude statusline、Codex installer/monitor、Claude auto-start cleanup 等落点全部补显式/co-located resolver,并用 poison HOME 实际执行;同时订正外部审查 N7:`codex-session-index.js:48-53` **已有** `options.codexDir` seam,问题是与 installer/monitor resolver 不统一;
  4. **成立但收窄 — macOS Claude auth**:官方说明 subscription credentials 在 Keychain 且 clean config 会继承;这推翻“每个 fresh root 都独立登录”,但不推翻 settings/hooks/transcript/history 与 Clawd 路由隔离。Phase 2 不禁用整个 macOS isolated mode,改为逐 capability 标注 `config/session isolated; subscription auth shared`,P2V2 增 Linux+macOS 维度;
  5. **推翻 — `.claude.json` 必然留在账号 HOME**:当前 2.1.211 将分离 HOME/config probe 的 `.claude.json` 与 backup 写入 `CLAUDE_CONFIG_DIR`;不得把它列成已知共享例外。新增 P2V10 对真实 session/支持版本做完整写入清单与版本门,以观测防未来漂移;
  6. **推翻 — Copilot CLI 不识别 `COPILOT_HOME`**:GitHub 官方 config-dir reference 明确它替换整个 `~/.copilot`;保留真实 CLI 产物激活门,但不再把正式契约写成“仓库自定义约定”。
  另吸收三项有效非阻断:N3 ownerless/corrupt lock 独立诊断且不自动破锁;N4 legacy monitor 只在 account-default lease + ownership/显式遗留确认 + command line 匹配时处理;N6 旧 controller 不取新锁的混合版本边界。Phase 1 矩阵扩至 V33,Phase 2 扩至 P2V10。
- **2026-07-24 v8 实现终审收口**:方案范围代码、双语文档与自动化均已落地。终审额外发现并修复 6 个不能只靠初版 happy-path 证明的断点:①先持久化 deploy ownership 元数据、后 commit A→B nonce,落盘失败保持同一事务可续跑;②同账号 cleanup ownership domain 纳入 `runtimeMode + runtimeKey + layoutVersion`,避免 isolated sibling 被误判为共享 account-default;③停止 Codex monitor 前核验 PID 的实际命令行,防 PID 复用误杀;④CLI capability probe 从 PATH 排除当前 profile wrapper 目录,防 repair 生成自递归 wrapper;⑤主 HTTP 入口发现 Remote SSH nonce header 时直接 generic 404,堵住手写反向转发绕过专用 ingress;⑥ingress start/close 加 single-flight 与 close-before-listen 防护,避免断开后晚到 listener 复活。当轮证据:#513 定向调用链 **1052/1052**,全量 **5986 pass / 0 fail / 18 platform skips (6004 total)**,改动 JS 全部通过 `node --check`,`git diff --check` 通过。真实 V1/V3/V5 与 P2V1-P2V10 等 SSH/CLI/权限矩阵仍保持未勾选,不得用上述自动化替代。
- **2026-07-24 v9 Claude 对抗审查修复**:Claude 以 4 个子代理分拆 transport/session namespace/Phase 2/tests 后给出 1 个 P0、5 个 P1、9 个 P2 与 1 个 P3；云宝逐条回到真实调用链修复并补回归:
  1. `markDeployed`、`markRemoteNode` 与 target-drift 分支均保留顶层 installation binding `installId`，真实 reducer 回归覆盖 deploy 后立即 connect；
  2. 普通 WSL 的裸 `--remote` 只保留 `CLAWD_REMOTE`，只有显式 SSH remote 才写 `CLAWD_SSH_REMOTE`/secure marker；Claude/Codex/Copilot 三条 installer 路径统一；
  3. clone recovery 同时清除继承的 deploy ledger 与 isolated runtime，cleanup/delete 重新校验当前 installation binding、目标 `installId` 与进行中 identity transaction；产品补出双确认 force-revoke IPC/UI；
  4. monitor 启动整段纳入 subshell lease fence，installer/monitor 改为配置与 live PID/命令行 read-back，wrapper evidence 只在 CLI 成功且版本/产物成立后写入；PATH 排除改为 realpath 语义；
  5. Codex official-turn map、subagent classifier、JSONL callback 与 route 全部消费 canonical session key；本地和远端 key 使用同一 opaque envelope，remote profile 明确拒绝保留字 `local`；
  6. Phase 2 connect/deploy/autostart 均要求持久化 isolated evidence，sanitizer 只从可验证 evidence 推导 `isolatedActive`；无 ledger 的 mode switch fail closed，cleanup 不再静默跳过旧 layout；
  7. legacy trace 增加 config-only managed registration 检测，runtime probe identity schema 与 hook 校验对齐，remote-only approval 补齐 trusted profile/raw metadata；
  8. 用真实 shell 执行错 owner 的多行 fence、fresh child process + poison HOME、复制 ledger cleanup、canonical collision、真实 reducer、UI 静态连线等回归替换原有空跑/字符串证明。
  当前证据:#513 定向调用链 **1114/1114**,仓库全量 **6008 pass / 0 fail / 18 platform skips (6026 total)**；`git diff --check` 通过。真实 V1/V3/V5、V21-V33 抽验及 P2V1-P2V10 SSH/CLI/权限矩阵仍未执行，合并与 Phase 2 支持声明继续受这些证据门约束。
- **2026-07-24 v10 首轮真实双账号 SSH transport smoke**:AWS Lightsail Ubuntu 24.04 实例上创建两个一次性、无 sudo 的 Unix 账号 A/B；各账号只安装校验过 SHA-256 的 Node 22.23.1 到自身 cache，**未登录 Claude、Codex 或 Copilot**。本机用两套真实 Remote SSH runtime/ingress 和 `ssh -R` 将 A/B 分别固定到远端 23333/23334，secure deploy controller 并行完成 24 个步骤后，直接执行安装器实际写入的 Claude/Codex command hook，并对 Claude permission URL 做受控 HTTP 请求。结果:
  1. A/B 使用相同 raw session id 时仍分别进入各自 trusted profile sink；Claude/Codex command 均不串台；
  2. 两条 permission URL 分别固定到 23333/23334 且携带各自 routing nonce；wrong nonce 返回 404 且不写事件；
  3. 断开 B tunnel 后再次执行 B hook，事件被丢弃且没有扫描/投递到仍在线的 A；
  4. ownership-checked cleanup A 后 B 仍能继续上报，随后 B cleanup 也成功。
  真机在达到上述 PASS 前连续抓出并修复三个自动化未覆盖的真实缺口:①现代 OpenSSH SFTP-backed `scp` 会把 argv 中人为添加的 shell quote 当作目录名，secure staging target 改为单个 raw `host:/absolute/path/` argv 并加回归；②Claude/Codex installer 的合法命令会把 `CLAWD_REMOTE`/`CLAWD_SSH_REMOTE` 写成带引号赋值，read-back verifier 改为逐 token 接受 unquoted/single-quoted/double-quoted 三种形态；③Copilot `hooks.json` 的 POSIX 命令字段是 `bash` 而非 `command`，verifier 按集成读取真实字段并覆盖生成物形状。修复后 `test/remote-ssh-deploy.test.js` **49/49**，仓库全量 **6009 pass / 0 fail / 18 platform skips (6027 total)**，`node --check` 与 `git diff --check` 通过。
  **证据边界不放宽**:该轮是实机 SSH/部署/隧道/安装产物与受控 hook payload smoke，可作为 V1/V3/V4/V26/V28 的 transport 子集证据，但没有真实启动或登录三套 CLI，没有观察真实 HUD GUI，也没有覆盖 V5 的真实 Claude 批准/拒绝/600s 超时三态、V6 permission、V7、V8/V9/V12-V19/V21-V25/V27/V29-V33 全矩阵或任一 P2V1-P2V10。因此不得把 v10 写成 Phase 1 合并门或 Phase 2 发布门已全部通过。
- **2026-07-24 v11 同一 Unix 账号双 profile-isolated 无登录 smoke**:复用 `clawd-test-a` 一个远端 Unix 账号与一个 HOME，在 `$HOME/.clawd/profiles/issue513_same_a`、`issue513_same_b` 建立两个不同 runtimeKey/runtimeRoot，分别固定 23333/23334。为避免任何真实 AI 账号登录或模型/API 调用，测试在账号 cache 中放置三个只响应 `--version`、并按 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`COPILOT_HOME` 写测试产物的假 CLI；其余路径全部使用真实 bootstrap ownership、layout lock、secure deploy/read-back、profile wrapper、artifact activation、SSH reverse tunnel、installed Claude/Codex hooks、permission URL 与 ownership cleanup。结果:
  1. 两个 root 各自生成独立 Claude/Codex/Copilot 用户级目录、wrapper evidence、hook/identity/marker/lock/staging；第一轮 prepared、wrapper 成功运行后第二轮才 active，激活门没有被绕过；
  2. 同 raw session id 的 Claude 与 Codex 事件分别进入 profile A/B；两条 permission URL/nonce/端口各自匹配，双向零串台；
  3. cleanup A 后 B 继续上报；cleanup A/B 均不删除各 root 的测试用户产物，符合数据保留边界；
  4. 中途一次 VPS 主动关闭短命 SSH 连接，留下精确 B runtime lock；确认本地 deployer 已退出且锁 owner 为 B 后，将锁改名保留现场，再用 bootstrap owner 中同一 installId 续跑，验证了“不自动破锁、不另 mint 身份”的恢复边界。
  该轮真机另发现 **profile-isolated 无法激活的 P0 级真实阻断**:`probeRemoteCliCapabilities()` 生成的 Node `-e` 脚本含 `command -v "$1"`，而 `buildRemoteNodeEvalCommand()` 用远端 shell 双引号承载整段 JS，导致 shell 在 Node 启动前把 `$1` 展开为空，三个 CLI 永远返回 `present:false`。修复为 Node 直接遍历过滤后的 PATH 并用 `fs.accessSync(X_OK)` 找可执行文件，不再嵌套带 `$1` 的 shell；新增真实 `/bin/sh -c` 回归，旧实现必失败、新实现发现三 CLI 并通过版本门。另一次 health probe 404 最终证实是 harness 忘记模拟真实 `remote-ssh-ipc` 从全局 installation binding 注入 `installId`，不是产品缺口；补回注入后 identity/profile nonce 哈希一致且双 ingress 健康探针通过。
  修复后 `test/remote-ssh-deploy.test.js` **50/50**；重放到 `origin/main@37be12d` 后仓库全量 **6028 pass / 0 fail / 18 platform skips (6046 total)**，`git diff --check` 通过。**边界**:该轮把 P2V1/P2V5/P2V7/P2V9 的 layout/transport/wrapper/artifact/cleanup 子集从纯模拟提升为真实同 UID SSH 证据，但假 CLI 不能证明真实 Claude/Codex/Copilot auth、session/resume、CLI 自身 hooks、macOS Keychain 或完整写入清单；P2V1-P2V10 发布门仍未通过，experimental gate 不得解除。
