<!-- readme-translation source-blob=9c65bada5dcd25126a88e6b2728e7cb56ea71c6e -->
> Questa è una traduzione automatica di [README.md](../README.md) alla revisione `9c65bad`. La versione inglese è quella canonica.

<p align="center">
  <a href="https://www.kangentic.com"><img src="https://raw.githubusercontent.com/Kangentic/branding/main/resources/web/logo.png" alt="Logo di Kangentic" width="96" /></a>
</p>

<h1 align="center">Kangentic</h1>

<p align="center">
  <strong>Trascina una scheda. Un agente si avvia.</strong><br />
  Un ambiente di sviluppo agentico per agenti di programmazione IA.
</p>

<p align="center">
  <a href="https://github.com/Kangentic/kangentic/releases/latest"><img src="https://img.shields.io/github/v/release/Kangentic/kangentic?style=flat-square" alt="Ultima versione" /></a>
  <a href="https://www.npmjs.com/package/kangentic"><img src="https://img.shields.io/npm/v/kangentic?style=flat-square" alt="Versione npm" /></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="Licenza AGPL-3.0" /></a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" />
      <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-light.png" />
      <img src="https://raw.githubusercontent.com/Kangentic/kangentic/main/docs/images/readme-board-dark.png" alt="La bacheca di Kangentic con attività in Da fare, Pianificazione, Esecuzione e Revisione del codice. Ogni scheda in esecuzione mostra l'ultimo messaggio del suo agente, e il terminale dell'agente selezionato è aperto sotto la bacheca. Apre la demo live." width="900" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://kangentic.github.io/kangentic/">Demo live</a> |
  <a href="https://www.kangentic.com/getting-started/">Guida rapida</a> |
  <a href="https://www.kangentic.com/overview/">Documentazione</a>
</p>

<!-- language-switcher -->
<p align="center">
  <a href="../README.md">English</a> |
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

Un agente di programmazione può portare avanti un'attività da solo, e gli alberi di lavoro git permettono di eseguirne diversi contemporaneamente. Il limite allora diventi tu: quale agente è in attesa di un prompt, quale ha finito e dove è andato a finire ogni ramo. Kangentic riunisce tutte le sessioni in un'unica bacheca e contrassegna quelle che richiedono il tuo intervento.

### Esegui i tuoi agenti da un'unica bacheca

- **Una bacheca, tutti gli agenti.** Ogni scheda mostra il modello, quanta parte della finestra di contesto è in uso e l'ultimo messaggio dell'agente, con un contrassegno su quelle che richiedono il tuo intervento.
- **Kangentic Mobile.** Associa il telefono una sola volta, poi controlla gli agenti, rispondi alla domanda su cui uno si è fermato e rivedi il suo diff lontano dalla scrivania. La connessione è crittografata end-to-end, tramite il relay di Kangentic o uno ospitato da te. Scaricala da [App Store](https://apps.apple.com/app/kangentic/id6794952339) o [Google Play](https://play.google.com/store/apps/details?id=com.kangentic.mobile).
- **Quindici CLI di agenti.** Pianifica con Claude Code e sviluppa con Codex, oppure usa una sola CLI per tutto. Kangentic esegue le CLI che hai già con le credenziali che hai già configurato. Nessuna chiave API, nessun proxy, nessun account Kangentic.
- **Tutti i progetti in un unico posto.** Ogni repository ha la propria bacheca e il Monitor agenti mostra gli agenti in esecuzione in tutti i repository.
- **Revisione sulla bacheca.** Il pannello Modifiche mostra il diff e la cronologia dei commit di ogni attività. Una pull request collegata su GitHub o Azure DevOps mostra il suo stato e se è pronta per il merge.
- **Gratuito e open source.** AGPL-3.0, con tutte le funzionalità incluse e nessun piano a pagamento.

### Personalizza il flusso di lavoro

- **Colonne.** Rinomina, aggiungi e ricollega le colonne finché la bacheca non rispecchia il tuo modo di rilasciare il software. Ogni colonna ha il proprio agente, modello, livello di impegno e modalità di autorizzazione. La configurazione viene inclusa nei commit del repository in `kangentic.json`, così i colleghi ottengono la stessa bacheca, mentre attività e sessioni degli agenti restano sul computer di ciascuno.
- **Automazioni.** Quando un'attività entra in una colonna, quando il suo agente termina un turno o quando l'attività esce, una colonna può inviare all'agente un messaggio o un comando slash, eseguire uno script, chiamare un webhook, inviarti una notifica o spostare l'attività alla colonna successiva. Una condizione scritta a parole, verificata da un agente, decide se un passaggio viene eseguito.
- **Flussi di lavoro.** Dai un brief all'agente del flusso di lavoro, rivedi le attività collegate che pianifica e premi Avvia. Ogni attività parte quando le attività che attende raggiungono Fatto, e un flusso di lavoro può estendersi a più progetti.
- **Agenti che lavorano sulla bacheca.** Il server MCP di Kangentic permette a un agente in esecuzione di creare attività, spostare la propria scheda, cercare nelle conversazioni passate e inviare messaggi all'agente di un'altra attività, così una regola scritta in un prompt può far avanzare il lavoro.

## Fa per te?

**Fa per te se:**

- esegui più agenti di programmazione contemporaneamente e perdi di vista quale ti sta aspettando.
- ti destreggi tra attività di più progetti o clienti e vuoi vedere tutti gli agenti in un'unica vista.
- vuoi combinare Claude Code, Codex e altre CLI con i piani che paghi già.
- hai un flusso di lavoro in più fasi e vuoi personalizzarne agenti e automazioni per ogni progetto.
- vuoi rispondere ai tuoi agenti dal telefono quando ti allontani.

**Probabilmente non fa per te se:**

- preferisci lavorare su un'attività alla volta, dall'inizio alla fine.
- lavori in un singolo progetto e cambi raramente.
- non usi CLI di agenti, o preferisci app come Cursor o Claude Desktop.
- non hai bisogno di flussi di lavoro o automazioni nel tuo modo di sviluppare.
- vuoi che i tuoi agenti vengano eseguiti nel cloud anziché sul tuo computer.

Se ti sembra utile, una ⭐ aiuta altri sviluppatori a trovare Kangentic.

## Installazione

```bash
npx kangentic
```

Questo comando scarica l'ultima versione per la tua piattaforma da [GitHub Releases](https://github.com/Kangentic/kangentic/releases/latest), la installa e la apre. In seguito l'app si aggiorna da sola. I programmi di installazione sono disponibili anche nella pagina delle versioni, se preferisci eseguirne uno manualmente.

**Requisiti**

- Windows x64, macOS 13 o versioni successive su Apple Silicon o Intel, oppure Linux x64 o arm64 (`.deb` o `.rpm`). Il grafo della conoscenza non è disponibile sui Mac Intel.
- Node.js 20 o versioni successive per `npx` e Git 2.26 o versioni successive.
- Almeno una [CLI di agenti supportata](#supported-agents), installata e con accesso effettuato.

Chi usa WSL installa la versione Windows e può scegliere una distribuzione WSL come shell del terminale. Gli agenti eseguono l'installazione Windows di ogni CLI, quindi una CLI installata solo all'interno della distribuzione non viene trovata. La [guida all'installazione](https://www.kangentic.com/guide/installation/) tratta ogni piattaforma.

## Come funziona

1. **Configura la bacheca.** Mantieni le colonne predefinite o riorganizzale, e scegli l'agente e la modalità di autorizzazione di ciascuna.
2. **Crea un'attività.** Assegnale un titolo e un prompt, oppure importane una da GitHub Issues, GitHub Projects, Azure DevOps o Asana.
3. **Trascina per eseguire.** Kangentic crea l'albero di lavoro, applica la modalità di autorizzazione della colonna e avvia l'agente.
4. **Guardalo programmare.** Segui l'agente nel suo terminale live, rispondi quando chiede qualcosa e trascina la scheda più avanti quando ha finito.

<a name="supported-agents"></a>
## Agenti supportati

[Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://developers.openai.com/codex/cli), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor CLI](https://cursor.com/docs/cli/overview), [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started), [Grok Build](https://github.com/xai-org/grok-build), [Antigravity CLI](https://antigravity.google/docs/cli/getting-started), [Goose CLI](https://github.com/aaif-goose/goose), [OpenCode](https://opencode.ai/docs), [Aider](https://aider.chat/), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-code), [Factory Droid](https://docs.factory.ai/cli/getting-started/overview), [Warp (Oz CLI)](https://docs.warp.dev/reference/cli/cli) e [Ollama](https://ollama.com) per i modelli locali come chat a turno singolo.

La ripresa dopo un riavvio, gli strumenti MCP per la bacheca e il passaggio della cronologia all'agente successivo dipendono dalla CLI. Vedi [cosa supporta ogni agente](https://www.kangentic.com/features/agent-orchestration/#supported-agents).

## Lingue

L'interfaccia di Kangentic è disponibile in ogni lingua elencata all'inizio di questa pagina. Puoi cambiarla in Settings > Language e Kangentic si riavvia nella lingua scelta. Le traduzioni sono automatiche e aperte alla revisione, e [Traduzioni](../docs/contributing/translations.md) spiega come correggerne una.

## Dati e privacy

Bacheche, attività e trascrizioni restano in un database SQLite locale. Le CLI degli agenti contattano i rispettivi provider con i tuoi account, come farebbero nel tuo terminale.

Le build di rilascio inviano per impostazione predefinita eventi di utilizzo anonimi (Aptabase) e segnalazioni di errori (Sentry). Gli eventi di utilizzo non contengono mai testo delle attività, prompt o codice. Imposta `KANGENTIC_TELEMETRY=0` per disattivarli entrambi, oppure `KANGENTIC_ERROR_REPORTING=0` per disattivare solo le segnalazioni di errori. Non esiste un'opzione nell'app. L'app controlla inoltre GitHub per verificare la presenza di aggiornamenti e annunci. Vedi l'[informativa sulla privacy](https://www.kangentic.com/privacy/) per l'elenco completo.

## Documentazione

Inizia dalla [guida rapida](https://www.kangentic.com/getting-started/), poi consulta la [documentazione](https://www.kangentic.com/overview/) per colonne, automazioni, flussi di lavoro, server MCP e configurazione.

## Sviluppo

La compilazione dal codice sorgente richiede Node.js 22.14 o versioni successive, oppure 24 o versioni successive.

```bash
git clone https://github.com/Kangentic/kangentic.git
cd kangentic
npm install
npm start
```

## Contribuire

Consulta [CONTRIBUTING.md](../CONTRIBUTING.md) per la struttura del progetto, i test e le convenzioni. I collaboratori firmano un [CLA](../CLA.md) prima che venga eseguito il merge della loro prima pull request.

## Supporto

- [GitHub Discussions](https://github.com/Kangentic/kangentic/discussions) per domande e richieste di funzionalità
- [GitHub Issues](https://github.com/Kangentic/kangentic/issues) per le segnalazioni di bug
- [support@kangentic.com](mailto:support@kangentic.com) se preferisci non scrivere pubblicamente

Per segnalare un problema di sicurezza, consulta [SECURITY.md](../SECURITY.md).

## Licenza

[AGPL-3.0](../LICENSE). Per una licenza commerciale, scrivi a licensing@kangentic.com.
