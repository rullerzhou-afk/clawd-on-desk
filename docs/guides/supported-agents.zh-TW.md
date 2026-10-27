# 支援的 Agent

[返回 README](../../README.zh-TW.md)

Claude Code 和 Codex CLI 第一次啟動就會接上。其他整合在 **設定 → AI 程式設計工具** 中安裝；保持啟用期間，Clawd 會自動同步。

- **Claude Code** — 以 command hook + HTTP 權限 hook 完整整合
- **Codex CLI** — official hooks 為主、JSONL 日誌輪詢（`~/.codex/sessions/`）備援，會自動註冊並支援真實的權限對話框
- **Copilot CLI** — 在 `~/.copilot/hooks/hooks.json` 設定 command hook
- **Gemini CLI** — 在 `~/.gemini/settings.json` 設定 command hook（Clawd 啟動時自動註冊，或執行 `npm run install:gemini-hooks`）
- **Antigravity CLI (agy)** — 在 `~/.gemini/config/hooks.json` 設定 command hook（已有 Antigravity 設定時 Clawd 啟動會自動註冊，或執行 `npm run install:antigravity-hooks`）；**僅同步狀態**：Clawd 不會為 agy 顯示任何權限對話框，所有 Allow / Deny / Always-allow 都在 agy 自己的終端機選單完成
- **Cursor Agent** — [Cursor IDE hooks](https://cursor.com/docs/agent/hooks)，設定在 `~/.cursor/hooks.json`（Clawd 啟動時自動註冊，或執行 `npm run install:cursor-hooks`）
- **CodeBuddy** — 以 Claude Code 相容的 command hook + HTTP 權限 hook 整合，設定寫入 `~/.codebuddy/settings.json`（Clawd 啟動時自動註冊，或執行 `node hooks/codebuddy-install.js`）
- **自訂 HTTP Agent** — 在 Settings 註冊其他本機應用，再由應用或 adapter 主動向 Clawd 的動態 `/state` 位址上報事件；註冊不會安裝 hook，v1 僅同步狀態，權限決定留在應用自己的介面。詳見[自訂 HTTP Agent 指南](custom-agent-http.md)
- **WorkBuddy** — 可選 Claude Code 相容 command hook，當前使用 `~/.workbuddy-ai/settings.json`，舊版使用 `~/.workbuddy/settings.json`（從 Settings → AI 程式設計工具 安裝，或執行 `node hooks/workbuddy-install.js`）；僅同步狀態與通知，權限仍由 WorkBuddy 原生 GUI 處理
- **Grok Build** — 可選 Claude Code 相容 command hook，寫入 `~/.grok/hooks/clawd-on-desk.json`（從 Settings → AI 程式設計工具 安裝，或執行 `node hooks/grok-install.js`）。僅同步狀態與通知；Grok 沒有阻塞式 `PermissionRequest` hook，Allow / Deny 仍由 Grok TUI 處理。
- **Kiro CLI** — command hooks 注入到 `~/.kiro/agents/` 下的自訂 agent 設定，並自動建立 `clawd` agent；Clawd 每次啟動都會從內建的 `kiro_default` 重新同步它，盡量和預設 agent 保持一致。macOS 與 Windows 上狀態動效已驗證可用；需要時可用 `kiro-cli --agent clawd` 或在工作階段內執行 `/agent swap clawd` 啟用 hooks（Clawd 啟動時自動註冊，或執行 `npm run install:kiro-hooks`）
- **Kimi Code CLI（Kimi-CLI）** — 在 `~/.kimi/config.toml` 的 `[[hooks]]` 條目設定 command hooks（Clawd 啟動時自動註冊，或執行 `npm run install:kimi-hooks`）
- **Qwen Code** — 在 `~/.qwen/settings.json` 設定 command hooks（Clawd 啟動時自動註冊，或執行 `npm run install:qwen-hooks`）；支援狀態追蹤和 Qwen `PermissionRequest` 桌面權限對話框
- **ZCode** — 可選狀態 + 阻塞式 `PermissionRequest` hooks，寫入 `~/.zcode/cli/config.json` 的 `hooks.events.*`（從 Settings → AI 程式設計工具 安裝，或執行 `npm run install:zcode-hooks`）；Clawd 提供人工 Allow/Deny 權限氣泡，global 與 per-session 自動審批保持 defer。Clawd 會保留使用者明確設定的全域或單項 `enabled:false`，並且不會覆蓋第三方 `PermissionRequest` hook
- **CodeWhale** — 可選、僅同步狀態的 lifecycle hooks，寫入 `~/.codewhale/config.toml`（`[[hooks.hooks]]`；從 Settings → AI 程式設計工具 安裝，或執行 `npm run install:codewhale-hooks`）；Phase 1 只驅動狀態動畫，不接管權限或追蹤子代理
- **Reasonix CLI** — 可選、僅同步狀態的 command hooks，寫入 `<Reasonix home>/settings.json`（macOS/Linux：`~/.reasonix/settings.json`；Windows：`%APPDATA%\reasonix\settings.json`；從 Settings → AI 程式設計工具 安裝，或執行 `npm run install:reasonix-hooks`）；同步生命週期、工具、通知、壓縮與子代理結束動畫，權限留在 Reasonix 原生流程
- **opencode** — 可選 [外掛整合](https://opencode.ai/docs/plugins)，寫入 `~/.config/opencode/` 下目前生效的檔案（`config.json` → `opencode.json` → `opencode.jsonc`，後者優先）（從 Settings → AI 程式設計工具 安裝）；支援零延遲事件流與 Allow/Always/Deny 權限對話框。`task` 工具產生的子工作階段是 headless，不參與可見的多工作階段動畫聚合
- **MiMo Code** — 可選 [外掛整合](https://opencode.ai/docs/plugins)，寫入 `~/.config/mimocode/mimocode.jsonc`（從 Settings → AI 程式設計工具 安裝，或執行 `node hooks/mimocode-install.js`）；與 opencode 共用 `@mimo-ai/plugin` SDK 與權限行為，`task` 子工作階段同樣是 headless
- **Pi** — 以全域擴充功能整合，寫入 `~/.pi/agent/extensions/clawd-on-desk`（Clawd 啟動時自動註冊，或執行 `npm run install:pi-extension`）；僅同步互動式 Pi 工作階段生命週期和工具活動狀態，並保留 Pi 預設 YOLO 行為
- **OMP (oh-my-pi)** — 可選全域 extension，寫入 `~/.omp/agent/extensions/clawd-on-desk`（從 Settings → AI 程式設計工具 安裝，或執行 `npm run install:omp-extension`）；僅同步互動式會話與工具狀態。`session_stop` 先記錄完成候選，隨後終態 `agent_end` 確認沒有 extension 要求續跑才提交完成；已有社群 bridge `clawd-on-desk-omp.ts` 時保留它並跳過自身安裝
- **OpenClaw** — 靠 `~/.openclaw/openclaw.json` 裡的外掛路徑做狀態感知（OpenClaw 設定已存在時 Clawd 啟動會自動註冊，或執行 `npm run install:openclaw-plugin`）；Phase 1 針對本機 `openclaw tui --local` 工作階段，只驅動動畫，沒接權限對話框和終端機焦點
- **Hermes Agent** — [外掛整合](https://hermes-agent.org/)，寫入 Hermes 受管理的外掛目錄（偵測到 Hermes 後 Clawd 啟動時自動註冊，或執行 `npm run install:hermes-plugin`）；支援狀態、工作階段、SessionEnd 和終端機焦點
- **KiroCrew** — 可選、僅同步狀態的 gateway hooks，註冊到 `~/.kiro/crew/hooks.json`（從 Settings → AI 程式設計工具安裝，或執行 `npm run install:kirocrew-hooks`；解除安裝執行 `npm run uninstall:kirocrew-hooks`）。KiroCrew 透過背景 MCP gateway 執行 agent，Clawd 只橋接 AgentSpawn / UserPromptSubmit / PostToolUse / Stop 四個狀態事件；不註冊 PreToolUse、權限氣泡或 subagent 追蹤。請在 gateway 停止時安裝或解除安裝，之後再啟動 gateway 讓 hooks 生效。
- **Qoder** — 在 `~/.qoder/settings.json` 或 `~/.qoder-cn/settings.json` 設定 command hooks（從 Settings → AI 程式設計工具安裝，或執行 `npm run install:qoder-hooks`）；Clawd 不會建立未安裝版本的目錄。Windows CN worker runtime 1.1.69 已驗證；macOS/Linux CN 尚未驗證。**僅同步狀態**：Phase 1 只驅動動畫，權限請求僅以通知方式觀察，Clawd 不顯示權限對話框也不代答，所有 Allow / Deny 都在 Qoder 自己的權限流程完成
- **QoderWork** — 可選、僅同步狀態的 command hooks，寫入 `~/.qoderwork/settings.json`（從 Settings → AI 程式設計工具 安裝，或執行 `npm run install:qoderwork-hooks`）；Phase 1 驅動動畫與 Session HUD，權限事件作為正常工作靜默觀察，所有 Allow / Deny 留在 QoderWork 原生流程
- **QwenWork（千問辦公）** — 在 `~/.QwenWorkCN/settings.json` 設定 hook-only / state-only command hooks（從 Settings → AI 程式設計工具 安裝，或執行 `npm run install:qwenwork-hooks`，解除安裝用 `npm run uninstall:qwenwork-hooks`）；目前只支援 macOS / Windows 桌面版——[qwenwork.cn/download](https://qwenwork.cn/download) 沒有 Linux 版，因此也不提供 WSL Pair。Phase 1 驅動動畫與 Session HUD；`PermissionRequest` / `PermissionDenied` 僅作觀察並對應到 `working`，hook stdout 恆為 `{}`，Clawd 不產生 allow/deny，權限唯一決策者是 QwenWork 自己的流程。沒有 startup recovery：桌面主程序長駐，不代表正在執行任務
- **DeepSeek Harness** — 實驗性整合，支援 DSH 的 web profile 與 DeepSeek Harness 桌面版（macOS / Windows），透過 Clawd 管理的 DSH 行程內 plugin 運作。公開 session 事件會依 session 順序驅動 Clawd 狀態，公開的阻塞式 `approval/request` 可顯示 Allow Once / Deny 氣泡；無決定時一律交還給 DSH 自己的審批流程（web 的 answerer，或桌面版自己的審批框）。`ask_user_question` 完全留在 DSH 原生 provider，Clawd 從不讀取 DSH projection 儲存內容。詳見 [DeepSeek Harness 指南](dsh-setup.md)
- **TraeCode (Trae CN)** — 實驗性、僅狀態同步的 hook 整合，寫入 `~/.trae-cn/hooks.json`（從 Settings → AI 程式設計工具 安裝，或執行 `npm run install:traecode-hooks`；解除安裝用 `npm run uninstall:traecode-hooks`）。須在 Trae 手動開啟 hooks（**Settings → Hooks → Enable**，執行模式選 **Sandbox**；見 [Trae 官方 hooks 文件](https://docs.trae.cn/ide/automate-actions-with-hooks)）。首版僅支援 Trae 中國版；Clawd 從第一則提問推導會話標題，不接管權限，也沒有 `SessionEnd`，關閉的會話由桌面端閒置逾時清理。
- **MiniMax Code** — 實驗性、僅同步狀態的本地插件，寫入 `<MINIMAX_DATA_DIR 或 MAVIS_DATA_DIR 或 ~/.minimax>/plugins/clawd-state/`（從 Settings → AI 程式設計工具 安裝，或執行 `npm run install:minimax-hooks`；解除安裝用 `npm run uninstall:minimax-hooks`）。支援 mcode CLI 與桌面應用，上報 10 個狀態事件（含 `SessionEnd`）；handler 的 1–10 秒上限無法承載阻塞式人工審批，因此不註冊 `PermissionRequest`，stdout 恆為 `{}`，權限留在 MiniMax。若未載入，可執行 `mcode plugin enable clawd-state@local` 或在插件面板啟用；標題保留首條提問
- **多 Agent 並存** — 多個 Agent 可以同時跑，Clawd 會獨立追蹤每個工作階段
