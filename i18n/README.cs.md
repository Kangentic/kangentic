<!-- readme-translation source-blob=9c65bada5dcd25126a88e6b2728e7cb56ea71c6e -->
> Toto je strojový překlad souboru [README.md](../README.md) v revizi `9c65bad`. Kanonická je anglická verze.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Logo Kangentic" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Přetáhněte kartu. Agent se spustí.</strong><br />
  Agentní vývojové prostředí pro programovací agenty s AI.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Nejnovější verze" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="Verze npm" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="Licence AGPL-3.0" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="Nástěnka Kangentic s úkoly ve sloupcích To Do, Planning, Executing a Code Review. Každá spuštěná karta ukazuje poslední zprávu svého agenta a pod nástěnkou je otevřený terminál vybraného agenta. Otevře živou ukázku." width="900" />
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
  <a href="../README.md">English</a> |
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

Programovací agent zvládne úkol dovést do konce sám a díky pracovním stromům Git jich může běžet několik současně. Limitem se pak stáváte vy: který agent čeká na prompt, který skončil a kam se poděla která větev. Kangentic dá všechny relace na jednu nástěnku a označí ty, které vás potřebují.

### Spouštějte agenty z jedné nástěnky

- **Jedna nástěnka, všichni agenti.** Každá karta ukazuje model, využití kontextového okna a poslední zprávu agenta a ty, které vás potřebují, jsou označené.
- **Kangentic Mobile.** Jednou si spárujte telefon a pak můžete i mimo svůj stůl kontrolovat agenty, odpovědět na otázku, u které se některý zastavil, a prohlédnout si jeho diff. Spojení je koncově šifrované a vede přes přenosový server Kangentic nebo váš vlastní. Aplikaci najdete v [App Store](https://apps.apple.com/app/kangentic/id6794952339) nebo na [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile).
- **Patnáct agentních CLI.** Plánujte v Claude Code a implementujte v Codex, nebo používejte jedno CLI všude. Kangentic spouští CLI, která už máte, s přihlašovacími údaji, které už máte nastavené. Žádný klíč API, žádná proxy, žádný účet Kangentic.
- **Všechny projekty na jednom místě.** Každé úložiště má vlastní nástěnku a Agent Monitor ukazuje agenty spuštěné napříč všemi z nich.
- **Revize přímo na nástěnce.** Panel Changes ukazuje diff a historii commitů každého úkolu. Propojený pull request z GitHub nebo Azure DevOps ukazuje svůj stav a to, zda je připravený ke sloučení.
- **Zdarma a s otevřeným zdrojovým kódem.** AGPL-3.0, se všemi funkcemi a bez placené úrovně.

### Přizpůsobte si pracovní postup

- **Sloupce.** Přejmenovávejte, přidávejte a přepojujte sloupce, dokud nástěnka neodpovídá tomu, jak vydáváte software. Každý sloupec má vlastní agenta, model, úsilí a režim oprávnění. Nastavení se commituje s úložištěm v `kangentic.json`, takže kolegové dostanou stejnou nástěnku, zatímco úkoly a relace agentů zůstávají na počítači každého z nich.
- **Automatizace.** Když úkol vstoupí do sloupce, když jeho agent dokončí tah nebo když úkol sloupec opustí, může sloupec poslat agentovi zprávu nebo lomítkový příkaz, spustit skript, zavolat webhook, upozornit vás nebo přesunout úkol do dalšího sloupce. O tom, zda se krok spustí, rozhoduje podmínka napsaná běžnými slovy, kterou ověřuje agent.
- **Pracovní postupy.** Předejte agentovi pracovního postupu zadání, zkontrolujte propojené úkoly, které naplánuje, a stiskněte Start. Každý úkol se spustí, jakmile úkoly, na které čeká, dosáhnou stavu Done, a jeden pracovní postup může zahrnovat několik projektů.
- **Agenti, kteří pracují s nástěnkou.** Server MCP od Kangentic umožňuje běžícímu agentovi vytvářet úkoly, přesouvat vlastní kartu, prohledávat minulé konverzace a posílat zprávy agentovi jiného úkolu, takže práci může posouvat dál i pravidlo napsané v promptu.

## Je to pro vás?

**Hodí se pro vás, pokud:**

- spouštíte několik programovacích agentů najednou a ztrácíte přehled o tom, který na vás čeká.
- žonglujete s úkoly napříč několika projekty nebo klienty a chcete mít všechny agenty v jednom zobrazení.
- chcete kombinovat Claude Code, Codex a další CLI v rámci plánů, které už platíte.
- máte vícekrokový pracovní postup a chcete jeho agenty a automatizace přizpůsobit pro každý projekt.
- chcete agentům odpovídat z telefonu, když odejdete od počítače.

**Spíš se pro vás nehodí, pokud:**

- raději pracujete na jednom úkolu od začátku do konce.
- pracujete v jediném projektu a přepínáte jen zřídka.
- nepoužíváte agentní CLI nebo dáváte přednost aplikacím jako Cursor nebo Claude Desktop.
- ve svém vývoji nevyužijete pracovní postupy ani automatizace.
- chcete, aby agenti běželi v cloudu, a ne na vašem počítači.

Pokud vám to přijde užitečné, ⭐ pomůže dalším vývojářům Kangentic najít.

## Instalace

```bash
npx kangentic
```

Tento příkaz stáhne nejnovější verzi pro vaši platformu z [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest), nainstaluje ji a otevře. Poté se aplikace aktualizuje sama. Instalační programy jsou také na stránce s verzemi, pokud byste si některý raději spustili sami.

**Požadavky**

- Windows x64, macOS 13 nebo novější na Apple Silicon nebo Intel, nebo Linux x64 či arm64 (`.deb` nebo `.rpm`). Knowledge Graph není na Macích s Intelem k dispozici.
- Node.js 20 nebo novější pro `npx` a Git 2.26 nebo novější.
- Alespoň jedno [podporované agentní CLI](#supported-agents), nainstalované a přihlášené.

Uživatelé WSL si nainstalují verzi pro Windows a jako shell terminálu si mohou vybrat distribuci WSL. Agenti spouštějí instalaci každého CLI ve Windows, takže CLI nainstalované pouze uvnitř distribuce se nenajde. [Průvodce instalací](https://www.kangentic.com/guide/installation/) popisuje jednotlivé platformy.

## Jak to funguje

1. **Nastavte si nástěnku.** Ponechte výchozí sloupce nebo je upravte a u každého vyberte agenta a režim oprávnění.
2. **Vytvořte úkol.** Zadejte název a prompt, nebo úkol importujte z GitHub Issues, GitHub Projects, Azure DevOps nebo Asana.
3. **Přetažením spusťte.** Kangentic vytvoří pracovní strom, použije režim oprávnění daného sloupce a spustí agenta.
4. **Sledujte, jak programuje.** Sledujte agenta v živém terminálu, odpovězte, když se zeptá, a až skončí, přetáhněte kartu dál.

<a name="supported-agents"></a>
## Podporovaní agenti

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-code), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli) a [Ollama](https://ollama.com) pro lokální modely jako chat s jedním tahem.

Obnovení po restartu, nástroje MCP pro nástěnku a předání historie dalšímu agentovi závisí na konkrétním CLI. Podívejte se, [co který agent podporuje](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Jazyky

Rozhraní Kangentic je k dispozici ve všech jazycích uvedených v horní části této stránky. Jazyk změníte v Settings > Language a Kangentic se v něm restartuje. Překlady jsou strojové a otevřené ke kontrole a v části [Překlady](../docs/contributing/translations.md) se dozvíte, jak některý opravit.

## Data a soukromí

Vaše nástěnky, úkoly a přepisy zůstávají v lokální databázi SQLite. Agentní CLI se připojují ke svým poskytovatelům pod vašimi vlastními účty, stejně jako ve vašem terminálu.

Sestavení verzí ve výchozím nastavení odesílají anonymní události o používání (Aptabase) a hlášení chyb (Sentry). Události o používání nikdy neobsahují text úkolů, prompty ani kód. Nastavením `KANGENTIC_TELEMETRY=0` vypnete obojí, nastavením `KANGENTIC_ERROR_REPORTING=0` vypnete jen hlášení chyb. Přepínač v aplikaci neexistuje. Aplikace také kontroluje na GitHub aktualizace a oznámení. Úplný seznam najdete v [zásadách ochrany osobních údajů](https://www.kangentic.com/privacy/).

## Dokumentace

Začněte [rychlým startem](https://www.kangentic.com/getting-started/) a pak pokračujte [dokumentací](https://www.kangentic.com/overview/) ke sloupcům, automatizacím, pracovním postupům, serveru MCP a konfiguraci.

## Vývoj

Sestavení ze zdrojového kódu vyžaduje Node.js 22.14 nebo novější, případně 24 nebo novější.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Přispívání

Strukturu projektu, testy a konvence popisuje [CONTRIBUTING.md](../CONTRIBUTING.md). Přispěvatelé podepisují [CLA](../CLA.md) před sloučením svého prvního pull requestu.

## Podpora

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) pro dotazy a požadavky na funkce
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) pro hlášení chyb
- [support@kangentic.com](mailto:support@kangentic.com), pokud nechcete psát veřejně

Bezpečnostní problém nahlaste podle [SECURITY.md](../SECURITY.md).

## Licence

[AGPL-3.0](../LICENSE). Komerční licenci si můžete vyžádat e-mailem na licensing@kangentic.com.
