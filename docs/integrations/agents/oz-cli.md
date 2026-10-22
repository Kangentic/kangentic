---
type: Reference
title: Oz CLI (Warp)
description: How Kangentic detects Warp's Oz CLI, builds its command and maps permission modes, and what the integration leaves out.
tags: [agents, adapter, warp]
sources:
  - resource: src/main/agent/adapters/warp/
---
# Oz CLI (Warp)

## CLI Detection

`src/main/agent/adapters/warp/warp-adapter.ts` (the detection walk),
`src/main/agent/adapters/warp/version-detector.ts` (the version command and its parser)

Detection is custom because `oz` does not support `--version` - it uses `dump-debug-info` instead. The detector inlines the same caching and inflight-deduplication pattern as `AgentDetector` but with the alternate version command. Override path is checked first, then `which('oz')` falls back to PATH. Because it does not use the shared `AgentDetector`, `oz` resolves only `which`'s first match and gets neither the multi-match walk nor the dead-shim skip described in [Claude Code's CLI detection](claude-code.md#cli-detection).

## Command Building

`src/main/agent/adapters/warp/warp-adapter.ts`

```
oz agent run -C <cwd> --name <taskId> -- --prompt "prompt text"
```

- `oz agent run` is a one-shot cloud agent runner - it streams output then exits
- `-C <cwd>` sets the working directory
- `--name <taskId>` provides traceability/grouping
- `--` end-of-options guard prevents prompt content starting with `-` from being parsed as a flag

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
