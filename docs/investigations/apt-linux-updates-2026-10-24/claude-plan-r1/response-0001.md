# 审查结论：APT 软件源与 Linux 更新迁移计划（基线 `6573eab7`）

**审查对象**：`docs/plans/2026-10-24-apt-linux-updates.md` 初版（SHA-256 `5459e4ac…6e296`），应用基线 `6573eab7`。补充证据是 `docs/investigations/apt-linux-updates-2026-10-24/pre-review-validation.md`。两个哈希都取自委托上下文和预验证记录，我没有自己重算。

全程只读：没有编辑文件、没有运行命令、没有发评论。上轮被中断的 apt_preferences 手册检索没有拿到结果，涉及 pin 优先级合并的地方标为"实现时验证"。

## 结论

**修订计划后可以开工，不需要再调研。** 计划有 4 处条款和仓库已有证据或 dpkg/GitHub 的实际语义冲突，照原文实现会做错（下面 B1–B4），先改进计划再写代码。

云宝的四个方向：

1. **方向 1（conffile 方案）：采纳。** 预验证第 32–48 行的证据充分，补充见 B1。
2. **方向 2（无密钥 dispatcher）：采纳，这是最小的正确修正。** "只 checkout main 不等于用 main 的 workflow"这个判断是对的，见 B2。
3. **方向 3（旧用户走独立指南）：方向对但不完整。** 旧用户不会自己找到指南，需要补触达渠道和上线顺序，见 B4。
4. **方向 4（Pages 容量与 by-hash）：采纳。** 需要补几条强制条件，见约束 6、7。

## 一、阻止开工的问题与最小修正

### B1. bootstrap 的 remove 语义自相矛盾（阻塞第 2 步）

**证据**：
- 计划第 23 行要求"remove/purge 后不留下引用已删除公钥的启用源"，但没给出机制。
- Debian wiki 的常规布局是：公钥放 `/usr/share/keyrings`，不是 conffile；`.sources` 放在 `/etc` 下，是 conffile。
- 按 dpkg(1)，`--remove` 保留 conffile、删除其余文件。所以按常规布局，`apt remove` 之后正好是"源还在、公钥没了"，之后每次 `apt update` 都报错。
- 预验证第 32–36 行证明：三类文件都登记为 conffile 时，remove 全部保留，purge 全部删除。

**最小修正**：采纳方向 1，并把计划措辞改准：
- remove 之后源**仍然启用、仍然受信任**（包处于 rc 状态，此后收不到公钥更新）。
- 只有 `apt purge clawd-apt-source` 才算移除源。
- `.sources` 和 `.pref` 的模板跨版本冻结，只有公钥文件随版本变化，避免用户改过的文件在升级时弹 conffile 提示。
- 在计划里记录"偏离 wiki 推荐的 `/usr/share/keyrings` 位置"这个决定和理由。

### B2. 发布信任边界与 release 触发冲突（阻塞第 4 步和一切生产配置）

**证据**：
- 计划第 36 行写"workflow 代码来自默认分支 + 受保护 environment"。
- 但 `docs/project/release-process.md:488-491` 已经记录：release 事件读取的是 tag 上的 workflow 定义。
- `.github/workflows/winget.yml:103-110` 只是把工具 checkout 到默认分支，YAML 本身仍来自 tag。
- `release-process.md:618-620` 因此要求 winget 的环境规则"兼容 release tag"。

**后果**：环境只允许 main，就会拒绝 tag ref 的部署；放宽到允许 tag，tag 提交里的任意 YAML 就能拿到生产私钥。

**最小修正**：
- **dispatcher**：
  - 用 `release: types: [released]` 触发（同 `winget.yml:33-34`）。
  - 权限只有 `actions: write`；不 checkout、不读 secret、不传任何可信数据，只请求 main 上的发布 workflow。
- **发布 workflow**：
  - 由 `workflow_dispatch` 触发，设 concurrency 组，`cancel-in-progress: false`。
  - 签名 job 和 Pages 部署 job 的 environment 都只允许 main。
  - 发布目标一律由 API 重新计算。
- **维护文档写明三点**：
  - dispatcher 必须在打 tag 之前进入 main。
  - dispatcher 失败时用手动 dispatch 补发。
  - 这道边界以 main 的分支保护为前提。
- **实测一项**：GitHub 文档把 GITHUB_TOKEN 触发 `workflow_dispatch` 列为会产生新 run 的例外，首次 dry-run 时实际确认一次。

### B3. 安装格式判定规则与仓库已有证据规则冲突（阻塞第 3 步）

**证据**：
- `hooks/install.js:578-584` 明确写：继承来的 `APPIMAGE`/`APPDIR` 不能证明当前进程是 Clawd 的 AppImage。`test/claude-appimage-hooks.test.js:152` 和 `:502` 覆盖了这个场景。
- `src/updater.js:945` 的 `autoUpdater` getter 会根据同一个 `package-type` marker 自己挑更新器。
- `scripts/prepare-appimage-launcher.js:44-51` 往共享的 `appOutDir` 写文件，`release-process.md:185` 要求检查 deb 里的 AppRun。两者说明 AppImage 和 deb 是从同一个 `linux-unpacked` 打出来的。

**风险**：
- **(a) 外来 APPIMAGE 被误判。** 计划第 29 行"有 APPIMAGE 且无 marker → AppImage"，会把继承了别人 APPIMAGE 的未知格式判成 AppImage。AppImageUpdater 安装时会删除并替换 `APPIMAGE` 指向的那个文件，可能毁掉别的应用。此行为需实现时对照锁定的 6.8.9 源码确认。
- **(b) marker 可能漏进 AppImage。** deb target 把 marker 写进共享的 resources，它是否会进入 AppImage 尚未验证。如果会，"marker 优先"会把 AppImage 用户送去 APT，而 getter 本身也会给 AppImage 构造 DebUpdater。

**最小修正**：
- **判定顺序改为三步**：
  1. `APPIMAGE` 是绝对路径、`APPDIR` 是绝对路径且包含 `process.resourcesPath`，判为 AppImage。显式构造 AppImageUpdater，不走 getter（需确认 6.8.9 导出了这个类）。
  2. `resources/package-type` 内容是 `deb`，走 APT 路径。
  3. 其他情况一律走手动兜底：打开固定指南或 Releases 页。
- **加 CI 产物断言**：解包后的 AppImage 里没有这个 marker；deb 的数据部分里有，且内容为 `deb`。

### B4. 旧用户迁移缺少触达渠道（核心目标；阻塞交付与验收）

**证据**：
- 旧版代码已经冻结、无法修改。基线 `src/updater.js:908-914` 中，通知的主按钮会走回 electron-updater 下载。
- 出错时的气泡只有"复制错误"和"关闭"两个按钮（`:619-622`），没有指南链接。
- `docs/guides/setup-guide.md:337` 和 `docs/guides/known-limitations.md:70`（及其中文版）还写着"Linux 包不自动更新"，与当前代码和计划都不符。
- 六个 README 的安装行（`README.md:43`）只写了 `.deb`。

**最小修正**：
- **交付清单**：
  - 首个相关版本的 release note（`build.yml:553`）。
  - 六个 README。
  - setup-guide 和 known-limitations（中英）。
  - `agent-runtime-architecture.md:927-934` 中补上 Linux 路由说明。
  - #1221 的回复属于对外动作，由维护者确认后再发。
- **上线顺序**：先手动 dispatch，只发布现有的包（如 1.4.0）和指南；验收通过后，再发布引用指南的新版本。这样旧用户现在就能迁移。
- **明确决定继续在 `latest-linux.yml` 里保留 deb**（这也是 `scripts/verify-updater-metadata.js:114-118` 的现行合约）。这样 pkexec 能用的旧用户仍能自举到新版本。
- **指南提示**：旧版如果已经下载过更新，退出时可能弹授权框（`updater.js:947`）；取消后改用 APT 即可。

## 二、必要的实现与验证约束

1. **`.gitignore` 白名单**：`.gitignore:19` 是 `docs/**`，`:123` 是 `scripts/*`。新增的文档、脚本和站点源码都必须加白名单，否则会被静默漏提交（`release-process.md:8-11` 记录过这类事故）。计划文件和预验证记录目前也在忽略范围内，要决定是否随 PR 提交。
2. **deb 路由测试**：deb 路由下，所有入口对 `autoUpdaterFactory` 的调用次数必须为 0。需要覆盖：
   - 启动：`main.js:6143` → `updater.js:1323`
   - 托盘菜单：`:1599-1607`
   - About 页的按钮和提示：`settings-tab-about.js:415-417, 447-457`
   - 定时通知的主按钮：`:908-914`
   - ready 状态下的安装请求：`:1604-1605`

   另外几点：
   - deb 路由下替换 "Download and install now?" 文案，七种语言都要改。
   - 打开指南后要清掉 `activeCheck`，否则托盘菜单会一直灰掉（`:1451, 1600-1603`）。
   - pending 状态靠重启后的 `reconcilePendingOnStartup` 清除（`:468-482`）。
3. **运行中升级**：指南和通知文案要写"先退出 Clawd → 执行 APT 命令 → 重新打开"。APT 会在应用运行时直接替换磁盘文件，其中包括 asarUnpack 出来的 hooks、agents、themes（`package.json:186-194`）。
4. **Pin**：
   - 写法：`Pin: origin "rullerzhou-afk.github.io"`。wiki 要求用用户可控的标签，不能用 Release 文件里的字段。
   - 优先级：`Package: *` 设负值或 1；两个白名单包设 100 或 500，不得 ≥1000。
   - 范围：在文档中注明 pin 作用于整个主机名，不只是 `/clawd-on-desk/apt` 这一路径。
   - 测试：在测试源里放一个版本更高的发行版同名包，断言它装不上。具体优先级怎么合并，以这个测试的结果为准。
5. **Release 元数据**：
   - 首次发布后冻结 Origin、Label、Suite、Codename。改动这些字段会要求用户显式确认，需在测试中覆盖。
   - 开启 `Acquire-By-Hash`。
   - `.sources` 写 `Architectures: amd64`；`all` 架构的 bootstrap 包要出现在 `binary-amd64/Packages` 里。
   - 部署前，用 bootstrap 包实际随附的那份 keyring 字节跑 `gpgv` 验签。
6. **发布完整性**：
   - digest 改为必须匹配，删掉 "when present" 的放行条件。
   - 上一代的 by-hash 文件要先用生产公钥验过上一份 InRelease、再核对哈希，才能复用。
   - 同一个（包名、版本、架构）一旦发布，哈希不可再变。
   - "最新"按严格数字版本给已发布的正式版排序，不用 GitHub 的 latest 标记。
   - 新的最高版本低于线上最高版本时默认失败，除非显式给出回滚输入。
   - bootstrap 包要么可复现构建，要么内容一改就升版本。
7. **容量**：
   - GitHub Pages 有约 100 GB/月的软带宽上限，约等于 900 次整包下载（数值以计划引用的 limits 页面为准，我本轮没有重抓）。把它写进残余风险，并附迁移预案。
   - 部署耗时和 CDN 缓存 TTL 在 dry-run 中实测。
8. **密钥与支持范围**：
   - 生产密钥用 RSA ≥3072 或 Ed25519，在支持范围内最老和最新的 APT 上确认没有弱算法告警。
   - CI 只把签名子密钥导入临时 GNUPGHOME。
   - 计划要写明最低支持的发行版矩阵，CI 镜像和公钥格式都按它来选。
9. **部署前确认自定义域名**：确认该账号的用户站点没有配置自定义域名。如果配置了，github.io 上的项目 URL 会被重定向，固定 URL、pin 主机名，以及"clawdondesk.com 不受影响"的前提都会随之改变。计划目前只确认了仓库 Pages 返回 404。

## 三、剩余真机与线上验证（单元测试、容器测试替代不了）

- **真实安装升级**：在 amd64 真 root 环境下，用真实的 1.3/1.4 deb 经 APT 升级，覆盖维护脚本、chrome-sandbox 权限和 AppArmor，并确认用户 profile 保留。
- **补齐预验证**：预验证是在 aarch64、`--root`、加 force 参数、只覆盖源和公钥的条件下做的，需要补：
  - `.pref` 纳入同一生命周期测试；
  - remove 之后 `apt update` 仍然成功；
  - 不带 force 参数的交互升级不出现 conffile 提示。
- **运行中升级**：Clawd 正在运行时被升级的实际表现。
- **真实 Pages 环境**：https、CDN 新旧版本过渡、整站替换。
- **触发链路**：dispatcher 确实能触发 main 上的 run，且只允许 main 的环境确实拒绝 tag ref。
- **AppImage**：应用内更新全链路（下载、Restart Now、Later）仍然正常，且产物里确实没有 marker。
- **GUI 文案**：托盘、About、静默模式下的文案，七种语言。
- **多架构主机**：启用了 i386 外部架构的主机上不出现 notice。