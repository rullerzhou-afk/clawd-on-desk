<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd 桌寵</h1>
<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="README.zh-CN.md">簡體中文</a>
  ·
  <a href="README.ko-KR.md">한국어</a>
  ·
  <a href="README.ja-JP.md">日本語</a>
</p>
<p align="center">
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/releases"><img src="https://img.shields.io/github/v/release/rullerzhou-afk/clawd-on-desk" alt="Version"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
</p>
<p align="center">
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/stargazers"><img src="https://img.shields.io/github/stars/rullerzhou-afk/clawd-on-desk?style=flat&logo=github&color=yellow" alt="Stars"></a>
  <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge-flat.svg" alt="Mentioned in Awesome Claude Code"></a>
</p>

<p align="center">
  <img src="assets/hero.gif" alt="Clawd 桌寵動畫示範：像素螃蟹會跟著 AI 程式設計助理的狀態即時切換，睡覺、思考、工具執行時打字、單一子代理時戴耳機律動、多個子代理並行時三球雜耍、權限請求出現時提醒、任務完成後慶祝。支援 Claude Code、Codex、Cursor、Copilot、Gemini、Pi、OpenClaw 等。">
</p>

Clawd 住在你的桌面上，即時感知 AI 程式設計助理在做什麼。發起一個長任務，起身做點別的，等螃蟹告訴你任務完成了再回來。

你提問時牠思考，工具執行時牠打字，子代理在跑時牠會戴耳機律動或三球雜耍，審查權限時牠彈卡片，任務完成時牠慶祝，你離開時牠睡覺。內建三套主題：**Clawd**（像素螃蟹）、**Calico**（三花貓）和 **Cloudling**（雲寶），支援自訂主題，也支援匯入 Codex Pet 動畫套件。

> 支援 Windows 11、macOS 和 Ubuntu/Linux。Windows 發布版本提供獨立的 x64 和 ARM64 安裝檔。從原始碼執行需要 Node.js。支援 **Claude Code**、**Codex CLI**、**Copilot CLI**、**Gemini CLI**、**Cursor Agent**、**CodeBuddy**、**Kiro CLI**、**Kimi Code CLI（Kimi-CLI）**、**opencode**、**Pi**、**OpenClaw** 與 **Hermes Agent**。

## 功能特色

### 多 Agent 支援

- **Claude Code** — 以 command hook + HTTP 權限 hook 完整整合
- **Codex CLI** — official hooks 為主、JSONL 日誌輪詢（`~/.codex/sessions/`）備援，會自動註冊並支援真實的權限對話框
- **Copilot CLI** — 在 `~/.copilot/hooks/hooks.json` 設定 command hook
- **Gemini CLI** — 在 `~/.gemini/settings.json` 設定 command hook（Clawd 啟動時自動註冊，或執行 `npm run install:gemini-hooks`）
- **Cursor Agent** — [Cursor IDE hooks](https://cursor.com/docs/agent/hooks)，設定在 `~/.cursor/hooks.json`（Clawd 啟動時自動註冊，或執行 `npm run install:cursor-hooks`）
- **CodeBuddy** — 以 Claude Code 相容的 command hook + HTTP 權限 hook 整合，設定寫入 `~/.codebuddy/settings.json`（Clawd 啟動時自動註冊，或執行 `node hooks/codebuddy-install.js`）
- **Kiro CLI** — command hooks 注入到 `~/.kiro/agents/` 下的自訂 agent 設定，並自動建立 `clawd` agent；Clawd 每次啟動都會從內建的 `kiro_default` 重新同步它，盡量和預設 agent 保持一致。macOS 與 Windows 上狀態動效已驗證可用；需要時可用 `kiro-cli --agent clawd` 或在工作階段內執行 `/agent swap clawd` 啟用 hooks（Clawd 啟動時自動註冊，或執行 `npm run install:kiro-hooks`）
- **Kimi Code CLI（Kimi-CLI）** — 在 `~/.kimi/config.toml` 的 `[[hooks]]` 條目設定 command hooks（Clawd 啟動時自動註冊，或執行 `npm run install:kimi-hooks`）
- **opencode** — [外掛整合](https://opencode.ai/docs/plugins)，寫入 `~/.config/opencode/opencode.json`（Clawd 啟動時自動註冊）；零延遲事件流、Allow/Always/Deny 權限對話框、`task` 工具分派平行子代理時自動播放建築動畫
- **Pi** — 以全域擴充功能整合，寫入 `~/.pi/agent/extensions/clawd-on-desk`（Clawd 啟動時自動註冊，或執行 `npm run install:pi-extension`）；僅同步互動式 Pi 工作階段生命週期和工具活動狀態，並保留 Pi 預設 YOLO 行為
- **OpenClaw** — 靠 `~/.openclaw/openclaw.json` 裡的外掛路徑做狀態感知（OpenClaw 設定已存在時 Clawd 啟動會自動註冊，或執行 `npm run install:openclaw-plugin`）；Phase 1 針對本機 `openclaw tui --local` 工作階段，只驅動動畫，沒接權限對話框和終端機焦點
- **Hermes Agent** — [外掛整合](https://hermes-agent.org/)，寫入 Hermes 受管理的外掛目錄（偵測到 Hermes 後 Clawd 啟動時自動註冊，或執行 `npm run install:hermes-plugin`）；支援狀態、工作階段、SessionEnd 和終端機焦點
- **多 Agent 並存** — 多個 Agent 可以同時跑，Clawd 會獨立追蹤每個工作階段

### 動畫與互動

- **即時狀態感知** — 由 Agent hook 和日誌輪詢自動驅動動畫
- **12 種動畫狀態** — 待機、思考、打字、建造、戴耳機律動、多個子代理三球雜耍、報錯、開心、通知、掃地、搬運、睡覺
- **Codex Pet 匯入** — 在 `設定…` → `主題` 內匯入 Codex Pet zip 套件，Clawd 會把 atlas 動畫轉成可管理主題
- **眼球追蹤** — 待機狀態下 Clawd 跟著滑鼠，身體微傾，影子拉伸
- **睡眠序列** — 60 秒沒活動 → 打哈欠 → 打盹 → 倒下 → 睡覺；移動滑鼠觸發驚醒彈起動畫
- **點按反應** — 點兩下會戳一下，連點 4 下會東張西望
- **任意狀態拖曳** — 隨時抓起 Clawd（Pointer Capture 防止快甩丟失），放手後回到目前動畫
- **迷你模式** — 拖到右邊緣或右鍵「迷你模式」；Clawd 藏在螢幕邊緣，滑鼠移過去探頭招手，通知/完成有迷你動畫，拋物線跳躍過場

### 權限審查對話框

- **桌面端權限審查** — Claude Code、Codex CLI、CodeBuddy 或 opencode 請求工具權限時，Clawd 會彈出浮動卡片，不用切回終端機
- **允許 / 拒絕 / Agent 原生擴充功能** — 一鍵允許或拒絕；如果該 Agent 支援，還會顯示權限規則或 `Always` 之類的額外動作
- **全域快速鍵** — `Ctrl+Shift+Y` 允許、`Ctrl+Shift+N` 拒絕最新的權限對話框（只在對話框可見時註冊）
- **堆疊版面** — 多個權限請求從螢幕右下角往上堆疊
- **自動關閉** — 如果你先在終端機回答了，對話框會自動消失
- **依 Agent 個別關閉** — 開啟 `設定…` → `Agents`，選取對應 Agent，關掉 `顯示彈出視窗`，權限提示就會回到該 Agent 自己的終端機或 TUI 處理

### 工作階段智慧體

- **多工作階段追蹤** — 所有已支援 Agent 的工作階段統一解析到最高優先順序狀態
- **子代理感知** — 1 個子代理戴耳機律動，2 個以上三球雜耍
- **工作階段 Dashboard + HUD** — 右鍵或系統匣 → `開啟 Dashboard` 看進行中的工作階段、最近事件、別名，並可跳到終端機；Clawd 附近的輕量 HUD 會持續顯示目前的 live session
- **終端機焦點** — Dashboard 或 HUD 操作可跳到指定工作階段的終端機視窗；通知/注意狀態會自動聚焦相關終端機
- **行程存活偵測** — 偵測已當掉或結束的受支援 Agent 行程，並在 10 秒內清理孤兒工作階段
- **啟動回復** — 如果 Clawd 重新啟動時還有受支援的 Agent 在跑，牠會保持清醒等後續事件，而不是直接睡覺

### 系統

- **滑鼠穿透** — 透明區域的滑鼠事件會直接穿到下層視窗，只有角色本體可互動
- **位置記憶** — 重新啟動後 Clawd 回到上次的位置（包括迷你模式）
- **單一執行個體鎖** — 防止重複啟動
- **自動啟動** — Claude Code 的 SessionStart hook 可在 Clawd 沒在跑時自動啟動它
- **勿擾模式** — 右鍵或系統匣選單進入休眠，所有 hook 事件靜默，直到手動喚醒。勿擾期間不彈權限對話框——Codex 和 opencode 會退回原生的命令列確認，Claude Code 和 CodeBuddy 會退回各自內建的權限確認流程；Antigravity 和 Pi 都是僅同步狀態的整合
- **提示音效** — 任務完成和權限請求時播放短音效（右鍵選單可開關；10 秒冷卻，勿擾模式自動靜音）
- **系統匣** — 調大小（S/M/L）、勿擾、語言切換、登入時啟動、檢查更新
- **國際化** — 支援英文、簡體中文、繁體中文、韓文和日文介面，可從右鍵選單或系統匣切換
- **自動更新** — 檢查 GitHub release；Windows 結束時安裝 NSIS 更新檔，macOS/Linux 從原始碼跑時以 `git pull` + 重新啟動自動更新

## 動畫一覽

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

完整事件對應表、迷你模式、互動彩蛋見：**[狀態對應指南（簡體中文）](docs/guides/state-mapping.zh-CN.md)**

## 多螢幕支援

Clawd 支援多螢幕場景：按啟動時所在螢幕做等比縮放，直立螢幕有尺寸加成防止寵物過小，也可以跨螢幕拖動。

<p align="center"><sub>想看多螢幕下的實際效果？可以<a href="assets/videos/clawd-multi-monitor-demo.mp4">開啟儲存庫裡的示範影片</a>。</sub></p>

## 快速開始

一般使用者建議直接從 **[GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest)** 下載最新的預先建置安裝檔：

- **Windows**：`Clawd-on-Desk-Setup-<version>-x64.exe` 或 `Clawd-on-Desk-Setup-<version>-arm64.exe`
- **macOS**：`.dmg`
- **Linux**：`.AppImage` 或 `.deb`

安裝後啟動 Clawd；支援的 agent hooks 或外掛會在啟動時自動同步。

只有參與開發、測試還沒發布的程式碼或除錯整合時，才建議從原始碼跑。從原始碼安裝會下載 Electron 和打包工具，並產生比較大的 `node_modules`。

```bash
# clone 儲存庫
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# 安裝相依套件
npm install

# 啟動 Clawd（啟動時會自動註冊 Claude Code hooks；要先手動註冊的話，可以單獨跑 `node hooks/install.js`）
npm start
```

**Claude Code** 和 **Codex CLI** 會自動註冊 hooks，開箱即用。**Gemini CLI**、**Cursor Agent**、**CodeBuddy**、**Kiro CLI**、**Kimi Code CLI（Kimi-CLI）**、**opencode**、**Pi**、**OpenClaw**、**Hermes Agent** 在已安裝的前提下，會在 Clawd 啟動時自動同步（OpenClaw 還需要已有設定）；**Copilot CLI** 還是要做一次手動 hooks 設定。也涵蓋遠端 SSH、WSL 及平台說明（macOS 與 Linux）：**[設定指南（簡體中文）](docs/guides/setup-guide.zh-CN.md)**

關於 `Codex + WSL` 的官方現況、Clawd 目前實作的邊界、以及為什麼容易被誤解，見：**[Codex / WSL 說明（簡體中文）](docs/guides/codex-wsl-clarification.zh-CN.md)**

## 已知限制

有些 Agent 存在功能差異（沒有權限對話框、輪詢延遲、不能跳到終端機等）。完整列表見：**[已知限制（簡體中文）](docs/guides/known-limitations.zh-CN.md)**

## 自訂主題

Clawd 支援自訂主題——用你自己的角色和動畫取代預設的螃蟹。如果你已經有 Codex Pet 套件，也可以在 `設定…` → `主題` → `匯入寵物 zip` 直接匯入，Clawd 會自動把 atlas 轉成可管理主題。

**快速開始：**

1. 先產生一個主題骨架：
   ```bash
   node scripts/create-theme.js my-theme
   # 或
   npm run create-theme -- my-theme
   ```
   不傳參數也行，腳手架會自動在你的使用者主題目錄裡產生下一個可用的 `my-theme`。
2. 編輯 `theme.json`，做出你自己的素材（SVG、GIF、APNG、WebP、PNG、JPG 或 JPEG）
3. 重新啟動 Clawd，或開啟 `設定…` → `主題` 選你的主題

**最小可用主題：** 1 個 SVG（帶眼球追蹤的閒置狀態）+ 7 個 GIF/APNG 檔案（thinking、working、error、happy、notification、sleeping、waking）。關掉眼球追蹤後所有狀態都可以用任意格式。

驗證主題：

```bash
node scripts/validate-theme.js path/to/your-theme
```

`設定…` → `主題` 裡的主題卡現在會顯示支援項目，例如 `游標跟隨閒置狀態`、`靜態主題`、`迷你模式`、`直接睡`、`無 reactions`，方便使用者在切換前比較主題差異。

詳見 [docs/guides/guide-theme-creation.md](docs/guides/guide-theme-creation.md)（主題創作完整指南，含入門/進階/高階路徑、theme.json 欄位說明、素材規範）。

> 第三方 SVG 檔案會自動消毒，確保安全。

### 未來規劃

幾個我們想試試的方向：

- Codex 終端機焦點（從 `codex.exe` PID 反查行程樹）
- Copilot CLI hooks 自動註冊（像 Claude Code 那樣開箱即用）
- 主題註冊表 + 應用內下載
- Hook 解除安裝腳本（乾淨移除應用程式）

## 參與貢獻

Clawd on Desk 是社群驅動的專案。歡迎提 Bug、提需求、提 PR —— 在 [Issues](https://github.com/rullerzhou-afk/clawd-on-desk/issues) 聊聊或直接送 PR。

### 維護者

<table>
  <tr>
    <td align="center" valign="top" width="140"><a href="https://github.com/rullerzhou-afk"><img src="https://github.com/rullerzhou-afk.png" width="72" style="border-radius:50%" /><br /><sub><b>@rullerzhou-afk</b><br />鹿鹿 · 建立者</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="72" style="border-radius:50%" /><br /><sub><b>@YOIMIYA66</b><br />維護者</sub></a></td>
  </tr>
</table>

### 貢獻者

謝謝每一位讓 Clawd 變得更好的貢獻者：

<details>
<summary>展開全部 48 位貢獻者</summary>

<a href="https://github.com/PixelCookie-zyf"><img src="https://github.com/PixelCookie-zyf.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/yujiachen-y"><img src="https://github.com/yujiachen-y.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/AooooooZzzz"><img src="https://github.com/AooooooZzzz.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/purefkh"><img src="https://github.com/purefkh.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Tobeabellwether"><img src="https://github.com/Tobeabellwether.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Jasonhonghh"><img src="https://github.com/Jasonhonghh.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/crashchen"><img src="https://github.com/crashchen.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/hongbigtou"><img src="https://github.com/hongbigtou.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/InTimmyDate"><img src="https://github.com/InTimmyDate.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/NeizhiTouhu"><img src="https://github.com/NeizhiTouhu.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/xu3stones-cmd"><img src="https://github.com/xu3stones-cmd.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Ye-0413"><img src="https://github.com/Ye-0413.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/WanfengzzZ"><img src="https://github.com/WanfengzzZ.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/androidZzT"><img src="https://github.com/androidZzT.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/TaoXieSZ"><img src="https://github.com/TaoXieSZ.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/ssly"><img src="https://github.com/ssly.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/stickycandy"><img src="https://github.com/stickycandy.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Rladmsrl"><img src="https://github.com/Rladmsrl.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Kevin7Qi"><img src="https://github.com/Kevin7Qi.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/sefuzhou770801-hub"><img src="https://github.com/sefuzhou770801-hub.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Tonic-Jin"><img src="https://github.com/Tonic-Jin.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/seoki180"><img src="https://github.com/seoki180.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/sophie-haynes"><img src="https://github.com/sophie-haynes.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/PeterShanxin"><img src="https://github.com/PeterShanxin.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/CHIANGANGSTER"><img src="https://github.com/CHIANGANGSTER.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/JaeHyeon-KAIST"><img src="https://github.com/JaeHyeon-KAIST.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/hhhzxyhhh"><img src="https://github.com/hhhzxyhhh.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/TVpoet"><img src="https://github.com/TVpoet.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/zeus6768"><img src="https://github.com/zeus6768.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/anhtrinh919"><img src="https://github.com/anhtrinh919.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/tomaioo"><img src="https://github.com/tomaioo.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/v-avuso"><img src="https://github.com/v-avuso.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/livlign"><img src="https://github.com/livlign.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/tongguang2"><img src="https://github.com/tongguang2.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Ziy1-Tan"><img src="https://github.com/Ziy1-Tan.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/tatsuyanakanogaroinc"><img src="https://github.com/tatsuyanakanogaroinc.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/yeonhub"><img src="https://github.com/yeonhub.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/joshua-wu"><img src="https://github.com/joshua-wu.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/nmsn"><img src="https://github.com/nmsn.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/sunnysonx"><img src="https://github.com/sunnysonx.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/YuChenYunn"><img src="https://github.com/YuChenYunn.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/jhseo-b"><img src="https://github.com/jhseo-b.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/Hwasowl"><img src="https://github.com/Hwasowl.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/XiangZheng2002"><img src="https://github.com/XiangZheng2002.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/keiyo118"><img src="https://github.com/keiyo118.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/pan93412"><img src="https://github.com/pan93412.png" width="50" style="border-radius:50%" /></a>
<a href="https://github.com/taehwanis"><img src="https://github.com/taehwanis.png" width="50" style="border-radius:50%" /></a>

</details>

## 致謝

- Clawd 像素畫參考自 [clawd-tank](https://github.com/marciogranzotto/clawd-tank) by [@marciogranzotto](https://github.com/marciogranzotto)
- 本專案在 [LINUX DO](https://linux.do/) 社群推廣

## 授權

原始碼以 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0）授權釋出。

**美術素材和內建主題素材（包括 `assets/` 與 `themes/*/assets/`）不適用 AGPL-3.0 授權。** 所有權利歸各自著作權人所有，詳見 [assets/LICENSE](assets/LICENSE) 及下列說明。

- **Clawd** 角色設計屬於 [Anthropic](https://www.anthropic.com)。本專案為非官方粉絲作品，與 Anthropic 沒有官方關聯。
- **三花貓** 素材由 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) 創作，保留所有權利。
- **Cloudling（雲寶）** 素材由 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) 創作，保留所有權利。雲寶的視覺方向包含對 OpenAI Codex logo 的致敬；Codex 與 OpenAI 相關標誌仍歸 OpenAI 所有，本專案與 OpenAI 沒有官方關聯，也未獲 OpenAI 背書。
- **第三方畫師作品**：著作權歸各自作者所有。
