---
type: Reference
title: Aider
description: Aider's --message prompt delivery, --chat-mode ask, --architect and --yes for the permission modes, --no-auto-commits because Kangentic manages git, an idle signal from --notifications-command, and what it lacks (no resume, hooks, settings merge or trust).
tags: [agents, adapter, aider]
sources:
  - resource: src/main/agent/adapters/aider/aider-adapter.ts
---
# Aider

## CLI Detection

Detection is inlined in the adapter (no separate detector class): check `config.agent.cliPaths.aider`, fall back to `PATH` via `which`, run `aider --version`. The version output (`aider 86.2`) is parsed to strip the product name prefix.

## Command Building

`src/main/agent/adapters/aider/aider-adapter.ts`

```
aider --message "prompt text" --chat-mode <mode> --no-auto-commits
```

- `--message` delivers the prompt (shell-safe quoting applied)
- `--no-auto-commits` prevents Aider from auto-committing (Kangentic manages git)
- `--notifications --notifications-command` runs `node <event-bridge> <events file> idle` when Aider waits for input. Aider runs it through its own shell, so the paths are written bare when they allow it. A path that cannot be carried through the outer shell drops the pair, and the prompt regex stays the idle signal (see `isBareShellToken` in [Shells and paths](../../platforms/shells-and-paths.md#path-handling))

## WSL

An Aider installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts Aider's Linux path in a `wsl -d <distro>` shell. Its idle notification is the WSL hook transport's `event idle` (`wsl-hook-transport.ts`) instead of `node event-bridge.js ... idle`, and the command ends in `</dev/null`: Aider runs it with `subprocess.run(command, shell=True, capture_output=True)` and passes no stdin (`aider/io.py` `ring_bell`), so it inherits the terminal, and the transport's stdin read would otherwise wait on the user's keyboard. A Knowledge Graph answer runs through `wsl.exe`, with `--chat-history-file` and `--input-history-file` in the distro's form. The chat history Kangentic reads is `.aider.chat.history.md` in the project folder, which Windows reads as before. Not yet run against an Aider installed in a distro.

## Permission Modes

| Mode | Flags | Aider Mode |
|------|-------|------------|
| `plan` / `dontAsk` | `--chat-mode ask` | Ask (Read-Only Questions) |
| `default` | (no flags) | Code (Confirm Changes) |
| `acceptEdits` / `auto` | `--architect` | Architect (Two-Model Design) |
| `bypassPermissions` | `--yes` | Auto Yes (Skip Confirmations) |

## Limitations

- No session resume (no `--resume` equivalent)
- No structured status output; idle comes from the notifications command above or the prompt regex
- No hooks, settings merge, or trust mechanism
- No TUI alternate screen - uses streaming text output
