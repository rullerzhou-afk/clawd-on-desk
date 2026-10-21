# 参与贡献 · Clawd on Desk

[English](CONTRIBUTING.md)

谢谢你愿意帮忙。Clawd on Desk 是社区驱动的项目：大部分语言翻译、好几个 agent 集成、还有移动端伴侣，都是贡献者做的。这一页告诉你东西该放哪、什么样的 PR 能合并。

有不清楚的地方，开一个 [Discussion](https://github.com/rullerzhou-afk/clawd-on-desk/discussions) 问就行。仓库里任何地方都可以用中文或英文。

## 可以做什么

| 你想… | 从这里开始 |
| --- | --- |
| 报 Bug，或某个 agent 没被识别 | [新建 Issue](https://github.com/rullerzhou-afk/clawd-on-desk/issues/new/choose)，选 Bug 或集成问题模板 |
| 提功能建议 | 功能需求模板；还只是个想法的话先发 Discussion |
| 问使用问题 | [Discussions](https://github.com/rullerzhou-afk/clawd-on-desk/discussions)，别开 Issue |
| 翻译界面或 README | 看下面的 [翻译](#翻译) |
| 接入新的 AI 编程工具 | 看下面的 [Agent 集成](#agent-集成) |
| 做主题 | 看下面的 [主题](#主题) |
| 改文档 | 直接改 `docs/guides/` 下的文件或 README，提 PR |

比小修小补大的改动，先开 Issue 或在已有 Issue 下说一声，把做法对齐了再动手，免得大家花时间审一个合不进去的东西。

## 从源码运行

要求：Node.js 22.12 或更高，以及 git。

```bash
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk
npm install
npm start
```

`npm install` 会下载 Electron 和打包工具，`node_modules` 很大。只有贡献代码或排查问题时才需要从源码跑，普通使用请装打包好的发布版。

常用命令：

```bash
npm test                 # 完整测试（node --test），提 PR 前必跑
npm run audit:assets     # 新增或修改素材后检查仓库素材
npm run create-theme     # 生成一个新主题的骨架
bash test-demo.sh        # 轮播各个动画状态，肉眼快速检查
```

`AGENTS.md` 是这个代码库的操作入口，本来是写给编程 agent 看的，对人同样有用：里面有全部命令、`docs/project/` 下的架构文档，以及 agent 集成必须遵守的规则。

## 翻译

界面目前有英文、简体中文、繁体中文、韩文、日文、巴西葡萄牙文、西班牙文七种，其中五种来自社区，所以这是最常见的第一个 PR。

界面文案在两个文件里，按语言分块：

- `src/i18n.js`：菜单、桌宠和通知的文案
- `src/settings-i18n.js`：设置面板

修正或润色已有语言：在两个文件里改对应语言的条目。新增一种语言：

1. 在 `src/i18n.js` 的 `SUPPORTED_LANGS` 里加上语言代码，然后在**两个文件**里各加一个完整的语言对象。复制 `en` 那一块，逐条翻译，键的顺序保持一致。
2. 占位符比如 `{n}`、`{w}×{h}` 原样保留。
3. 跑 `npm test`。`test/i18n.test.js` 会在缺键、顺序不一致、占位符和 `en` 不同时报错。文案的审核清单就是这个测试。
4. 给新语言一个显示名：在 `src/settings-i18n.js` 里，挨着 `langKorean` 那几条，在每个语言块中各加一条 `lang…`。语言选择器本身读的是 `SUPPORTED_LANGS`，`src/language-picker.js` 不用改；但有两个文件各自维护了一份语言列表，也要一起加上：`src/permission-automation-confirmation.js` 和 `src/roam-fence-picker.js`。

README 的翻译同样欢迎：把 `README.md` 复制成 `README.<lang>.md`（命名参考 `README.ko-KR.md`），并在每个 README 顶部的语言行里加上链接。`docs/guides/` 下的指南也是同样的做法（如 `setup-guide.zh-CN.md`）。

用机器翻译起稿没问题，但请以这门语言的用户的眼光通读一遍。在 PR 里说明你是母语者还是流利使用者。

## Agent 集成

Clawd 通过 hook、日志轮询、plugin 或 extension 感知 AI 编程工具的状态。每个已支持的工具在 `agents/` 里有一个适配器，在 `hooks/` 里有一个安装器（例如 `agents/codex.js` 和 `hooks/codex-install.js`）。

接入新工具之前：

- 先看 `docs/guides/custom-agent-http.md`。如果这个工具能发 HTTP 状态事件，把它注册成自定义 HTTP agent 可能就够了，不需要改这个仓库。
- 开一个集成类 Issue，说明这个工具怎么暴露状态（hook、日志、plugin API），附上它的文档链接。
- 读 `docs/project/agent-runtime-architecture.md` 了解模块边界，读 `AGENTS.md` 了解每个集成都必须遵守的安装、启用、卸载规则。一句话：安装不能碰用户没让 Clawd 管的配置，卸载只能删 Clawd 自己加的东西。

一个新集成的 PR 通常包括：适配器、安装器和卸载器、`test/` 下的测试、`docs/guides/` 下的配置指南，以及把工具加进 `AGENTS.md`、README 的「支持的 Agent」列表和 `docs/guides/supported-agents.md`。

## 主题

主题不需要合进这个仓库。一个主题就是一个带 `theme.json` 和 `assets/` 目录的文件夹，用户本地安装即可，完整格式见 `docs/guides/guide-theme-creation.md`，`npm run create-theme` 可以生成骨架。把你的主题放在自己的仓库或 Release 里发布，到 Discussions 说一声，我们会收录。

三个内置主题（`clawd`、`calico`、`cloudling`）和官方可下载主题（`hash-sage`、`whale-chan`，从 [`clawd-themes`](https://github.com/rullerzhou-afk/clawd-themes) 分发）的 id 是保留的。内置素材的改动会审得比较仔细，因为它们随每一份安装包一起发布。

素材必须是你自己的，或者许可证与本项目兼容。如果取材自第三方，请把出处写进 `NOTICE.md`。

## 提 PR

1. Fork 仓库，从 `main` 开分支。
2. 一个 PR 只做一件事。修一个 bug 和顺手重构，请分成两个 PR。
3. 本地跑 `npm test`，确认通过。
4. 填 PR 模板。审核的人最先看的就是这四节：
   - **摘要**：解决什么问题，最终行为是什么；关联 Issue（`Closes #123`）。
   - **变更内容**：按职责归类，不要逐文件罗列。
   - **验证**：实际跑了哪些检查、结果如何，没测的直说。界面改动附截图或短录屏。
   - **范围控制**：这个 PR 有意不做的事。
5. 贴日志、截图、录屏之前，去掉 Token、凭据、私密 Prompt 和个人数据。
6. 做好被追问的准备。这里的审核比较细，因为 Clawd 会写入其他工具的配置；在同一分支上补提交是正常的回应方式。

用 AI 编程 agent 来写改动没问题，这里很常见。要紧的是你跑过结果、看懂了、并且如实描述了验证过程。描述是生成的但没人核对过的 PR，会被退回。

提交信息用轻量的约定式写法，例如 `fix(codex): …`、`feat(theme): …`、`docs: …`、`test(i18n): …`。合并提交以 PR 标题为准，分支内随你整理。

## 安全问题

发现安全问题（比如能通过 hook 执行代码、能读到其他工具的凭据）时，请不要开公开 Issue。请走 GitHub 的私密漏洞报告：[Report a vulnerability](https://github.com/rullerzhou-afk/clawd-on-desk/security/advisories/new)。修复发布之前只有维护者能看到。

## 许可证

提交贡献即表示你同意你的贡献按本项目相同的 [GNU AGPL v3](LICENSE) 许可。第三方材料需列入 `NOTICE.md`。
