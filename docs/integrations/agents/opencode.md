---
type: Reference
title: OpenCode
description: OpenCode's activity plugin copied into .opencode/plugins (tool calls, subagents, question and permission waits, and a status.json of model, context, tokens and cost), --auto for the Build (Auto-approve) mode, the model list from opencode models, session ids from an opencode.db SQLite poll or ses_ output scan, --prompt because the positional argument is a directory, OPENCODE_CONFIG_CONTENT for MCP, remote mode through opencode attach with no plugin or MCP, and OpenCode 2's --standalone launch with the agent and model in config.
tags: [agents, adapter, opencode]
sources:
  - resource: src/main/agent/adapters/opencode/opencode-adapter.ts
  - resource: src/main/agent/adapters/opencode/detector.ts
  - resource: src/main/agent/adapters/opencode/command-builder.ts
  - resource: src/main/agent/adapters/opencode/hook-manager.ts
  - resource: src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs
  - resource: src/main/agent/adapters/opencode/session-history-parser.ts
  - resource: src/main/agent/adapters/opencode/remote-client.ts
  - resource: src/main/agent/adapters/opencode/remote-client-v2.ts
  - resource: src/main/agent/adapters/opencode/distro-sessions.ts
  - resource: src/main/agent/adapters/opencode/version.ts
  - resource: src/main/agent/adapters/opencode/v2-messages.ts
  - resource: src/main/agent/adapters/opencode/plugin/kangentic-activity-v2.mjs
  - resource: src/main/agent/adapters/opencode/transcript-parser.ts
  - resource: src/main/agent/adapters/opencode/command-injection-verifier.ts
  - resource: src/main/agent/adapters/opencode/capability-discovery.ts
  - resource: src/main/agent/adapters/opencode/project-relocation.ts
  - resource: src/main/agent/adapters/opencode/status-parser.ts
  - resource: src/main/agent/adapters/opencode/transcript-usage.ts
  - resource: src/main/agent/adapters/opencode/subagent-usage.ts
---
# OpenCode

## CLI Detection

`config.agent.cliPaths.opencode` override, then `PATH` lookup for `opencode` (with the `.cmd` shim on Windows for `npm i -g opencode-ai` installs; under a PowerShell or Git Bash host the spawn chokepoint launches the sibling `.ps1` or sh shim instead, see [npm .cmd shims under PowerShell and Git Bash](../../platforms/shells-and-paths.md#npm-cmd-shims-under-powershell-and-git-bash)), then the standard Unix fallback paths. Distributed via Homebrew, Scoop, Chocolatey, Pacman, the curl|sh installer, and `npm i -g opencode-ai` - all install methods publish the same `opencode` binary name. The version probe runs `opencode --version` and strips an optional `opencode ` product prefix from the output.

## Command Building

`src/main/agent/adapters/opencode/command-builder.ts`

OpenCode 1 (OpenCode 2 is below):

```
opencode [--session <id>] [--prompt <text>]
```

Important shape constraints (verified against /anomalyco/opencode docs):

- The TUI's positional argument is a **project directory**, not a prompt. Initial prompts must go through `--prompt <text>` or OpenCode tries to chdir into the prompt text. The PTY layer already sets the shell cwd, so Kangentic never emits a positional or `--dir` value.
- Resume uses `--session <id>` (alias `-s`) on the TUI command - not the `run` subcommand. A resume passes no `--prompt`. The TUI lists `--session` and `--prompt` side by side, but neither `opencode --help` nor the docs say the prompt runs on a session it continues, so the adapter declares `resumePromptDelivery: 'typed'` and Kangentic types a resume's message in once the TUI is ready (see [How the resume prompt arrives](../../architecture/sessions/resume.md#how-the-resume-prompt-arrives)).
- Windows shells get embedded `"` characters in the prompt rewritten to `'` to keep the cmd.exe / PowerShell quoting parser happy.

## OpenCode 2

OpenCode 2 (`@opencode/cli`, 2.x) installs as `opencode` too, and its TUI command rejects `--agent` and `--model` ("Unrecognized flag: --agent", GitHub #720). Both majors are supported, picked by the detected version (`version.ts`: `opencode --version` prints `opencode v2.2.5` on V2). A version that cannot be read is treated as OpenCode 1. Checked against 2.2.5:

```
opencode --standalone [--session <id> | --prompt <text>]
```

- **`--standalone`.** Without it the V2 TUI joins or starts one background service per user account. That service reads `OPENCODE_CONFIG_CONTENT` only when it starts, so a TUI that joins it never gets the Kangentic MCP entry, and one that starts it leaves a detached service carrying the task's env. With it, the TUI runs a private `opencode serve --stdio` child that inherits the spawn's env and exits with the TUI. Measured: Ctrl+C ends both in about 1.7 s, and `opencode service status` stays `stopped`.
- **Agent and model.** A fresh spawn puts `default_agent` (`plan` or `build`, from the same mapping as `--agent`) and the column's `model` in `OPENCODE_CONFIG_CONTENT` beside `mcp.kangentic`. `default_agent: "plan"` opens the TUI in Plan. A resume names neither, so the session keeps its agent. V2 reads the V1-shaped `mcp.kangentic` entry and normalizes it to `mcp.servers.kangentic`.
- **MCP tools.** V2 offers MCP tools through its Code Mode `execute` tool and a tool catalog in the instructions, not as one tool each. The catalog lists `tools.kangentic.kangentic_*`, and the TUI's `/mcps` shows the server Connected.
- **Activity.** V2 does not run V1 plugins: it tries the V1 file and logs "Plugin must export a default definition with an id and an effect or setup function". A V2 spawn installs `kangentic-activity-v2.mjs` as `.opencode/plugins/kangentic-activity/index.js` instead, the directory shape V2 discovers and V1's one-level glob never reads. It is a plain `export default { id, setup(ctx) }`, so it needs no `@opencode/plugin` package. From `ctx.event.subscribe()` it maps:
  - `session.execution.started` to `prompt`;
  - `session.execution.succeeded` to `idle`;
  - a failed execution to `idle` with `detail: 'error'`, and an interrupted one to `interrupted`;
  - `permission.asked` and `question.asked` to the waits, their replies to notifications (the V1 names).

  The first event carrying `data.sessionID` writes `session_start` with the id in hookContext. `ctx.tool.hook('execute.before' | 'execute.after')` writes `tool_start` (detail from `input.command`, `input.path`, ...) and `tool_end`. Measured on 2.2.5: a turn with a shell call wrote session start, prompt, tool start and end, idle; a `.env` read wrote the approval wait and its reply. The failure and interrupt event names, and the `question.*` names, are not measured. They stay as guesses: one that misses matches nothing, and the PTY fallback ends the turn.
- **Session ids.** V2 keeps `~/.local/share/opencode/opencode.db` and migrates it in place: it leaves the V1 `session`, `message` and `part` tables as they were, copies the V1 sessions into `session_v2`, and writes new sessions to `session_v2` and `session_message` only. An OpenCode 1 run afterwards writes `session` again. The session poll reads both tables.
- **Transcript and delivery check.** A V2 session's messages are `session_message` rows, one per message ordered by `seq`, with the text, reasoning and tool calls in `data.content` (`v2-messages.ts`). The migration copies every V1 session's messages into `session_message` too, and each major then writes only its own table, so a session continued after the upgrade has its newest turns in one table alone. The transcript reader and the Conversation viewer's pages read whichever table holds the session's newest message, and `message` on a tie. The auto_command check reads the recent `message` rows, then the session's `type = 'user'` rows. So handoff, the agent's last reply for turn-end automations, and delivery confirmation work on V2.
- **WSL.** The distro CLI's major is read with `--version` once per binary, and again after Kangentic re-detects the CLI. A failed read fails the run that asked rather than guessing a major. On V2, `session list` takes `--standalone` instead of `--pure`, and the export is `session export <id> --standalone`, which prints one record per message.
- **Sign-in.** V2 keeps credentials in the database's `credential` table and imports a V1 `auth.json` there at start, so `probeAuth` counts that table first (local only), then reads `auth.json`.
- **Upgrading in place.** The detected version is cached until Kangentic re-detects the CLI (a CLI path change, or a restart), so the first spawn after replacing OpenCode 1 with 2 under the same path still gets the V1 command.
- **Answer runs** (auto-name, Knowledge Graph Ask): `run --agent plan --format json --standalone`, and the session delete takes `--standalone` too. V2 has no `--pure`. Its `run --format json` events have V1's shape. V2's built-in Plan agent allows shell commands (V1's refused them), so an answer run's inline config denies `shell` and `edit`. Measured: without the deny a scripted shell call wrote its file, with it V2 did not offer the shell tool.
- **Model picker.** V2's root `--help` has no `--model`, so capability discovery reports the model override as supported on V2 without reading the help. V2's `models` command has not been read, so a V2 picker has no list and takes a typed id.
- **Build (Auto-approve).** V2's TUI command keeps `--auto` (`packages/cli/src/commands/commands.ts` at v2.2.5, `PermissionParams`), so such a column's V2 spawn is `opencode --standalone --auto`.
- **Remote mode** with a local OpenCode 2 is blocked: the remote spawn is OpenCode 1's `opencode attach <url>`, which OpenCode 2 does not have. The spawn fails with "OpenCode remote mode needs OpenCode 1", and "Test connection" with a local V2 gives the same answer before it asks the server. The V2 server client and the connection test's naming of a V2 server are described under Remote Execution below.
- **Subagents and compaction.** `createV2SessionTracker` reads the 2.2.5 event schema (`packages/schema/src/session-event.ts`): a `session.created` whose `data.parentID` is set is a `task` subagent's child session, so it writes `subagent_start` and the child's `session.execution.*` end writes `subagent_stop`, never the task's own `session_start` or `idle`. The root's turn end stops any subagent still open first. `session.compaction.started` writes `compact`. A subagent's tool calls carry its `subagentId`.
- **Telemetry.** The V2 plugin writes the same `status.json` as OpenCode 1's (Live telemetry below): the model from the root's `session.step.started` (`Model.Ref`: `id`, `providerID`), tokens and cost from each `session.step.ended` (`TokenUsage.Info` in `token-usage.ts`), and cost from compactions and subagent steps too. The events give no model name or context limit, so the label is the id and the context size is 0. The adapter keeps `liveTelemetryUnsupported` ("Telemetry: TUI only") for remote sessions, which run no plugin; the card and context bar show it only until a session names a model.

## Permission Modes

The `permissions` list exposes the modes OpenCode itself has, in its own vocabulary:

| Mode | Label | OpenCode 1 fresh spawn | OpenCode 2 fresh spawn |
|------|-------|------------------------|------------------------|
| `plan` | Plan | `--agent plan` (the built-in read-only agent) | `default_agent: "plan"` in the inline config |
| `default` | Default Agent | no flag, so the user's own `default_agent` decides | nothing named |
| `acceptEdits` | Build | `--agent build` (full tool access) | `default_agent: "build"` |
| `bypassPermissions` | Build (Auto-approve) | `--auto --agent build` | `--auto`, `default_agent: "build"` |

The stored `PermissionMode` enum values are reused for compatibility, so a swimlane set to `acceptEdits` under Claude continues to mean "Build" under OpenCode. `--auto` is OpenCode's own flag, "auto-approve permissions that are not explicitly denied (dangerous!)" (`opencode --help` on 1.18.31; [permissions](https://opencode.ai/docs/permissions/)), so a `deny` rule the user wrote still holds. OpenCode 1 added it in 1.17.12 (PRs #33279 and #34641), and an older or unread version gets `--agent build` alone, since it would reject the flag (`openCodeSupportsAutoApprove`, `version.ts`). A resume passes `--session <id>` and no `--agent`, because the saved session already has an agent and the user may have switched it with Tab. It does pass `--auto`, which is a flag on the TUI process, not a choice the session keeps. `attach` (remote mode) never gets `--auto`: nothing documents it there. `dontAsk` and `auto` have no OpenCode meaning and sit outside the list: `mapPermissionModeToAgent` still accepts them for mixed-agent projects and gives no flag. The default mode is `acceptEdits`.

## Settings Merge

None. OpenCode reads MCP and provider configuration from `opencode.json` (project) or `~/.config/opencode/opencode.json` (global). `removeHooks` only removes the activity plugin (next subsection). The Kangentic MCP server IS wired in for a local-mode spawn - `buildOpenCodeEnv` (`command-builder.ts`) emits an inline `mcp.kangentic` entry via the `OPENCODE_CONFIG_CONTENT` env var per PTY spawn, deep-merged over the user's own config so their `mcp.*` entries are preserved (see [How the MCP server works](../mcp-server/how-it-works.md)). It is NOT wired in for a remote-mode spawn (`opencode attach <url>`) - see the Remote Execution subsection below.

## Activity Plugin

OpenCode 1 local-mode spawns install the Kangentic activity plugin by copying the packaged `kangentic-activity.mjs` into `<projectRoot>/.opencode/plugins/` as `kangentic-activity.js`, where OpenCode auto-discovers plugins at TUI startup. An OpenCode 2 spawn installs `kangentic-activity-v2.mjs` as `.opencode/plugins/kangentic-activity/index.js` instead (see OpenCode 2 above), held and removed the same way. The extension decides whether OpenCode loads it. OpenCode 1.18.31's loader reads only `{plugin,plugins}/*.{ts,js}` (read from its binary), and its Bun runtime loads ES module syntax from a `.js` file. Earlier builds installed the `.mjs` name, which OpenCode never loaded, so every OpenCode session ran on the PTY fallback alone. The installer and `removeHooks` delete such a leftover `.mjs`. Measured on 1.18.31 with the `.js` name: the plugin wrote `session_start` and the turn's `idle` lines. No live capture of a question or permission wait exists yet.

The module exports the plugin and nothing else. The loader calls every export value as a plugin factory and throws on one that is not a function, so the pure helpers ride on the plugin as `KangenticActivity.helpers` for the tests.

The copy is byte-compare idempotent, and removal of either name verifies a sentinel comment on line 1 so a user-authored plugin at the same path is never touched. The plugin runs inline in the OpenCode process and writes activity events straight to the session's `events.jsonl`, reading its output path from the `KANGENTIC_EVENTS_PATH` env var exported by the PTY spawn flow. Note the install lands at the PROJECT ROOT, not the task worktree. Concurrent sessions in one project hold the plugin per session (`OpenCodeAdapter.hookHolds`), and the hold records the project root, so a worktree session's release (which names the worktree) removes the plugin once the root's last session ends.

The plugin also reports the waits on the user (GitHub #452), from its `event` hook, which OpenCode calls with every event for its directory and no type filter (`packages/opencode/src/plugin/index.ts` in 1.18.31). `question.asked` writes the permission `idle` tagged `waitKind: 'question'`, and `permission.asked` the same tagged `'approval'` (type strings from OpenCode's `packages/schema/src/v1/question.ts` and `v1/permission.ts`). OpenCode publishes both from inside the tool's own execution: it triggers `tool.execute.before`, runs the tool, whose `ask` publishes the request, then triggers `tool.execute.after`, also after a throw. So the wait lands after the tool's `tool_start` and the tool's `tool_end` ends it. The answers (`question.replied`, `question.rejected`, `permission.replied`) are logged as notifications only; a rejection ends the tool or the turn, whose next `tool_start` or `session.idle` clears the wait. OpenCode 2 does not run this plugin; its own reports the same waits (see OpenCode 2 above).

The plugin file is hidden from git via the shared `.git/info/exclude` mechanism (`src/main/agent/shared/git-exclude.ts`, see [Antigravity](antigravity.md)), seeded only once the plugin file actually exists at the destination so a failed copy never leaves an entry pointing at a missing file. Earlier releases appended the entry to the project's tracked `.gitignore` instead, which dirtied the user's checkout. A line those releases appended is left in place. It names the old `.mjs` path, so the exclude entry alone hides the `.js` copy. The OpenCode 2 plugin directory is hidden the same way, under `.opencode/plugins/kangentic-activity/`.

### Subagents, prompts and compaction (OpenCode 1)

OpenCode's `task` tool runs a subagent in a child session whose `Session.parentID` names the task's session, and the `event` hook gets every session's events with no filter. The plugin used to write a child's `session.created` and `session.idle` as the task's own `session_start` and `idle`, which ended the task's turn while the subagent still ran. `createSessionTracker` now tells them apart: a session is a child once a `session.created` or `session.updated` shows its `parentID`, and every other session is the root (the TUI's own, or the one a resume opened).

- A child's `session.created` writes `subagent_start` with `subagentId` set to the child's session id, and its `session.idle` or `session.error` writes `subagent_stop`. A child the `task` tool continues raises no second `session.created`, so its `session.status` of `busy` starts it again.
- The root's `session.idle` first stops every subagent still open, then writes `idle`.
- `tool.execute.before` and `tool.execute.after` add `toolId` from their `callID`, and `subagentId` for a call a child makes.
- `chat.message` (the user's message reaching the root) writes `prompt`.
- `experimental.session.compacting`, which OpenCode calls before it compacts a session, writes `compact`.

Question and permission waits are written whichever session asked, since a subagent's wait is on the user too.

OpenCode 2's plugin does the same from its own events (see OpenCode 2 above).

### Live telemetry

The OpenCode 1 plugin keeps the session's `status.json` beside `events.jsonl` (the same session folder, so the path needs no variable of its own and is already the distro's path under WSL), and the adapter's `statusFile.parseStatus` (`parseOpenCodeStatus`, `status-parser.ts`) reads it. The plugin rewrites it whole and in place, as Claude's status bridge does, since the reader watches the file itself and a rename would swap it under that watch; `isFullRewrite` is true. A read that lands mid-write gets bad JSON, which the parser drops.

- **Model:** the one the root's newest answer came from (`providerID/modelID`, the form `--model` takes), so a `/models` switch shows once the new model answers. Before the first answer it is the root's newest `chat.params` model. Each `chat.params` input carries a `Model` (`id`, `providerID`, `name`, `limit.context`), which names and sizes that model; nothing documents that only the main agent's requests pass through `chat.params`, so it never picks the model shown on its own. A model no `chat.params` described (a resumed session's first answer) has no name and context size 0.
- **Context:** the root's newest assistant message, `tokens.input` plus `tokens.cache.read` and `cache.write`, against `limit.context`. A model with no limit reports size 0, the unknown sentinel, and 0 percent.
- **Tokens:** the root's assistant messages summed, each counted once at its latest numbers. Input includes the cache read and written; output includes reasoning.
- **Cost:** every assistant message's `cost`, the subagents' included, since they are paid too.
- **No session id** is reported, so a child session can never read as a conversation switch.

OpenCode 2's plugin writes the same file from `session.step.started` and `session.step.ended` (OpenCode 2 above). A remote session runs no plugin and has no telemetry.

### Model picker

On OpenCode 1, discovery runs `opencode models --verbose` (`parseOpenCodeModels`, `capability-discovery.ts`) when the help lists `--model`. The command lists only the providers the user has connected (`Provider.list()` in `provider/provider.ts`, `cli/cmd/models.ts` at v1.18.31; [CLI docs](https://opencode.ai/docs/cli/#models)): one `<providerID>/<modelID>` line per model, each followed in `--verbose` by the model's JSON, whose `name` labels it. Two providers serving one name are told apart by the provider. The list is kept per CLI path until a model dropdown forces a refresh or the CLI is detected again. The agent list waits on every adapter's discovery before it answers, so an unforced ask starts the read and answers with the list it has, none on the first ask. A dropdown opening (`rescanModels`) re-detects every CLI, which marks the list stale and drops a read in flight, then waits for a fresh read. A failed read keeps the last list, stale or not, or leaves the picker's typed input when there is none. `configuredModelFromCommand` seeds the card with the `--model` of a V1 command, by that name once the list has been read, and `modelDisplayName` names a telemetry-learned id from it. No effort levels are reported: OpenCode's reasoning variants differ per model and only `run` takes `--variant`, while the TUI cycles them with ctrl+t ([models](https://opencode.ai/docs/models/)).

### Transcript usage, tool counts and subagents

These read a local session from `opencode.db`, in the store the transcript reader picks; a remote or distro session answers null or empty.

- **`transcriptUsage`** (`transcript-usage.ts`) sums every assistant message's `tokens` the way Claude's transcript usage does.
- **Per-turn usage.** Each assistant entry the transcript readers mint carries its message's `tokens` as `usage` (`openCodeTurnUsage`), for the turn-usage ledger.
- **`transcriptToolCounts`** counts distinct calls by name (`callID` on an OpenCode 1 tool part, `id` on an OpenCode 2 `tool` content item). **`transcriptToolResultTokens`** estimates each call's returned text (`state.output` or `state.error`, OpenCode 2's `state.content`) at four characters a token. Both keep to `sinceMs` and `untilMs` by the row's `time_created`, so the adapter declares `scopesTranscriptReadsByTime`: OpenCode keeps a resumed session's runs in one session, as Claude keeps them in one transcript.
- **`parseTranscriptWindow`** walks the session for the conversation indexer in the transcript reader's position unit (characters of stored `data`), whole messages at a time, the same entries the tail parse mints.
- **Subagents** (`subagent-usage.ts`, OpenCode 1). The `task` tool runs a subagent in a child session whose `session.parent_id` names its parent (`packages/core/src/session/sql.ts`), and the spawning part's `state.metadata.sessionId` names the child (`tool/task.ts`), both at v1.18.31. `parseSubagentUsage` reads each child's answers, to any depth, as one turn per assistant message, with the spawning `task` call as `parentToolUseId` and its `subagent_type` as the agent type; the `task` calls subagents make are its spawn links. `statSubagentTranscripts` signs the child sessions by count, stored size and newest update. `subagentSpawnToolName` is `task`, so the indexer links a main-thread `task` call to the turn that made it. OpenCode 2's `session_v2` parent column has not been read, so an OpenCode 2 session reports no subagents. `fileChangeTools` names `edit` and `write` by `filePath` (`tool/edit.ts` and `tool/write.ts` at v1.18.31; [tools](https://opencode.ai/docs/tools/)); `apply_patch` carries its paths inside `patchText`.

### Built from documentation

Everything in the four subsections above, the OpenCode 2 plugin's subagents, compaction and telemetry, and the Build (Auto-approve) mode, was built from OpenCode's published source and docs and has not been run against a real OpenCode session. Sources: tag v1.18.31 of `github.com/anomalyco/opencode` (`packages/plugin/src/index.ts`, `packages/sdk/js/src/gen/types.gen.ts`, `packages/core/src/session/sql.ts`, `cli/cmd/models.ts`, `provider/provider.ts`, `tool/edit.ts`, `tool/write.ts`, `tool/task.ts`) and tag v2.2.5 (`packages/cli/src/commands/commands.ts`, `packages/schema/src/session-event.ts`, `token-usage.ts`, `model.ts`). The plugin tests' fixtures are shaped from those types (`tests/fixtures/opencode-plugin-events.json`). Two parts were since checked against OpenCode 1.18.31 on a real machine: the `opencode models --verbose` layout, which `tests/fixtures/opencode-models-verbose.txt` holds verbatim, and the `opencode.db` tables and fields the usage and subagent readers use (`session.parent_id`, a `task` part's `state.metadata.sessionId` and `state.input.subagent_type`, an answer's `tokens`, `edit` and `write` taking `filePath`). Check first on a live run: that a child session's idle (OpenCode 1) or `session.execution.succeeded` (OpenCode 2) arrives, since the subagent's stop rests on it; the hook payloads the plugins read; the `status.json` numbers against the TUI's own; and that `--auto` approves a prompt.

### Gaps against Claude Code

Checked against OpenCode's docs and left unbuilt:

- **Not supported by the CLI:** a live model or effort swap (`getInjectionSequence`; the TUI only opens pickers or cycles, `/models`, `/variants`, ctrl+t), a TUI effort flag, rate-limit windows (only `session.status` `retry`, with quota detail for OpenCode Zen alone), background commands (`bash` takes `command`, `timeout`, `workdir`), a trust prompt, readable directories by flag (only the `external_directory` permission in config), and `dontAsk` or classifier modes.
- **Need a live probe:** plan exit (`plan_exit` exists only with `OPENCODE_EXPERIMENTAL_PLAN_MODE`, and nothing documents how an approved and a rejected exit differ in `tool.execute.after`), webp, avif, svg and pdf in `pastedImageNativeExtensions` (the TUI's paste handler lists them), `supportsReadOnlyLaunch`, `supportsPlanAutoApproval` and `mayApprovePlanTool`, `consoleCloseIsGraceful`, `hungTurn`, a paste verifier and escalation, `describeStartupFailure` and `proveConversationGone` (what `--session` does with a missing id), and an effort setting for answer runs (`run --variant`).
- **Not applicable:** Claude's background-session members (`stopBackgroundSession` and its siblings), `runtime.sessionHistory` (the history is SQLite), `kangenticMcpBlockedReason`, `pastedImageReferenceTemplate`, and `firstPromptMayBeTyped` (measured not declared, see [First prompt typed](adapter-interface.md#first-prompt-typed-firstpromptmaybetyped)).
- **Not built, by decision:**
  - `openAnswerSession`. OpenCode has no stdin-JSON session to keep warm; one would be an `opencode serve` process driven over HTTP, a server lifecycle and paid answers nobody could check without a live run. The alternative, a warm `opencode serve` the adapter starts and stops itself, waits for that run.
  - `onWorktreeRemoved` for OpenCode's per-worktree snapshot folders (`snapshot/<projectID>/<hash of the worktree>` in `instance-store.ts`, never cleaned up by OpenCode). The hook is for trust entries only, by design (see [Optional properties](optional-properties.md)), the snapshots are OpenCode's undo data, and the folder's name is an internal hash. The alternative, deleting the folder by recomputing that hash, would tie Kangentic to an OpenCode internal.

## Session ID Capture

Not caller-owned (`supportsCallerSessionId = false`). Two capture pathways run concurrently and the first to succeed wins:

- **`sessionId.fromOutput`:** `SessionIdScanner` strips ANSI escapes from each PTY chunk and matches against `(?:session(?:[ _-]?id)?|sid)` and `--session` flag forms. Accepts both OpenCode's native `ses_<16-64 alphanumeric>` shape (verified empirically on v1.14.25, e.g. `ses_2349b5c91ffeKd6qajuUTR4clq`) and canonical UUID format.
- **`sessionId.fromFilesystem`:** Polls the OpenCode SQLite database at `~/.local/share/opencode/opencode.db` (read-only, WAL-friendly handle) for a `session` or `session_v2` row (OpenCode 2's table, see above) whose `directory` equals the spawn cwd and whose `time_created` falls within `[spawnedAt - 5s, spawnedAt + 30s]`. Polls every 500 ms for up to ~10 s. Direct DB read avoids ~200-500 ms `opencode` CLI spin-up per poll, and avoids the Windows `child_process.execFile` rejection of `.cmd` shims.

## WSL

An OpenCode installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`, for the curl installer `~/.opencode/bin/opencode`). Name that binary itself: a distro whose PATH also reaches a Windows `npm` install resolves a bare `opencode` to the Windows shim through interop. The session starts the binary's Linux path in a `wsl -d <distro>` shell.

- **Activity plugin:** unchanged. It is a file in the project, which the distro reads at its `/mnt` path, and the spawn lists `KANGENTIC_EVENTS_PATH` in `WSLENV` with `/up`, so the plugin appends to `events.jsonl` at the path the distro sees. One OpenCode process is that file's only writer, as on Windows.
- **MCP:** `OPENCODE_CONFIG_CONTENT` crosses into the distro through `WSLENV`. On mirrored networking it holds the `remote` entry. On NAT networking it holds the WSL hook transport's bridge as a `local` entry, `{"type": "local", "command": ["sh", <script>, "mcp", <url>], "environment": {"KANGENTIC_MCP_TOKEN": <token>}, "enabled": true}`, the shape OpenCode's MCP docs give a local server (`command` is the program and its arguments in one array).
- **Sessions:** the distro's sessions are in the distro's `opencode.db`. Its WAL needs shared memory the share does not give a Windows reader, so Kangentic never opens it. It asks the distro's own CLI through `wsl.exe`, with `--pure` and the session's cwd (`distro-sessions.ts`). The session id comes from the plugin's hook first, else `opencode session list --format json` polled once a second for up to ten tries, matched on the distro's path of the cwd. The transcript is `opencode export <id>`, whose messages are the `{info, parts}` entries the remote mapper reads. That is OpenCode 1. On OpenCode 2 the flags and the export differ, as the OpenCode 2 section above describes: `--standalone` in place of `--pure`, `session export`, and one record per message, which `parseOpenCodeExport` converts to the same entries. The auto_command check exports the session too, one run per Enter where the local query takes under 100 ms. The Conversation viewer gets no pages and handoff no history file, as for a remote session. Running the CLI after the session needs its path, so a session row's `cli_target` keeps `linuxCliPath`. A row from before that reads as no transcript.
- **Sign-in:** `probeAuth` reads `auth.json` under the distro's own `XDG_DATA_HOME`, else its `~/.local/share/opencode/`.
- **Other runs:** `--help` and a Knowledge Graph answer run through `wsl.exe`, and the answer's session is deleted there. An answer whose search bridges gets a run directory of its own for the relay.
- **Not covered:** `onProjectRelocated` rewrites this machine's database only, so a distro's sessions keep their old directory after a project moves.

The shapes were checked against this machine's OpenCode 1.18.31 and the distro's 1.14.25 `--help`. The distro's OpenCode was not signed in and had no sessions, so no session has been run end to end in a distro.

## Remote Execution

OpenCode is the only adapter that declares `remoteExecution` (see `remoteExecution?` in [Optional properties](optional-properties.md) and [Remote Execution](../../settings/app-config.md#remote-execution) for the config shape). A remote spawn with OpenCode 2 detected locally is blocked with "OpenCode remote mode needs OpenCode 1", because the spawn is OpenCode 1's `attach`. When a project's mode for OpenCode is `remote`:

- **Command:** `command-builder.ts`'s `buildOpenCodeAttachCommand` emits `opencode attach <url> [--dir <serverPath>] [--username u] [--password p]` instead of the local TUI form. `--model` is never emitted - the server is the authority for providers and models. Resume uses `--session <id>` exactly as in local mode.
- **Auth:** `probeAuth()` (the local `auth.json` check) is bypassed. `remoteExecution.probeServer` (`remote-client.ts`'s `probeOpenCodeServer`) hits `GET <url>/global/health` instead, surfaced via the `agent:probeExecutionServer` IPC channel and the Agent settings tab's "Test connection" button. An OpenCode 2 server answers that route with its web app's HTML, or with a 401 to any username but `opencode`. In either case the probe asks the server's `GET /api/info` as `opencode` and reports the server's version, because the local CLI and the server must run the same major.
- **Session ID capture:** `sessionId.fromFilesystem` (the local SQLite poll) is skipped for a remote-mode cwd - `sessionId.fromOutput` (the PTY scan) is the sole capture path. This also means the "concurrent same-cwd spawns cannot be disambiguated" caveat below does not apply to remote sessions.
- **Transcript:** `parseTranscript` fetches `GET <url>/session/:id/message` (`remote-client.ts`'s `fetchOpenCodeSessionMessages`) instead of reading the local SQLite database, mapped into the same `TranscriptEntry[]` shape by `mapOpenCodeRemoteEntries` (a distinct mapper from the local `mapOpenCodeRows` - the wire shape is `{info, parts}[]`, not SQLite rows).
- **Activity plugin:** not installed - the plugin file would need to land on the server's filesystem, which Kangentic has no access to. PTY-silence activity detection (already the fallback tier of `hooks_and_pty`) carries activity for remote sessions.
- **MCP:** not wired. `buildOpenCodeEnv` returns `null` whenever `options.executionTarget` is set (loopback or genuinely remote target - both). This is architectural, not a reachability problem: `opencode attach <url>` is a stateless HTTP client to a server that was started, and had its config fixed, independently and earlier - its CLI surface exposes no config-push flags (verified against `opencode attach --help`), so env vars Kangentic sets on the spawned attach process are never read by the already-running server. Kangentic's `mcpServer.bindAddress`/`callbackHost` settings (see [Network Access](../mcp-server/how-it-works.md#network-access)) make the server itself LAN/VPN-reachable, but cannot make `attach` push config into a server it does not control the startup of.
- **Worktree:** `ensureTaskWorktree` (`src/main/ipc/helpers/task-git.ts`) skips creating a local git worktree for a task whose resolved agent is remote-mode; the configured server working directory travels via `executionTarget`, never through `task.worktree_path`.
- **Handoff:** `locateSessionHistoryFile` returns `null` for a remote-mode cwd - cross-agent handoff degrades to the PTY-scrollback cleanup fallback, since there is no local history file to reference.
- **OpenCode 2 server:** `remote-client-v2.ts` is the client for a V2 server, which replaced the V1 API and removed `opencode attach`. The adapter does not call it yet: remote mode still launches `opencode attach` (OpenCode 1), so "Test connection" reports an OpenCode 2 server as a version mismatch. Its probe reads `GET /api/info` with Basic auth whose username is always `opencode`, and when that route answers with HTML, a major-1 version, or a 401 to a username other than `opencode`, it asks `GET /global/health` to name the OpenCode 1 server it found. `createOpenCodeV2Session` creates a session through `POST /api/session` in the server-side directory, so the TUI can open it with `--session <id>`. `fetchOpenCodeV2SessionMessages` pages `GET /api/session/{id}/message` newest first until the transcript window's byte budget, 20 pages or a 30 s deadline, and says whether it reached the history's start. `mapOpenCodeV2Messages` maps the messages into `TranscriptEntry[]`. Shapes come from `@opencode/client` 2.2.5 and responses recorded from a live `opencode serve` 2.2.5 (`tests/fixtures/opencode-v2/`).

The adapter tracks which cwd resolved to which remote target in an in-memory `Map` populated by `buildCommand` (alongside the plugin's `hookHolds`), since `parseTranscript` / `locateSessionHistoryFile` / `sessionId.fromFilesystem` have no other way to reach Kangentic's `AppConfig` (adapters hold no config reference by design). Known limitation: this map is empty after an app restart, so viewing an old remote session's transcript falls back to the (empty) local SQLite lookup until the task is resumed again.

## Limitations

- **Concurrent same-cwd spawns cannot be disambiguated (local mode only):** Two OpenCode tasks spawned within ~30 s against the same `cwd` cannot be reliably distinguished by `captureSessionIdFromFilesystem`. Both rows match the directory + time-window predicate, so the parser returns the most recently created row - which can attribute task A's session ID to task B, or vice versa. Kangentic's per-task worktrees (`git.worktreesEnabled`, default `true`) sidestep this by giving every task its own `cwd`. If you have disabled worktrees and need to run multiple OpenCode tasks against the same project root, either re-enable worktrees in Settings -> Git or stagger the spawns by more than 30 seconds. The Codex CLI parser carries the same caveat. Does not apply to remote-mode sessions (see above).
- **Activity is `hooks_and_pty`:** the activity plugin's events are authoritative when they fire, and PTY-silence detection (`PTY_SILENCE_THRESHOLD_MS`, same `PtyActivityTracker` shape as Codex) is the fallback tier for sessions without the plugin (remote mode, failed install). OpenCode has no statusline; the only `status.json` is the activity plugin's (Live telemetry above), so a remote session has no live telemetry.
- **No trust dialog:** `ensureTrust` is a no-op. OpenCode does not prompt for directory trust on first run.
- **Remote mode is single-directory per project:** the server working directory is per-project, not per-task, so concurrent remote tasks in the same project share one directory. Per-task remote worktrees would require remote git operations (OpenCode's `POST /session/:id/shell` is the mechanism, if pursued later).
