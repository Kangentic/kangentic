---
type: Reference
title: Goose CLI
description: Block's Goose CLI with goose run -t -s, goose session, -n/-r resume and --model, approval mode set through the GOOSE_MODE env var, a version parser that rejects the pressly/goose migration tool, a hook plugin for activity and turn ends, questions and approvals from its OSC 7501 program status, and transcript, usage and live telemetry read from its SQLite session store, all built from Goose's docs and source.
tags: [agents, adapter, goose]
sources:
  - resource: src/main/agent/adapters/goose/goose-adapter.ts
  - resource: src/main/agent/adapters/goose/detector.ts
  - resource: src/main/agent/adapters/goose/program-status-parser.ts
  - resource: src/main/agent/adapters/goose/hook-manager.ts
  - resource: src/main/agent/adapters/goose/session-store.ts
  - resource: src/main/agent/adapters/goose/transcript-parser.ts
  - resource: src/main/agent/adapters/goose/transcript-cleanup.ts
---
# Goose CLI

Goose is Block's open-source agent CLI (`goose`, https://github.com/aaif-goose/goose). Kangentic starts it with a caller-supplied session name, sets its approval mode through an env var, reads its activity from a hook plugin, and reads its conversation and usage from its SQLite session store.

## Built from documentation

Goose was not installed on the machine this adapter was written on, so nothing below has run against a real Goose. Every behavior comes from Goose's published docs or its source at 1.57.0 (the latest release, 2026-10-28), cited in each section and beside the code. The parts that still need a live Goose to confirm:

- The hook plugin loads from `<cwd>/.agents/plugins/kangentic-goose/` and fires on the events below, in `goose run` as well as `goose session`.
- The session database is where the docs say, the columns read below exist, and a fresh `-n <name>` stores that name.
- The usage poll shows the model, context and cost the TUI shows.
- `--model` works on `goose session` as well as `goose run`.
- The summarize prompt comes back as a clean title.
- The handoff cleaner's banner patterns match a real scrollback.
- The OSC 7501 waits and the exit sequence (both older, also unprobed).

## CLI Detection

Detection uses the shared `AgentDetector` (via composition) with binary name `goose` and `standardUnixFallbackPaths('goose')`. The official installer puts the binary in `~/.local/bin` on macOS/Linux (covered by those fallbacks) and in `%USERPROFILE%\.local\bin` on Windows, where it is added to PATH and found by `which`.

`parseVersion` REQUIRES a digit immediately after the product name (`goose` or `goose-cli`, optional `v`, case-insensitive). This is a collision defense, not cosmetic: two other tools install a binary called `goose` - pressly/goose, a widely used Go database-migration tool (banner `goose version: v3.24.1`), and the awesome-goose scaffolding framework (banner `goose version 0.0.0`). A scan-anywhere `MAJOR.MINOR.PATCH` match accepts both and reports them as Block's agent CLI, after which Kangentic spawns `goose run -t "<prompt>" -s` against a tool that has no such command. Both impostors put the literal word `version` where Block's clap-generated banner puts the digits, which is the discriminator. `AgentDetector` walks every `which` match in order, so rejecting a foreign banner means detection skips that binary and keeps looking rather than stopping on the wrong one. Same anchoring as `GrokDetector`, for the same reason.

The accept side is deliberately wider than one pinned string, because Goose's published docs show the `--version` command everywhere and its stdout nowhere. A false negative surfaces as a diagnosable "not found" with the raw line logged by `AgentDetector`; a false positive spawns the wrong binary.

## Command Building

`src/main/agent/adapters/goose/goose-adapter.ts`

```
goose run [-r] [-n <sessionId>] [--model <id>] -t "<prompt>" -s    # with a prompt
goose run [-r] [-n <sessionId>] [--model <id>] -t "<prompt>"       # nonInteractive spawn_agent action
goose session [-r] [-n <sessionId>] [--model <id>]                 # promptless / resume
```

- Goose runs in the process cwd (there is no start-in-dir flag), so the PTY's cwd set by the spawn chokepoint is authoritative and no directory flag is passed.
- A prompt uses `goose run -t "<prompt>" -s`: process the prompt, then stay interactive (`-s` / `--interactive`) so the user can continue the session. A promptless spawn opens a bare interactive `goose session`.
- A `nonInteractive` spawn_agent action drops `-s`, which is already Goose's headless one-shot form: run the prompt and exit. Leaving `-s` on would park a fire-and-forget automation in a session that never exits.
- `-n <sessionId>` names the session with the engine-generated id when one is present; `-r` is added to resume that named session. On Windows / non-unix shells, embedded double quotes in the prompt are rewritten to single quotes.
- `--model <id>` is passed only when the column names a model, before `-t` so `configuredModelFromCommand` never reads a prompt that mentions the flag. `run` and `session` both take `--model` and `--provider` ([CLI commands guide](https://goose-docs.ai/docs/guides/goose-cli-commands), `crates/goose-cli/src/cli.rs` `ModelOptions`). Without it Goose uses its own `GOOSE_MODEL`.

## Model

Goose has no command that lists the models a provider serves, so `discoverCapabilities` returns a fixed `{ supportsModelOverride: true }` with no list: the Column Manager's Model field is free-form, and the adapter keeps no model list (`cli-features-over-custom-layers.md`). It runs no CLI, which is why `wsl-adapter-headless-runs.test.ts` lists it beside Droid. `configuredModelFromCommand` seeds the card with the `--model` it built, shown as Goose names it, until the session's own row reports the model. Goose has no effort flag, so no effort is offered.

## Session Resume

`supportsCallerSessionId` is `true`. Goose accepts a caller-supplied session name (`--name`), so the engine hands it the id it generated on the fresh spawn and resumes with `-r -n <id>`. A fresh `-n <name>` creates the session with that name, and `-r -n <name>` resumes the first session whose name or id equals it (`crates/goose-cli/src/cli.rs`, `get_or_create_session_id`).

`locateSessionHistoryFile` returns null: Goose keeps every session in one shared database, so there is no file that is this session's alone, and its mtime moves with every other Goose session. The transcript methods below find the session by name instead.

## Permission Modes

Goose sets its approval mode through the `GOOSE_MODE` env var, not a spawn flag, so the permission dropdown is delivered via `buildEnv`. The mapping lives in `GOOSE_MODE_BY_PERMISSION`, a `Record` over the full `PermissionMode` union (so a new mode is a compile error rather than a silent wrong-mode spawn), and it maps all six modes below. The dropdown exposes three, one per distinct Goose mode Kangentic can reach; `dontAsk`, `acceptEdits`, and `auto` are not offered there but are still mapped, so a column/lane override or the global default that forces one of them resolves to a valid `GOOSE_MODE`.

Goose has four modes. `approve` (every action needs approval) is stricter than `smart_approve`, so it sits below `default` on the permissiveness ladder the dropdown is ordered by and nothing maps to it.

| Mode | GOOSE_MODE | Goose Behavior |
|------|-----------|----------------|
| `plan` | `chat` | No tools at all. Not merely read-only: the agent cannot read files either, so a plan-mode Goose session reasons without repo access |
| `dontAsk` | `chat` | No tools (not in the dropdown). Goose has no allowlist, so "deny unless allowed" degrades to "deny" |
| `default` | `smart_approve` | File modifications need approval, reads do not |
| `acceptEdits` | `smart_approve` | Not in the dropdown. See below |
| `auto` | `auto` | Modify/create/delete and run shell commands without approval (not in the dropdown) |
| `bypassPermissions` | `auto` | Same as above. The explicit opt-in to full autonomy |

`acceptEdits` is the mode with no faithful target. Everywhere else in Kangentic it means "auto-approve edits, still gate shell commands", and Goose has no such mode: the only way to stop prompting on edits is `auto`, which also stops prompting on shell. It therefore resolves DOWN to `smart_approve` rather than up to `auto`, and this matters more than it looks: `DEFAULT_CONFIG.agent.permissionMode` is `acceptEdits` and `resolveEffectivePermissionMode` falls through task -> lane -> that global without consulting the adapter's `permissions` list, so whatever `acceptEdits` maps to is the out-of-the-box spawn for every Goose session on a fresh install. Mapping it to `auto` made that a fully unattended agent nobody chose. The practical consequence of resolving down is that a Goose agent on default settings prompts on file writes; choose "Auto (Skip All Approvals)" for unattended board runs.

`defaultPermission` is `default`.

## Hooks and activity

`src/main/agent/adapters/goose/hook-manager.ts`

Goose's hooks are plugins ([hooks guide](https://goose-docs.ai/docs/guides/context-engineering/hooks), [plugins guide](https://goose-docs.ai/docs/guides/context-engineering/plugins)): a folder with `hooks/hooks.json` and an optional `plugin.json`, found at start in `<project>/.agents/plugins/<name>/` or `~/.agents/plugins/<name>/`, with no trust prompt. Each hook gets a JSON payload on stdin carrying `event` and `session_id`, plus `tool_name`, `tool_input`, `tool_call_id`, `message` or `last_assistant_message` where they apply.

On every spawn with an events file, `buildCommand` writes `<cwd>/.agents/plugins/kangentic-goose/` and adds it to `.git/info/exclude`. The folder is not `kangentic`, because Antigravity owns `.agents/plugins/kangentic/` for its MCP plugin and deletes it whole on cleanup. Every Goose session in a folder shares the plugin, so it is held per session (`SharedFolderHolds`) and removed when the folder's last session releases. Each command is `node <event-bridge> env:KANGENTIC_GOOSE_EVENTS_PATH <type> <directives>`, and `buildEnv` sets that variable to the session's events file. A Goose the user runs by hand, or another agent that loads `.agents/plugins/*`, has no such variable, and the bridge writes nothing.

| Goose event | Kangentic event | Read from the payload |
|---|---|---|
| `SessionStart` | `session_start` | the whole payload, as hook context |
| `UserPromptSubmit` | `prompt` | |
| `PreToolUse` | `tool_start` | `tool_name`, `tool_call_id`, and `tool_input`'s `command`, `path` or `source` |
| `PostToolUse`, `PostToolUseFailure` | `tool_end` | `tool_name`, `tool_call_id` |
| `Stop` | `idle` | |
| `SessionEnd` | `session_end` | |

`Stop` fires when Goose "finishes a turn", so the adapter declares `reportsTurnEnd: true`: a Goose column offers On agent turn end automations, and a workflow task's step check runs on it. Activity is `hooksAndPty`, with the PTY silence timer as the fallback. Goose documents SubagentStart and SubagentStop as not emitted and has no compaction or notification event, so none is wired.

**Windows.** Goose runs every hook with `sh -c` and has no Windows branch (`crates/goose/src/hooks/mod.rs`). Its install guide recommends Git Bash, where `sh` is on PATH, but also supports PowerShell, where it usually is not. So when `sh.exe` is on no PATH folder, `buildEnv` appends Git for Windows' `bin` folder (`sh`, `bash` and `git` only) to the end of PATH, under the variable's own spelling (`gooseWindowsHookPath`). It looks in Program Files, Program Files (x86) and `%LOCALAPPDATA%\Programs\Git`, the installer's defaults. Appended last, it changes no command that already resolved. The remaining gap is a Windows machine with no Git for Windows: there the hooks never fire, activity falls back to the PTY silence timer, and the column's turn-end automations never run for that Goose. The other option was to leave PATH alone, which leaves every PowerShell and cmd terminal in that state.

**WSL.** A distro Goose's hooks call the folder's copy of the WSL hook transport's script (`.kangentic/goose-wsl-hook.sh`), as Grok's do, and the events variable is not passed.

### Questions and approvals

No hook marks a wait on the user. From 1.56, Goose's CLI writes a program status escape to the terminal at each change of state, the one place it says it waits on you (GitHub #452). Read from Goose's own source (`crates/goose-cli/src/session/program_status.rs`):

```
ESC ] 7501 ; state=<state>[:kind=permission|question]:app=goose[:msg=<base64>] ESC \
```

`state` is `idle`, `working`, `done`, `error`, `blocked` or `clear`, and `kind` rides only on `blocked`. Goose writes it only when stdout is a terminal and `GOOSE_CLI_PROGRAM_STATUS` is not turned off. `runtime.streamOutput` runs `GooseProgramStatusParser` (`program-status-parser.ts`) over the PTY output, holding a sequence split across chunks, and reports the waits only:

- `blocked` is the permission wait, `kind=question` a question and `kind=permission` an approval. A `blocked` with no kind is left unknown.
- `working` after a wait writes the PTY tracker's own resume event (`prompt`, `PromptReason.PtyActivity`), which clears it.
- `idle`, `done`, `error` or `clear` after a wait writes `interrupted`: it clears the wait and settles idle at once. Never a plain `idle`: the Stop hook reports the turn end, and a second one would run the column's turn-end automations twice, or for a turn the user cut short.

Every other status writes nothing. The question text in `msg` is not read. On Windows, ConPTY passes an OSC 7501 sequence through to node-pty unchanged with either terminator (measured with node-pty 1.2.0-beta.15), though it can move it ahead of printable text written in the same frame.

## Session store

`src/main/agent/adapters/goose/session-store.ts`, `transcript-parser.ts`

Since 1.10.0 Goose keeps every session in one SQLite database ([logs guide](https://goose-docs.ai/docs/guides/logs), "Session Records"): `~/.local/share/goose/sessions/sessions.db` on Linux and macOS and `%APPDATA%\Block\goose\data\sessions\sessions.db` on Windows. `gooseDataDirectory` follows Goose's `Paths` (`crates/goose/src/config/paths.rs`): an absolute `GOOSE_PATH_ROOT` wins (`<root>/data`), then `XDG_DATA_HOME`. A source comment in that file names `~/Library/Application Support/Block/goose/` as a macOS example, but Goose resolves the path with etcetera's `choose_app_strategy`, which uses "the Windows strategy on Windows, and Xdg everywhere else" ([etcetera docs](https://docs.rs/etcetera/latest/etcetera/app_strategy/fn.choose_app_strategy.html)), so macOS gets the logs guide's Unix path.

The schema beyond the guide's `sessions` columns is Goose's source (`crates/goose/src/session/session_manager.rs`, schema version 17, WAL mode), so every read opens the database read-only, selects `*`, and answers empty on a missing table or column. The session is the row whose `name` or `id` equals the name Kangentic passed.

- **Conversation viewer and `get_transcript`.** `parseTranscript` maps the `messages` rows of the session (`content_json` blocks, `crates/goose-provider-types/src/conversation/message.rs`): `text`, `thinking`, `toolRequest` as a tool use, and `toolResponse` (in the next user-role message) as its result. A message whose `metadata_json` says `userVisible: false` (a compaction summary kept for the model) is skipped. Positions are bytes of `content_json` (`octet_length()`, which SQLite answers without reading the text), and `readTranscriptPage` pages the rest by row id, minting the uuids the tail does.
- **Lifetime tokens.** `transcriptUsage` reads the row's `accumulated_input_tokens` and `accumulated_output_tokens`.
- **Tool counts.** `transcriptToolCounts` counts distinct `toolRequest` ids by tool name, and `transcriptToolResultTokens` sizes each response's text at four characters a token. Both count only `[sinceMs, untilMs)` by `created_timestamp` (seconds, or milliseconds above 1e10), so the adapter declares `scopesTranscriptReadsByTime`. A response in the window is named by its request wherever that request sits, so a call made just before the window still has its result tokens counted.
- **Live telemetry.** `attachSession` reads the session's row every 3 seconds while it lives, and skips the read while the database and its WAL are unchanged. The read runs on main: one read-only row of Goose's own database, not a transcript parse or Kangentic's index, which stay in the retrieval worker. It reports the model (`model_config_json.model_name`), context used (`total_tokens`) against `context_limit` (size 0, the unknown sentinel, when the config names none), lifetime tokens and `accumulated_cost`. That is what Goose's own context bar draws. No `liveTelemetryUnsupported` is declared.
- **Changed files.** `fileChangeTools` names `write` and `edit` by `path`, from the hooks guide's tool input table.

A distro Goose keeps its database in the distro, which is not opened from Windows (a WAL database over the distro's file share is not safe to read), so its conversation, usage and telemetry read as none.

## Auto-name and Knowledge Graph

`answerFromContext` runs `goose run -i - --no-session -q` with the prompt on stdin, `GOOSE_MODE=chat` (no tools, no extensions) and `--model` when one is chosen. `summarize` runs the title prompt through that same run and cleans the reply with `titleFromAnswer`, as Gemini and OpenCode do.

## Pasted images

A pasted image is named in an instruction (`pastedImageReferenceTemplate`, `Read this image: {path} `), which Goose's `read_image` tool can open by path. Whether a bare path in a paste attaches the image on its own (`pastedImageNativeExtensions`) needs a live probe.

## Handoff

`cleanGooseTranscript` (`transcript-cleanup.ts`) drops the startup banner (`  __( O)>  <status> · <provider> · <model>`, ` \____)    <id> · <cwd>`, `   L L     goose is ready`) and the context bar after a turn (`━━╌╌ 9% 12k/128k`), from `crates/goose-cli/src/session/output.rs`. Goose draws inline with no prompt glyph, so the whole conversation is kept rather than the last turn.

## WSL

A Goose installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`): the session starts in a `wsl -d <distro>` shell with Goose's Linux path, `GOOSE_MODE` crosses into the distro through `WSLENV` with the adapter's other variables, the hooks publish through the WSL hook transport, and a Knowledge Graph answer runs through `wsl.exe` too. The distro's session database is not read (see above).

## Limitations

- No Kangentic MCP server. `--with-streamable-http-extension` takes a URL and an optional timeout but no headers (`crates/goose-cli/src/cli.rs`, `parse_streamable_http_extension`), and Kangentic's server needs the token in the `X-Kangentic-Token` header. Plugins carry no MCP servers (plugins guide), and `~/.config/goose/config.yaml` is global to every Goose run, so neither is a per-session route. The route left is a native stdio relay for `--with-extension`, with the token in the environment. That relay lives in `src/main/agent/shared/kangentic-mcp-server.ts` and the external-scripts list, outside this adapter, and it rests on Goose passing its environment to a stdio extension, which its docs do not say.
- No subagent usage. Goose's source gives a child session a `parent_session_id` and keeps a per-call `usage_ledger`, but neither is in its published docs, and nothing names the tool call that spawned a child, so a `parseSubagentUsage` would write ledger rows it cannot attribute.
- No command-injection verifier yet. User turns are `messages` rows, but a verifier waits on a measurement of when the row lands after a submit.
- No trust mechanism (Goose has no folder-trust gate).
- No plan exit. `plan` maps to Goose `chat`, which has no file access at all, so a plan-mode Goose session cannot read the repo it is planning against, and Goose's `/plan` reports no plan exit.
- No live model or effort swap in the Command Terminal: Goose has no in-session model command.
- No background commands: Goose's `shell` tool returns when the command ends (see [Background commands](background-commands.md#background-commands)).
