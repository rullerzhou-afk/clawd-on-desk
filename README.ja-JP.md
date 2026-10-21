<p align="center">
  <img src="assets/icon.png" width="128" alt="Clawd">
</p>

<div align="center">
  <h1>Clawd on Desk</h1>
  <p><b>AI コーディングエージェントの状態にリアルタイムで反応する、ピクセルのデスクトップペット。</b></p>
  <p><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ko-KR.md">한국어</a> · 日本語 · <a href="README.es.md">Español</a></p>
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/stargazers"><img src="https://img.shields.io/github/stars/rullerzhou-afk/clawd-on-desk?style=flat-square" alt="Stars"></a>
  <a href="https://github.com/rullerzhou-afk/clawd-on-desk/releases"><img src="https://img.shields.io/github/v/release/rullerzhou-afk/clawd-on-desk?label=version&style=flat-square" alt="Version"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square" alt="Platform">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge-flat.svg" alt="Mentioned in Awesome Claude Code"></a>
  <a href="https://discord.gg/VQsQZbZCPx"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&amp;logo=discord&amp;logoColor=white" alt="Discord"></a>
</div>

<p align="center">
  <img src="assets/hero.gif" alt="Clawd on Desk のアニメーションデモ。AI コーディングエージェントの状態に合わせて、ピクセルのカニが睡眠、思考、ツール実行中のタイピング、サブエージェント 1 個ではヘッドホングルーヴ、複数では3ボールジャグリング、権限リクエストの通知、タスク完了後のお祝いへリアルタイムに切り替わります。Claude Code、Codex、Cursor、Copilot、Gemini、Antigravity、Qwen、Pi、OMP、OpenClaw などに対応しています。">
</p>

長いタスクを始めたら席を外し、カニが完了を知らせたら戻るだけ。プロンプトを送ると考え、ツールが動くとタイピングし、サブエージェントが増えるとジャグリングし、承認が必要ならカードを出し、離席すると眠ります。

## 機能

- **リアルタイムの状態表示**: エージェントの hook とログで動く 12 種類のアニメーション、視線追従、睡眠シーケンス、クリック反応、画面端から覗くミニモード
- **主要ツールに対応**: Claude Code、Codex、Copilot、Gemini、Cursor、opencode、Kiro、Qwen など 20 以上、セッションごとに並行して追跡
- **権限バブル**: フローティングカードやグローバルホットキーでツール要求を Allow / Deny、または自動承認に切り替え
- **セッションを一目で**: ペットの横の HUD、ターミナルへ一発で戻れるライブセッションのダッシュボード、クォータリング、ローカルだけに保存されるリキャップ
- **席を外していても**: Telegram や Feishu/Lark からリモート承認、Slack 通知、読み取り専用のモバイル PWA でスマホからセッションを確認
- **自分好みに**: Clawd、Calico、Cloudling を内蔵、公式テーマのダウンロード、Codex Pet のインポート、自作テーマ
- **どこでコードを書いても**: Windows（x64 / ARM64）、macOS、Linux、Remote SSH と WSL に対応、UI は 7 言語

機能の詳細: **[docs/guides/features.ja-JP.md](docs/guides/features.ja-JP.md)**

## クイックスタート

**[GitHub Releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases/latest)** から最新のインストーラーをダウンロードしてください:

| プラットフォーム | ダウンロード |
|---|---|
| Windows | `Clawd-on-Desk-Setup-<version>-x64.exe` または `-arm64.exe` |
| macOS | `.dmg`、または `brew install --cask clawd-on-desk` |
| Linux | `.AppImage` または `.deb`（x86_64 では Homebrew も可） |

Clawd を起動すればすぐに反応し始めます。初回起動時に Claude Code と Codex が自動で接続され、ほかのエージェントは **Settings → AI コーディングツール** からワンクリックでインストールできます。

<details>
<summary><strong>ソースから実行</strong></summary>
<br/>

コントリビュート、未リリースコードのテスト、連携のデバッグをするときだけ必要です。ソースインストールでは Electron とビルドツールをダウンロードするため、`node_modules` が大きくなります。

```bash
# リポジトリを clone
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk

# 依存関係をインストール
npm install

# Clawd を起動（起動時に Claude Code と Codex の hooks を自動登録）
npm start
```

前提条件、Remote SSH、WSL、macOS / Linux の注意点: **[セットアップガイド](docs/guides/setup-guide.md)**

</details>

## 対応エージェント

> **Claude Code** · **Codex CLI** · **Copilot CLI** · **Gemini CLI** · **Antigravity CLI (agy)** · **Cursor Agent** · **CodeBuddy** · **WorkBuddy** · **Grok Build** · **Kiro CLI** · **KiroCrew** · **Kimi Code CLI (Kimi-CLI)** · **Qwen Code** · **ZCode** · **CodeWhale** · **opencode** · **MiMo Code** · **Pi** · **OMP** · **OpenClaw** · **Hermes Agent** · **Qoder** · **QoderWork** · **QwenWork（千问办公）** · **Reasonix CLI** · **DeepSeek Harness** · **TraeCode (Trae CN)** · **MiniMax Code**

Claude Code と Codex CLI は初回起動時に接続されます。ほかの連携は **Settings → AI コーディングツール** からインストールすると、Clawd が同期を保ちます。そのほかのローカルツールは [カスタム HTTP エージェント](docs/guides/custom-agent-http.md) のエンドポイントから状態を送れます。エージェントごとの詳細は **[対応エージェント](docs/guides/supported-agents.ja-JP.md)**、権限バブルがないエージェントなどの違いは **[既知の制限](docs/guides/known-limitations.md)** を参照してください。

## テーマ

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

**Clawd**（ピクセルのカニ）、**Calico**（三毛猫）、**Cloudling**（云宝）を内蔵しています。**Hash Sage**（哈希仙人）と **Whale-chan**（鲸鱼娘）は **Settings → テーマ** からダウンロードできる公式テーマで、同じ画面で Codex Pet の zip もインポートできます。自分で描くなら `npm run create-theme -- my-theme` を実行して **[テーマ作成ガイド](docs/guides/guide-theme-creation.md)** へ。イベントとアニメーションの対応: [状態マッピング](docs/guides/state-mapping.md)。

コミュニティツール: @receyuki による [Live2Pet](https://github.com/receyuki/live2pet) は、Live2D モデルを Clawd のテーマに変換します。

## ガイド

| ガイド | 内容 |
|---|---|
| [機能](docs/guides/features.ja-JP.md) | すべての機能の詳細 |
| [セットアップガイド](docs/guides/setup-guide.md) | ソースビルド、エージェント設定、Windows / macOS / Linux の注意点 |
| [権限の扱い](docs/guides/setup-guide.md#permission-handling-automation) | 毎回確認、質問プロンプトのみ、自動承認 |
| [Remote SSH](docs/guides/guide-remote-ssh.md) | リモートサーバー上のエージェントの状態と権限バブル |
| [Codex + WSL](docs/guides/codex-wsl-clarification.md) | WSL 内の Codex に対する Clawd の対応範囲 |
| [リモート承認](docs/guides/telegram-approval.md) | Telegram、[Feishu / Lark](docs/guides/feishu-lark-remote-approval.md)、[Slack 通知](docs/guides/slack-notifications.md) |
| [リキャップ](docs/guides/recap.md) | ローカルだけに保存されるアクティビティの振り返り |
| [カスタム HTTP エージェント](docs/guides/custom-agent-http.md) | まだ連携していないツールをつなぐ |
| [既知の制限](docs/guides/known-limitations.md) | エージェントごとの機能差 |
| [テーマ作成](docs/guides/guide-theme-creation.md) | 自作テーマの作成と検証 |

## コミュニティ

[Discord コミュニティ](https://discord.gg/VQsQZbZCPx)で、使い方の相談、テーマやデスクトップ環境の共有、アイデアの交換ができます。英語・中国語で気軽にご参加ください。バグ報告は追跡できるよう、[GitHub Issues](https://github.com/rullerzhou-afk/clawd-on-desk/issues) にお願いします。

## コントリビュート

Clawd on Desk はコミュニティ主導のプロジェクトです。バグ報告、機能案、Pull Request を歓迎します。相談したい場合は [issue](https://github.com/rullerzhou-afk/clawd-on-desk/issues) を開くか、直接 PR を送ってください。

### メンテナー

<p align="center">
  <img src="assets/readme/maintainers.svg" width="660" alt="Maintainers: @rullerzhou-afk (creator), @YOIMIYA66, @Bynlk (Mobile / PWA)">
</p>

### コントリビューター

Clawd をより良くしてくれたすべての方に感謝します。

<a href="https://github.com/rullerzhou-afk/clawd-on-desk/graphs/contributors">
  <img src="assets/readme/contributors.svg" width="900" alt="Clawd on Desk contributors">
</a>

## 謝辞

- Clawd のピクセルアートは [@marciogranzotto](https://github.com/marciogranzotto) による [clawd-tank](https://github.com/marciogranzotto/clawd-tank) を参考にしています
- [LINUX DO](https://linux.do/) コミュニティで共有されました

## ライセンス

ソースコードは [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0) のもとでライセンスされています。

**Artwork および同梱テーマアセット（`assets/` と `themes/*/assets/` を含む）は AGPL-3.0 の対象外です。** すべての権利は各著作権者に帰属します。詳細は [assets/LICENSE](assets/LICENSE) と以下の注記を参照してください。

- **Clawd** キャラクターは [Anthropic](https://www.anthropic.com) の所有物です。このプロジェクトは非公式のファンプロジェクトであり、Anthropic との提携または承認を受けたものではありません。
- **Calico cat (三毛猫)** のアートワークは 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) によるものです。All rights reserved.
- **Cloudling (云宝)** のアートワークは 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) によるものです。All rights reserved. Cloudling のビジュアル方針には OpenAI Codex ロゴへのオマージュが含まれています。Codex/OpenAI の標章は OpenAI に帰属し、このプロジェクトは OpenAI との提携または承認を受けたものではありません。
- **Whale-chan（鲸鱼娘）** は [`rullerzhou-afk/clawd-themes`](https://github.com/rullerzhou-afk/clawd-themes) から任意の公式テーマとして別途配布されます。元のキャラクター・設定・素材の権利は各原作者に帰属し、テーマは [Neko3000/deepseek-whalechan](https://github.com/Neko3000/deepseek-whalechan) に記載された ZipZipPipe と上善无形をクレジットします。鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk)) による新しいアニメーションとエフェクトは CC BY-NC-SA 4.0 です。全文はテーマパッケージをご覧ください。非公式・非商用のファン作品であり、DeepSeek との関係や承認はなく、本プロジェクトの AGPL-3.0 ソースライセンスの対象外です。
- **サードパーティのコントリビューション**: 著作権は各アーティストに帰属します。
