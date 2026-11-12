---
type: Reference
title: Oz CLI (Warp)
description: Warp's Oz CLI, a one-shot oz agent run with an end-of-options guard, Kangentic's MCP server through --mcp, a --model override, one Default permission entry because Warp profiles hold the real permissions, no live telemetry, detection through dump-debug-info, running from a WSL distro, and which Claude Code features Oz's docs do and do not support.
tags: [agents, adapter, warp]
sources:
  - resource: src/main/agent/adapters/warp/warp-adapter.ts
  - resource: src/main/agent/adapters/warp/mcp-config.ts
  - resource: src/main/agent/adapters/warp/version-detector.ts
---
# Oz CLI (Warp)

## Sources

Everything below the detection section was built from Warp's documentation and the help text of an
installed `oz`, without running an Oz session. The MCP server, the model override and the
permission entry have not been checked against a real `oz agent run` yet.

| Source | What it gives |
|---|---|
| [CLI reference](https://docs.warp.dev/reference/cli/cli) | The flags of `oz agent run`: `--prompt`, `-C/--cwd`, `-n/--name`, `--share`, `--profile <ID>`, `--model <MODEL_ID>`, `--skill`, `--mcp <SPEC>`, `-e/--environment`, `-f/--file`. Calls Oz "a supported legacy interface" |
| [MCP servers (CLI)](https://docs.warp.dev/reference/cli/mcp-servers/) | `--mcp` takes a JSON file path or inline JSON, repeatable; the file is an object keyed by server name |
| [MCP servers (platform)](https://docs.warp.dev/platform/mcp/) | A server's fields: `url` with optional `headers`, or `command` with `args` and `env`; exactly one transport |
| [Warp Agent CLI reference](https://docs.warp.dev/agents/cli/reference) | The separate `warp` binary, which has `--resume` and `--auto-approve` |
| `oz agent run --help`, Warp v0.2026.04.08.08.36.stable_02 | Confirms `--model`, `--mcp`, `--profile <ID>`, `--output-format json\|pretty\|text`, and `--conversation <ID>`, which continues a cloud conversation |

Warp's pages carried "Last updated Nov 3, 2026" when read and name no CLI version.

## CLI Detection

`src/main/agent/adapters/warp/version-detector.ts` (`WarpDetector` and the version parser)

`oz` does not support `--version`: it prints its version from `dump-debug-info`. `WarpDetector` is the shared `AgentDetector` with that as its version command (`versionArgs`), so `oz` gets the same pipeline as every other agent: a cache per configured path (two projects can name two installs), the multi-match PATH walk, the dead-shim skip described in [Claude Code's CLI detection](claude-code.md#cli-detection), and a probe inside the distro for a WSL path.

**The Windows probe starts `warp.exe` directly** (`warpVersionLaunch`). Warp installs `oz.cmd`, which sets `WARP_CLI_MODE=1` and runs `warp.exe`, a GUI-subsystem program. Run through cmd, as every other Windows version probe runs, Warp's output never reaches the pipe, so the probe logged "exited without printing anything" and never found Oz. The detector reads the `.exe` path (`%~dp0` and `%NAME%` references resolved) and the `set` variables out of the shim and starts that program with no shell; a configured `warp.exe` starts directly with `WARP_CLI_MODE=1`. A shim whose program does not resolve to an existing absolute path is probed as found, so the report names its own failure. Measured on v0.2026.04.08.08.36.stable_02: `oz.cmd` and `warp.exe` through cmd returned nothing, `warp.exe` started directly returned the `dump-debug-info` text, and the real detector then found Oz by its configured path and through PATH. A session needs none of this: `oz.cmd` run inside a pseudo-terminal printed its output, so the spawn still runs `oz.cmd`.

## Command Building

`src/main/agent/adapters/warp/warp-adapter.ts`

```
oz agent run -C <cwd> --name <taskId> [--model <id>] [--mcp <sessionDir>/mcp.json] -- --prompt "prompt text"
```

- `oz agent run` runs the agent locally, in the current working directory; `oz agent run-cloud` is the remote form, which Kangentic does not use. It streams output then exits
- `-C <cwd>` sets the working directory
- `--name <taskId>` provides traceability/grouping
- `--model <id>` when the column or task names a model (see Model)
- `--mcp <path>` when Kangentic's MCP server is on (see Kangentic MCP server)
- `--` end-of-options guard prevents prompt content starting with `-` from being parsed as a flag. It goes through `quoteArg`, because PowerShell's binder eats a bare `--`

## Kangentic MCP server

`src/main/agent/adapters/warp/mcp-config.ts` (`writeWarpMcpConfig`)

Each run gets its own `mcp.json` in its session directory, named by `--mcp`, so `kangenticMcp` is `'per-session'`. The file uses Oz's documented shape, an object keyed by server name with no `mcpServers` wrapper:

```json
{ "kangentic": { "url": "<session MCP URL>", "headers": { "X-Kangentic-Token": "<token>" } } }
```

The token stays in the file, never on the command line. Nothing is written in the working folder, so `removeHooks` has nothing to strip. Oz cannot be a Workflow agent: that needs a conversation id to resume by, and a local run has none.

## Model

`oz agent run --model <MODEL_ID>` overrides the run's model, so `discoverCapabilities` declares `supportsModelOverride` without running the CLI. It lists no models. Warp documents `oz model list` but not its output format, so the model field stays free-form. Asking the CLI would also need the direct `warp.exe` start the detector uses. `configuredModelFromCommand` reads the `--model` value back out of the flags before the end-of-options guard, so the card shows the model before the run prints anything. Its label is the id itself, since Warp documents no naming scheme to derive one from. Oz takes no effort flag.

## Telemetry

Oz reports no model, context, tokens, cost or rate limits to Kangentic: Warp documents no status file, hook or event stream for `oz agent run`. The adapter declares `liveTelemetryUnsupported` ("Telemetry: none"), so a card shows that label instead of a spinner that never ends.

## Accounts

Each extra Oz account in Settings > Accounts is a key file the user owns ([accounts](../accounts.md)). A session on one gets the file's `WARP_API_KEY` in its env, and Kangentic stores only the file's path and the names in it. The `oz login` session is the Warp app's own, one per machine, and stays account #1. A key file adds one variable to a session and moves nothing, so conversations stay where they are. Built from the documented variable and not run with a second key.

## WSL

An `oz` installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`): the session starts in a `wsl -d <distro>` shell with oz's Linux path, `-C` takes the folder as the distro sees it (`/mnt/c/...`), and detection runs `dump-debug-info` inside the distro. The `--mcp` path reaches the distro in its `/mnt` form. A distro on NAT networking cannot reach this machine's loopback, so its `mcp.json` names the WSL hook transport's bridge as a stdio server (`command`, `args`, and the token in `env`); a distro on mirrored networking gets the URL. Built from Warp's CLI docs; not yet run against an `oz` installed in a distro.

## SSH

A Warp `oz` on a remote host over SSH (#913) runs as `oz`, found by the host's login `PATH` (`remoteCliName`), so it must be installed there. `-C` receives the project's folder on the host, not this computer's shell folder. It is checked only against a fake host in `tests/unit/warp-ssh-remote.test.ts`, never against a real `oz` or host. `oz` edits no file Kangentic manages, so `remoteFiles()` declares none. `oz` has no `--version` and is detected only on this computer, so a remote project shows no `oz` version. Whether `oz` can sign in to a Warp account on a host with no browser is unverified. Sign in on the host once before using it from a board.

## Permission Modes

Warp keeps permissions in agent profiles (`--profile <ID>`, an id from the user's own Warp account), not in per-mode flags. Oz therefore offers one entry, `default` ("Default (set by your Warp agent profile)"), and the profile the user set in Warp decides. A Plan or Auto entry would mislead, because neither maps to a flag: a "Plan Only (Read-Only)" column would run with the profile's full permissions. A column still set to another mode for Oz falls back to the default entry; the command is the same either way.

## What Oz supports, against Claude Code

| Claude Code feature | Oz | Source |
|---|---|---|
| Kangentic MCP server | Built (`--mcp`) | CLI reference, MCP pages, `--help` |
| Model override and the card's seeded model | Built (`--model`) | CLI reference, `--help` |
| Model list | Not built: `oz model list` exists, its output format is undocumented | CLI reference |
| Live telemetry | Not supported; declared `liveTelemetryUnsupported` | CLI reference |
| Six permission modes, plan mode, plan exit | Not supported: profiles only | CLI reference, `--help` |
| Effort | Not supported: no flag | `--help` |
| Resume and session id capture | Not supported for a local run. `--conversation` continues a cloud conversation, and a local run prints no id. The separate Warp Agent CLI (`warp --resume`) resumes | `--help`, Warp Agent CLI reference |
| Hooks and activity events (tool start and end, question and approval waits, subagents, compaction, session start and end, prompt submit) | Not supported: no hook system is documented | CLI reference |
| Session history, transcript parsing and paging, transcript usage and tool counts | Not supported: `oz run conversation get <ID>` reads a cloud run's conversation by an id a local run does not give | CLI reference |
| Image paste | Not supported: `--attach` is `run-cloud` only, and a one-shot run has no input box | CLI reference |
| Command injection, submission verifier, background commands | Not supported: one-shot, no input box, no history | CLI reference |
| `summarize` and `answerFromContext` | Not supported: `--output-format json` has no documented shape, and no read-only run exists outside a profile | `--help` |
| Trust, relocation, worktree cleanup | Nothing to do: Oz documents no per-folder state | CLI reference |
| Handoff transcript cleanup | Not needed: plain streamed output, no alternate screen | |

## Limitations

- No session resume (`oz agent run` is one-shot)
- No hooks, no settings merge, no trust mechanism
- No structured status or event output - PTY silence timer is the sole idle detection
- No `transcript-cleanup.ts` (streams text output, not a TUI alternate screen)
- `locateSessionHistoryFile` returns null - no CLI-accessible session history
