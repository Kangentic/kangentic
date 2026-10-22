---
type: Reference
title: Grok Build
description: How Kangentic runs xAI's Grok Build, a Claude-compatible TUI, and how its command building and permission modes map.
tags: [agents, adapter, grok]
sources:
  - resource: src/main/agent/adapters/grok/
---
# Grok Build

`src/main/agent/adapters/grok/`

xAI's terminal coding agent (repo: `xai-org/grok-build`, binary `grok`, a Rust alt-screen
TUI). Grok deliberately clones Claude Code's surface - Claude-compatible hooks, the same
`--session-id` / `--resume` split, the same `--permission-mode` vocabulary - which is what
makes this the second full-harness adapter after Claude. Every empirical claim below was
verified against grok 1.0.0 (3cd0d0cbce) on Windows and is re-checkable with
`node scripts/probe-grok.js` (headless checks spend a few tiny free-tier turns; add
`--skip-pty` to skip the interactive leg).

**Sessions (caller-owned ids).** `-s/--session-id <uuid>` names a NEW session only (reusing
an existing uuid errors with "Session ID ... is already in use"); `--resume <uuid>` resumes.
The store lives at `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/` (the raw
absolute cwd, backslashes intact on Windows, URL-encoded byte-for-byte) with
`updates.jsonl` (append-only ACP `session/update` JSON-RPC log, the authoritative record),
`chat_history.jsonl` (raw model messages), and `summary.json` (metadata). `GROK_HOME`
overrides `~/.grok`. Because the id is caller-owned, `locate` is a deterministic path build
plus an existence poll, with a sessions-root scan fallback keyed on the uuid for encoding
mismatches. The command builder deliberately emits NO `--cwd`: grok keys the store by
process cwd, and a normalized `--cwd` value could key it under a different encoding than
`session-paths.ts` computes.

**Hooks (the activity pipeline).** Grok fires the full Claude-compatible hook set -
including in headless mode - with camelCase payloads (`toolName`, `toolUseId`, `toolInput`,
`toolResult`, `reason`, `stopHookActive`). `Stop` fires only for the main agent (subagents
fire `SubagentStop` in the subagent), so Claude's subagent-depth gating is unnecessary.
Grok has no per-session settings flag, so the hook file is per-cwd:
`<cwd>/.grok/hooks/kangentic.json`, a wholly-Kangentic-owned file (grok merges every
`*.json` in that directory, so user hook files are never read, merged, or swept). The
per-session events path rides the spawn environment instead of the file: hook commands name
`env:KANGENTIC_EVENTS_PATH`, which `event-bridge.js` resolves from its own process env at
run time - hook processes inherit the grok process env (probe-verified). One static file is
therefore correct for concurrent sessions in one cwd, and a session without the variable
(the user's own manual `grok` run there) makes the bridge a silent no-op. Hooks load from
the project root grok discovers by walking up to the first `.git`; every Kangentic spawn cwd
is a git root, so writing at cwd is writing at the root. On Windows grok runs each hook with
`pwsh -NoProfile -NonInteractive -Command`, and it replaces `$NAME` in the command first, so the
bridge path is quoted for that (see [Paths in hook commands](claude-code.md#paths-in-hook-commands)). Runtime is
`ActivityDetection.hooksAndPty()`: untrusted folders skip project hooks silently
(fail-open), and the PTY silence timer carries activity until trust lands. No `detectIdle`
regex - grok's `❯` prompt stays visible during active work, the same always-visible-prompt
trap as Codex's `›`.

**Telemetry (`updates.jsonl` tail, no statusline).** Grok has no statusline, so
`parseStatus` is null and usage comes from `runtime.sessionHistory` tailing `updates.jsonl`.
Three measured semantics are load-bearing: `params._meta.totalTokens` on streaming/tool
updates is the RUNNING context total (the ContextBar occupancy number);
`turn_completed.usage` is CUMULATIVE across the session (observed `numTurns: 8`,
`inputTokens: 541k` - using it for occupancy is the Codex `total_token_usage` trap; it feeds
`transcriptUsage` instead); and `costUsdTicks` is 1e-10 USD (pinned by a headless json run
reporting `total_cost_usd` and `total_cost_usd_ticks` side by side, re-checked by the
probe). Context window sizes and model display names come from `~/.grok/models_cache.json`.
The parser emits NO tool events - hooks own those, and a second emitter would double-count
ToolStart/ToolEnd pairs - only usage plus idempotent activity hints (`turn_completed` ->
Idle, chunks -> Thinking, non-terminal `retry_state` -> Thinking) as a hook backstop.

**Kangentic MCP.** Project-scoped `<cwd>/.grok/config.toml` carries a sentinel-delimited
`[mcp_servers.kangentic]` block whose every value is an env reference
(`url = "${KANGENTIC_MCP_URL}"`, token header `${KANGENTIC_MCP_TOKEN}`); grok's documented
`${VAR}` expansion resolves them at load time. The block is fully static - the per-session
URL (which carries the caller-session id) and per-launch token ride `buildEnv` - so
concurrent sessions in one cwd each expand their own environment, no secret ever reaches
disk or argv, and removal (held per session, shared with the hooks file) is a surgical strip of
the sentinel block that never reserializes the user's TOML. The builder also passes
`--allow "MCPTool(kangentic__*)"` (grok's native permission-rules mechanism,
session-scoped, deny still wins) so a board-driven session never stalls on the interactive
approval prompt for Kangentic's own tools - verified live without it,
`kangentic__kangentic_get_current_task` sat on the approval dialog with nobody there to
answer. This is Claude's `mcp__kangentic` allow-rule injection, in grok's dialect.

Both runtime files are hidden from git for the untracked case: the builder seeds
`.grok/hooks/kangentic.json` (unconditionally - the filename is wholly Kangentic-owned),
`.grok/config.toml` (only when Kangentic creates the file; a pre-existing user config keeps
its git visibility), and `.kangentic/` into `.git/info/exclude` via the shared
`git-exclude.ts` mechanism (see [Antigravity](antigravity.md)). Neither file carries a secret, so
this is purely untracked-noise control for the Changes pane and `git add -A`.

**Trust.** Folder trust (`~/.grok/trusted_folders.toml`, entries
`[folders.'<path>'] / trusted = true / decided_at = <unix>`) gates project hooks and
project MCP together, and CASCADES to subdirectories - verified live: a Kangentic worktree
under a trusted project root reports `projectTrusted: true` with only the root in the store.
`ensureTrust` therefore pre-approves ONLY a Kangentic worktree with no covering decision
(one entry per task, dropped by `onWorktreeRemoved` - the Codex dead-entries lesson), never
overrules an explicit ancestor deny, and never auto-trusts a plain project root: an
undecided root runs untrusted (PTY fallback carries activity) until the user's own first
interactive grok session decides it once, which then cascades to every future worktree.

**Verification tier: confirm-only.** `chat_history.jsonl` flushes the typed user turn on
SUBMIT (measured 313ms and 32ms across two runs, against a ~2s turn), so a
`command-injection` verifier is wired against it (genuine turns have no `synthetic_reason`
and wrap the text in `<user_query>` tags, which the extractor strips). But records carry no
timestamps to bound the match window and the resolver has never been proven in-app, so
`canEscalateOnVerificationFailure` is false. `canVerifySlashSubmission` is false (slash
input runs in the TUI palette and never becomes a chat_history turn - the Codex verdict),
which is also why `getInjectionSequence` returns `[]` despite grok having native `/model`
and `/effort` commands: an unconfirmable injection could land as literal prompt text, while
a task session's restart applies `--model` / `--reasoning-effort` deterministically.

**Other capabilities.** `parseTranscript` reads `chat_history.jsonl`
(`system`/`user`/`assistant`/`reasoning`/`tool_result` records; assistant tool calls in
`tool_calls[]` with JSON-string `arguments`; no timestamps, so entries get a parse-time
stamp and synthesized uuids). `transcriptUsage`/`transcriptToolCounts` read `updates.jsonl`
(Claude-parity lifetime rollup). `summarize` runs the plain-output print mode
(`--output-format plain -p`) with the answer run's deny rules (see the Auto-Name table); its session
stays in `~/.grok/sessions` until a title is measured on the answer run. `probeAuth` runs `grok models` and checks for "not
authenticated" - note grok currently serves a free tier without login, so false means "not
signed in", not "unusable"; a subscription-less account that hits a limit gets an explicit
403 rendered as a failed turn in the TUI, not a hang. Auth is browser OAuth through the PTY
(`grok login`, device-code fallback `--device-auth`, `XAI_API_KEY` env for CI).

**Detector.** `binaryName: 'grok'` with NO `agent` alias - grok's installer also publishes
a generic `agent` shim that collides with Cursor's (see the collision guard below), and
`parseVersion` requires the `grok ` banner prefix so a foreign binary answering on a shared
name is rejected. `tests/unit/cursor-grok-binary-collision.test.ts` pins both directions.

## Command Building

`src/main/agent/adapters/grok/command-builder.ts`

```
grok [-s <uuid> | --resume <uuid>] --permission-mode <mode> [--allow "MCPTool(kangentic__*)"]
     [--model <slug>] [--reasoning-effort <effort>]
     [-- "<prompt>" | -p "<prompt>" --output-format plain]
```

- `-s <uuid>` names a NEW session and `--resume <uuid>` resumes an existing one; the builder emits exactly one of the two, never both.
- `--permission-mode` is always emitted (see below).
- `--allow "MCPTool(kangentic__*)"` rides along only when the Kangentic MCP server is attached, so a board-driven session never stalls on grok's interactive approval prompt for Kangentic's own tools. An explicit user deny still wins.
- Model and effort overrides pass straight through as `--model <slug>` and `--reasoning-effort <effort>` when set.
- The interactive prompt is delivered after `--` (end-of-options), so prompt text starting with a dash can never be parsed as a CLI option regardless of shell quoting. Non-interactive spawns (`nonInteractive` transition actions) use `-p "<prompt>" --output-format plain` instead, which prints one turn and exits. A resume passes no prompt at all.

## Permission Modes

`--permission-mode` accepts Kangentic's `PermissionMode` names verbatim (verified in
`grok --help`), so all six pass through 1:1. Internally grok normalizes `acceptEdits` and
`dontAsk` onto its own ladder (`default | auto | plan | bypassPermissions`), with `auto` as the
nearest neighbor, so the behavior these names select is grok's, not Claude's.

| Mode | CLI Flag |
|------|----------|
| `plan` | `--permission-mode plan` |
| `default` | `--permission-mode default` |
| `acceptEdits` | `--permission-mode acceptEdits` |
| `auto` | `--permission-mode auto` |
| `dontAsk` | `--permission-mode dontAsk` |
| `bypassPermissions` | `--permission-mode bypassPermissions` |

`defaultPermission` is `acceptEdits`.
