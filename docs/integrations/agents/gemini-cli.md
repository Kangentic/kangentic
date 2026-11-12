---
type: Reference
title: Gemini CLI
description: Gemini CLI's shared .gemini/settings.json with per-session holds that strip Kangentic hooks when the last session leaves, the httpUrl MCP entry of environment references, chosen session ids, plan exit read from AfterTool text, ToolPermission notifications as permission idle, chat-file patches and rewinds, usage and tool counts, model labels, trustedFolders.json entries, and its parity with Claude Code.
tags: [agents, adapter, gemini]
sources:
  - resource: src/main/agent/adapters/gemini/gemini-adapter.ts
  - resource: src/main/agent/adapters/gemini/detector.ts
  - resource: src/main/agent/adapters/gemini/command-builder.ts
  - resource: src/main/agent/adapters/gemini/hook-manager.ts
  - resource: src/main/agent/adapters/gemini/transcript-parser.ts
  - resource: src/main/agent/adapters/gemini/transcript-usage.ts
  - resource: src/main/agent/adapters/gemini/model-display-name.ts
  - resource: src/main/agent/adapters/gemini/conversation-gone.ts
  - resource: src/main/agent/adapters/gemini/subagent-usage.ts
  - resource: src/main/agent/adapters/gemini/trust-manager.ts
  - resource: src/main/agent/adapters/gemini/gemini-home.ts
  - resource: src/main/agent/adapters/gemini/accounts.ts
  - resource: src/main/agent/shared/shared-folder-holds.ts
  - resource: src/main/agent/shared/git-exclude.ts
---
# Gemini CLI

## CLI Detection

`src/main/agent/adapters/gemini/detector.ts`

Detection follows the same pattern: check `config.agent.cliPaths.gemini`, fall back to `PATH` via `which`, run `gemini --version`.

## Command Building

`src/main/agent/adapters/gemini/command-builder.ts`

### New Session

```
gemini --approval-mode <mode> --session-id <uuid> "prompt text"
```

The session starts under the id Kangentic chose (`supportsCallerSessionId`), so the reader of its chat file attaches at spawn and nothing has to be captured. The CLI describes the flag as "Start a new session with a manually provided UUID" and accepts letters, digits, `-` and `_` ([config.ts at v0.66.0](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/cli/src/config/config.ts)). It shipped in v0.41.0 (PR #26060). The parser is strict, so an older Gemini exits on the unknown flag; the answer run already passed `--session-id`, so it already needed 0.41.0. `runtime.sessionId` still reads an id from the session file, the SessionStart hook and the shutdown banner, and `SessionIdManager` drops any capture once the chosen id is known.

### Resumed Session

```
gemini --resume <sessionId> "prompt text"
```

The resumed session runs the prompt as its next turn (`resumePromptDelivery` is `command-line`). Never both flags: the CLI rejects the pair ("The flags --resume, --session-id, and --session-file are mutually exclusive").

### Readable directories

A workflow agent's other projects reach Gemini as one `--include-directories <path>` each (`supportsReadableDirectories`), before the prompt. The option takes one value per flag (`nargs: 1`), so the positional prompt after it is never read as a directory, and a Gemini in a WSL distro gets each path's `/mnt` form. Gemini's read tools need no approval in its default policy ([file system tools](https://geminicli.com/docs/tools/file-system/): only `write_file` and `replace` do). The [configuration reference](https://geminicli.com/docs/reference/configuration/) says 5 directories at most, but the v0.66.0 parser has no cap and no check, so every directory is passed.

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

The notification's `details.type` is the dialog's own type, which says what the wait is for:
`ask_user` is the `ask_user` tool's question, and every other type (`exec`, `edit`, `mcp`, `info`,
the plan prompt) is an approval. The same entry tags the wait with `setWaitKind('approval')` and
`setWaitKindWhen({ path: ['details', 'type'], equals: 'ask_user', to: 'question' })`, so the card
draws the speech bubble or the quartered shield. The question's text is not read: the card and the
notification carry none. Captured on Gemini CLI 0.66.0
(`tests/fixtures/gemini-hooks/gemini-0.66.0-notification-*.json`): the `ask_user` dialog's
Notification carries `details: { type: "ask_user", title: "Ask User" }` and lands after the tool's
`BeforeTool`, a shell command's carries `details.type: "exec"` with the command, and each tool's
`AfterTool` ends its wait.

Gemini does not declare `supportsPlanAutoApproval`, so its plans always wait for you. Three things
stand in the way:

- Its approval always continues in Auto Edit or Default, never in the destination column's mode.
- An approval would have to be armed at spawn, so a column switched to Manual mid-plan could not
  stop it.
- Nothing would write the marker the [plan approval gate](../../architecture/activity/event-types.md#plan-approval-gate)
  pairs with the plan exit.

## Model switch and model labels

A Command Terminal's live model swap types `/model set <id>`. A bare `/model <id>` does not switch: at v0.66.0 the parent command forwards to `manage`, which opens the model dialog and ignores the argument ([modelCommand.ts](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/cli/src/ui/commands/modelCommand.ts), [commands reference](https://geminicli.com/docs/reference/commands/), Oct 9, 2026). Without `--persist` the user's saved default is untouched.

Labels come from the id alone (`geminiModelDisplayName`, `model-display-name.ts`), in Gemini's own word order: `gemini-3-flash-preview` reads "Gemini 3 Flash Preview" and `gemini-2.5-pro` "Gemini 2.5 Pro". The shared `humanizeModelId` follows Anthropic's scheme and would move the version to the end. The live telemetry, `modelDisplayName` and `configuredModelFromCommand` all use it. `configuredModelFromCommand` walks the built command's words from the start and reads only the builder's own flags, because Gemini's positional prompt follows them with no `--`: a task text containing `--model x` never seeds a model the session did not run.

## Chat file records

Gemini 0.66.0 writes more than messages to `~/.gemini/tmp/<project>/chats/session-*.jsonl` ([chatRecordingTypes.ts](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/services/chatRecordingTypes.ts)):

- A message appended again under the same `id` replaces the earlier copy in its first place.
- `$patch` sets a message's `content` and its tool calls' `result` by call id, on the patch itself or in each of `updates[]`. A tool's result arrives this way after its call was recorded. `removeIds` deletes messages, and `orderIds` moves the listed ones to the end.
- `$rewindTo: <id>` (written by `/rewind`, or Esc twice) drops that message and everything after it, or everything when the id is unknown.

`parseTranscript` and `readTranscriptPage` apply these as the CLI's own loader does ([`createJsonlRecordAccumulator`](https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/services/chatRecordingService.ts)), within each window they read. A patch for a message an earlier window holds yields that message's results at the patch line, under the message's uuid, so `transcriptEntryKey` (uuid plus call id) dedupes it with any copy the message carries. A rewind whose target is not in the window drops everything the window kept before it, which is the CLI's rule and also right for a tail: the target sits earlier. A page of older history read on its own still shows turns a later rewind dropped. A call with no result, no `resultDisplay` and no finished status yields no result entry, where it used to yield an empty one. Each reply's entry carries `usage` for the turn-usage ledger: fresh input is `input` less `cached` (the Gemini API counts the cached part inside `promptTokenCount`), cache reads are `cached`, output is `output` plus `thoughts`, and there is no cache write. The live telemetry reader applies `$rewindTo`, `removeIds` and `orderIds` too.

## Usage and tool counts

`transcript-usage.ts` reads the chat file through one resumable cursor per path, which keeps a few numbers per message and per call and reads only bytes appended since its last read. Resuming a conversation appends to the same file, so:

- `transcriptUsage` sums each message id's last `tokens` over the whole file: input is `input` (the full input side, cached included), output is `output` plus `thoughts`. Rewinds are not applied, because a rewound turn was still billed.
- `transcriptToolCounts` counts distinct `toolCalls[].id` by tool name, and `transcriptToolResultTokens` estimates each result at four characters a token, results patched in included. Both take a call's own `timestamp` (else its message's) for the run window, so the adapter declares `scopesTranscriptReadsByTime`.

A legacy `.json` session is one pretty-printed document, so it is read whole on any change.

`fileChangeTools` names `write_file` and `replace`, both by `file_path` ([file system tools](https://geminicli.com/docs/tools/file-system/), Apr 10, 2026).

## Settings Merge

Gemini reads settings from `.gemini/settings.json` in the project directory. Unlike Claude's `--settings` flag, Gemini has no way to point to a per-session settings file. Kangentic writes merged settings (event-bridge hooks and / or the Kangentic MCP server entry) directly to `.gemini/settings.json` in the CWD.

The base file is read on every spawn, never cached, so an edit or a pull reaches the next session with no restart. It is the project root's in the main repo, and in a worktree the branch's own copy when git tracks it, otherwise the root's (see below). In the main repo that read finds the file the previous spawn wrote, so it strips Kangentic's own hooks and `mcpServers.kangentic` entry first (`stripKangenticEntries`, the same strip `removeHooks` runs) and the user's content is the baseline. A hook counts as Kangentic's when its command runs one of the bridges (`isKangenticHookCommand`). Gemini's commands name no `.kangentic` path, so they are recognized by the events argument `env:KANGENTIC_EVENTS_PATH` and by the hint spec naming `kangentic_mark_background_service`. Neither depends on the install path, so hooks an earlier install wrote from another path (an AppImage remount, a moved app) are stripped too.

In a worktree the merge writes the worktree's own copy, so a copy git tracks is the branch's and starts the merge (`settingsBaseDirectory` in `src/main/agent/shared/git-exclude.ts`). Starting from the root would replace it with the root's content, and `removeHooks` strips only Kangentic's entries, so the branch would keep the change. A copy git does not track is one an earlier spawn wrote, so the merge starts from the root and a root edit still reaches the worktree. The check is one synchronous `git ls-files` on main (1 s at most), run for a worktree with the file present, whether its checkout brought the file or an earlier spawn wrote it. The merge falls to the root only when nothing tracks the file: git's own answer (exit 1), or a folder that is no git checkout (exit 128 with no `.git`). Anything else keeps the worktree's copy, since falling to the root would be the overwrite. That covers git refusing a checkout (exit 128, as for dubious ownership or a corrupt index), a timeout, and a git that will not start.

Because the file is shared, concurrent Gemini sessions in the same folder are serialized by per-session holds in `GeminiAdapter.hookHolds` (a `SharedFolderHolds`): every `buildCommand` that writes the file (an events pipeline or MCP wiring) holds it under `CommandOptions.ptySessionId`, the id the session spawns under, and `removeHooks(directory, sessionId)` only strips the file when the last session in that folder releases. The key is the session, not the task: a young session's kill leaves its PTY exiting for up to the grace while the task's next session starts, and a task-keyed release let that late exit strip the running session's hooks. A second release of one session (session-manager invokes `removeHooks` both in `suspend()` and from the PTY `onExit` handler) is a no-op. A built command that never becomes a session (an abort, a skipped startup spawn, a failed spawn) releases its hold through `releaseCommandHold` (`src/main/pty/lifecycle/adapter-lifecycle.ts`). On crash or force-quit, the next spawn's read strips any stale Kangentic entries (`stripKangenticEntries`) and `buildHooks` filters them again. `removeHooks` strips the `mcpServers.kangentic` entry alongside the hooks, so the entry and its environment references do not outlive the session. Qwen, Cursor, Droid, Antigravity, Grok, OpenCode and Codex (its legacy `.codex/hooks.json` sweep) hold their shared files the same way.

## MCP Wiring

The merged settings carry an `mcpServers.kangentic` entry using the Gemini-family `httpUrl` key (not the Anthropic/fastmcp `url` used by Claude and Kimi), with `httpUrl` `${KANGENTIC_MCP_URL}` and `headers` `X-Kangentic-Token: ${KANGENTIC_MCP_TOKEN}`. Both values come from the session environment through `buildEnv` (task #859; Gemini expands `$NAME` and `${NAME}` in every settings string), so the file holds no URL and no token, and the entry is per-session. This is the same shape the Qwen fork writes. User-defined `mcpServers` are preserved, and `removeHooks` strips only our entry.

The settings write is gated on hooks **or** MCP, so an MCP-only spawn (no events pipeline) still produces the file.

## Accounts

**Built, not enabled.** Gemini has no card in Settings > Accounts yet. Its account support was written from the bundle and docs with no second Google account to run it on, so the adapter does not declare it. What follows describes it as built ([accounts](../accounts.md), Per agent).

Each extra Gemini account is a folder `GEMINI_CLI_HOME` points at, with its data in the folder's `.gemini` (task #1057, [accounts](../accounts.md), `accounts.ts`). It keeps its own Google login (`oauth_creds.json`, `google_accounts.json`). `tmp` and `history`, which hold every chat and checkpoint, are links into the user's `~/.gemini`. The project registry (`projects.json`) is copied before each spawn, `settings.json` is the user's with the account's own sign-in method, and commands, skills, agents, policies and extensions are linked. An account session reads the trust file Kangentic writes (`GEMINI_CLI_TRUSTED_FOLDERS_PATH`) and keeps its login in a file (`GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=false`).

Gemini has no sign-in command, so Add account starts Gemini itself in the account folder. With no method chosen it opens its own sign-in screen. The user picks Sign in with Google, restarts when asked, and leaves with `/quit`. An account is always a Google sign-in: an API key typed into that screen goes to one keychain entry every home shares. Who is signed in is read from `google_accounts.json`. Gemini has no usage read outside its own screen, so an account shows no usage lines and is never continued at a limit.

Measured on 0.67.0 with no login: a second home whose `tmp` and `history` were links listed and found the first home's session and gave a project the same storage slot. A home with an empty registry claimed the slot of a project folder that had no ownership marker, which is why the registry is copied and a failed copy blocks the account. Not run: the sign-in screen, a chat written through the link by a live session, a resume on a second Google account, and anything on macOS, where the seatbelt sandbox's `.cache/.gemini` is linked whole.

## WSL

A Gemini installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts Gemini's Linux path in a `wsl -d <distro>` shell. `.gemini/settings.json` is shared by every session in the folder, so none of it names one session's path. The hooks call the folder's copy of the WSL hook transport's script, `<cwd>/.kangentic/gemini-wsl-hook.sh` (`copyWslHookScriptInto`), with the same events and directives, since a distro may have no node. The copy finds the session's own folder through `KANGENTIC_WSL_HOOK_DIR`, which Gemini's hooks inherit, as they inherit `KANGENTIC_EVENTS_PATH` for the node bridge. The background shell hint goes through the transport's `reply`. Gemini passes each hook its payload on stdin, which the script's `event` mode reads.

On mirrored networking the MCP entry is the URL one above. On NAT networking the distro cannot reach this machine's loopback, so it is the transport's stdio bridge, `{"command": "sh", "args": ["${KANGENTIC_MCP_BRIDGE_SCRIPT}", "mcp", "${KANGENTIC_MCP_URL}"], "env": {"KANGENTIC_MCP_TOKEN": "${KANGENTIC_MCP_TOKEN}"}}`, every value a reference the session's environment fills (`buildEnv` adds the script's distro path), so the file still holds no token and no session's path. Trust, the chats, the model scan and an answer's chat cleanup read the distro's Gemini directory (its own `GEMINI_CLI_HOME`, else the distro home), keyed by the `/mnt` cwd and compared with Linux case. A removed worktree's trust entry goes from the distro's file while the distro runs. `--help`, a title summary and a Knowledge Graph answer run through `wsl.exe`. Not yet run against a Gemini installed in a distro: the `gemini` on this machine's Ubuntu is the Windows one through interop.

## SSH

A Gemini on a remote host over SSH (#913) runs as `gemini`, found by the host's login `PATH` (`remoteCliName`), so it must be installed and signed in there. Its command and files are checked against a fake host in `tests/unit/gemini-ssh-remote.test.ts`, and Gemini 0.67.0's real chat crossed the real helper and relay in a Linux container, a resume included (`tests/unit/remote-transcript-real-cli.test.ts`). It has not been started by the app on a real host.

- **Synced files.** `remoteFiles()` declares the host's `~/.gemini/trustedFolders.json` (home) and the project's `.gemini/settings.json` and `.kangentic/gemini-wsl-hook.sh` (project). The trust entry for the project folder is merged into the user's file (an explicit deny or a trusted ancestor leaves it alone). The hooks and the `mcpServers.kangentic` entry are merged into the user's project settings, read from the working folder itself, never from another folder of this computer. `GEMINI_CLI_HOME` is not honored on a host. Nothing holds a token: the entry's `${KANGENTIC_MCP_URL}`, `${KANGENTIC_MCP_TOKEN}` and `${KANGENTIC_MCP_BRIDGE_SCRIPT}` come from the session's environment, the last as the script's path on the host. When the session releases, the strip is pushed, so the settings return to what the user had, and a file Kangentic created is removed. The trust entry and the script copy stay.
- **Hooks and MCP** run through the transport script's host path, as in a distro, so the host needs no node. The session relay carries the session's own script and files.
- **The chat is copied.** The host searches every project folder under `~/.gemini/tmp` for the session's `.jsonl` chat (`remoteTranscriptFiles()`), because the folder is the CLI's slug from `projects.json` (`7`, then `7-1` for the next project's worktree 7), not the working folder's name. The copy lands as `session-copy-<first 8 of id>.jsonl` in the folder the readers build from the working folder, so the Conversation viewer, the search index and the ledger find it. A legacy `.json`, which Gemini rewrites whole in place, is never matched. Subagent chats are not carried.
- **Unavailable over SSH.** The session id comes from the id Kangentic chose, the SessionStart hook or the shutdown banner, never from a scan, and the live model and token reader stays off and does not wait. A removed worktree's trust entry is not dropped from the host. A title summary and a Knowledge Graph answer do not run on a host.

Every `~/.gemini` path on this page is Gemini's user directory, `<GEMINI_CLI_HOME>/.gemini` when that variable is set (`geminiHomeDir`, `gemini-home.ts`), the folder Gemini's configuration docs say it creates there. The trust write and removal, the chats, the model scan, the answer chat cleanup and the relocation pass all use it, so trust lands where Gemini reads it. Only an absolute value is taken: a relative one would resolve against the CLI's own working directory, which a global reader does not have.

Two things make this work that are easy to miss:

- **Folder trust is load-bearing.** Gemini disables every configured MCP server in an untrusted folder (`gemini mcp list` reports "MCP servers are configured but disabled because this folder is untrusted", and user-level servers are suppressed too), so the entry would be silently inert. `GeminiAdapter.ensureTrust` pre-populates `~/.gemini/trustedFolders.json` via `trust-manager.ts`. Unlike the Qwen equivalent it does **not** gate on `security.folderTrust.enabled`, because Gemini 0.54.4 enforces trust with that flag unset. It never overrides a user's `TRUST_PARENT` or `DO_NOT_TRUST`, at the path itself or on any ancestor, so a `DO_NOT_TRUST` on the repo suppresses approval for every worktree Kangentic creates beneath it (the same deny rule Codex applies to its project root). It also skips the write when an ancestor is already trusted, so a worktree under an already-trusted repo adds no key at all. When no ancestor is trusted, though, it does record one `TRUST_FOLDER` per task worktree, exactly like Codex - which is why `GeminiAdapter.onWorktreeRemoved` drops that entry again when Kangentic deletes the worktree (`removeWorktreeTrust`). Without it the file grows by a dead entry per task forever, the accumulation that reached 473 entries in Codex's `config.toml`. Removal only ever takes an entry Kangentic could have written itself: a `TRUST_PARENT` or `DO_NOT_TRUST` at that path is a user decision and survives, so a later worktree at the same path still honors it. Ancestor matching folds case only on Windows, since POSIX paths are case-sensitive.
- **No token is on disk.** The file holds only the `${KANGENTIC_MCP_URL}` and `${KANGENTIC_MCP_TOKEN}` references (the values travel in the session environment), but its hook entries still land in `.gemini/settings.json`, which is project-shared and may be intentionally committed, so it cannot be blanket-gitignored like `.kangentic/`. `removeHooks` strips the entry when the folder's last session ends. For the untracked case this is now self-enforcing: when Kangentic creates the file (it did not exist before the spawn), the builder seeds `.gemini/settings.json` and `.kangentic/` into `.git/info/exclude` via the shared `git-exclude.ts` mechanism (see [Antigravity](antigravity.md)), so the file never shows as untracked and cannot ride a `git add -A` into history. A pre-existing file keeps its normal git visibility (the created-by-us carve-out), and ignore rules never affect tracked files - so the rule stands: do not commit `.gemini/settings.json` while a Kangentic-spawned Gemini session is running.

## Parity with Claude Code

Compared member by member with the Claude adapter in 2026-11, against Gemini CLI's docs and its source at v0.66.0. The docs site says Gemini CLI "was replaced by Antigravity CLI on June 18th, 2026", so every citation is pinned to that tag or to a dated docs page.

**Run against the real CLI.** A headless `gemini --session-id <uuid> -p` on 0.66.0 (Windows, 2026-11-03) started under the chosen id and named its chat `session-<time>-<first 8 of the id>.jsonl`, so `supportsCallerSessionId` holds. The API answered 503 to every retry, and the CLI then wrote `$rewindTo: <the prompt's id>` to drop the unanswered prompt. That file is `tests/fixtures/gemini-real-rewind.jsonl`, replayed by `gemini-real-rewind.test.ts`.

**Still not captured: a real tool result.** No real chat file yet holds a `$patch` tool result or a reply's `tokens.cached` and `thoughts`, so those readers rest on the v0.66.0 source alone. A second attempt the same day (a headless run asking for one `read_file`) got no reply: `gemini-2.5-flash` answered 404 ("no longer available to new users"), and the `flash` alias, then `gemini-3.8-flash`, answered 429 for the free tier's 20 requests a day. Both runs wrote only the prompt and a `$rewindTo`, the shape the fixture above already holds. To finish this: in a scratch folder holding one small file, run `gemini --skip-trust --approval-mode plan --session-id <uuid> --model flash -p "Use your read_file tool to read notes.txt, then reply with only the word it contains."`. Then copy its chat file from `~/.gemini/tmp/<folder>/chats/` into `tests/fixtures/` with home paths replaced, and replay it through `parseGeminiTranscript`, `parseGeminiTranscriptWindow` and `geminiTranscriptUsage`.

**Built from documentation, not yet run against the real CLI.** Each comes from the CLI's published docs or source, and each needs a live check:

- `/model set <id>` for the live model swap.
- `$patch`, `removeIds` and `orderIds` in the transcript and the live telemetry, `$rewindTo` in the live telemetry (the transcript readers replay the real rewind above), and per-turn `usage`.
- `transcriptUsage`, `transcriptToolCounts`, `transcriptToolResultTokens` and `scopesTranscriptReadsByTime`.
- `configuredModelFromCommand` and `modelDisplayName`.
- `fileChangeTools`.
- `--include-directories` (`supportsReadableDirectories`).
- `parseTranscriptWindow`, which lets the indexer walk the whole chat, the message trail read what was appended, and a turn end's reply read from its anchor. Patches and rewinds apply within each window. It needs no usage carry: a reply's uuid is its message id, and the ledger upserts by uuid, so a later window's copy updates the same row. It counts the lines before a window only when the window holds a message with no id, the one case whose uuid is its line number.
- `proveConversationGone`. The resume guard already reads the SessionStart hook's `transcript_path` (every hook carries it) from the session's events file. The proof wants that chat missing, the reader's folder holding no file for the id, and no project's `chats` folder under Gemini's `tmp` holding one. Files are matched by the id's first eight characters, as Gemini names them, so a shared prefix keeps the conversation resumable.
- `statSubagentTranscripts` and `parseSubagentUsage`. Gemini 0.66.0 writes a subagent's chat to `chats/<parent id>/<subagent id>.jsonl` with `kind: 'subagent'`, and its replies carry `tokens`. Each reply becomes one ledger row at depth 1. Gemini records neither the subagent's type nor the call that started it, so `agentType` and `parentToolUseId` are null and there are no spawn links.

**Needs a live probe.** These members' own entries say a measurement comes first, or the docs leave the behavior open:

- `getSubmissionVerifier` and `canEscalateOnVerificationFailure`: `BeforeAgent` exists and the chat file records the user turn, but the flush latency is unmeasured.
- `supportsPlanAutoApproval` and `mayApprovePlanTool`: Gemini has no permission hook; its Notification cannot answer a prompt.
- `supportsReadOnlyLaunch`: the Policy Engine (`--policy`) or `tools.core` might restrict the tools, if the user's own settings cannot outrank them.
- `hungTurn`, `consoleCloseIsGraceful` and the exit sequence: `\x03` then `/quit\r` may approve an open confirmation dialog, the failure Claude's old sequence had.
- `describeStartupFailure`: a `--resume` of a chat that `general.sessionRetention` deleted after 30 days fails, but a recognizer needs wording seen on a real card.
- `openAnswerSession`: only `--experimental-acp` (JSON-RPC over stdio) keeps a process warm.
- `pastedImageReferenceTemplate` (an `@path` reference) and `firstPromptMayBeTyped`.

**Not supported by the CLI:**

- The `dontAsk` and `auto` permission modes. `--approval-mode` takes `default`, `auto_edit`, `yolo` and `plan` only.
- Effort: no flag and no slash command.
- A model list: no flag lists models, so discovery stays the history scan.
- Context window, cost and rate limits: there is no status line, and the chat file and hooks carry tokens only.
- Subagent, interrupt and turn-failure hook events. The [hooks reference](https://geminicli.com/docs/hooks/reference/) lists none.
- `subagentSpawnToolName`: Gemini exposes each subagent as a tool of its own name, so there is no single spawning tool to name, and no record links a subagent's chat to the call that started it.
