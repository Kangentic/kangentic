---
type: Reference
title: Kimi Code
description: Kimi Code CLI 2.x, built from its docs and source and not yet run live, with no starting prompt so Kangentic types the first prompt in, session ids captured from session_index.jsonl, protocol 1.5 wire.jsonl parsed into activity, usage and transcripts, Always Ask, Ask When Needed, Never Ask and Plan modes, a folder-shared .kimi-code/mcp.json, models from config.toml, and WSL.
tags: [agents, adapter, kimi]
sources:
  - resource: src/main/agent/adapters/kimi/kimi-adapter.ts
  - resource: src/main/agent/adapters/kimi/command-builder.ts
  - resource: src/main/agent/adapters/kimi/session-history-parser.ts
  - resource: src/main/agent/adapters/kimi/session-index.ts
  - resource: src/main/agent/adapters/kimi/kimi-home.ts
  - resource: src/main/agent/adapters/kimi/wire-parser.ts
  - resource: src/main/agent/adapters/kimi/transcript-parser.ts
  - resource: src/main/agent/adapters/kimi/transcript-usage.ts
  - resource: src/main/agent/adapters/kimi/subagent-transcripts.ts
  - resource: src/main/agent/adapters/kimi/config-toml.ts
  - resource: src/main/agent/adapters/kimi/mcp-config.ts
  - resource: src/main/agent/adapters/kimi/cached-file.ts
---
# Kimi Code

The adapter drives Kimi Code CLI 2.x (npm `@moonshot-ai/kimi-code`, binary `kimi`, [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)), built against 2.4.1, the `latest` release of 2026-10-30.

**Built from documentation.** Every flag, path, record and result string below comes from the CLI's docs and source, read on 2026-11-03. No real Kimi session has run against this adapter. The specs drive `tests/fixtures/mock-kimi.js`, which behaves as we read the CLI, and the parser tests also replay the CLI's own sample sessions, copied byte for byte into `tests/fixtures/kimi-upstream-sample-*.jsonl` at tag 2.4.1. Those samples hold no tool call, turn end or interaction record, so those rest on `wire-manifest.d.ts`. [What needs a live probe](#what-needs-a-live-probe) lists what a real run must check.

Sources, under `github.com/MoonshotAI/kimi-code/blob/main/`. The CLI's own docs are in that repository's `docs` folder, and the adapter's comments cite them relative to it (`en/reference/kimi-command.md`):

- `en/reference/kimi-command.md`, `tools.md` and `slash-commands.md`
- `en/configuration/config-files.md`, `data-locations.md` and `env-vars.md`
- `en/customization/mcp.md` and `hooks.md`, `en/guides/interaction.md`
- `apps/kimi-code/src/cli/commands.ts`, `apps/kimi-code/src/cli/v2/run-v2-print.ts`, `apps/kimi-code/src/tui/components/chrome/welcome.ts`
- `packages/agent-core-v2/docs/wire-manifest.d.ts`, and under `packages/agent-core-v2/src/`: `agent/contextMemory/loopEventFold.ts`, `features/plan/exitPlanModeReview.ts`, `agent/tools/os/bash/bashTool.ts`, `_base/utils/workdir-slug.ts`

## The 1.x CLI

The adapter used to drive the Python `kimi-cli` 1.x (`~/.kimi`, `-w`, `--prompt`, caller-owned `--session <uuid>`, wire protocol 1.9). That repository is archived, and its last release, 1.52.0, runs no agent: any argument prints a deprecation notice and exits 0, and a bare `kimi` downloads and runs the Kimi Code installer with no prompt. So never probe with a bare `kimi`. `--version` and `--help` are safe on either CLI.

Detection reads a 1.x install as not installed (`parseKimiVersion`), because `kimi, version 1.x` is not a CLI this adapter can drive. The output's shape decides that, not the number: Kimi Code's own releases run 0.1 to 0.43, then 2.0.0, with no 1.x on npm, and both print a bare version. So a 0.x install is detected, though the adapter was built against 2.4.1 and an old one may lack a flag it passes. A resume of a 1.x session cannot work either: Kimi Code reads `~/.kimi` only through `kimi migrate`. Run that once from your own shell. Kangentic's sessions turn its first-launch screen off, because that screen's default is "Migrate now" and the typed first prompt's Enter would pick it.

## CLI detection

`AgentDetector` probes `kimi --version`, which prints the bare version. Fallback paths are the install script's `~/.kimi-code/bin/kimi`, or `%USERPROFILE%\.kimi-code\bin\kimi.exe` on Windows. An npm global install is on PATH.

## Command building

```
kimi [--session <id>] [--plan | --yolo | --auto] [--model <alias>]
```

The working directory is the PTY's cwd, since the CLI has no `-w`. The command never carries a prompt. A positional argument fails with "unknown command", and `-p` runs one prompt and exits with no TUI. So `freshPromptDelivery` and `resumePromptDelivery` are both `'typed'`: the engine keeps the prompt off the command line and hands it back (`SpawnOutcome.typedOpening` on a fresh session, `unsentPrompt` on a resume), and the caller types it in once the agent is ready.

`buildEnv` sets, per process and with nothing persisted:

| Variable | Why |
|----------|-----|
| `KIMI_CODE_TRUST_WORKSPACE=1` | Answers the folder trust prompt, which every new worktree would raise and which exits the CLI when declined. It trusts every folder a session runs in, a fresh clone included, and loads that folder's project `mcp.json` |
| `KIMI_CODE_NO_AUTO_UPDATE=1` | Turns off the update preflight, whose prompt would take the typed first prompt as its answer |
| `KANGENTIC_MCP_TOKEN` | The token for Kangentic's MCP server, when the session has one. `.kimi-code/mcp.json` names the variable and never holds the value |
| `KIMI_SHARE_DIR=.kangentic-no-kimi-cli-data` | Names a folder that does not exist, so the CLI finds no 1.x data and skips its migration screen. It overrides a value you exported. Only the migration code reads it (`migration/legacy-source.ts`) |
| `KIMI_MODEL_THINKING_EFFORT=<level>` | A column's effort. The CLI has no effort flag. The docs say this applies to the `kimi` provider only |

## Permission modes

| Mode | Label | Flag |
|------|-------|------|
| `plan` | Plan (Read-Only) | `--plan` |
| `default` | Always Ask | none (the CLI's `manual` default) |
| `auto` | Ask When Needed (YOLO) | `--yolo`. It still asks for sensitive files, dangerous commands and a plan exit |
| `bypassPermissions` | Never Ask (Auto) | `--auto`. Only a plan waits for review |

The CLI has no accept-edits or deny-unless-allowed mode, so neither is offered. A stored one passes no flag. A resume passes the mode again, which overrides the one stored in the session.

## Session id capture

Kangentic cannot choose an id: `--session` only resumes, and an unknown id fails with `Session "<id>" not found.`. A new session has no id and no folder until its first message, so the id is captured after the typed prompt lands:

1. **Session index**: `runtime.sessionId.fromFilesystem` reads `session_index.jsonl` once a second for about 90 s, for the newest live session whose `workDir` is this cwd and whose folder was made since the spawn. The CLI records `process.cwd()`, so a cwd reached through a symlink is compared in both spellings.
2. **Welcome box**: `Session:   <id>`, printed only on a resume.
3. **Exit hint**: `To resume this session: kimi -r <id>`, printed on stderr when the session has content.

An index match can be another session's, so `SessionIdManager` drops one that a session in the folder already holds, or any match while another Kimi session with no id started there within 60 s. Those sessions get their id from the exit hint, or stay with none. Per-task worktrees keep that rare.

## Session history

Data lives under `$KIMI_CODE_HOME`, else `~/.kimi-code`. Each session is `sessions/<workspaceId>/<id>/`, and its main agent writes `agents/main/wire.jsonl`. A session is located through `session_index.jsonl`, which names its folder, so no folder name is computed: `wd_<slug>_<sha256 prefix>` has a managed form (`wm_<uuid>`) and a case rule on Windows that a computed name would miss. The index and `config.toml` are parsed again only when their size or mtime changes (`cached-file.ts`), since the id capture polls one and every transcript window looks a session up in it.

Line 1 of the file is `{"type":"metadata","protocol_version":"1.5","created_at":...}`. Every other line is `{"type":"<record>", ...payload, "time":...}`, with `time` in milliseconds, as the CLI's own samples show. A `parseWireJsonl` chunk stands alone unless the session's parser passes its memory of open calls, and its `switch` over `KIMI_DISPATCH_TYPES` is exhaustive.

| Record | Activity | SessionEvent |
|--------|----------|--------------|
| `turn.prompt`, `turn.steer` | → Thinking | `Prompt` |
| `turn.ended` | (released) | `Idle` (completed, blocked), `Interrupted` (cancelled), `TurnFailed` (failed) |
| `turn.step.retrying` | (preserve) | `TurnRetrying` (`errorName`) |
| `turn.step.interrupted` | (preserve) | `Notification` |
| `context.append_loop_event` `step.begin` | → Thinking | none |
| `context.append_loop_event` `step.end` | (preserve) | none; the step's token usage |
| `context.append_loop_event` `tool.call` | (preserve) | `ToolStart` (`toolId`; detail = the command for `Bash`, else the tool name) |
| `context.append_loop_event` `tool.result` | (preserve) | `ToolEnd`, tagged `ExitPlanMode` for an approved plan |
| `interaction.request` | (released) | `Idle` (`IdleReason.Permission`, `waitKind` approval or question). `user_tool` waits on no person and is skipped |
| `interaction.resolved` | → Thinking | none |
| `subagent.spawned` | (preserve) | `SubagentStart` (`subagentId`; detail = its name) |
| `subagent.completed`, `.failed`, `.cancelled` | (preserve) | `SubagentStop` (`subagentId`) |
| `full_compaction.begin` | → Thinking | `Compact` |
| `plan_mode.enter`, `.exit` | (preserve) | `Notification` |
| `token_counting.*`, `llm.request`, `usage.record` | (preserve) | none; context tokens and the live model |

"Released" means the event moves the engine and the chunk forces no activity, so a turn end reaches the On agent turn end automations. A plan review is a tool approval, so it is an `approval` wait. An approved plan's result output starts `Exited plan mode.`, and no rejected, revised or dismissed one does, which is how the parser names the plan exit from the result alone.

A `tool.result` names only its call id, so each session's parser (`sessionHistory.createParse`) remembers an open call's tool and tags its start and its end with it, and the live per-tool breakdown is right as it happens. Two cases stay `AgentTool.Bash`: an end whose start was never read, as after a watcher that began at the end of the file, and `ExitPlanMode`, whose name on an end means an approved plan.

The context window comes from the alias's `max_context_size` in the host's `config.toml`, never a guess. A WSL install's config is the distro's, so its context bar shows tokens with no percentage.

## Transcripts and usage

- `parseTranscript`, `parseTranscriptWindow` and `readTranscriptPage` read `turn.prompt`, `content.part` runs, `tool.call`, `tool.result` and compaction records. Uuids are `<session>:<physical line>`, so all three mint the same ones.
- `transcriptUsage` sums every `step.end` usage in the main file. A partial read answers nothing rather than a smaller total.
- `transcriptToolCounts` counts distinct `toolCallId`s per tool and honours `sinceMs` and `untilMs`, since every resume appends to one file (`scopesTranscriptReadsByTime`).
- `statSubagentTranscripts` and `parseSubagentUsage` read each `agents/<subagentId>/wire.jsonl`, with the name and parent call from the main file's `subagent.spawned`.

## Kangentic MCP

The CLI has no MCP flag or environment variable for one session. It reads `$KIMI_CODE_HOME/mcp.json` and the project's `.kimi-code/mcp.json`, and the docs name no `${VAR}` expansion. So `kangenticMcp` is `'shared-folder'`: the session's literal URL goes into `<cwd>/.kimi-code/mcp.json`, merged with the user's servers. Every session in a folder shares the entry, so the last to start decides the URL. A file Kangentic creates is git-excluded, and the entry comes out when the folder's last session releases it (`SharedFolderHolds`). A file Kangentic cannot parse is left alone and is the `kangenticMcpBlockedReason`.

The token never reaches the file. It is `KANGENTIC_MCP_TOKEN` in the session's environment (`buildEnv`). The HTTP entry names that variable in `bearerTokenEnvVar` (`en/customization/mcp.md`), so the CLI sends `Authorization: Bearer <token>`, which our server accepts beside `X-Kangentic-Token`. The WSL bridge's stdio entry has no `env`, because a local stdio server inherits the CLI's environment (`mergeStdioEnv` in `mcpCore/client-stdio.ts`). A `kimi` you start yourself in the folder while a Kangentic session holds the file has no such variable, so that one server does not connect (`client-remote.ts` throws for a missing variable).

A `'shared-folder'` adapter cannot be a Workflow agent, and neither can one whose fresh prompt is typed (`canBeWorkflowAgent`). It cannot declare `backgroundCommands` either, because a mark through a shared URL could land on another session ([Background commands](background-commands.md#background-commands)). So a background `Bash` reads as a plain tool end, its turn ends with no hold, and its task is not offered `kangentic_mark_background_service`.

## Models and effort

`--model` takes an alias, a key in `config.toml`'s `[models]`. No command lists models, so `discoverCapabilities` reads the aliases from the user's config, with `display_name` and the `.overrides` table, after `--help` confirms the flag. Effort levels are the union of every model's `support_efforts`. Kangentic keeps no model list of its own.

A live model swap has nothing to type: `/model <alias>` opens the picker rather than switching.

## Authentication

`probeAuth` answers `true` for a `credentials/*.json` from `/login`, or a model configured in `config.toml`, and `false` for neither. It reads a WSL install in its distro's home. A row of its `AGENT_LIST` result drives the amber "Copy `kimi login`" hint in the welcome grid and Settings > Agent.

## Headless runs

- `summarize` runs `kimi [--model] --output-format stream-json -p <prompt>` in the answer home and reads the last `assistant` line. The prompt can only be an argument, which a title fits, and it goes on one line because an npm install runs through a `.cmd` shim. `-p` forces Never Ask, and rejects `--plan`, so the run stays out of the project, though a task's text, which can come from an imported issue, still reaches a run that asks for no approval. It saves a session in the answer home, and the CLI has no delete command.
- `answerFromContext` is not implemented. An answer prompt runs to about 50k characters, past a Windows command line, and `-p` reads no stdin and has no read-only mode.

## WSL

`supportsWslCli` is set: Kimi Code ships Linux glibc builds. The command head is the distro's path, the MCP entry is the WSL bridge on NAT networking, and the home, index and credentials are read through the distro's share. An index `workDir` is compared with the path the distro sees.

## SSH

A Kimi Code on a remote host over SSH (#913) runs as `kimi`, found by the host's login `PATH` (`remoteCliName`), so it must be installed and signed in there. It is checked only against a fake host in `tests/unit/kimi-ssh-remote.test.ts`, never against a real Kimi or host.

- **Synced file.** `remoteFiles()` declares the project's `.kimi-code/mcp.json`. Kangentic's stdio entry (the hook transport's bridge, by its path on the host) is merged beside the user's servers, the token stays in the session's environment, and the file is restored when the session releases. A file that is not JSON Kangentic can merge into is left as written.
- **Trust and the first prompt.** `KIMI_CODE_TRUST_WORKSPACE`, `KIMI_CODE_NO_AUTO_UPDATE` and `KIMI_SHARE_DIR` ride the spawn environment, as locally.
- **Unavailable over SSH.** The wire file and the session index are on the host. The transcript, usage and live model show nothing, and the session id comes from the welcome box or the exit hint, never the index scan, which would otherwise wait 90 seconds. Activity is the terminal's.

## What needs a live probe

Run these against a real install before trusting the adapter:

- **The typed first prompt**, past the startup screens. A model upgrade prompt (`tui/controllers/model-migration.ts`) opens over an idle, empty editor when the default model has an upgrade, the source shows no variable that turns it off, and a typed Enter would answer it, so check what a first prompt does on such a model. The migration screen, shown when `~/.kimi` holds 1.x data, is off through `KIMI_SHARE_DIR`, a behavior of the source that no doc lists, so check that on a machine with a real `~/.kimi`.
- Session id capture timing after the first message, and the welcome box and exit hint wording.
- Whether the wire is append-only across resumes, and whether any session keeps its turns only as `context.append_message` records, as the CLI's compaction sample does. The transcript parsers read `turn.prompt` and loop events, not those.
- The exit sequence (Esc, a pause, `/exit`). It ends in Enter, which must not answer an open dialog. In the source Esc rejects an approval dialog (`tui/components/dialogs/approval-panel.ts`), so the Enter reaches the editor, but check with `scripts/probe-agent-dialog-exit.js`, including a second approval that opens inside the pause.
- `detectFirstOutput` and the PTY prompt regex. `transcript-cleanup.ts` has no real capture behind it.
- Background task ids and payloads, should the MCP wiring ever become per-session, which is what `backgroundCommands` needs first.
- Whether a relocated project's sessions resume. The folder name hashes the path, a resume from another directory fails, and the workspace registry was not traced, so `onProjectRelocated` is not implemented.
- A `describeStartupFailure` recognizer for `Session "<id>" not found.`.
- Probe-gated members the docs may support: `getSubmissionVerifier` (declared, returns null until a run shows when the wire flushes a submitted prompt), `pastedImageNativeExtensions`, `consoleCloseIsGraceful`, `hungTurn`, `supportsPlanAutoApproval`, `supportsReadOnlyLaunch`. `canEscalateOnVerificationFailure` and `answerCapabilities` are left out because they need a verifier and `answerFromContext`, which Kimi does not have.

## Not supported by the CLI

- A prompt on an interactive launch, and a caller-chosen session id.
- Accept-edits and deny-unless-allowed modes.
- Per-invocation hooks. Hooks live in the user's `config.toml` or an installed plugin, which Kangentic does not edit, so `removeHooks` only strips the MCP entry. Activity comes from the wire instead.
- Per-invocation MCP.
- A live model or effort swap.
- Cost and rate limits. `/usage` shows quota on screen only.
- A session delete command, a run that saves no session, and a read-only headless run.

Startup recovery types nothing, so a session whose conversation was deleted opens idle there, with no recap.
