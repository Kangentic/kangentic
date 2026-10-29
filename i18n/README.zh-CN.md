<!-- readme-translation source-blob=eecf91791ca282e05478d5f2732f583958463f0e -->
> 本文是 [README.md](../README.md) 在 `eecf917` 版本的机器翻译。以英文版本为准。

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic 标志" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>拖动卡片，智能体即刻启动。</strong><br />
  面向 AI 编码智能体的智能体开发环境。
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="最新版本" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm 版本" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 许可证" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="Kangentic 看板，任务分布在“待办”“规划”“执行”和“代码审查”列中。每张运行中的卡片都显示其智能体的最新消息，所选智能体的终端在看板下方打开。点击可打开在线演示。" width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">在线演示</a> |
  <a href="https://www.kangentic.com/getting-started/">快速入门</a> |
  <a href="https://www.kangentic.com/overview/">文档</a>
</p>

<!-- language-switcher -->
<p align="center">
  <a href="../README.md">English</a> |
  中文(简体) |
  <a href="README.zh-TW.md">中文(繁體)</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.pt-BR.md">Português (Brasil)</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.cs.md">Čeština</a> |
  <a href="README.hu.md">Magyar</a>
</p>
<!-- /language-switcher -->

## 功能简介

编码智能体可以独立完成一项任务，而 Git 工作树可以让多个智能体同时运行。这时瓶颈就变成了你自己：哪个智能体在等待输入，哪个已经完成，每个分支又进展到了哪里。Kangentic 将所有会话放在一个看板上，并标记出需要你处理的会话。

### 在一个看板上运行所有智能体

- **一个看板，所有智能体。** 每张卡片都会显示其模型、上下文窗口的使用量以及智能体最后说的内容，并标记出需要你处理的卡片。
- **Kangentic Mobile。** 只需配对一次手机，即可在离开工位时查看智能体、回答让智能体停下来的问题，并审查其差异。连接采用端到端加密，通过 Kangentic 的中继或你自己托管的中继进行。可从 [App Store](https://apps.apple.com/app/kangentic/id6794952339) 或 [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile) 获取。
- **十五种智能体 CLI。** 用 Claude Code 做规划、用 Codex 做构建，或者全程使用同一个 CLI。Kangentic 使用你已安装的 CLI 和你已配置的凭据来运行。无需 API 密钥，无需代理，也无需 Kangentic 账户。
- **所有项目集中一处。** 每个仓库都有自己的看板，智能体监视器会显示所有仓库中正在运行的智能体。
- **在看板上审查。** “更改”面板会显示每个任务的差异和提交历史。在 GitHub 或 Azure DevOps 上关联的拉取请求会显示其状态以及是否可以合并。
- **免费且开源。** 采用 AGPL-3.0 许可，包含全部功能，没有付费层级。

### 定制工作流

- **列。** 重命名、添加列并重新连接列，直到看板符合你的交付方式。每列都有自己的智能体、模型、推理强度和权限模式。这些配置保存在 `kangentic.json` 中并随仓库一起提交，因此队友会得到相同的看板，而任务和智能体会话则保留在每个人自己的机器上。
- **自动化。** 当任务进入某列、其智能体完成一轮对话或任务离开该列时，该列可以向智能体发送消息或斜杠命令、运行脚本、调用 webhook、通知你，或将任务移到下一列。由智能体检查的一条自然语言条件决定某个步骤是否运行。
- **工作流。** 向工作流智能体提供一份简要说明，审查它规划出的关联任务，然后按“开始”。每个任务会在其所依赖的任务到达“完成”列时启动，一个工作流可以跨越多个项目。
- **能操作看板的智能体。** 借助 Kangentic 的 MCP 服务器，正在运行的智能体可以创建任务、移动自己的卡片、搜索过往对话，以及向其他任务的智能体发送消息，因此写在提示中的规则就能推动工作向前进行。

## 它适合你吗？

**如果你符合以下情况，它会很适合你：**

- 同时运行多个编码智能体，却搞不清哪个正在等你。
- 在多个项目或客户之间处理任务，希望在一个视图中看到所有智能体。
- 希望在已付费的套餐上混合使用 Claude Code、Codex 和其他 CLI。
- 有多步骤的工作流，并希望按项目自定义其中的智能体和自动化。
- 希望离开电脑时也能用手机回复智能体。

**如果你符合以下情况，它可能不适合你：**

- 更喜欢一次只处理一个任务，从头做到尾。
- 只在单个项目中工作，很少切换。
- 不使用智能体 CLI，或者更喜欢 Cursor、Claude Desktop 之类的应用。
- 开发过程中用不到工作流或自动化。
- 希望智能体在云端运行，而不是在你的机器上运行。

如果你觉得它有用，点个 ⭐ 能帮助更多开发者发现 Kangentic。

## 安装

```bash
npx kangentic
```

此命令会从 [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) 下载适用于你平台的最新版本，完成安装并打开应用。之后应用会自动更新。如果你更想自己运行安装程序，也可以在发布页面找到它们。

**系统要求**

- Windows x64、Apple Silicon 或 Intel 芯片上的 macOS 13 或更高版本，或者 Linux x64 或 arm64（`.deb` 或 `.rpm`）。Intel Mac 上无法使用知识图谱。
- `npx` 需要 Node.js 20 或更高版本，另需 Git 2.26 或更高版本。
- 至少安装并登录一个[受支持的智能体 CLI](#supported-agents)。

WSL 用户应安装 Windows 版本，并可选择一个 WSL 发行版作为终端 shell。智能体运行的是各 CLI 的 Windows 安装版本，因此仅安装在发行版内部的 CLI 无法被找到。[安装指南](https://www.kangentic.com/guide/installation/)介绍了各个平台的安装方法。

## 工作原理

1. **配置看板。** 保留默认列或重新调整，并为每列选择要运行的智能体和权限模式。
2. **创建任务。** 为任务填写标题和提示，或从 GitHub Issues、GitHub Projects、Azure DevOps 或 Asana 导入任务。
3. **拖动即运行。** Kangentic 会创建工作树、应用该列的权限模式并启动智能体。
4. **观看编码过程。** 在实时终端中跟进智能体，在它提问时作答，并在完成后将卡片拖到下一列。

<a name="supported-agents"></a>
## 支持的智能体

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex CLI](https://developers.openai.com/codex/cli)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[Cursor CLI](https://cursor.com/docs/cli/overview)、[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)、[Grok Build](https://github.com/xai-org/grok-build)、[Antigravity CLI](https://antigravity.google/docs/cli/getting-started)、[Goose CLI](https://github.com/aaif-goose/goose)、[OpenCode](https://opencode.ai/docs)、[Aider](https://aider.chat/)、[Qwen Code](https://github.com/QwenLM/qwen-code)、[Kimi Code](https://github.com/MoonshotAI/kimi-cli)、[Factory Droid](https://docs.factory.ai/cli/getting-started/overview)、[Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli)，以及以单轮对话方式使用本地模型的 [Ollama](https://ollama.com)。

重启后恢复会话、MCP 看板工具以及将历史记录交给下一个智能体，这些功能是否可用取决于具体的 CLI。请参阅[各智能体支持的功能](https://www.kangentic.com/features/agent-orchestration/#supported-agents)。

## 语言

Kangentic 的界面支持本页顶部列出的所有语言。在 Settings > Language 中更改语言后，Kangentic 会以该语言重新启动。这些翻译由机器生成，欢迎审阅，[翻译](../docs/contributing/translations.md)介绍了如何更正翻译。

## 数据与隐私

你的看板、任务和对话记录都保存在本地 SQLite 数据库中。智能体 CLI 使用你自己的账户访问各自的提供商，就像在你的终端中运行时一样。

发布版本默认会发送匿名使用事件（Aptabase）和错误报告（Sentry）。使用事件绝不包含任务文本、提示或代码。设置 `KANGENTIC_TELEMETRY=0` 可同时关闭这两项，设置 `KANGENTIC_ERROR_REPORTING=0` 则仅关闭错误报告。应用内没有相应的开关。应用还会从 GitHub 检查更新和公告。完整列表请参阅[隐私政策](https://www.kangentic.com/privacy/)。

## 文档

请先阅读[快速入门](https://www.kangentic.com/getting-started/)，然后查阅[文档](https://www.kangentic.com/overview/)，了解列、自动化、工作流、MCP 服务器和配置。

## 开发

从源代码构建需要 Node.js 22.14 或更高版本，或者 24 或更高版本。

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## 贡献

有关项目结构、测试和约定，请参阅 [CONTRIBUTING.md](../CONTRIBUTING.md)。贡献者需要在其首个拉取请求合并之前签署 [CLA](../CLA.md)。

## 支持

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions)：提问和功能请求
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues)：报告 bug
- [support@kangentic.com](mailto:support@kangentic.com)：如果你不想公开发帖

如需报告安全问题，请参阅 [SECURITY.md](../SECURITY.md)。

## 许可证

[AGPL-3.0](../LICENSE)。如需商业许可证，请发送电子邮件至 licensing@kangentic.com。
