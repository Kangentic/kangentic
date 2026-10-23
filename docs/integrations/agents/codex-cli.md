---
type: Reference
title: Codex CLI
description: Why Codex's MCP and hook overrides go in as quote-free -c flags, how hook trust comes from Codex's own app-server hash, how per-worktree trust entries are added to and removed from config.toml, and how permission modes map to sandbox and approval flags.
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
  -c <the same two MCP overrides> \
  [-c <the same task tag override>] \
  -c check_for_update_on_startup=false \
  [-c <the same hook and trust overrides>]
```

The hook overrides appear only when Codex confirmed their trust for this binary (see [Hook Integration](#hook-integration)).

`check_for_update_on_startup=false` keeps Codex's "Update available" prompt out of a Kangentic session. It is a modal at TUI startup whose first option is "Update now", so an `auto_command` typed into a session showing it, or any Enter meant for the agent, updates Codex and ends the session (a probe's Enter did exactly that, 0.154.0 to 0.163.0, in task #859). The key is Codex's own (`config_toml.rs`), it applies to that process only, and the user's own terminal still offers updates.

The task tag override is added for every session, a Command Terminal included (it carries its own made-up task id, so its leftovers are reaped when it ends). Codex passes its environment to tool shells through `shell_environment_policy`, which a user can narrow (`inherit = "core"`), and that strips `KANGENTIC_TASK_ID`, the tag a terminal transition finds a task's leftover processes by (see [Process reaping](../../architecture/worktrees/process-reaping.md)). A `set` entry always wins over the inherit and filter steps, and it adds to the user's own `set` table rather than replacing it (measured on codex-cli 0.154.0).

Resume is a subcommand in Codex (not a flag like Claude). Both forms emit the same flags: `codex resume` accepts `-c`, `-s/--sandbox`, `-a/--ask-for-approval`, `-m/--model`, `-C/--cd`, and `--disable`. The resume branch used to return early after `-C`, so a resumed session silently lost its permission mode, model override, and MCP wiring.

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

The entry is also **removed** when Kangentic deletes the worktree, via the adapter contract's `onWorktreeRemoved` hook (`removeWorktreeTrust`). Without that, a per-directory key that can never be inherited accumulates one dead table per task forever: one developer machine had reached 473 entries before this landed. Only a table whose sole key is `trust_level` is dropped, so anything the user or a future Codex added to it survives. `$CODEX_HOME` is honored on both the write and the removal, so Kangentic always targets the file Codex will actually read.

## Launch Options

Codex declares one `AgentLaunchOptionInfo` (see [Agent Adapter Interface - Optional Properties](optional-properties.md)): `disableApps`, off by default. When enabled, `--disable apps` is appended to both the new-session and `resume` command forms, skipping Codex's optional cloud ChatGPT Apps MCP connector (`apps` feature, stable and on by default per `codex features list`), which can hang the whole session at `Booting MCP server: codex_apps` (openai/codex#20167, #19284, #16550). The flag is per-invocation only - it never touches the user's `~/.codex/config.toml`. Configured via the Agent settings tab's Launch Options row, stored at `agent.launchOptions.codex.disableApps`.

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

**Trust comes from Codex itself.** Codex runs a session-flags hook only when `hooks.state` holds the hash it computes for it, and its TUI opens a blocking "Hooks need review" dialog for any hook without one (exec mode skips the hook silently). Kangentic does not compute that hash. `CodexHookTrustCheck` (`codex/hook-trust.ts`) runs the binary's own `codex app-server` once, with a scratch `CODEX_HOME`, asks `hooks/list` for the key and `currentHash` of the exact overrides, and passes them as one `-c hooks.state={...}` override, which Codex merges with the user's own `[hooks.state]` (their trusted hooks stay trusted, measured). The read starts in `detect`, `ensureTrust` waits for it for up to 8 s, and the answer is cached per binary file (path, size and modification time), so an in-place update reads again. A read that fails, times out, reports an error or warning, or leaves a hook out wires no hooks: the session runs on the PTY tracker as before. One read covers every session, because the overrides do not vary by session. An npm `.cmd` shim is the gap: an update replaces the package behind it, not the shim, so the cache key does not change.

What no hook reports comes from the rollout (`codex/session-history-parser.ts`): a command still running at its yield (`Process running with session ID N`, which fires PreToolUse but no PostToolUse) is a background start keyed by its call id, a `write_stdin` poll that finds it exited ends it, `turn_aborted` (an Esc interrupt, no hook) is an Interrupted event, and a `task_complete` that carries an `error` (a failed model request, no Stop) is a TurnFailed event. The rollout no longer forces activity or reports tool starts, and `sessionHistory.suppressesPtyFallback: false` keeps its reads from turning the PTY tracker off, so a session whose hooks Codex did not confirm keeps that tracker.

The legacy project-local `.codex/hooks.json` from builds before Codex 0.128 is still swept of Kangentic-owned entries by `buildHooks`.

Codex's rollout, transcript and model-history readers resolve Codex's home through `codexHomeDir` (`config-toml.ts`), so `$CODEX_HOME` is honored there too; with `~/.codex` hard-coded, a user with `CODEX_HOME` set got no rollout telemetry at all.

## Limitations

- No real-time token usage or cost data (no statusLine equivalent)
- No merged settings file mechanism
- No live `/model` or `/reasoning-effort` injection: changing either requires a respawn (`getInjectionSequence` returns `[]`), and effort is `config.toml`-only with no CLI flag
