# #1248：本地 HTTP 服务避开 Windows 保留端口

状态：Claude 第二轮 PASS WITH NOTES，云宝独立核实后补齐测试隔离条款，允许开始实现。提出者：鹿鹿。负责人：云宝。日期：2026-10-25。代码基线：`82cb92637134242f8a7d462f3db6028fccd2dde4`。原文及逐项裁决见 `docs/investigations/windows-local-server-ports-2026-10-25/`。

## 问题与已核实证据

[Issue #1248](https://github.com/rullerzhou-afk/clawd-on-desk/issues/1248) 报告 Windows 11 上系统保留了 23240–23339，覆盖 Clawd 的全部五个备用端口。桌宠启动，但本地 HTTP 服务没有监听，Claude Code / Codex 无法连接。报告者通过管理员调整 WinNAT / 端口保留临时恢复；该环境和操作结果来自报告者，尚未独立真机复现。

在当前代码中已经核实：

- `src/server.js` 只在 `EADDRINUSE` 后尝试下一个端口；注入 `EACCES` 后只尝试 23333 就返回 null。五个端口全部占用也直接失败。
- `hooks/server-config.js` 的端口读写、候选构建、审批 URL 都只接受 23333–23337；向 runtime 候选传入 45000 会被忽略，写入该端口会返回 false。
- OpenCode / MiMo、Pi / OMP、OpenClaw、Hermes、DSH 还有独立的固定区间校验，不能只改公共 helper。
- Doctor 没有保存 bind 错误码/端口，只提示未监听和目录权限。旧 runtime 文件不能证明当前服务成功启动。
- 现有 server-start 和 Doctor 测试 10 项通过，但缺少 EACCES、系统分配端口及对应客户端发现覆盖。

## 目标与范围

本地默认五个端口都不可用时，Clawd 自动监听系统分配的可用 loopback 端口；能读取同一主机用户 runtime 的已启用原生集成使用该端口恢复状态和既有审批行为，包括共享 Windows home 并使用 Windows node.exe 的 Codex interop。用户不必修改 Windows 服务、代理或端口保留配置。

本次不增加设置项或环境变量，不扩大全端口扫描，不修改 Windows 网络配置，不改变远程 SSH remoteForwardPort / nonce / 身份约束，不改变 Mobile Preview 的独立 LAN listener。不引入新的 daemon、端口租约表或跨语言共享框架。所需校验保留在各自现有部署单元，OpenCode managed generation 文件集不扩充。

动态端口模式下，独立 Linux home 的 WSL 集成不在本次支持范围：Linux 侧看不到 Windows runtime，原五端口扫描无法发现动态 listener。现有 Claude WSL 安装时固定审批 URL 的限制也不在本次修复。文档明确区分这个发现限制与 NAT/mirrored 网络限制；Windows Settings 的 WSL Pair 在本机已监听范围外端口时，应报告此限制，不把它解释成 NAT 配置错误。Mobile Preview 全部候选也被保留时仍会失败，不宣称本次修复所有 listener。手工写死本地 23333 的 SSH 转发需按实际端口调整；托管 Remote SSH 的 profile ingress 逻辑不变。

## 设计

### 1. 本地服务端启动

提示文件的读写由 ctx 注入，`initServer` 默认禁用，仅 `main.js` 的生产接线传入真实 helper。测试工厂统一 stub 提示读写；它们与 runtime 读写/清理、同步函数一起列为必须隔离的入口，绝不访问真实用户提示文件。共同端口测试按 JSON 解析后的值定义（45000、45000.0、4.5e4 数值相同，Python 允许整值 float，但拒绝 bool）；字符串仍只允许规范十进制。专用 URL 所有权按原始字符串精确匹配，避免 URL 规范化吞掉路径变体。

- 候选顺序：可读 runtime 端口 → 五个 legacy 端口 → 上次动态端口提示 → `listen(0, "127.0.0.1")`，去重。0 只由服务端追加一次，绝不写入客户端候选或 runtime。
- 增加一个服务端私有提示文件 `~/.clawd/local-server-port.json`（`{app:"clawd-on-desk", port}`），只接受 1024–65535 的范围外端口，文件小且有界。只在范围外 listener 的 runtime 发布成功后原子更新；失败只记 warning，不影响已正常运行的服务。退出时只清理 runtime，保留该提示，正常退出→重启才有机会复用旧端口。客户端、安装器与审批目标绝不读取此提示；它不是存活证据。损坏/缺失提示忽略，端口被占用或被保留则继续下一个候选。由 `src/` 的小型 helper 管理，不加入远端 hook 文件集。
- `EADDRINUSE` 和 `EACCES` 都可进入下一个候选；其他错误直接停止并报告。初次及后续尝试的同步 throw 也经过同一有界处理，不得在 error 回调里漏掉 try/catch；不无限重试。
- `listening` 后必须用 `server.address().port` 获取真实端口，不能把候选值 0 当作监听端口。范围外端口完成 runtime 发布后才设 activeServerPort、记录 listening、调度同步、settle(port)。runtime、`getHookServerPort()`、健康响应、集成同步、远程连接启动均使用这个真实端口。
- 保持 `startHttpServer()` 的 Promise 在成功/失败路径都落定，失败为 null，失败后不执行集成同步或 connect-on-launch。不新增重复 server / 后台 retry 状态机。
- 固定五个端口监听成功但 runtime 写失败时保留原来的服务可用 + Doctor warning 行为；监听范围外端口但 runtime 写失败时，客户端没有可靠发现路径，关闭这次 listener、清空 active port、返回 null，Doctor 显示 runtime 发布失败及路径。不能显示健康、不能继续安装指向该端口的 HTTP hook。
- 使用现有 owner-guarded runtime 清理，不为启动失败删掉另一进程的 runtime，不增加清理其他进程文件的权力。成功后原子替换 runtime。提示只降低不必要的端口漂移，不保证端口永不变；当旧端口不可用时，已运行 CLI 的 HTTP hook 快照可能需要新会话或重载，需真实 CLI 检查并在限制中说明。
- 所有同步安装入口只能使用本进程实际监听端口；未监听时 `getHookServerPort()` 仅兼容五个 legacy runtime 值，其他情形返回 23333，绝不把过期的范围外 runtime 端口传给设置安装、auto-start、Doctor 修复或 watcher。CodeBuddy 的服务端同步要显式传入该端口，避免安装器另读磁盘而漂移。命令行安装未显式指定端口时，只有 runtime app/port/ownerPid 合法且 owner 存活才采用范围外端口，否则回到 legacy 默认；明确的远端 identity 和调用方显式端口保持各自原有边界。

### 2. 区分本地有效端口与远程固定端口

- 本地端口允许 JSON 整数 1–65535，或者 ASCII `^[1-9][0-9]{0,4}$` 且值在该区间的字符串。不接受 0、负数、小数、超范围、空白、前导零、十六进制、指数格式、布尔值、数组或对象；数字字符串兼容只保留规范十进制形式。用共用测试数据验证 CJS、各独立 JS/TS、Python 的一致性。
- `SERVER_PORTS` 继续是原五个端口，作为 legacy 扫描集合及远端 allowlist。新增/拆分本地端口规范化与远端严格校验，不能全局放宽 `readRemoteIdentity()` 或 Remote SSH profile。
- `runtime.json` 仍是 `{app, port, ownerPid, ...}`，原子写入和权限不变。客户端只从明确的 runtime/已确认缓存/显式调用参数获取范围外端口，缺失或损坏时只扫描原五个端口。
- 现有身份头、健康确认、owner-only / live-owner 审批目标检查、远端 secure fail-closed 都保留。不把端口有效性误称为服务身份认证。
- 覆盖 CJS 公共 helper、OpenCode family v1/v2（含 MiMo）、Pi、OMP、OpenClaw、Hermes、DSH。对于 OpenCode v1/v2、OpenClaw、Hermes 的本地缓存：同一次请求先用缓存端口；落空后立即重读 runtime，再尝试五个 legacy 端口，去重且有界；缓存成功时保留不读文件的快路径。不能等丢掉第一次事件/第一次 Hermes 审批后才在下一次请求重新发现。Hermes secure 仍只走精确 identity，DSH 审批的 retry:false 以及 OpenCode 严格 permission/question 目标不改。安装复制/managed generation 的哈希变更使用既有机制，更新后按宿主现有要求重载常驻插件。
- 调用点分类：runtime 读写、local candidate、Windows process-chain port 比较使用本地校验；remote identity 与 buildPermissionUrl 的 nonce 分支保持五端口校验；HTTP 所有权按下一节单独判定。尤其不能让两个不同范围外进程链端口都归一为 null 后被误判一致。

### 3. HTTP 审批 hook 的所有权与迁移

不能把 `isManagedPermissionUrl()` 改成“任意 loopback 端口的 /permission 都属于 Clawd”。

- 原五个端口的 legacy `/permission` URL 和远端 nonce URL 继续按原规则识别。
- 本地范围外端口由 `buildPermissionUrl()` 生成专用固定路径 `/permission/clawd-on-desk`。该路径是安装器所有权标记，不是认证 token。仅精确的 `http://127.0.0.1:<有效端口>/permission/clawd-on-desk` 被识别；userinfo、query、fragment、路径变体、第三方普通 `/permission` 均不扩大接管范围。
- 本地路由额外接受这个精确路径，调用原 permission handler，执行同样的 Origin / Host / Content-Type 检查；普通 `/permission` 仍供现有 command/plugin 使用。远端 ingress 不接受新本地路径，也不改变 nonce 校验或 profile stamping。
- Claude 的注册、同步、watcher/health、卸载与 About cleanup 复用更新后的共同所有权分类。测试五个端口 → 范围外端口 → 另一个范围外端口 → 五个端口的迁移，保留所有 foreign hook 和 sibling。
- CodeBuddy 保留 `clawd-on-desk.permission.v1` 名字 marker 以及 preserve/custom/local 模式语义；范围外本地专用 URL 能被区分为 local，而用户自定义普通 `/permission` URL 不受影响。
- Windows NSIS 的 `build/uninstall-claude-hooks.ps1` 兜底同步加入精确专用路径规则，不能只依赖 Node 清理成功；用真实 PowerShell 验证删除标记 URL，同时保留普通第三方范围外 URL、query/fragment/路径变体。WorkBuddy 的导入清理也要跑回归。
- 不引入新的未知 hook schema 字段，不修改 Claude / CodeBuddy 审批回包。真实 Claude Code 验收应覆盖 HTTP URL 迁移后的普通人工审批。

### 4. Doctor 与日志

- server runtime status 保存有界的启动诊断：尝试端口、错误码、失败阶段（bind / runtime 发布）。错误文本有长度限制，不包含请求 body 或凭据。
- 未监听时 Doctor 展示实际端口和错误码；对 EACCES 提示可能受 Windows 端口保留或权限策略影响，不把它直接认定成 Hyper-V，也不误导成仅目录权限。
- 范围外端口监听并成功发布 runtime 后 Doctor 正常 pass；历史失败尝试不把已恢复的服务显示成故障。
- 保留旧 runtime 的 dead-owner / port mismatch 诊断。失败提示给出重启及只读检查方向，不建议停止 WinNAT 或修改系统保留列表。

对 EACCES 同时说明可能是保留区间、权限策略或其他程序独占，并可给出只读 `netsh interface ipv4 show excludedportrange protocol=tcp`。本轮不新增 runtime 写入重试层：现有 writer 是原子 boolean API，首次发布失败就关闭动态 listener 的行为可验证；Windows 文件占用导致的偶发失败风险明确保留，不在缺少实测时扩展该 API。既有本地同用户信任、PID 复用、静态 HTTP URL 在 Clawd 停止后可能被其他本地进程接收的边界不因路径标记消失；混合版本/降级不认识新路径的风险写入限制，不宣称认证增强。

## 预计文件范围

| 部分 | 主要文件 |
|---|---|
| 启动、提示、诊断与路由 | `src/server.js`, 新增服务端 port-hint helper, `src/doctor-detectors/local-server.js`, `src/integration-sync.js` |
| 本地 / 远端端口与 URL 分类 | `hooks/server-config.js`；只有调用语义确实需要时修改 Claude / CodeBuddy installer、health/watcher |
| 独立客户端 | `hooks/opencode-family-plugin/core.mjs`, `hooks/pi-extension.ts`, `hooks/omp-extension.ts`, `hooks/openclaw-plugin/index.js`, `hooks/hermes-plugin/__init__.py`, `hooks/dsh-clawd-bridge/lib/clawd-client.js` |
| 卸载与 WSL 提示 | `build/uninstall-claude-hooks.ps1`, WSL Pair 设置动作的诊断接线（不增加跨 home 发现机制） |
| 自动测试 | 现有 server-start / server-config / runtime-write / doctor-local-server / local-request-security / installer / 各 plugin / remote identity 测试；必要时增加集成级回归 |
| 文档 | `AGENTS.md`, `docs/project/agent-runtime-architecture.md`, `docs/guides/custom-agent-http.md`, setup / known-limitations 中确实宣称固定范围的段落 |

## 验收矩阵

1. **启动**：第一个 EACCES 后下一个成功；五个候选全部 EACCES / EADDRINUSE / 混合失败后系统端口成功；正常退出删除 runtime → 重启仍能通过独立提示复用旧动态端口；提示端口占用时再次漂移；坏提示不影响启动；系统端口失败及初次/后续同步 throw 均有界返回 null；settled 后不再重试；最终上报的是实际 address port。
2. **发布与安装**：动态端口写入 runtime 后读写一致；动态 runtime 写失败关闭 listener 且不设 active、不触发同步；五端口 runtime 写失败保留既有 warning。失败后设置安装/Doctor/auto-start 不使用陈旧动态 URL；CodeBuddy 使用当前实际端口；CLI 安装拒绝 dead-owner 的范围外端口。成功发布后没有陈旧端口传给远程连接。
3. **客户端**：每个受影响客户端能读取范围外 runtime 并实际将 state 发到对应 fake/本地测试 listener；缓存旧端口失效后，同一次发送能在新动态端口送达，Hermes 首次审批也覆盖；坏 runtime/非法端口不扩大扫描。OpenCode v1/v2 的 state 与严格 permission / question 目标均覆盖；Hermes secure 仍只接受原固定端口。共同非法值表覆盖各语言差异。
4. **所有权与安全**：专用 URL 能迁移/卸载（Node 与 PowerShell 两条路径），普通第三方 `127.0.0.1:45000/permission` 保持原样；remote nonce URL 及非法 identity 回归通过；remote ingress 即使带合法 nonce 也拒绝本地专用路径；新路径的浏览器请求防护与原路径一致；disabled/uninstalled agent 不写配置；WorkBuddy imported-hook cleanup 回归。
5. **Doctor**：bind EACCES、全部占用、runtime 发布失败可区分；恢复成功 pass；旧 runtime / 死 owner 保持准确提示。
6. **运行验收与隔离**：启动子进程前同时设置专用 HOME、USERPROFILE、HOMEDRIVE/HOMEPATH、APPDATA/LOCALAPPDATA，并清除/重设所有被测 agent 的 config/home 覆盖；Electron 另用独立 user-data-dir。进入子进程后先断言 Node os.homedir()/Python Path.home()/runtime path 实际指向测试目录，未满足就退出。server 测试显式注入全部 runtime 读写/清理和同步函数，不能只改日志路径。禁止碰用户现有 runtime、集成和进程。本机用真正 listener 验证系统分配端口、runtime 发现及状态请求。Windows 已只读发现自然保留区间（测试时重新读取），向隔离实例注入该区间内五个候选，另用自有 listener 验证 EADDRINUSE；这能测真实 EACCES，但不冒充报告者恰好 23333–23337 被保留的环境。还需检查真实 Claude 的人工审批及 Clawd 正常重启后的行为；未完成项明确 pending。

## 执行顺序与完成边界

1. 保存本计划和文件摘要，Claude 在隔离 checkout 只读审查；重点挑战端口放宽的权限边界、runtime 写失败、遗留 HTTP hook 所有权、远端隔离和插件漏项。
2. 云宝逐条检查原文与代码证据，记录采纳/驳回/待解决；存在阻塞项就修订同一计划、沿用同一 Claude 会话复核。通过前不写实现。
3. 先添加能复现问题的测试，再实现服务端和公共 helper，接着更新独立客户端、HTTP 所有权/路由、Doctor 及文档。
4. 运行定向测试和 `npm test`；做隔离真实 listener / CLI 验收，保留平台限制。必要的实现复查沿用同一 Claude job，不追加未经点名的审查者。
5. 独立复核最终 diff，提交在 `fix/` 分支并准备 draft PR（不合并、不发布、不回复 issue）。PR 明确自动化与真机证据，以及仍待报告者环境确认的部分。

## 参考

- Issue #1248：上面的用户环境报告。
- Node [`server.listen`](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback)：port 0 由系统分配，listening 后通过 address().port 获取。
- [Microsoft WSAEACCES 说明](https://learn.microsoft.com/en-us/troubleshoot/windows-server/networking/error-10013-wsaeacces-is-returned)：记录了 excluded port 绑定失败情形；该文适用特定 Windows Server 场景，不视为对本次 Windows 11 环境的完整复现证据。
