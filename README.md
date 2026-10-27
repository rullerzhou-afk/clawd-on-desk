<p align="center">
  <img src="assets/icon.png" width="128" alt="Clawd">
</p>

<div align="center">
  <h1>Clawd on Desk</h1>
  <p><b>A pixel desktop pet that reacts to your AI coding agent in real time.</b></p>
  <p>English · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ko-KR.md">한국어</a> · <a href="README.ja-JP.md">日本語</a> · <a href="README.es.md">Español</a></p>
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/stargazers"><img src="https://img.shields.io/github/stars/rullerzhou-afk/clawd-on-desk?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/releases"><img src="https://img.shields.io/github/v/release/rullerzhou-afk/clawd-on-desk?label=version&style=flat-square" alt="Version"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge-flat.svg" alt="Mentioned in Awesome Claude Code"></a>
  <a href="https://discord.gg/VQsQZbZCPx"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&amp;logo=discord&amp;logoColor=white" alt="Discord"></a>
</div>

<p align="center">
  <img src="assets/hero.gif" alt="Clawd on Desk — a pixel desktop pet that reacts to your AI coding agent in real time. Animated demo: the crab cycles through sleeping, thinking while the model reads the codebase, typing as edit/bash tools run, grooving for one subagent, juggling when multiple subagents run, raising a permission bubble, and celebrating when 14 files / 312 tests are complete. Works with Claude Code, Codex, Cursor, Copilot, Gemini, Antigravity, Qwen, CodeWhale, Pi, OMP, OpenClaw and more.">
</p>

Start a long task, walk away, and come back when the crab tells you it's done. Clawd thinks while you prompt, types while tools run, juggles when subagents pile up, pops a card when a tool needs your approval, and dozes off when you step away.

## Features

- **Live agent status**: 12 animated states driven by agent hooks and logs, plus eye tracking, a sleep sequence, click reactions, and a mini mode that peeks from the screen edge
- **Works with your tools**: Claude Code, Codex, Copilot, Gemini, Cursor, opencode, Kiro, Qwen and 20+ more, each session tracked side by side
- **Permission bubbles**: Allow or Deny tool requests from a floating card or a global hotkey, or switch to auto-approve
- **Sessions at a glance**: a HUD next to the pet, a dashboard of every live session with one-click jump to its terminal, quota rings, and a private local recap
- **Away from your desk**: approve from Telegram or Feishu/Lark, get Slack notifications, or follow sessions on your phone with the read-only mobile PWA
- **Make it yours**: Clawd, Calico and Cloudling built in, official themes to download, Codex Pet imports, or a theme of your own
- **Runs where you code**: Windows (x64 and ARM64), macOS and Linux, plus Remote SSH and WSL, with the UI in 7 languages

Every feature in detail: **[docs/guides/features.md](docs/guides/features.md)**

## Quick Start

Download the latest installer from **[GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest)**:

| Platform | Download |
|---|---|
| Windows | `Clawd-on-Desk-Setup-<version>-x64.exe` or `-arm64.exe` |
| macOS | `.dmg`, or `brew install --cask clawd-on-desk` |
| Linux | `.AppImage` (in-app updates), or `.deb` with [APT setup / migration](docs/guides/apt-setup.md) (Homebrew also works on x86_64) |

Launch Clawd and it starts reacting right away: Claude Code and Codex are connected on first launch. Every other agent is one click away in **Settings → AI Coding Tools**.

<details>
<summary><strong>Run from source</strong></summary>
<br/>

Only needed for contributing, testing unreleased code, or debugging integrations. Source installs download Electron and build tooling, so `node_modules` gets large.

```bash
# Clone the repo
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# Install dependencies
npm install

# Start Clawd (auto-registers Claude Code and Codex hooks on launch)
npm start
```

Prerequisites, Remote SSH, WSL, and macOS / Linux notes: **[setup guide](docs/guides/setup-guide.md)**

</details>

## Supported Agents

> **Claude Code** · **Codex CLI** · **Copilot CLI** · **Gemini CLI** · **Antigravity CLI (agy)** · **Cursor Agent** · **CodeBuddy** · **WorkBuddy** · **Grok Build** · **Kiro CLI** · **KiroCrew** · **Kimi Code CLI (Kimi-CLI)** · **Qwen Code** · **ZCode** · **CodeWhale** · **opencode** · **MiMo Code** · **Pi** · **OMP** · **OpenClaw** · **Hermes Agent** · **Qoder** · **QoderWork** · **QwenWork (千问办公)** · **Reasonix CLI** · **DeepSeek Harness** · **TraeCode (Trae CN)** · **MiniMax Code**

Claude Code and Codex CLI are set up on first launch; install any other integration from **Settings → AI Coding Tools** and Clawd keeps it synced. Other local tools can report through the [custom HTTP agent](docs/guides/custom-agent-http.md) endpoint. Per-agent details are in **[supported agents](docs/guides/supported-agents.md)**, and gaps such as agents without permission bubbles are in **[known limitations](docs/guides/known-limitations.md)**.

## Themes

<table>
  <tr>
    <td align="center"><img src="assets/gif/clawd-idle.gif" width="100"><br><sub>Idle</sub></td>
    <td align="center"><img src="assets/gif/clawd-thinking.gif" width="100"><br><sub>Thought Bubble</sub></td>
    <td align="center"><img src="assets/gif/clawd-typing.gif" width="100"><br><sub>Typing</sub></td>
    <td align="center"><img src="assets/gif/clawd-building.gif" width="100"><br><sub>Building</sub></td>
    <td align="center"><img src="assets/gif/clawd-headphones-groove.gif" width="100"><br><sub>1 Subagent</sub></td>
    <td align="center"><img src="assets/gif/clawd-juggling.gif" width="100"><br><sub>2+ Subagents</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/calico-idle.gif" width="80"><br><sub>Calico Idle</sub></td>
    <td align="center"><img src="assets/gif/calico-thinking.gif" width="80"><br><sub>Calico Thinking</sub></td>
    <td align="center"><img src="assets/gif/calico-typing.gif" width="80"><br><sub>Calico Typing</sub></td>
    <td align="center"><img src="assets/gif/calico-building.gif" width="80"><br><sub>Calico Building</sub></td>
    <td align="center"><img src="assets/gif/calico-juggling.gif" width="80"><br><sub>Calico Juggling</sub></td>
    <td align="center"><img src="assets/gif/calico-conducting.gif" width="80"><br><sub>Calico Conducting</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/cloudling-idle.gif" width="120"><br><sub>Cloudling Idle</sub></td>
    <td align="center"><img src="assets/gif/cloudling-thinking.gif" width="120"><br><sub>Cloudling Thinking</sub></td>
    <td align="center"><img src="assets/gif/cloudling-typing.gif" width="120"><br><sub>Cloudling Typing</sub></td>
    <td align="center"><img src="assets/gif/cloudling-building.gif" width="120"><br><sub>Cloudling Building</sub></td>
    <td align="center"><img src="assets/gif/cloudling-juggling.gif" width="120"><br><sub>Cloudling Juggling</sub></td>
    <td align="center"><img src="assets/gif/cloudling-conducting.gif" width="120"><br><sub>Cloudling Conducting</sub></td>
  </tr>
</table>

Clawd ships with **Clawd** (pixel crab), **Calico** (三花猫) and **Cloudling** (云宝). **Hash Sage** (哈希仙人) and **Whale-chan** (鲸鱼娘) are optional official themes in **Settings → Theme**, where you can also import a Codex Pet zip. To draw your own, run `npm run create-theme -- my-theme` and follow the **[theme creation guide](docs/guides/guide-theme-creation.md)**. Which event plays which animation: [state mapping](docs/guides/state-mapping.md).

Community tool: [Live2Pet](https://github.com/receyuki/live2pet) by @receyuki turns Live2D models into Clawd themes.

## Guides

| Guide | What it covers |
|---|---|
| [Features](docs/guides/features.md) | Every feature in detail |
| [Setup guide](docs/guides/setup-guide.md) | Source builds, agent setup, Windows / macOS / Linux notes |
| [Permission handling](docs/guides/setup-guide.md#permission-handling-automation) | Ask every time, question prompts only, or auto-approve |
| [Remote SSH](docs/guides/guide-remote-ssh.md) | State and permission bubbles from agents on a remote server |
| [Codex + WSL](docs/guides/codex-wsl-clarification.md) | What Clawd supports for Codex inside WSL |
| [Remote approval](docs/guides/telegram-approval.md) | Telegram, plus [Feishu / Lark](docs/guides/feishu-lark-remote-approval.md) and [Slack notifications](docs/guides/slack-notifications.md) |
| [Recap](docs/guides/recap.md) | Private local activity review |
| [Custom HTTP agents](docs/guides/custom-agent-http.md) | Connect a tool Clawd doesn't integrate with yet |
| [Known limitations](docs/guides/known-limitations.md) | Per-agent feature gaps |
| [Theme creation](docs/guides/guide-theme-creation.md) | Build and validate your own theme |
| [Contributing themes](docs/guides/contributing-themes.md) | Submissions, licenses, catalog review, and updates |

## Community

Join our [Discord community](https://discord.gg/VQsQZbZCPx) to get help, share themes and desktop setups, or discuss ideas. English and Chinese are welcome. Please report bugs through [GitHub Issues](https://github.com/rullerzhou-afk/clawd-on-desk/issues) so we can track them.

<table>
  <tr>
    <th align="center">WeChat Official Account</th>
    <th align="center">WeChat Group</th>
  </tr>
  <tr>
    <td align="center" valign="top"><img src="assets/readme/wechat-official-account.jpg" width="200" height="200" alt="QR code for the WeChat official account 鹿鹿的学习笔记"><br><b>鹿鹿的学习笔记</b><br>Scan to follow on WeChat</td>
    <td align="center" valign="top"><img src="assets/readme/wechat-group-contact.png" width="200" height="200" alt="WeChat contact QR code for a group invite"><br><b>Join the WeChat group</b><br>Scan to add 云宝.bot on WeChat<br>Once your friend request is accepted,<br>we’ll invite you to the group</td>
  </tr>
</table>

## Contributing

Clawd on Desk is a community-driven project. Bug reports, feature ideas, and pull requests are all welcome — open an [issue](https://github.com/rullerzhou-afk/clawd-on-desk/issues) to discuss or submit a PR directly. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to run from source, add a translation, or integrate a new agent.

### Maintainers

<p align="center">
  <img src="assets/readme/maintainers.svg" width="660" alt="Maintainers: @rullerzhou-afk (creator), @YOIMIYA66, @Bynlk (Mobile / PWA)">
</p>

### Contributors

Thanks to everyone who has helped make Clawd better:

<a href="https://github.com/rullerzhou-afk/clawd-on-desk/graphs/contributors">
  <img src="assets/readme/contributors.svg" width="900" alt="Clawd on Desk contributors">
</a>

## Acknowledgments

- Clawd pixel art reference from [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto)
- Shared on [LINUX DO](https://linux.do/) community

## License

Source code is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).

**Artwork and bundled theme assets (including `assets/` and `themes/*/assets/`) are NOT covered by AGPL-3.0.** All rights reserved by their respective copyright holders. See [assets/LICENSE](assets/LICENSE) and the notices below for details.

- **Clawd** character is the property of [Anthropic](https://www.anthropic.com). This is an unofficial fan project, not affiliated with or endorsed by Anthropic.
- **Calico cat (三花猫)** artwork by 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)). All rights reserved.
- **Cloudling (云宝)** artwork by 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)). All rights reserved. Cloudling's visual direction includes an homage to the OpenAI Codex logo; Codex/OpenAI marks remain the property of OpenAI, and this project is not affiliated with or endorsed by OpenAI.
- **Hash Sage (哈希仙人)** is distributed as an optional official theme from the [`rullerzhou-afk/clawd-themes`](https://github.com/rullerzhou-afk/clawd-themes) repository. Its artwork is copyright 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)); see the theme package for its license and full attribution. It is not covered by this project's AGPL-3.0 source license.
- **Whale-chan (鲸鱼娘)** is distributed as an optional official theme from the [`rullerzhou-afk/clawd-themes`](https://github.com/rullerzhou-afk/clawd-themes) repository. Rights in the original character design, setting and upstream materials remain with their creators; the theme credits ZipZipPipe and 上善无形 as named by [Neko3000/deepseek-whalechan](https://github.com/Neko3000/deepseek-whalechan). New animation and effects by 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) are licensed under CC BY-NC-SA 4.0; see the theme package for full terms. It is an unofficial, non-commercial fan work, not affiliated with or endorsed by DeepSeek, and it is not covered by this project's AGPL-3.0 source license.
- **Third-party contributions**: copyright retained by respective artists.

**No cryptocurrency.** This project has no token, coin, NFT, or airdrop, and is not affiliated with any cryptocurrency project.
