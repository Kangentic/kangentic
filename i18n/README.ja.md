<!-- readme-translation source-blob=ded000bed8af5253da7d62f8cafb9a8369f243a4 -->
> これは [README.md](../README.md) の `ded000b` 時点の機械翻訳です。正式版は英語版です。

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic ロゴ" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>カードをドラッグすると、エージェントが動き出す。</strong><br />
  AI コーディングエージェントのためのエージェント型開発環境。
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="最新リリース" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm バージョン" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 ライセンス" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://kangentic.github.io/kangentic/readme/board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://kangentic.github.io/kangentic/readme/board-light.png" />
      <img src="https://kangentic.github.io/kangentic/readme/board-dark.png" alt="To Do、Planning、Executing、Code Review の各列にタスクが並ぶ Kangentic のボード。実行中の各カードにはエージェントの最新メッセージが表示され、選択中のエージェントのターミナルがボードの下に開いています。ライブデモを開きます。" width="900" />
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

コーディングエージェントはタスクを単独でこなせます。また、git ワークツリーを使えば複数のエージェントを同時に実行できます。そうなると、ボトルネックになるのはあなた自身です。どのエージェントがプロンプト待ちか、どれが完了したか、各ブランチがどうなったかを把握しなければなりません。Kangentic はすべてのセッションを 1 つのボードにまとめ、あなたの対応が必要なものに印を付けます。

### 1 つのボードからエージェントを実行する

- **1 つのボードで、すべてのエージェントを。** 各カードには、モデル、コンテキストウィンドウの使用量、エージェントの最後の発言が表示され、対応が必要なものには印が付きます。
- **Kangentic Mobile。** スマートフォンを一度ペアリングすれば、デスクを離れていてもエージェントの状況を確認し、エージェントが止まっている質問に答え、その差分をレビューできます。接続はエンドツーエンドで暗号化され、Kangentic のリレーまたは自分でホストするリレーを経由します。[App Store](https://apps.apple.com/app/kangentic/id6794952339) または [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile) から入手できます。
- **15 種類のエージェント CLI。** Claude Code で計画して Codex で実装することも、すべてに 1 つの CLI を使うこともできます。Kangentic は、すでにお使いの CLI を、設定済みの認証情報のまま実行します。API キーもプロキシも Kangentic アカウントも不要です。
- **リモートホスト上のエージェント。** SSH で接続できる Linux マシンにプロジェクトを置くと、そのリポジトリ、エージェント、ビルド、テストはそのマシン上で実行されます。ボードは手元のコンピューターに残り、接続が切れても、アプリを終了しても、エージェントは作業を続けます。セットアップと制限については、[SSH リモートホスト](https://www.kangentic.com/features/ssh-remote-hosts/)を参照してください。
- **すべてのプロジェクトを 1 か所に。** リポジトリごとに専用のボードがあり、Agent Monitor にはすべてのボードで実行中のエージェントが表示されます。
- **ボード上でレビュー。** Changes パネルには、各タスクの差分とコミット履歴が表示されます。GitHub または Azure DevOps 上の pull request をリンクすると、その状態とマージできる状態かどうかが表示されます。
- **無料のオープンソース。** AGPL-3.0 ライセンスで、すべての機能が含まれており、有料プランはありません。

### ワークフローを組み立てる

- **列。** ボードが自分の開発の進め方に合うまで、列の名前の変更、追加、つなぎ替えができます。各列には、それぞれのエージェント、モデル、effort、権限モードを設定できます。この設定は `kangentic.json` としてリポジトリと一緒にコミットされるため、チームメイトも同じボードを使えます。一方、タスクとエージェントセッションは各自のマシンに残ります。
- **オートメーション。** タスクが列に入ったとき、そのエージェントがターンを終えたとき、またはタスクが列から出るときに、列はエージェントへのメッセージやスラッシュコマンドの送信、スクリプトの実行、webhook の呼び出し、通知、タスクの次の列への移動を行えます。平易な言葉で書いた条件をエージェントが確認し、ステップを実行するかどうかを判断します。
- **ワークフロー。** ワークフローエージェントに概要を伝え、エージェントが計画した、相互にリンクされたタスクを確認して、Start を押します。各タスクは、待機対象のタスクが Done に達すると開始されます。1 つのワークフローで複数のプロジェクトにまたがることもできます。
- **ボードを操作するエージェント。** Kangentic の MCP サーバーを使うと、実行中のエージェントがタスクの作成、自分のカードの移動、過去の会話の検索、別のタスクのエージェントへのメッセージ送信を行えます。そのため、プロンプトに書いたルールで作業を先に進められます。

## Kangentic は自分に合っているか

**次のような方に適しています:**

- 複数のコーディングエージェントを同時に実行していて、どれが自分の対応を待っているのか分からなくなる。
- 複数のプロジェクトやクライアントのタスクを並行して扱っていて、すべてのエージェントを 1 つの画面で確認したい。
- すでに契約しているプランで、Claude Code、Codex、その他の CLI を組み合わせて使いたい。
- 複数ステップのワークフローがあり、そのエージェントとオートメーションをプロジェクトごとにカスタマイズしたい。
- 席を離れているときに、スマートフォンからエージェントに応答したい。

**次のような方にはおそらく向いていません:**

- タスクは 1 つずつ、最初から最後まで進めたい。
- 単一のプロジェクトで作業していて、切り替えることはほとんどない。
- エージェント CLI を使わない、または Cursor や Claude Desktop のようなアプリのほうが好み。
- 開発の進め方にワークフローやオートメーションは必要ない。
- アプリをインストールせずに、ホスト型サービスでエージェントを実行したい。

役に立ちそうだと思ったら、⭐ を付けていただけると、ほかの開発者が Kangentic を見つけやすくなります。

## インストール

```bash
npx kangentic
```

このコマンドは、お使いのプラットフォーム向けの最新リリースを [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) からダウンロードし、インストールして起動します。その後は、アプリが自動的に更新されます。インストーラーを自分で実行したい場合は、リリースページからも入手できます。

**要件**

- Windows x64、Apple Silicon または Intel 搭載の macOS 13 以降、または Linux x64 / arm64 (`.deb` または `.rpm`)。
- `npx` 用の Node.js 20 以降と、Git 2.26 以降。
- インストールしてサインイン済みの [サポートされているエージェント CLI](#supported-agents) が 1 つ以上。

WSL ユーザーは Windows 版をインストールし、ターミナルのシェルとして WSL ディストリビューションを選択できます。ディストリビューション内にインストールしたエージェント CLI は、そのパスをディストリビューション内のものに設定すると、ディストリビューション内で実行されます。プロジェクト自体は Windows のドライブに置いてください。各プラットフォームについては、[インストールガイド](https://www.kangentic.com/guide/installation/)を参照してください。

## しくみ

1. **ボードを構成する。** デフォルトの列をそのまま使うか作り変えて、各列で実行するエージェントと権限モードを選びます。
2. **タスクを作成する。** タイトルとプロンプトを指定するか、GitHub Issues、GitHub Projects、Azure DevOps、Asana、Jira、Linear、Trello、GitLab、または Obsidian vault からインポートします。
3. **ドラッグして実行する。** Kangentic がワークツリーを作成し、列の権限モードを適用して、エージェントを起動します。
4. **コーディングを見守る。** ライブターミナルでエージェントの作業を追い、質問されたら答え、完了したらカードを次の列へドラッグします。

<a name="supported-agents"></a>
## サポートされているエージェント

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex CLI](https://developers.openai.com/codex/cli)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[Cursor CLI](https://cursor.com/docs/cli/overview)、[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)、[Grok Build](https://github.com/xai-org/grok-build)、[Antigravity CLI](https://antigravity.google/docs/cli/getting-started)、[Goose CLI](https://github.com/aaif-goose/goose)、[OpenCode](https://opencode.ai/docs)、[Aider](https://aider.chat/)、[Qwen Code](https://github.com/QwenLM/qwen-code)、[Kimi Code](https://github.com/MoonshotAI/kimi-code)、[Factory Droid](https://docs.factory.ai/cli/getting-started/overview)、[Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli)、およびローカルモデルをシングルターンのチャットとして使う [Ollama](https://ollama.com)。

再起動後の再開、MCP ボードツール、次のエージェントへの履歴の引き継ぎに対応しているかどうかは、CLI によって異なります。[各エージェントのサポート状況](https://www.kangentic.com/features/agent-orchestration/#supported-agents)を参照してください。

## 言語

Kangentic のインターフェイスは、このページの上部に記載されている各言語で利用できます。Settings > Language で変更すると、Kangentic はその言語で再起動します。翻訳は機械翻訳によるもので、誰でもレビューできます。翻訳を修正する方法については、[翻訳](../docs/contributing/translations.md)を参照してください。

## データとプライバシー

ボード、タスク、トランスクリプトは、ローカルの SQLite データベースに保存されます。エージェント CLI は、ターミナルで使う場合と同じように、あなた自身のアカウントでそれぞれのプロバイダーに接続します。

リリースビルドは、既定で匿名の使用状況イベント (Aptabase) とエラーレポート (Sentry) を送信します。使用状況イベントに、タスクのテキスト、プロンプト、コードが含まれることはありません。両方を無効にするには `KANGENTIC_TELEMETRY=0` を、エラーレポートのみを無効にするには `KANGENTIC_ERROR_REPORTING=0` を設定します。アプリ内に切り替えスイッチはありません。また、アプリは更新とお知らせを確認するために GitHub にアクセスします。全項目については、[プライバシーポリシー](https://www.kangentic.com/privacy/)を参照してください。

## ドキュメント

まず [クイックスタート](https://www.kangentic.com/getting-started/)を読み、次に列、オートメーション、ワークフロー、MCP サーバー、構成について [ドキュメント](https://www.kangentic.com/overview/)を参照してください。

## 開発

ソースからビルドするには、Node.js 22.14 以降、または 24 以降が必要です。

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## コントリビューション

プロジェクトの構成、テスト、規約については、[CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。コントリビューターは、最初の pull request がマージされる前に [CLA](../CLA.md) に署名します。

## サポート

- 質問と機能リクエストは [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) へ
- バグ報告は [GitHub Issues](https://github.com/Kangentic/kangentic/issues) へ
- 公開の場に投稿したくない場合は [support@kangentic.com](mailto:support@kangentic.com) へ

セキュリティの問題を報告するには、[SECURITY.md](../SECURITY.md) を参照してください。

## ライセンス

[AGPL-3.0](../LICENSE)。商用ライセンスについては、licensing@kangentic.com までメールでお問い合わせください。
