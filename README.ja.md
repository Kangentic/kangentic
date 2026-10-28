<!-- readme-translation source-blob=3c139f6ee74019ac75b29fddea661fd14d0b0846 -->
> これは `3c139f6` 時点の [README.md](README.md) の機械翻訳です。正式な版は英語版です。

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic のロゴ" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>カードをドラッグすると、エージェントが動き出します。</strong><br />
  AI コーディングエージェントのためのエージェント型開発環境です。
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="最新リリース" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm バージョン" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 ライセンス" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="To Do、Planning、Executing、Code Review の各列にタスクが並ぶ Kangentic のボード。実行中の各カードにはエージェントの最新メッセージが表示され、ボードの下には選択したエージェントのターミナルが開いています。ライブデモを開きます。" width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">ライブデモ</a> |
  <a href="https://www.kangentic.com/getting-started/">クイックスタート</a> |
  <a href="https://www.kangentic.com/overview/">ドキュメント</a>
</p>

<!-- language-switcher -->
<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">中文(简体)</a> |
  <a href="README.zh-TW.md">中文(繁體)</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.es.md">Español</a> |
  日本語 |
  <a href="README.ko.md">한국어</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.pt-BR.md">Português (Brasil)</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.cs.md">Čeština</a> |
  <a href="README.hu.md">Magyar</a>
</p>
<!-- /language-switcher -->

## できること

コーディングエージェントはタスクを単独でこなせますし、Git のワークツリーを使えば複数のエージェントを同時に実行できます。そうなると限界はあなた自身です。どのエージェントがプロンプト待ちか、どれが完了したか、各ブランチがどうなったかを把握しなければなりません。Kangentic はすべてのセッションを 1 つのボードにまとめ、あなたの対応が必要なものに印を付けます。

### 1 つのボードからエージェントを実行する

- **1 つのボードにすべてのエージェント。** 各カードには、モデル、コンテキストウィンドウの使用量、エージェントの最新の発言が表示され、対応が必要なカードには印が付きます。
- **Kangentic Mobile。** スマートフォンを一度ペアリングすれば、席を離れていてもエージェントの状況を確認し、エージェントが止まっている質問に答え、差分をレビューできます。接続はエンドツーエンドで暗号化され、Kangentic のリレーまたは自分でホストするリレーを経由します。[App Store](https://apps.apple.com/app/kangentic/id6794952339) または [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile) から入手できます。
- **15 種類のエージェント CLI。** Claude Code で計画して Codex で実装することも、すべてに 1 つの CLI を使うこともできます。Kangentic は、すでにお持ちの CLI を、すでに設定済みの認証情報で実行します。API キーもプロキシも Kangentic アカウントも不要です。
- **すべてのプロジェクトを 1 か所に。** リポジトリごとに専用のボードがあり、Agent Monitor ではすべてのリポジトリで実行中のエージェントを確認できます。
- **ボード上でレビュー。** Changes パネルには各タスクの差分とコミット履歴が表示されます。GitHub または Azure DevOps でリンクされた pull request は、その状態とマージ可能かどうかが表示されます。
- **無料でオープンソース。** AGPL-3.0 で、すべての機能が含まれ、有料プランはありません。

### ワークフローを形づくる

- **列。** 列の名前変更、追加、つなぎ替えを行い、ボードを自分の出荷の流れに合わせます。各列には独自のエージェント、モデル、effort、権限モードを設定できます。この設定は `kangentic.json` としてリポジトリと一緒にコミットされるため、チームメイトも同じボードを使えます。一方、タスクとエージェントセッションは各自のマシンに残ります。
- **自動化。** タスクが列に入ったとき、エージェントがターンを終えたとき、またはタスクが列を出たときに、列からエージェントへメッセージやスラッシュコマンドを送る、スクリプトを実行する、Webhook を呼び出す、通知する、タスクを次の列に移動する、といった操作を行えます。平易な言葉で書いた条件をエージェントが判定し、ステップを実行するかどうかを決めます。
- **ワークフロー。** ワークフローエージェントに概要を渡し、エージェントが計画したリンク付きタスクをレビューして、Start を押します。各タスクは、待機対象のタスクが Done に到達すると開始されます。1 つのワークフローで複数のプロジェクトにまたがることもできます。
- **ボードを操作するエージェント。** Kangentic の MCP サーバーを使うと、実行中のエージェントがタスクを作成したり、自分のカードを移動したり、過去の会話を検索したり、別のタスクのエージェントにメッセージを送ったりできます。そのため、プロンプトに書いたルールで作業を先に進められます。

## あなたに向いているか

**次のような方に向いています:**

- 複数のコーディングエージェントを同時に実行していて、どれが自分を待っているのか分からなくなる。
- 複数のプロジェクトやクライアントにまたがるタスクを抱えていて、すべてのエージェントを 1 つの画面で見たい。
- すでに料金を払っているプランで、Claude Code、Codex、その他の CLI を組み合わせて使いたい。
- 複数ステップのワークフローがあり、プロジェクトごとにエージェントと自動化をカスタマイズしたい。
- 席を離れているときに、スマートフォンからエージェントに応答したい。

**次のような方にはおそらく向いていません:**

- 一度に 1 つのタスクを最初から最後まで進めるほうが好き。
- 単一のプロジェクトで作業し、切り替えることはほとんどない。
- エージェント CLI を使わない、または Cursor や Claude Desktop のようなアプリのほうが好き。
- 開発の進め方にワークフローや自動化が必要ない。
- エージェントを自分のマシンではなくクラウドで実行したい。

役に立ちそうなら、⭐ を付けていただくと、ほかの開発者が Kangentic を見つけやすくなります。

## インストール

```bash
npx kangentic
```

このコマンドは、お使いのプラットフォーム向けの最新リリースを [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) からダウンロードし、インストールして起動します。その後はアプリが自動で更新されます。インストーラーを自分で実行したい場合は、リリースページからも入手できます。

**要件**

- Windows x64、Apple Silicon または Intel の macOS 13 以降、または Linux x64 / arm64 (`.deb` または `.rpm`)。Intel Mac では Knowledge Graph は利用できません。
- `npx` 用の Node.js 20 以降、および Git 2.26 以降。
- インストール済みでサインイン済みの [サポート対象のエージェント CLI](#supported-agents) が 1 つ以上。

WSL ユーザーは Windows 版をインストールし、ターミナルシェルとして WSL ディストリビューションを選択できます。エージェントは各 CLI の Windows 版インストールを実行するため、ディストリビューション内にのみインストールされた CLI は見つかりません。各プラットフォームについては [インストールガイド](https://www.kangentic.com/guide/installation/) を参照してください。

## しくみ

1. **ボードを設定する。** デフォルトの列をそのまま使うか作り替えて、各列で実行するエージェントと権限モードを選びます。
2. **タスクを作成する。** タイトルとプロンプトを指定するか、GitHub Issues、GitHub Projects、Azure DevOps、Asana からインポートします。
3. **ドラッグして実行する。** Kangentic がワークツリーを作成し、列の権限モードを適用して、エージェントを起動します。
4. **コーディングを見守る。** ライブターミナルでエージェントの動きを追い、質問されたら答え、完了したらカードを次へドラッグします。

<a name="supported-agents"></a>
## サポート対象のエージェント

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex CLI](https://developers.openai.com/codex/cli)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[Cursor CLI](https://cursor.com/docs/cli/overview)、[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)、[Grok Build](https://github.com/xai-org/grok-build)、[Antigravity CLI](https://antigravity.google/docs/cli/getting-started)、[Goose CLI](https://github.com/aaif-goose/goose)、[OpenCode](https://opencode.ai/docs)、[Aider](https://aider.chat/)、[Qwen Code](https://github.com/QwenLM/qwen-code)、[Kimi Code](https://github.com/MoonshotAI/kimi-cli)、[Factory Droid](https://docs.factory.ai/cli/getting-started/overview)、[Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli)、およびローカルモデルをシングルターンのチャットとして使う [Ollama](https://ollama.com)。

再起動後の再開、MCP のボードツール、次のエージェントへの履歴の引き継ぎは CLI によって異なります。[各エージェントのサポート状況](https://www.kangentic.com/features/agent-orchestration/#supported-agents)を参照してください。

## 言語

Kangentic のインターフェースは、このページの上部に記載されている各言語で利用できます。Settings > Language で変更すると、Kangentic がその言語で再起動します。翻訳は機械翻訳で、レビューを受け付けています。修正方法は [Translations](docs/contributing/translations.md) で説明しています。

## データとプライバシー

ボード、タスク、トランスクリプトはローカルの SQLite データベースに保存されます。エージェント CLI は、ターミナルで使う場合と同じように、あなた自身のアカウントでそれぞれのプロバイダーに接続します。

リリースビルドは、デフォルトで匿名の利用状況イベント (Aptabase) とエラーレポート (Sentry) を送信します。利用状況イベントには、タスクのテキスト、プロンプト、コードは一切含まれません。両方をオフにするには `KANGENTIC_TELEMETRY=0` を、エラーレポートだけをオフにするには `KANGENTIC_ERROR_REPORTING=0` を設定します。アプリ内の切り替えスイッチはありません。アプリは更新とお知らせの確認のために GitHub にもアクセスします。完全な一覧は [プライバシーポリシー](https://www.kangentic.com/privacy/) を参照してください。

## ドキュメント

まず [クイックスタート](https://www.kangentic.com/getting-started/) から始め、列、自動化、ワークフロー、MCP サーバー、構成については [ドキュメント](https://www.kangentic.com/overview/) を参照してください。

## 開発

ソースからビルドするには、Node.js 22.14 以降、または 24 以降が必要です。

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## コントリビューション

プロジェクト構成、テスト、規約については [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。コントリビューターは、最初の pull request がマージされる前に [CLA](CLA.md) に署名します。

## サポート

- 質問や機能リクエストは [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) へ
- バグ報告は [GitHub Issues](https://github.com/Kangentic/kangentic/issues) へ
- 公開の場に投稿したくない場合は [support@kangentic.com](mailto:support@kangentic.com) へ

セキュリティの問題を報告するには、[SECURITY.md](SECURITY.md) を参照してください。

## ライセンス

[AGPL-3.0](LICENSE)。商用ライセンスについては licensing@kangentic.com までメールでお問い合わせください。
