<!-- readme-translation source-blob=9c65bada5dcd25126a88e6b2728e7cb56ea71c6e -->
> 這是 [README.md](../README.md) 在 `9c65bad` 的機器翻譯版本。英文版本為正式版本。

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic 標誌" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>拖曳卡片，代理程式隨即啟動。</strong><br />
  專為 AI 程式碼撰寫代理程式打造的代理式開發環境。
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
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="Kangentic 看板，工作分布在待辦、規劃、執行中和程式碼審查等欄中。每張執行中的卡片都會顯示其代理程式的最新訊息，所選代理程式的終端機則開啟於看板下方。點選可開啟線上示範。" width="900" />
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

## 功能

程式碼撰寫代理程式可以獨力完成一項工作，而 Git 工作樹讓多個代理程式能同時執行。這時瓶頸就變成您自己：哪個代理程式正在等待提示、哪個已經完成，以及每個分支進展到哪裡。Kangentic 將每個工作階段都放在同一個看板上，並標示出需要您處理的工作階段。

### 從同一個看板執行您的代理程式

- **一個看板，容納所有代理程式。** 每張卡片都會顯示其模型、內容視窗的使用量，以及代理程式最後說的內容，並在需要您處理的卡片上加上標記。
- **Kangentic Mobile。** 只要配對手機一次，即使不在座位上，也能查看代理程式、回答讓代理程式停下來的問題，並檢閱其差異。連線採用端對端加密，透過 Kangentic 的轉送伺服器或您自行架設的轉送伺服器傳輸。您可以從 [App Store](https://apps.apple.com/app/kangentic/id6794952339) 或 [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile) 取得。
- **十五種代理程式 CLI。** 您可以用 Claude Code 規劃、用 Codex 建置，也可以全程使用同一個 CLI。Kangentic 會以您已設定的認證執行您現有的 CLI。不需要 API 金鑰、不需要 Proxy，也不需要 Kangentic 帳戶。
- **所有專案集中一處。** 每個存放庫都有自己的看板，而代理程式監視器會顯示在所有存放庫中執行的代理程式。
- **在看板上檢閱。** 變更面板會顯示每項工作的差異和提交歷程記錄。在 GitHub 或 Azure DevOps 上連結的提取要求會顯示其狀態，以及是否可以合併。
- **免費且開放原始碼。** 採用 AGPL-3.0 授權，包含所有功能，沒有付費方案。

### 調整工作流程

- **欄。** 您可以重新命名、新增欄並重新連接欄，直到看板符合您的交付方式。每一欄都有自己的代理程式、模型、投入程度和權限模式。這些設定會儲存在 `kangentic.json` 中，隨存放庫一起提交，因此團隊成員會取得相同的看板，而工作和代理程式工作階段則保留在每個人自己的電腦上。
- **自動化。** 當工作進入某一欄、其代理程式完成一個回合，或工作離開該欄時，該欄可以傳送訊息或斜線命令給代理程式、執行指令碼、呼叫 webhook、通知您，或將工作移至下一欄。以一般文字撰寫的條件會由代理程式檢查，以決定步驟是否執行。
- **工作流程。** 向工作流程代理程式提供簡報、檢閱它規劃的連結工作，然後按下開始。每項工作會在其等待的工作抵達完成欄時開始，而且一個工作流程可以跨越多個專案。
- **能操作看板的代理程式。** 透過 Kangentic 的 MCP 伺服器，執行中的代理程式可以建立工作、移動自己的卡片、搜尋過去的交談，以及傳送訊息給其他工作的代理程式，因此寫在提示中的規則就能推動工作進展。

## 適合您嗎？

**如果您符合下列情況，就很適合：**

- 同時執行多個程式碼撰寫代理程式，卻搞不清楚哪一個正在等您。
- 在多個專案或客戶之間同時處理工作，並想在同一個檢視中查看所有代理程式。
- 想在已付費的方案上混合使用 Claude Code、Codex 和其他 CLI。
- 有多步驟的工作流程，並想依專案自訂其代理程式和自動化。
- 想在離開座位時用手機回覆代理程式。

**如果您符合下列情況，可能就不適合：**

- 偏好一次處理一項工作，從頭做到尾。
- 只在單一專案中工作，很少切換。
- 不使用代理程式 CLI，或偏好 Cursor 或 Claude Desktop 這類應用程式。
- 開發時用不到工作流程或自動化。
- 希望代理程式在雲端執行，而不是在您的電腦上執行。

如果您覺得這個專案實用，給個 ⭐ 能幫助其他開發人員找到 Kangentic。

## 安裝

```bash
npx kangentic
```

這個命令會從 [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) 下載適用於您平台的最新版本，然後安裝並開啟。之後應用程式會自行更新。如果您想自行執行安裝程式，也可以在版本頁面上取得。

**需求**

- Windows x64、Apple Silicon 或 Intel 上的 macOS 13 或更新版本，或是 Linux x64 或 arm64 (`.deb` 或 `.rpm`)。知識圖譜無法在 Intel Mac 上使用。
- `npx` 需要 Node.js 20 或更新版本，另需 Git 2.26 或更新版本。
- 至少一個已安裝並登入的[支援的代理程式 CLI](#supported-agents)。

WSL 使用者請安裝 Windows 版本，並可選擇 WSL 發行版作為終端機殼層。代理程式會執行各 CLI 的 Windows 安裝版本，因此只安裝在發行版內的 CLI 將找不到。[安裝指南](https://www.kangentic.com/guide/installation/)涵蓋各平台的說明。

## 運作方式

1. **設定看板。** 保留預設欄或重新調整，並為每一欄選擇要執行的代理程式和權限模式。
2. **建立工作。** 為工作提供標題和提示，或從 GitHub Issues、GitHub Projects、Azure DevOps 或 Asana 匯入。
3. **拖曳以執行。** Kangentic 會建立工作樹、套用該欄的權限模式，並啟動代理程式。
4. **觀看代理程式撰寫程式碼。** 在即時終端機中追蹤代理程式、在它提問時回答，並在完成後將卡片往下拖曳。

<a name="supported-agents"></a>
## 支援的代理程式

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[Codex CLI](https://developers.openai.com/codex/cli)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)、[Cursor CLI](https://cursor.com/docs/cli/overview)、[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started)、[Grok Build](https://github.com/xai-org/grok-build)、[Antigravity CLI](https://antigravity.google/docs/cli/getting-started)、[Goose CLI](https://github.com/aaif-goose/goose)、[OpenCode](https://opencode.ai/docs)、[Aider](https://aider.chat/)、[Qwen Code](https://github.com/QwenLM/qwen-code)、[Kimi Code](https://github.com/MoonshotAI/kimi-code)、[Factory Droid](https://docs.factory.ai/cli/getting-started/overview)、[Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli)，以及以單回合聊天方式使用本機模型的 [Ollama](https://ollama.com)。

重新啟動後繼續工作、MCP 看板工具，以及將歷程記錄交給下一個代理程式等功能，取決於各個 CLI。請參閱[各代理程式支援的功能](https://www.kangentic.com/features/agent-orchestration/#supported-agents)。

## 語言

Kangentic 的介面提供本頁頂端列出的各種語言。您可以在 Settings > Language 中變更語言，Kangentic 會以該語言重新啟動。這些翻譯由機器產生，並開放審查，[翻譯](../docs/contributing/translations.md)說明如何修正翻譯。

## 資料與隱私權

您的看板、工作和文字記錄都保存在本機 SQLite 資料庫中。代理程式 CLI 會以您自己的帳戶連線到各自的提供者，就像在您的終端機中執行時一樣。

發行組建預設會傳送匿名使用事件 (Aptabase) 和錯誤報告 (Sentry)。使用事件絕不包含工作文字、提示或程式碼。設定 `KANGENTIC_TELEMETRY=0` 可同時關閉兩者，設定 `KANGENTIC_ERROR_REPORTING=0` 則只關閉錯誤報告。應用程式內沒有切換開關。應用程式也會向 GitHub 檢查更新和公告。如需完整清單，請參閱[隱私權原則](https://www.kangentic.com/privacy/)。

## 文件

請先閱讀[快速入門](https://www.kangentic.com/getting-started/)，再參閱[文件](https://www.kangentic.com/overview/)以了解欄、自動化、工作流程、MCP 伺服器和設定。

## 開發

從原始碼建置需要 Node.js 22.14 或更新版本，或 24 或更新版本。

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## 參與貢獻

如需專案結構、測試和慣例的相關資訊，請參閱 [CONTRIBUTING.md](../CONTRIBUTING.md)。貢獻者須在其第一個提取要求合併之前簽署 [CLA](../CLA.md)。

## 支援

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) 用於提問和功能要求
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) 用於回報錯誤
- 如果您不想公開張貼，請寄信至 [support@kangentic.com](mailto:support@kangentic.com)

若要回報安全性問題，請參閱 [SECURITY.md](../SECURITY.md)。

## 授權

[AGPL-3.0](../LICENSE)。如需商業授權，請寄送電子郵件至 licensing@kangentic.com。
