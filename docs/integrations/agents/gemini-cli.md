---
type: Reference
title: Gemini CLI
description: Gemini CLI's shared .gemini/settings.json with per-session holds that strip Kangentic hooks when the last session leaves, the httpUrl MCP entry of environment references, plan exit read from AfterTool text, ToolPermission notifications as permission idle, and trustedFolders.json entries.
tags: [agents, adapter, gemini]
sources:
  - resource: src/main/agent/adapters/gemini/gemini-adapter.ts
  - resource: src/main/agent/adapters/gemini/detector.ts
  - resource: src/main/agent/adapters/gemini/command-builder.ts
  - resource: src/main/agent/adapters/gemini/hook-manager.ts
  - resource: src/main/agent/adapters/gemini/trust-manager.ts
  - resource: src/main/agent/adapters/gemini/gemini-home.ts
  - resource: src/main/agent/shared/shared-folder-holds.ts
---
# Gemini CLI

## CLI Detection

`src/main/agent/adapters/gemini/detector.ts`

Detection follows the same pattern: check `config.agent.cliPaths.gemini`, fall back to `PATH` via `which`, run `gemini --version`.

## Command Building

`src/main/agent/adapters/gemini/command-builder.ts`

### New Session

```
gemini --approval-mode <mode> "prompt text"
```

Gemini creates sessions implicitly (no `--session-id` equivalent).

### Resumed Session

```
gemini --resume <sessionId>
```

## Permission Modes

| Mode | Flag | Gemini Mode |
|------|------|-------------|
| `plan` / `dontAsk` | `--approval-mode plan` | Plan (Read-Only Research) |
| `default` | (no flag) | Default (Confirm Actions) |
| `acceptEdits` / `auto` | `--approval-mode auto_edit` | Auto Edit (Auto-Approve Edits) |
| `bypassPermissions` | `--approval-mode yolo` | YOLO (Auto-Approve All) |

## Plan exit

A plan column's task moves to its After Plan Mode target when Gemini's plan is approved, as a
Claude task does. Gemini's `exit_plan_mode` fires `AfterTool` for an approved plan and a rejected
one alike, so the `AfterTool` hook carries a `setToolWhen` directive that reports it as
`ExitPlanMode` only when `tool_response.llmContent` starts with "Plan approved." (measured on
Gemini CLI 0.63.0: a rejection reads "Plan rejected. User feedback: ...").

## Confirmation prompts

Gemini has no permission hook. It reports each tool confirmation dialog, the plan prompt included,
as a `Notification` whose `notification_type` is `ToolPermission`. A second `Notification` entry
turns that one into the permission `idle` (`extractDetail(['notification_type'])`, then
`emitOnlyWhenDetailMatches('^ToolPermission$')`, then `setDetail('permission')`), so the card
shows the task needs you. The `AfterTool` that follows your answer clears it. Any other
notification writes no idle.

Gemini does not declare `supportsPlanAutoApproval`, so its plans always wait for you. Three things
stand in the way:

- Its approval always continues in Auto Edit or Default, never in the destination column's mode.
- An approval would have to be armed at spawn, so a column switched to Manual mid-plan could not
  stop it.
- Nothing would write the marker the [plan approval gate](../../architecture/activity/event-types.md#plan-approval-gate)
  pairs with the plan exit.

## Settings Merge

Gemini reads settings from `.gemini/settings.json` in the project directory. Unlike Claude's `--settings` flag, Gemini has no way to point to a per-session settings file. Kangentic writes merged settings (event-bridge hooks and / or the Kangentic MCP server entry) directly to `.gemini/settings.json` in the CWD.

The project root's file is read on every spawn, never cached, so an edit or a pull reaches the next session with no restart. In the main repo that read finds the file the previous spawn wrote, so it strips Kangentic's own hooks and `mcpServers.kangentic` entry first (`stripKangenticEntries`, the same strip `removeHooks` runs) and the user's content is the baseline. A hook counts as Kangentic's when its command runs one of the bridges (`isKangenticHookCommand`). Gemini's commands name no `.kangentic` path, so they are recognized by the events argument `env:KANGENTIC_EVENTS_PATH` and by the hint spec naming `kangentic_mark_background_service`. Neither depends on the install path, so hooks an earlier install wrote from another path (an AppImage remount, a moved app) are stripped too.

Because the file is shared, concurrent Gemini sessions in the same folder are serialized by per-session holds in `GeminiAdapter.hookHolds` (a `SharedFolderHolds`): every `buildCommand` that writes the file (an events pipeline or MCP wiring) holds it under `CommandOptions.ptySessionId`, the id the session spawns under, and `removeHooks(directory, sessionId)` only strips the file when the last session in that folder releases. The key is the session, not the task: a young session's kill leaves its PTY exiting for up to the grace while the task's next session starts, and a task-keyed release let that late exit strip the running session's hooks. A second release of one session (session-manager invokes `removeHooks` both in `suspend()` and from the PTY `onExit` handler) is a no-op. A built command that never becomes a session (an abort, a skipped startup spawn, a failed spawn) releases its hold through `releaseCommandHold` (`src/main/pty/lifecycle/adapter-lifecycle.ts`). On crash or force-quit, the next spawn's read strips any stale Kangentic entries (`stripKangenticEntries`) and `buildHooks` filters them again. `removeHooks` strips the `mcpServers.kangentic` entry alongside the hooks, so the entry and its environment references do not outlive the session. Qwen, Cursor, Droid, Antigravity, Grok, OpenCode and Codex (its legacy `.codex/hooks.json` sweep) hold their shared files the same way.

## MCP Wiring

The merged settings carry an `mcpServers.kangentic` entry using the Gemini-family `httpUrl` key (not the Anthropic/fastmcp `url` used by Claude and Kimi), with `httpUrl` `${KANGENTIC_MCP_URL}` and `headers` `X-Kangentic-Token: ${KANGENTIC_MCP_TOKEN}`. Both values come from the session environment through `buildEnv` (task #859; Gemini expands `$NAME` and `${NAME}` in every settings string), so the file holds no URL and no token, and the entry is per-session. This is the same shape the Qwen fork writes. User-defined `mcpServers` are preserved, and `removeHooks` strips only our entry.

The settings write is gated on hooks **or** MCP, so an MCP-only spawn (no events pipeline) still produces the file.

## WSL

A Gemini installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts Gemini's Linux path in a `wsl -d <distro>` shell. `.gemini/settings.json` is shared by every session in the folder, so none of it names one session's path. The hooks call the folder's copy of the WSL hook transport's script, `<cwd>/.kangentic/gemini-wsl-hook.sh` (`copyWslHookScriptInto`), with the same events and directives, since a distro may have no node. The copy finds the session's own folder through `KANGENTIC_WSL_HOOK_DIR`, which Gemini's hooks inherit, as they inherit `KANGENTIC_EVENTS_PATH` for the node bridge. The background shell hint goes through the transport's `reply`. Gemini passes each hook its payload on stdin, which the script's `event` mode reads.

On mirrored networking the MCP entry is the URL one above. On NAT networking the distro cannot reach this machine's loopback, so it is the transport's stdio bridge, `{"command": "sh", "args": ["${KANGENTIC_MCP_BRIDGE_SCRIPT}", "mcp", "${KANGENTIC_MCP_URL}"], "env": {"KANGENTIC_MCP_TOKEN": "${KANGENTIC_MCP_TOKEN}"}}`, every value a reference the session's environment fills (`buildEnv` adds the script's distro path), so the file still holds no token and no session's path. Trust, the chats, the model scan and an answer's chat cleanup read the distro's Gemini directory (its own `GEMINI_CLI_HOME`, else the distro home), keyed by the `/mnt` cwd and compared with Linux case. A removed worktree's trust entry goes from the distro's file while the distro runs. `--help`, a title summary and a Knowledge Graph answer run through `wsl.exe`. Not yet run against a Gemini installed in a distro: the `gemini` on this machine's Ubuntu is the Windows one through interop.

Every `~/.gemini` path on this page is Gemini's user directory, `<GEMINI_CLI_HOME>/.gemini` when that variable is set (`geminiHomeDir`, `gemini-home.ts`), the folder Gemini's configuration docs say it creates there. The trust write and removal, the chats, the model scan, the answer chat cleanup and the relocation pass all use it, so trust lands where Gemini reads it. Only an absolute value is taken: a relative one would resolve against the CLI's own working directory, which a global reader does not have.

Two things make this work that are easy to miss:

- **Folder trust is load-bearing.** Gemini disables every configured MCP server in an untrusted folder (`gemini mcp list` reports "MCP servers are configured but disabled because this folder is untrusted", and user-level servers are suppressed too), so the entry would be silently inert. `GeminiAdapter.ensureTrust` pre-populates `~/.gemini/trustedFolders.json` via `trust-manager.ts`. Unlike the Qwen equivalent it does **not** gate on `security.folderTrust.enabled`, because Gemini 0.54.4 enforces trust with that flag unset. It never overrides a user's `TRUST_PARENT` or `DO_NOT_TRUST`, at the path itself or on any ancestor, so a `DO_NOT_TRUST` on the repo suppresses approval for every worktree Kangentic creates beneath it (the same deny rule Codex applies to its project root). It also skips the write when an ancestor is already trusted, so a worktree under an already-trusted repo adds no key at all. When no ancestor is trusted, though, it does record one `TRUST_FOLDER` per task worktree, exactly like Codex - which is why `GeminiAdapter.onWorktreeRemoved` drops that entry again when Kangentic deletes the worktree (`removeWorktreeTrust`). Without it the file grows by a dead entry per task forever, the accumulation that reached 473 entries in Codex's `config.toml`. Removal only ever takes an entry Kangentic could have written itself: a `TRUST_PARENT` or `DO_NOT_TRUST` at that path is a user decision and survives, so a later worktree at the same path still honors it. Ancestor matching folds case only on Windows, since POSIX paths are case-sensitive.
- **No token is on disk.** The file holds only the `${KANGENTIC_MCP_URL}` and `${KANGENTIC_MCP_TOKEN}` references (the values travel in the session environment), but its hook entries still land in `.gemini/settings.json`, which is project-shared and may be intentionally committed, so it cannot be blanket-gitignored like `.kangentic/`. `removeHooks` strips the entry when the folder's last session ends. For the untracked case this is now self-enforcing: when Kangentic creates the file (it did not exist before the spawn), the builder seeds `.gemini/settings.json` and `.kangentic/` into `.git/info/exclude` via the shared `git-exclude.ts` mechanism (see [Antigravity](antigravity.md)), so the file never shows as untracked and cannot ride a `git add -A` into history. A pre-existing file keeps its normal git visibility (the created-by-us carve-out), and ignore rules never affect tracked files - so the rule stands: do not commit `.gemini/settings.json` while a Kangentic-spawned Gemini session is running.
