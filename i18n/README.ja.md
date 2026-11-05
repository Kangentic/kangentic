<!-- readme-translation source-blob=9c65bada5dcd25126a88e6b2728e7cb56ea71c6e -->
> これは [README.md](../README.md) の `9c65bad` 時点の機械翻訳です。正式な版は英語版です。

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic ロゴ" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>カードをドラッグ。エージェントが起動。</strong><br />
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

## できること

コーディングエージェントは 1 つのタスクを単独でこなせます。また、Git ワークツリーを使えば複数のエージェントを同時に実行できます。すると、制約になるのはあなた自身です。どのエージェントがプロンプトを待っているのか、どれが完了したのか、各ブランチがどこへ進んだのかを追う必要があります。Kangentic はすべてのセッションを 1 つのボードにまとめ、あなたの対応が必要なものに印を付けます。

### 1 つのボードからエージェントを実行する

- **1 つのボードに、すべてのエージェント。** 各カードには、モデル、コンテキストウィンドウの使用量、エージェントの最新の発言が表示され、対応が必要なカードには印が付きます。
- **Kangentic Mobile。** スマートフォンを一度ペアリングすれば、デスクを離れていてもエージェントの状況を確認し、エージェントが止まっている質問に回答し、その差分をレビューできます。接続はエンドツーエンドで暗号化され、Kangentic のリレーまたは自分でホストするリレーを経由します。[App Store](https://apps.apple.com/app/kangentic/id6794952339) または [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile) から入手できます。
- **15 種類のエージェント CLI。** Claude Code で計画して Codex で実装することも、すべてを 1 つの CLI で行うこともできます。Kangentic は、すでに使っている CLI を、設定済みの認証情報のまま実行します。API キーも、プロキシも、Kangentic アカウントも不要です。
- **すべてのプロジェクトを 1 か所に。** リポジトリごとに専用のボードが用意され、Agent Monitor にはすべてのリポジトリで実行中のエージェントが表示されます。
- **ボード上でレビュー。** Changes パネルには、各タスクの差分とコミット履歴が表示されます。GitHub または Azure DevOps のリンクされた pull request については、その状態とマージできるかどうかが表示されます。
- **無料でオープンソース。** AGPL-3.0 で提供され、すべての機能が含まれており、有料プランはありません。

### ワークフローを設計する

- **列。** 列の名前変更、追加、つなぎ替えを行い、ボードを自分のリリースの進め方に合わせられます。各列には、それぞれエージェント、モデル、effort、権限モードを設定できます。この設定は `kangentic.json` としてリポジトリと一緒にコミットされるため、チームメイトも同じボードを使えます。一方、タスクとエージェントセッションは各自のマシンに残ります。
- **オートメーション。** タスクが列に入ったとき、エージェントがターンを終えたとき、タスクが列を離れたときに、列からエージェントへのメッセージやスラッシュコマンドの送信、スクリプトの実行、Webhook の呼び出し、通知、次の列へのタスクの移動を行えます。平易な言葉で書いた条件をエージェントが確認し、ステップを実行するかどうかを決めます。
- **ワークフロー。** ワークフローエージェントに概要を渡し、エージェントが計画した関連タスクをレビューして、Start を押します。各タスクは、待機先のタスクが Done に達すると開始されます。1 つのワークフローで複数のプロジェクトにまたがることもできます。
- **ボードを操作するエージェント。** Kangentic の MCP サーバーを使うと、実行中のエージェントがタスクの作成、自分のカードの移動、過去の会話の検索、別のタスクのエージェントへのメッセージ送信を行えます。そのため、プロンプトに書いたルールで作業を先に進められます。

## 自分に合っていますか?

**次に当てはまるなら、適しています:**

- 複数のコーディングエージェントを同時に実行していて、どれが自分を待っているのか分からなくなる。
- 複数のプロジェクトやクライアントのタスクを掛け持ちしていて、すべてのエージェントを 1 つのビューで見たい。
- すでに料金を払っているプランで、Claude Code、Codex、その他の CLI を組み合わせて使いたい。
- 複数のステップからなるワークフローがあり、そのエージェントとオートメーションをプロジェクトごとにカスタマイズしたい。
- 席を離れたときに、スマートフォンからエージェントに回答したい。

**次に当てはまるなら、おそらく適していません:**

- 1 つのタスクを最初から最後まで、一度に 1 つずつ進めたい。
- 単一のプロジェクトで作業していて、切り替えることがほとんどない。
- エージェント CLI を使わない、または Cursor や Claude Desktop のようなアプリのほうが好みである。
- 開発の進め方にワークフローやオートメーションが必要ない。
- エージェントを自分のマシンではなくクラウドで実行したい。

役に立ちそうだと思ったら、⭐ を付けていただくと、ほかの開発者が Kangentic を見つけやすくなります。

## インストール

```bash
npx kangentic
```

このコマンドは、お使いのプラットフォーム向けの最新リリースを [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) からダウンロードしてインストールし、起動します。以降は、アプリが自動的に更新されます。インストーラーを自分で実行したい場合は、リリースページからも入手できます。

**要件**

- Windows x64、Apple Silicon または Intel 搭載の macOS 13 以降、または Linux x64 / arm64 (`.deb` または `.rpm`)。Knowledge Graph は Intel Mac では利用できません。
- `npx` 用の Node.js 20 以降、および Git 2.26 以降。
- インストールしてサインイン済みの[対応エージェント CLI](#supported-agents) が 1 つ以上。

WSL ユーザーは Windows 版をインストールし、ターミナルシェルとして WSL ディストリビューションを選択できます。エージェントは Windows にインストールされた各 CLI を実行するため、ディストリビューション内にのみインストールされた CLI は検出されません。各プラットフォームについては、[インストールガイド](https://www.kangentic.com/guide/installation/)を参照してください。

## しくみ

1. **ボードを設定します。** 既定の列をそのまま使うか、作り変えて、各列で実行するエージェントと権限モードを選択します。
2. **タスクを作成します。** タイトルとプロンプトを指定するか、GitHub Issues、GitHub Projects、Azure DevOps、Asana からインポートします。
3. **ドラッグして実行します。** Kangentic がワークツリーを作成し、列の権限モードを適用して、エージェントを起動します。
4. **コーディングの様子を確認します。** ライブターミナルでエージェントを追い、質問されたら回答し、完了したらカードを次へドラッグします。

<a name="supported-agents"></a>
## 対応エージェント

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex CLI](https://developers.openai.com/codex/cli)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[Cursor CLI](https://cursor.com/docs/cli/overview)、[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)、[Grok Build](https://github.com/xai-org/grok-build)、[Antigravity CLI](https://antigravity.google/docs/cli/getting-started)、[Goose CLI](https://github.com/aaif-goose/goose)、[OpenCode](https://opencode.ai/docs)、[Aider](https://aider.chat/)、[Qwen Code](https://github.com/QwenLM/qwen-code)、[Kimi Code](https://github.com/MoonshotAI/kimi-code)、[Factory Droid](https://docs.factory.ai/cli/getting-started/overview)、[Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli)、およびローカルモデルをシングルターンのチャットとして利用する [Ollama](https://ollama.com)。

再起動後の再開、MCP ボードツール、次のエージェントへの履歴の引き継ぎは、CLI によって異なります。[各エージェントの対応状況](https://www.kangentic.com/features/agent-orchestration/#supported-agents)を参照してください。

## 言語

Kangentic のインターフェイスは、このページの上部に記載されている各言語で利用できます。Settings > Language で変更すると、Kangentic はその言語で再起動します。翻訳は機械によるもので、レビューを受け付けています。修正方法については、[翻訳](../docs/contributing/translations.md)を参照してください。

## データとプライバシー

ボード、タスク、トランスクリプトは、ローカルの SQLite データベースに保存されます。エージェント CLI は、ターミナルで実行する場合と同じように、あなた自身のアカウントでそれぞれのプロバイダーに接続します。

リリースビルドは、既定で匿名の使用状況イベント (Aptabase) とエラーレポート (Sentry) を送信します。使用状況イベントに、タスクのテキスト、プロンプト、コードが含まれることはありません。両方をオフにするには `KANGENTIC_TELEMETRY=0` を設定し、エラーレポートのみをオフにするには `KANGENTIC_ERROR_REPORTING=0` を設定します。アプリ内の切り替えスイッチはありません。アプリは、更新とお知らせも GitHub で確認します。完全な一覧については、[プライバシーポリシー](https://www.kangentic.com/privacy/)を参照してください。

## ドキュメント

まず[クイックスタート](https://www.kangentic.com/getting-started/)を読み、次に列、オートメーション、ワークフロー、MCP サーバー、構成について[ドキュメント](https://www.kangentic.com/overview/)を参照してください。

## 開発

ソースからビルドするには、Node.js 22.14 以降または 24 以降が必要です。

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## コントリビューション

プロジェクト構成、テスト、規約については、[CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。コントリビューターは、最初の pull request がマージされる前に [CLA](../CLA.md) に署名します。

## サポート

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions): 質問と機能リクエスト
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues): バグレポート
- [support@kangentic.com](mailto:support@kangentic.com): 公開の場に投稿したくない場合

セキュリティの問題を報告するには、[SECURITY.md](../SECURITY.md) を参照してください。

## ライセンス

[AGPL-3.0](../LICENSE)。商用ライセンスについては、licensing@kangentic.com までメールでお問い合わせください。
