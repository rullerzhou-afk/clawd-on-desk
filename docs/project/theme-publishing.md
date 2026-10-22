# 主题收录与发布

这是维护者的操作说明，保存在 `clawd-on-desk` 主仓库。投稿与讨论也在主仓库；本页提到的 manifest、打包脚本、Release 与 catalog 操作属于 [`clawd-themes`](https://github.com/rullerzhou-afk/clawd-themes) 分发仓库；设置页标识和离线快照属于主仓库。作者从[贡献指南](../guides/contributing-themes.zh-CN.md)和投稿 Issue 开始；发布之前，先完成素材、体验与许可审查。收到投稿或合并说明文件，不等于主题已进入应用下载列表。

## 主题上架与应用发版分开进行

投稿、审核、主题包发布和 catalog 更新均不需要等待 `clawd-on-desk` 发布新版本。发布工具支持已合并到 `clawd-themes` 后，即可按本页流程收录审核通过的作品。目录刷新后，已经支持主题下载、且满足主题 `minAppVersion` 的现有应用可以获取并安装新主题。

「社区主题」分组、社区角标和卡片作者署名需要随应用发版才生效；旧版应用仍可下载兼容的社区作品，并沿用「官方主题」的显示方式。不要因客户端标签尚未更新而推迟兼容主题的上架。

| 项目 | 发布约定 |
| --- | --- |
| 源码记录 | `source.repository` 只接受 `rullerzhou-afk` 账号下的仓库，包括保留的作者仓库 fork；`source.commit` 固定为 40 位小写 SHA。`source.path` 为仓库内相对目录，根目录写空字符串；禁止绝对路径、反斜杠、空段和 `.` / `..` 段。每次完整校验仍逐文件核对来源 |
| 社区署名 | manifest 与 catalog 同时写 `category: "community"` 和 `author`，两者必须一致。作者为 1–160 字符的单行文本，无首尾空格。旧条目省略 category 时按 official 处理，不改两套现有主题的身份 |
| 展示页 | 选填；省略整个 `showcase` 字段即可。提供时仍只接受 `https://<id>-art.pages.dev/progress/`，不接受 null 或任意外部链接 |
| 应用显示 | 包含本次支持的应用在「社区主题」分组显示「社区」角标和作者，安装后保留这些信息。已发布的旧版应用会继续显示「官方」；提高 minAppVersion 只能限制安装，不能改变旧版标签 |
| 主题包内容 | 打包器仅收集 `theme.json`、`assets/`，再加入分发仓库的 `README.md` 和 `LICENSE`。独立 `sounds/` 等目录不会被打包，必须先解决兼容或与作者确认删去相关能力 |
| 下载地址 | 主题包与预览图仍必须是 `clawd-themes` 的固定版本 Release asset；来源仓库与作品分类均不扩大应用的下载地址或运行权限 |

兼容策略允许旧版应用继续显示「官方」，作品作者与许可不变。新版本安装的社区标记会保存在安装记录中，断网或条目撤下后仍可显示。旧版安装记录自身没有社区信息：新目录仍包含该条目时可补全显示；条目撤下后，这类历史记录仍按旧默认分类显示。

## 审阅与固定交付内容

在 Issue 中确认主题 ID、作者署名、设计差异、状态覆盖、许可、实际测试结果，以及后续维护方式。同角色新造型使用新 ID；已有主题的升级沿用原 ID 并增加版本。

取得包含实际 `theme.json` 与全部图片的固定源码提交。完整下载校验会从 GitHub 的原始文件地址读取该提交下的每个资源并逐一核对；Git LFS 指针、临时网盘链接或只有成品 ZIP 的来源不能直接通过这个流程。作者的源文件、许可范围和交付方式需要先谈清楚。

先把已审阅的作者仓库 fork 到 `rullerzhou-afk` 账号，保留公开访问；审核通过不自动授权改作者仓库。确认 fork 中包含实际审核的提交，而非仅有默认分支：在该 fork 为每个发布提交保留一个不移动、不删除的标签或分支，例如 `clawd-source/<id>/v<version>`。不要只记录一个可能失去引用的 SHA，也不要跟随上游改写这些保留引用。

manifest 的 `source.repository` 指向保留的 fork，`source.commit` 指向审核过的同一提交，`source.path` 指向其实际主题目录（仓库根目录为 `""`）。发布前以未登录方式核对该提交下的 `theme.json` 和全部资源可读取；完整 `--download` 校验会再次核对字节数与 SHA-256。作者删库或改写历史后，保留来源仍需可用，否则每次校验全部 catalog 时都可能被阻塞。没有可 fork 的作者仓库时，先与作者商定并建立可追溯的公开来源，再发布。

`clawd-themes` 保留：

```text
themes/<id>/manifest.json
themes/<id>/README.md
themes/<id>/LICENSE
themes/<id>/preview.webp
```

manifest 可参考[现有记录](https://github.com/rullerzhou-afk/clawd-themes/blob/main/themes/whale-chan/manifest.json)的结构，但所有值都必须来自新主题：`id`、`version`、中英文名称与简介、`minAppVersion`、`assetCount`、`source`、`license`，社区作品另写 `category: "community"` 与真实 `author`。不要沿用已有角色的作者或许可。

- `assetCount` 是 `assets/` 内实际文件数，不是状态数或动画帧数。
- `theme.json.version` 必须等于 manifest 的版本，`theme.json.license` 必须等于 `manifest.license.themeJson`。
- 包中所有素材都应被配置引用；发布校验会拒绝缺失文件和未引用文件。
- 预览图是实际 WebP，最大 1 MiB；先在浅色与深色背景上检查。
- 打包上限：ZIP 与展开内容各 256 MiB，单文件 48 MiB，最多 256 个 ZIP 条目（包含目录）。这些上限不等于推荐大小。
- 独立运行主仓库的主题校验，再实际打开主题核对动画和交互。打包校验不检查全部运行时 schema，也不证明视觉体验合格。

## 打包与核对

只有来源与能力限制已解决，才执行以下步骤。使用 Node.js 24（与 `clawd-themes` CI 一致），在 `clawd-themes` 根目录运行；将示例 ID、路径与版本替换为实际值：

```sh
node scripts/build-theme-package.js --source "/absolute/path/to/my-theme" --manifest themes/my-theme/manifest.json --output dist
node scripts/verify-theme-release.js --archive dist/my-theme-1.0.0.clawd-theme.zip --manifest themes/my-theme/manifest.json
```

源目录名可以与主题 ID 不同；包内顶层目录始终使用 manifest 的 ID。构建生成 ZIP、SHA-256 文件和 metadata JSON，后者包含准确的包大小、展开大小与哈希。正式包由维护者从审查过的来源构建；不要直接把一个未经核对的投稿 ZIP 改名上架。

检查 ZIP 内的 `README.md` 与 `LICENSE` 确实来自 `clawd-themes` 中 `themes/<id>/` 下的已审阅文件。冻结这些内容后再发布；它们改变也需要重新构建，已发布的版本不可原地覆盖。

## 发布后再加入目录

1. 合并审阅过的主题 metadata 文件，记录包含 `themes/<id>/LICENSE` 的实际提交 SHA。此时先不改 catalog。
2. 准备版本标签 `<id>-v<version>` 的草稿 Release，上传 `<id>-<version>.clawd-theme.zip`，以及内容与 `themes/<id>/preview.webp` 一致的 `<id>-<version>.preview.webp`。保留构建输出供核对。
3. 核对附件后发布 Release。草稿附件不能供未登录用户或目录 CI 下载，因此正式 catalog 必须等公开下载可用后再提交。
4. 添加或更新 `catalog-v1.json` 的主题条目。archive 大小与 SHA-256 取自实际构建结果；preview 大小与 SHA-256 取自上传的那份预览图。社区条目的 category 和 author 必须与 manifest 一致。有展示页再填写符合规则的链接；许可链接固定到第 1 步的提交：`https://github.com/rullerzhou-afk/clawd-themes/blob/<commit>/themes/<id>/LICENSE`。
5. 将 `catalogVersion` 增加到大于当前 main 的值。任何 catalog 内容变化都必须递增，包括纠错或移除条目。
6. 运行以下检查：

```sh
npm test
node scripts/verify-theme-release.js --catalog catalog-v1.json
node scripts/verify-theme-release.js --catalog catalog-v1.json --download
```

提交 catalog 改动后，再检查相对基线的版本递增（脚本比较 Git 提交，而不只是工作区文件）。下面是 macOS/Linux 的命令；以实际基线 SHA 替换占位符，Windows 可通过 PowerShell 的 `$env:CATALOG_BASE_SHA` 设置同名环境变量后运行脚本：

```sh
CATALOG_BASE_SHA="<base-commit-sha>" node scripts/check-catalog-version.js
```

完整下载检查会验证官方 Release、预览图、包内文件、源提交逐文件内容和固定许可说明。CI 通过后审阅合并 catalog。然后用实际 Clawd 刷新主题列表，验证下载、选择、状态切换与卸载，记录系统和版本。目录可能使用缓存，不要把尚未刷新的列表误判为收录失败。

联网目录发布与应用发版是独立步骤。应用发版前，按[发版流程的 Before Tagging 要求](release-process.md#before-tagging)，在主仓库运行 `npm run update:official-theme-snapshot`，有变化则提交快照，让未来安装包在离线时也包含新的列表信息。

## 更新与撤回

每次资源变化发布一个新版本。不要覆盖已公开的同版本 ZIP 或预览图；旧版 README 与 LICENSE 也参与当前包的校验，不能只改 metadata 而不处理版本包。

有问题的条目需要下架时，通过新的 catalog 提交移除或更正并增加 `catalogVersion`。这会改变后续列表和下载，不会自动删除用户已安装的文件。重大素材或许可问题在关联 Issue 与 Release 说明中交代处理情况。
