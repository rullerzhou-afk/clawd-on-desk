<p align="center">
  <img src="assets/tray-icon.png" width="128" alt="Clawd">
</p>
<h1 align="center">Clawd on Desk</h1>
<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="README.zh-CN.md">中文版</a>
  ·
  <a href="README.zh-TW.md">繁體中文</a>
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
  <img src="assets/hero.gif" alt="Clawd on Desk のアニメーションデモ。AI コーディングエージェントの状態に合わせて、ピクセルのカニが睡眠、思考、ツール実行中のタイピング、サブエージェント 1 個ではヘッドホングルーヴ、複数では3ボールジャグリング、権限リクエストの通知、タスク完了後のお祝いへリアルタイムに切り替わります。Claude Code、Codex、Cursor、Copilot、Gemini、Pi、OpenClaw などに対応しています。">
</p>

Clawd はデスクトップに住むペットで、AI コーディングエージェントが今何をしているかにリアルタイムで反応します。長いタスクを開始したら席を外し、Clawd が完了を知らせたら戻ってくるだけです。

プロンプトを入力すると考え、ツールが動くとタイピングし、サブエージェントが動くとヘッドホングルーヴや3ボールジャグリングになり、権限確認ではカードを表示し、タスク完了時には喜び、離席中は眠ります。組み込みテーマとして **Clawd**（ピクセルのカニ）、**Calico**（三毛猫）、**Cloudling**（云宝）を同梱し、カスタムテーマと Codex Pet アニメーションパックのインポートにも対応しています。

> Windows 11、macOS、Ubuntu/Linux に対応しています。Windows リリースでは x64 と ARM64 のインストーラーを個別に提供します。ソースから実行するには Node.js が必要です。**Claude Code**、**Codex CLI**、**Copilot CLI**、**Gemini CLI**、**Cursor Agent**、**CodeBuddy**、**Kiro CLI**、**Kimi Code CLI (Kimi-CLI)**、**opencode**、**Pi**、**OpenClaw**、**Hermes Agent** と連携します。

## 機能

### マルチエージェント対応
- **Claude Code** — command hook と HTTP permission hook による完全統合
- **Codex CLI** — official hooks を主経路にし、JSONL フォールバック（`~/.codex/sessions/`）も利用。自動登録され、実際の権限バブルに対応
- **Copilot CLI** — `~/.copilot/hooks/hooks.json` の command hook に対応
- **Gemini CLI** — `~/.gemini/settings.json` の command hook に対応（Clawd 起動時に自動登録、または `npm run install:gemini-hooks`）
- **Cursor Agent** — `~/.cursor/hooks.json` の [Cursor IDE hooks](https://cursor.com/docs/agent/hooks) に対応（Clawd 起動時に自動登録、または `npm run install:cursor-hooks`）
- **CodeBuddy** — `~/.codebuddy/settings.json` 経由で Claude Code 互換の command hook と HTTP permission hook に対応（Clawd 起動時に自動登録、または `node hooks/codebuddy-install.js`）
- **Kiro CLI** — `~/.kiro/agents/` 配下のカスタムエージェント設定に command hook を注入。Clawd 起動時には Kiro 組み込みの `kiro_default` から再同期される `clawd` エージェントも自動作成されるため、`kiro-cli --agent clawd` または `/agent swap clawd` で挙動差を抑えながら hook を利用できます（Clawd 起動時に自動登録、または `npm run install:kiro-hooks`）。state hook は macOS と Windows で検証済みです。
- **Kimi Code CLI (Kimi-CLI)** — `~/.kimi/config.toml` の command hook（`[[hooks]]` エントリ）に対応（Clawd 起動時に自動登録、または `npm run install:kimi-hooks`）
- **opencode** — `~/.config/opencode/opencode.json` 経由の [plugin integration](https://opencode.ai/docs/plugins) に対応（Clawd 起動時に自動登録）。遅延のないイベントストリーミング、Allow/Always/Deny 付きの権限バブル、`task` tool による並列サブエージェント生成時の building アニメーションに対応
- **Pi** — `~/.pi/agent/extensions/clawd-on-desk` のグローバル extension で連携します（Clawd 起動時に自動登録、または `npm run install:pi-extension`）。インタラクティブな Pi セッションのライフサイクルとツール活動だけを状態同期し、Pi のデフォルト YOLO 動作を維持します
- **OpenClaw** — `~/.openclaw/openclaw.json` の plugin path で state-only 連携します（OpenClaw config が既にある場合は Clawd 起動時に自動登録、または `npm run install:openclaw-plugin`）。Phase 1 はローカル `openclaw tui --local` セッションのアニメーションのみを対象とし、権限バブルやターミナルフォーカスには対応しません
- **Hermes Agent** — Hermes の管理 plugin ディレクトリ経由の [plugin integration](https://hermes-agent.org/)（Hermes インストール済みの場合は Clawd 起動時に自動登録、または `npm run install:hermes-plugin`）。状態、セッション、SessionEnd、ターミナルフォーカスに対応
- **複数エージェントの共存** — すべてのエージェントを同時に動かせます。Clawd は各セッションを個別に追跡します

### アニメーションと操作
- **リアルタイムな状態認識** — agent hook とログポーリングが Clawd のアニメーションを自動で切り替えます
- **12 種類のアニメーション状態** — idle、thinking、typing、building、headphones groove、multi-subagent juggling、error、happy、notification、sweeping、carrying、sleeping
- **Codex Pet インポート** — `Settings...` → `Theme` から Codex Pet zip パッケージをインポートすると、Clawd が atlas アニメーションを管理テーマに変換します
- **視線追従** — idle 状態では Clawd がカーソルを追い、体の傾きや影の伸びも変化します
- **睡眠シーケンス** — 60 秒アイドルが続くと、あくび、うとうと、倒れ込み、睡眠へ移行します。マウス移動で驚いて起きるアニメーションが再生されます
- **クリックリアクション** — ダブルクリックでつつき、4 回クリックでじたばたします
- **どの状態からでもドラッグ** — いつでも Clawd をつかめます（Pointer Capture により素早いフリックでも取り落としません）。離すと元の状態へ戻ります
- **Mini mode** — 右端へドラッグ、または右クリックの「Mini Mode」で有効化。Clawd が画面端に隠れ、ホバーで顔を出し、mini 通知やお祝い、放物線ジャンプの遷移を行います

### 権限バブル
- **アプリ内権限レビュー** — Claude Code、Codex CLI、CodeBuddy、opencode がツール権限を要求すると、ターミナルで待つ代わりに Clawd がフローティングバブルカードを表示します
- **許可 / 拒否 / エージェント固有の追加操作** — ワンクリックで承認または拒否できます。対応エージェントでは permission rule や `Always` 操作も利用できます
- **グローバルホットキー** — 最新の権限バブルに対して `Ctrl+Shift+Y` で許可、`Ctrl+Shift+N` で拒否（バブル表示中だけ登録されます）
- **スタックレイアウト** — 複数の権限リクエストは右下から上方向へ積み重なります
- **自動消去** — 先にターミナルで回答した場合、バブルは自動的に消えます
- **エージェントごとの切り替え** — `Settings...` → `Agents` でエージェントを選び、`Show pop-up bubbles` をオフにすると、そのエージェント自身のターミナル/TUI に確認を残せます

### セッション情報
- **マルチセッション追跡** — すべてのエージェントのセッションから、優先度の最も高い状態を解決します
- **サブエージェント認識** — サブエージェント 1 個で headphones groove、2 個以上で three-ball juggling
- **Sessions dashboard + HUD** — 右クリックまたは tray → `Open Dashboard` から live session、最近のイベント、エイリアス、ターミナルジャンプを確認できます。Clawd の近くにはコンパクトな HUD が表示され、現在の live session を見失いません
- **ターミナルフォーカス** — Dashboard/HUD の操作で特定セッションのターミナルへジャンプできます。notification/attention 状態では関連するターミナルを自動で前面にします
- **プロセス生存確認** — 対応エージェントのプロセスがクラッシュまたは終了したことを検知し、孤立セッションを片付けます
- **起動時リカバリー** — Clawd の再起動時に対応エージェントがまだ動いていれば、眠らずに起きたままになります

### システム
- **クリック透過** — 透明部分のクリックは背面ウィンドウへ通り、Clawd の体だけが操作対象になります
- **位置の記憶** — 再起動後も最後に置いた場所を覚えます（mini mode を含む）
- **単一インスタンスロック** — Clawd ウィンドウの重複起動を防ぎます
- **自動起動** — Claude Code の SessionStart hook により、Clawd が起動していない場合に自動で起動できます
- **Do Not Disturb** — 右クリックまたは tray メニューから sleep mode に入り、起こすまで hook event をすべて抑制します。DND 中は権限バブルも抑制されます。Codex と opencode はネイティブプロンプトに戻り、Claude Code と CodeBuddy は組み込みの権限フローに戻ります。Antigravity と Pi は state-only です
- **効果音** — タスク完了や権限リクエスト時に短い音を鳴らします（右クリックメニューで切り替え、10 秒クールダウン、DND 中は自動ミュート）
- **システムトレイ** — サイズ変更（S/M/L）、DND mode、言語切り替え、自動起動、更新確認
- **i18n** — English、簡体中文、繁体中文、Korean、Japanese UI。右クリックメニューまたは tray から切り替えできます
- **自動更新** — GitHub Releases を確認します。Windows では終了時に NSIS 更新を適用し、macOS/Linux では clone したリポジトリから実行している場合に `git pull` + restart を行います

## アニメーション

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

event-to-state mapping、mini mode、クリックリアクションの詳細: **[docs/guides/state-mapping.md](docs/guides/state-mapping.md)**

## マルチディスプレイ

Clawd はマルチモニター環境に適応します。起動したディスプレイに合わせて比例サイズを決め、縦長モニターでは読みやすさを保つために上限付きで拡大し、ディスプレイ間のドラッグにも対応します。

<p align="center"><sub>実際のマルチモニター挙動は、<a href="assets/videos/clawd-multi-monitor-demo.mp4">このリポジトリ内のデモ動画</a>で確認できます。</sub></p>

## クイックスタート

通常利用では、**[GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest)** から最新のビルド済みインストーラーをダウンロードしてください。

- **Windows**: `Clawd-on-Desk-Setup-<version>-x64.exe` または `Clawd-on-Desk-Setup-<version>-arm64.exe`
- **macOS**: `.dmg`
- **Linux**: `.AppImage` または `.deb`

インストール後に Clawd を起動してください。対応エージェントの hook/plugin は起動時に自動同期されます。

ソースからの実行は、コントリビュート、未リリースコードのテスト、または連携のデバッグを行う場合だけを推奨します。ソースインストールでは Electron/build tooling をダウンロードし、大きな `node_modules` ツリーが作成されることがあります。

```bash
# リポジトリを clone
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# 依存関係をインストール
npm install

# Clawd を起動（起動時に Claude Code hooks を自動登録）
npm start
```

**Claude Code** と **Codex CLI** は自動登録される hook により、そのまま動作します。**Gemini CLI**、**Cursor Agent**、**CodeBuddy**、**Kiro CLI**、**Kimi Code CLI (Kimi-CLI)**、**opencode**、**Pi**、**OpenClaw**、**Hermes Agent** は、インストール済みかつ初期化済みであれば Clawd 起動時に自動登録されます。**Copilot CLI** だけは一度だけ hook setup が必要です。Remote SSH、WSL、macOS/Linux のプラットフォーム別メモも含めた詳細: **[docs/guides/setup-guide.md](docs/guides/setup-guide.md)**

公式の `Codex + WSL` ステータス、Clawd の現在の実装境界、そして誤解しやすい理由については、こちらを参照してください: **[docs/guides/codex-wsl-clarification.md](docs/guides/codex-wsl-clarification.md)**

## 既知の制限

一部のエージェントには機能差があります（権限バブルなし、ポーリング遅延、ターミナルフォーカスなしなど）。完全な表はこちら: **[docs/guides/known-limitations.md](docs/guides/known-limitations.md)**

## カスタムテーマ

Clawd はカスタムテーマに対応しています。標準のカニを、自分のキャラクターやアニメーションに置き換えられます。既存の Codex Pet パッケージがある場合は、`Settings...` → `Theme` → `Import pet zip` から取り込むと、Clawd が atlas を管理テーマへ自動変換します。

**クイックスタート:**
1. テーマを scaffold します。
   ```bash
   node scripts/create-theme.js my-theme
   # または
   npm run create-theme -- my-theme
   ```
   引数なしでも動作します。ユーザーテーマディレクトリ内に、次に利用可能な `my-theme` scaffold を作成します。
2. `theme.json` を編集し、アセット（SVG、GIF、APNG、WebP、PNG、JPG、JPEG）を作成します
3. Clawd を再起動するか、`Settings...` → `Theme` → 自分のテーマを選択します

**最小構成のテーマ:** SVG 1 個（視線追従付き idle）+ GIF/APNG 7 個（thinking、working、error、happy、notification、sleeping、waking）。視線追従を無効にすれば、すべての状態で任意の形式を利用できます。

配布前にテーマを検証してください。
```bash
node scripts/validate-theme.js path/to/your-theme
```

`Settings...` → `Theme` のテーマカードには、`Tracked idle`、`Static theme`、`Mini`、`Direct sleep`、`No reactions` などの capability badge が表示されるため、ユーザーは切り替える前にテーマの対応範囲を確認できます。

初心者から上級者までの段階別パス、`theme.json` のフィールドリファレンス、アセットガイドラインを含む完全な作成ガイドは [docs/guides/guide-theme-creation.md](docs/guides/guide-theme-creation.md) を参照してください。

> サードパーティ製 SVG ファイルは、セキュリティのため自動で sanitize されます。

### Roadmap

今後検討したい項目です。

- `codex.exe` PID からのプロセスツリー lookup による Codex ターミナルフォーカス
- Copilot CLI hooks の自動登録（Claude Code と同様）
- テーマレジストリとアプリ内ダウンロード
- アプリのクリーン削除用 hook uninstall script

## コントリビュート

Clawd on Desk はコミュニティ主導のプロジェクトです。バグ報告、機能案、Pull Request を歓迎します。相談したい場合は [issue](https://github.com/rullerzhou-afk/clawd-on-desk/issues) を開くか、直接 PR を送ってください。

### メンテナー

<table>
  <tr>
    <td align="center" valign="top" width="140"><a href="https://github.com/rullerzhou-afk"><img src="https://github.com/rullerzhou-afk.png" width="72" style="border-radius:50%" /><br /><sub><b>@rullerzhou-afk</b><br />鹿鹿 · creator</sub></a></td>
    <td align="center" valign="top" width="140"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="72" style="border-radius:50%" /><br /><sub><b>@YOIMIYA66</b><br />maintainer</sub></a></td>
  </tr>
</table>

### コントリビューター

Clawd をより良くしてくれたすべての方に感謝します。

<details>
<summary>コントリビューター 48 人をすべて表示</summary>

<table>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/PixelCookie-zyf"><img src="https://github.com/PixelCookie-zyf.png" width="50" style="border-radius:50%" /><br /><sub>PixelCookie-zyf</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/yujiachen-y"><img src="https://github.com/yujiachen-y.png" width="50" style="border-radius:50%" /><br /><sub>yujiachen-y</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/AooooooZzzz"><img src="https://github.com/AooooooZzzz.png" width="50" style="border-radius:50%" /><br /><sub>AooooooZzzz</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/purefkh"><img src="https://github.com/purefkh.png" width="50" style="border-radius:50%" /><br /><sub>purefkh</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Tobeabellwether"><img src="https://github.com/Tobeabellwether.png" width="50" style="border-radius:50%" /><br /><sub>Tobeabellwether</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Jasonhonghh"><img src="https://github.com/Jasonhonghh.png" width="50" style="border-radius:50%" /><br /><sub>Jasonhonghh</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/crashchen"><img src="https://github.com/crashchen.png" width="50" style="border-radius:50%" /><br /><sub>crashchen</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/hongbigtou"><img src="https://github.com/hongbigtou.png" width="50" style="border-radius:50%" /><br /><sub>hongbigtou</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/InTimmyDate"><img src="https://github.com/InTimmyDate.png" width="50" style="border-radius:50%" /><br /><sub>InTimmyDate</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/NeizhiTouhu"><img src="https://github.com/NeizhiTouhu.png" width="50" style="border-radius:50%" /><br /><sub>NeizhiTouhu</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/xu3stones-cmd"><img src="https://github.com/xu3stones-cmd.png" width="50" style="border-radius:50%" /><br /><sub>xu3stones-cmd</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/androidZzT"><img src="https://github.com/androidZzT.png" width="50" style="border-radius:50%" /><br /><sub>androidZzT</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Ye-0413"><img src="https://github.com/Ye-0413.png" width="50" style="border-radius:50%" /><br /><sub>Ye-0413</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/WanfengzzZ"><img src="https://github.com/WanfengzzZ.png" width="50" style="border-radius:50%" /><br /><sub>WanfengzzZ</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/TaoXieSZ"><img src="https://github.com/TaoXieSZ.png" width="50" style="border-radius:50%" /><br /><sub>TaoXieSZ</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/ssly"><img src="https://github.com/ssly.png" width="50" style="border-radius:50%" /><br /><sub>ssly</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/stickycandy"><img src="https://github.com/stickycandy.png" width="50" style="border-radius:50%" /><br /><sub>stickycandy</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Rladmsrl"><img src="https://github.com/Rladmsrl.png" width="50" style="border-radius:50%" /><br /><sub>Rladmsrl</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/YOIMIYA66"><img src="https://github.com/YOIMIYA66.png" width="50" style="border-radius:50%" /><br /><sub>YOIMIYA66</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Kevin7Qi"><img src="https://github.com/Kevin7Qi.png" width="50" style="border-radius:50%" /><br /><sub>Kevin7Qi</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/sefuzhou770801-hub"><img src="https://github.com/sefuzhou770801-hub.png" width="50" style="border-radius:50%" /><br /><sub>sefuzhou770801-hub</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/Tonic-Jin"><img src="https://github.com/Tonic-Jin.png" width="50" style="border-radius:50%" /><br /><sub>Tonic-Jin</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/seoki180"><img src="https://github.com/seoki180.png" width="50" style="border-radius:50%" /><br /><sub>seoki180</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/sophie-haynes"><img src="https://github.com/sophie-haynes.png" width="50" style="border-radius:50%" /><br /><sub>sophie-haynes</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/PeterShanxin"><img src="https://github.com/PeterShanxin.png" width="50" style="border-radius:50%" /><br /><sub>PeterShanxin</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/CHIANGANGSTER"><img src="https://github.com/CHIANGANGSTER.png" width="50" style="border-radius:50%" /><br /><sub>CHIANGANGSTER</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/JaeHyeon-KAIST"><img src="https://github.com/JaeHyeon-KAIST.png" width="50" style="border-radius:50%" /><br /><sub>JaeHyeon-KAIST</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/hhhzxyhhh"><img src="https://github.com/hhhzxyhhh.png" width="50" style="border-radius:50%" /><br /><sub>hhhzxyhhh</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/TVpoet"><img src="https://github.com/TVpoet.png" width="50" style="border-radius:50%" /><br /><sub>TVpoet</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/zeus6768"><img src="https://github.com/zeus6768.png" width="50" style="border-radius:50%" /><br /><sub>zeus6768</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/anhtrinh919"><img src="https://github.com/anhtrinh919.png" width="50" style="border-radius:50%" /><br /><sub>anhtrinh919</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/tomaioo"><img src="https://github.com/tomaioo.png" width="50" style="border-radius:50%" /><br /><sub>tomaioo</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/v-avuso"><img src="https://github.com/v-avuso.png" width="50" style="border-radius:50%" /><br /><sub>v-avuso</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/livlign"><img src="https://github.com/livlign.png" width="50" style="border-radius:50%" /><br /><sub>livlign</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/tongguang2"><img src="https://github.com/tongguang2.png" width="50" style="border-radius:50%" /><br /><sub>tongguang2</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/Ziy1-Tan"><img src="https://github.com/Ziy1-Tan.png" width="50" style="border-radius:50%" /><br /><sub>Ziy1-Tan</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/tatsuyanakanogaroinc"><img src="https://github.com/tatsuyanakanogaroinc.png" width="50" style="border-radius:50%" /><br /><sub>tatsuyanakanogaroinc</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/yeonhub"><img src="https://github.com/yeonhub.png" width="50" style="border-radius:50%" /><br /><sub>yeonhub</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/joshua-wu"><img src="https://github.com/joshua-wu.png" width="50" style="border-radius:50%" /><br /><sub>joshua-wu</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/nmsn"><img src="https://github.com/nmsn.png" width="50" style="border-radius:50%" /><br /><sub>nmsn</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/sunnysonx"><img src="https://github.com/sunnysonx.png" width="50" style="border-radius:50%" /><br /><sub>sunnysonx</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/YuChenYunn"><img src="https://github.com/YuChenYunn.png" width="50" style="border-radius:50%" /><br /><sub>YuChenYunn</sub></a></td>
  </tr>
  <tr>
    <td align="center" valign="top" width="110"><a href="https://github.com/jhseo-b"><img src="https://github.com/jhseo-b.png" width="50" style="border-radius:50%" /><br /><sub>jhseo-b</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/Hwasowl"><img src="https://github.com/Hwasowl.png" width="50" style="border-radius:50%" /><br /><sub>Hwasowl</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/XiangZheng2002"><img src="https://github.com/XiangZheng2002.png" width="50" style="border-radius:50%" /><br /><sub>XiangZheng2002</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/keiyo118"><img src="https://github.com/keiyo118.png" width="50" style="border-radius:50%" /><br /><sub>keiyo118</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/pan93412"><img src="https://github.com/pan93412.png" width="50" style="border-radius:50%" /><br /><sub>pan93412</sub></a></td>
    <td align="center" valign="top" width="110"><a href="https://github.com/taehwanis"><img src="https://github.com/taehwanis.png" width="50" style="border-radius:50%" /><br /><sub>taehwanis</sub></a></td>
  </tr>
</table>

</details>

## 謝辞

- Clawd のピクセルアートは [@marciogranzotto](https://github.com/marciogranzotto) による [clawd-tank](https://github.com/marciogranzotto/clawd-tank) を参考にしています
- [LINUX DO](https://linux.do/) コミュニティで共有されました

## ライセンス

ソースコードは [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0) のもとでライセンスされています。

**Artwork および同梱テーマアセット（`assets/` と `themes/*/assets/` を含む）は AGPL-3.0 の対象外です。** すべての権利は各著作権者に帰属します。詳細は [assets/LICENSE](assets/LICENSE) と以下の注記を参照してください。

- **Clawd** キャラクターは [Anthropic](https://www.anthropic.com) の所有物です。このプロジェクトは非公式のファンプロジェクトであり、Anthropic との提携または承認を受けたものではありません。
- **Calico cat (三毛猫)** のアートワークは 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) によるものです。All rights reserved.
- **Cloudling (云宝)** のアートワークは 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) によるものです。All rights reserved. Cloudling のビジュアル方針には OpenAI Codex ロゴへのオマージュが含まれています。Codex/OpenAI の標章は OpenAI に帰属し、このプロジェクトは OpenAI との提携または承認を受けたものではありません。
- **サードパーティのコントリビューション**: 著作権は各アーティストに帰属します。
