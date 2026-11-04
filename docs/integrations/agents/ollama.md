---
type: Reference
title: Ollama
description: Ollama as a local chat model rather than an agentic coder, one-shot ollama run with a mandatory model (default llama3.2, picker from ollama list), effort as --think levels read from its help, a single Chat permission mode, idle detected only by PTY silence or the REPL prompt, and which Claude Code features its docs do not support.
tags: [agents, adapter, ollama]
sources:
  - resource: src/main/agent/adapters/ollama/ollama-adapter.ts
  - resource: src/main/agent/adapters/ollama/capability-discovery.ts
---
# Ollama

Ollama drives a local LLM via the `ollama` CLI (https://ollama.com). It is a local-inference tool, not an agentic coder: `ollama run` opens a chat with a local model and cannot edit files or call tools on its own. It is modeled on the Warp adapter (a one-shot run that streams output then exits): `ollama run <model> "<prompt>"` prints the answer and the process exits, so each spawn is a single turn. Free-form multi-turn chat is available by running `ollama run <model>` directly in a Command Terminal.

## CLI Detection

Detection uses the shared `AgentDetector` (via composition, like Aider) with binary name `ollama` and `standardUnixFallbackPaths('ollama')`. `ollama --version` prints `ollama version is X.Y.Z`; `parseVersion` strips the `ollama version is ` prefix.

## Command Building

`src/main/agent/adapters/ollama/ollama-adapter.ts`

```
ollama run <model> [--think=<level>] [-- "<prompt>"]
```

- `ollama run` **requires** a model argument (it has no built-in default and no interactive picker), so the adapter always supplies one: the per-column / per-task model override when set, else `DEFAULT_OLLAMA_MODEL` (`llama3.2`). Ollama auto-pulls a missing model on first run, so the fallback is always runnable. The model picker is populated from `ollama list` (see `capability-discovery.ts`); on discovery failure the renderer falls back to a free-form text input.
- The mandatory model argument is a documented exception to `cli-features-over-custom-layers.md` - it is the one Kangentic-managed knob, because `ollama run` cannot run without it.
- The initial prompt is delivered as a single positional argument. The `--` end-of-options guard is pushed first (like Warp) so a prompt starting with `-` (a markdown bullet, a dashed list item) is taken as the positional argument rather than parsed as a flag. On Windows / non-unix shells, embedded double quotes in the prompt are rewritten to single quotes.
- A no-prompt spawn (`ollama run <model>` with no prompt) drops into an interactive REPL the user types into.

## Effort

Effort is Ollama's thinking level, passed as `--think=<level>` after the model and before the `--` guard, only when a column or task sets one. The levels are read from the CLI, never kept in Kangentic: `discoverOllama` runs `ollama run --help` beside `ollama list` and `parseOllamaThinkLevels` takes the slash-separated words on the `--think` line, minus `true`/`false`. At v0.40.14 the line reads "Enable thinking mode: true/false or high/medium/low for supported models", so the Effort dropdown offers high, medium and low. A CLI without the flag (before 0.9.0) reports no levels, and the Effort row stays hidden. A help read that fails (a timeout, a spawn error) is not an answer: the adapter keeps and offers the levels an earlier read of that CLI reported, and with none it reports no levels.

- The `=` form is required. `--think` is registered with `NoOptDefVal = "true"`, and pflag gives such a flag a value only when it is attached with `=`. `--think high` parses as `--think` (true) plus a stray positional `high`.
- A level the CLI did not report is dropped. The spawn path hands over a column's or task's effort without checking it, so a level left from another agent (Claude's `xhigh`) would otherwise fail the run. The adapter keeps the levels each CLI path's discovery reported and passes `--think` only for one of them; before a help read of that path has answered, the level passes through and the CLI decides.
- Levels are model-defined. A reported level on a model that cannot think fails the run with "does not support thinking", shown in the terminal. Leaving Effort unset passes nothing and keeps Ollama's default, which turns thinking on for any model that supports it.

## Model pill

`configuredModelFromCommand` seeds the board card's model pill from the command: the token right after `run`, past the executable read as one shell word (quoted, escaped or bare, so a path with a space or an apostrophe still counts as one), so a prompt that mentions `run something` never seeds it. The id is shown as is (`qwen3:8b`). Ollama reports no model of its own, so this is the pill's only source.

## Live telemetry

None. `ollama run` writes no status file, session file or structured stream; its only usage output is the per-response timing block `--verbose` (or `/set verbose` in the REPL) prints in the terminal, and the runtime contract has nothing that reads stats out of PTY output. The adapter declares `liveTelemetryUnsupported` ("Telemetry: none"), so the context bar shows that label instead of waiting for telemetry forever.

## Command Terminal live swap

`getInjectionSequence` changes the model and effort of a running Ollama chat with the REPL's own commands: `/load <model>`, then `/set think <level>`. `/load` switches the model in place but clears the chat's history, unlike Claude's `/model`; Ollama starts the new model with no messages. A task session never types these; it restarts with the new launch flags.

## Knowledge Graph answers

`answerFromContext` runs `ollama run <model> --hidethinking` with the prompt piped on stdin, plus `--think=<level>` when the Knowledge Graph's Effort row is set (`answerCapabilities.effort`, with no default level, since a default would fail every answer on a model that cannot think). The model is required: the run never falls back to a model nobody chose.

`--hidethinking` keeps a thinking model's reasoning out of the answer. Ollama turns thinking on by default for any model that supports it and prints it to stdout between `Thinking...` and `...done thinking.` whether or not stdout is a terminal. Before the flag, an answer from qwen3, deepseek-r1 or gpt-oss carried the model's whole reasoning.

`--think` and `--hidethinking` need Ollama 0.9.0 or later, when thinking shipped, and an older CLI fails a run with an unknown-flag error. The answer run discovers the CLI's levels just before it starts, so a CLI whose help has no `--think` flag gets neither flag. A `run --help` that fails records nothing, so `--hidethinking` is still passed unless an earlier read of that CLI found no `--think` flag. The cost is that an older CLI whose help read keeps failing gets the flag and fails the answer with an unknown-flag error, shown as the answer's error.

## WSL

An Ollama installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`): the session starts in a `wsl -d <distro>` shell with Ollama's Linux path, and the model picker's `ollama list`, the `ollama run --help` effort read and a Knowledge Graph answer run through `wsl.exe` too, so all of them talk to the distro's own install and pulled models. Ollama wires no hooks, MCP server or transcript reader. Not yet run against an Ollama installed in a distro.

## Permission Modes

Ollama has no autonomy / permission concept - it is a plain chat REPL. Per `cli-features-over-custom-layers.md`, the adapter exposes a single informational entry and injects no permission flags in `buildCommand()`.

| Mode | Ollama Behavior |
|------|-----------------|
| `default` | Chat |

`defaultPermission` is `default`.

## Activity Detection

Runtime activity is PTY-only. A one-shot `ollama run` streams output then exits, so the PTY silence timer drives the idle transition. The `detectIdle` callback additionally matches the interactive REPL prompt (`>>> `) for an instant idle when a no-prompt spawn drops into the REPL. `detectFirstOutput` returns true on any non-empty data (no alternate screen buffer).

## Built from documentation

Ollama was not installed where this adapter's effort, model pill, live swap and answer-run changes were built, so none of them has been run against a real CLI. They follow Ollama's docs and source at v0.40.14 (the release current on 2026-11-03):

- `ollama run` flags (`--think` with `NoOptDefVal`, `--hidethinking`, `--verbose`), the thinking output and the `run MODEL [PROMPT]` usage: https://github.com/ollama/ollama/blob/v0.40.14/cmd/cmd.go
- REPL commands (`/load`, which clears the messages; `/set think [level]`; `/set nothink`; the `>>> ` prompt): https://github.com/ollama/ollama/blob/v0.40.14/cmd/interactive.go
- `--hidethinking` for scripting: https://ollama.com/blog/thinking
- Command reference: https://docs.ollama.com/cli

## Not supported by the CLI

Checked against the same sources. Each is a Claude Code feature with no Ollama counterpart:

- **Tools, permission modes, plan mode, subagents, background commands.** `ollama run` has no tools. Ollama 0.14-rc2 added an experimental agent loop (`ollama run --experimental`, bash and web search, reported at https://www.phoronix.com/news/ollama-0.14-rc2), but the v0.40.14 `cmd.go` registers no `--experimental` flag on `run`; the only one left is a hidden no-op on `create`.
- **MCP, hooks and every activity event** (tool start and end, question and approval waits, compaction, session start and end, prompt submit). The CLI has no MCP client and no hook system.
- **Resume and session ids.** `/save <name>` saves the chat as a new model in the user's store, not a session, so a resume built on it would fill the model picker.
- **Session history and transcripts** (`parseTranscript`, `readTranscriptPage`, transcript usage and tool counts, the conversation index). The REPL's readline history file holds input lines only. `locateSessionHistoryFile` returns null.
- **Rate limits and cost.** Local inference has neither.
- **Trust, relocation and worktree cleanup.** Ollama keeps no per-folder state.
- **Search in Knowledge Graph answers.** No tools to call `kangentic_search` with.
- **Handoff transcript cleanup.** Not needed: output is plain inline text, not a TUI alternate screen.

## Needs a live probe

The docs suggest these, but each is a member that must be measured against the real CLI before it is declared:

- **`pastedImageNativeExtensions`.** The REPL attaches an image whose path appears in the input for a multimodal model (`interactive.go` regex: jpg, jpeg, png, webp, plus wav audio). Whether a bracketed-paste quoted path is picked up is unmeasured.
- **`summarize`.** The answer run could title tasks, but whether a local model titles cleanly was not measured.
- **`answerCapabilities.streaming`.** `ollama run` writes the reply as it generates; streaming through `onEvent` was not measured.
- **`consoleCloseIsGraceful`, `hungTurn`, `getSubmissionVerifier`.** Nothing in the docs speaks to them, and with no history file a verifier has nothing to read.
