# 機能

[README に戻る](../../README.ja-JP.md)

## アニメーションと操作

- **リアルタイムな状態認識** — agent hook とログポーリングが Clawd のアニメーションを自動で切り替えます
- **12 種類のアニメーション状態** — idle、thinking、typing、building、headphones groove、multi-subagent juggling、error、happy、notification、sweeping、carrying、sleeping
- **Codex Pet インポート** — `Settings...` → `Theme` から Codex Pet zip パッケージをインポートすると、Clawd が atlas アニメーションを管理テーマに変換します
- **視線追従** — idle 状態では Clawd がカーソルを追い、体の傾きや影の伸びも変化します
- **睡眠シーケンス** — 60 秒アイドルが続くと、あくび、うとうと、倒れ込み、睡眠へ移行します。マウス移動で驚いて起きるアニメーションが再生されます
- **クリックリアクション** — ダブルクリックでつつき、4 回クリックでじたばたします
- **どの状態からでもドラッグ** — いつでも Clawd をつかめます（Pointer Capture により素早いフリックでも取り落としません）。離すと元の状態へ戻ります
- **Mini mode** — 右端へドラッグ、または右クリックの「Mini Mode」で有効化。Clawd が画面端に隠れ、ホバーで顔を出し、mini 通知やお祝い、放物線ジャンプの遷移を行います

## 権限バブル

- **アプリ内権限レビュー** — Claude Code、Codex CLI、CodeBuddy、opencode、MiMo Code がツール権限を要求すると、ターミナルで待つ代わりに Clawd がフローティングバブルカードを表示します
- **許可 / 拒否 / エージェント固有の追加操作** — ワンクリックで承認または拒否できます。対応エージェントでは permission rule や `Always` 操作も利用できます
- **グローバルホットキー** — 最新の権限バブルに対して `Ctrl+Shift+Y` で許可、`Ctrl+Shift+N` で拒否（バブル表示中だけ登録されます）
- **スタックレイアウト** — 複数の権限リクエストは右下から上方向へ積み重なります
- **自動消去** — 先にターミナルで回答した場合、バブルは自動的に消えます
- **エージェントごとの切り替え** — `Settings...` → `AI コーディングツール` でエージェントのカードを展開し、`権限リクエストを Clawd の吹き出しで表示` をオフにすると、そのエージェント自身のターミナル/TUI に確認を残せます

## リモート通知

- **Telegram / Feishu（Lark）** — インタラクティブなリモート承認：権限リクエストをスマートフォンへ転送し、デスクトップに戻らず Allow / Deny できます
- **Slack** — **通知専用**：Slack Incoming Webhook（または任意の `xoxb-` Bot Token + channel id）を使い、タスクの**完了**、**エラー**、**権限リクエスト**を Block Kit カードで送信します。このバージョンでは Slack から Allow / Deny はできません。権限メッセージは通知のみで、判断はデスクトップアプリで行います。Telegram / Feishu と同じリモート承認設定にあり、secret は prefs 外のローカル env ファイルに保存されます（macOS / Linux は `0600`、Windows は AppData ACL）。未設定またはオフライン時は安全にフォールバックします。メッセージには session title、folder、host name が含まれる場合があるため、private channel を推奨します。詳細は [Slack 通知ガイド](slack-notifications.md)

## セッション情報

- **マルチセッション追跡** — すべてのエージェントのセッションから、優先度の最も高い状態を解決します
- **サブエージェント認識** — サブエージェント 1 個で headphones groove、2 個以上で three-ball juggling
- **Sessions dashboard + HUD** — 右クリックまたは tray → `Open Dashboard` から live session、最近のイベント、エイリアス、ターミナルジャンプを確認できます。Clawd の近くにはコンパクトな HUD が表示され、現在の live session を見失いません
- **ターミナルフォーカス** — Dashboard/HUD の操作で特定セッションのターミナルへジャンプできます。notification/attention 状態では関連するターミナルを自動で前面にします
- **プロセス生存確認** — 対応エージェントのプロセスがクラッシュまたは終了したことを検知し、孤立セッションを片付けます
- **起動時リカバリー** — Clawd の再起動時に対応エージェントがまだ動いていれば、眠らずに起きたままになります

## モバイルコンパニオン（PWA）

- **スマホでライブミラー** — `Settings...` → `Mobile / PWA` を有効にし、スマホでペアリング URL を開くと、Clawd Mobile ウェブアプリがエージェントのセッションと状態をリアルタイムに表示します
- **読み取り専用設計** — LAN ブリッジは状態のブロードキャストのみを行い、スマホから PC を操作することはできません（リモート承認はロードマップにあります）
- **LAN 限定 + トークン保護** — ペアリングにはトークンが必要で、トークンは猶予期間つきで自動ローテーションされ、ワンクリックで再生成・リセットできます
- **インストール可能** — PWA なので、ホーム画面に追加すればアプリのように使えます
> モバイルコンパニオンのラインは、最初のプロトタイプからトークンローテーションまで、コアコントリビューター [@Bynlk](https://github.com/Bynlk) が作り上げ、リードしています。ネイティブ Android アプリを備えた姉妹プロジェクト [clawd-on-mobile](https://github.com/Bynlk/clawd-on-mobile) も同氏がメンテナンスしています。

## システム

- **クリック透過** — 透明部分のクリックは背面ウィンドウへ通り、Clawd の体だけが操作対象になります
- **位置の記憶** — 再起動後も最後に置いた場所を覚えます（mini mode を含む）
- **単一インスタンスロック** — Clawd ウィンドウの重複起動を防ぎます
- **自動起動** — Claude Code の SessionStart hook により、Clawd が起動していない場合に自動で起動できます
- **Do Not Disturb** — 右クリックまたは tray メニューから sleep mode に入り、起こすまで hook event をすべて抑制します。DND 中は権限バブルも抑制されます。Codex、opencode、MiMo Code はネイティブプロンプトに戻り、Claude Code と CodeBuddy は組み込みの権限フローに戻ります。Antigravity と Pi は state-only です
- **効果音** — タスク完了や権限リクエスト時に短い音を鳴らします（システムトレイまたは設定から切り替え、10 秒クールダウン、DND 中は自動ミュート）
- **システムトレイ** — DND mode、自動起動、更新確認
- **i18n** — English、簡体中文、繁体中文、Korean、Japanese、Português (Brasil)、Español UI。設定 → 一般から切り替えできます
- **自動更新** — GitHub Releases を確認します。Windows では終了時に NSIS 更新を適用し、macOS/Linux では clone したリポジトリから実行している場合に `git pull` + restart を行います

## マルチディスプレイ

Clawd はマルチモニター環境に適応します。起動したディスプレイに合わせて比例サイズを決め、縦長モニターでは読みやすさを保つために上限付きで拡大し、ディスプレイ間のドラッグにも対応します。

<p align="center"><sub>実際のマルチモニター挙動は、<a href="../../assets/videos/clawd-multi-monitor-demo.mp4">このリポジトリ内のデモ動画</a>で確認できます。</sub></p>

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

初心者から上級者までの段階別パス、`theme.json` のフィールドリファレンス、アセットガイドラインを含む完全な作成ガイドは [docs/guides/guide-theme-creation.md](guide-theme-creation.md) を参照してください。

> サードパーティ製 SVG ファイルは、セキュリティのため自動で sanitize されます。

## Roadmap

今後検討したい項目です。

- `codex.exe` PID からのプロセスツリー lookup による Codex ターミナルフォーカス
- アプリのクリーン削除用 hook uninstall script
- モバイルコンパニオン: スマホからのリモート権限承認（[@Bynlk](https://github.com/Bynlk) 主導で進行中）
