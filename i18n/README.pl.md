<!-- readme-translation source-blob=ef6ed72a1d4b6736b32f5cd06be82d664e91fc50 -->
> To jest tłumaczenie maszynowe pliku [README.md](../README.md) w wersji `ef6ed72`. Wersją kanoniczną jest wersja angielska.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Logo Kangentic" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Przeciągnij kartę. Agent zaczyna pracę.</strong><br />
  Agentowe środowisko programistyczne dla agentów AI do programowania.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Najnowsze wydanie" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="Wersja npm" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="Licencja AGPL-3.0" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="Tablica Kangentic z zadaniami w kolumnach To Do, Planning, Executing i Code Review. Każda uruchomiona karta pokazuje ostatnią wiadomość swojego agenta, a terminal wybranego agenta jest otwarty pod tablicą. Otwiera demo na żywo." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">Demo na żywo</a> |
  <a href="https://www.kangentic.com/getting-started/">Szybki start</a> |
  <a href="https://www.kangentic.com/overview/">Dokumentacja</a>
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
  Polski |
  <a href="README.cs.md">Čeština</a> |
  <a href="README.hu.md">Magyar</a>
</p>
<!-- /language-switcher -->

## Co robi

Agent programistyczny potrafi samodzielnie poprowadzić zadanie, a drzewa robocze Git pozwalają uruchomić kilka agentów naraz. Wtedy ograniczeniem stajesz się ty: który agent czeka na odpowiedź, który skończył i dokąd trafiła każda gałąź. Kangentic umieszcza każdą sesję na jednej tablicy i oznacza te, które cię potrzebują.

### Uruchamiaj agentów z jednej tablicy

- **Jedna tablica, każdy agent.** Każda karta pokazuje swój model, jaka część okna kontekstu jest zajęta i co agent powiedział ostatnio, a te, które cię potrzebują, są oznaczone.
- **Kangentic Mobile.** Sparuj telefon raz, a potem sprawdzaj agentów, odpowiadaj na pytanie, na którym agent się zatrzymał, i przeglądaj jego diff z dala od biurka. Połączenie jest szyfrowane end-to-end, przez przekaźnik Kangentic lub taki, który sam hostujesz. Pobierz aplikację z [App Store](https://apps.apple.com/app/kangentic/id6794952339) lub [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile).
- **Piętnaście CLI agentów.** Planuj z Claude Code i buduj z Codex albo używaj jednego CLI wszędzie. Kangentic uruchamia CLI, które już masz, z poświadczeniami, które już skonfigurowałeś. Bez klucza API, bez proxy, bez konta Kangentic.
- **Każdy projekt w jednym miejscu.** Każde repozytorium dostaje własną tablicę, a Monitor agentów pokazuje agentów działających we wszystkich z nich.
- **Przegląd na tablicy.** Panel Zmiany pokazuje diff i historię commitów każdego zadania. Powiązany pull request w GitHub lub Azure DevOps pokazuje swój stan i to, czy jest gotowy do scalenia.
- **Darmowy i open source.** AGPL-3.0, ze wszystkimi funkcjami w zestawie i bez płatnego planu.

### Dostosuj przepływ pracy

- **Kolumny.** Zmieniaj nazwy, dodawaj i przepinaj kolumny, aż tablica będzie odpowiadać temu, jak dostarczasz kod. Każda kolumna ma własnego agenta, model, poziom wysiłku i tryb uprawnień. Konfiguracja trafia do commitów razem z repozytorium w `kangentic.json`, więc członkowie zespołu dostają tę samą tablicę, a zadania i sesje agentów zostają na komputerze każdej osoby.
- **Automatyzacje.** Gdy zadanie wchodzi do kolumny, gdy jego agent kończy turę lub gdy zadanie ją opuszcza, kolumna może wysłać agentowi wiadomość lub polecenie z ukośnikiem, uruchomić skrypt, wywołać webhook, powiadomić cię albo przenieść zadanie do następnej kolumny. Warunek zapisany zwykłymi słowami i sprawdzany przez agenta decyduje, czy dany krok zostanie wykonany.
- **Przepływy pracy.** Przekaż agentowi przepływu pracy krótki opis, przejrzyj zaplanowane przez niego powiązane zadania i naciśnij Start. Każde zadanie rozpoczyna się, gdy zadania, na które czeka, trafią do Done, a jeden przepływ pracy może obejmować kilka projektów.
- **Agenci, którzy obsługują tablicę.** Serwer MCP Kangentic pozwala działającemu agentowi tworzyć zadania, przenosić własną kartę, przeszukiwać wcześniejsze rozmowy i wysyłać wiadomości do agenta innego zadania, więc reguła zapisana w prompcie może popychać pracę dalej.

## Czy to coś dla ciebie?

**Pasuje do ciebie, jeśli:**

- uruchamiasz kilka agentów naraz i tracisz rachubę, który z nich czeka na ciebie.
- żonglujesz zadaniami w kilku projektach lub dla kilku klientów i chcesz widzieć wszystkich agentów w jednym widoku.
- chcesz łączyć Claude Code, Codex i inne CLI w ramach planów, za które już płacisz.
- masz wieloetapowy przepływ pracy i chcesz dostosować jego agentów i automatyzacje do każdego projektu.
- chcesz odpowiadać agentom z telefonu, gdy odchodzisz od komputera.

**Raczej nie jest dla ciebie, jeśli:**

- wolisz pracować nad jednym zadaniem naraz, od początku do końca.
- pracujesz w jednym projekcie i rzadko się przełączasz.
- nie używasz CLI agentów albo wolisz aplikacje takie jak Cursor czy Claude Desktop.
- nie potrzebujesz przepływów pracy ani automatyzacji w swoim sposobie pracy.
- chcesz, aby twoi agenci działali w chmurze, a nie na twoim komputerze.

Jeśli to wygląda na przydatne, ⭐ pomaga innym programistom znaleźć Kangentic.

## Instalacja

```bash
npx kangentic
```

To polecenie pobiera najnowsze wydanie dla twojej platformy z [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest), instaluje je i otwiera. Potem aplikacja aktualizuje się sama. Instalatory są też dostępne na stronie wydań, jeśli wolisz uruchomić jeden z nich samodzielnie.

**Wymagania**

- Windows x64, macOS 13 lub nowszy na Apple Silicon lub Intel albo Linux x64 lub arm64 (`.deb` lub `.rpm`). Graf wiedzy jest niedostępny na komputerach Mac z procesorem Intel.
- Node.js 20 lub nowszy dla `npx` oraz Git 2.26 lub nowszy.
- Co najmniej jedno [obsługiwane CLI agenta](#supported-agents), zainstalowane i zalogowane.

Użytkownicy WSL instalują wersję dla Windows i mogą wybrać dystrybucję WSL jako powłokę terminala. Agenci uruchamiają instalację każdego CLI w Windows, więc CLI zainstalowane tylko wewnątrz dystrybucji nie zostanie znalezione. [Przewodnik instalacji](https://www.kangentic.com/guide/installation/) omawia każdą platformę.

## Jak to działa

1. **Skonfiguruj tablicę.** Zachowaj domyślne kolumny lub zmień ich układ i wybierz agenta oraz tryb uprawnień dla każdej z nich.
2. **Utwórz zadanie.** Nadaj mu tytuł i prompt albo zaimportuj je z GitHub Issues, GitHub Projects, Azure DevOps, Asana, Jira, Linear, Trello, GitLab lub sejfu Obsidian.
3. **Przeciągnij, aby uruchomić.** Kangentic tworzy drzewo robocze, stosuje tryb uprawnień kolumny i uruchamia agenta.
4. **Obserwuj, jak koduje.** Śledź agenta w jego terminalu na żywo, odpowiadaj, gdy o coś pyta, i przeciągnij kartę dalej, gdy skończy.

<a name="supported-agents"></a>
## Obsługiwani agenci

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-code), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli) oraz [Ollama](https://ollama.com) dla modeli lokalnych jako czat jednoturowy.

Wznawianie po ponownym uruchomieniu, narzędzia tablicy MCP i przekazywanie historii następnemu agentowi zależą od CLI. Zobacz, [co obsługuje każdy agent](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Języki

Interfejs Kangentic jest dostępny w każdym języku wymienionym na górze tej strony. Zmień go w Settings > Language, a Kangentic uruchomi się ponownie w tym języku. Tłumaczenia są wykonane maszynowo i otwarte na weryfikację, a strona [Tłumaczenia](../docs/contributing/translations.md) wyjaśnia, jak poprawić jedno z nich.

## Dane i prywatność

Twoje tablice, zadania i transkrypcje pozostają w lokalnej bazie danych SQLite. CLI agentów łączą się z własnymi dostawcami przy użyciu twoich kont, tak jak w twoim terminalu.

Kompilacje wydań domyślnie wysyłają anonimowe zdarzenia użycia (Aptabase) i raporty błędów (Sentry). Zdarzenia użycia nigdy nie zawierają tekstu zadań, promptów ani kodu. Ustaw `KANGENTIC_TELEMETRY=0`, aby wyłączyć jedno i drugie, lub `KANGENTIC_ERROR_REPORTING=0`, aby wyłączyć tylko raporty błędów. W aplikacji nie ma przełącznika. Aplikacja sprawdza też w GitHub dostępność aktualizacji i ogłoszeń. Pełną listę znajdziesz w [polityce prywatności](https://www.kangentic.com/privacy/).

## Dokumentacja

Zacznij od [szybkiego startu](https://www.kangentic.com/getting-started/), a następnie przejdź do [dokumentacji](https://www.kangentic.com/overview/) dotyczącej kolumn, automatyzacji, przepływów pracy, serwera MCP i konfiguracji.

## Rozwój

Budowanie ze źródeł wymaga Node.js 22.14 lub nowszego albo 24 lub nowszego.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Współtworzenie

Zobacz [CONTRIBUTING.md](../CONTRIBUTING.md), aby poznać strukturę projektu, testy i konwencje. Współtwórcy podpisują [CLA](../CLA.md), zanim ich pierwszy pull request zostanie scalony.

## Wsparcie

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) – pytania i propozycje funkcji
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) – zgłoszenia błędów
- [support@kangentic.com](mailto:support@kangentic.com), jeśli wolisz nie pisać publicznie

Aby zgłosić problem z bezpieczeństwem, zobacz [SECURITY.md](../SECURITY.md).

## Licencja

[AGPL-3.0](../LICENSE). Aby uzyskać licencję komercyjną, napisz na adres licensing@kangentic.com.
