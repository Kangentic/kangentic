<!-- readme-translation source-blob=9c65bada5dcd25126a88e6b2728e7cb56ea71c6e -->
> Ez a(z) [README.md](../README.md) gépi fordítása a(z) `9c65bad` változat alapján. Az angol változat a mérvadó.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic logó" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Húzz el egy kártyát. Elindul egy ügynök.</strong><br />
  Agentikus fejlesztői környezet AI-kódolóügynököknek.
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
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="A Kangentic tábla a Teendők, Tervezés, Végrehajtás és Kódáttekintés oszlopokban lévő feladatokkal. Minden futó kártya az ügynöke legutóbbi üzenetét mutatja, a kiválasztott ügynök terminálja pedig a tábla alatt van megnyitva. Megnyitja az élő demót." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">Élő demó</a> |
  <a href="https://www.kangentic.com/getting-started/">Gyorsútmutató</a> |
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

## Mit csinál

Egy kódolóügynök önállóan is végig tud vinni egy feladatot, a git worktree-k pedig lehetővé teszik, hogy egyszerre több is fusson. Ekkor már te leszel a szűk keresztmetszet: melyik ügynök vár promptra, melyik végzett, és hová került melyik ág. A Kangentic minden munkamenetet egy táblára tesz, és megjelöli azokat, amelyeknek szükségük van rád.

### Futtasd az ügynökeidet egyetlen tábláról

- **Egy tábla, minden ügynök.** Minden kártya mutatja a modellt, a kontextusablak kihasználtságát és az ügynök legutóbbi üzenetét, azokon pedig, amelyeknek szükségük van rád, jelölés látható.
- **Kangentic Mobile.** Párosítsd egyszer a telefonodat, és utána az asztalodtól távol is ellenőrizheted az ügynököket, megválaszolhatod a kérdést, amelynél egyikük megállt, és áttekintheted a diffjét. A kapcsolat végpontok között titkosított, és a Kangentic közvetítőszerverén vagy egy saját üzemeltetésűn keresztül működik. Szerezd be az [App Store](https://apps.apple.com/app/kangentic/id6794952339) vagy a [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile) áruházból.
- **Tizenöt ügynök-CLI.** Tervezz a Claude Code-dal, és építs a Codex-szel, vagy használj mindenhol egyetlen CLI-t. A Kangentic a már meglévő CLI-jeidet futtatja a már beállított hitelesítő adataiddal. Nincs API-kulcs, nincs proxy, nincs Kangentic-fiók.
- **Minden projekt egy helyen.** Minden repónak saját táblája van, az Ügynökfigyelő pedig megmutatja az összes repóban futó ügynököket.
- **Áttekintés a táblán.** A Változások panel megmutatja az egyes feladatok diffjét és commitelőzményeit. A GitHubon vagy az Azure DevOpsban lévő kapcsolt pull request mutatja az állapotát, és azt, hogy készen áll-e az egyesítésre.
- **Ingyenes és nyílt forráskódú.** AGPL-3.0, minden funkcióval, fizetős csomag nélkül.

### A munkafolyamat alakítása

- **Oszlopok.** Nevezz át, adj hozzá és köss át oszlopokat, amíg a tábla a te szállítási folyamatodhoz nem igazodik. Minden oszlopnak saját ügynöke, modellje, erőfeszítési szintje és engedélymódja van. A beállítás a `kangentic.json` fájlban a repóval együtt kerül commitba, így a csapattársak ugyanazt a táblát kapják, a feladatok és az ügynök-munkamenetek viszont mindenki saját gépén maradnak.
- **Automatizálások.** Amikor egy feladat belép egy oszlopba, amikor az ügynöke befejez egy kört, vagy amikor a feladat kilép, az oszlop üzenetet vagy perjeles parancsot küldhet az ügynöknek, futtathat egy szkriptet, meghívhat egy webhookot, értesíthet téged, vagy a következő oszlopba helyezheti a feladatot. Egy hétköznapi szavakkal megfogalmazott feltétel, amelyet egy ügynök ellenőriz, dönti el, hogy egy lépés lefut-e.
- **Munkafolyamatok.** Adj rövid leírást a munkafolyamat-ügynöknek, tekintsd át az általa tervezett, egymáshoz kapcsolt feladatokat, és nyomd meg az Indítás gombot. Minden feladat akkor indul el, amikor a feladatok, amelyekre vár, elérik a Kész oszlopot, és egy munkafolyamat több projektre is kiterjedhet.
- **Ügynökök, amelyek a táblán dolgoznak.** A Kangentic MCP-kiszolgálója lehetővé teszi, hogy egy futó ügynök feladatokat hozzon létre, áthelyezze a saját kártyáját, korábbi beszélgetésekben keressen, és üzenetet küldjön egy másik feladat ügynökének, így egy promptba írt szabály is továbbviheti a munkát.

## Neked való?

**Akkor illik hozzád, ha:**

- egyszerre több kódolóügynököt futtatsz, és elveszíted a fonalat, hogy melyik vár rád.
- több projekt vagy ügyfél feladatai között zsonglőrködsz, és minden ügynököt egy nézetben szeretnél látni.
- a Claude Code-ot, a Codexet és más CLI-ket szeretnéd vegyesen használni a már előfizetett csomagjaidon.
- többlépéses munkafolyamatod van, és projektenként szeretnéd testre szabni annak ügynökeit és automatizálásait.
- a telefonodról szeretnél válaszolni az ügynökeidnek, amikor nem vagy a gépnél.

**Valószínűleg nem neked való, ha:**

- inkább egyszerre egy feladaton dolgozol, az elejétől a végéig.
- egyetlen projektben dolgozol, és ritkán váltasz.
- nem használsz ügynök-CLI-ket, vagy az olyan alkalmazásokat részesíted előnyben, mint a Cursor vagy a Claude Desktop.
- a fejlesztési munkádban nincs szükséged munkafolyamatokra vagy automatizálásokra.
- azt szeretnéd, hogy az ügynökeid a felhőben fussanak a saját géped helyett.

Ha ez hasznosnak tűnik, egy ⭐ segít más fejlesztőknek megtalálni a Kangenticet.

## Telepítés

```bash
npx kangentic
```

Ez letölti a platformodnak megfelelő legújabb kiadást a [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) oldalról, telepíti és megnyitja. Ezután az alkalmazás önmagát frissíti. A telepítők a kiadások oldalán is megtalálhatók, ha inkább magad futtatnál egyet.

**Követelmények**

- Windows x64, macOS 13 vagy újabb Apple Silicon vagy Intel processzoron, illetve Linux x64 vagy arm64 (`.deb` vagy `.rpm`). A Tudásgráf Intel-alapú Maceken nem érhető el.
- Node.js 20 vagy újabb az `npx` használatához, és Git 2.26 vagy újabb.
- Legalább egy [támogatott ügynök-CLI](#supported-agents), telepítve és bejelentkezve.

A WSL-felhasználók a Windows-verziót telepítik, és terminálhéjként választhatnak egy WSL-disztribúciót. Az ügynökök az egyes CLI-k Windows-telepítését futtatják, így a csak a disztribúción belül telepített CLI nem található meg. A [telepítési útmutató](https://www.kangentic.com/guide/installation/) minden platformot ismertet.

## Hogyan működik

1. **Állítsd be a táblát.** Tartsd meg az alapértelmezett oszlopokat, vagy alakítsd át őket, és válaszd ki, milyen ügynököt és engedélymódot futtasson mindegyik.
2. **Hozz létre egy feladatot.** Adj neki címet és promptot, vagy importálj egyet a GitHub Issues, a GitHub Projects, az Azure DevOps vagy az Asana szolgáltatásból.
3. **Húzd a futtatáshoz.** A Kangentic létrehozza a worktree-t, alkalmazza az oszlop engedélymódját, és elindítja az ügynököt.
4. **Nézd, ahogy kódol.** Kövesd az ügynököt az élő termináljában, válaszolj, ha kérdez, és húzd tovább a kártyát, ha végzett.

<a name="supported-agents"></a>
## Támogatott ügynökök

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-code), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli) és [Ollama](https://ollama.com) helyi modellekhez, egykörös csevegésként.

Az újraindítás utáni folytatás, az MCP-táblaeszközök és az előzmények átadása a következő ügynöknek a CLI-től függ. Lásd: [mit támogatnak az egyes ügynökök](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Nyelvek

A Kangentic felülete az oldal tetején felsorolt összes nyelven elérhető. A nyelvet a Settings > Language alatt módosíthatod, és a Kangentic azon a nyelven indul újra. A fordítások gépi készítésűek, és nyitottak az ellenőrzésre; a [Fordítások](../docs/contributing/translations.md) leírja, hogyan javíthatsz ki egyet.

## Adatok és adatvédelem

A tábláid, feladataid és átirataid egy helyi SQLite-adatbázisban maradnak. Az ügynök-CLI-k a saját fiókjaiddal érik el a saját szolgáltatóikat, ahogyan a terminálodban is tennék.

A kiadási buildek alapértelmezés szerint névtelen használati eseményeket (Aptabase) és hibajelentéseket (Sentry) küldenek. A használati események soha nem tartalmaznak feladatszöveget, promptokat vagy kódot. A `KANGENTIC_TELEMETRY=0` beállítással mindkettőt kikapcsolhatod, a `KANGENTIC_ERROR_REPORTING=0` beállítással pedig csak a hibajelentéseket. Alkalmazáson belüli kapcsoló nincs. Az alkalmazás a GitHubon is ellenőrzi a frissítéseket és a közleményeket. A teljes listát az [adatvédelmi szabályzat](https://www.kangentic.com/privacy/) tartalmazza.

## Dokumentáció

Kezdd a [gyorsútmutatóval](https://www.kangentic.com/getting-started/), majd folytasd a [dokumentációval](https://www.kangentic.com/overview/), amely az oszlopokat, az automatizálásokat, a munkafolyamatokat, az MCP-kiszolgálót és a konfigurációt ismerteti.

## Fejlesztés

A forrásból való buildeléshez Node.js 22.14 vagy újabb, illetve 24 vagy újabb verzió szükséges.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Közreműködés

A projekt szerkezetéről, a tesztekről és a konvenciókról a [CONTRIBUTING.md](../CONTRIBUTING.md) fájlban olvashatsz. A közreműködők az első pull requestjük egyesítése előtt aláírnak egy [CLA](../CLA.md) megállapodást.

## Támogatás

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) kérdésekhez és funkciókérésekhez
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) hibajelentésekhez
- [support@kangentic.com](mailto:support@kangentic.com), ha inkább nem nyilvánosan írnál

Biztonsági probléma jelentéséhez lásd: [SECURITY.md](../SECURITY.md).

## Licenc

[AGPL-3.0](../LICENSE). Kereskedelmi licencért írj a licensing@kangentic.com címre.
