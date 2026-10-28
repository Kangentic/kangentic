<!-- readme-translation source-blob=3c139f6ee74019ac75b29fddea661fd14d0b0846 -->
> Ez a [README.md](README.md) gépi fordítása, `3c139f6` állapot szerint. A hiteles változat az angol.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic logó" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Húzz át egy kártyát. Elindul egy ágens.</strong><br />
  Ágensalapú fejlesztői környezet AI-kódolóágensekhez.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Legújabb kiadás" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm-verzió" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 licenc" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="A Kangentic tábla a To Do, Planning, Executing és Code Review oszlopokban lévő feladatokkal. Minden futó kártya az ágense legutóbbi üzenetét mutatja, a kiválasztott ágens terminálja pedig a tábla alatt látható. Megnyitja az élő demót." width="900" />
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
  <a href="README.cs.md">Čeština</a> |
  Magyar
</p>
<!-- /language-switcher -->

## Mire jó?

Egy kódolóágens önállóan is végig tud vinni egy feladatot, a git worktree-k pedig lehetővé teszik, hogy egyszerre több is fusson. Ekkor már te leszel a szűk keresztmetszet: melyik ágens vár egy promptra, melyik végzett, és merre járnak az egyes ágak. A Kangentic minden munkamenetet egyetlen táblára tesz, és megjelöli azokat, amelyeknek rád van szükségük.

### Futtasd az ágenseidet egyetlen tábláról

- **Egy tábla, minden ágens.** Minden kártya mutatja a modellt, a kontextusablak kihasználtságát és az ágens utolsó üzenetét, a rád váró kártyákon pedig jelölés látható.
- **Kangentic Mobile.** Párosítsd egyszer a telefonodat, és az asztalodtól távol is ellenőrizheted az ágenseket, megválaszolhatod a kérdést, amelynél egy ágens megállt, és átnézheted a diffjét. A kapcsolat végponttól végpontig titkosított, és a Kangentic relayszerverén vagy egy általad üzemeltetett relayszerveren keresztül halad. Töltsd le az [App Store](https://apps.apple.com/app/kangentic/id6794952339) vagy a [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile) áruházból.
- **Tizenöt ágens-CLI.** Tervezz a Claude Code segítségével, és építs a Codex segítségével, vagy használj mindenhol egyetlen CLI-t. A Kangentic a már meglévő CLI-jeidet futtatja a már beállított hitelesítő adataiddal. Nincs API-kulcs, nincs proxy, nincs Kangentic-fiók.
- **Minden projekt egy helyen.** Minden repó saját táblát kap, az Agent Monitor pedig az összes táblán futó ágenseket mutatja.
- **Áttekintés a táblán.** A Changes panel megjeleníti minden feladat diffjét és commitelőzményeit. A GitHub vagy Azure DevOps rendszerben csatolt pull request mutatja az állapotát, és azt, hogy kész-e az egyesítésre.
- **Ingyenes és nyílt forráskódú.** AGPL-3.0, minden funkcióval és fizetős csomag nélkül.

### A munkafolyamat alakítása

- **Oszlopok.** Nevezd át, add hozzá és kösd át az oszlopokat, amíg a tábla nem illeszkedik ahhoz, ahogyan szállítasz. Minden oszlophoz saját ágens, modell, erőfeszítési szint és engedélymód tartozik. A beállítás a repóval együtt, a `kangentic.json` fájlban kerül commitba, így a csapattársak ugyanazt a táblát kapják, a feladatok és az ágensmunkamenetek pedig mindenki saját gépén maradnak.
- **Automatizálások.** Amikor egy feladat belép egy oszlopba, amikor az ágense befejez egy kört, vagy amikor a feladat kilép, az oszlop üzenetet vagy perjeles parancsot küldhet az ágensnek, szkriptet futtathat, webhookot hívhat meg, értesíthet téged, vagy áthelyezheti a feladatot a következő oszlopba. Egy hétköznapi szavakkal megfogalmazott feltétel, amelyet egy ágens ellenőriz, dönti el, hogy egy lépés lefut-e.
- **Munkafolyamatok.** Adj egy rövid leírást a munkafolyamat-ágensnek, tekintsd át az általa megtervezett, egymáshoz kapcsolt feladatokat, és nyomd meg a Start gombot. Minden feladat akkor indul, amikor azok a feladatok, amelyekre vár, elérik a Done oszlopot, és egy munkafolyamat több projektre is kiterjedhet.
- **A táblán dolgozó ágensek.** A Kangentic MCP-szervere lehetővé teszi, hogy egy futó ágens feladatokat hozzon létre, áthelyezze a saját kártyáját, korábbi beszélgetésekben keressen, és üzenetet küldjön egy másik feladat ágensének, így egy promptba írt szabály is továbbviheti a munkát.

## Neked való?

**Jó választás, ha:**

- egyszerre több kódolóágenst futtatsz, és elveszíted a fonalat, hogy melyik vár rád.
- több projekt vagy ügyfél között zsonglőrködsz a feladatokkal, és minden ágenst egy nézetben szeretnél látni.
- a Claude Code, a Codex és más CLI-k vegyes használatát szeretnéd a már kifizetett előfizetéseiddel.
- többlépéses munkafolyamatod van, és projektenként szeretnéd testre szabni annak ágenseit és automatizálásait.
- a telefonodról szeretnél válaszolni az ágenseidnek, amikor nem vagy a gépnél.

**Valószínűleg nem neked való, ha:**

- inkább egyszerre egy feladaton dolgozol, az elejétől a végéig.
- egyetlen projektben dolgozol, és ritkán váltasz.
- nem használsz ágens-CLI-ket, vagy az olyan alkalmazásokat részesíted előnyben, mint a Cursor vagy a Claude Desktop.
- a fejlesztési folyamatodban nincs szükséged munkafolyamatokra vagy automatizálásokra.
- azt szeretnéd, hogy az ágenseid a felhőben fussanak, ne a saját gépeden.

Ha ez hasznosnak tűnik, egy ⭐ segít más fejlesztőknek megtalálni a Kangentic alkalmazást.

## Telepítés

```bash
npx kangentic
```

Ez letölti a platformodhoz tartozó legújabb kiadást a [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) oldalról, telepíti és megnyitja. Ezután az alkalmazás magától frissül. A telepítők a kiadások oldalán is elérhetők, ha inkább magad futtatnád valamelyiket.

**Követelmények**

- Windows x64, macOS 13 vagy újabb Apple Silicon vagy Intel processzorral, illetve Linux x64 vagy arm64 (`.deb` vagy `.rpm`). A Knowledge Graph Intel-alapú Maceken nem érhető el.
- Node.js 20 vagy újabb az `npx` használatához, valamint Git 2.26 vagy újabb.
- Legalább egy telepített és bejelentkezett [támogatott ágens-CLI](#supported-agents).

A WSL-felhasználók a Windows-verziót telepítik, és terminálhéjként kiválaszthatnak egy WSL-disztribúciót. Az ágensek az egyes CLI-k Windows-os telepítését futtatják, így a csak a disztribúción belül telepített CLI-t nem találják meg. A [telepítési útmutató](https://www.kangentic.com/guide/installation/) minden platformot ismertet.

## Hogyan működik?

1. **Állítsd be a táblát.** Tartsd meg az alapértelmezett oszlopokat, vagy alakítsd át őket, és válaszd ki, melyik ágenst és engedélymódot futtassa mindegyik.
2. **Hozz létre egy feladatot.** Adj meg neki címet és promptot, vagy importáld a GitHub Issues, GitHub Projects, Azure DevOps vagy Asana szolgáltatásból.
3. **Húzd át a futtatáshoz.** A Kangentic létrehozza a worktree-t, alkalmazza az oszlop engedélymódját, és elindítja az ágenst.
4. **Figyeld, ahogy kódol.** Kövesd az ágenst az élő termináljában, válaszolj, ha kérdez, és ha végzett, húzd tovább a kártyát.

<a name="supported-agents"></a>
## Támogatott ágensek

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-cli), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli), valamint az [Ollama](https://ollama.com) helyi modellekhez, egyfordulós csevegésként.

Az újraindítás utáni folytatás, a tábla MCP-eszközei és az előzmények átadása a következő ágensnek a CLI-től függ. Lásd: [mit támogatnak az egyes ágensek](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Nyelvek

A Kangentic felülete az oldal tetején felsorolt összes nyelven elérhető. A nyelvet a Settings > Language menüben módosíthatod, és a Kangentic ezen a nyelven indul újra. A fordítások gépi fordítások, és bárki átnézheti őket; a [Fordítások](docs/contributing/translations.md) leírja, hogyan javíthatsz ki egyet.

## Adatok és adatvédelem

A tábláid, feladataid és átirataid egy helyi SQLite-adatbázisban maradnak. Az ágens-CLI-k a saját fiókjaiddal érik el a saját szolgáltatóikat, ugyanúgy, ahogy a terminálodban tennék.

A kiadási buildek alapértelmezés szerint névtelen használati eseményeket (Aptabase) és hibajelentéseket (Sentry) küldenek. A használati események soha nem tartalmaznak feladatszöveget, promptot vagy kódot. Mindkettő kikapcsolásához állítsd be a `KANGENTIC_TELEMETRY=0` értéket, csak a hibajelentések kikapcsolásához pedig a `KANGENTIC_ERROR_REPORTING=0` értéket. Az alkalmazásban nincs erre kapcsoló. Az alkalmazás emellett a GitHubon keresi a frissítéseket és a közleményeket. A teljes listát az [adatvédelmi irányelvekben](https://www.kangentic.com/privacy/) találod.

## Dokumentáció

Kezdd a [gyors kezdéssel](https://www.kangentic.com/getting-started/), majd folytasd a [dokumentációval](https://www.kangentic.com/overview/), amely az oszlopokat, az automatizálásokat, a munkafolyamatokat, az MCP-szervert és a konfigurációt ismerteti.

## Fejlesztés

A forráskódból való buildeléshez Node.js 22.14 vagy újabb, illetve 24 vagy újabb verzió szükséges.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Közreműködés

A projekt felépítéséről, a tesztekről és a konvenciókról a [CONTRIBUTING.md](CONTRIBUTING.md) fájlban olvashatsz. A közreműködők az első pull requestjük egyesítése előtt aláírnak egy [CLA](CLA.md) megállapodást.

## Támogatás

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) kérdésekhez és funkciókérésekhez
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) hibajelentésekhez
- [support@kangentic.com](mailto:support@kangentic.com), ha inkább nem posztolnál nyilvánosan

Biztonsági probléma bejelentéséhez lásd: [SECURITY.md](SECURITY.md).

## Licenc

[AGPL-3.0](LICENSE). Kereskedelmi licencért írj a licensing@kangentic.com címre.
