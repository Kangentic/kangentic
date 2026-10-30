---
type: Reference
title: Antigravity
description: Google's Antigravity CLI (agy), which tokenizes its own hook commands so paths are unquoted and .agents-relative, a copied agy-event-bridge.cjs, MCP as a workspace plugin, per-cwd trustedWorkspaces, a PreToolUse hook for ask_question alone that answers allow and marks the question, and brain transcript.jsonl history.
tags: [agents, adapter, antigravity]
sources:
  - resource: src/main/agent/adapters/antigravity/antigravity-adapter.ts
  - resource: src/main/agent/adapters/antigravity/detector.ts
  - resource: src/main/agent/adapters/antigravity/command-builder.ts
  - resource: src/main/agent/adapters/antigravity/hook-manager.ts
  - resource: src/main/agent/adapters/antigravity/trust-manager.ts
  - resource: src/main/agent/adapters/antigravity/data-paths.ts
  - resource: src/main/agent/adapters/antigravity/transcript-parser.ts
  - resource: src/main/agent/shared/git-exclude.ts
---
# Antigravity

Antigravity CLI (`agy`, https://antigravity.google/docs/cli/getting-started) is Google's terminal TUI coding agent, Gemini-family models by default with optional Claude and open-source backends. It shares the `~/.gemini` home directory with the Gemini CLI but keeps everything of its own under the `~/.gemini/antigravity-cli/` subtree, with its own trust store, hook schema, and MCP config format - hence a sibling adapter rather than a Gemini variant. Every behavior below was verified against a real agy 1.1.13 install (2026-08-16).

## CLI Detection

Detection uses the shared `AgentDetector` (via composition) with binary name `agy`. The official installer places the binary at `%LOCALAPPDATA%\agy\bin\agy.exe` on Windows (a fallback path derived from the `LOCALAPPDATA` env var) and `~/.local/bin/agy` on macOS/Linux (covered by `standardUnixFallbackPaths`). `agy --version` prints a bare version number; `parseVersion` requires a leading digit so a foreign tool answering on the same name is rejected.

## Command Building

`src/main/agent/adapters/antigravity/command-builder.ts`

```
agy [--mode plan|accept-edits] [--dangerously-skip-permissions] [--conversation <id>] [--model <slug>] [--effort <level>] [-i|-p "<prompt>"]
```

- The interactive prompt is delivered via `-i` (`--prompt-interactive`), which runs the prompt and keeps the TUI session; agy has no bare positional prompt form. Non-interactive spawns (`nonInteractive` transition actions) use `-p` instead.
- Resume passes `--conversation <id>` with the captured conversation UUID; it works cross-directory, so a relocated worktree still reaches its conversation. Fresh spawns pass nothing - agy allocates the conversation id lazily at the first turn (`supportsCallerSessionId` is false).
- Model (`--model <slug>`) and effort (`--effort low|medium|high`) overrides pass straight through when set.
- As spawn side effects the builder merges the Kangentic named hook into `<cwd>/.agents/hooks.json` and writes the MCP workspace plugin (below).

## Permission Modes

Mapped onto agy's native autonomy flags; the unflagged default is agy's own "request-review" mode.

| Mode | agy flag |
|------|----------|
| `plan` | `--mode plan` |
| `default` | (none - request-review) |
| `acceptEdits` / `auto` | `--mode accept-edits` |
| `bypassPermissions` / `dontAsk` | `--dangerously-skip-permissions` |

`defaultPermission` is `acceptEdits`.

## Hooks and Activity Detection

agy has a lifecycle hook system (`hooks.json` in a customization root; the adapter writes `<cwd>/.agents/hooks.json` with one named hook, `kangentic-events`). Three events feed the event-bridge pipeline for every tool, and a fourth, `PreToolUse` for the question tool alone, is described below: `PreInvocation` -> `prompt` (the turn-initiating signal, also carrying a `captureHookContext` directive so the session id can be read from the payload), `PostToolUse` -> `tool_end` (tool name at `toolCall.name`, primary argument from `toolCall.args`, via the path-addressed `extractToolPath` / `extractDetailPath` directives), and `Stop` -> `idle` (agy's payload carries `fullyIdle`). `PreToolUse` is hooked for agy's question tool, `ask_question`, and nothing else (GitHub #452). agy treats a handler response without a `decision` field as a DENY (observed: a `{}` response put the model in a tool-denied retry loop), so the entry carries `replyJson({ decision: 'allow' })`, the one directive that makes the event bridge write to stdout (see [Bridge scripts](bridge-scripts.md#event-bridgejs)). The same entry writes the tool's `tool_start` and then a question wait (`appendPermissionWaitForTool`), and the tool's `PostToolUse` ends it. Antigravity's hook reference says `allow` "delegates to the next hook or default policy", and a probe on agy 1.3.4 in a `/preview` showed it: a PreToolUse hook answering `allow` for every tool left both the question dialog ("Question 1/1: Which color?") and the command dialog ("Run this command?") on screen. Its payload names the tool at `toolCall.name` with the questions in `toolCall.args.questions` (`tests/fixtures/antigravity-hooks/`). Then Kangentic's own entry was run live: the card showed the bubble while the dialog stayed up, and the answer fired `PostToolUse` for `ask_question` and a `PreInvocation`, which cleared it.

Approvals stay on the envelope. PreToolUse fires for every tool, and agy's own policy decides whether a dialog follows, so the hook cannot tell a tool that asks from one that just runs. A distro's agy (WSL) gets no question entry either: its hook transport carries no stdout reply, and an entry without one would deny every question.

Two agy quirks shape the wiring. First, agy tokenizes hook commands on whitespace with quote characters kept literal, so no command token may be quoted or contain a space: every path is emitted `.agents`-relative (hooks run with cwd = the directory containing hooks.json) and the event-bridge is copied to `<cwd>/.kangentic/agy-event-bridge.cjs` on each spawn whose copy differs from the app's bridge (`.cjs` so a `"type": "module"` in the user's package.json cannot make node parse the CommonJS bridge as ESM). Second, hooks do NOT fire in `-p` print mode, so activity is `hooks_and_pty`: hook events are primary, and the PTY silence timer plus a `detectIdle` match on the idle footer (`? for shortcuts`; the running footer shows `esc to cancel` instead) cover print-mode spawns and any workspace where hook wiring was skipped.

Session ids are captured two ways: `fromHook` reads `conversationId` (present in every hook payload, camelCase protojson), and `fromOutput` matches the graceful-shutdown summary (`agy --conversation=<uuid>`) plus print-mode JSON (`"conversation_id"`). There is no `fromFilesystem` capture: `cache/last_conversations.json` is written only at CLI exit, after the spawn-time polling window has closed.

## MCP

The Kangentic MCP server is registered as a WORKSPACE PLUGIN at `<cwd>/.agents/plugins/kangentic/` (`plugin.json` marker + `mcp_config.json` with `serverUrl` and a `headers['X-Kangentic-Token']` entry). agy dials `serverUrl` with streamable HTTP (`POST /mcp`) and forwards the headers map, connecting lazily at the first agent turn. A bare workspace `mcp_config.json` (no plugin wrapper) does not load (upstream google-antigravity/antigravity-cli#60). Same plaintext-token trade-off as Gemini: the per-launch token sits on disk during the active session; tokens rotate per app launch and `removeHooks()` deletes the plugin dir once the folder's last session exits or suspends. A spawn with MCP wiring holds the folder even without an events pipeline, so a neighbour's exit never deletes the plugin under it.

The runtime files are also hidden from git for the session's lifetime: the command builder seeds `.git/info/exclude` (the local, never-committed ignore file, resolved through the worktree's `commondir` so one seeding covers every worktree of the repo) with `.agents/plugins/kangentic/`, `.kangentic/`, and - only when Kangentic created the file itself - `.agents/hooks.json`. Ignore rules affect untracked files only, so a user's own tracked `.agents` customizations keep normal git visibility, while the token-bearing plugin can never ride into a commit on a `git add -A`. The marker comment in the exclude file says the lines are safe to remove. This mechanism originated here and now lives in `src/main/agent/shared/git-exclude.ts` (generic `# kangentic:` marker; the legacy antigravity-branded marker is recognized by prefix so already-seeded repos never gain a second marker block), shared by the Gemini, Qwen, Droid, and Grok builders and OpenCode's plugin install - each with its own pattern list and created-by-us carve-outs.

## Trust

agy stores workspace trust as `trustedWorkspaces: string[]` (exact absolute paths) in `~/.gemini/antigravity-cli/settings.json` - NOT Gemini's `trustedFolders.json`, and with no per-entry trust level. Trust is exact-path, not inherited: agy prompts for a task worktree even when the repository root above it is already trusted (observed live), so `ensureTrust` writes one entry per spawn cwd rather than relying on ancestor coverage, and the TUI's workspace trust confirmation never blocks an automated spawn. `onWorktreeRemoved` drops the exact-path entry so the list does not grow one dead entry per task, and `onProjectRelocated` re-keys both the trust entry and the `last_conversations.json` mapping.

## Session History and Transcript

Each conversation writes a parseable JSONL transcript at `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl` (steps: `USER_INPUT` with the prompt wrapped in `<USER_REQUEST>`, `PLANNER_RESPONSE` with `thinking` / `content` / `tool_calls`, `ERROR_MESSAGE`, `CHECKPOINT`). `parseTranscript` maps it into `TranscriptEntry[]` and `transcriptToolCounts` counts its tool calls. The conversation store itself (`conversations/<uuid>.db`) is SQLite with opaque protobuf step payloads and is not read.

The transcript flushes ON SUBMIT (measured: 84ms worst append latency across short and long turns), which is what qualifies the command-injection verifier - see [command-injection.md](../../architecture/automations/command-injection.md).

## WSL

An agy installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts agy's Linux path in a `wsl -d <distro>` shell. Its hooks call the WSL hook transport's script in place of the node bridge, since a distro may have no node: `sh <token> event <type> <directives>` (`wslAgentsHookCommand`). The token is the session's copy of the script, named relative to `.agents/` and space-free, by the same rule the bridge token follows, because agy splits a command on whitespace and keeps quotes literal. The script finds its folder from its own path, and agy passes the payload on stdin, which its `event` mode reads. The hook names one session's script in the folder-shared `hooks.json`, as the node bridge's hook names one session's events path, so the folder's last session decides where its hooks publish, on this machine and in a distro alike. Gemini, Qwen and Grok name a per-folder copy of the script instead. On mirrored networking the MCP plugin keeps the `serverUrl` entry. On NAT networking it names the transport's stdio bridge, `{"command": "sh", "args": [<script>, "mcp", <url>], "env": {"KANGENTIC_MCP_TOKEN": <token>}}`, with the token as plaintext as the header form.

The data root, the trust store, the transcripts and an answer's conversation cleanup are the distro's `~/.gemini/antigravity-cli`. Trust entries are the `/mnt` path, compared with Linux case, and a removed worktree's entry goes from the distro's settings while the distro runs. The title run's hidden PTY starts `wsl.exe` in place of the CLI, with its scratch folder trusted in the distro. `--help`, `agy models` and a Knowledge Graph answer run through `wsl.exe` too. Not yet run against an agy installed in a distro, and agy's stdio MCP entry shape comes from its config, not from a run.

## Limitations

- No token/context/cost telemetry: neither the interactive transcript nor the hook payloads carry usage, so the adapter declares `liveTelemetryUnsupported` ("Telemetry: TUI only" - the agy footer shows the active model and effort). The board model pill is seeded from a `--model` override via `configuredModelFromCommand`.
- No live model/effort injection: `/model` exists in the TUI but model changes restart by design, and no `/effort` slash command exists, so `getInjectionSequence` is omitted.
- No `probeAuth` / `loginCommand`: sign-in is keyring + Google Sign-In completed inside the TUI (works through the PTY); there is no login subcommand and no reliable non-quota probe.
- Slash auto_commands are `verify: 'none'`: the TUI rejects an unregistered `/command` client-side ("Unknown command") and records nothing (`canVerifySlashSubmission` is false).
- Handoff transcript cleanup captures the last turn only (no response marker glyph; same limitation as Gemini).
