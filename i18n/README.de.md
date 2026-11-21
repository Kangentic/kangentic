<!-- readme-translation source-blob=addf4d308ea2879895590819a96e54c47a323ac9 -->
> Dies ist eine maschinelle Übersetzung von [README.md](../README.md) zum Stand `addf4d3`. Maßgeblich ist die englische Version.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Kangentic-Logo" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Karte ziehen. Ein Agent startet.</strong><br />
  Eine agentische Entwicklungsumgebung für KI-Coding-Agenten.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Neuestes Release" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="npm-Version" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0-Lizenz" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="Das Kangentic-Board mit Aufgaben in To Do, Planning, Executing und Code Review. Jede laufende Karte zeigt die letzte Nachricht ihres Agenten, und das Terminal des ausgewählten Agenten ist unter dem Board geöffnet. Öffnet die Live-Demo." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">Live-Demo</a> |
  <a href="https://www.kangentic.com/getting-started/">Schnellstart</a> |
  <a href="https://www.kangentic.com/overview/">Dokumentation</a>
</p>

<!-- language-switcher -->
<p align="center">
  <a href="../README.md">English</a> |
  <a href="README.zh-CN.md">中文(简体)</a> |
  <a href="README.zh-TW.md">中文(繁體)</a> |
  <a href="README.fr.md">Français</a> |
  Deutsch |
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

## Was Kangentic macht

Ein Coding-Agent kann eine Aufgabe selbstständig erledigen, und mit Git-Worktrees laufen mehrere gleichzeitig. Dann werden Sie selbst zum Engpass: Welcher Agent wartet auf eine Eingabe, welcher ist fertig, und wo ist welcher Branch gelandet? Kangentic bringt jede Sitzung auf ein Board und markiert die, die Sie brauchen.

### Agenten von einem Board aus ausführen

- **Ein Board, alle Agenten.** Jede Karte zeigt ihr Modell, wie viel des Kontextfensters belegt ist und was der Agent zuletzt gesagt hat; die Karten, die Sie brauchen, sind markiert.
- **Kangentic Mobile.** Koppeln Sie Ihr Smartphone einmal, und prüfen Sie dann abseits Ihres Schreibtischs den Stand Ihrer Agenten, beantworten Sie die Frage, bei der einer angehalten hat, und sehen Sie sich seinen Diff an. Die Verbindung ist Ende-zu-Ende-verschlüsselt, über das Relay von Kangentic oder ein selbst gehostetes. Erhältlich im [App Store](https://apps.apple.com/app/kangentic/id6794952339) oder bei [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile).
- **Fünfzehn Agent-CLIs.** Planen Sie mit Claude Code und bauen Sie mit Codex, oder verwenden Sie überall dieselbe CLI. Kangentic führt die CLIs aus, die Sie bereits haben, mit den Anmeldedaten, die Sie bereits konfiguriert haben. Kein API-Schlüssel, kein Proxy, kein Kangentic-Konto.
- **Agenten auf einem Remote-Host.** Legen Sie ein Projekt auf einen Linux-Rechner, den Sie per SSH erreichen; dann laufen dort sein Repository, seine Agenten, Builds und Tests. Das Board bleibt auf Ihrem Computer, und die Agenten arbeiten weiter, auch wenn die Verbindung abbricht oder Sie die App beenden. Einrichtung und Einschränkungen finden Sie unter [SSH-Remote-Hosts](https://www.kangentic.com/features/ssh-remote-hosts/).
- **Alle Projekte an einem Ort.** Jedes Repository erhält ein eigenes Board, und der Agent Monitor zeigt die Agenten, die in allen davon laufen.
- **Review auf dem Board.** Der Bereich „Changes“ zeigt den Diff und den Commit-Verlauf jeder Aufgabe. Ein verknüpfter Pull Request auf GitHub oder Azure DevOps zeigt seinen Status und ob er zum Mergen bereit ist.
- **Kostenlos und Open Source.** AGPL-3.0, mit allen Funktionen und ohne kostenpflichtige Stufe.

### Den Workflow gestalten

- **Spalten.** Benennen Sie Spalten um, fügen Sie neue hinzu und verknüpfen Sie sie neu, bis das Board zu Ihrer Arbeitsweise passt. Jede Spalte hat ihren eigenen Agenten, ihr eigenes Modell, ihren Aufwand und ihren Berechtigungsmodus. Die Konfiguration wird mit dem Repository in `kangentic.json` committet, sodass Teammitglieder dasselbe Board erhalten, während Aufgaben und Agent-Sitzungen auf dem Rechner jeder Person bleiben.
- **Automatisierungen.** Wenn eine Aufgabe in eine Spalte kommt, wenn ihr Agent einen Turn beendet oder wenn die Aufgabe die Spalte verlässt, kann eine Spalte dem Agenten eine Nachricht oder einen Slash-Befehl senden, ein Skript ausführen, einen Webhook aufrufen, Sie benachrichtigen oder die Aufgabe in die nächste Spalte verschieben. Eine Bedingung in natürlicher Sprache, die ein Agent prüft, entscheidet, ob ein Schritt ausgeführt wird.
- **Workflows.** Geben Sie dem Workflow-Agenten eine Beschreibung, prüfen Sie die verknüpften Aufgaben, die er plant, und klicken Sie auf „Start“. Jede Aufgabe startet, sobald die Aufgaben, auf die sie wartet, „Done“ erreichen, und ein Workflow kann mehrere Projekte umfassen.
- **Agenten, die das Board bedienen.** Mit dem MCP-Server von Kangentic kann ein laufender Agent Aufgaben erstellen, seine eigene Karte verschieben, frühere Unterhaltungen durchsuchen und dem Agenten einer anderen Aufgabe Nachrichten senden, sodass eine in einem Prompt formulierte Regel die Arbeit voranbringen kann.

## Passt Kangentic zu Ihnen?

**Es passt gut, wenn Sie:**

- mehrere Coding-Agenten gleichzeitig ausführen und den Überblick verlieren, welcher auf Sie wartet.
- Aufgaben über mehrere Projekte oder Kunden hinweg jonglieren und alle Agenten in einer Ansicht sehen möchten.
- Claude Code, Codex und andere CLIs mit Abos kombinieren möchten, die Sie bereits bezahlen.
- einen mehrstufigen Workflow haben und seine Agenten und Automatisierungen pro Projekt anpassen möchten.
- Ihren Agenten vom Smartphone aus antworten möchten, wenn Sie unterwegs sind.

**Es ist wahrscheinlich nichts für Sie, wenn Sie:**

- lieber an einer Aufgabe nach der anderen arbeiten, von Anfang bis Ende.
- in einem einzigen Projekt arbeiten und selten wechseln.
- keine Agent-CLIs verwenden oder Apps wie Cursor oder Claude Desktop bevorzugen.
- in Ihrer Entwicklung keine Verwendung für Workflows oder Automatisierungen haben.
- einen gehosteten Dienst möchten, der Ihre Agenten ausführt, ohne dass Sie eine App installieren müssen.

Wenn das nützlich aussieht, hilft ein ⭐ anderen Entwicklern, Kangentic zu finden.

## Installation

```bash
npx kangentic
```

Dieser Befehl lädt das neueste Release für Ihre Plattform von [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest) herunter, installiert es und öffnet es. Danach aktualisiert sich die App selbst. Die Installationsprogramme finden Sie auch auf der Releases-Seite, falls Sie eines lieber selbst ausführen möchten.

**Voraussetzungen**

- Windows x64, macOS 13 oder höher auf Apple Silicon oder Intel oder Linux x64 oder arm64 (`.deb` oder `.rpm`).
- Node.js 20 oder höher für `npx` sowie Git 2.26 oder höher.
- Mindestens eine [unterstützte Agent-CLI](#supported-agents), installiert und angemeldet.

WSL-Benutzer installieren die Windows-Version und können eine WSL-Distribution als Terminal-Shell auswählen. Eine in einer Distribution installierte Agent-CLI läuft dort, wenn Sie ihren Pfad auf die Kopie in der Distribution setzen. Legen Sie das Projekt selbst auf einem Windows-Laufwerk ab. Der [Installationsleitfaden](https://www.kangentic.com/guide/installation/) behandelt jede Plattform.

## Funktionsweise

1. **Board konfigurieren.** Behalten Sie die Standardspalten bei oder gestalten Sie sie um, und wählen Sie für jede Spalte den Agenten und den Berechtigungsmodus.
2. **Aufgabe erstellen.** Geben Sie ihr einen Titel und einen Prompt, oder importieren Sie eine aus GitHub Issues, GitHub Projects, Azure DevOps, Asana, Jira, Linear, Trello, GitLab oder einem Obsidian-Vault.
3. **Zum Ausführen ziehen.** Kangentic erstellt den Worktree, wendet den Berechtigungsmodus der Spalte an und startet den Agenten.
4. **Beim Coden zusehen.** Verfolgen Sie den Agenten in seinem Live-Terminal, antworten Sie, wenn er fragt, und ziehen Sie die Karte weiter, wenn er fertig ist.

<a name="supported-agents"></a>
## Unterstützte Agenten

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-code), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli) und [Ollama](https://ollama.com) für lokale Modelle als Single-Turn-Chat.

Das Fortsetzen nach einem Neustart, die MCP-Board-Tools und die Übergabe des Verlaufs an den nächsten Agenten hängen von der CLI ab. Siehe [Was jeder Agent unterstützt](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Sprachen

Die Oberfläche von Kangentic ist in allen Sprachen verfügbar, die oben auf dieser Seite aufgeführt sind. Ändern Sie die Sprache unter Settings > Language, und Kangentic startet in dieser Sprache neu. Die Übersetzungen sind maschinell erstellt und offen für Überprüfungen; unter [Übersetzungen](../docs/contributing/translations.md) erfahren Sie, wie Sie eine korrigieren.

## Daten und Datenschutz

Ihre Boards, Aufgaben und Transkripte bleiben in einer lokalen SQLite-Datenbank. Die Agent-CLIs greifen mit Ihren eigenen Konten auf ihre eigenen Anbieter zu, genau wie in Ihrem Terminal.

Release-Builds senden standardmäßig anonyme Nutzungsereignisse (Aptabase) und Fehlerberichte (Sentry). Nutzungsereignisse enthalten niemals Aufgabentext, Prompts oder Code. Setzen Sie `KANGENTIC_TELEMETRY=0`, um beides zu deaktivieren, oder `KANGENTIC_ERROR_REPORTING=0`, um nur die Fehlerberichte zu deaktivieren. Es gibt keinen Schalter in der App. Die App prüft außerdem GitHub auf Updates und Ankündigungen. Die vollständige Liste finden Sie in der [Datenschutzrichtlinie](https://www.kangentic.com/privacy/).

## Dokumentation

Beginnen Sie mit dem [Schnellstart](https://www.kangentic.com/getting-started/) und lesen Sie dann die [Dokumentation](https://www.kangentic.com/overview/) zu Spalten, Automatisierungen, Workflows, dem MCP-Server und der Konfiguration.

## Entwicklung

Zum Erstellen aus dem Quellcode benötigen Sie Node.js 22.14 oder höher bzw. 24 oder höher.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Mitwirken

Informationen zu Projektstruktur, Tests und Konventionen finden Sie in [CONTRIBUTING.md](../CONTRIBUTING.md). Mitwirkende unterzeichnen eine [CLA](../CLA.md), bevor ihr erster Pull Request gemergt wird.

## Support

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) für Fragen und Feature-Anfragen
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) für Fehlerberichte
- [support@kangentic.com](mailto:support@kangentic.com), wenn Sie lieber nicht öffentlich posten möchten

Informationen zum Melden eines Sicherheitsproblems finden Sie in [SECURITY.md](../SECURITY.md).

## Lizenz

[AGPL-3.0](../LICENSE). Für eine kommerzielle Lizenz schreiben Sie eine E-Mail an licensing@kangentic.com.
