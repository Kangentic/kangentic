---
type: Reference
title: GitHub Copilot CLI
description: GitHub Copilot CLI with caller-owned --session-id (--resume failed on unseen ids), a per-session --config-dir holding hooks/kangentic.json plus settings.json and config.json copies, cleanup that spares session-state, and plan exit read from exit_plan_mode result text.
tags: [agents, adapter, copilot]
sources:
  - resource: src/main/agent/adapters/copilot/copilot-adapter.ts
  - resource: src/main/agent/adapters/copilot/detector.ts
  - resource: src/main/agent/adapters/copilot/command-builder.ts
  - resource: src/main/agent/adapters/copilot/hook-manager.ts
  - resource: src/main/agent/adapters/copilot/status-parser.ts
---
# GitHub Copilot CLI

## CLI Detection

`src/main/agent/adapters/copilot/detector.ts`

Detection follows the standard pattern: check `config.agent.cliPaths.copilot`, fall back to `PATH` via `which`, run `copilot --version`.

## Command Building

`src/main/agent/adapters/copilot/command-builder.ts`

Copilot CLI 1.0.51+ supports caller-owned session IDs via `--session-id <uuid>` (same semantics as Claude's `--session-id`): passing a new UUID starts a fresh session with that ID, passing an existing UUID resumes it. The builder used `--resume <uuid>`, which 1.0.97 refuses for an id it has not seen ("No session, task, or name matched"), so no new Copilot task started.

Per-session config is written to `<eventsOutputPath dir>/copilot-config/` and passed with `--config-dir`, which Copilot 1.0.97 still honors by setting `COPILOT_HOME` (it prints a deprecation line). Three files go there:

- `hooks/kangentic.json` holds the hooks (`preToolUse`, `postToolUse`, `agentStop`, `preCompact`) as `{ "version": 1, "hooks": ... }`. Copilot reads every `*.json` in `<COPILOT_HOME>/hooks/` as user hooks, and has since 0.0.422, so one file covers every version.
- `settings.json` is a copy of the user's `~/.copilot/settings.json` plus the `statusLine` bridge and `banner: never`. Copilot 1.0.93 reads user settings only from this file.
- `config.json` is a copy of the user's (signed-in account, trusted folders) with the same two settings for older versions. It never carries hooks: 1.0.8 through 1.0.92 read config.json hooks as well as the hooks folder, so hooks in both would fire twice. Earlier Kangentic versions wrote their hooks there, which 1.0.93 ignores.

The adapter tracks these directories keyed by the session's own id (`CommandOptions.ptySessionId`), so `removeHooks(directory, sessionId?)` cleans that session's directory and never the one of the task's next session. It deletes Kangentic's files one by one and never recursively, because Copilot keeps the session's `session-state/` in the same config home and the next resume by `--session-id` needs it. The project-delete sweep (no `sessionId`) cleans every directory recorded for its folder.

## Permission Modes

| Mode | Flag | Copilot Mode |
|------|------|--------------|
| `plan` | `--plan` | Plan (Read-Only) |
| `dontAsk` | `--plan --no-ask-user` | Plan Non-Interactive (CI) |
| `default` | (no flag) | Default (Confirm Actions) |
| `acceptEdits` | `--allow-all-tools` | Allow All Tools |
| `auto` | `--allow-all-tools` | Autopilot (Allow All Tools) |
| `bypassPermissions` | `--yolo` | YOLO (Full Access) |

`defaultPermission` is `acceptEdits`.

## Status & Events

The `CopilotStatusParser` reads a `status.json` written by Copilot's `statusLine` config (full-rewrite). Activity uses `hooksAndPty` - hooks primary, PTY silence timer as fallback.

## Limitations

- No `transcript-cleanup.ts` despite being a TUI agent (`\x1b[?25l` cursor hide). Handoff transcripts may contain rendering artifacts.
- `locateSessionHistoryFile` returns null - file location is not yet empirically verified.
- Trust is handled at runtime via `--add-dir`, not pre-approved.
- Plan exit detection was read from the 1.0.97 bundle and confirmed on a live 1.0.98 session (`tests/fixtures/plan-exit/copilot-1.0.98-post-tool-use-*.json`). Copilot's plan exit tool is `exit_plan_mode`, and its `postToolUse` result at `toolResult.textResultForLlm` starts "Plan approved! Exited plan mode." for an approved plan and "Plan not approved." otherwise. A rejection does reach `postToolUse`, as a `success` result with the "Plan not approved." text. The `postToolUse` entry carries `setToolWhen({ whenTool: 'exit_plan_mode', toolField: 'toolName', nested: ['toolResult', 'textResultForLlm'], startsWith: 'Plan approved', to: 'ExitPlanMode' })`, so only an approved plan moves the card to the After Plan Mode target.
