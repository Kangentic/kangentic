---
type: Reference
title: OpenCode
description: OpenCode's activity plugin copied into .opencode/plugins (tool calls, and question and permission waits), the --auto flag Kangentic does not pass, session ids from an opencode.db SQLite poll or ses_ output scan, --prompt because the positional argument is a directory, OPENCODE_CONFIG_CONTENT for MCP, remote mode through opencode attach with no plugin or MCP, and OpenCode 2's --standalone launch with the agent and model in config.
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
- **Model picker.** V2's root `--help` has no `--model`, so capability discovery reports the model override as supported on V2 without reading the help.
- **Remote mode** with a local OpenCode 2 is blocked: the remote spawn is OpenCode 1's `opencode attach <url>`, which OpenCode 2 does not have. The spawn fails with "OpenCode remote mode needs OpenCode 1", and "Test connection" with a local V2 gives the same answer before it asks the server. The V2 server client and the connection test's naming of a V2 server are described under Remote Execution below.
- **Telemetry.** OpenCode streams no token usage to Kangentic on either major, so the adapter declares `liveTelemetryUnsupported` ("Telemetry: TUI only") and the card no longer shows "Starting agent..." for the whole session.

## Permission Modes

The `permissions` list exposes two entries in OpenCode's own vocabulary: `plan` (label "Plan", OpenCode's built-in read-only agent) and `acceptEdits` (label "Build", full tool access). The stored `PermissionMode` enum values are reused for compatibility, so a swimlane set to `acceptEdits` under Claude continues to mean "Build" under OpenCode. On a fresh OpenCode 1 spawn the mode sets OpenCode's `--agent` (on OpenCode 2, `default_agent` in the inline config): `plan` gives `--agent plan`, `acceptEdits` and `bypassPermissions` give `--agent build`, and `default`, `dontAsk` and `auto` give no flag, deferring to the user's `default_agent`. A resume passes only `--session <id>`, because the saved session already has an agent and the user may have switched it with Tab. OpenCode 1.18.31's TUI does have an auto-approve flag, `--auto` ("auto-approve permissions that are not explicitly denied (dangerous!)"), which Kangentic does not pass: `bypassPermissions` still maps to `--agent build`, and auto-approval is the user's choice in OpenCode (the flag, or `opencode.json`). `bypassPermissions`, `default`, `dontAsk` and `auto` sit outside the `permissions` list and are still accepted by `mapPermissionModeToAgent` for mixed-agent projects. The default mode is `acceptEdits`.

## Settings Merge

None. OpenCode reads MCP and provider configuration from `opencode.json` (project) or `~/.config/opencode/opencode.json` (global). `removeHooks` only removes the activity plugin (next subsection). The Kangentic MCP server IS wired in for a local-mode spawn - `buildOpenCodeEnv` (`command-builder.ts`) emits an inline `mcp.kangentic` entry via the `OPENCODE_CONFIG_CONTENT` env var per PTY spawn, deep-merged over the user's own config so their `mcp.*` entries are preserved (see [How the MCP server works](../mcp-server/how-it-works.md)). It is NOT wired in for a remote-mode spawn (`opencode attach <url>`) - see the Remote Execution subsection below.

## Activity Plugin

OpenCode 1 local-mode spawns install the Kangentic activity plugin by copying the packaged `kangentic-activity.mjs` into `<projectRoot>/.opencode/plugins/` as `kangentic-activity.js`, where OpenCode auto-discovers plugins at TUI startup. An OpenCode 2 spawn installs `kangentic-activity-v2.mjs` as `.opencode/plugins/kangentic-activity/index.js` instead (see OpenCode 2 above), held and removed the same way. The extension decides whether OpenCode loads it. OpenCode 1.18.31's loader reads only `{plugin,plugins}/*.{ts,js}` (read from its binary), and its Bun runtime loads ES module syntax from a `.js` file. Earlier builds installed the `.mjs` name, which OpenCode never loaded, so every OpenCode session ran on the PTY fallback alone. The installer and `removeHooks` delete such a leftover `.mjs`. Measured on 1.18.31 with the `.js` name: the plugin wrote `session_start` and the turn's `idle` lines. No live capture of a question or permission wait exists yet.

The module exports the plugin and nothing else. The loader calls every export value as a plugin factory and throws on one that is not a function, so the pure helpers ride on the plugin as `KangenticActivity.helpers` for the tests.

The copy is byte-compare idempotent, and removal of either name verifies a sentinel comment on line 1 so a user-authored plugin at the same path is never touched. The plugin runs inline in the OpenCode process and writes activity events straight to the session's `events.jsonl`, reading its output path from the `KANGENTIC_EVENTS_PATH` env var exported by the PTY spawn flow. Note the install lands at the PROJECT ROOT, not the task worktree. Concurrent sessions in one project hold the plugin per session (`OpenCodeAdapter.hookHolds`), and the hold records the project root, so a worktree session's release (which names the worktree) removes the plugin once the root's last session ends.

The plugin also reports the waits on the user (GitHub #452), from its `event` hook, which OpenCode calls with every event for its directory and no type filter (`packages/opencode/src/plugin/index.ts` in 1.18.31). `question.asked` writes the permission `idle` tagged `waitKind: 'question'`, and `permission.asked` the same tagged `'approval'` (type strings from OpenCode's `packages/schema/src/v1/question.ts` and `v1/permission.ts`). OpenCode publishes both from inside the tool's own execution: it triggers `tool.execute.before`, runs the tool, whose `ask` publishes the request, then triggers `tool.execute.after`, also after a throw. So the wait lands after the tool's `tool_start` and the tool's `tool_end` ends it. The answers (`question.replied`, `question.rejected`, `permission.replied`) are logged as notifications only; a rejection ends the tool or the turn, whose next `tool_start` or `session.idle` clears the wait. OpenCode 2 does not run this plugin; its own reports the same waits (see OpenCode 2 above).

The plugin file is hidden from git via the shared `.git/info/exclude` mechanism (`src/main/agent/shared/git-exclude.ts`, see [Antigravity](antigravity.md)), seeded only once the plugin file actually exists at the destination so a failed copy never leaves an entry pointing at a missing file. Earlier releases appended the entry to the project's tracked `.gitignore` instead, which dirtied the user's checkout. A line those releases appended is left in place. It names the old `.mjs` path, so the exclude entry alone hides the `.js` copy. The OpenCode 2 plugin directory is hidden the same way, under `.opencode/plugins/kangentic-activity/`.

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

## SSH

An OpenCode on a remote host over SSH (#913) runs as `opencode`, found by the host's login `PATH` (`remoteCliName`), so it must be installed and signed in there. This is a different feature from Remote Execution below, which attaches to a server you run yourself. It is checked only against a fake host in `tests/unit/opencode-ssh-remote.test.ts`, never against a real OpenCode or host.

- **Version.** The host's CLI is never detected here, so `ensureTrust` runs `opencode --version` on the host once and the builders pick OpenCode 1 or 2 flags from it. If that fails, the spawn goes on with OpenCode 1's command line.
- **Synced files.** `remoteFiles()` declares `.opencode/plugins/kangentic-activity.js` (OpenCode 1) and `.opencode/plugins/kangentic-activity/index.js` (OpenCode 2). Only the one for the host's major is written, and it is removed again, or never kept, when the session releases. A remote task has no worktree, so the plugin goes in the working folder.
- **Activity.** The spawn exports `KANGENTIC_WSL_HOOK_DIR` and not `KANGENTIC_EVENTS_PATH`, since that path would name a file on this computer. With only the hook folder set, both plugins publish each event as a record in the transport's format (`inbox/<19-digit time and sequence>-<pid>.rec`, written under a dot name and renamed, then a byte to `signal`). The host's helper sends the records back and the existing inbox reader turns them into the same `events.jsonl` lines a direct append makes, so turn ends, waits on the user and the session id (`session_start`) arrive as locally. With an events path set (this computer, a WSL distro) the plugins append as before.
- **MCP** is `OPENCODE_CONFIG_CONTENT` in the spawn environment: the `local` entry for the transport's stdio bridge, named by its path on the host.
- **Unavailable over SSH.** The session id is not polled from `opencode session list`, because a place read back from a session row has no connection to the host to run it through, and `distro-sessions.ts` has no live place to run `export` against either. So the transcript, the Conversation viewer, the auto_command check (reported as failed, with escalation off) and handoff history show nothing. `probeAuth` and `onProjectRelocated` look at this computer only.

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
- **No status.json pipeline:** activity is `hooks_and_pty` - the activity plugin's events are authoritative when they fire, and PTY-silence detection (`PTY_SILENCE_THRESHOLD_MS`, same `PtyActivityTracker` shape as Codex) is the fallback tier for sessions without the plugin (remote mode, failed install). OpenCode has no statusline, so there is no `status.json` pipeline.
- **No trust dialog:** `ensureTrust` is a no-op. OpenCode does not prompt for directory trust on first run.
- **Remote mode is single-directory per project:** the server working directory is per-project, not per-task, so concurrent remote tasks in the same project share one directory. Per-task remote worktrees would require remote git operations (OpenCode's `POST /session/:id/shell` is the mechanism, if pursued later).
