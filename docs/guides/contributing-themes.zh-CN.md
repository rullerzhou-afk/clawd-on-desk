# 贡献外部主题

[English](contributing-themes.md)

欢迎为 Clawd 制作主题。主题提案、成品投稿与贡献文档都放在 `clawd-on-desk` 主仓库。本指南说明独立于应用安装包分发的主题如何投稿和审核。

## 当前状态

现在可以发投稿 Issue 讨论，也可以由作者打包分享，用户通过「设置 → 主题 → 导入 Clawd 主题包（.zip）」安装（见[独立分享](#独立分享与后续更新)）。

**投稿和主题上架都不需要等待 Clawd 应用发布新版本。** 进入下载列表仍需完成主题包审核、主题包公开发布和目录更新。目录刷新后，已经支持主题下载、且满足该主题最低应用版本要求的现有 Clawd，就能看到并安装这个主题。

「社区主题」分组、社区角标和卡片上的作者署名属于应用界面更新，需要使用包含这些功能的应用版本。旧版仍可下载兼容的社区主题，只是会将它们显示在「官方主题」里。

**从[主题投稿 Issue](https://github.com/rullerzhou-afk/clawd-on-desk/issues/new?template=theme-submission-zh.yml)开始。** 可以用中文或英文。初次投稿不用先 fork 主仓库或提交 PR；主题文件可以留在作者自己的仓库，在 Issue 中按下文提供链接、预览、许可等信息。

如果还只有想法，先附草图或参考图、说明你准备做什么；这属于提案，不是可安装主题，也不代表维护者会代为制作。

我们会综合考虑设计辨识度、完成度、使用体验、素材来源与维护情况。提交或通过格式检查都不保证收录。同一角色的不同造型可以投稿，请说明区别，并使用独立主题 ID。

## 制作与本地体验

安装 Clawd，并按主仓库的[主题制作指南](guide-theme-creation.md)制作。该指南是 `theme.json`、状态映射和能力开关的格式说明。

如果使用生成脚本，需要 Node.js 22.12 或更新版本。下面的命令在 **clawd-on-desk 主仓库**中执行：

```sh
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk
node scripts/create-theme.js my-theme --name "My Theme" --author "Your Name"
```

脚本会打印新建主题的目录；编辑其中的 `theme.json` 和 `assets/`。骨架带有示例文件名，尚未包含全部动画；请补齐素材，或移除不提供的可选映射并关闭对应能力，再校验和试用。在 Clawd「设置 → 主题」选择它。新目录未出现时，先点该页的「刷新主题」；仍然没有再重启 Clawd。

- 主题可以使用 SVG、GIF、APNG、WebP、PNG、JPG 或 JPEG。静态主题也可以投稿，不要求像素风或某个生成工具。MP4 视频需要先转换为支持的图片或动画格式。
- `idle`、`thinking`、`working` 需要实际文件；`sleeping` 需要文件或有效的 `fallbackTo`。完成、报错、通知等状态应有可理解的表现或回退。
- 可以先做小而完整的主题。无需追齐现有主题的动画数量。没有眼球追踪或迷你模式时，显式关闭对应能力；采用 `sleepSequence.mode: "direct"` 可省去完整入睡过程。细节见制作指南。
- 为自己的主题选择独立 ID（文件夹名）。不要使用 `clawd`、`calico`、`cloudling`、`hash-sage`、`whale-chan`、`template`，也不要占用目录中已有的 ID。
- 外部 SVG 会被清理，不能依赖内嵌 JavaScript、联网加载资源或 `trustedRuntime`。请把需要的画面放在本地素材中。

在主仓库运行校验，把路径替换为脚本打印的实际目录：

```sh
node scripts/validate-theme.js "/absolute/path/to/my-theme"
```

校验通过后，还要在真实 Clawd 中看一遍。检查透明边缘、常用桌宠大小下的清晰度、状态切换时的位置和大小、循环接缝、点击与拖拽；若提供迷你模式或漫游，也检查这些动作。说明实际测试的 Clawd 版本、系统和未测试项。格式校验不替代这些体验检查。

## 投稿时提供什么

创意提案先提供名称与 ID、设计或预览、署名与许可，尚待取得的许可也请说明。成品主题和更新请再补充文件、测试及维护信息：

1. 主题名称、拟用 ID、作者署名，以及与已有主题的区别。
2. 一张清楚的预览图；动画主题附几个代表动作的录屏或动图。
3. 可下载的主题文件夹或 ZIP，以及 `theme.json`。有源仓库时，提供仓库链接、固定提交和主题所在目录；还没有仓库时，先说明交付方式，正式发布的来源记录再与维护者商定。
4. 已完成的状态与可选能力、主题版本、实际测试过的 Clawd 版本和系统、校验结果及已知问题。
5. 素材来源、作者和完整许可说明，包括参考或改编的第三方素材、生成工具的使用情况。不要仅写“来自网络”。
6. 后续更新由谁维护，反馈可以留在哪里。

只有美术或只有创意也可以先发提案寻找协作者；请明确还缺哪些制作工作。维护者会在 Issue 中讨论是否继续接入和需要补充的内容。

## 文件与许可

一个可交付的主题通常长这样：

```text
my-theme/
  theme.json
  assets/
    idle.webp
    thinking.webp
    working.webp
    sleeping.webp
  README.md
  LICENSE
```

`README.md` 写清作者、版本、安装方式、支持的能力和已知限制。`LICENSE` 写清实际适用条款与第三方署名，并说明是否允许项目通过 `clawd-themes` 分发主题包和预览图，以及用户下载、安装和使用。请只提供自己有权提供的素材；参考图本身不等于授权。

各主题保留自己的许可。Clawd 应用的 AGPL 源码许可不会自动套用到美术，现有主题的许可也不是可直接沿用的通用模板。生成工具和付费订阅不替代素材来源与许可说明。

不要把大型素材、视频或 ZIP 提交进 `clawd-on-desk` 或 `clawd-themes` 的 Git 历史。投稿时用作者仓库、版本化 Release 或可下载附件交付；正式收录的主题包由维护者在 [`clawd-themes`](https://github.com/rullerzhou-afk/clawd-themes) 的 Release 中发布。

## 审核后如何收录

投稿与讨论在主仓库完成。审核通过后，维护者会安排向 [`clawd-themes`](https://github.com/rullerzhou-afk/clawd-themes) 提交分发记录的 PR，并关联主仓库中的投稿 Issue。下面这些文件属于分发仓库，不应作为新主题目录提交进主仓库：

```text
themes/<theme-id>/
  README.md
  LICENSE
  preview.webp
  manifest.json
```

`manifest.json` 是分发记录，和运行时的 `theme.json` 是两个文件；版本、来源、许可、素材数量须与实际主题对应。初次提案不需要编写 manifest。不熟悉 Git 的作者可以先通过 Issue 提供材料，再与维护者商定如何提交这些文件。

社区作品的 manifest 和 catalog 都会写明 `category: "community"` 和作者署名。维护者在 `rullerzhou-afk` 账号下的公开仓库中保留已审阅源码，并固定到具体提交；作者署名和原许可继续保留。独立的动画展示网站不是必需项。

预览图使用 WebP，最大 1 MiB。大型动画留在源仓库与 Release 中。主题 ID 使用小写字母、数字和连字符，长度 1–64，首字符为字母或数字；主题版本使用 `1.0.0` 这样的三段数字。

**首次投稿不要直接修改 `catalog-v1.json` 或填写尚未发布的下载地址。** 发布和目录更新由维护者按[发布检查](../project/theme-publishing.md)处理。请提交真实来源；维护者会在发布前确认所需的工具支持已合并。

## 独立分享与后续更新

你也可以在自己的仓库发布主题，让用户手动安装，无需等待官方目录收录。ZIP 中应当只有一个主题，`theme.json` 放在根目录或一个顶层文件夹内。在支持此功能的 Clawd 版本中，可用「设置 → 主题 → 导入 Clawd 主题包（.zip）」；没有该入口时，将主题文件夹放入用户主题目录：

| 系统 | 默认目录 |
| --- | --- |
| Windows | `%APPDATA%/clawd-on-desk/themes/` |
| macOS | `~/Library/Application Support/clawd-on-desk/themes/` |
| Linux | `~/.config/clawd-on-desk/themes/`（设置了 `XDG_CONFIG_HOME` 时使用该目录下的 `clawd-on-desk/themes/`） |

普通 ZIP 导入的限制与官方目录下载不同：ZIP 最大 80 MiB、展开后最大 160 MiB、单文件最大 40 MiB。超过导入限制的主题可以按制作指南手动放置文件夹，再与维护者讨论是否适合收录。

更新已收录主题时，递增主题版本，关联原 Issue，提供变更说明、新素材和重新测试的结果。已发布版本的资源不会原地替换；维护者会审核新的版本包。若暂时无法继续维护，请在主题 Issue 中说明。
