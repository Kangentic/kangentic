<!-- readme-translation source-blob=ef6ed72a1d4b6736b32f5cd06be82d664e91fc50 -->
> Ez a(z) [README.md](../README.md) gépi fordítása a(z) `ef6ed72` állapot szerint. Az angol változat a mérvadó.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic logó" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Húzz el egy kártyát. Elindul egy ügynök.</strong><br />
  Agentikus fejlesztői környezet AI-kódolóügynökökhöz.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Legújabb kiadás" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm-verzió" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 licenc" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="A Kangentic tábla a Teendő, Tervezés, Végrehajtás és Kódellenőrzés oszlopokban lévő feladatokkal. Minden futó kártya az ügynöke legutóbbi üzenetét mutatja, a kijelölt ügynök terminálja pedig a tábla alatt látható. Megnyitja az élő demót." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">Élő demó</a> |
  <a href="https://www.kangentic.com/getting-started/">Gyors kezdés</a> |
  <a href="https://www.kangentic.com/overview/">Dokumentáció</a>
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
  <a href="README.cs.md">Čeština</a> |
  Magyar
</p>
<!-- /language-switcher -->

## Mire képes?

Egy kódolóügynök önállóan is végig tud vinni egy feladatot, a git worktree-k pedig lehetővé teszik, hogy egyszerre több is fusson. Ekkor már te leszel a korlát: melyik ügynök vár egy promptra, melyik végzett, és mi lett az egyes ágakkal. A Kangentic minden munkamenetet egyetlen táblára helyez, és megjelöli azokat, amelyeknek rád van szükségük.

### Futtasd az ügynökeidet egyetlen tábláról

- **Egy tábla, minden ügynök.** Minden kártya mutatja a modelljét, a kontextusablak kihasználtságát és az ügynök utolsó üzenetét, és megjelöli azokat, amelyeknek rád van szükségük.
- **Kangentic Mobile.** Párosítsd egyszer a telefonodat, és utána az asztalodtól távol is ránézhetsz az ügynökökre, megválaszolhatod a kérdést, amelynél egy ügynök megállt, és átnézheted a diffjét. A kapcsolat végpontok közötti titkosítást használ, a Kangentic továbbítószerverén vagy egy saját üzemeltetésű továbbítón keresztül. Elérhető az [App Store](https://apps.apple.com/app/kangentic/id6794952339) és a [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile) áruházban.
- **Tizenöt ügynök-CLI.** Tervezz a Claude Code-dal és építs a Codexszel, vagy használj mindenhol egyetlen CLI-t. A Kangentic a már meglévő CLI-jeidet futtatja a már beállított hitelesítő adataiddal. Nincs API-kulcs, nincs proxy, nincs Kangentic-fiók.
- **Minden projekt egy helyen.** Minden repó saját táblát kap, az Ügynökfigyelő pedig az összes táblán futó ügynököket mutatja.
- **Áttekintés a táblán.** A Változások panel minden feladat diffjét és commitelőzményeit mutatja. A GitHubon vagy Azure DevOpsban csatolt pull request megjeleníti az állapotát, és azt, hogy egyesíthető-e.
- **Ingyenes és nyílt forráskódú.** AGPL-3.0, minden funkcióval, fizetős csomag nélkül.

### A munkafolyamat alakítása

- **Oszlopok.** Nevezd át, add hozzá és kösd át az oszlopokat, amíg a tábla meg nem felel annak, ahogyan szállítasz. Minden oszlopnak saját ügynöke, modellje, erőfeszítési szintje és engedélymódja van. A beállítás a repóval együtt kerül commitba a `kangentic.json` fájlban, így a csapattársak ugyanazt a táblát kapják, a feladatok és az ügynök-munkamenetek viszont mindenkinek a saját gépén maradnak.
- **Automatizálások.** Amikor egy feladat belép egy oszlopba, amikor az ügynöke befejez egy kört, vagy amikor a feladat kilép, az oszlop üzenetet vagy perjeles parancsot küldhet az ügynöknek, futtathat egy szkriptet, meghívhat egy webhookot, értesíthet téged, vagy áthelyezheti a feladatot a következő oszlopba. Egy hétköznapi szavakkal megfogalmazott feltétel, amelyet egy ügynök ellenőriz, dönti el, hogy egy lépés lefut-e.
- **Munkafolyamatok.** Adj egy rövid leírást a munkafolyamat-ügynöknek, nézd át az általa tervezett, egymáshoz kapcsolt feladatokat, és nyomd meg az Indítás gombot. Minden feladat akkor indul, amikor azok a feladatok, amelyekre vár, elérik a Kész oszlopot, és egy munkafolyamat több projektre is kiterjedhet.
- **A táblán dolgozó ügynökök.** A Kangentic MCP-szervere lehetővé teszi, hogy egy futó ügynök feladatokat hozzon létre, áthelyezze a saját kártyáját, korábbi beszélgetésekben keressen, és üzenetet küldjön egy másik feladat ügynökének, így egy promptba írt szabály is továbbviheti a munkát.

## Neked való?

**Jó választás, ha:**

- egyszerre több kódolóügynököt futtatsz, és elveszíted a fonalat, hogy melyik vár rád.
- több projekt vagy ügyfél feladatai között zsonglőrködsz, és minden ügynököt egy nézetben szeretnél látni.
- a Claude Code-ot, a Codexet és más CLI-ket szeretnéd vegyesen használni a már kifizetett előfizetéseiddel.
- többlépéses munkafolyamatod van, és projektenként szeretnéd testre szabni az ügynökeit és automatizálásait.
- a telefonodról szeretnél válaszolni az ügynökeidnek, amikor nem vagy a gépnél.

**Valószínűleg nem neked való, ha:**

- szívesebben dolgozol egyszerre egy feladaton, az elejétől a végéig.
- egyetlen projekten dolgozol, és ritkán váltasz.
- nem használsz ügynök-CLI-ket, vagy az olyan alkalmazásokat részesíted előnyben, mint a Cursor vagy a Claude Desktop.
- a fejlesztési folyamatodban nincs szükséged munkafolyamatokra vagy automatizálásokra.
- azt szeretnéd, hogy az ügynökeid a felhőben fussanak a saját géped helyett.

Ha hasznosnak tűnik, egy ⭐ segít más fejlesztőknek megtalálni a Kangenticet.

## Telepítés

```bash
npx kangentic
```

Ez letölti a platformodhoz tartozó legújabb kiadást a [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) oldalról, telepíti és megnyitja. Ezután az alkalmazás magától frissül. A telepítők a kiadások oldalán is megtalálhatók, ha inkább magad futtatnád valamelyiket.

**Követelmények**

- Windows x64, macOS 13 vagy újabb Apple Silicon vagy Intel processzoron, illetve Linux x64 vagy arm64 (`.deb` vagy `.rpm`). A Tudásgráf nem érhető el Intel-alapú Maceken.
- Node.js 20 vagy újabb az `npx`-hez, és Git 2.26 vagy újabb.
- Legalább egy [támogatott ügynök-CLI](#supported-agents), telepítve és bejelentkezve.

A WSL-felhasználók a Windows-verziót telepítik, és terminálhéjként kiválaszthatnak egy WSL-disztribúciót. Az ügynökök az egyes CLI-k Windows-os telepítését futtatják, ezért a csak a disztribúción belül telepített CLI-t nem találják. A [telepítési útmutató](https://www.kangentic.com/guide/installation/) minden platformot ismertet.

## Hogyan működik?

1. **Állítsd be a táblát.** Tartsd meg az alapértelmezett oszlopokat, vagy alakítsd át őket, és válaszd ki, melyik ügynököt és engedélymódot futtassa mindegyik.
2. **Hozz létre egy feladatot.** Adj neki címet és promptot, vagy importálj egyet a következők valamelyikéből: GitHub Issues, GitHub Projects, Azure DevOps, Asana, Jira, Linear, Trello, GitLab vagy egy Obsidian-tároló.
3. **Húzd át a futtatáshoz.** A Kangentic létrehozza a worktree-t, alkalmazza az oszlop engedélymódját, és elindítja az ügynököt.
4. **Nézd, ahogy kódol.** Kövesd az ügynököt az élő termináljában, válaszolj, amikor kérdez, és húzd tovább a kártyát, amikor végzett.

<a name="supported-agents"></a>
## Támogatott ügynökök

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-code), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli), valamint az [Ollama](https://ollama.com) helyi modellekhez, egyfordulós csevegésként.

Az újraindítás utáni folytatás, az MCP táblaeszközei és az előzmények átadása a következő ügynöknek CLI-függő. Lásd: [melyik ügynök mit támogat](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Nyelvek

A Kangentic felülete az oldal tetején felsorolt összes nyelven elérhető. A Settings > Language alatt módosíthatod, és a Kangentic ezen a nyelven indul újra. A fordítások gépi fordítások, és bárki átnézheti őket; a [Fordítások](../docs/contributing/translations.md) leírja, hogyan javíthatsz ki egyet.

## Adatok és adatvédelem

A tábláid, feladataid és átirataid egy helyi SQLite-adatbázisban maradnak. Az ügynök-CLI-k a saját fiókjaiddal érik el a saját szolgáltatóikat, ugyanúgy, ahogy a terminálodban tennék.

A kiadási buildek alapértelmezés szerint névtelen használati eseményeket (Aptabase) és hibajelentéseket (Sentry) küldenek. A használati események soha nem tartalmaznak feladatszöveget, promptokat vagy kódot. Mindkettő kikapcsolásához állítsd be a `KANGENTIC_TELEMETRY=0` értéket, vagy csak a hibajelentések kikapcsolásához a `KANGENTIC_ERROR_REPORTING=0` értéket. Alkalmazáson belüli kapcsoló nincs. Az alkalmazás a GitHubon frissítéseket és közleményeket is keres. A teljes listát az [adatvédelmi irányelvekben](https://www.kangentic.com/privacy/) találod.

## Dokumentáció

Kezdd a [gyors kezdéssel](https://www.kangentic.com/getting-started/), majd folytasd a [dokumentációval](https://www.kangentic.com/overview/), amely az oszlopokat, az automatizálásokat, a munkafolyamatokat, az MCP-szervert és a konfigurációt ismerteti.

## Fejlesztés

A forrásból való buildeléshez Node.js 22.14 vagy újabb, illetve 24 vagy újabb verzió szükséges.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Közreműködés

A projekt felépítéséről, a tesztekről és a konvenciókról a [CONTRIBUTING.md](../CONTRIBUTING.md) fájlban olvashatsz. A közreműködők az első pull requestjük egyesítése előtt aláírják a [CLA](../CLA.md) dokumentumot.

## Támogatás

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) kérdésekhez és funkciókérésekhez
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) hibajelentésekhez
- [support@kangentic.com](mailto:support@kangentic.com), ha nem szeretnél nyilvánosan posztolni

Biztonsági probléma jelentéséhez lásd a [SECURITY.md](../SECURITY.md) fájlt.

## Licenc

[AGPL-3.0](../LICENSE). Kereskedelmi licencért írj a licensing@kangentic.com címre.
