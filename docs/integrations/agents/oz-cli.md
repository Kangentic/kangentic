---
type: Reference
title: Oz CLI (Warp)
description: Warp's Oz CLI, a one-shot oz agent run that runs locally, with an end-of-options guard, detection through dump-debug-info because oz has no --version, running from a WSL distro, permission modes that are labels only since Warp profiles hold the real permissions, and no resume, hooks or history.
tags: [agents, adapter, warp]
sources:
  - resource: src/main/agent/adapters/warp/warp-adapter.ts
  - resource: src/main/agent/adapters/warp/version-detector.ts
---
# Oz CLI (Warp)

## CLI Detection

`src/main/agent/adapters/warp/version-detector.ts` (`WarpDetector` and the version parser)

`oz` does not support `--version`: it prints its version from `dump-debug-info`. `WarpDetector` is the shared `AgentDetector` with that as its version command (`versionArgs`), so `oz` gets the same pipeline as every other agent: a cache per configured path (two projects can name two installs), the multi-match PATH walk, the dead-shim skip described in [Claude Code's CLI detection](claude-code.md#cli-detection), and a probe inside the distro for a WSL path. It used to inline its own detection, which cached one result whatever path it was asked about.

## Command Building

`src/main/agent/adapters/warp/warp-adapter.ts`

```
oz agent run -C <cwd> --name <taskId> -- --prompt "prompt text"
```

- `oz agent run` runs the agent locally, in the current working directory (Warp's Oz CLI quickstart and CLI reference); `oz agent run-cloud` is the remote form, which Kangentic does not use. It streams output then exits. Warp's docs now call the Oz CLI a supported legacy interface, deprecated in favor of the Warp Agent CLI (`warp`)
- `-C <cwd>` sets the working directory
- `--name <taskId>` provides traceability/grouping
- `--` end-of-options guard prevents prompt content starting with `-` from being parsed as a flag

## WSL

An `oz` installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`): the session starts in a `wsl -d <distro>` shell with oz's Linux path, `-C` takes the folder as the distro sees it (`/mnt/c/...`), and detection runs `dump-debug-info` inside the distro. Oz wires no hooks, MCP server or transcript reader, so nothing else is routed. Built from Warp's CLI docs; not yet run against an `oz` installed in a distro.

## Permission Modes

Warp manages permissions via agent profiles (`--profile <ID>`), not individual CLI flags. The labels below are informational only - no permission-mode-to-flag mapping exists in `buildCommand()`.

| Mode | Oz Mode |
|------|---------|
| `plan` | Plan Only (Read-Only) |
| `default` | Default |
| `bypassPermissions` | Auto (Skip Confirmations) |

## Limitations

- No session resume (`oz agent run` is one-shot)
- No hooks, no settings merge, no trust mechanism
- No structured status or event output - PTY silence timer is the sole idle detection
- No `transcript-cleanup.ts` (streams text output, not a TUI alternate screen)
- `locateSessionHistoryFile` returns null - no CLI-accessible session history
