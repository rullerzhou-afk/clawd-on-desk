# Telegram legacy transport 立即退役计划

- 状态：已通过四轮子代理对抗复审（0 must-fix / 0 should-fix），可实现
- 目标版本：v0.14.0
- 基线：`origin/main@04687b96882bf18b54dd34017bb9c137942f478f`
- 实现分支：`feat/telegram-legacy-immediate-retirement`

## 1. 决策摘要

本计划取代“Release N 继续运行 legacy、到 v0.15.0 才删除”的旧方案。

v0.14.0 的产品契约是：

1. Telegram legacy Go sidecar 已退役，不再启动、不再恢复、不再打包。
2. 旧用户已有的 bot token、allowed Telegram user id、target session key 原样复用，不要求重新配置。
3. 旧偏好只作为“这是一个需要迁移的旧用户”的检测证据，不再代表一种可运行 transport。
4. Settings 显示明确的阻断式迁移门：“旧版 Telegram 已退役，请验证并切换到原生模式”。
5. 用户点击 CTA 后，Clawd 使用已有配置发送原生 Telegram 验证卡；只有真实 Telegram callback 成功后才持久化 `transport: "native"`。
6. 失败、超时或原生启动失败都不会恢复 legacy；错误 callback 会被安全忽略并保持 testing，随后由 timeout 回到迁移门；用户可重试或关闭 Telegram。
7. 已经处于原生模式的用户不看到退役提示，行为不变。
8. 显式关闭 Telegram 的用户不被旧字段重新激活。
9. 不删除 `telegram-approval.env`，不改写 token，不删除旧 bridge TOML 等用户数据。

“立即退役”分三层同时成立：

- 产品层：legacy 不再是可选择或可回退的模式。
- 运行时层：Clawd 不再创建 sidecar、bridge 或 sidecar HTTP client。
- 产物层：五个目标安装包都不再包含 `cc-connect-clawd`。

## 2. 历史事实与纠偏

### 2.1 已核实的历史

- v0.9.0 引入 native Telegram 时明确采用 compatibility-first 策略：legacy sidecar 继续打包，旧用户需显式切换。
- commit `1960d82` / PR #647 只删除了已经无读者的旧 migration-card 渲染层；其提交说明明确指出迁移状态机与 sidecar fallback 当时仍是生产路径。
- v0.13.0 仍包含 sidecar 源码、启动逻辑、五目标 `extraResources` 和 pinned binary 获取/校验流程。

因此，“丰富的 Allow / Deny 已由 native 实现”与“legacy runtime 已经删除”是两件事。前者早已成立，后者尚未成立。

### 2.2 本次新的产品决定

维护者现在明确决定迁移窗口已经结束。v0.14.0 不再给 legacy 一个额外通知版本，也不保留 “Later / I understand”：

- 旧用户必须验证 native 才能继续使用 Telegram 审批；
- 或者显式关闭 Telegram；
- 没有继续使用 legacy 的按钮、隐藏开关或回滚入口。

旧的 `feat/telegram-legacy-release-n` 分支及其“到 v0.15 才退役”的实现不作为本计划的实现基础，不 cherry-pick 其产品代码。

## 3. 当前生产事实

### 3.1 当前 legacy 仍然可运行

当前 `src/telegram-migration-state.js` 会在以下情况进入 `LEGACY_ACTIVE` 并产生 `START_SIDECAR`：

- `tgMigration.transport === "legacy"`；
- 缺少 transport、legacy 配置完整且 `legacyEnabled !== false`；
- native 测试失败或超时，且 legacy 可用。

当前 `src/main.js`：

- 创建 `telegram-approval-sidecar`；
- 创建 sidecar status bridge；
- 维护 sidecar 配置写入与同步队列；
- legacy 时从 sidecar 取得 `/permission` client；
- 设置变化、token 写入和退出流程都包含 sidecar 生命周期。

当前 `package.json` 和三个 workflow 会：

- 启动/构建前 ensure、fetch、verify pinned binaries；
- 按平台/架构把 sidecar 放入 `extraResources`；
- 对五目标产物运行 packaged-sidecar assertion。

### 3.2 可复用的 native 配置

native 与 legacy 已共享以下用户数据：

- `tgApproval.allowedTgUserId`；
- `tgApproval.targetSessionKey`；
- `userData/telegram-approval.env` 内的 bot token。

native 验证不需要用户重新输入 token/user/chat。旧 bridge TOML 不是 native 的输入。

### 3.3 native 验证的安全门

原生 runner 只在以下条件同时成立时接受测试成功：

- callback data 精确匹配当前 nonce；
- Telegram user id 匹配配置；
- chat/session 匹配配置；
- callback 仍属于当前 pending test。

本计划不新增本地成功快捷方式，也不允许单元测试 fixture 进入生产。

## 4. 非目标与边界

本 PR 不做：

- 不删除或重写 `telegram-approval.env`；
- 不主动清理用户目录中旧的 `cc-connect-clawd/clawd-bridge.toml`；
- 不轮换 token，不改变 allowed user/chat；
- 不修改 Feishu/Lark、LAN approval、Discord、Remote SSH、#690 窗口代码；
- 不删除历史 release notes 中对 v0.8/v0.9 的准确记录；
- 不删除 Telegram native 模块：
  - `telegram-native-client.js`
  - `telegram-native-runner.js`
  - `telegram-token-store.js`
  - `telegram-companion.js`
  - `telegram-direct-send.js`
  - `telegram-fetch-transport.js`
- 不把所有名字含 `sidecar` 的功能一并清理。Remote SSH/statusline sidecar、Koffi native payload 和 `elevate.exe` 均不属于 Telegram legacy。
- 不建立与本任务无关的全仓 compatibility ledger。
- 不修现有 Windows Remote SSH 的 CRLF、POSIX path 或 chmod 基线失败。

## 5. 权威状态模型

### 5.1 状态

保留：

- `IDLE`：Telegram 显式关闭或从未启用；
- `NEEDS_SETUP`：用户有启用/迁移意图，但 token/user/chat 不完整；
- `TESTING_NATIVE`：原生验证卡正在等待真实 callback；
- `NATIVE_ACTIVE`：原生 transport 已验证并运行。

新增：

- `NATIVE_MIGRATION_REQUIRED`：检测到旧 legacy 用户；legacy 不运行，用户必须验证 native 或关闭 Telegram。

删除：

- `LEGACY_ACTIVE`；
- `SWITCHING_TO_LEGACY`。

### 5.2 事件

保留：

- `USER_TEST_NATIVE`
- `TEST_SUCCESS`
- `TEST_FAILED`
- `TEST_TIMEOUT`
- `USER_DISABLE`

删除：

- `USER_ENABLE_LEGACY`
- `USER_ROLLBACK_TO_LEGACY`
- `SIDECAR_STARTED`
- `SIDECAR_START_FAILED`
- `SIDECAR_RUNTIME_FAILED`
- `SIDECAR_RUNTIME_RECOVERED`

同步删除 legacy-only side effects：

- `START_SIDECAR`
- `STOP_SIDECAR`
- `EMIT_RUNTIME_STATUS`（当前只承载 sidecar health）

同步删除 legacy-only error codes：

- `LEGACY_ENV_MISSING`
- `LEGACY_CONFIG_INCOMPLETE`

所有 renderer 可发事件继续采用白名单；renderer 只能发送 `{ type }`，时间、错误分类和 callback 元数据只能由 main/native runner 产生。

### 5.3 初始状态判定

按以下优先级计算，不能先 normalize 后丢失“transport 字段是否原本存在”的信息：

| 持久化事实 | 配置完整 | 初始状态 | 启动副作用 |
|---|---:|---|---|
| `transport === "native"` 且 `nativeVerifiedAt` 有效 | 是 | `NATIVE_ACTIVE` | 启动 native poller |
| `transport === "native"`、配置完整但缺验证证据 | 是 | `NATIVE_MIGRATION_REQUIRED` | 无 |
| `transport === "native"` 且配置不完整 | 否 | `NEEDS_SETUP` | 无 |
| `transport === "off"` | 任意 | `IDLE` | 无 |
| `transport === "legacy"` | 是 | `NATIVE_MIGRATION_REQUIRED` | 无 |
| `transport === "legacy"` | 否 | `NEEDS_SETUP` | 无 |
| transport 缺失，且 legacy intent 为真 | 是 | `NATIVE_MIGRATION_REQUIRED` | 无 |
| transport 缺失，且 legacy intent 为真 | 否 | `NEEDS_SETUP` | 无 |
| transport 缺失，且无启用意图 | 任意 | `IDLE` | 无 |
| transport 字段存在但值非法 | 任意 | fail-safe：按 legacy intent/config 进入 migration-required、needs-setup 或 IDLE，并记录脱敏诊断 | 无 |

legacy intent 的兼容读取仅来自：

- 明确的历史 `legacyEnabled === true`；
- 当 `legacyEnabled` 缺失时，历史 `tgApproval.enabled === true` 的只读镜像。

`transport === "off"` 永远优先于 stale `legacyEnabled === true`，防止显式关闭的用户被复活。

非法 transport 与字段缺失都不得启动 runtime；区别是非法值必须留下可审计诊断，不能被静默解释成用户显式 off。

controller 必须保留 test origin（`legacy` / `native-unverified` / `idle`），使失败后的归宿不依赖 normalize 后的 transport 猜测。

### 5.4 转移矩阵

| 当前状态 | 事件 | 下一状态 | 持久化 | 运行时 |
|---|---|---|---|---|
| `NATIVE_MIGRATION_REQUIRED`，live config 完整 | `USER_TEST_NATIVE` | `TESTING_NATIVE` | 无 | 启动 native，发送验证卡，启动 60s timer |
| `NATIVE_MIGRATION_REQUIRED`，live config 不完整 | `USER_TEST_NATIVE` | `NEEDS_SETUP` | 无 | 不启动，刷新缺失项 |
| `NEEDS_SETUP`，live config 已完整 | `USER_TEST_NATIVE` | `TESTING_NATIVE` | 无 | 重新读取配置后启动 native；不得要求重启 Settings/app |
| `NEEDS_SETUP`，live config 仍不完整 | `USER_TEST_NATIVE` | `NEEDS_SETUP` | 无 | 返回缺失配置错误，不启动 |
| `IDLE`，live config 完整 | `USER_TEST_NATIVE` | `TESTING_NATIVE` | 无 | 使用现有完整配置发验证卡 |
| `IDLE`，live config 不完整 | `USER_TEST_NATIVE` | `NEEDS_SETUP` | 无 | 不启动，刷新缺失项 |
| `TESTING_NATIVE` | `TEST_SUCCESS` | `NATIVE_ACTIVE` | `transport=native`, `nativeVerifiedAt=now` | 保持 native poller |
| `TESTING_NATIVE`（migration-required 起源：legacy 或 native-unverified） | `TEST_FAILED/TIMEOUT` | `NATIVE_MIGRATION_REQUIRED` | 不改 transport/token | 停止 native poller |
| `TESTING_NATIVE`（off/IDLE 起源） | `TEST_FAILED/TIMEOUT` | `IDLE` | 不改 token；transport 保持/写为 off 的现有语义 | 停止 native poller |
| 任意非 IDLE | `USER_DISABLE` | `IDLE` | `transport=off`, 清 `nativeVerifiedAt` | 停止 native poller |
测试失败必须记录有限、脱敏的 `lastTestResult`：

- `failed` + allowlisted `errorClass`；
- `timeout`；
- `native-start-failed`。

不得存 raw error、HTTP body、nonce、token、chat/user id 或路径。重启后该临时结果可清空。

native active 后的网络/Telegram API 健康状态继续由 native runner 自身的 retry 与 status 负责，不为此虚构一个当前不存在的 reducer event；任何 native runtime failure 都不得触发 legacy。

### 5.5 配置变化 reconcile

token、allowed user、target session 或相关 `tgApproval` 设置成功写入后，main 必须调用 controller 的串行 `reconcileConfiguration()`（或等价 internal event），不能只刷新 UI：

- `NEEDS_SETUP` + 配置变完整：
  - legacy/native-unverified intent -> `NATIVE_MIGRATION_REQUIRED`；
  - `transport=native` 且仍有有效 `nativeVerifiedAt` 的已验证用户 -> `NATIVE_ACTIVE` 并启动 native poller；
  - explicit off/fresh IDLE intent -> `IDLE`；
- `NATIVE_MIGRATION_REQUIRED` + 配置变不完整 -> `NEEDS_SETUP`；
- `TESTING_NATIVE` 期间配置变化：取消当前 pending test、清 timer、停止 poller，按 test origin 回到 migration-required 或 IDLE；旧 nonce 此后必须无效；
- `NATIVE_ACTIVE` 的连接配置变化：串行重启/刷新 native poller；若必需配置变不完整则停止并进入 `NEEDS_SETUP`，绝不回 legacy；
- `transport=off` 始终保持 IDLE，配置写入本身不能隐式启用。

已验证 native 的 repair 与身份变化必须区分：

- 启动/运行时因 token 文件暂时缺失而进入 `NEEDS_SETUP`，随后恢复配置，且持久化仍是 `transport=native + nativeVerifiedAt`、Settings 未改连接身份：恢复 `NATIVE_ACTIVE` 并启动 poller；
- Settings 明确替换 token、allowed user 或 target session，属于连接身份变化：先停止当前 test/poller，清 `nativeVerifiedAt`，进入 `NATIVE_MIGRATION_REQUIRED`，要求用新身份重新验证；
- 不持久化 raw token 或 token hash；进程内写入路径可用写前/写后内容是否实际变化或 revision 来判断，日志不得含 token；
- 不能因为普通 `enabled` 联动或非连接字段（completion/direct-send preferences）变化而清验证证据。

`USER_TEST_NATIVE` 自身也必须在 reducer 前读取 live config，因此即使异步 reconcile 尚未完成，刚补齐配置的用户也能立即起测。

reconcile 接线必须防 controller 自重入：

- controller-originated 的 `tgMigration` 持久化及其 `tgApproval.enabled` 联动写入带 suppression/source 标记，不触发外部 config reconcile；
- Settings subscriber 只在 token、allowed user、target session 等真实连接字段变化时 fire-and-forget enqueue reconcile，绝不能在当前 controller dispatch 的 prefs write 中 await 同一 public queue；
- 单纯的 `enabled` 联动不得重启刚建立的 native poller；
- 测试必须制造 `TEST_SUCCESS -> write prefs -> settings subscriber` 链，证明不死锁、不二次 restart、revision 最终一致。

### 5.6 并发与 partial failure

controller 的 public `dispatch` 必须串行化，至少关闭：

- `TEST_SUCCESS × TEST_TIMEOUT`；
- 用户关闭 × callback；
- 重复 callback；
- Settings 重复点击。

timer 事件和 native callback 必须进入同一队列。迟到 terminal 事件在已经离开 `TESTING_NATIVE` 后必须无副作用，尤其不能覆盖成功结果。

若 `START_NATIVE_POLLER` 或 `SEND_TEST_CARD` 的 apply 阶段失败：

1. best-effort 停止 native poller；
2. 清 timer；
3. migration-required 起源（legacy 或 native-unverified）回 `NATIVE_MIGRATION_REQUIRED`；
4. IDLE 起源回 `IDLE`；
5. 写入脱敏失败结果；
6. 不写 `transport=native`；
7. 不启动 sidecar；
8. 不改 token。

偏好写入只有成功后才能更新 controller 的内存镜像。

## 6. Settings UX

### 6.1 migration-required 卡片

仅在 `NATIVE_MIGRATION_REQUIRED` 或从该状态进入的 `TESTING_NATIVE` 显示。

五语言（`en/zh/zh-TW/ko/ja`）语义一致：

- 标题：Telegram 旧版模式已退役；
- 正文：现有 token 与目标配置会被复用，无需重新配置；
- 主按钮：验证原生连接并切换；
- 次要动作：关闭 Telegram；
- 文档链接：迁移/排障指南。

若 origin 是 `native-unverified` 而非历史 legacy，复用同一阻断状态与 CTA，但正文改为“当前 Telegram 原生连接需要重新验证”，不得错误声称该用户正在使用旧版。

禁止出现：

- “仍可继续使用到 v0.15”；
- Later / I understand；
- Enable legacy；
- rollback；
- Delete legacy token。

### 6.2 状态展示

- migration-required 不能显示绿色 `Running`；
- 已 native 的用户继续显示现有运行状态，不显示退役卡；
- `TESTING_NATIVE` 显示等待用户点击 Telegram 验证卡；
- failed、timeout、native-start-failed 分别显示可操作文案和 Retry；
- 点击关闭后卡片消失，状态为 off；
- 不要求关闭/重开 Settings 才刷新。

现有 Telegram toggle 在 migration-required 时不能被 `tgApproval.enabled === true` 误判为已启用。迁移 CTA 与普通 toggle 的语义必须分开。

入口语义：

- migration-required 用户只能走阻断卡 CTA；
- fresh/explicit-off 的 `IDLE` 用户在配置完整时仍可通过现有 Enable toggle dispatch `USER_TEST_NATIVE`，这是首次启用入口，不显示 legacy-retired 卡；
- 仅在 `NATIVE_ACTIVE` 且 native poller 正在运行时可点击；
- `NATIVE_MIGRATION_REQUIRED`、`NEEDS_SETUP`、`TESTING_NATIVE` 和 `IDLE` 中必须 disabled/隐藏；
- 上一条仅约束普通 “Send test request”；pre-verification 的真实 nonce 入口分别是 required card CTA 或 IDLE Enable toggle；
- 删除 main 中该普通测试入口的 sidecar fallback。

### 6.3 异步刷新

复用 channel-scoped `remoteApproval:status-changed`：

```js
{ channel: "telegram", revision: <monotonic integer> }
```

payload 不携带 snapshot、token、user/chat 或错误正文。renderer 收到更新后重新 pull `telegramMigrationSnapshot`。

必须同时更新：

- main 的 revision notifier；
- preload 既有 status-changed 通道已有 channel-generic 转发，无需制造行为改动，但必须加回归测试证明 Telegram payload 能透传且 unsubscribe 不变；
- renderer 对 `channel === "telegram"` 的处理；
- snapshot sequence 防旧响应覆盖；
- `migrationSnapshotRenderKey`（至少包含 state、revision、test origin、lastTestResult）。

## 7. 偏好与用户数据

### 7.1 保留的兼容读取

`tgMigration.transport` schema 暂时继续接受 `"legacy"`，但仅作为历史检测标记：

- 新代码永不写入 `"legacy"`；
- `"legacy"` 不对应任何 runtime owner；
- 成功验证改写为 `"native"`；
- 用户关闭改写为 `"off"`。

缺 transport 的旧 prefs 继续用字段存在性与 legacy intent 判定，不得把 normalize 生成的 `"off"` 当成用户显式关闭。

### 7.2 token/config 不变量

以下值在迁移成功、失败、超时、关闭和重启测试中都必须验证：

- `telegram-approval.env` 不被删除；
- 验证流程不重写 token 文件，SHA-256 与 mtime 不变；
- 旧 bridge TOML（若存在）不被读写删除，SHA-256 与 mtime 不变；
- `allowedTgUserId` 不变；
- `targetSessionKey` 不变；
- 失败路径不清 `tgApproval`；
- 旧 bridge TOML 即使存在也不读取、不写入、不删除。

### 7.3 删除 legacy-only settings helpers

从 `telegram-approval-settings.js` 删除：

- `defaultBridgeConfigPath`
- `buildBridgeConfigToml`
- `writeBridgeConfigFile`
- TOML quoting helper

保留 token env、配置 normalize/validate、readiness、masking 与 redaction helpers。

## 8. 运行时删除集合

计划删除：

- `src/telegram-approval-sidecar.js`
- `src/telegram-approval-client.js`
- `src/telegram-sidecar-status-bridge.js`
- `src/telegram-owner-manager.js`（唯一职责是 legacy/native owner 互斥；native-only controller 不再需要）

同步删除对应测试：

- `test/telegram-approval-sidecar.test.js`
- `test/telegram-approval-client.test.js`
- `test/telegram-sidecar-status-bridge.test.js`
- `test/telegram-owner-manager.test.js`

`src/main.js` 删除：

- sidecar/bridge require、全局、创建、同步、状态签名、配置写入、退出 stop；
- legacy client fallback；
- token/settings 变化触发 sidecar sync；
- legacy status overlay；
- `transport=legacy` 的写入联动。

同步清理：

- `src/permission.js` 中声称由 `cc-connect-clawd` 负责 redaction 的过时注释，改为当前 native/transport-neutral 事实；
- `src/i18n.js` 五语言中的 `telegramApprovalSidecarNotRunningMessage`；
- `test/fakes/migration-transitions.js` 的 legacy transition fixtures，改成 immediate-retirement 状态；
- `test/telegram-approval-settings.test.js` 只删除 bridge TOML helper 用例并增加“exports 中不再有 bridge writer”的反向断言；保留该文件中 native token/config 测试。

保留并重接：

- native runner；
- native permission client；
- companion/direct-send/fetch transport；
- token store；
- migration controller；
- Telegram `/status` 的 native-only路径。

`telegram-approval-runtime-status.js` 不再把 legacy 视为健康或可用 transport。历史 legacy marker 只通过 migration state 显示为 setup/migration-required；`/status` 仍只在 native active 时可达。

## 9. 打包与仓库删除集合

计划删除：

- `bin/cc-connect-clawd/README.md`
- `scripts/fetch-sidecar-binaries.js`
- `scripts/ensure-sidecar-binaries.js`
- `scripts/verify-sidecar-binaries.js`
- `scripts/assert-packaged-sidecar.js`
- 对应四个测试文件
- `.github/workflows/sidecar-package-audit.yml`

`package.json`：

- `start` 改为 `node launch.js`；
- 删除 fetch/verify/assert sidecar scripts；
- 删除所有只为 sidecar 存在的 `prebuild*` hooks；
- 删除 mac/win/linux 的 sidecar `extraResources`；
- 将 `@electron/asar` 声明为直接 devDependency，供跨平台真实 archive retirement assertion 使用；
- 保留 common `assets/icon.ico -> icon.ico`；
- 不改变 NSIS architecture contract。

`.gitignore`：

- 删除 `bin/cc-connect-clawd` executable ignore 与 README negation；
- 删除三个现存的已退役 sidecar script `!scripts/...` negation（verify/fetch/assert；ensure 当前没有单独 negation）；
- 因仓库默认忽略 `scripts/*`，显式加入 `!scripts/assert-no-retired-telegram-sidecar.js`；
- 保留所有无关 scripts allowlist；
- 本计划文件受现有 `docs/**` ignore 影响，提交时必须使用精确 `git add -f docs/plans/plan-telegram-legacy-immediate-retirement.md`，不得误开放整个 docs 树。

`.github/workflows/build.yml`：

- 删除 fetch/verify/packaged-sidecar steps；
- 保留正常 `npm test` 与 electron-builder；
- `artifact_validation_only` 若保留，focused test 清单改为 retirement/package 配置测试；
- installer artifact 上传不变。

`.github/workflows/wayland-smoke.yml`：

- 删除 sidecar fetch/verify；
- AppImage 构建和 Wayland 测试语义不变。

新建跨平台断言 `scripts/assert-no-retired-telegram-sidecar.js`，对解包后的 resources root hard fail：

- 出现 `sidecars/cc-connect-clawd/**`；
- 任意路径 basename 为 `cc-connect-clawd` 或 `cc-connect-clawd.exe`；
- legacy-only source module 意外出现在可枚举的 app.asar 清单。

将原五目标 PR package workflow 改造成 retirement assertion workflow（可改名），实际构建：

- windows-x64
- windows-arm64
- darwin-x64
- darwin-arm64
- linux-x64

每个 job 必须：

1. 不下载 sidecar；
2. 构建真实产物；
3. 对解包 resources 运行 retirement assertion；
4. 保存稳定 JSON manifest；
5. 断言安装包存在。

CI fail-closed 消费面：

- 无 paths filter 的 `.github/workflows/repository-asset-audit.yml` 必须运行：
  - `npm install`（新 assertion 明确直接依赖 `@electron/asar`，不得依赖 electron-builder 的未声明 transitive hoist）；
  - `test/assert-no-retired-telegram-sidecar.test.js`；
  - package/workflow source guard（无 legacy scripts、extraResources、source importer）；
  - 正反 fixture，证明断言脚本自身不是恒绿；
- 五目标 workflow 的 paths filter 至少覆盖：
  - `package.json`
  - `.gitignore`
  - `src/telegram-*`
  - `src/main.js`
  - 新 assertion script/test
  - package config test
  - build/retirement workflow 自身；
- manifest 路径按字典序，内容无时间戳，固定 `\n` EOL；
- `package.json` 必须把 `@electron/asar` 声明为直接 devDependency 并更新 lockfile；
- app.asar 不能靠普通 `fs.readdir` 假装已检查。实现必须使用已声明的 `@electron/asar` API 枚举 archive，再与 resources 外层递归清单合并；
- assertion 单测必须创建真实 app.asar negative fixture，证明藏在 archive 内的 retired source 会 hard fail；五目标 build job 在真实 archive 上再跑一次。

仓库资产审计中“tracked sidecar executable hard fail”保留，作为防止二进制回流的永久安全规则；不需要保留下载/校验脚本才能消费该规则。同步把 finding 文案从 “must remain generated/ignored” 改为 “retired Telegram sidecar executables must never be tracked”，并更新单测，避免审计输出继续声称它应被生成或忽略。

## 10. 测试计划

### 10.1 状态机

至少覆盖：

- `transport=legacy` 完整配置 -> migration-required，零 sidecar effect；
- 缺 transport + legacy intent -> migration-required；
- 缺 transport + 无 intent -> IDLE；
- 非法 transport -> 零 runtime + 脱敏诊断；
- explicit off + stale legacyEnabled -> IDLE；
- native verified -> native active；
- legacy 配置不完整 -> needs setup；
- migration-required -> testing -> success -> native；
- legacy 配置不完整 -> needs-setup -> 用户补齐 -> 不重启 Settings/app 即可 testing；
- legacy 起源的 failed/timeout/start failure -> migration-required，不恢复 legacy；
- native-unverified 起源的 failed/timeout/start failure -> migration-required；
- migration-required/IDLE 点击验证前配置已变不完整 -> needs-setup，零 poller/card；
- IDLE 起测失败 -> IDLE；
- disable -> off；
- 无 legacy event/effect/export。

### 10.2 controller

至少覆盖：

- callback/timeout 串行竞争；
- TEST_SUCCESS 联动写 prefs 不触发 reconcile 自锁或第二次 native restart；
- native-active -> 配置暂缺 -> 原身份 repair -> native-active；
- native-active -> Settings 改 token/user/chat -> 清验证证据并进入 migration-required；
- write prefs 失败不污染内存；
- native start/send failure 的确定归宿；
- best-effort stop 再失败仍有终态；
- 迟到/重复 callback 不覆盖结果；
- timer 全路径清理；
- revision 单调；
- snapshot 不含 secrets；
- controller 不需要 sidecar dependency。

### 10.3 Settings/IPC/i18n

至少覆盖：

- migration-required 显示退役阻断卡；
- 没有 Later/legacy/rollback/delete-token 控件；
- CTA 只发 `USER_TEST_NATIVE`；
- renderer payload 额外字段被剥离；
- already-native/off 不显示卡；
- migration-required 不显示 Running；
- migration-required 不存在第二个可点击的普通 Send test 入口；
- 普通 Send test 仅在 native active + polling 可用；
- fresh IDLE 与 explicit-off + 完整配置的 Enable toggle 都能进入真实 native 验证；
- async revision 后立即刷新；
- render key 会因 last result/revision 改变；
- 五语言逐 key parity；
- failed/timeout/start failure 文案不同；
- 关闭 Telegram 后卡片消失。

### 10.4 用户数据

fixture 覆盖：

- v0.8 风格缺 transport；
- v0.9 风格 `legacyEnabled=true`；
- `transport=legacy`；
- `transport=off` + stale legacy flag；
- native verified；
- 不完整 legacy config。

端到端 prefs round-trip 分字段断言：token env 与旧 bridge 文件字节/mtime 不变、allowed user/target session 不变；只允许 `tgMigration.transport/nativeVerifiedAt` 和与 transport 既有联动明确列出的字段发生预期变化。

### 10.5 删除与产物

- `rg` 证明生产代码无 legacy source importer；
- package config 断言无 sidecar scripts/prebuild/extraResources；
- workflow 断言不 fetch/verify sidecar；
- retirement assertion 正反 fixture；
- source audit 0 error；
- Windows x64 真实解包产物 sidecar 归零；
- PR CI 最终提供五目标真实归零证据。

删除测试的理由必须是对应生产模块已删除，不得以测试数量多为理由。

## 11. 文档

更新：

- `docs/guides/telegram-approval.md`
- `docs/guides/setup-guide.md` 中所有仍称 legacy 可用的段落
- `docs/project/release-process.md`
- 与 package/workflow 命令直接相关的文档

文档必须说明：

- v0.14.0 已移除 legacy runtime；
- 旧配置自动复用；
- 需要真实 Telegram 验证 callback；
- 失败不会删除配置，但 Telegram 保持不可用直到验证成功或被关闭；
- token 文件不被删除；
- 409 conflict 的排障要求同一个 bot token 只能有一个 poller。

历史 release notes 不改。

## 12. 验证

### 12.1 自动化

至少执行：

- 新/改状态机、controller、Settings、IPC、settings、runtime-status 测试；
- retirement assertion 单元测试；
- package/build config 测试；
- `npm run audit:assets` 连跑两次，三份 JSON 逐字节一致；
- `npm test`；
- `git diff --check`；
- `rg` 删除闭包核对；
- Windows x64 `electron-builder --win nsis:x64` 或等价真实构建；
- 对 `win-unpacked/resources` 运行 retirement assertion；
- 解包/清单确认 `cc-connect-clawd` 为零。

Windows Remote SSH 既有 CRLF/POSIX/chmod 失败必须单列；不混入本 PR。

### 12.2 隔离真机 Telegram smoke

本 PR 的真实 smoke 必须使用 Windows Sandbox/VM，不允许把本机 launcher 的 env 隔离当作等价完成证据。原因是文件 env 无法隔离 `app.setLoginItemSettings` 的 HKCU 注册表写入，也无法证明宿主上所有 agent/config side effect 均被拦截。

Sandbox/VM 内仍必须使用其自身的：

- `APPDATA`
- `USERPROFILE`
- `HOME`
- `CLAUDE_CONFIG_DIR`
- `CODEX_HOME`
- Electron userData。

预置 `openAtLogin=false`、`autoUpdateCheck=false`，确认不会写宿主 agent 配置。启动 smoke 前宿主 Clawd 必须完全退出，而不只是停止同 token poller；隔离实例运行期间不得有第二个进程使用同一 Telegram bot token polling。

smoke 前后记录：

- token env 文件 SHA-256 + mtime；
- 旧 bridge TOML（若存在）的 SHA-256 + mtime；
- prefs 中 allowed user/chat 的值；
- 宿主配置 hash；
- 是否存在任何 `cc-connect-clawd` 进程；
- runtime snapshot。

真实步骤拆为互不污染的 fixture：

### A. 成功迁移

1. 用 legacy fixture（已有 token/user/chat，`transport=legacy`）启动；
2. 确认无 `cc-connect-clawd` 进程、UI 显示“已退役/必须切换”；
3. 确认没有 Later/继续 legacy，也没有第二个普通 Send test 入口；
4. 点击 CTA；
5. Telegram 收到真实 nonce 验证卡；
6. 由真实用户在 Telegram 客户端点击确认；
7. Settings 无需重开即变为 native running；
8. 重启后仍 native；
9. 发起真实 agent 审批，Allow 与 Deny 各一次；
10. 关闭 Telegram 后为 off，重启不复活；
11. token env 与旧 bridge 文件的 hash/mtime 不变；allowed user/target session 值不变。`tgMigration` prefs 因成功切换必须发生预期变化，不能笼统要求整个 prefs 文件 hash 不变。

### B. timeout

使用全新的 legacy fixture：CTA -> 收到卡但不点击 -> 60s timeout -> 回 migration-required + Retry；全程无 sidecar 进程、prefs/token 不变。

### C. 错误或 stale callback

使用另一个全新 legacy fixture：发送错误 nonce/user/chat callback -> 不成功、不写 native prefs、仍保持 testing -> 随后由 60s timeout 收敛到 migration-required。错误 callback 本身不会立即产生 `TEST_FAILED`，不能把“安全忽略”和“立即失败”混为一谈。

### D. 安装升级

在 Sandbox/VM 先安装 Windows v0.13.0，再用 head NSIS installer 原位升级：

- head 测试 installer 必须带 v0.14.0（或更高）的临时构建版本元数据，不能用同为 0.13.0 的覆盖安装冒充真实升级；临时版本只用于隔离构建，不提交 package version；
- 新版本进程不会启动旧 executable；
- 安装目录中的旧 `cc-connect-clawd` 必须被卸载/升级流程清除；若 NSIS 明确保留了孤儿文件，则本 PR 必须增加受约束的安装期清理并复测，不能只声称“代码不可达”；
- 卸载后也不得残留 packaged sidecar；
- 用户 token/config 数据仍保留。

Sandbox/VM 在 A-9 前必须预装并登录一个真实支持 Clawd 审批的 agent；curl 或自造 `/permission` payload 不能替代真实 agent smoke。

自动化不得伪造 A-6。若维护者未在线点击，允许把隔离实例和待点击卡留在安全、可识别状态，但不能把 smoke 报为完成。

## 13. 提交结构

建议本地提交：

1. `docs: plan immediate Telegram legacy retirement`
2. `refactor(telegram): remove legacy runtime and fallback`
3. `feat(telegram): add native migration-required gate`
4. `build: remove Telegram sidecar packaging`
5. `test(docs): lock retirement and migration contract`

提交可按实现耦合适当合并，但最终 PR 必须是独立、可回滚的 Telegram retirement 变更，不夹带其他修复。

## 14. 完成条件

同时满足才可称“整个 Telegram legacy 退役完成”：

- legacy runtime/source/importer 删除；
- legacy 状态、事件、副作用和 fallback 删除；
- Settings 只提供 native 验证或关闭；
- 旧配置原样复用；
- 失败不恢复 legacy；
- token 不删除、不重写；
- 五目标 package assertion 证明 sidecar 为零；
- 自动化无新增失败；
- 隔离真机 callback、重启、Allow/Deny smoke 完成；
- 文档与 release 流程同步；
- 对抗式 code review 无 must-fix。

在五目标 CI 尚未跑或真实用户尚未点击 callback 时，只能报告“代码实现完成，等待对应证据”，不得提前宣称全部完成。
