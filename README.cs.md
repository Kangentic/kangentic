<!-- readme-translation source-blob=3c139f6ee74019ac75b29fddea661fd14d0b0846 -->
> Toto je strojový překlad souboru [README.md](README.md) v revizi `3c139f6`. Kanonickou verzí je anglická verze.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Logo Kangentic" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Přetáhněte kartu. Spustí se agent.</strong><br />
  Agentní vývojové prostředí pro AI agenty pro programování.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Nejnovější verze" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="Verze npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="Licence AGPL-3.0" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="Nástěnka Kangentic s úkoly ve sloupcích K provedení, Plánování, Provádění a Revize kódu. Každá spuštěná karta zobrazuje poslední zprávu svého agenta a pod nástěnkou je otevřený terminál vybraného agenta. Otevře živou ukázku." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">Živá ukázka</a> |
  <a href="https://www.kangentic.com/getting-started/">Rychlý start</a> |
  <a href="https://www.kangentic.com/overview/">Dokumentace</a>
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
  <a href="README.ja.md">日本語</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.pt-BR.md">Português (Brasil)</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.pl.md">Polski</a> |
  Čeština |
  <a href="README.hu.md">Magyar</a>
</p>
<!-- /language-switcher -->

## Co to dělá

Agent pro programování zvládne úkol sám a pracovní stromy Gitu umožňují spustit jich několik najednou. Omezením se pak stáváte vy: který agent čeká na odpověď, který skončil a kam se poděla která větev. Kangentic dá všechny relace na jednu nástěnku a označí ty, které vás potřebují.

### Spouštějte agenty z jedné nástěnky

- **Jedna nástěnka, všichni agenti.** Každá karta zobrazuje svůj model, jak velká část kontextového okna je využitá a co agent naposledy řekl. Karty, které vás potřebují, jsou označené.
- **Kangentic Mobile.** Jednou spárujte telefon a pak můžete i mimo svůj stůl kontrolovat agenty, odpovídat na otázku, na které se agent zastavil, a procházet jeho diff. Spojení je koncově šifrované a vede přes relay Kangentic nebo přes vlastní, který si sami hostujete. Stáhněte si aplikaci z [App Store](https://apps.apple.com/app/kangentic/id6794952339) nebo [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile).
- **Patnáct agentních CLI.** Plánujte s Claude Code a implementujte s Codex, nebo používejte všude jedno CLI. Kangentic spouští CLI, která už máte, s přihlašovacími údaji, které už máte nastavené. Žádný klíč API, žádná proxy, žádný účet Kangentic.
- **Všechny projekty na jednom místě.** Každé úložiště má vlastní nástěnku a Monitor agentů zobrazuje agenty spuštěné napříč všemi z nich.
- **Revize přímo na nástěnce.** Panel Změny zobrazuje diff a historii commitů každého úkolu. Propojený pull request na platformě GitHub nebo Azure DevOps ukazuje svůj stav a to, zda je připravený ke sloučení.
- **Zdarma a open source.** AGPL-3.0, se všemi funkcemi a bez placené úrovně.

### Přizpůsobte si pracovní postup

- **Sloupce.** Přejmenovávejte, přidávejte a přepojujte sloupce, dokud nástěnka neodpovídá tomu, jak dodáváte. Každý sloupec má vlastního agenta, model, úroveň úsilí a režim oprávnění. Nastavení se commituje spolu s úložištěm v `kangentic.json`, takže kolegové dostanou stejnou nástěnku, zatímco úkoly a relace agentů zůstávají na počítači každého z nich.
- **Automatizace.** Když úkol vstoupí do sloupce, když jeho agent dokončí tah nebo když úkol sloupec opustí, může sloupec poslat agentovi zprávu nebo lomítkový příkaz, spustit skript, zavolat webhook, upozornit vás nebo přesunout úkol do dalšího sloupce. O tom, zda se krok spustí, rozhoduje podmínka napsaná běžnými slovy, kterou vyhodnotí agent.
- **Pracovní postupy.** Předejte agentovi pracovního postupu zadání, zkontrolujte propojené úkoly, které naplánuje, a stiskněte Spustit. Každý úkol se spustí, jakmile úkoly, na které čeká, dorazí do sloupce Hotovo, a jeden pracovní postup může zahrnovat několik projektů.
- **Agenti, kteří pracují s nástěnkou.** MCP server Kangentic umožňuje spuštěnému agentovi vytvářet úkoly, přesouvat vlastní kartu, prohledávat minulé konverzace a posílat zprávy agentovi jiného úkolu, takže práci může posouvat dál i pravidlo napsané v promptu.

## Hodí se pro vás?

**Hodí se pro vás, pokud:**

- spouštíte několik agentů pro programování najednou a ztrácíte přehled o tom, který na vás čeká.
- žonglujete s úkoly napříč několika projekty nebo klienty a chcete mít všechny agenty v jednom zobrazení.
- chcete kombinovat Claude Code, Codex a další CLI v rámci předplatných, za která už platíte.
- máte vícekrokový pracovní postup a chcete jeho agenty a automatizace přizpůsobit pro každý projekt.
- chcete agentům odpovídat z telefonu, když odejdete od počítače.

**Spíš se pro vás nehodí, pokud:**

- dáváte přednost práci na jednom úkolu najednou, od začátku do konce.
- pracujete v jediném projektu a málokdy přepínáte.
- nepoužíváte agentní CLI nebo dáváte přednost aplikacím jako Cursor či Claude Desktop.
- při vývoji nevyužijete pracovní postupy ani automatizace.
- chcete, aby agenti běželi v cloudu, a ne na vašem počítači.

Pokud vám to připadá užitečné, ⭐ pomůže dalším vývojářům Kangentic najít.

## Instalace

```bash
npx kangentic
```

Tento příkaz stáhne nejnovější verzi pro vaši platformu z [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest), nainstaluje ji a otevře. Potom se už aplikace aktualizuje sama. Pokud chcete instalační program spustit sami, najdete instalační programy také na stránce s verzemi.

**Požadavky**

- Windows x64, macOS 13 nebo novější na Apple Silicon nebo Intel, nebo Linux x64 či arm64 (`.deb` nebo `.rpm`). Graf znalostí není na Macích s procesorem Intel k dispozici.
- Node.js 20 nebo novější pro `npx` a Git 2.26 nebo novější.
- Alespoň jedno [podporované agentní CLI](#supported-agents), nainstalované a přihlášené.

Uživatelé WSL nainstalují verzi pro Windows a jako shell terminálu si mohou vybrat distribuci WSL. Agenti spouštějí instalaci každého CLI ve Windows, takže CLI nainstalované jen uvnitř distribuce se nenajde. [Průvodce instalací](https://www.kangentic.com/guide/installation/) popisuje jednotlivé platformy.

## Jak to funguje

1. **Nastavte nástěnku.** Ponechte výchozí sloupce nebo je upravte a u každého vyberte agenta a režim oprávnění, se kterým běží.
2. **Vytvořte úkol.** Zadejte název a prompt, nebo úkol importujte z GitHub Issues, GitHub Projects, Azure DevOps nebo Asana.
3. **Přetažením spusťte.** Kangentic vytvoří pracovní strom, použije režim oprávnění daného sloupce a spustí agenta.
4. **Sledujte, jak programuje.** Sledujte agenta v jeho živém terminálu, odpovídejte, když se na něco ptá, a až skončí, přetáhněte kartu dál.

<a name="supported-agents"></a>
## Podporovaní agenti

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-cli), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli) a [Ollama](https://ollama.com) pro lokální modely v podobě jednokolového chatu.

Obnovení po restartu, nástroje nástěnky MCP a předání historie dalšímu agentovi závisí na konkrétním CLI. Viz [co který agent podporuje](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Jazyky

Rozhraní Kangentic je k dispozici v každém jazyce uvedeném v horní části této stránky. Jazyk změníte v Settings > Language a Kangentic se v něm restartuje. Překlady jsou strojové a otevřené ke kontrole. Jak některý z nich opravit, vysvětlují [Překlady](docs/contributing/translations.md).

## Data a soukromí

Vaše nástěnky, úkoly a přepisy zůstávají v lokální databázi SQLite. Agentní CLI se připojují ke svým poskytovatelům pod vašimi vlastními účty, stejně jako ve vašem terminálu.

Vydané sestavení ve výchozím nastavení odesílá anonymní události využití (Aptabase) a hlášení chyb (Sentry). Události využití nikdy neobsahují text úkolů, prompty ani kód. Nastavením `KANGENTIC_TELEMETRY=0` vypnete obojí, nastavením `KANGENTIC_ERROR_REPORTING=0` vypnete jen hlášení chyb. Přepínač pro to v aplikaci není. Aplikace také kontroluje aktualizace a oznámení na platformě GitHub. Úplný seznam najdete v [zásadách ochrany osobních údajů](https://www.kangentic.com/privacy/).

## Dokumentace

Začněte [rychlým startem](https://www.kangentic.com/getting-started/) a pak pokračujte [dokumentací](https://www.kangentic.com/overview/) ke sloupcům, automatizacím, pracovním postupům, MCP serveru a konfiguraci.

## Vývoj

Sestavení ze zdrojového kódu vyžaduje Node.js 22.14 nebo novější, případně 24 nebo novější.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Přispívání

Informace o struktuře projektu, testech a konvencích najdete v [CONTRIBUTING.md](CONTRIBUTING.md). Přispěvatelé podepisují [CLA](CLA.md) před sloučením svého prvního pull requestu.

## Podpora

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) pro dotazy a návrhy nových funkcí
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) pro hlášení chyb
- [support@kangentic.com](mailto:support@kangentic.com), pokud nechcete psát veřejně

Bezpečnostní problém nahlaste podle pokynů v [SECURITY.md](SECURITY.md).

## Licence

[AGPL-3.0](LICENSE). Pokud chcete komerční licenci, napište na licensing@kangentic.com.
