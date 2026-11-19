<!-- readme-translation source-blob=ef6ed72a1d4b6736b32f5cd06be82d664e91fc50 -->
> 這是 [README.md](../README.md) 於 `ef6ed72` 的機器翻譯。以英文版本為準。

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic 標誌" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>拖曳卡片，代理程式隨即啟動。</strong><br />
  為 AI 程式設計代理程式打造的代理式開發環境。
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="最新版本" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm 版本" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 授權" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="Kangentic 看板，任務分佈在「待辦」、「規劃」、「執行中」與「程式碼審查」欄。每張執行中的卡片都會顯示其代理程式的最新訊息，所選代理程式的終端機則開啟在看板下方。點選即可開啟線上示範。" width="900" />
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
  <a href="../README.md">English</a> |
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

程式設計代理程式可以自行完成一項任務，而 Git 工作樹讓多個代理程式能同時執行。這時瓶頸就變成了你：哪個代理程式正在等待提示、哪個已經完成、每個分支又進展到哪裡。Kangentic 將每個工作階段放在同一個看板上，並標記出需要你處理的工作階段。

### 在同一個看板上執行你的代理程式

- **一個看板，所有代理程式。** 每張卡片會顯示其模型、內容視窗的使用量，以及代理程式最後說的話，並標記出需要你處理的卡片。
- **Kangentic Mobile。** 只要配對手機一次，就能在離開座位時查看代理程式、回答讓代理程式停下來的問題，並審查其差異。連線採用端對端加密，透過 Kangentic 的轉送伺服器或你自行架設的轉送伺服器。可從 [App Store](https://apps.apple.com/app/kangentic/id6794952339) 或 [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile) 下載。
- **十五種代理程式 CLI。** 用 Claude Code 規劃、用 Codex 建置，或在所有地方都使用同一個 CLI。Kangentic 會以你已設定好的認證執行你既有的 CLI。不需要 API 金鑰、不需要 Proxy，也不需要 Kangentic 帳戶。
- **所有專案集中一處。** 每個存放庫都有自己的看板，而代理程式監視器會顯示所有存放庫中正在執行的代理程式。
- **在看板上審查。** 「變更」面板會顯示每個任務的差異與提交歷程記錄。在 GitHub 或 Azure DevOps 上連結的提取要求會顯示其狀態，以及是否已可合併。
- **免費且開放原始碼。** 採用 AGPL-3.0 授權，包含所有功能，沒有付費方案。

### 打造工作流程

- **欄。** 重新命名、新增及重新串接欄，直到看板符合你的出貨方式。每一欄都有自己的代理程式、模型、投入程度與權限模式。這些設定會儲存在 `kangentic.json` 中並隨存放庫一起提交，讓團隊成員取得相同的看板，而任務與代理程式工作階段則保留在每個人的電腦上。
- **自動化。** 當任務進入某一欄、其代理程式完成一輪回應，或任務離開該欄時，該欄可以傳送訊息或斜線命令給代理程式、執行指令碼、呼叫 Webhook、通知你，或將任務移至下一欄。以白話撰寫並由代理程式檢查的條件，會決定某個步驟是否執行。
- **工作流程。** 提供簡介給工作流程代理程式，審查它規劃的相互連結任務，然後按下「開始」。每個任務會在其所等待的任務抵達「完成」時開始，而一個工作流程可以橫跨多個專案。
- **能操作看板的代理程式。** Kangentic 的 MCP 伺服器讓執行中的代理程式能建立任務、移動自己的卡片、搜尋過去的對話，以及傳送訊息給另一個任務的代理程式，因此寫在提示中的規則就能推動工作進展。

## 適合你嗎？

**如果你符合以下情況，就很適合：**

- 同時執行多個程式設計代理程式，卻搞不清楚哪一個正在等你。
- 在多個專案或客戶之間處理任務，並希望在同一個畫面中看到所有代理程式。
- 想在已付費的方案上混用 Claude Code、Codex 與其他 CLI。
- 有多步驟的工作流程，並想依專案自訂其代理程式與自動化。
- 想在離開座位時用手機回覆你的代理程式。

**如果你符合以下情況，可能就不適合：**

- 偏好一次只處理一個任務，從頭做到尾。
- 只在單一專案中工作，很少切換。
- 不使用代理程式 CLI，或偏好 Cursor 或 Claude Desktop 之類的應用程式。
- 你的開發方式用不到工作流程或自動化。
- 希望代理程式在雲端執行，而不是在你的電腦上。

如果這看起來有用，給個 ⭐ 能幫助其他開發人員找到 Kangentic。

## 安裝

```bash
npx kangentic
```

這會從 [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) 下載適用於你平台的最新版本、進行安裝並開啟。之後應用程式會自行更新。如果你想自己執行安裝程式，也可以在版本頁面上找到。

**需求**

- Windows x64、搭載 Apple Silicon 或 Intel 的 macOS 13 或更新版本，或 Linux x64 或 arm64 (`.deb` 或 `.rpm`)。Intel Mac 無法使用知識圖譜。
- Node.js 20 或更新版本 (用於 `npx`)，以及 Git 2.26 或更新版本。
- 至少一個已安裝並登入的[支援的代理程式 CLI](#supported-agents)。

WSL 使用者請安裝 Windows 版本，並可選擇 WSL 發行版作為終端機殼層。代理程式會執行各 CLI 的 Windows 安裝版本，因此只安裝在發行版內的 CLI 將無法被找到。[安裝指南](https://www.kangentic.com/guide/installation/)涵蓋了各個平台。

## 運作方式

1. **設定看板。** 保留預設欄或重新調整，並為每一欄選擇要執行的代理程式與權限模式。
2. **建立任務。** 為任務提供標題與提示，或從 GitHub Issues、GitHub Projects、Azure DevOps、Asana、Jira、Linear、Trello、GitLab 或 Obsidian 保存庫匯入。
3. **拖曳即可執行。** Kangentic 會建立工作樹、套用該欄的權限模式，並啟動代理程式。
4. **看著它寫程式。** 在即時終端機中追蹤代理程式、在它提問時回答，並在完成後將卡片拖曳到下一欄。

<a name="supported-agents"></a>
## 支援的代理程式

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex CLI](https://developers.openai.com/codex/cli)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[Cursor CLI](https://cursor.com/docs/cli/overview)、[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)、[Grok Build](https://github.com/xai-org/grok-build)、[Antigravity CLI](https://antigravity.google/docs/cli/getting-started)、[Goose CLI](https://github.com/aaif-goose/goose)、[OpenCode](https://opencode.ai/docs)、[Aider](https://aider.chat/)、[Qwen Code](https://github.com/QwenLM/qwen-code)、[Kimi Code](https://github.com/MoonshotAI/kimi-code)、[Factory Droid](https://docs.factory.ai/cli/getting-started/overview)、[Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli)，以及以單輪聊天方式使用本機模型的 [Ollama](https://ollama.com)。

重新啟動後繼續執行、MCP 看板工具，以及將歷程記錄交給下一個代理程式，這些功能取決於 CLI。請參閱[各代理程式支援的功能](https://www.kangentic.com/features/agent-orchestration/#supported-agents)。

## 語言

Kangentic 的介面提供本頁頂端列出的每種語言。可在 Settings > Language 中變更，Kangentic 會以該語言重新啟動。翻譯皆由機器產生並開放審查，[翻譯](../docs/contributing/translations.md)說明了如何修正翻譯。

## 資料與隱私權

你的看板、任務與對話記錄都保存在本機 SQLite 資料庫中。代理程式 CLI 會以你自己的帳戶連線至各自的提供者，就像在你的終端機中一樣。

發行組建預設會傳送匿名使用事件 (Aptabase) 與錯誤報告 (Sentry)。使用事件絕不包含任務文字、提示或程式碼。設定 `KANGENTIC_TELEMETRY=0` 可同時關閉兩者，或設定 `KANGENTIC_ERROR_REPORTING=0` 只關閉錯誤報告。應用程式內沒有切換開關。應用程式也會向 GitHub 檢查更新與公告。完整清單請參閱[隱私權政策](https://www.kangentic.com/privacy/)。

## 文件

先從[快速入門](https://www.kangentic.com/getting-started/)開始，再參閱[文件](https://www.kangentic.com/overview/)了解欄、自動化、工作流程、MCP 伺服器與設定。

## 開發

從原始碼建置需要 Node.js 22.14 或更新版本，或 24 或更新版本。

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## 參與貢獻

如需專案結構、測試與慣例，請參閱 [CONTRIBUTING.md](../CONTRIBUTING.md)。貢獻者須在第一個提取要求合併前簽署 [CLA](../CLA.md)。

## 支援

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions)：提問與功能要求
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues)：錯誤回報
- [support@kangentic.com](mailto:support@kangentic.com)：如果你不想公開發文

若要回報安全性問題，請參閱 [SECURITY.md](../SECURITY.md)。

## 授權

[AGPL-3.0](../LICENSE)。如需商業授權，請寄信至 licensing@kangentic.com。
