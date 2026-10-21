# 功能特色

[返回 README](../../README.zh-TW.md)

## 動畫與互動

- **即時狀態感知** — 由 Agent hook 和日誌輪詢自動驅動動畫
- **12 種動畫狀態** — 待機、思考、打字、建造、戴耳機律動、多個子代理三球雜耍、報錯、開心、通知、掃地、搬運、睡覺
- **Codex Pet 匯入** — 在 `設定…` → `主題` 內匯入 Codex Pet zip 套件，Clawd 會把 atlas 動畫轉成可管理主題
- **眼球追蹤** — 待機狀態下 Clawd 跟著滑鼠，身體微傾，影子拉伸
- **睡眠序列** — 60 秒沒活動 → 打哈欠 → 打盹 → 倒下 → 睡覺；移動滑鼠觸發驚醒彈起動畫
- **點按反應** — 點兩下會戳一下，連點 4 下會東張西望
- **任意狀態拖曳** — 隨時抓起 Clawd（Pointer Capture 防止快甩丟失），放手後回到目前動畫
- **迷你模式** — 拖到右邊緣或右鍵「迷你模式」；Clawd 藏在螢幕邊緣，滑鼠移過去探頭招手，通知/完成有迷你動畫，拋物線跳躍過場

## 權限審查對話框

- **桌面端權限審查** — Claude Code、Codex CLI、CodeBuddy、opencode 或 MiMo Code 請求工具權限時，Clawd 會彈出浮動卡片，不用切回終端機
- **允許 / 拒絕 / Agent 原生擴充功能** — 一鍵允許或拒絕；如果該 Agent 支援，還會顯示權限規則或 `Always` 之類的額外動作
- **全域快速鍵** — `Ctrl+Shift+Y` 允許、`Ctrl+Shift+N` 拒絕最新的權限對話框（只在對話框可見時註冊）
- **堆疊版面** — 多個權限請求從螢幕右下角往上堆疊
- **自動關閉** — 如果你先在終端機回答了，對話框會自動消失
- **依 Agent 個別關閉** — 開啟 `設定…` → `AI 程式設計工具`，選取對應 Agent，關掉 `顯示彈出視窗`，權限提示就會回到該 Agent 自己的終端機或 TUI 處理

## 遠端通知

- **Telegram / 飛書（Lark）** — 互動式遠端審批：把權限請求轉送到手機，直接遠端 Allow / Deny，不必回到桌面
- **Slack** — **僅通知**：透過 Slack Incoming Webhook（或可選的 `xoxb-` Bot Token + channel id）以 Block Kit 卡片推送任務**完成**、**錯誤**與**權限請求**。本版本中 Slack 無法 Allow 或 Deny；權限訊息只是通知，仍需回到桌面 App 決定。請在遠端審批通道中與 Telegram / 飛書並列設定；密鑰保存在 prefs 之外的本機 env 檔案（macOS / Linux 為 `0600`，Windows 依賴 AppData ACL），未設定或離線時會安全降級。訊息可能包含 session 標題、資料夾與主機名稱，建議使用私人頻道。詳見 [Slack 通知指南](slack-notifications.md)

## 工作階段智慧體

- **多工作階段追蹤** — 所有已支援 Agent 的工作階段統一解析到最高優先順序狀態
- **子代理感知** — 1 個子代理戴耳機律動，2 個以上三球雜耍
- **工作階段 Dashboard + HUD** — 右鍵或系統匣 → `開啟 Dashboard` 看進行中的工作階段、最近事件、別名，並可跳到終端機；Clawd 附近的輕量 HUD 會持續顯示目前的 live session
- **終端機焦點** — Dashboard 或 HUD 操作可跳到指定工作階段的終端機視窗；通知/注意狀態會自動聚焦相關終端機
- **行程存活偵測** — 偵測已當掉或結束的受支援 Agent 行程，並在 10 秒內清理孤兒工作階段
- **啟動回復** — 如果 Clawd 重新啟動時還有受支援的 Agent 在跑，牠會保持清醒等後續事件，而不是直接睡覺

## 手機伴侶（PWA）

- **手機即時鏡像** — 在 `設定…` → `Mobile / PWA` 開啟後，用手機開啟配對連結，「Clawd Mobile」網頁應用就會即時顯示各 Agent 工作階段與狀態
- **唯讀設計** — 區網橋接只對外廣播狀態，手機端無法操作你的電腦（遠端審批已在規劃中）
- **僅限區域網路 + 權杖防護** — 配對需要權杖，權杖會自動輪換並附寬限期，可一鍵重新產生或重設存取
- **可安裝** — 標準 PWA，加入主畫面即可獲得近原生體驗
> 手機伴侶這條線——從最初原型到權杖輪換——由核心貢獻者 [@Bynlk](https://github.com/Bynlk) 一手打造並持續主導，他還維護著內建原生 Android App 的姊妹專案 [clawd-on-mobile](https://github.com/Bynlk/clawd-on-mobile)。

## 系統

- **滑鼠穿透** — 透明區域的滑鼠事件會直接穿到下層視窗，只有角色本體可互動
- **位置記憶** — 重新啟動後 Clawd 回到上次的位置（包括迷你模式）
- **單一執行個體鎖** — 防止重複啟動
- **自動啟動** — Claude Code 的 SessionStart hook 可在 Clawd 沒在跑時自動啟動它
- **勿擾模式** — 右鍵或系統匣選單進入休眠，所有 hook 事件靜默，直到手動喚醒。勿擾期間不彈權限對話框——Codex、opencode 和 MiMo Code 會退回原生的命令列確認，Claude Code 和 CodeBuddy 會退回各自內建的權限確認流程；Antigravity 和 Pi 都是僅同步狀態的整合
- **提示音效** — 任務完成和權限請求時播放短音效（可從系統匣或設定中開關；10 秒冷卻，勿擾模式自動靜音）
- **系統匣** — 勿擾、登入時啟動、檢查更新
- **國際化** — 支援英文、簡體中文、繁體中文、韓文、日文、Português (Brasil) 和 Español 介面，可在設定 → 一般中切換
- **自動更新** — 檢查 GitHub release；Windows 結束時安裝 NSIS 更新檔，macOS/Linux 從原始碼跑時以 `git pull` + 重新啟動自動更新

## 多螢幕支援

Clawd 支援多螢幕場景：按啟動時所在螢幕做等比縮放，直立螢幕有尺寸加成防止寵物過小，也可以跨螢幕拖動。

<p align="center"><sub>想看多螢幕下的實際效果？可以<a href="../../assets/videos/clawd-multi-monitor-demo.mp4">開啟儲存庫裡的示範影片</a>。</sub></p>

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

詳見 [docs/guides/guide-theme-creation.md](guide-theme-creation.md)（主題創作完整指南，含入門/進階/高階路徑、theme.json 欄位說明、素材規範）。

> 第三方 SVG 檔案會自動消毒，確保安全。

## 未來規劃

幾個我們想試試的方向：

- Codex 終端機焦點（從 `codex.exe` PID 反查行程樹）
- Hook 解除安裝腳本（乾淨移除應用程式）
- 手機伴侶：在手機上遠端審批權限（推進中，由 [@Bynlk](https://github.com/Bynlk) 主導）
