<!-- readme-translation source-blob=3c139f6ee74019ac75b29fddea661fd14d0b0846 -->
> 這是 [README.md](README.md) 於 `3c139f6` 的機器翻譯，內容以英文版本為準。

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic 標誌" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>拖曳一張卡片，代理程式就會啟動。</strong><br />
  專為 AI 程式設計代理程式打造的代理式開發環境。
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="最新版本" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm 版本" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 授權" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="Kangentic 看板，任務分布在 To Do、Planning、Executing 和 Code Review 欄中。每張執行中的卡片都會顯示其代理程式的最新訊息，所選代理程式的終端機則開啟在看板下方。點選即可開啟線上示範。" width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">線上示範</a> |
  <a href="https://www.kangentic.com/getting-started/">快速入門</a> |
  <a href="https://www.kangentic.com/overview/">文件</a>
</p>

<!-- language-switcher -->
<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">中文(简体)</a> |
  中文(繁體) |
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

## 功能介紹

程式設計代理程式可以獨力完成一項任務，而 git 工作樹讓多個代理程式能同時執行。這時瓶頸就變成了你：哪個代理程式正在等待提示、哪個已經完成，以及每個分支跑到哪裡去了。Kangentic 會將所有工作階段放在同一個看板上，並標示出需要你處理的那些。

### 在同一個看板上執行你的代理程式

- **一個看板，所有代理程式。** 每張卡片都會顯示其模型、內容視窗的使用量，以及代理程式最後說了什麼，需要你處理的卡片會加上標記。
- **Kangentic Mobile。** 只要將手機配對一次，即使離開座位，也能查看代理程式狀態、回答代理程式停下來等待的問題，並檢閱其差異。連線採用端對端加密，可透過 Kangentic 的中繼伺服器或你自行架設的中繼伺服器。可從 [App Store](https://apps.apple.com/app/kangentic/id6794952339) 或 [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile) 下載。
- **十五種代理程式 CLI。** 用 Claude Code 規劃、用 Codex 建置，或在所有地方都使用同一個 CLI。Kangentic 會使用你已設定的認證來執行你已安裝的 CLI。不需要 API 金鑰、不需要 Proxy，也不需要 Kangentic 帳戶。
- **所有專案集中一處。** 每個存放庫都有自己的看板，而 Agent Monitor 會顯示在所有存放庫中執行的代理程式。
- **在看板上檢閱。** Changes 面板會顯示每項任務的差異和提交歷程記錄。連結至 GitHub 或 Azure DevOps 的提取要求會顯示其狀態，以及是否已可合併。
- **免費且開放原始碼。** 採用 AGPL-3.0 授權，包含所有功能，沒有付費方案。

### 打造你的工作流程

- **欄。** 重新命名、新增和重新串接欄，直到看板符合你的出貨流程。每一欄都有自己的代理程式、模型、投入程度和權限模式。這份設定會與存放庫一起提交到 `kangentic.json` 中，讓隊友取得相同的看板，而任務和代理程式工作階段則留在每個人自己的電腦上。
- **自動化。** 當任務進入某一欄、其代理程式完成一個回合，或任務離開該欄時，該欄可以傳送訊息或斜線命令給代理程式、執行指令碼、呼叫 Webhook、通知你，或將任務移到下一欄。由代理程式檢查以白話撰寫的條件，決定某個步驟是否執行。
- **工作流程。** 給工作流程代理程式一份簡介，檢閱它規劃的連結任務，然後按下 Start。每項任務會在它所等待的任務到達 Done 時開始，而且一個工作流程可以橫跨多個專案。
- **會操作看板的代理程式。** Kangentic 的 MCP 伺服器讓執行中的代理程式能建立任務、移動自己的卡片、搜尋過去的對話，以及傳送訊息給其他任務的代理程式，因此寫在提示中的規則就能推動工作進展。

## 它適合你嗎？

**如果你符合以下情況，它會很適合你：**

- 同時執行多個程式設計代理程式，卻搞不清楚哪一個正在等你。
- 在多個專案或客戶之間切換處理任務，並希望在同一個檢視中看到所有代理程式。
- 想在已付費的方案上混用 Claude Code、Codex 和其他 CLI。
- 有多步驟的工作流程，並想針對每個專案自訂其代理程式和自動化。
- 想在離開座位時，透過手機回覆你的代理程式。

**如果你符合以下情況，它可能不適合你：**

- 偏好一次只處理一項任務，從頭做到尾。
- 只在單一專案中工作，很少切換。
- 不使用代理程式 CLI，或偏好 Cursor 或 Claude Desktop 之類的應用程式。
- 你的開發方式用不到工作流程或自動化。
- 希望代理程式在雲端執行，而不是在你的電腦上執行。

如果你覺得這個專案有用，給一顆 ⭐ 可以幫助其他開發人員找到 Kangentic。

## 安裝

```bash
npx kangentic
```

這會從 [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) 下載適用於你平台的最新版本、安裝並開啟它。之後應用程式會自行更新。如果你想自行執行安裝程式，也可以在版本頁面上找到。

**需求**

- Windows x64、搭載 Apple Silicon 或 Intel 的 macOS 13 或更新版本，或 Linux x64 或 arm64（`.deb` 或 `.rpm`）。Intel Mac 上無法使用 Knowledge Graph。
- `npx` 需要 Node.js 20 或更新版本，以及 Git 2.26 或更新版本。
- 至少一個已安裝並登入的[支援的代理程式 CLI](#supported-agents)。

WSL 使用者請安裝 Windows 版本，並可選擇 WSL 發行版作為終端機殼層。代理程式會執行每個 CLI 的 Windows 安裝版本，因此只安裝在發行版內的 CLI 將無法被找到。[安裝指南](https://www.kangentic.com/guide/installation/)涵蓋了每個平台。

## 運作方式

1. **設定看板。** 保留預設的欄或重新調整，並為每一欄選擇要執行的代理程式和權限模式。
2. **建立任務。** 為任務提供標題和提示，或從 GitHub Issues、GitHub Projects、Azure DevOps 或 Asana 匯入。
3. **拖曳即執行。** Kangentic 會建立工作樹、套用該欄的權限模式，並啟動代理程式。
4. **看著它寫程式。** 在即時終端機中追蹤代理程式、在它提問時回答，並在完成後將卡片拖曳到下一欄。

<a name="supported-agents"></a>
## 支援的代理程式

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex CLI](https://developers.openai.com/codex/cli)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[Cursor CLI](https://cursor.com/docs/cli/overview)、[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)、[Grok Build](https://github.com/xai-org/grok-build)、[Antigravity CLI](https://antigravity.google/docs/cli/getting-started)、[Goose CLI](https://github.com/aaif-goose/goose)、[OpenCode](https://opencode.ai/docs)、[Aider](https://aider.chat/)、[Qwen Code](https://github.com/QwenLM/qwen-code)、[Kimi Code](https://github.com/MoonshotAI/kimi-cli)、[Factory Droid](https://docs.factory.ai/cli/getting-started/overview)、[Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli)，以及以單回合聊天方式使用本機模型的 [Ollama](https://ollama.com)。

重新啟動後繼續工作階段、MCP 看板工具，以及將歷程記錄交給下一個代理程式等功能，取決於所使用的 CLI。請參閱[各代理程式支援的功能](https://www.kangentic.com/features/agent-orchestration/#supported-agents)。

## 語言

Kangentic 的介面提供本頁頂端列出的每種語言。可在 Settings > Language 中變更，Kangentic 會以該語言重新啟動。這些翻譯由機器產生並開放審閱，[翻譯](docs/contributing/translations.md)說明了如何修正翻譯。

## 資料與隱私權

你的看板、任務和對話記錄都會保存在本機的 SQLite 資料庫中。代理程式 CLI 會使用你自己的帳戶連線至其各自的提供者，就像在你的終端機中一樣。

正式發行版本預設會傳送匿名使用事件 (Aptabase) 和錯誤報告 (Sentry)。使用事件絕不包含任務文字、提示或程式碼。設定 `KANGENTIC_TELEMETRY=0` 可同時關閉兩者，或設定 `KANGENTIC_ERROR_REPORTING=0` 僅關閉錯誤報告。應用程式內沒有切換開關。應用程式也會向 GitHub 檢查更新和公告。完整清單請參閱[隱私權政策](https://www.kangentic.com/privacy/)。

## 文件

請先從[快速入門](https://www.kangentic.com/getting-started/)開始，再參閱[文件](https://www.kangentic.com/overview/)以了解欄、自動化、工作流程、MCP 伺服器和組態。

## 開發

從原始碼建置需要 Node.js 22.14 或更新版本，或 24 或更新版本。

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## 參與貢獻

如需專案結構、測試和慣例的相關資訊，請參閱 [CONTRIBUTING.md](CONTRIBUTING.md)。貢獻者須在第一個提取要求合併前簽署 [CLA](CLA.md)。

## 支援

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions)：提出問題和功能要求
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues)：回報錯誤
- [support@kangentic.com](mailto:support@kangentic.com)：如果你不想公開發文

若要回報安全性問題，請參閱 [SECURITY.md](SECURITY.md)。

## 授權

[AGPL-3.0](LICENSE)。如需商業授權，請寄送電子郵件至 licensing@kangentic.com。
