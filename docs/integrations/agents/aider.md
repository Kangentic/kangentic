---
type: Reference
title: Aider
description: Aider's --message prompt delivery, the permission-mode flags, a per-session --chat-history-file that carries resume, the transcript, the model and the token and cost telemetry, --model and --reasoning-effort, the answer run's usage, and what Aider lacks (hooks, MCP, trust). Built from Aider's docs, with its flags checked against a real --help capture and no Aider session run yet.
tags: [agents, adapter, aider]
sources:
  - resource: src/main/agent/adapters/aider/aider-adapter.ts
  - resource: src/main/agent/adapters/aider/history-paths.ts
    title: aiderHistoryPath (one chat history file per session)
  - resource: src/main/agent/adapters/aider/chat-history-markdown.ts
    title: The history and stdout line readers (model, tokens, cost)
  - resource: src/main/agent/adapters/aider/session-history-parser.ts
    title: AiderSessionHistoryParser (the usage card's live model, tokens and cost)
  - resource: src/main/agent/adapters/aider/transcript-parser.ts
    title: parseAiderTranscript, aiderTranscriptUsage
  - resource: src/main/agent/adapters/aider/capability-discovery.ts
    title: discoverAiderCapabilities
  - resource: src/main/agent/adapters/aider/command-injection-verifier.ts
    title: createAiderCommandInjectionVerifier (the session's own history file, confirm-only)
---
# Aider

Every behavior on this page comes from Aider's published docs and source. The flags are checked
against a real `aider --help` from Aider 0.86.2, and the history readers replay excerpts of the
history Aider publishes in its own repository, but no Aider session has been run against any of
it. See [Built from documentation](#built-from-documentation) for the list.

The docs and source referenced throughout are Aider v0.86.1. The sources are:
- the [options reference](https://aider.chat/docs/config/options.html)
- [in-chat commands](https://aider.chat/docs/usage/commands.html)
- [notifications](https://aider.chat/docs/usage/notifications.html)
- [images](https://aider.chat/docs/usage/images-urls.html)
- the `main` branch of `aider/args.py`, `aider/io.py`, `aider/main.py`,
  `aider/coders/base_coder.py` and `aider/utils.py`

## CLI Detection

Detection is the shared `AgentDetector`: check `config.agent.cliPaths.aider`, fall back to `PATH` via `which`, run `aider --version`. The version output (`aider 86.2`) is parsed to strip the product name prefix.

## Command Building

`src/main/agent/adapters/aider/aider-adapter.ts`

```
aider [--model <id>] [--reasoning-effort <level>] [--chat-history-file <file>] [--message "prompt text"]
      [--chat-mode ask | --architect] [--yes-always] --no-auto-commits --no-suggest-shell-commands
      [--restore-chat-history] [--notifications --notifications-command <idle command>]
```

Each bracketed flag is sent only when it applies: the permission-mode flags per the
[table below](#permission-modes), `--restore-chat-history` on a resume, and the notifications pair
when the session has an events file.

- `--model` and `--reasoning-effort` carry the column's model and effort. They come ahead of the
  prompt, so `configuredModelFromCommand` never reads a `--model` out of task text.
- `--chat-history-file` names the session's own history file (see
  [Chat history and resume](#chat-history-and-resume)).
- `--message` delivers the prompt on a fresh start and on a resume, with shell-safe quoting. The
  options page says it will "process reply then exit (disables chat mode)", so an Aider task runs
  one turn and exits.
- `--no-auto-commits` prevents Aider from auto-committing, because Kangentic manages git.
- `--no-suggest-shell-commands` turns off Aider's shell command suggestions (on by default,
  `args.py`), which would print noise into a Kangentic-managed session.
- `--notifications --notifications-command` runs `node <event-bridge> <events file> idle` when Aider waits for input. Aider runs it through its own shell, so the paths are written bare when they allow it. A path that cannot be carried through the outer shell drops the pair, and the prompt regex stays the idle signal (see `isBareShellToken` in [Shells and paths](../../platforms/shells-and-paths.md#path-handling))

## Chat history and resume

Aider has no session id of its own. It writes a markdown chat history, `.aider.chat.history.md` by default,
and `--chat-history-file` points it at another file. `--restore-chat-history` loads that file's
messages into the next run (`Coder.__init__` reads it through `split_chat_history_markdown`).

Kangentic gives each session its own file: `<cwd>/.aider.chat.history.<agentSessionId>.md`
(`aiderHistoryPath`, `history-paths.ts`). The adapter declares `supportsCallerSessionId`, so the
engine mints the id, stores it as the session's `agent_session_id` and passes it to
`buildCommand`. Aider never sees it as an id.

- **Resume.** A resume adds `--restore-chat-history` for the same file. `resumePromptDelivery` is
  `command-line`, so a resume's message rides `--message`. That is one reply and an exit, the same
  run a fresh start makes. A resume with no message opens the restored conversation interactive.
  `typed` was rejected. A typed message waits only for the PTY to go quiet
  (`waitForTurnCompletion`), and Aider sits quiet at a confirm prompt (`(Y)es/(N)o`), which
  would take the message as its answer.
- **Where the file lives.** It sits flat in the working directory, beside Aider's own `.aider.*`
  files, which keeps `locate(agentSessionId, cwd)` a pure path function. Aider's `.gitignore` entry
  is `.aider*` (`--gitignore`, on by default), and that covers the file. If a user declines Aider's
  gitignore prompt, each session leaves one untracked file. No subfolder is used, because Aider
  creates a missing parent folder only from v0.85.0 on.
- **A session with no id.** A Command Terminal mints no id for an adapter whose id is caller-owned,
  so it keeps Aider's default file, which every Aider run in that folder shares.
- **What reads the file.**
  - the session usage card (`runtime.sessionHistory`)
  - `locateSessionHistoryFile` (handoff)
  - `parseTranscript` and `transcriptUsage`
  - the command-injection verifier

### What the history holds

The parsers follow what Aider's source writes.

- Each run opens with `# aider chat started at <YYYY-MM-DD HH:MM:SS>`.
- Every line of a user prompt is written as `#### <line>`.
- The reply is plain text.
- Every `tool_output` message goes in as a `> ` blockquote, with the `> ` on its first line only,
  and `log_only` messages are written too. So the blockquotes include:
  - the logged command line (`aider/main.py`), whose multi-line `--message` spills unprefixed lines
  - the model announcement, `Model: <name> with <format> edit format`, or `Main model:` when a
    separate weak model is set (`base_coder.py` `get_announcements`)
  - each message's `Tokens: <n> sent[, <n> cache write][, <n> cache hit], <n> received.` and
    `Cost: $<message> message, $<session> session.`

When both cache fields are present, the `Cost:` half lands on its own line without the `> `. The
`session` figure is that Aider process's running total, so it starts over in each run.

A history file can hold what an older Aider wrote, and the readers accept it. Aider's published
history shows `Models: <name> with <format> edit format, weak model <name>`,
`Cost: $<message> request, $<session> session.`, and a `Cost:` half on its own line for reports
with one cache field or none, some followed by `Use --no-stream for accurate caching costs.`
Aider 0.86.2's `base_coder.py` writes none of these.

### Live telemetry

`AiderSessionHistoryParser` reads the whole file (`isFullRewrite`):

- The **model** is the newest announcement, marked `reportedByAgent`. When the file names none,
  the patch leaves `model` out. Otherwise the usage merge would replace a model seeded from
  `--model` with an empty one.
- The **context** is the newest `sent` count, and the input and output totals add up every
  message.
- The **cost** adds up each run's last `session` figure.
- No **context window size** is reported, because Aider serves hundreds of models and a per-model
  table is not allowed (`cli-features-over-custom-layers.md`).
- No **rate limits** are reported, because Aider prints none.

### Transcript

`parseTranscript` (`transcript-parser.ts`) splits the file the way Aider's own reader,
`split_chat_history_markdown`, does:

- `####` lines are the user
- `> ` lines are tool output
- every other line is the reply

On top of that:

- Everything between a run's header and its first `####` is skipped. That is the command line and
  the announcements. A multi-line `--message` holding a `#### ` line (a markdown heading in the
  task) spills it bare there, so the skip ends early and the rest of the spill reads as turns.
  Aider's own reader splits it the same way. A cut read starts at a byte offset, so its leading
  lines are read as the end of a turn, not skipped. A cut that lands inside a preamble cannot be
  told from that, so the rest of that preamble's spill reads as a reply.
- A user line starting with `/` is a `command` entry, and the tool output after it is its
  `command_output`. `/ask`, `/code`, `/architect` and `/context` with text stay user turns, as
  messages sent in that mode. Aider logs that text again as a second `####` line, and the parser
  drops that echo so one question shows once.
- A second run in the file opens with a `session_boundary`.
- The read is the shared bounded tail with its truncation notice.
- Uuids are `<id>:<line>`.

The file records no time per entry, so entries carry `ts: 0` and `transcriptHasTimestamps` is
false. There is no `readTranscriptPage`, so the viewer reads the tail alone. `transcriptUsage` adds
up every `Tokens:` report, window by window.

## Model and effort

- **Discovery.** `discoverCapabilities` (`capability-discovery.ts`) reads `aider --help` for
  `--model`, through `wsl.exe` for a distro path. It reports no model list: `--list-models` needs
  a search term and searches LiteLLM's whole catalog, not the models this user can run. It reports
  no effort levels either: `/reasoning-effort` takes "a number or low/medium/high depending on
  model".
- **The model seed.** `configuredModelFromCommand` names the `--model` the builder wrote. The
  provider prefix is dropped, and an Anthropic id is humanized (`claude-sonnet-4-5` is "Sonnet
  4.5"). Any other name is shown as written.
- **Live swap.** A Command Terminal changes model and effort live with `getInjectionSequence`,
  which sends `/model <name>` and `/reasoning-effort <level>`.

## WSL

An Aider installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts Aider's Linux path in a `wsl -d <distro>` shell, and `--chat-history-file` is handed over in the distro's form (`/mnt/c/...`). Its idle notification is the WSL hook transport's `event idle` (`wsl-hook-transport.ts`) instead of `node event-bridge.js ... idle`, and the command ends in `</dev/null`: Aider runs it with `subprocess.run(command, shell=True, capture_output=True)` and passes no stdin (`aider/io.py` `ring_bell`), so it inherits the terminal, and the transport's stdin read would otherwise wait on the user's keyboard. A Knowledge Graph answer runs through `wsl.exe`, with `--chat-history-file` and `--input-history-file` in the distro's form. The history files Kangentic reads are in the project folder, which Windows reads as before. Not yet run against an Aider installed in a distro.

## Permission Modes

| Mode | Flags | Aider Mode |
|------|-------|------------|
| `plan` / `dontAsk` | `--chat-mode ask` | Ask (Read-Only Questions) |
| `default` | (no flags) | Code (Confirm Changes) |
| `acceptEdits` / `auto` | `--architect` | Architect (Two-Model Design) |
| `bypassPermissions` | `--yes-always` | Auto Yes (Skip Confirmations) |

`--yes-always` is the flag `aider/args.py` defines. The adapter used to send `--yes`, which worked
only because argparse accepts an unambiguous prefix of an option.

## Knowledge Graph answers

`answerFromContext` sends the prompt with `--message-file` in `--chat-mode ask`, with `--no-git`,
`--yes-always`, `--no-auto-commits`, `--no-pretty`, `--no-stream`, no update check, no model
warnings, no shell command suggestions and `--no-restore-chat-history`. It adds `--model <id>` when
a model is chosen (`answerCapabilities.model`). Its history files go in the run directory.
`extractAiderAnswer` trims the banner and the
token report, including a `Cost:` half on its own line. `aiderAnswerUsage` reads the banner's
`Model:` line and the `Tokens:` / `Cost:` report into the run's `AgentCallUsage`, which goes to
`onUsage`:

- `sent` is reported as input tokens. It is the call's prompt tokens as Aider reports them, and
  may include cached ones.
- The cache fields come from the cache write and hit counts.
- The cost is the `$ message` figure.

## Built from documentation

One part is checked against the real CLI. `aider --help` from Aider 0.86.2 was captured with
`uvx --from aider-chat aider --help` (no session, no model call), sanitized, and committed as
`tests/fixtures/aider-help-0.86.2.txt`. `aider-capability-discovery.test.ts` runs discovery
against it, and holds every flag the session builder and the answer run send to it, including
`--yes-always` and the absence of a bare `--yes`.

The history readers replay Aider's published examples, which are not captures.
`tests/fixtures/aider-published-chat-history.md` holds whole runs from `tests/fixtures/chat-history.md`
in Aider's repository at `v0.86.2`, written by Aider v0.48 to v0.51 in August 2024.
`aider-published-chat-history.source.md` beside it names the commit, the lines, the fetch date and
the one substitution, a home directory in the logged command lines. Aider's 14
`aider/website/examples` transcripts and the `tests/basic` files that mention `Tokens:` hold no
report line, and its scripting and caching pages show no stdout of a `--message` run.

Replaying the published file corrected four readings that fixtures shaped to the source could not
catch: the `request` wording, the `--no-stream` warning after a bare `Cost:` half, the plural
`Models:` announcement, and the `/ask` echo. It also confirmed the format this page describes, and
that `tool_output` quotes only the first line of a multi-line message. What it holds comes from
versions far older than 0.86.2, so it shows the format is read correctly, not that 0.86.2 writes it.
For the current report, the check is `base_coder.py` at the tag.

What each flag does once Aider runs is still unchecked. None of these has been run in an Aider
session, because that needs a model reply:

- the per-session `--chat-history-file`, and resume through `--restore-chat-history`
- what a restore loads first. Aider logs its own command line into the history, and a multi-line
  `--message` spills bare lines after it. Aider's `split_chat_history_markdown` does not skip them,
  so they come back as an assistant message at the head of the restored conversation. Whether a
  provider accepts a conversation that opens on an assistant message is unknown. Sending the
  prompt with `--message-file` would keep it out of the logged command line. That was not done:
  the prompt would then not be in the command at all, which `resume-prompt-delivery-parity.test.ts`
  holds every `command-line` adapter to, and nobody has yet seen the spill break a restore.
- the model, token and cost readers over a file 0.86.2 writes
- `parseTranscript` and `transcriptUsage` over such a file
- `--model` and `--reasoning-effort` on the command
- `configuredModelFromCommand` and `getInjectionSequence`
- the answer run's usage

Some fixtures stay shaped to Aider's source because Aider publishes nothing to replay. No published
run uses `--restore-chat-history` or a multi-line `--message`, so
`aider-chat-history-session.md` stays. Aider publishes no answer run's stdout, so those tests stay,
and one case reads a published history run with its quoting taken off.

A future capture would follow these steps, each a run that makes model calls:
- a `--message` run with `--chat-history-file`, then a `--restore-chat-history` resume in the
  same file, recording whether the restored request opens on an assistant message (the open
  question above)
- one Anthropic turn whose `Tokens:` and `Cost:` halves split across two lines
- an answer run's stdout

## Limitations

- A fresh task runs one turn and exits, because `--message` disables chat mode. Keeping it
  interactive needs a typed first prompt for a CLI with no alternate screen, which the spawn path
  does not offer (see [First prompt typed](adapter-interface.md#first-prompt-typed-firstpromptmaybetyped)).
- No hooks. Tool start and end, question and approval waits, subagents, compaction, session start
  and end and prompt submit never reach the event bridge.
- No structured status output. Idle comes from the prompt regex. The notifications command above
  writes its `idle` line to `events.jsonl`, but the adapter declares no `runtime.statusFile`, and
  `StatusFileReader` parses events only through that hook. It hands the raw lines on for session id
  capture alone, so the engine never reads the line. Wiring it as a turn end would also be wrong:
  `ring_bell` fires at the first wait after each LLM response, and `confirm_ask` and `prompt_ask`
  are such waits as well as `get_input`. So it can fire on a confirm prompt mid-turn.
- A confirm prompt (`(Y)es/(N)o ... [Yes]:`) is not told apart from a finished turn: the card shows the envelope for both (GitHub #452). Telling it apart needs an edge-triggered match on the prompt in a `streamOutput` parser, and an end on the first output after the answer. No capture shows the prompt's bytes yet, so nothing is wired
- No MCP client through v0.86.1. The options reference lists none.
- No trust mechanism, and no settings merge.
- No plan exit. Ask mode is a read-only chat.
- Images are added with `/add <image>` or `/paste`. Nothing says a pasted path attaches, so
  `pastedImageNativeExtensions` waits on a probe.
- No TUI alternate screen - uses streaming text output
