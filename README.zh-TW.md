<p align="center">
  <img src="assets/icon.png" width="128" alt="Clawd">
</p>

<div align="center">
  <h1>Clawd 桌寵</h1>
  <p><b>一隻像素桌寵，即時感知你的 AI 程式設計助理在做什麼。</b></p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · 繁體中文 · <a href="README.ko-KR.md">한국어</a> · <a href="README.ja-JP.md">日本語</a> · <a href="README.es.md">Español</a></p>
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/stargazers"><img src="https://img.shields.io/github/stars/rullerzhou-afk/clawd-on-desk?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/releases"><img src="https://img.shields.io/github/v/release/rullerzhou-afk/clawd-on-desk?label=version&style=flat-square" alt="Version"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge-flat.svg" alt="Mentioned in Awesome Claude Code"></a>
  <a href="https://discord.gg/VQsQZbZCPx"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&amp;logo=discord&amp;logoColor=white" alt="Discord"></a>
</div>

<p align="center">
  <img src="assets/hero.gif" alt="Clawd 桌寵動畫示範：像素螃蟹會跟著 AI 程式設計助理的狀態即時切換，睡覺、思考、工具執行時打字、單一子代理時戴耳機律動、多個子代理並行時三球雜耍、權限請求出現時提醒、任務完成後慶祝。支援 Claude Code、Codex、Cursor、Copilot、Gemini、Antigravity、Qwen、Pi、OMP、OpenClaw 等。">
</p>

發起一個長任務，起身做點別的，等螃蟹告訴你完成了再回來。你提問時它思考，工具執行時它打字，子代理一多它就雜耍，需要審批時它跳出卡片，你離開時它睡覺。

## 功能特色

- **即時狀態**：由 agent hook 和日誌驅動的 12 種動畫狀態，還有視線跟隨、睡眠序列、點擊反應，以及貼邊探頭的迷你模式
- **涵蓋主流工具**：Claude Code、Codex、Copilot、Gemini、Cursor、opencode、Kiro、Qwen 等 20 多款，多個工作階段並行追蹤
- **權限對話框**：在浮動卡片上或用全域快速鍵 Allow / Deny 工具請求，也可以切換成自動放行
- **工作階段一目了然**：桌寵旁的 HUD、所有工作階段的儀表板（一鍵跳回終端機）、額度環，以及只存在本機的活動回顧
- **離開電腦也能管**：透過 Telegram 或飛書 / Lark 遠端審批，Slack 通知，或在手機上用唯讀 PWA 查看工作階段
- **換成你喜歡的樣子**：內建 Clawd、Calico、Cloudling，可下載官方主題、匯入 Codex Pet，或自己做主題
- **在哪寫程式就在哪**：Windows（x64 / ARM64）、macOS、Linux，支援 Remote SSH 和 WSL，介面支援 7 種語言

完整功能說明：**[docs/guides/features.zh-TW.md](docs/guides/features.zh-TW.md)**

## 快速開始

從 **[GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest)** 下載最新安裝檔：

| 平台 | 下載 |
|---|---|
| Windows | `Clawd-on-Desk-Setup-<version>-x64.exe` 或 `-arm64.exe` |
| macOS | `.dmg`，或 `brew install --cask clawd-on-desk` |
| Linux | `.AppImage` 或 `.deb`（x86_64 也可用 Homebrew） |

啟動 Clawd 後它會立刻開始運作：第一次啟動就會接上 Claude Code 和 Codex。其他 agent 在 **設定 → AI 程式設計工具** 裡一鍵安裝。

<details>
<summary><strong>從原始碼執行</strong></summary>
<br/>

只有參與開發、測試未發布程式碼或除錯整合時才需要。原始碼安裝會下載 Electron 和建置工具，`node_modules` 會比較大。

```bash
# clone 儲存庫
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# 安裝相依套件
npm install

# 啟動 Clawd（啟動時自動註冊 Claude Code 和 Codex hooks）
npm start
```

環境需求、Remote SSH、WSL 以及 macOS / Linux 說明：**[安裝指南](docs/guides/setup-guide.md)**

</details>

## 支援的 Agent

> **Claude Code** · **Codex CLI** · **Copilot CLI** · **Gemini CLI** · **Antigravity CLI (agy)** · **Cursor Agent** · **CodeBuddy** · **WorkBuddy** · **Grok Build** · **Kiro CLI** · **KiroCrew** · **Kimi Code CLI（Kimi-CLI）** · **Qwen Code** · **ZCode** · **CodeWhale** · **opencode** · **MiMo Code** · **Pi** · **OMP** · **OpenClaw** · **Hermes Agent** · **Qoder** · **QoderWork** · **QwenWork（千問辦公）** · **Reasonix CLI** · **DeepSeek Harness** · **TraeCode (Trae CN)** · **MiniMax Code**

Claude Code 和 Codex CLI 第一次啟動就會接上；其他整合在 **設定 → AI 程式設計工具** 中安裝，之後由 Clawd 保持同步。其他本機工具可以透過 [自訂 HTTP agent](docs/guides/custom-agent-http.md) 介面回報狀態。各 agent 的細節見 **[支援的 Agent](docs/guides/supported-agents.zh-TW.md)**，沒有權限對話框等差異見 **[已知限制](docs/guides/known-limitations.md)**。

## 主題

<table>
  <tr>
    <td align="center"><img src="assets/gif/clawd-idle.gif" width="100"><br><sub>待機</sub></td>
    <td align="center"><img src="assets/gif/clawd-thinking.gif" width="100"><br><sub>思考泡泡</sub></td>
    <td align="center"><img src="assets/gif/clawd-typing.gif" width="100"><br><sub>打字</sub></td>
    <td align="center"><img src="assets/gif/clawd-building.gif" width="100"><br><sub>建造</sub></td>
    <td align="center"><img src="assets/gif/clawd-headphones-groove.gif" width="100"><br><sub>耳機律動</sub></td>
    <td align="center"><img src="assets/gif/clawd-juggling.gif" width="100"><br><sub>三球雜耍</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/calico-idle.gif" width="80"><br><sub>三花待機</sub></td>
    <td align="center"><img src="assets/gif/calico-thinking.gif" width="80"><br><sub>三花思考</sub></td>
    <td align="center"><img src="assets/gif/calico-typing.gif" width="80"><br><sub>三花打字</sub></td>
    <td align="center"><img src="assets/gif/calico-building.gif" width="80"><br><sub>三花建造</sub></td>
    <td align="center"><img src="assets/gif/calico-juggling.gif" width="80"><br><sub>三花雜耍</sub></td>
    <td align="center"><img src="assets/gif/calico-conducting.gif" width="80"><br><sub>三花指揮</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/gif/cloudling-idle.gif" width="120"><br><sub>雲寶待機</sub></td>
    <td align="center"><img src="assets/gif/cloudling-thinking.gif" width="120"><br><sub>雲寶思考</sub></td>
    <td align="center"><img src="assets/gif/cloudling-typing.gif" width="120"><br><sub>雲寶打字</sub></td>
    <td align="center"><img src="assets/gif/cloudling-building.gif" width="120"><br><sub>雲寶建造</sub></td>
    <td align="center"><img src="assets/gif/cloudling-juggling.gif" width="120"><br><sub>雲寶雜耍</sub></td>
    <td align="center"><img src="assets/gif/cloudling-conducting.gif" width="120"><br><sub>雲寶指揮</sub></td>
  </tr>
</table>

內建 **Clawd**（像素螃蟹）、**Calico**（三花貓）和 **Cloudling**（雲寶）。**Hash Sage**（哈希仙人）和 **Whale-chan**（鯨魚娘）是可選官方主題，在 **設定 → 主題** 下載，那裡也可以匯入 Codex Pet 壓縮檔。想自己畫？執行 `npm run create-theme -- my-theme`，然後看 **[主題創作指南](docs/guides/guide-theme-creation.md)**。事件與動畫的對應：[狀態對應](docs/guides/state-mapping.md)。

社群工具：[Live2Pet](https://github.com/receyuki/live2pet)（作者 @receyuki）可以把 Live2D 模型轉換成 Clawd 主題。

## 文件

| 文件 | 內容 |
|---|---|
| [功能特色](docs/guides/features.zh-TW.md) | 所有功能的詳細說明 |
| [安裝指南](docs/guides/setup-guide.md) | 原始碼建置、agent 設定、Windows / macOS / Linux 說明 |
| [權限處理](docs/guides/setup-guide.md#permission-handling-automation) | 每次詢問、僅問題提示或自動放行 |
| [Remote SSH](docs/guides/guide-remote-ssh.md) | 遠端伺服器上的 agent 狀態和權限對話框 |
| [Codex + WSL](docs/guides/codex-wsl-clarification.md) | Clawd 對 WSL 中 Codex 的支援範圍 |
| [遠端審批](docs/guides/telegram-approval.md) | Telegram，以及 [飛書 / Lark](docs/guides/feishu-lark-remote-approval.md) 和 [Slack 通知](docs/guides/slack-notifications.md) |
| [活動回顧](docs/guides/recap.md) | 只存在本機的活動回顧 |
| [自訂 HTTP agent](docs/guides/custom-agent-http.md) | 接入 Clawd 尚未整合的工具 |
| [已知限制](docs/guides/known-limitations.md) | 各 agent 的功能差異 |
| [主題創作](docs/guides/guide-theme-creation.md) | 製作並驗證自己的主題 |

## 社群

歡迎加入 [Discord 社群](https://discord.gg/VQsQZbZCPx)，交流使用心得、尋求協助、分享主題和桌面配置，也歡迎討論新想法。支援中文和英文交流；Bug 請提交至 [GitHub Issues](https://github.com/rullerzhou-afk/clawd-on-desk/issues)，方便追蹤。

## 參與貢獻

Clawd on Desk 是社群驅動的專案。歡迎提 Bug、提需求、提 PR —— 在 [Issues](https://github.com/rullerzhou-afk/clawd-on-desk/issues) 聊聊或直接送 PR。

### 維護者

<p align="center">
  <img src="assets/readme/maintainers.svg" width="660" alt="Maintainers: @rullerzhou-afk (creator), @YOIMIYA66, @Bynlk (Mobile / PWA)">
</p>

### 貢獻者

謝謝每一位讓 Clawd 變得更好的貢獻者：

<a href="https://github.com/rullerzhou-afk/clawd-on-desk/graphs/contributors">
  <img src="assets/readme/contributors.svg" width="900" alt="Clawd on Desk contributors">
</a>

## 致謝

- Clawd 像素畫參考自 [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto)
- 本專案在 [LINUX DO](https://linux.do/) 社群推廣

## 授權

原始碼以 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0）授權釋出。

**美術素材和內建主題素材（包括 `assets/` 與 `themes/*/assets/`）不適用 AGPL-3.0 授權。** 所有權利歸各自著作權人所有，詳見 [assets/LICENSE](assets/LICENSE) 及下列說明。

- **Clawd** 角色設計屬於 [Anthropic](https://www.anthropic.com)。本專案為非官方粉絲作品，與 Anthropic 沒有官方關聯。
- **三花貓** 素材由 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) 創作，保留所有權利。
- **Cloudling（雲寶）** 素材由 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) 創作，保留所有權利。雲寶的視覺方向包含對 OpenAI Codex logo 的致敬；Codex 與 OpenAI 相關標誌仍歸 OpenAI 所有，本專案與 OpenAI 沒有官方關聯，也未獲 OpenAI 背書。
- **Whale-chan（鯨魚娘）** 由 [`rullerzhou-afk/clawd-themes`](https://github.com/rullerzhou-afk/clawd-themes) 作為可選官方主題獨立發佈。原始角色設計、設定與素材權利歸原作者；主題依 [Neko3000/deepseek-whalechan](https://github.com/Neko3000/deepseek-whalechan) 署名 ZipZipPipe 與上善無形。鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) 新作的動畫與特效採用 CC BY-NC-SA 4.0，完整條款見主題包。本主題是非官方、非商業同人作品，與 DeepSeek 無關，亦未獲授權或背書；不適用本專案 AGPL-3.0 原始碼授權。
- **第三方畫師作品**：著作權歸各自作者所有。
