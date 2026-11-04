---
type: Reference
title: Antigravity
description: Google's Antigravity CLI (agy), which tokenizes its own hook commands so paths are unquoted and .agents-relative, a copied agy-event-bridge.cjs, MCP as a workspace plugin, per-cwd trustedWorkspaces, a per-session status line through --settings, SessionStart and every-tool PreToolUse hooks that answer allow, and brain transcript.jsonl history.
tags: [agents, adapter, antigravity]
sources:
  - resource: src/main/agent/adapters/antigravity/antigravity-adapter.ts
  - resource: src/main/agent/adapters/antigravity/detector.ts
  - resource: src/main/agent/adapters/antigravity/command-builder.ts
  - resource: src/main/agent/adapters/antigravity/hook-manager.ts
  - resource: src/main/agent/adapters/antigravity/trust-manager.ts
  - resource: src/main/agent/adapters/antigravity/data-paths.ts
  - resource: src/main/agent/adapters/antigravity/transcript-parser.ts
  - resource: src/main/agent/adapters/antigravity/status-parser.ts
  - resource: src/main/agent/adapters/antigravity/capability-discovery.ts
  - resource: src/main/agent/adapters/antigravity/answer-stream.ts
  - resource: src/main/agent/adapters/antigravity/print-runner.ts
  - resource: src/main/agent/shared/git-exclude.ts
---
# Antigravity

Antigravity CLI (`agy`, https://antigravity.google/docs/cli/getting-started) is Google's terminal TUI coding agent, Gemini-family models by default with optional Claude and open-source backends. It shares the `~/.gemini` home directory with the Gemini CLI but keeps everything of its own under the `~/.gemini/antigravity-cli/` subtree, with its own trust store, hook schema, and MCP config format - hence a sibling adapter rather than a Gemini variant.

The adapter was first verified against a real agy 1.1.13 install (2026-08-16). A later pass (2026-11-03) built more of it from agy's own documentation and the 1.4.12 `--help`, without a signed-in agy to run it against. Those parts are listed in [Built from documentation](#built-from-documentation), each with its source.

## CLI Detection

Detection uses the shared `AgentDetector` (via composition) with binary name `agy`. The official installer places the binary at `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows (a fallback path derived from the `LOCALAPPDATA` env var) and `~/.local/bin/agy` on macOS/Linux (covered by `standardUnixFallbackPaths`). `agy --version` prints a bare version number; `parseVersion` requires a leading digit so a foreign tool answering on the same name is rejected.

Capability discovery (`capability-discovery.ts`) reads `agy --help` once per CLI path:
- `--model` turns on the model override, and `agy models` lists the models (`slug<TAB>Display Name`, a network fetch, cached per CLI path).
- `--effort`'s parenthesized list is the effort levels: `low|medium|high|xhigh|max` on 1.4.12. A line with no list falls back to the `low`, `medium` and `high` the headless flag table documents.
- `--settings` and the `--mode` values are kept for the command builder (`antigravityHelpFeatures`), which passes either one only when this CLI's help lists it. A CLI path discovery has not read yet counts as an older CLI.

## Command Building

`src/main/agent/adapters/antigravity/command-builder.ts`

```
agy [--mode plan|accept-edits|auto] [--dangerously-skip-permissions] [--settings <file>] [--conversation <id>] [--model <slug>] [--effort <level>] [-i|-p "<prompt>"]
```

- The interactive prompt is delivered via `-i` (`--prompt-interactive`), which runs the prompt and keeps the TUI session; agy has no bare positional prompt form. Non-interactive spawns (`nonInteractive` transition actions) use `-p` instead.
- Resume passes `--conversation <id>` with the captured conversation UUID; it works cross-directory, so a relocated worktree still reaches its conversation. Fresh spawns pass nothing - agy allocates the conversation id lazily at the first turn (`supportsCallerSessionId` is false).
- Model (`--model <slug>`) and effort (`--effort <level>`) overrides pass straight through when set.
- `--settings <file>` names the session's `antigravity-settings.json`, which carries the status line (see [Live telemetry](#live-telemetry)).
- As spawn side effects the builder merges the Kangentic named hook into `<cwd>/.agents/hooks.json`, writes the MCP workspace plugin (below), and writes the `--settings` file into the session directory.

## Permission Modes

Mapped onto agy's native modes (https://antigravity.google/docs/cli/modes). With no flag, agy runs in the mode its own settings save: `auto` where the terminal sandbox and the account allow it, `default` (review before each write and command) otherwise.

| Mode | Label | agy flag |
|------|-------|----------|
| `plan` | Plan (Read-Only Research) | `--mode plan` |
| `default` | Default (Saved Agent Mode) | (none) |
| `acceptEdits` | Accept Edits (Auto-Approve Edits) | `--mode accept-edits` |
| `auto` | Auto (Sandbox + Review) | `--mode auto` when `--help` lists it, else `--mode accept-edits` |
| `bypassPermissions` | Skip Permissions (Auto-Approve All) | `--dangerously-skip-permissions` |
| `dontAsk` | (not offered) | `--mode plan` |

- `auto` approves workspace edits and safe, reversible commands, runs commands in the terminal sandbox, and still prompts for irreversible ones. It exists from 1.3.5 on macOS and Linux and 1.4.4 on Windows. Where the sandbox is missing or the account is a business one, the modes doc says agy starts in `default` instead.
- `dontAsk` reaches agy only from a column set up for another agent. agy has no deny-unless-allowed mode, so it maps to read-only plan mode, as Gemini, Qwen and Copilot map it. It used to map to `--dangerously-skip-permissions`, which approved everything.

`defaultPermission` is `acceptEdits`.

## Hooks and Activity Detection

agy has a lifecycle hook system (https://antigravity.google/docs/hooks): six events in a `hooks.json` in a customization root. The adapter writes `<cwd>/.agents/hooks.json` with one named hook, `kangentic-events`:

| agy event | Kangentic event | Notes |
|-----------|-----------------|-------|
| `SessionStart` | `session_start` (log-only) | Fires once when a NEW conversation starts, before the first model call. The bridge captures its payload as `hookContext`, so the conversation id is known before the first turn. |
| `PreInvocation` | `prompt` | The turn-initiating signal, fired before every model call. Carries `captureHookContext`, since a `--conversation` resume fires no SessionStart. |
| `PreToolUse` (matcher `*`) | `tool_start` | Every tool, with its name at `toolCall.name` and its primary argument from `toolCall.args`. For `ask_question` alone it also appends a question wait. Replies `{"decision":"allow"}`. Not wired for an agy in a WSL distro. |
| `PostToolUse` (matcher `*`) | `tool_end` | Same name and detail directives as PreToolUse. |
| `Stop` | `idle` | When the execution loop terminates; the payload carries `fullyIdle`. |
| `PostInvocation` | (not wired) | Fires with PreInvocation's cadence and carries nothing Stop and Prompt do not. |

**The PreToolUse reply.** The hooks reference makes `decision` required, and agy treats a response without one as a DENY (observed on 1.1.13: a `{}` response put the model in a tool-denied retry loop). So the entry carries `replyJson({ decision: 'allow' })`, the one directive that makes the event bridge write to stdout (see [Bridge scripts](bridge-scripts.md#event-bridgejs)). `allow` "proceed[s], deferring to the next hook or default policy". A probe on agy 1.3.4 in a `/preview` showed it: a PreToolUse hook answering `allow` for every tool left both the question dialog ("Question 1/1: Which color?") and the command dialog ("Run this command?") on screen. Its payload names the tool at `toolCall.name` with the questions in `toolCall.args.questions` (`tests/fixtures/antigravity-hooks/`). Kangentic's question entry was then run live: the card showed the bubble while the dialog stayed up, and the answer fired `PostToolUse` for `ask_question` and a `PreInvocation`, which cleared it.

The every-tool entry carries two costs the question-only one did not. A handler that fails before it answers denies whatever tool it fired for, where before only a question could be lost; the bridge writes the reply before it touches the events file, which keeps that window small. With no `node` on PATH every handler would fail that way and the agent could run no tool, so `buildHooks` leaves the entry out on such a machine and logs it. The session then runs with no tool starts or question waits. And every tool call now starts a node process that agy waits on before the tool runs, beside the one PostToolUse already started. The entry stays every-tool because the approval wait below names the newest tool in flight, which only a start for every tool can supply.

Approvals come from the status line, not a hook. PreToolUse fires for every tool, and agy's own policy decides whether a dialog follows, so the hook cannot tell a tool that asks from one that just runs. The status payload's `tool_confirmation_pending` can: see [Live telemetry](#live-telemetry). A distro's agy (WSL) gets no PreToolUse entry at all: its hook transport carries no stdout reply, and an entry without one would deny every tool. It keeps SessionStart, PreInvocation, PostToolUse and Stop.

Two agy quirks shape the wiring. First, agy tokenizes hook commands on whitespace with quote characters kept literal, so no command token may be quoted or contain a space: every path is emitted `.agents`-relative (hooks run with cwd = the directory containing hooks.json) and the event-bridge is copied to `<cwd>/.kangentic/agy-event-bridge.cjs` on each spawn whose copy differs from the app's bridge (`.cjs` so a `"type": "module"` in the user's package.json cannot make node parse the CommonJS bridge as ESM). Second, hooks do NOT fire in `-p` print mode, so activity is `hooks_and_pty`: hook events are primary, and the PTY silence timer plus a `detectIdle` match on the idle footer (`? for shortcuts`; the running footer shows `esc to cancel` instead) cover print-mode spawns and any workspace where hook wiring was skipped.

Session ids are captured two ways: `fromHook` reads `conversationId` (present in every hook payload, camelCase protojson) from SessionStart or PreInvocation, and `fromOutput` matches the graceful-shutdown summary (`agy --conversation=<uuid>`) plus print-mode JSON (`"conversation_id"`). The status line's `conversation_id` is deliberately not a third (see [Live telemetry](#live-telemetry)). There is no `fromFilesystem` capture: `cache/last_conversations.json` is written only at CLI exit, after the spawn-time polling window has closed.

## Live telemetry

agy's custom status line (https://antigravity.google/docs/cli/statusline) pipes a JSON state payload to a command on stdin whenever the agent state changes, at most every 300 ms. The payload carries the model (`id`, `display_name`, `effort`), the context window (`used_percentage`, `context_window_size`, the input and output totals, `current_usage`), `cost.total_usd`, `conversation_id` and `quota`.

Its documented home is the user's global `~/.gemini/antigravity-cli/settings.json`, which every agy session shares, Kangentic's and the user's own alike. So the adapter never writes it there. agy 1.4.12's `--help` lists `--settings`: "Settings for this session only, never saved: a JSON object of settings.json keys, inline or as a file path". The command builder writes the session's `antigravity-settings.json` beside its status file and passes its path:

```json
{ "statusLine": { "type": "command", "command": "node <status-bridge.js> <status.json>", "stack_with_default": true } }
```

- `status-bridge.js` writes the payload to the session's status file whole and prints nothing. `parseStatus` (`status-parser.ts`) maps it to the context bar's model, context, tokens and cost.
- `stack_with_default: true` keeps agy's built-in status line, with the `? for shortcuts` hint `detectIdle` reads.
- On Windows agy runs the command with `cmd /c`, and whether it escapes the command line is not documented, so every token stays bare. A bridge or status path with a space gets no status line rather than a broken one.
- An agy in a WSL distro runs the WSL hook transport's `status` mode (`wslStatusLineCommand`), since the distro may have no node. The `--settings` path is the one the distro sees.
- `quota` buckets with a `remaining_fraction` become rate-limit windows (`reportsRateLimits`), id `antigravity-quota-<bucket>`, used share `1 - remaining_fraction`, reset from `reset_time`. A disabled bucket and one that reports only `remaining_amount` are skipped. The doc gives no bucket's length, so the pill draws no time marker. Main stamps each window with the agent that reported it, so the pill shows agy's quota only on agy sessions and Claude's limits only on Claude's. The pill's "Updated" time is still the shared snapshot's, so an agy report refreshes it on a Claude pill too.
- `parseStatusEvents` raises an approval wait (`idle` / `permission` / `approval`) on the write where `tool_confirmation_pending` turns true, "True while a tool confirmation dialog shows". Only the edge: agy rewrites the file on every state change while the dialog stays up. The engine ends the wait on the tool's own end, the next prompt (a denial lets the model go on), or the turn's end, so nothing is raised when the dialog closes. The payload names no tool, so the wait awaits the newest call in flight. The status file and the events file are read on separate watchers, so a status read that lands after the tool's own end raises a wait with no tool to await; the next tool, prompt or turn end clears it. A read that catches the bridge mid-write is not a state: `parseStatusEvents` answers null and the reader keeps comparing against the last whole write.
- The same reader reports plan mode. `cycle_mode` is `accept-edits`, `auto` or `plan`, omitted in default mode. A write that changes whether it is `plan` raises a log-only `config_change` ("Config changed" in the activity log) carrying `planMode`, which the engine's plan-mode trail records, so a turn-end automation can tell a turn that began after the plan was left. A session launched in plan mode reports it on its first write. The hook payloads carry no mode.

The status line's `conversation_id` is not reported as the session id: main adopts every change of a reported id and the next resume follows it, agy has no SessionStart guard for that, and the doc defines the field as the active conversation, which may follow a subagent view or a `/btw` side question.

**Merge or replace.** The help says `--settings` takes "a JSON object of settings.json keys", not that it is merged over the saved file, and the settings doc does not mention the flag. Had agy replaced the saved settings with a status-line-only file, the session would lose the user's `trustedWorkspaces` (and stop at the folder trust prompt) and their permission rules. So the file also repeats the saved values of `trustedWorkspaces`, `permissions`, `toolPermission`, `enableTerminalSandbox` and `agentMode` (`AGY_SESSION_GUARD_KEYS`), and the session sees them either way. Every spawn path awaits `ensureTrust` before it builds the command, so the copied trust list already names the folder. Nothing else is copied: the file sits in the project's `.kangentic/`, and settings.json can hold a custom model provider's credentials. Replaced, the session would still lose the user's other preferences (theme, model default, notifications), which is cosmetic. A signed-in run should still confirm which it is. A read-only probe for this, `agy -p "/config"` on 1.4.12, ran a billed model turn, despite the changelog's claim that print-mode slash commands answer without one.

Discovery reads `--help` when the agent list loads, so an agy spawned before then (a session resumed at startup) is treated as an older CLI for that session: no status line, and `auto` maps to `--mode accept-edits`. The command builder logs this once per CLI path.

An agy whose `--help` lists no `--settings` gets no status line and has no telemetry channel at all: neither the interactive transcript nor the hook payloads carry usage (verified on 1.1.13). `liveTelemetryUnsupported` ("Telemetry: TUI only") stays as the fallback. The renderer shows it only while no model name is known, so a status-line report hides it. The board model pill is also seeded from a `--model` override via `configuredModelFromCommand`.

## MCP

The Kangentic MCP server is registered as a WORKSPACE PLUGIN at `<cwd>/.agents/plugins/kangentic/` (`plugin.json` marker + `mcp_config.json` with `serverUrl` and a `headers['X-Kangentic-Token']` entry). agy dials `serverUrl` with streamable HTTP (`POST /mcp`) and forwards the headers map, connecting lazily at the first agent turn. A bare workspace `mcp_config.json` (no plugin wrapper) does not load (upstream google-antigravity/antigravity-cli#60). `--settings` cannot carry it per session: it takes settings.json keys, and MCP servers live in `mcp_config.json`. Same plaintext-token trade-off as Gemini: the per-launch token sits on disk during the active session; tokens rotate per app launch and `removeHooks()` deletes the plugin dir once the folder's last session exits or suspends. A spawn with MCP wiring holds the folder even without an events pipeline, so a neighbour's exit never deletes the plugin under it.

The runtime files are also hidden from git for the session's lifetime: the command builder seeds `.git/info/exclude` (the local, never-committed ignore file, resolved through the worktree's `commondir` so one seeding covers every worktree of the repo) with `.agents/plugins/kangentic/`, `.kangentic/`, and - only when Kangentic created the file itself - `.agents/hooks.json`. Ignore rules affect untracked files only, so a user's own tracked `.agents` customizations keep normal git visibility, while the token-bearing plugin can never ride into a commit on a `git add -A`. The marker comment in the exclude file says the lines are safe to remove. This mechanism originated here and now lives in `src/main/agent/shared/git-exclude.ts` (generic `# kangentic:` marker; the legacy antigravity-branded marker is recognized by prefix so already-seeded repos never gain a second marker block), shared by the Gemini, Qwen, Droid, and Grok builders and OpenCode's plugin install - each with its own pattern list and created-by-us carve-outs.

## Trust

agy stores workspace trust as `trustedWorkspaces: string[]` (exact absolute paths) in `~/.gemini/antigravity-cli/settings.json` - NOT Gemini's `trustedFolders.json`, and with no per-entry trust level. Trust is exact-path, not inherited: agy prompts for a task worktree even when the repository root above it is already trusted (observed live), so `ensureTrust` writes one entry per spawn cwd rather than relying on ancestor coverage, and the TUI's workspace trust confirmation never blocks an automated spawn. `onWorktreeRemoved` drops the exact-path entry so the list does not grow one dead entry per task, and `onProjectRelocated` re-keys both the trust entry and the `last_conversations.json` mapping.

## Session History and Transcript

Each conversation writes a parseable JSONL transcript at `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl` (steps: `USER_INPUT` with the prompt wrapped in `<USER_REQUEST>`, `PLANNER_RESPONSE` with `thinking` / `content` / `tool_calls`, `ERROR_MESSAGE`, `CHECKPOINT`). `parseTranscript` maps the newest part of it into `TranscriptEntry[]`, `readTranscriptPage` pages the rest for the Conversation viewer, and `transcriptToolCounts` counts its tool calls. The conversation store itself (`conversations/<uuid>.db`) is SQLite with opaque protobuf step payloads and is not read.

There is no `parseTranscriptWindow`, so the conversation index covers the newest `MAX_PARSE_SOURCE_BYTES` of a long conversation. The indexer resumes a windowed walk from a stored byte offset and chunks each window's entries, which assumes an append-only file. agy writes steps out of order and more than once (last write wins) and rewrites the transcript on compaction (CHANGELOG 1.1.13), so a walk would index a re-emitted step twice and resume into a rewritten file.

`fileChangeTools` names `write_to_file`, `replace_file_content` and `multi_replace_file_content` by `TargetFile`, so the memory index's change corpus finds an agy session's edits. The names are the hooks reference's tool list; `TargetFile` is the argument `write_to_file` carries in the transcript (measured on 1.1.13).

The transcript flushes ON SUBMIT (measured: 84ms worst append latency across short and long turns), which is what qualifies the command-injection verifier - see [command-injection.md](../../architecture/automations/command-injection.md).

## Command Terminal live swap

`getInjectionSequence` sends `/model <slug>` and then `/effort <level>` for the fields that changed, model first so the level lands on a model that has it. `/model <name>` switches by "name, slug or label" (CHANGELOG 1.1.22); `/effort <level>` sets the level directly (https://antigravity.google/docs/cli/commands/effort, CHANGELOG 1.1.5). Both also save the choice as agy's default for later sessions, which a `--model` or `--effort` flag does not. A level the model lacks is refused in the TUI with the levels it supports. Unmeasured: agy shows an argument dropdown while `/model` is typed (CHANGELOG 1.2.4), and whether the submitting Enter takes the typed slug or the highlighted suggestion is not documented.

## Headless runs

- **Auto-name (`summarize`)** runs `agy -p ... --output-format json` through a hidden PTY (`print-runner.ts`), since `agy -p` hangs when stdio is not a TTY (upstream #318). See [Auto-name](auto-name.md).
- **Knowledge Graph answer (`answerFromContext`)** sends the prompt on stdin as one stream-json user message, read-only under `--mode plan`, and streams `text_delta` (`answer-stream.ts`, measured on 1.2.11). No search: the headless run soft-denies any tool that needs a permission it cannot prompt for.
- **Warm answer session (`openAnswerSession`)** keeps that same run open for a chat. The headless doc (https://antigravity.google/docs/cli/headless) says one `--input-format stream-json` process runs a full turn per stdin message, ends each turn with its own `result` event, and keeps one `conversation_id`. Both paths build their flags from `antigravityAnswerArgs`, so they cannot drift. The session's conversation is removed once its process is gone, as the one-shot run's is. Its id is read off every stdout line through the shared session's `onLine`, the `init` event that arrives before any turn included, so a prewarmed session nobody asks leaves nothing behind either.

## WSL

An agy installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts agy's Linux path in a `wsl -d <distro>` shell. Its hooks call the WSL hook transport's script in place of the node bridge, since a distro may have no node: `sh <token> event <type> <directives>` (`wslAgentsHookCommand`). The token is the session's copy of the script, named relative to `.agents/` and space-free, by the same rule the bridge token follows, because agy splits a command on whitespace and keeps quotes literal. The script finds its folder from its own path, and agy passes the payload on stdin, which its `event` mode reads. The hook names one session's script in the folder-shared `hooks.json`, as the node bridge's hook names one session's events path, so the folder's last session decides where its hooks publish, on this machine and in a distro alike. Gemini, Qwen and Grok name a per-folder copy of the script instead. Its status line runs the same script's `status` mode, and its `--settings` file is named by its `/mnt` path. On mirrored networking the MCP plugin keeps the `serverUrl` entry. On NAT networking it names the transport's stdio bridge, `{"command": "sh", "args": [<script>, "mcp", <url>], "env": {"KANGENTIC_MCP_TOKEN": <token>}}`, with the token as plaintext as the header form.

The data root, the trust store, the transcripts and an answer's conversation cleanup are the distro's `~/.gemini/antigravity-cli`. Trust entries are the `/mnt` path, compared with Linux case, and a removed worktree's entry goes from the distro's settings while the distro runs. The title run's hidden PTY starts `wsl.exe` in place of the CLI, with its scratch folder trusted in the distro. `--help`, `agy models` and a Knowledge Graph answer run through `wsl.exe` too. A warm answer session for a distro path whose facts detection has not read yet refuses, and the answer takes a fresh run. Not yet run against an agy installed in a distro, and agy's stdio MCP entry shape comes from its config, not from a run.

## Built from documentation

Built on 2026-11-03 from agy's documentation and its 1.4.12 `--help`. None of these has run against a real agy yet:

| Behavior | Source |
|----------|--------|
| Quota buckets as rate-limit windows, the approval wait from `tool_confirmation_pending`, and plan mode from `cycle_mode` | statusline doc |
| The per-session status line through `--settings`, and `parseStatus` | statusline doc; `agy --help` (1.4.12) for `--settings`, which no changelog entry dates. Whether the file merges over the saved settings is undocumented (see [Live telemetry](#live-telemetry)) |
| `SessionStart` -> `session_start` | hooks reference (no changelog entry dates the event) |
| PreToolUse for every tool -> `tool_start` | hooks reference; the allow reply measured on 1.3.4 for the question tool |
| `--mode auto`, and `dontAsk` -> `--mode plan` | modes doc; CHANGELOG 1.3.5 and 1.4.4; `agy --help` (1.4.12) |
| Effort levels from the `--effort` help line (`xhigh`, `max`) | `agy --help` (1.4.12); `/effort` doc |
| `getInjectionSequence` (`/model`, `/effort`) | `/effort` doc; CHANGELOG 1.1.5 and 1.1.22 |
| `openAnswerSession` | headless doc |
| `fileChangeTools` tool names | hooks reference |

## Limitations

- **No subagent tracking.** `invoke_subagent` starts a subagent that runs in the background (https://antigravity.google/docs/subagents), and no hook reports one finishing.
- **No compaction or session-end hook.** The hooks reference lists neither.
- **No plan exit or plan auto-approval.** agy documents no plan approval tool or hook.
- **No transcript usage.** Neither `transcript.jsonl` nor the hook payloads carry token counts; per-run usage reaches the board only through the status line.
- **Effort levels are the CLI's, not the model's.** The picker offers every level `--effort` lists, `xhigh` and `max` included, and only some models have those. What `--effort max` does at launch on a model without it is not documented.
- No `probeAuth` / `loginCommand`: sign-in is keyring + Google Sign-In completed inside the TUI (works through the PTY); there is no login subcommand and no reliable non-quota probe.
- Slash auto_commands are `verify: 'none'`: the TUI rejects an unregistered `/command` client-side ("Unknown command") and records nothing (`canVerifySlashSubmission` is false).
- Handoff transcript cleanup captures the last turn only (no response marker glyph; same limitation as Gemini).
- **Pasted images are unprobed since 1.4.9.** A 2026-09-18 probe on 1.1.13 inserted a pasted path as text. CHANGELOG 1.4.9 says a dragged image file now attaches, so `pastedImageNativeExtensions` waits on a new probe.
