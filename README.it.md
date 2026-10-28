<!-- readme-translation source-blob=3c139f6ee74019ac75b29fddea661fd14d0b0846 -->
> Questa è una traduzione automatica di [README.md](README.md) alla revisione `3c139f6`. La versione inglese è quella di riferimento.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Logo di Kangentic" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Trascina una scheda. Parte un agente.</strong><br />
  Un ambiente di sviluppo agentico per agenti di programmazione IA.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Ultima release" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="Versione npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="Licenza AGPL-3.0" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="La board di Kangentic con attività nelle colonne Da fare, Pianificazione, Esecuzione e Revisione del codice. Ogni scheda in esecuzione mostra l'ultimo messaggio del suo agente e il terminale dell'agente selezionato è aperto sotto la board. Apre la demo dal vivo." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">Demo dal vivo</a> |
  <a href="https://www.kangentic.com/getting-started/">Guida rapida</a> |
  <a href="https://www.kangentic.com/overview/">Documentazione</a>
</p>

<!-- language-switcher -->
<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">中文(简体)</a> |
  <a href="README.zh-TW.md">中文(繁體)</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.de.md">Deutsch</a> |
  Italiano |
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

## Cosa fa

Un agente di programmazione può portare avanti un'attività da solo, e gli alberi di lavoro di git permettono di eseguirne diversi contemporaneamente. A quel punto il limite diventi tu: quale agente attende un prompt, quale ha finito e dove è finito ogni ramo. Kangentic mette ogni sessione su un'unica board e contrassegna quelle che hanno bisogno di te.

### Esegui i tuoi agenti da un'unica board

- **Una board, tutti gli agenti.** Ogni scheda mostra il modello, quanta parte della finestra di contesto è in uso e l'ultima cosa detta dall'agente, con un contrassegno su quelle che hanno bisogno di te.
- **Kangentic Mobile.** Associa il telefono una volta, poi controlla gli agenti, rispondi alla domanda su cui uno si è fermato e rivedi il suo diff lontano dalla scrivania. La connessione è crittografata end-to-end, tramite il relay di Kangentic o uno ospitato da te. Scaricala da [App Store](https://apps.apple.com/app/kangentic/id6794952339) o [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile).
- **Quindici CLI di agenti.** Pianifica con Claude Code e sviluppa con Codex, oppure usa una sola CLI ovunque. Kangentic esegue le CLI che hai già con le credenziali che hai già configurato. Nessuna chiave API, nessun proxy, nessun account Kangentic.
- **Tutti i progetti in un unico posto.** Ogni repository ha la propria board e l'Agent Monitor mostra gli agenti in esecuzione in tutti i progetti.
- **Revisione sulla board.** Il pannello Modifiche mostra il diff e la cronologia dei commit di ogni attività. Una pull request collegata su GitHub o Azure DevOps ne mostra lo stato e indica se è pronta per il merge.
- **Gratuito e open source.** AGPL-3.0, con tutte le funzionalità incluse e nessun piano a pagamento.

### Modella il flusso di lavoro

- **Colonne.** Rinomina, aggiungi e ricollega le colonne finché la board non rispecchia il tuo modo di rilasciare. Ogni colonna ha il proprio agente, modello, livello di effort e modalità di autorizzazione. La configurazione viene inclusa nei commit del repository in `kangentic.json`, così i colleghi ottengono la stessa board, mentre attività e sessioni degli agenti restano sul computer di ciascuno.
- **Automazioni.** Quando un'attività entra in una colonna, quando il suo agente termina un turno o quando l'attività esce, una colonna può inviare all'agente un messaggio o un comando slash, eseguire uno script, chiamare un webhook, inviarti una notifica o spostare l'attività nella colonna successiva. Una condizione in linguaggio naturale, verificata da un agente, decide se un passaggio viene eseguito.
- **Flussi di lavoro.** Dai un brief all'agente del flusso di lavoro, rivedi le attività collegate che pianifica e premi Avvia. Ogni attività parte quando le attività da cui dipende arrivano in Completato, e un flusso di lavoro può estendersi su più progetti.
- **Agenti che lavorano sulla board.** Il server MCP di Kangentic consente a un agente in esecuzione di creare attività, spostare la propria scheda, cercare nelle conversazioni passate e inviare messaggi all'agente di un'altra attività, così una regola scritta in un prompt può far avanzare il lavoro.

## Fa al caso tuo?

**È adatto a te se:**

- esegui diversi agenti di programmazione contemporaneamente e perdi traccia di quale ti sta aspettando.
- gestisci attività su più progetti o clienti e vuoi tutti gli agenti in un'unica vista.
- vuoi combinare Claude Code, Codex e altre CLI con i piani che già paghi.
- hai un flusso di lavoro in più passaggi e vuoi personalizzarne agenti e automazioni per progetto.
- vuoi rispondere ai tuoi agenti dal telefono quando ti allontani.

**Probabilmente non fa per te se:**

- preferisci lavorare su un'attività alla volta, dall'inizio alla fine.
- lavori su un solo progetto e cambi raramente.
- non usi CLI di agenti, o preferisci app come Cursor o Claude Desktop.
- non ti servono flussi di lavoro o automazioni nel tuo modo di sviluppare.
- vuoi che i tuoi agenti vengano eseguiti nel cloud invece che sul tuo computer.

Se ti sembra utile, una ⭐ aiuta altri sviluppatori a trovare Kangentic.

## Installazione

```bash
npx kangentic
```

Questo comando scarica l'ultima release per la tua piattaforma da [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest), la installa e la apre. Da quel momento l'app si aggiorna da sola. I programmi di installazione sono disponibili anche nella pagina delle release, se preferisci eseguirne uno tu.

**Requisiti**

- Windows x64, macOS 13 o successivo su Apple Silicon o Intel, oppure Linux x64 o arm64 (`.deb` o `.rpm`). Il Knowledge Graph non è disponibile sui Mac Intel.
- Node.js 20 o successivo per `npx` e Git 2.26 o successivo.
- Almeno una [CLI di agenti supportata](#supported-agents), installata e con accesso effettuato.

Gli utenti WSL installano la versione Windows e possono scegliere una distribuzione WSL come shell del terminale. Gli agenti eseguono l'installazione Windows di ogni CLI, quindi una CLI installata solo all'interno della distribuzione non viene trovata. La [guida all'installazione](https://www.kangentic.com/guide/installation/) tratta ogni piattaforma.

## Come funziona

1. **Configura la board.** Mantieni le colonne predefinite o rimodellale e scegli l'agente e la modalità di autorizzazione per ciascuna.
2. **Crea un'attività.** Assegnale un titolo e un prompt, oppure importane una da GitHub Issues, GitHub Projects, Azure DevOps o Asana.
3. **Trascina per avviare.** Kangentic crea l'albero di lavoro, applica la modalità di autorizzazione della colonna e avvia l'agente.
4. **Guardalo programmare.** Segui l'agente nel suo terminale dal vivo, rispondi quando chiede qualcosa e sposta avanti la scheda quando ha finito.

<a name="supported-agents"></a>
## Agenti supportati

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-cli), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli) e [Ollama](https://ollama.com) per i modelli locali come chat a turno singolo.

La ripresa dopo un riavvio, gli strumenti MCP della board e il passaggio della cronologia all'agente successivo dipendono dalla CLI. Consulta [cosa supporta ogni agente](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Lingue

L'interfaccia di Kangentic è disponibile in ciascuna delle lingue elencate in cima a questa pagina. Cambiala in Settings > Language e Kangentic si riavvia nella lingua scelta. Le traduzioni sono generate automaticamente e aperte alla revisione; [Traduzioni](docs/contributing/translations.md) spiega come correggerne una.

## Dati e privacy

Board, attività e trascrizioni restano in un database SQLite locale. Le CLI degli agenti contattano i rispettivi provider con i tuoi account, come farebbero nel tuo terminale.

Le build di release inviano per impostazione predefinita eventi di utilizzo anonimi (Aptabase) e segnalazioni di errore (Sentry). Gli eventi di utilizzo non contengono mai testo delle attività, prompt o codice. Imposta `KANGENTIC_TELEMETRY=0` per disattivarli entrambi, oppure `KANGENTIC_ERROR_REPORTING=0` per disattivare solo le segnalazioni di errore. Non esiste un'opzione nell'app. L'app controlla inoltre GitHub per aggiornamenti e annunci. Consulta l'[informativa sulla privacy](https://www.kangentic.com/privacy/) per l'elenco completo.

## Documentazione

Inizia dalla [guida rapida](https://www.kangentic.com/getting-started/), poi passa alla [documentazione](https://www.kangentic.com/overview/) per colonne, automazioni, flussi di lavoro, server MCP e configurazione.

## Sviluppo

Per compilare dai sorgenti serve Node.js 22.14 o successivo, oppure 24 o successivo.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Contribuire

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) per la struttura del progetto, i test e le convenzioni. I collaboratori firmano un [CLA](CLA.md) prima che venga eseguito il merge della loro prima pull request.

## Supporto

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) per domande e richieste di funzionalità
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) per segnalazioni di bug
- [support@kangentic.com](mailto:support@kangentic.com) se preferisci non scrivere pubblicamente

Per segnalare un problema di sicurezza, consulta [SECURITY.md](SECURITY.md).

## Licenza

[AGPL-3.0](LICENSE). Per una licenza commerciale, scrivi a licensing@kangentic.com.
