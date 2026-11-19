<!-- readme-translation source-blob=ef6ed72a1d4b6736b32f5cd06be82d664e91fc50 -->
> これは `ef6ed72` 時点の [README.md](../README.md) の機械翻訳です。正式な内容は英語版です。

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic のロゴ" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>カードをドラッグすると、エージェントが起動します。</strong><br />
  AI コーディングエージェントのためのエージェント型開発環境です。
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="最新リリース" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm バージョン" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 ライセンス" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="To Do、Planning、Executing、Code Review の各列にタスクが並ぶ Kangentic のボード。実行中の各カードにはエージェントの最新メッセージが表示され、選択したエージェントのターミナルがボードの下に開いています。ライブデモを開きます。" width="900" />
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
  <a href="../README.md">English</a> |
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

## 機能

コーディングエージェントはタスクを単独でこなせますし、Git のワークツリーを使えば複数を同時に実行できます。そうなると限界はあなた自身です。どのエージェントがプロンプト待ちか、どれが完了したか、各ブランチがどうなったかを把握しなければなりません。Kangentic はすべてのセッションを 1 つのボードにまとめ、あなたの対応が必要なものに印を付けます。

### 1 つのボードからエージェントを実行する

- **1 つのボードにすべてのエージェント。** 各カードには、モデル、コンテキストウィンドウの使用量、エージェントの最後の発言が表示され、あなたの対応が必要なものには印が付きます。
- **Kangentic Mobile。** スマートフォンを一度ペアリングすれば、席を離れていてもエージェントの状況を確認し、エージェントが止まっている質問に答え、差分をレビューできます。接続はエンドツーエンドで暗号化され、Kangentic のリレーか自分でホストするリレーを経由します。[App Store](https://apps.apple.com/app/kangentic/id6794952339) または [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile) から入手できます。
- **15 種類のエージェント CLI。** Claude Code で計画し Codex で実装することも、どこでも 1 つの CLI を使うこともできます。Kangentic は、すでにお持ちの CLI を、すでに設定済みの認証情報で実行します。API キーもプロキシも Kangentic アカウントも不要です。
- **すべてのプロジェクトを 1 か所に。** リポジトリごとに専用のボードがあり、Agent Monitor にはすべてのリポジトリで実行中のエージェントが表示されます。
- **ボード上でレビュー。** Changes パネルには各タスクの差分とコミット履歴が表示されます。GitHub または Azure DevOps でリンクした pull request については、その状態とマージ可能かどうかが表示されます。
- **無料のオープンソース。** AGPL-3.0 で、すべての機能が含まれ、有料プランはありません。

### ワークフローを形づくる

- **列。** 列の名前を変更、追加、つなぎ替えして、ボードを自分の出荷の流れに合わせます。各列には独自のエージェント、モデル、effort、権限モードを設定できます。設定は `kangentic.json` としてリポジトリにコミットされるので、チームメイトも同じボードを使えます。一方、タスクとエージェントのセッションは各自のマシンに残ります。
- **オートメーション。** タスクが列に入ったとき、エージェントがターンを終えたとき、またはタスクが列を出たときに、列からエージェントにメッセージやスラッシュコマンドを送る、スクリプトを実行する、Webhook を呼び出す、通知する、タスクを次の列に移動する、といった操作ができます。平易な言葉で書いた条件をエージェントが判定し、ステップを実行するかどうかを決めます。
- **ワークフロー。** ワークフローエージェントに概要を渡し、計画されたリンク済みタスクをレビューして、Start を押します。各タスクは、待機対象のタスクが Done に到達すると開始されます。1 つのワークフローで複数のプロジェクトにまたがることもできます。
- **ボードを操作するエージェント。** Kangentic の MCP サーバーを使うと、実行中のエージェントがタスクの作成、自分のカードの移動、過去の会話の検索、別のタスクのエージェントへのメッセージ送信を行えます。そのため、プロンプトに書いたルールで作業を進めることができます。

## あなたに合っているか

**次のような場合に適しています。**

- 複数のコーディングエージェントを同時に実行していて、どれがあなたを待っているか見失ってしまう。
- 複数のプロジェクトやクライアントのタスクを掛け持ちしていて、すべてのエージェントを 1 つのビューで見たい。
- すでに契約しているプランで Claude Code、Codex、その他の CLI を組み合わせて使いたい。
- 複数ステップのワークフローがあり、そのエージェントとオートメーションをプロジェクトごとにカスタマイズしたい。
- 席を離れたときにスマートフォンからエージェントに応答したい。

**次のような場合はおそらく向いていません。**

- 1 つのタスクを最初から最後まで 1 つずつ進めたい。
- 単一のプロジェクトで作業し、切り替えることはほとんどない。
- エージェント CLI を使わない、または Cursor や Claude Desktop のようなアプリを好む。
- 開発の進め方にワークフローやオートメーションを必要としない。
- エージェントを自分のマシンではなくクラウドで実行したい。

役に立ちそうだと思ったら、⭐ を付けていただくと他の開発者が Kangentic を見つけやすくなります。

## インストール

```bash
npx kangentic
```

このコマンドは、お使いのプラットフォーム向けの最新リリースを [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) からダウンロードし、インストールして起動します。以降、アプリは自動で更新されます。インストーラーを自分で実行したい場合は、リリースページからも入手できます。

**要件**

- Windows x64、Apple Silicon または Intel の macOS 13 以降、または Linux x64 か arm64 (`.deb` または `.rpm`)。Intel Mac では Knowledge Graph を利用できません。
- `npx` 用の Node.js 20 以降、および Git 2.26 以降。
- インストール済みでサインイン済みの [サポート対象エージェント CLI](#supported-agents) が 1 つ以上。

WSL ユーザーは Windows 版をインストールし、ターミナルのシェルとして WSL ディストリビューションを選択できます。エージェントは各 CLI の Windows 版を実行するため、ディストリビューション内にのみインストールされた CLI は検出されません。各プラットフォームについては [インストールガイド](https://www.kangentic.com/guide/installation/) を参照してください。

## しくみ

1. **ボードを構成します。** 既定の列をそのまま使うか作り変え、各列で実行するエージェントと権限モードを選びます。
2. **タスクを作成します。** タイトルとプロンプトを入力するか、GitHub Issues、GitHub Projects、Azure DevOps、Asana、Jira、Linear、Trello、GitLab、または Obsidian の vault からインポートします。
3. **ドラッグして実行します。** Kangentic がワークツリーを作成し、列の権限モードを適用して、エージェントを起動します。
4. **コーディングを見守ります。** ライブターミナルでエージェントの動きを追い、質問されたら答え、完了したらカードを次へドラッグします。

<a name="supported-agents"></a>
## サポート対象のエージェント

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex CLI](https://developers.openai.com/codex/cli)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[Cursor CLI](https://cursor.com/docs/cli/overview)、[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)、[Grok Build](https://github.com/xai-org/grok-build)、[Antigravity CLI](https://antigravity.google/docs/cli/getting-started)、[Goose CLI](https://github.com/aaif-goose/goose)、[OpenCode](https://opencode.ai/docs)、[Aider](https://aider.chat/)、[Qwen Code](https://github.com/QwenLM/qwen-code)、[Kimi Code](https://github.com/MoonshotAI/kimi-code)、[Factory Droid](https://docs.factory.ai/cli/getting-started/overview)、[Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli)、およびローカルモデルをシングルターンのチャットとして使う [Ollama](https://ollama.com)。

再起動後の再開、MCP のボードツール、次のエージェントへの履歴の引き継ぎは CLI によって異なります。[各エージェントのサポート状況](https://www.kangentic.com/features/agent-orchestration/#supported-agents) を参照してください。

## 言語

Kangentic のインターフェイスは、このページの上部に記載されている各言語で利用できます。Settings > Language で変更すると、Kangentic がその言語で再起動します。翻訳は機械翻訳で、レビューを受け付けています。修正方法は [翻訳](../docs/contributing/translations.md) で説明しています。

## データとプライバシー

ボード、タスク、トランスクリプトはローカルの SQLite データベースに保存されます。エージェント CLI は、ターミナルで使う場合と同様に、あなた自身のアカウントでそれぞれのプロバイダーに接続します。

リリースビルドは、既定で匿名の使用状況イベント (Aptabase) とエラーレポート (Sentry) を送信します。使用状況イベントにタスクのテキスト、プロンプト、コードが含まれることはありません。両方を無効にするには `KANGENTIC_TELEMETRY=0` を、エラーレポートのみを無効にするには `KANGENTIC_ERROR_REPORTING=0` を設定します。アプリ内の切り替えはありません。アプリは更新とお知らせの確認のために GitHub にもアクセスします。詳細な一覧は [プライバシーポリシー](https://www.kangentic.com/privacy/) を参照してください。

## ドキュメント

まず [クイックスタート](https://www.kangentic.com/getting-started/) を読み、次に列、オートメーション、ワークフロー、MCP サーバー、構成について [ドキュメント](https://www.kangentic.com/overview/) を参照してください。

## 開発

ソースからビルドするには、Node.js 22.14 以降、または 24 以降が必要です。

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## コントリビューション

プロジェクト構成、テスト、規約については [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。コントリビューターは、最初の pull request がマージされる前に [CLA](../CLA.md) に署名します。

## サポート

- 質問と機能リクエストは [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) へ
- バグ報告は [GitHub Issues](https://github.com/Kangentic/kangentic/issues) へ
- 公開の場に投稿したくない場合は [support@kangentic.com](mailto:support@kangentic.com) へ

セキュリティの問題を報告するには、[SECURITY.md](../SECURITY.md) を参照してください。

## ライセンス

[AGPL-3.0](../LICENSE)。商用ライセンスについては licensing@kangentic.com までメールでお問い合わせください。
