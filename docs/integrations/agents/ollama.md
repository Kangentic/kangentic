---
type: Reference
title: Ollama
description: Ollama as a local chat model rather than an agentic coder, one-shot ollama run with a mandatory model (default llama3.2, picker from ollama list), a single Chat permission mode, and idle detected only by PTY silence or the interactive REPL prompt.
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
ollama run <model> [-- "<prompt>"]
```

- `ollama run` **requires** a model argument (it has no built-in default and no interactive picker), so the adapter always supplies one: the per-column / per-task model override when set, else `DEFAULT_OLLAMA_MODEL` (`llama3.2`). Ollama auto-pulls a missing model on first run, so the fallback is always runnable. The model picker is populated from `ollama list` (see `capability-discovery.ts`); on discovery failure the renderer falls back to a free-form text input.
- The mandatory model argument is a documented exception to `cli-features-over-custom-layers.md` - it is the one Kangentic-managed knob, because `ollama run` cannot run without it.
- The initial prompt is delivered as a single positional argument. The `--` end-of-options guard is pushed first (like Warp) so a prompt starting with `-` (a markdown bullet, a dashed list item) is taken as the positional argument rather than parsed as a flag. On Windows / non-unix shells, embedded double quotes in the prompt are rewritten to single quotes.
- A no-prompt spawn (`ollama run <model>` with no prompt) drops into an interactive REPL the user types into.

## WSL

An Ollama installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`): the session starts in a `wsl -d <distro>` shell with Ollama's Linux path, and the model picker's `ollama list` and a Knowledge Graph answer run through `wsl.exe` too, so all three talk to the distro's own daemon and its pulled models. Ollama wires no hooks, MCP server or transcript reader. Not yet run against an Ollama installed in a distro.

## Permission Modes

Ollama has no autonomy / permission concept - it is a plain chat REPL. Per `cli-features-over-custom-layers.md`, the adapter exposes a single informational entry and injects no permission flags in `buildCommand()`.

| Mode | Ollama Behavior |
|------|-----------------|
| `default` | Chat |

`defaultPermission` is `default`.

## Activity Detection

Runtime activity is PTY-only. A one-shot `ollama run` streams output then exits, so the PTY silence timer drives the idle transition. The `detectIdle` callback additionally matches the interactive REPL prompt (`>>> `) for an instant idle when a no-prompt spawn drops into the REPL. `detectFirstOutput` returns true on any non-empty data (no alternate screen buffer).

## Limitations

- No session resume (Ollama has no CLI-level session IDs)
- No hooks, no settings merge, no trust mechanism, no MCP wiring
- No structured status or event output - PTY silence timer (plus the REPL-prompt regex) is the sole idle detection
- No `transcript-cleanup.ts` (streams plain text output, not a TUI alternate screen)
- `locateSessionHistoryFile` returns null - `ollama run` has no native session history files
