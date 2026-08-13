# Plan: npm 依赖安全修复与发布产物验证

> 状态：已通过最终交叉审查，无 P0/P1 计划缺陷；等待实施授权。本文不授权修改依赖、提交、推送、创建 PR、合并或发版。
>
> 调查基线：`main` = `57073c986e3174ed07dca17a4d30bf1cea3b993b`，当时工作区干净且与 `origin/main` 一致。实施前必须重新核对，不能把这条历史记录当作当前状态。
>
> 日期：2026-08-10

## 0. 决策摘要

建议用 **一个独立依赖安全 PR** 处理当前 14 个独立 advisory（npm 汇总显示为 12 个 high package nodes），不拆成多个依赖 PR：

- 直接依赖安全地板：
  - `electron-builder`: `^26.8.1` → `^26.15.7`，本次候选 lockfile 预期锁定 `26.15.7`。
  - `electron`: `^41.10.2` → `^41.10.4`，本次候选 lockfile 预期锁定 `41.10.4`。
- 间接依赖必须做命名包定向刷新，不能假设两个直接升级会自动清掉所有旧物理副本：
  - `app-builder-lib` → `26.15.7`；`builder-util` / `electron-publish` 预期为 `26.15.3`；`dmg-builder` 预期为 `26.15.7`。
  - electron-builder 构建树中的 `builder-util-runtime` → `>=9.7.0`，当前解析预期为 `9.7.0`。
  - `js-yaml` → `4.3.1`。
  - `brace-expansion` → `1.1.18` / `2.1.4` / `5.0.9`（按各自 major 保持兼容）。
  - `ip-address` 安全地板为 `10.3.1`；最终候选树已不再包含该包，若未来重新出现仍按该地板检查。
  - `undici` → `7.29.0`；升级后的 `node-gyp 12.4.0` 另带来一份安全的 `undici 6.28.0`，两条已审阅 major 均纳入回归门。
- `koffi` 必须继续保持精确版本 `2.16.3`。
- 因 electron-builder 26.15.x 不再在无证书时自动为 ARM64/universal macOS 产物做 ad-hoc 签名，本 PR 应显式设置 `build.mac.identity: "-"`，把当前无 Developer ID 的发布策略固定为 x64/ARM64 均 ad-hoc 签名。
- 不使用 `npm audit fix`、`--force`、`overrides`，不删除 lockfile，不做 major upgrade。
- 安全修复和“允许发布”是两个门：audit 清零不能替代 Windows/macOS/Linux 真实打包验证。

当前最高项目级风险定为 **P1，而不是 P0**：`app-builder-lib <26.15.0` 会把不安全的搜索路径写入最终 AppImage 的 `AppRun`。其官方 CVSS 向量为 `AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`，利用要求本地低权限攻击者能向应用启动工作目录写入恶意动态库；它不是无需前提的远程接管或紧急全平台下架事件，但会阻断下一次 Linux AppImage 发布。

本计划只修依赖、由该升级直接引起的 macOS 签名确定性问题，以及相应验证门；不顺带重构业务代码，也不在本 PR 决定是否发布 `v0.14.x`。当前 `main` 已明显超过 `v0.14.0` 的范围；若以后决定做真正的 `v0.14.1`，应另行评估从 `v0.14.0` tag 建维护分支，而不是直接把当前 `main` 称为补丁版。

## 1. 已核实的风险模型

### 1.1 “12 high”不是 12 个独立漏洞

去重结果为 **14 个独立 GitHub Security Advisory：8 high + 6 moderate**。npm 报告的 12 个 high 是 package node 数，并将节点命中的最高严重度向上汇总：

- electron-builder 家族的 2 个真实 advisory 被多个中间包节点重复计数。
- `undici` 一个节点命中 5 个 advisory。
- `ip-address` 一个节点命中 3 个 advisory。
- `brace-expansion` 的多个物理版本命中 2 个 advisory。

计划验收应按 advisory 和实际依赖树判断，不能只比较 npm 顶层计数。

### 1.2 去重后的修复分组

| 分组 | Advisory | 当前情况 | 项目可达性/产物影响 | 安全地板 / 当前预期解析 | 项目级优先级 |
|---|---|---|---|---|---|
| AppImage | [GHSA-7g7r-gx96-252g](https://github.com/advisories/GHSA-7g7r-gx96-252g) | `app-builder-lib 26.8.1`，经直接 devDependency `electron-builder` 引入 | 构建期把脆弱 `AppRun` 固化进 AppImage；需要攻击者可写启动 cwd | `>=26.15.0` / `26.15.7` | **P1；阻断下一次 AppImage** |
| YAML | [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) | production `js-yaml 4.3.0` | 已进入 `app.asar`，updater 的 YAML 解析路径可达；攻击前提是控制 Release 元数据或 TLS 路径 | `4.3.1` / `4.3.1` | P2 |
| Electron | [GHSA-9f4c-93c8-jc8g](https://github.com/advisories/GHSA-9f4c-93c8-jc8g) | 直接 devDependency `electron 41.10.2` | Electron Framework 随应用发布，但仓库无命中条件所需的不可信 sandboxed iframe；当前不可达 | `>=41.10.4` / `41.10.4` | P3 |
| 凭据重定向 | [GHSA-p2f4-r6v6-j797](https://github.com/advisories/GHSA-p2f4-r6v6-j797) | 构建树 `builder-util-runtime 9.5.1`；production 副本已修复 | dev-only；本项目用 `--publish never`，不从该路径携带 GitLab/custom redirect 凭据发布 | `>=9.7.0` / `9.7.0` | P3 |
| Glob/ReDoS | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg), [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) | `brace-expansion` 多个 dev-only major | 不进应用，pattern 来自仓库受控构建配置 | `1.1.18` / `2.1.4` / `5.0.9` | P3 |
| IP 分类 | [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr), [GHSA-4xrf-jv44-h6hh](https://github.com/advisories/GHSA-4xrf-jv44-h6hh), [GHSA-22jq-vg5j-6vgg](https://github.com/advisories/GHSA-22jq-vg5j-6vgg) | `ip-address 10.2.0`，node-gyp/SOCKS 构建链 | dev-only，不进应用；本链路不依赖 advisory 涉及的 SSRF 安全分类结果 | `>=10.3.1` / `10.4.0` | P3 |
| HTTP client | [GHSA-4cwx-7wf7-3272](https://github.com/advisories/GHSA-4cwx-7wf7-3272), [GHSA-8xcm-r25x-g524](https://github.com/advisories/GHSA-8xcm-r25x-g524), [GHSA-m8rv-5g2x-5cg5](https://github.com/advisories/GHSA-m8rv-5g2x-5cg5), [GHSA-jr45-8vmc-qm54](https://github.com/advisories/GHSA-jr45-8vmc-qm54), [GHSA-v3r7-h72x-cjcm](https://github.com/advisories/GHSA-v3r7-h72x-cjcm) | `undici 7.28.0`，由 `@electron/get` 引入 | 只用于安装期下载 Electron，不进应用；项目未调用命中的 interceptor/Blob/cookie 路径 | `7.29.0` / `7.29.0` | P3 |

结论：**No P0 findings；存在一个 P1 发布目标 blocker。** 14 个 advisory 都已有同 major 修复版本，没有等待上游或长期接受风险的必要。

### 1.3 与 PR #810 的边界

PR #810 未修改 `package.json` 或 `package-lock.json`，也未引入新依赖。它新增的窗口没有 iframe，并显式拒绝新窗口和导航；当前 advisory 是既有依赖债务，不应归因给 PR #810。

## 2. 目标与非目标

### 2.1 目标

1. 将直接依赖安全地板写进 `package.json`，并让 `package-lock.json` 精确解析到本次经过选择的版本。
2. 对所有相关间接包做命名包定向刷新，清除每个脆弱物理副本，而不是依赖 npm 的偶然重解析。
3. 当前完整依赖树和 production-only 依赖树中的原 14 个 advisory 全部关闭；实施当天新增 advisory 另行分级。
4. 证明最终 AppImage 中的 `AppRun` 已消除空/相对搜索路径元素，而不是只证明 `node_modules` 里的生成器源码已更新。
5. 明确保持无 Developer ID 的 macOS 发布策略，并以最终产物 gate 确保 x64/ARM64 都得到 ad-hoc hardened-runtime 签名。
6. 证明 electron-builder 升级没有破坏五个常设 release targets：Windows x64、Windows ARM64、macOS x64、macOS ARM64、Linux x64。
7. 保持 Koffi 2.16.3、native pruning、ASAR integrity、updater metadata 和现有发布命名契约不变。
8. 增加离线、确定性的安全地板回归测试，防止未来 lockfile 回退到已知脆弱版本。

### 2.2 非目标

- 不修改业务功能、窗口安全模型、updater 行为或代理/网络配置。
- 不升级任何 major，不引入 `overrides`。
- 不引入 Developer ID 证书或 notarization；这些属于单独的签名发布策略变更。
- 不建立新的独立 `.blockmap` 发布契约或硬门；只保留并复核现有 updater metadata/校验契约。
- 不把上游 npm workspace 修复当作本仓库升级理由；本仓库当前不是 npm workspace。
- 不重新设计 CI 或发布流程，只增加与本次依赖修复直接相关的 gate。
- 不在本 PR 创建 tag、发布资产、修改已有 Release、发公告或下架 v0.14.0 AppImage。
- 不把 `npm audit` 结果当成真实平台运行证明。

## 3. 依赖、签名与 lockfile 契约

### 3.1 直接依赖

`package.json` 只提高两个直接 devDependency 的最低安全版本：

```json
{
  "devDependencies": {
    "electron": "^41.10.4",
    "electron-builder": "^26.15.7"
  }
}
```

caret 表示允许未来在同 major 内正常解析；本次 PR 的候选 `package-lock.json` 必须精确锁到 `electron 41.10.4` 和 `electron-builder 26.15.7`。永久回归测试检查安全地板和同 major，不把这两个本次解析结果永久写死为唯一允许版本。

选择 26.x 当前维护线版本，而不是只升到 advisory 下限 26.15.0，理由是：

- 26.15.0 已包含不可回避的 Go → TypeScript 模块收集/构建内部迁移，停在下限并不能避开主要回归面。
- [electron-builder 26.15.6](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder%4026.15.6) 修复 NSIS 在 x64/ARM64 上可靠安装主程序和 native binaries 的问题，直接关系本仓库多架构产物。
- 26.15.7 是当前 `v26` dist-tag 指向的版本；[26.15.7 release](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder%4026.15.7) 的 locale 修复因本仓库未配置 `electronLanguages` 而不是本项目特有理由，但选择 v26 线最新已发布版本可以避免停在已知落后 patch。

选择 [Electron 41.10.4](https://github.com/electron/electron/releases/tag/v41.10.4) 是为了关闭本 advisory 并保持 Electron 41.x，不改变 major。

### 3.2 macOS 签名策略

[electron-builder PR #9822](https://github.com/electron-userland/electron-builder/pull/9822) 移除了“无证书时仅 ARM64/universal 自动 ad-hoc 签名”的回退；在 26.15.x 中，不提供证书时默认跳过所有架构签名。无签名 ARM 应用仍可能由用户在 Privacy & Security 中手动批准后本地运行，因此不能绝对描述为“完全无法启动”，但失去 code seal、hardened-runtime 标志和既有 ARM64 行为仍是发布回归。

本 PR 的最小方案是在现有 `build.mac` 配置中显式加入：

```json
{
  "identity": "-"
}
```

契约如下：

- `identity: "-"` 表达 ad-hoc 签名意图；x64 会从当前的 unsigned 变为 ad-hoc，ARM64 则保持既有的 ad-hoc 意图。electron-builder 26.15.7 会先把该值作为证书名称 qualifier 做子串匹配，匹配不到时才构造 `"-"` ad-hoc identity，因此配置本身不能证明没有选中名称含连字符的证书。
- `.github/workflows/build.yml` 必须对两个最终 `.app` 检查 `Signature=adhoc`、`adhoc,runtime`、严格签名和 entitlement；这道产物 gate 才是本发布流程的确定性保证，任何意外证书签名都会阻止 build job 和后续 release job。
- 保留 electron-builder 默认 hardened runtime 和生成的 entitlement；不新增证书、keychain、notarization secret 或网络发布步骤。
- electron-builder 26.15.x 在 `identity: "-"` 与默认 hardened runtime 同时启用时会输出建议性告警，提示检查 `com.apple.security.cs.disable-library-validation`。本项目必须以最终 entitlement 和实际启动验证为准；该告警属于预期，**不得通过增加 `hardenedRuntime: false` 来消除**。
- 未来若引入 Developer ID，必须在单独变更中删除/覆盖此设置，并重新验证签名与 notarization，不能依赖当前 qualifier 的隐式匹配行为。
- 本次必须同时检查 x64 和 ARM64 的签名结构；只有 ARM64 可在当前硬件上提供真实启动/Koffi smoke，Intel 真机证据仍按可用性单独声明。

### 3.3 间接依赖

实施时必须逐项检查 lockfile 的所有物理副本，而不是只看顶层 `npm ls` 输出：

| 包 | 不允许残留 | 本轮当前预期解析 |
|---|---|---|
| `app-builder-lib` | `<26.15.0` | `26.15.7` |
| `builder-util-runtime` | 构建树中的 `<9.7.0` | `9.7.0` |
| `js-yaml` | `>=4.0.0 <4.3.1` | `4.3.1` |
| `brace-expansion` | `<1.1.18`、`>=2 <2.1.4`、`>=5 <5.0.9` | `1.1.18` / `2.1.4` / `5.0.9` |
| `ip-address` | 出现 `<10.3.1` 即失败；允许安全升级后不再存在 | 最终候选树中不存在 |
| `undici` | `>=6 <6.28.0`、`>=7 <7.29.0` | `6.28.0` / `7.29.0` |

`electron-builder 26.15.7` 当前依赖组合还预期解析为 `builder-util 26.15.3`、`electron-publish 26.15.3`、`dmg-builder 26.15.7`。这些是本次 lockfile 审阅证据，不是永久禁止后续同 major patch 的断言。

`koffi` 的 manifest 和 lockfile 必须继续精确为 `2.16.3`。

### 3.4 lockfile 更新方式

以下命令只在用户另行授权实施后运行，本轮修改计划时不得运行：

1. 从重新核实过的 exact HEAD 和干净工作区开始。
2. 手工修改两个直接版本地板和 `build.mac.identity`，再以禁用 scripts/audit 的 package-lock-only 方式生成候选 lockfile。
3. 无论初次解析看起来是否已清零，都执行一次命名包定向 refresh：

   ```bash
   npm update js-yaml undici ip-address brace-expansion --package-lock-only --ignore-scripts --no-audit
   ```

   npm 11 会更新命名包在树中的直接和间接副本，且该命令不会把它们写成新的直接依赖。
4. 不使用 `npm install <transitive>@<version>`；这种写法可能把间接包误写成直接依赖。
5. 不删除整个 lockfile、不使用 `--force`、不使用 `overrides` 掩盖上游约束。
6. 审核 lockfile diff，确认没有无关直接依赖、major、registry、integrity 或 package-manager 元数据漂移。
7. 用审阅后的 lockfile 做一次干净 `npm ci`，实际安装树必须与 lockfile 一致。

不能预先声称两个直接升级会自动清掉多少 advisory：例如现有 `brace-expansion 5.0.7` 仍满足新上游的 `^5.0.5`，不做定向刷新就可能保留。最终数量只能以生成后的全部物理副本和两种 audit 为证据。

## 4. 实施阶段

### Phase 0 — 重新锁定基线

- 核实 `HEAD`、branch、`git status`、`origin/main`。
- 记录 Node/npm 版本以及现有 `npm audit --json`、`npm audit --omit=dev --json`、`npm ls --all` 基线。
- 如果工作区不干净或 HEAD 漂移，停止并先重新评估；不要覆盖已有用户改动。

### Phase 1 — 最小 manifest/lockfile/签名配置变更

- 只提高 `electron`、`electron-builder` 两个直接地板，并显式设置 `build.mac.identity: "-"`。
- 生成候选 lockfile，执行第三节的强制命名包定向 refresh，再逐段评审 diff。
- 检查根 package entry 与 `package.json` 一致。
- 核实第三节列出的所有实际版本；任何旧物理副本都必须解释或清除。
- 确认 `koffi 2.16.3` 及其 target-native package layout 没有被顺带改动。
- PR diff 不得新增 `overrides`；这一条作为本次变更审阅规则，不做成永久禁止仓库未来使用 overrides 的测试。

### Phase 2 — 增加确定性安全回归门

建议新增两个窄验证器，避免安全保证完全依赖联网的 advisory 数据库。

#### 2A. `test/dependency-security-floor.test.js`

- 解析 `package.json` 和 `package-lock.json` 的 `packages` 表。
- 对两个直接依赖检查：manifest 最低版本不低于所选安全地板、仍在既定 major；lockfile 实际版本不低于 manifest 地板且仍在同 major。
- 遍历所有物理副本，按已审阅 major 白名单拒绝脆弱区间：
  - `js-yaml`: `{ 4: >=4.3.1 }`
  - `brace-expansion`: `{ 1: >=1.1.18, 2: >=2.1.4, 5: >=5.0.9 }`
  - `ip-address`: `{ 10: >=10.3.1 }`（允许该包不再存在）
  - `undici`: `{ 6: >=6.28.0, 7: >=7.29.0 }`
- 上述包出现未审阅 major 时 fail closed，要求人工确认后再更新白名单。
- 检查 `app-builder-lib >=26.15.0` 和构建树中 `builder-util-runtime >=9.7.0`，但不永久写死本次预期 patch。
- floor test 不实现任何 Koffi 版本或 integrity 断言，也不 `require` `test/koffi-lockfile.test.js`；Koffi 契约由该顶层测试文件独立注册和运行。
- 这是已知安全地板回归测试，不替代实时 `npm audit`。

#### 2B. `scripts/verify-appimage-apprun.js`

- 只在 Linux CI 的最终 `.AppImage` 生成后运行；检查最终 artifact，不检查 `node_modules/app-builder-lib` 生成器源码。
- 在临时目录中只提取 `AppRun`。首选 `<artifact> --appimage-extract AppRun`；该操作只执行 AppImage 的 ELF runtime stub 来完成临时提取，不得继续启动被提取的 `AppRun`。若 CI 环境不支持 AppImage 自提取，可用 `unsquashfs` 配合不执行 `AppRun` 的只读 offset 提取作为 fallback。
- **绝不 `source`、`eval`、执行 `AppRun` 或执行从中提取的赋值语句。** 产物内容一律作为不可信数据处理。
- 验证器不构建 shell AST，也不猜测函数、`trap` / `case` / `if` 的控制流；它保守扫描每一行，只允许从行首开始的精确 `export NAME="…"` 语句。shell 缩进不表示嵌套，因此任何以空格或 Tab 开头、但仍会执行的 `export` 都 fail closed；普通参数展开和 `LD_LIBRARY_PATH="" zenity …` 这类命令前缀赋值不计入 export 数量，也不触发四条 export 右值的语法拒绝。
- 对 `PATH`、`XDG_DATA_DIRS`、`LD_LIBRARY_PATH`、`GSETTINGS_SCHEMA_DIR` 各要求恰好一个顶层 export 赋值；缺失或重复都 fail closed。
- 额外断言：所有从行首开始的 export 变量集合必须恰好等于上述四项。出现第五个未审阅 export 时，无论右值是否含 `:` 都 fail closed，人工评估后才能扩充名单，不能因其不在既有名单中就默认安全。
- 有限静态语法白名单只适用于上述四条 export 的右值，只允许已审阅的 literal、`${APPDIR}` 和 `${VAR:+:${VAR}}` 形式；在这些右值中拒绝命令替换、反引号、控制运算符、重定向和任何未识别 shell 语法。
- 用验证器自己的字符串解释逻辑分别模拟继承变量未设置和设置为无害哨兵值的结果，不调用 shell。拒绝空的开头/结尾/连续 `:` 元素、相对 literal（如 `./share`），以及无条件继承变量展开造成的空路径元素。
- 允许并记录 26.15.7 已审阅模板的条件展开。以后上游更改语法时应主动失败，要求显式复审，而不是宽松放过。
- fixture 至少包含：真实 26.8.1 模板失败、真实 26.15.7 模板通过、`./share` 失败、双冒号失败、命令替换失败、重复顶层 export 失败、空格/Tab 缩进 export 失败、命令前缀 `LD_LIBRARY_PATH=""` 不计数、第五个 path-list export 和第五个无冒号 export 都失败。
- 输出 artifact SHA-256、AppRun SHA-256、四条规范化赋值及模拟结果，便于 CI 审阅。

将 AppRun gate 放在 `.github/workflows/build.yml` 的 Linux AppImage 构建后。现有失败产物上传使用 `if: always()`，应保留用于故障取证：gate 失败可以仍上传 CI artifact，但会让 Linux build job 失败，并通过 `release` job 的依赖关系阻止发布。在 `.github/workflows/wayland-smoke.yml` 中，将 gate 放在正常 artifact 上传和 smoke 之前，失败时不继续后续步骤。准确称呼它为 **release gate**，不是所有工作流中的绝对 upload gate。

### Phase 3 — 安装树与 audit 验证

用已审阅 lockfile 干净安装后执行并保存结果：

```bash
npm ci
npm ls --all
npm audit --json
npm audit --omit=dev --json
npm run verify:electron
```

验收要求：

- `npm ls --all` 无 invalid/extraneous/missing。
- 原 14 个 advisory 在完整和 production-only audit 中全部关闭。
- 目标是在实施当日两种 audit 都为 0；若期间出现新 advisory，必须独立去重和分级。P0/P1 且与发布产物相关的项目可阻断本 PR；较低、dev-only 或不可达项目可以建独立 follow-up，不能为追求数字清零盲目扩大本 PR，也不能无解释忽略。
- 本次 lockfile 证据应显示 Electron 41.10.4、electron-builder/app-builder-lib 26.15.7，以及第三节记录的预期间接版本；永久测试只执行安全地板/major 契约。
- 实际 Koffi 仍为 2.16.3。

### Phase 4 — 代码、配置与既有 package contract 回归

先跑窄测试，再跑全套：

```bash
node --test test/dependency-security-floor.test.js
node --test test/package-build-config.test.js
node --test test/koffi-lockfile.test.js
npm test
```

还必须运行仓库已有的 Electron install、native target、package native inventory、updater metadata、ASAR integrity 和 `scripts/assert-no-retired-telegram-sidecar.js` 相关验证。该 retired-sidecar 检查现已覆盖三个 build jobs、独立 package audit workflow 和 Wayland 路径；升级后应保留此覆盖，但不把上游 workspace PR 当成本仓库的直接适用依据。

任何测试如果只检查配置或 fixture，报告中必须明确它没有替代真实安装包验证。

### Phase 5 — 五目标真实打包矩阵

electron-builder 26.15.x 同时包含模块收集、Windows package-manager 调用、macOS 签名和 Linux AppImage 生成路径的内部变化，因此合并前的硬门是实际打包。

| 平台/目标 | 必须验证 | 允许保留的边界 |
|---|---|---|
| Windows x64 | `--publish never` 构建；native inventory；Koffi packaged smoke；NSIS 实际安装/启动；`clawd://` 注册 smoke；updater metadata；`app.asar`/unpacked 模块清单 | 必须有真实 x64 Windows 证据 |
| Windows ARM64 | `--publish never` 构建；架构命名；native inventory；唯一 ARM64 `koffi.node`；NSIS 结构与 metadata | 若无 ARM64 真机，只能声明结构验证，不能声称运行通过 |
| macOS ARM64 | 项目常规 DMG/zip target；ad-hoc/hardened 签名与 entitlement；ASAR integrity；native inventory；Koffi packaged smoke；实际启动；`clawd://` 安装后 smoke；metadata | 当前 Mac 可提供 ARM64 运行证据 |
| macOS x64 | x64 产物；ad-hoc/hardened 签名与 entitlement；native inventory；唯一 x64 `koffi.node`；DMG/metadata/ASAR integrity | 若未在 Intel Mac 运行，只能声明结构验证 |
| Linux x64 | AppImage + deb；最终 AppRun gate；在 disposable 环境实际安装/启动 `.deb`；native inventory；Koffi smoke；updater metadata；XWayland smoke 和现有 native-Wayland contract | CI/XWayland 不等同真实桌面环境全量手测 |

macOS 两个架构都必须执行并保存：

- `codesign -dv --verbose=4`：报告 `Signature=adhoc`，flags 含 `runtime`。
- `codesign --verify --deep --strict`：通过。
- entitlement 至少保留 `com.apple.security.cs.allow-jit`、`com.apple.security.cs.allow-unsigned-executable-memory`、`com.apple.security.cs.disable-library-validation`。
- ARM64 运行现有 packaged Koffi smoke；x64 若无 Intel 机器，只报告结构签名验证。

所有平台还需抽查：

- 打包应用的 Electron runtime 是本次 lockfile 选择的 41.10.4。
- `app.asar` 中 production `js-yaml` 是 4.3.1。
- dev-only 的 `brace-expansion`、`ip-address`、`undici` 不进入运行时应用。
- 每个 target 只保留目标架构的一个 `koffi.node`。
- `afterPack` 仍只裁剪 `app.asar.unpacked` 的物理文件，不重写 `app.asar`。
- 保留现有 updater metadata 校验，包括 artifact `sha512`/size 和 AppImage `blockMapSize`；不新增独立 blockmap 发布硬门。

### Phase 6 — `elevate.exe` provenance 专项门

`scripts/native-package-policy.json` 中的 `electron-builder 26.8.1` 目前只是 exception 的 `reason` 文本，不参与匹配；真正匹配依据是 target/path/format/architecture。

因此：

1. 不随版本号机械修改 `reason`。
2. 先完成 26.15.7 的真实 Windows x64 和 ARM64 打包。
3. 如果 `resources/elevate.exe` 仍存在，检查 `dist/native-package-manifests/windows-{x64,arm64}.json`，确认其来源、PE 格式和 ia32 架构仍符合 electron-builder 管理 helper 的既有例外，再更新 `reason` 的版本文本。
4. 如果 helper 已消失，删除这条已失效例外，不能保留死规则。
5. 如果 helper 的格式、架构或来源改变，保持 fail-closed；重新论证例外，不能只改 JSON 让 audit 通过。

执行证据（GitHub Actions `31364225508`）：electron-builder 26.15.7 的真实 Windows x64 / ARM64 打包均仍产出唯一的 `resources/elevate.exe` 例外；两份 manifest 都记录为 PE ia32、107,520 bytes、SHA-256 `9b1fbf0c11c520ae714af8aa9af12cfd48503eedecd7398d8992ee94d1b4dc37`，且无其他未声明例外。已据此把 policy 的 provenance 版本说明更新为 26.15.7，target/path/format/architecture 匹配条件保持不变。

### Phase 7 — 最终复核与交付边界

- 重新核对 exact HEAD/diff，确保只有计划内文件。
- 复跑完整测试、两种 audit 和实际依赖树检查。
- 汇总五目标证据，明确结构验证与真机运行验证的区别。
- 做一次独立 post-fix 安全审查，重点复核最终 AppImage、macOS 签名和各平台打包内容。
- 实施、commit、push、PR、merge、release/tag/资产处理分别等待授权；不得把本计划视为后续写操作的预授权。
- 依赖 PR 处理完成后，记录 `v0.14.0` 旧 AppImage 风险的明确 follow-up；创建 Issue、公开说明或修改 Release 仍需单独授权。

## 5. 验收标准

只有同时满足以下条件，修复 PR 才可判定 ready：

1. `package.json` 的 Electron/electron-builder 安全地板正确，本次 lockfile 精确解析到 41.10.4/26.15.7。
2. 第三节列出的脆弱间接版本在所有 lockfile 物理副本中均不存在，且执行过强制命名包定向 refresh。
3. `koffi` manifest、lockfile、打包产物都保持 2.16.3 和单目标架构契约。
4. 原 14 个 advisory 全部关闭；实施日新增 advisory 已独立分级并有明确处置。
5. 最终 AppImage 的 `AppRun` 通过 fail-closed 静态检查；验证器没有执行任何产物 shell；gate 能阻止 release job。
6. macOS 最终 x64/ARM64 产物均通过 ad-hoc hardened-runtime 签名、entitlement 和严格验证 gate；没有引入 Developer ID/notarization。
7. Windows x64/ARM64、macOS x64/ARM64、Linux x64 五个 release targets 均完成最低证据矩阵。
8. Windows module collection、Koffi pruning、`elevate.exe` provenance、macOS ASAR integrity、Linux AppImage/deb、updater metadata 均无回归。
9. `scripts/native-package-policy.json` 如有更新，必须由真实 Windows manifest 证据支持；helper 消失时必须删除死例外。
10. PR 不包含业务功能、无关依赖、代理配置、Release/tag、既有资产或新 blockmap 发布契约变更。

## 6. 失败处理与回滚原则

- 如果 electron-builder 26.15.7 破坏某一发布目标，先定位同 major 回归；不得降回 `<26.15.0` 后继续发布 AppImage。
- 如果只能让其他平台通过，可暂时阻止 AppImage target，但这属于发布范围变更，需单独决定，不能在依赖 PR 中静默发生。
- 如果显式 ad-hoc 签名不能在某一 macOS target 维持既有运行契约，先阻止该 target，不能静默发布 unsigned ARM64 应用。
- 如果 lockfile 出现大量无关漂移，重新从干净基线做定向解析，不接受“audit 变绿即可”。
- 如果新的 audit 项在实施期间出现，按新 advisory 单独分级；不能无上限扩张本 PR，也不能未经记录接受风险。
- 回滚只撤销本轮候选改动，保留用户或并行工作的现有文件。

## 7. 为什么不使用 `npm audit fix`

根据 [npm audit 官方文档](https://docs.npmjs.com/cli/v11/commands/npm-audit)，`npm audit fix` 底层执行完整 install，会改依赖树和 lockfile，并运行适用的 lifecycle/install 行为。本仓库还会触发 Electron 下载和 postinstall 验证。

本轮不使用它，原因不是“它一定会 major upgrade”，而是：

- 它无法表达本项目对两个直接安全地板、macOS 签名策略和特定间接包物理副本的明确决策。
- 它会把 electron-builder 的大型内部迁移和多组间接升级合成一次不透明解析，降低 diff 可审计性。
- `npm audit fix --omit=dev` 会漏掉真正污染 AppImage 的 dev 构建依赖，也会漏掉随产物发布的 Electron runtime。
- 本轮所有依赖修复都能通过显式同 major 版本选择和受控命名包 lock refresh 完成，不需要 `--force`。

`npm audit fix --dry-run` 也不是必要验收项；最终应以 manifest/lockfile diff、实际依赖树、最终安装包和真实平台证据为准。

## 8. 发布决策边界

依赖 PR 合并后，是否立即发版仍需单独决定：

- 下一次包含 AppImage 的发布必须先完成本修复。
- 已发布 v0.14.0 AppImage 高置信度继承旧生成器缺陷，但尚未逐字节下载、提取并核对公开资产；现有证据来自 tag lockfile、无条件生成路径和 CI `npm ci`。
- 该问题要求攻击者能写入启动 cwd，不建议仅凭 advisory 标签将其描述成无需前提的远程 RCE，也不自动触发全平台紧急下架。
- 当前 `main` 已包含 v0.14.0 之后的大量功能，不能直接将 main 的下一版叫作 v0.14.1。真正 hotfix 需要维护分支、最小 backport、完整打包和独立授权。
- Release note、用户提醒、旧资产处理和版本号选择都不属于本修复 PR；但合并后不能遗忘，应建立明确 follow-up。

## 9. 静态审查无法单独证明的边界

即使依赖和测试全部完成，以下内容仍必须在报告中保留限定：

1. 未下载并逐字节检查的公开 v0.14.0 AppImage，只能高置信度推断受影响，不能声称已直接解包验证。
2. 静态 `AppRun` 检查能证明本 advisory 的四个已知路径赋值已按受限语法安全生成，但不能证明 Linux 所有动态加载行为都无风险。
3. CI 构建成功不能证明 Windows ARM64、Intel Mac 或各种 Linux 桌面环境的真实启动体验；没有真机就必须明确写“结构验证”。
4. ARM64 Mac 的运行证据不能替代 Intel Mac；同样，Windows x64 不能替代 Windows ARM64 运行证明。
5. `npm audit` 只覆盖其数据库和 npm 依赖图，不能覆盖未知漏洞、Electron 二进制全部风险、构建器生成物或业务逻辑漏洞。
6. dependency floor test 只防止已知脆弱版本回退，不能替代联网复审；未审阅 major 只能 fail closed，不能自动判安全。
7. js-yaml updater 路径的利用需要外部信任边界被突破；除非构造隔离测试，否则静态审查不能量化真实卡顿时长。
8. Electron 41.10.2 advisory 当前不可达的结论依赖现有窗口/iframe 模型；未来新增不可信嵌入内容时仍需重新威胁建模。
9. electron-builder 26.15.7 的 Windows 模块收集、签名和安装行为必须靠实际产物验证，不能只引用 changelog。
10. ad-hoc 签名不提供 Developer ID 身份、notarization 或 Gatekeeper 信任；`identity: "-"` 只表达配置意图，真正的发布保证来自最终 `.app` 的签名 gate。
11. electron-builder 26.15.7 的 7zip 工具在 npm 安装树之外按平台下载，因此不受 lockfile 或 `npm audit` 覆盖；当前 app-builder-lib 将其固定为 `7zip@1.0.0` 并校验平台对应 SHA-256，但这仍是上游构建工具供应链边界。
12. AppImage runtime 自提取失败时，`unsquashfs` fallback 会按 SquashFS magic offset 尝试提取；当前真实产物只有一个 offset 能成功提取 `AppRun`，但静态审查没有证明恶意双 SquashFS/诱饵布局不可构造。
13. electron-builder 26.15.7 新增的 `desktopName is not set` 建议性告警没有在本安全 PR 中通过盲设配置消除；现有 Wayland CI 通过也不能替代真实 Linux 桌面集成验证。
14. `.deb` disposable-environment smoke、XWayland smoke 和 AppImage 静态 gate 仍不能覆盖所有发行版、桌面环境、挂载选项和用户启动目录。

## 10. 预计文件范围与计划文档状态

实施后的合理 diff 应限于：

- `package.json`（两个直接依赖地板和 `build.mac.identity: "-"`）
- `package-lock.json`
- `test/dependency-security-floor.test.js`
- AppImage verifier 及其 fixture/test
- `scripts/after-pack-koffi.js` / `test/after-pack-koffi.test.js`（真实 CI 暴露 `/var` alias 与 Windows 短路径误报时，仅统一使用已校验的 canonical root，不放宽目录逃逸检查）
- `.github/workflows/build.yml`
- `.github/workflows/wayland-smoke.yml`
- 有真实 Windows 证据时才更新 `scripts/native-package-policy.json`
- 本计划与必要的安全验证说明文档

如果实际修复需要超出该范围，应先说明原因和回归面，再决定是否继续。

本计划已通过精确 `.gitignore` 例外纳入本修复分支，普通 `git status` 可见；关键安全门和实施边界不会只存在于维护者本机。
