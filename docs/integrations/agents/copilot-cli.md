---
type: Reference
title: GitHub Copilot CLI
description: GitHub Copilot CLI with caller-owned --session-id, a per-session --config-dir that a resume seeds with the session's earlier session-state, the events.jsonl event log read as the transcript, file-write and assisted-permission modes, plan exit read from exit_plan_mode result text, and questions and approvals from the notification hook.
tags: [agents, adapter, copilot]
sources:
  - resource: src/main/agent/adapters/copilot/copilot-adapter.ts
  - resource: src/main/agent/adapters/copilot/detector.ts
  - resource: src/main/agent/adapters/copilot/command-builder.ts
  - resource: src/main/agent/adapters/copilot/hook-manager.ts
  - resource: src/main/agent/adapters/copilot/copilot-home.ts
  - resource: src/main/agent/adapters/copilot/status-parser.ts
  - resource: src/main/agent/adapters/copilot/session-state.ts
    title: Resume seeding and the event log locator
  - resource: src/main/agent/adapters/copilot/transcript-parser.ts
    title: events.jsonl as transcript entries, tool counts and usage
  - resource: src/main/agent/adapters/copilot/project-relocation.ts
---
# GitHub Copilot CLI

## CLI Detection

`src/main/agent/adapters/copilot/detector.ts`

Detection follows the standard pattern: check `config.agent.cliPaths.copilot`, fall back to `PATH` via `which`, run `copilot --version`.

## Command Building

`src/main/agent/adapters/copilot/command-builder.ts`

Copilot CLI 1.0.51+ supports caller-owned session IDs via `--session-id <uuid>` (same semantics as Claude's `--session-id`): passing a new UUID starts a fresh session with that ID, passing an existing UUID resumes it. The builder used `--resume <uuid>`, which 1.0.97 refuses for an id it has not seen ("No session, task, or name matched"), so no new Copilot task started.

A resume carries no prompt. `-i <prompt>` starts an interactive session with one, but neither `copilot --help` nor GitHub's docs say it runs on a session resumed by `--session-id`, so the adapter declares `resumePromptDelivery: 'typed'`: Kangentic keeps a resume's message (a column's message, held messages) off the command line and types it in once Copilot is ready. See [How the resume prompt arrives](../../architecture/sessions/resume.md#how-the-resume-prompt-arrives).

Per-session config is written to `<eventsOutputPath dir>/copilot-config/` and passed with `--config-dir`, which Copilot 1.0.97 still honors by setting `COPILOT_HOME` (it prints a deprecation line). Three files go there:

- `hooks/kangentic.json` holds the hooks (`preToolUse`, `postToolUse`, `postToolUseFailure`, `userPromptSubmitted`, `agentStop`, `subagentStart`, `subagentStop`, `sessionStart`, `sessionEnd`, `preCompact`, `notification`) as `{ "version": 1, "hooks": ... }`. Copilot reads every `*.json` in `<COPILOT_HOME>/hooks/` as user hooks, and has since 0.0.422, so one file covers every version. See [Hooks](#hooks).
- `settings.json` is a copy of the user's `~/.copilot/settings.json` plus the `statusLine` bridge and `banner: never`, and `defaultPermissionMode: "assisted"` for an `auto` session. Copilot 1.0.93 reads user settings only from this file.
- `config.json` is a copy of the user's (signed-in account, trusted folders) with the same settings for older versions. It never carries hooks: 1.0.8 through 1.0.92 read config.json hooks as well as the hooks folder, so hooks in both would fire twice. Earlier Kangentic versions wrote their hooks there, which 1.0.93 ignores.

The user's Copilot home those copies come from is `$COPILOT_HOME` when set, else `~/.copilot` (`copilotHomeDir`, `copilot-home.ts`), the same folder `--config-dir` names for a session. The history verifier, the model scan, the answer run's session cleanup and the relocation pass read it too. Before, a user with `COPILOT_HOME` set got every session seeded without their sign-in. Only an absolute value is taken.

The adapter tracks these directories keyed by the session's own id (`CommandOptions.ptySessionId`), so `removeHooks(directory, sessionId?)` cleans that session's directory and never the one of the task's next session. It deletes Kangentic's files one by one and never recursively, because Copilot keeps the session's `session-state/` in the same config home. The project-delete sweep (no `sessionId`) cleans every directory recorded for its folder.

### A resume brings its session over

Every spawn, a resume included, gets a new session record and so a new `.kangentic/sessions/<record>/copilot-config`. GitHub's [config directory reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference) keeps a session in `<config home>/session-state/<id>/` (its `events.jsonl` event log plus plans, checkpoints and tracked files, which "enables `--resume` and `--continue`"), and the [command reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) says `--session-id` with an unseen valid UUID creates a new session. So a resume used to open an empty conversation under the old id.

Before a resume starts, `seedResumedSessionState` (`session-state.ts`) copies `session-state/<id>/` into the new home: from the project's other Kangentic homes first (a folder holding an `events.jsonl` before one without, then the newest log), else from the user's own Copilot home. It copies and never moves, because the command is built before the session's record is saved, and the cold-open sweep (`pruneOrphanedDirectories`) deletes a record folder no row names, so an abandoned spawn would take a moved folder with it. The copy fills a staging folder in the config home and is renamed to `session-state/<id>/` only once whole, so a copy that fails partway leaves nothing a later build mistakes for a finished one. The copy's `events.jsonl` is stamped with the time of the copy (a copy may keep the source's, as Windows' does), so the transcript readers pick it. Only `<project>/.kangentic/sessions` is scanned, one stat per record. The copy is synchronous because `buildCommand` is; for a Copilot in a WSL distro it reads the distro's home over its share. A failure warns and the resume starts empty, as before.

## WSL

A Copilot installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts Copilot's Linux path in a `wsl -d <distro>` shell, and `--config-dir` names the session's config home in the distro's form. That home is seeded from the distro's Copilot home (its own `COPILOT_HOME`, else the distro's `~/.copilot`), never this machine's, so the session keeps the distro's sign-in. The config home is the session's alone, so its hooks call the session's own copy of the WSL hook transport's script with the same events and directives (a distro may have no node). The status line is the transport's `status`, which renames Copilot's status JSON over `status.json`, and the background shell hint goes through its `reply`. Copilot passes a hook its payload on stdin, which the script reads. On mirrored networking `--additional-mcp-config` names the `http` entry. On NAT networking it is the transport's stdio bridge, `{"type": "stdio", "command": "sh", "args": [<script>, "mcp", <url>], "env": {"KANGENTIC_MCP_TOKEN": <token>}, "tools": ["*"]}`. GitHub's Copilot CLI command reference makes `command`, `args` and `tools` required for a local server and takes `local` or `stdio` as its `type`. A Knowledge Graph answer that bridges gets a run directory of its own for the relay. The history verifier's fallback, the model scan and the answer run's session cleanup read the distro's Copilot home. `--help` and a Knowledge Graph answer run through `wsl.exe`. Not yet run against a Copilot installed in a distro.

## Permission Modes

| Mode | Flag | Copilot Mode |
|------|------|--------------|
| `plan` | `--plan` | Plan (Read-Only) |
| `dontAsk` | `--plan --no-ask-user` | Plan Non-Interactive (CI) |
| `default` | (no flag) | Default (Confirm Actions) |
| `acceptEdits` | `--allow-tool=write` | Allow File Edits |
| `auto` | `defaultPermissionMode: "assisted"` in the session's settings.json (`--assisted-approval` with `-p`) | Assisted Approvals |
| `bypassPermissions` | `--yolo` | YOLO (Full Access) |

`defaultPermission` is `acceptEdits`.

`acceptEdits` and `auto` used to pass `--allow-all-tools`, which approves every tool, shell included, and the `auto` row was labeled Autopilot without passing `--autopilot`. Both now map to the CLI's own controls:

- `acceptEdits`: the command reference defines the `write` permission kind as "file creation or modification", and [Allowing and denying tool use](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/allowing-tools) shows `--allow-tool='write'` letting Copilot edit files without asking. A shell command asks, as under Claude's acceptEdits. It is the default mode, so a Copilot task now asks before shell commands.
- `auto`: [assisted permissions](https://docs.github.com/en/copilot/concepts/customizations/allowing-safe-commands) have Copilot review each tool request and ask only when unsure. `--assisted-approval` exits with an error in an interactive session, so an interactive session gets `defaultPermissionMode: "assisted"`, which "applies to new interactive sessions". A resumed session keeps its saved mode, and an administrator's `permissions.defaultMode` wins. Every other mode keeps the user's own `defaultPermissionMode`.
- Kangentic's own MCP server is approved up front (`--allow-tool kangentic`, the flag the answer run measured) in `default`, `acceptEdits` and `auto`, as Claude's `mcp__kangentic` allow rule does, so a workflow agent never waits on an approval for Kangentic's own tools. It used to ride on `--allow-all-tools`. Not in the plan modes, where a mutating board tool keeps asking, and not under `--yolo`.
- `dontAsk` keeps `--plan --no-ask-user`: the docs show no interactive "deny unless pre-approved" mode.
- Copilot's Autopilot (`--autopilot`, or `--mode autopilot`) keeps the agent working until it calls `task_complete`. It is a continuation mode rather than a permission mode, and has no `PermissionMode` of its own.

## Status & Events

The `CopilotStatusParser` reads a `status.json` written by Copilot's `statusLine` config (full-rewrite). Its `parseStatus` returns null: the changelog lists a custom status line command (1.0.51) and context window fields in its input (1.0.35), but no GitHub doc gives the input's schema, so context, tokens, cost and rate limits wait on a captured sample. Activity uses `hooksAndPty` - hooks primary, PTY silence timer as fallback.

### Hooks

| Copilot hook | Event | Detail |
|---|---|---|
| `preToolUse` | `tool_start` | tool name; `subagentId` from `agentId` |
| `postToolUse` | `tool_end` | tool name; `subagentId`; plan exit and background commands (below) |
| `postToolUseFailure` | `tool_end` | tool name; `subagentId` |
| `userPromptSubmitted` | `prompt` | the prompt only when the session asks (`capturePromptText`) |
| `agentStop` | `idle` | `stopReason` |
| `subagentStart` | `subagent_start` | `agentName` (no id) |
| `subagentStop` | `subagent_stop` | `agentName`; `subagentId` from `agentId` |
| `sessionStart` | `session_start` | `source` (`startup`, `resume`, `new`) |
| `sessionEnd` | `session_end` | `reason` |
| `preCompact` | `compact` | |
| `notification` | `idle` (waits only) | see [Questions and approvals](#questions-and-approvals) |

The rows from `postToolUseFailure` through `sessionEnd` (except `agentStop`) and the `agentId` reads come from GitHub's [hooks reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference), which states no CLI version (changelog 1.0.105 current), and have not run against a real CLI:

- `postToolUse` fires only "after a tool completes successfully", so a failed call stayed open until the turn's `agentStop`. `postToolUseFailure` ends it. Its `error` is not copied, because the reference does not give its shape and an object would print as `[object Object]`.
- "Hooks that fire inside a subagent also receive `agentId`, `agentType`, and `parentAgentId`" (they fire for sub-agent tool calls since 1.0.49). `subagentStart` carries no `agentId`, so a start is id-less and its stop is named, which the engine already counts.
- An earlier measurement found no hook firing on submit. Whether the newly registered `userPromptSubmitted` fires was not checked.
- Each event runs its hooks one after another, about 0.7 s each on 1.0.100, so each new hook adds that to its event.

`errorOccurred` is not registered: the reference gives `recoverable` and `errorContext`, but not whether a non-recoverable error ends the turn without `agentStop`.

## Transcript

`locateSessionHistoryFile` finds the session's event log, `session-state/<id>/events.jsonl`: the path the agent reported while it exists, else the newest one in the project's Kangentic config homes, else the user's Copilot home (`session-state.ts`). `locateResumeHistoryFile` answers null: a resume finds the session by id from any folder but reopens it in the cwd `workspace.yaml` saved, so a renamed worktree's cwd is always rewritten (`project-relocation.ts`, which reads the Kangentic homes as well as `~/.copilot`).

`transcript-parser.ts` reads it with the shape of the Copilot SDK's [session events](https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md): an envelope `{ id, timestamp, parentId, agentId?, ephemeral?, type, data }`, where ephemeral events (`assistant.usage`, deltas, `session.idle`) never reach the log.

- `user.message` becomes a user entry and `assistant.message` an assistant entry (`reasoningText` as thinking, `content` as text, each `toolRequests[]` as a tool call).
- `tool.execution_complete` becomes the call's result (`result.content`, or `error.message` with `isError`).
- `session.compaction_complete` becomes a compaction notice with its `summaryContent`, and `session.resume` a session boundary.
- The envelope `id` is each entry's uuid, so pages need no line count (`readJsonlHistoryPage`).
- `transcriptToolCounts` counts distinct `tool.execution_start` ids per tool, a subagent's included. It cannot scope by time.
- `transcriptUsage` sums the last `session.shutdown`'s `modelMetrics` (`usage.inputTokens`, `usage.outputTokens`), so it answers only once a run has ended. `session.usage_checkpoint` exists "to reconstruct accounting when a session is resumed", which reads as the shutdown totals carrying across resumes, but that is not checked.

`configuredModelFromCommand` reads the `--model` argument by argument, so a prompt that mentions `--model` is never taken for it, and labels it with the stream parser's `prettifyModelId`, as `modelDisplayName` does.

### Questions and approvals

The `notification` hook tells a question from an approval (GitHub #452). GitHub's hooks reference lists its `notification_type` values. Two of them are a wait on the user: `elicitation_dialog` ("the agent requests additional information from the user", the `ask_user` question) and `permission_prompt` (a tool to allow). The entry writes the permission `idle` for those two only, tagged `waitKind: 'question'` or `'approval'`, and drops every other type (`shell_completed`, `agent_completed`, `agent_idle`, ...). `permissionRequest` is not used: it fires before Copilot's permission service, so it also fires for calls that rules or session approvals allow without asking.

Measured on a live 1.0.100 session in a `/preview` (`tests/fixtures/copilot-hooks/copilot-1.0.100-waits.jsonl` and the two `copilot-1.0.100-notification-*.json` payloads):

- The payload names the type in snake_case `notification_type` (with `hook_event_name: "Notification"`), even under the camelCase `notification` key, beside the camelCase `sessionId`.
- The notification lands after the waiting tool's `preToolUse`: 45 ms after `ask_user`'s by Copilot's own timestamps, and after the shell tool's for a permission prompt. The tool's `postToolUse` ends the wait, and `agentStop` ends the turn.
- An `echo` ran without a prompt in default mode, so it raised no wait.

The hook is fire-and-forget, so Copilot does not wait for it. An answer given before its process writes could land the tool's end first and leave the wait up. The next tool start or the turn's `agentStop` then clears it.

Copilot's tool hooks carry no tool id, so the engine's sibling rule (a parallel call that finishes does not end a wait, [The kind of a wait](../../architecture/activity/activity-engine.md#the-kind-of-a-wait)) cannot apply. A read tool run beside `ask_user` that ends while the question is open clears it, as it did on Claude before the rule.

## Built from documentation, not yet run

These were built from GitHub's published docs and the Copilot SDK's reference, with no Copilot CLI to run them against. Each needs a check on a real session before it is trusted:

- the resume seeding of `session-state/<id>/` ([A resume brings its session over](#a-resume-brings-its-session-over));
- the transcript, tool counts and usage read from `events.jsonl`, whose test fixture (`tests/fixtures/copilot-events/doc-shaped-events.jsonl`) is shaped from the docs, not captured. The fields it reads match local logs of Copilot 1.0.24 through 1.0.98 (envelope `id`, `timestamp` and `type`; `user.message` and `assistant.message` `content`; `toolRequests[]`; `tool.execution_complete` `result.content` and `error.message`; `session.shutdown` `modelMetrics[*].usage`), but none of those logs held a `session.compaction_complete` or `session.resume`, and none is committed as a fixture yet;
- the `postToolUseFailure`, `userPromptSubmitted`, `sessionStart`, `sessionEnd`, `subagentStart` and `subagentStop` hooks and the tool hooks' `agentId`;
- `acceptEdits` as `--allow-tool=write` and `auto` as assisted permissions;
- the `workspace.yaml` rewrite in Kangentic's own config homes.

Still waiting on a live probe, and not declared: the status line's input (context, tokens, cost, rate limits), image paste (Ctrl+V and Alt+V paste an image as an attachment per the command reference), plan auto-approval through `permissionRequest`, a read-only launch through `--available-tools`/`--deny-tool`, `consoleCloseIsGraceful`, `hungTurn` and `firstPromptMayBeTyped`.

## Limitations

- No `transcript-cleanup.ts` despite being a TUI agent (`\x1b[?25l` cursor hide). The TUI's rendering is undocumented, so a cleanup waits on a captured scrollback. Handoff transcripts may contain rendering artifacts.
- No trust step. The docs keep trusted folders in `config.json` under an undocumented key, and `--trust-folder` is for prompt mode only and conflicts with `--session-id`. Changelog 1.0.60: "Folder trust persists across git worktrees without re-prompting".
- `getInjectionSequence` sends `/reasoning-effort <level>`, which the command reference does not list (1.0.72's `/model --session` changes "the model, reasoning effort, or context window"). The command-injection verifier reads `command-history-state.json`, while the config directory reference names a `command-history-state/` directory. Neither was changed, and both wait on a live check.
- Plan exit detection was read from the 1.0.97 bundle and confirmed on a live 1.0.98 session (`tests/fixtures/plan-exit/copilot-1.0.98-post-tool-use-*.json`). Copilot's plan exit tool is `exit_plan_mode`, and its `postToolUse` result at `toolResult.textResultForLlm` starts "Plan approved! Exited plan mode." for an approved plan and "Plan not approved." otherwise. A rejection does reach `postToolUse`, as a `success` result with the "Plan not approved." text. The `postToolUse` entry carries `setToolWhen({ whenTool: 'exit_plan_mode', toolField: 'toolName', nested: ['toolResult', 'textResultForLlm'], startsWith: 'Plan approved', to: 'ExitPlanMode' })`, so only an approved plan moves the card to the After Plan Mode target.
