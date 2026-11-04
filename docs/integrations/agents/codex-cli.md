---
type: Reference
title: Codex CLI
description: Why Codex's MCP, hook and effort overrides go in as quote-free -c flags, how hook trust and the model list come from Codex's own app-server, how per-worktree trust entries are added to and removed from config.toml, how permission modes map to sandbox and approval flags, what the rollout feeds the per-task stats, and which Claude parity gaps wait on a live probe.
tags: [agents, adapter, codex]
sources:
  - resource: src/main/agent/adapters/codex/codex-adapter.ts
  - resource: src/main/agent/adapters/codex/detector.ts
  - resource: src/main/agent/adapters/codex/command-builder.ts
  - resource: src/main/agent/adapters/codex/hook-manager.ts
  - resource: src/main/agent/adapters/codex/hook-trust.ts
  - resource: src/main/agent/adapters/codex/trust-manager.ts
  - resource: src/main/agent/adapters/codex/config-toml.ts
  - resource: src/main/agent/adapters/codex/session-history-parser.ts
  - resource: src/main/agent/adapters/codex/model-catalog.ts
  - resource: src/main/agent/adapters/codex/app-server-rpc.ts
  - resource: src/main/agent/adapters/codex/capability-discovery.ts
  - resource: src/main/agent/shared/tool-call-cursor.ts
  - resource: src/main/agent/adapters/codex/transcript-usage.ts
  - resource: src/main/agent/adapters/codex/transcript-parser.ts
---
# Codex CLI

## CLI Detection

`src/main/agent/adapters/codex/detector.ts`

Detection follows the same pattern as Claude: check `config.agent.cliPaths.codex`, fall back to `PATH` search via `which`, run `codex --version`.

## Command Building

`src/main/agent/adapters/codex/command-builder.ts`

### New Session

```
codex -C <cwd> --sandbox <level> --ask-for-approval <level> [--model <m>] \
  [-c model_reasoning_effort=<level>] \
  -c mcp_servers.kangentic.url=<url> \
  -c mcp_servers.kangentic.env_http_headers.X-Kangentic-Token=KANGENTIC_MCP_TOKEN \
  [-c shell_environment_policy.set.KANGENTIC_TASK_ID=<taskId>] \
  -c check_for_update_on_startup=false \
  [-c hooks.<Event>=[...] for seven events, -c hooks.state={...}] \
  "prompt text"
```

### Resumed Session

```
codex resume <sessionId> -C <cwd> --sandbox <level> --ask-for-approval <level> [--model <m>] \
  [-c <the same effort override>] \
  -c <the same two MCP overrides> \
  [-c <the same task tag override>] \
  -c check_for_update_on_startup=false \
  [-c <the same hook and trust overrides>] \
  ["prompt text"]
```

`codex resume --help` lists `[PROMPT]`, "Optional user prompt to start the session", so a resume's message (a column's message, a plan continuation, held messages) rides it as the positional argument, as on a new session (`resumePromptDelivery: 'command-line'`). The builder used to drop it, and a column's message never reached a resumed Codex session. See [How the resume prompt arrives](../../architecture/sessions/resume.md#how-the-resume-prompt-arrives).

The hook overrides appear only when Codex confirmed their trust for this binary (see [Hook Integration](#hook-integration)).

`check_for_update_on_startup=false` keeps Codex's "Update available" prompt out of a Kangentic session. It is a modal at TUI startup whose first option is "Update now", so an `auto_command` typed into a session showing it, or any Enter meant for the agent, updates Codex and ends the session (a probe's Enter did exactly that, 0.154.0 to 0.163.0, in task #859). The key is Codex's own (`config_toml.rs`), it applies to that process only, and the user's own terminal still offers updates.

The task tag override is added for every session, a Command Terminal included (it carries its own made-up task id, so its leftovers are reaped when it ends). Codex passes its environment to tool shells through `shell_environment_policy`, which a user can narrow (`inherit = "core"`), and that strips `KANGENTIC_TASK_ID`, the tag a terminal transition finds a task's leftover processes by (see [Process reaping](../../architecture/worktrees/process-reaping.md)). A `set` entry always wins over the inherit and filter steps, and it adds to the user's own `set` table rather than replacing it (measured on codex-cli 0.154.0).

Resume is a subcommand in Codex (not a flag like Claude). Both forms emit the same flags: `codex resume` accepts `-c`, `-s/--sandbox`, `-a/--ask-for-approval`, `-m/--model`, `-C/--cd`, and `--disable`. The resume branch used to return early after `-C`, so a resumed session silently lost its permission mode, model override, and MCP wiring.

### Non-interactive session

A legacy Start agent row with `nonInteractive` set runs `codex exec`, "Run Codex non-interactively" in `codex --help` (codex-cli 0.163.0). The builder used to pass `-q --json`, which came from the retired TypeScript CLI; 0.163.0's `codex --help` lists neither.

```
codex exec -C <cwd> --sandbox <level> [--model <m>] [-c ...the same overrides] ["prompt text"]
codex exec resume <sessionId> -c sandbox_mode=<level> [--model <m>] [-c ...the same overrides] ["prompt text"]
```

`codex exec --help` lists no `-a/--ask-for-approval` (`exec` never asks), so the permission mode becomes the sandbox alone: `read-only` for `plan` and `dontAsk`, `workspace-write` otherwise, and the bypass flag for `bypassPermissions`. `codex exec resume --help` lists neither `-C` nor `-s`, so a resume takes its sandbox as `-c sandbox_mode=<level>` (the key `--sandbox` sets, per https://learn.chatgpt.com/docs/config-file/config-reference) and its working folder from the PTY's. Built from the help text; not yet run against a signed-in Codex.

### The shared app-server daemon

Since 0.157 an interactive `codex` runs its thread inside a shared app-server daemon by default (`daemon_auto_start`, stable and on in `codex features list`; release notes for 0.154.0, 0.156.0 and 0.157.0). That daemon keeps the environment it started with ("per-client environment isolation is not provided", `codex-rs/app-server-daemon/README.md`), which would put every session's hooks on the first session's `KANGENTIC_EVENTS_PATH`, its tool shells on the first task's `KANGENTIC_TASK_ID`, and its MCP calls on the first session's token. Kangentic never reaches it: any `-c` override other than a feature boolean makes the TUI run its own embedded app-server ("Running without the shared background server: ... requires embedded mode", `config_exclusion` in `codex-rs/tui/src/daemon_startup.rs` at rust-v0.163.0), and every form above carries `-c check_for_update_on_startup=false`. `codex-adapter.test.ts` pins that every form keeps one, so do not drop it as tidying. Passing `--no-daemon` instead was not chosen: the flag arrived in 0.156.0, and an older Codex exits on it.

## MCP Wiring

Codex reads MCP servers from the `mcp_servers.<name>` table in `~/.codex/config.toml`. Kangentic applies the same keys with `-c` for that invocation only, so the user's config file is never written. `env_http_headers` maps a header name to the NAME of an environment variable that Codex resolves at MCP-connect time, so the token travels via `CodexAdapter.buildEnv` as `KANGENTIC_MCP_TOKEN` and never appears in argv (argv is echoed into terminal scrollback the user can read).

**The `-c` payloads deliberately contain no quotes, braces, or whitespace.** `quoteArg` cannot deliver an embedded double quote on Windows: it writes one as `'` (see `escapeForDoubleQuotedShell` in [Shells and paths](../../platforms/shells-and-paths.md#path-handling)), so the natural TOML inline-table form cannot arrive as written. A `\"` escape breaks it under PowerShell with `error: unexpected argument 'http://...\' found`. Two properties make the quote-free form work: a bare URL fails TOML parsing and is taken as a literal string, and TOML bare keys permit `-`, so the header name works as a dotted key segment. Verified against codex-cli 0.141.0 on PowerShell, cmd, and Git Bash. Do not "tidy" these into quoted TOML.

## Directory Trust

Codex prompts "Do you trust the contents of this directory?" before it will load project-local config, hooks, or exec policies. Kangentic pre-approves the spawn directory in `~/.codex/config.toml` (`src/main/agent/adapters/codex/trust-manager.ts`):

```toml
[projects.'C:\Users\dev\proj\.kangentic\worktrees\7']
trust_level = "trusted"
```

Measured against codex-cli 0.141.0, this cannot be left to the user answering once. Trust is keyed on the **git repo root** and is **not inherited** by nested repositories, and every Kangentic task gets its own worktree, which is its own repo root. Accepting the prompt therefore records only that one worktree and the next task prompts again: there is no answer the user can give that carries forward. The per-invocation `-c` override does not help either, because trust is resolved before config overrides are applied.

The pre-approval never overrules the user. An explicit `trust_level` already recorded for the directory is left as-is (so a deliberate `"untrusted"` survives), and a project root marked `"untrusted"` suppresses approval for the worktrees beneath it.

Path comparison is shared with the relocation migration (`config-toml.ts`), because Codex stores these keys in several interchangeable spellings (single vs double quotes, forward vs back slashes, and an optional `\\?\` long-path prefix) and a missed match would append a duplicate table, which makes `config.toml` unparsable for Codex itself.

The entry is also **removed** when Kangentic deletes the worktree, via the adapter contract's `onWorktreeRemoved` hook (`removeWorktreeTrust`). Without that, a per-directory key that can never be inherited accumulates one dead table per task forever: one developer machine had reached 473 entries before this landed. Only the table Kangentic writes is dropped, a sole `trust_level = "trusted"`, so a deliberate `"untrusted"` and anything the user or a future Codex added to the table survive. `$CODEX_HOME` is honored on both the write and the removal, so Kangentic always targets the file Codex will actually read. For a project whose Codex runs from a WSL distro, the removal also drops the table in the distro's `config.toml`, keyed by the `/mnt` path, while the distro runs.

## Launch Options

Codex declares one `AgentLaunchOptionInfo` (see [Agent Adapter Interface - Optional Properties](optional-properties.md)): `disableApps`, off by default. When enabled, `--disable apps` is appended to both the new-session and `resume` command forms, skipping Codex's optional cloud ChatGPT Apps MCP connector (`apps` feature, stable and on by default per `codex features list`), which can hang the whole session at `Booting MCP server: codex_apps` (openai/codex#20167, #19284, #16550). The flag is per-invocation only - it never touches the user's `~/.codex/config.toml`. Configured via the Agent settings tab's Launch Options row, stored at `agent.launchOptions.codex.disableApps`.

## Models and reasoning effort

Codex has no effort flag. `model_reasoning_effort` is a config key ("Reasoning effort advertised by the selected model, such as `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`", https://learn.chatgpt.com/docs/config-file/config-reference), and `-c` sets it for one process on `codex`, `codex resume` and `codex exec` (each one's `--help`, codex-cli 0.163.0). A column's effort goes in as `-c model_reasoning_effort=<level>` on both session forms, and the title and Knowledge Graph answer runs pass their effort the same way (`answerCapabilities.effort`, `low` by default). The schema takes any non-empty string (`ReasoningEffort` in `codex-rs/core/config.schema.json`), so Codex judges the level against the model. A level that is not one bare token is dropped, under the same quoting contract as the MCP overrides.

A session spawn passes the level only when Codex's own `model/list` (below) advertises it for the chosen model, or for any listed model's levels when none is chosen or the chosen model (typed in by hand) is not in the list, and passes none without that list. Codex ignored the effort before, and nothing upstream checks a spawn's effort (`resolveSpawnOverrides`): a column whose agent changed to Codex keeps the effort set for Claude, and an MCP override is accepted unchecked for an agent that listed no levels. Without the gate such a value would start failing every turn. `ensureTrust` waits for the list read beside the hook trust read, both bounded at 8 s, so the first spawn after detection sees it. The title and answer runs need no gate, because their callers pass only a level discovery reported.

The levels and the model list come from Codex itself (`model-catalog.ts`). The adapter runs `codex app-server` and asks `model/list` (`initialize`, `initialized`, then `model/list { includeHidden: false }`, following `nextCursor`), per `ModelListParams` and `Model` in `codex-rs/app-server-protocol/src/protocol/v2/model.rs` at rust-v0.163.0:

- `models` are the listed `model` ids in Codex's order, then any other model a rollout's `turn_context` names.
- `modelDisplayNames` are each entry's `displayName`, which also name the card's model before the rollout does (`configuredModelFromCommand`, read from the flag region before `check_for_update_on_startup=false`, so a prompt holding `--model` is never misread) and a model learned from telemetry (`modelDisplayName`).
- `effortLevels` are every `supportedReasoningEfforts[].reasoningEffort`, deduplicated in first-seen order.

The list "depends on the client and account" (https://learn.chatgpt.com/docs/app-server), so this read runs on the user's real `CODEX_HOME`, unlike the hook trust read's scratch home, and it may reach the network. `detect` starts it, beside the trust read. It is bounded at 20 s, cached per binary for 12 h (a failed read is tried again after 5 minutes, and keeps the last good list), and a forced refresh (a model dropdown opening) reads again once the last read is a minute old. Discovery waits at most 8 s for it, so a cold app-server never holds the agent list, and without an answer it reports today's result: the rollout models and no effort levels, which hides the Effort row. The whole discovery answer is kept per binary, since the answer and condition runs ask on every run: for 12 h when it was built from a list, and for 5 minutes when the read settled with none (a Codex whose app-server fails or has no `model/list`). An answer built while a read was still running is not kept, even when that read lands before discovery returns. A forced refresh or a detection reset asks again. The hook trust read and this one share one JSON-RPC framing (`app-server-rpc.ts`). A Codex in a WSL distro is asked in the distro, on the distro's own home. The E2E mock Codex exits at once on `app-server`, so both reads fail fast there.

Live model and effort changes still need a respawn. Codex's `/model` only opens a picker (it is not in `supports_inline_args` in `codex-rs/tui/src/slash_command.rs`), and no slash command sets effort, so `getInjectionSequence` returns `[]`.

## Permission Modes

| Mode | Flags | Codex Preset |
|------|-------|--------------|
| `plan` | `--sandbox read-only --ask-for-approval on-request` | Safe Read-Only Browsing |
| `dontAsk` | `--sandbox read-only --ask-for-approval never` | Read-Only Non-Interactive (CI) |
| `default` | `--sandbox workspace-write --ask-for-approval on-request` | Automatically Edit, Ask When Needed |
| `acceptEdits` | `--sandbox workspace-write --ask-for-approval never` | Auto (Preset) |
| `auto` | `--sandbox workspace-write --ask-for-approval on-request` | Not exposed in the settings dropdown |
| `bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` | Dangerous Full Access |

`default` and `auto` launch alike: Codex 0.154.0 accepts only `on-request` and `never` for
`--ask-for-approval` and exits on `untrusted`, which `default` passed before.

The Codex Preset column is the adapter's `AgentPermissionEntry.label`, which is what the Agent
settings dropdown shows. Codex declares five entries, so `auto` has no preset of its own. It still
maps to flags, because a column or agent override can set the mode without going through that
dropdown.

## Hook Integration

Kangentic registers its hooks as `-c hooks.<Event>=[...]` overrides in Codex's session-flags layer (task #859, measured on codex-cli 0.154.0 and 0.163.0). Nothing is written to `~/.codex` or the repo beyond the bridge's workspace copy, and the user's own hooks load beside these. Seven events: SessionStart (`session_id` for `fromHook`), UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest (a permission idle; its payload has no `tool_use_id`, so the engine awaits the tool PreToolUse opened), Stop and PreCompact. Each command is `node .kangentic/codex-event-bridge.cjs env:KANGENTIC_EVENTS_PATH <type> <directives>`, bare tokens inside a TOML literal string: the hook runs in the session's working directory and inherits `KANGENTIC_EVENTS_PATH`, and the relative copy is the one path that never needs quotes. The overrides hold no `"` at all, the same quoting contract as the MCP overrides above, and `codex-hook-overrides.test.ts` types them at PowerShell 5.1 and 7, cmd and Git Bash and reads back what arrived.

**Questions and approvals (GitHub #452).** Every PermissionRequest is an approval wait (`setWaitKind('approval')`). Codex raises none for its question tool, `request_user_input` (on in Plan mode by default): the question shows once the tool starts and is answered when it ends. So the single PreToolUse entry carries `appendPermissionWaitForTool({ toolPath: ['tool_name'], tool: 'request_user_input', waitKind: 'question' })`, and one bridge process writes the `tool_start` and then the question wait. Codex runs one event's hook entries concurrently, so a second entry for the wait could land before the start, whose depth-0 clear would end it at once. The engine records `request_user_input` as the awaited tool, and its PostToolUse ends the wait. This is from Codex's source and the design research, not a live capture: a run that showed `request_user_input` firing no PostToolUse would leave the bubble up until the next tool event. No live capture of `request_user_input` exists yet; it needs a signed-in Codex. Adding the directive changed the PreToolUse and PermissionRequest commands, so `tests/fixtures/codex-hooks/codex-0.163.0-hooks-list.json` was captured again from codex-cli 0.163.0's own `hooks/list` for the new commands, with no warnings; the five unchanged hooks kept their hashes.

**Trust comes from Codex itself.** Codex runs a session-flags hook only when `hooks.state` holds the hash it computes for it, and its TUI opens a blocking "Hooks need review" dialog for any hook without one (exec mode skips the hook silently). Kangentic does not compute that hash. `CodexHookTrustCheck` (`codex/hook-trust.ts`) runs the binary's own `codex app-server` once, with a scratch `CODEX_HOME`, asks `hooks/list` for the key and `currentHash` of the exact overrides, and passes them as one `-c hooks.state={...}` override, which Codex merges with the user's own `[hooks.state]` (their trusted hooks stay trusted, measured). The read starts in `detect`, `ensureTrust` waits for it for up to 8 s, and the answer is cached per binary file (path, size and modification time), so an in-place update reads again. A read that fails, times out, reports an error or warning, or leaves a hook out wires no hooks: the session runs on the PTY tracker as before. One read covers every session, because the overrides do not vary by session. An npm `.cmd` shim is the gap: an update replaces the package behind it, not the shim, so the cache key does not change.

What no hook reports comes from the rollout (`codex/session-history-parser.ts`): a command still running at its yield (`Process running with session ID N`, which fires PreToolUse but no PostToolUse) is a background start keyed by its call id, a `write_stdin` poll that finds it exited ends it, `turn_aborted` (an Esc interrupt, no hook) is an Interrupted event, and a `task_complete` that carries an `error` (a failed model request, no Stop) is a TurnFailed event. The rollout no longer forces activity or reports tool starts, and `sessionHistory.suppressesPtyFallback: false` keeps its reads from turning the PTY tracker off, so a session whose hooks Codex did not confirm keeps that tracker.

The rollout also carries the live usage. `turn_context` names the model and the turn's `effort`, reported as the agent's own (`reportedByAgent`). Codex 0.163 writes a `token_usage_record` per model response (`codex-rs/history/src/rollout_payload.rs`), whose `usage` is that response's request size, read as the context in use the same way an older rollout's `token_count.last_token_usage` is; a record whose `thread_id` is not its `session_id` belongs to another thread and is skipped.

The legacy project-local `.codex/hooks.json` from builds before Codex 0.128 is still swept of Kangentic-owned entries by `buildHooks`.

## Per-task stats and the transcript

The rollout feeds the per-task stats as Claude's transcript does (`transcript-usage.ts`, read whole and streamed in the retrieval worker, the rollout found by id with `findCodexTranscriptFile`):

- `transcriptUsage` sums each `token_usage_record.usage` once per `response_id`, for the rollout's own thread (its `session_meta.payload.id`). A rollout with no such records takes the last `token_count.info.total_token_usage`: local 0.141.0 rollouts hold none, and 0.154.0 rollouts do. A rollout an older Codex started and a newer one resumed has both, so the sum starts from the last total written before its first record, which holds none of the summed responses because a response's record comes before its `token_count`. Codex's `input_tokens` already includes cached input, the same total Claude's reader sums from its three input buckets.
- `transcriptToolCounts` counts distinct `call_id`s over `function_call`, `custom_tool_call` and `local_shell_call` lines. Each is named as Codex's hooks name it, so a rollout count and the live count land on one row: `exec_command` and the local shell are `Bash` (`HookToolName::bash()` in `codex-rs/core/src/tools/handlers/unified_exec.rs`), `apply_patch` and `spawn_agent` keep their names (`hook_names.rs`), and an MCP call is `mcp__<namespace>__<name>` (`ensure_mcp_prefix(join_tool_name(..))` in `handlers/mcp.rs`). `write_stdin` polls are left out, because no hook reports them.
- `transcriptToolResultTokens` estimates each output's text at chars/4 under its call's name, from a per-path cursor that reads only the bytes appended since the last call. It reads in 4 MB chunks through the line reader Claude's and Qwen's cursors use (`forEachCompleteLine` in `shared/tool-call-cursor.ts`), one read per path at a time, so two overlapping popover refetches never count an output twice. An output's image items are not estimated.
- `scopesTranscriptReadsByTime` is true: a resume appends to the same rollout (`open_rollout_for_append` in `codex-rs/rollout/src/recorder.rs`), and every line carries a `timestamp` (`RolloutLine` in `codex-rs/history/src/lib.rs`), so both reads keep to one run's `[sinceMs, untilMs)`.

The transcript parser (`get_transcript`, the Conversation viewer) maps `custom_tool_call` to a `tool_use` and `custom_tool_call_output` to a `tool_result`. An `apply_patch` input that names a file becomes `{ file_path, patch }` (see `fileChangeTools` below); a patch that names none, and any other freeform input, keeps its raw text. Every `apply_patch` is one ("This is a FREEFORM tool, so do not wrap the patch in JSON", `codex-rs/core/src/tools/handlers/apply_patch_spec.rs`), so before this every edit Codex made was missing from the viewer. `local_shell_call` and `web_search_call` become `tool_use` entries carrying their `action`, and an output given as content items reads as its text items joined by newlines.

Codex's rollout, transcript and model-history readers resolve Codex's home through `codexHomeDir` (`config-toml.ts`), so `$CODEX_HOME` is honored there too; with `~/.codex` hard-coded, a user with `CODEX_HOME` set got no rollout telemetry at all.

## WSL

A Codex installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts Codex's Linux path in a `wsl -d <distro>` shell, and `-C` names the working directory as the distro sees it (`/mnt/c/...`). The hooks run a workspace copy of the WSL hook transport's script, `sh .kangentic/codex-wsl-hook.sh event <type> <directives>` (`copyWslHookScriptInto`), for the same seven events with the same directives, since a distro may have no node. The copy finds the session's own folder through `KANGENTIC_WSL_HOOK_DIR`, so the command is the same for every session and one trust read still covers them. That read runs `codex app-server` in the distro with a scratch `CODEX_HOME` and folder named by their `/mnt` paths. It is keyed by the detected version, because the binary cannot be stat'ed through the share. Codex's hooks only report events, so the transport's `reply` and `status` modes go unused.

On mirrored networking the MCP overrides are the URL ones above. On NAT networking the distro cannot reach this machine's loopback, so they are the transport's stdio bridge, three `-c` values in TOML literal strings: `mcp_servers.kangentic.command='sh'`, `mcp_servers.kangentic.args=['<script>','mcp','<url>']` and `mcp_servers.kangentic.env_vars=['KANGENTIC_MCP_TOKEN']`. The script is the session folder's own `wsl-hooks/wsl-hook.sh`. `env_vars` forwards the token from the session environment, which reaches the distro through `WSLENV`, so it stays out of argv. A script path or URL holding a quote, `%`, a backtick or `$` gets no bridge, and the session runs without Kangentic's tools.

Codex's home for a distro is the `CODEX_HOME` its interactive shell sets, mapped through the share (`hostPathForTarget`), else the distro home's `.codex` (`codexHomeDir`). This machine's `CODEX_HOME` does not apply. Trust goes into that home's `config.toml`, keyed by the `/mnt` path, and a project root's `"untrusted"` is looked up by its `/mnt` path too. The key comparison folds case, as every comparison does on Windows (`normalizeForCompare`). When Kangentic deletes the worktree, `removeWorktreeTrust(path, place)` drops that table while the distro runs (see [Directory Trust](#directory-trust)).

The session id comes from the SessionStart hook, the startup banner, or a scan of the distro's `sessions/<YYYY>/<MM>/<DD>/` folders for today and yesterday (UTC), which matches a rollout's `session_meta.cwd` against the `/mnt` form of the cwd. The rollout is found by id in the same folders and tailed over the share. The transcript, the auto_command check and the model scan read the same home. `--help`, a title summary and a Knowledge Graph answer run through `wsl.exe`. Not yet run against a Codex installed in a distro.

## Claude Code parity

Each gap against the Claude adapter was checked against Codex's own documentation and source for codex-cli 0.163.0 (the release the installed binary reports, tag `rust-v0.163.0`). Codex could not be run signed in, so nothing here was checked against a live session.

**Built from documentation, not yet run against a signed-in Codex:**

- The effort override on both session forms, and on the title and answer runs.
- The `model/list` read for a signed-in account. A logged-out codex-cli 0.163.0 answered with its whole list, and `tests/fixtures/codex-app-server-model-list.json` replays that answer.
- `configuredModelFromCommand` and `modelDisplayName`.
- Live effort, `reportedByAgent`, and `token_usage_record` in the live usage.
- `transcriptUsage`, `transcriptToolCounts`, `transcriptToolResultTokens` and `scopesTranscriptReadsByTime`.
- The `custom_tool_call`, `local_shell_call` and `web_search_call` entries in the transcript.
- `fileChangeTools` for `apply_patch`.
- The `codex exec` non-interactive form.

`tests/fixtures/codex-0.163.0-rollout-shape.jsonl` is replayed through the usage, tool count, transcript and live readers. Every value in it is invented, so it pins the record shape, not what a real turn writes. Its keys come from local rollouts: `session_meta`, `turn_context`, `token_usage_record`, `function_call` and `token_count` from codex-cli 0.163.0. No local 0.163.0 rollout holds a `custom_tool_call` or a `web_search_call`, so those keys come from 0.141.0 rollouts, and `models.rs` at rust-v0.163.0 still lists the fields the readers use. `local_shell_call` is not in the fixture: none of the local rollouts holds one, so it stays shaped from `models.rs` alone. A capture from a signed-in turn can replace the fixture.

**Supported by the docs, waiting on a live probe:**

- **`proveConversationGone`.** `codex resume` of a missing id exits with "No saved session found with ID" (`tui/src/lib.rs`), so a deleted rollout could start fresh from a recap as Claude's does. But Codex documents no retention sweep, and the part the 0.158+ SQLite thread index (`thread_history_1.sqlite`) plays in a resume is not settled.
- **Hook events `SubagentStart`, `SubagentStop`, `PostCompact`, `SessionEnd` and `Interrupt`** (`codex-rs/hooks/src/schema.rs`). The trust read is all-or-nothing, so an event a user's Codex does not know would turn every hook off. The `hooks-list` fixture has to be captured again from the real CLI. The same probe should show whether a denied approval fires any hook that ends its wait.
- **`pastedImageNativeExtensions`:** png, jpg, jpeg, gif and webp, attached by content (`paste_input.rs`, `chat_composer.rs`).
- **The exit sequence.** One Ctrl+C only shows "press again to quit" (`footer.rs`), while `/quit`, `/exit` and a second Ctrl+C exit. The pty-teardown rule asks for the dialog probe before a sequence changes.
- **`describeStartupFailure`** for "No saved session found with ID". A recognizer needs wording seen on a real card.
- **Subagent transcripts and usage.** A child is its own thread (`SubAgentSource.thread_spawn.parent_thread_id` in `protocol.rs`); where its rollout lives is implied, not stated, and no local rollout holds a spawn.
- **The answer run's streaming, search and usage** (`codex exec --json` `turn.completed`, `exec_events.rs`), and a warm `openAnswerSession` over app-server.
- **`supportsReadOnlyLaunch` and `supportsReadableDirectories`.** The read-only sandbox reads the whole disk (`has_full_disk_read_access`).
- **`consoleCloseIsGraceful`, `hungTurn` and a paste verifier.** Codex documents none of these.
- **Checks on the builds above:**
  - that `model/list` answers for a signed-in account;
  - that `codex exec resume` honors `sandbox_mode`, and takes the PTY's folder as its working folder under WSL;
  - that a resumed session's `token_usage_record` lines carry a `session_id` equal to their `thread_id`. If not, the live filter skips every record and the context bar stops moving.

**Not supported by the CLI:**

- **Live model or effort injection.** `/model` opens a picker and takes no argument.
- **A plan-mode launch, plan exit and plan auto-approval.** No flag or config key starts Plan mode; only `/plan` does (`config.schema.json` has `plan_mode_reasoning_effort` and no mode key). The `plan` permission mode stays a read-only sandbox.
- **Cost telemetry.** The rollout has no USD figure.

**Supported, not built, by decision:**

- **Rate-limit windows.** `token_count.rate_limits` carries them. But the renderer keeps one rate-limit snapshot for every agent (`latestRateLimits` in `session-store.ts`), so Codex windows would also show on Claude's pill. Parsing them in the adapter alone would do exactly that, so nothing reads them. Showing them needs a per-agent snapshot in shared renderer code.
- **`parseTranscriptWindow`.** The format supports it, but the measured rollouts are at most 0.3 MB against the 16 MB tail cap, so the tail already indexes whole conversations.

`fileChangeTools` is built inside the adapter, with no contract change. `apply_patch` input is patch text with no path field, so the transcript parser records each call's input as `{ file_path, patch }`. Its `file_path` is the first file the patch's `*** Add File:`, `*** Update File:`, `*** Delete File:` or `*** Move to:` headers name (`codex-rs/core/assets/tools/apply_patch.lark` at rust-v0.163.0). It leads the JSON, because the chunker cuts each tool input at 200 characters. A patch touching several files is recorded under its first, and the Conversation viewer shows the patch inside that object.

## Limitations

- No cost data: the rollout carries tokens, not dollars.
- No merged settings file mechanism.
- No live `/model` or effort injection: changing either requires a respawn (`getInjectionSequence` returns `[]`).
