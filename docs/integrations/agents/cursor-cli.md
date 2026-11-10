---
type: Reference
title: Cursor CLI
description: Cursor CLI detection that probes cursor-agent before the agent alias Grok also installs, confirm-changes, --force skip-approval and --mode plan sessions, and -p --trust stream-json commands, activity hooks in the project .cursor/hooks.json gated to session screens, turn ends from the stop hook and the stream-json result event, --model ids resolved from display names, --resume=id quoting, the project .cursor/mcp.json with --approve-mcps, create-chat session ids before an interactive session opens, structured transcripts read from agent-transcripts jsonl with the user_query wrapper removed and no clock, and which parts were built from Cursor's docs without a live run.
tags: [agents, adapter, cursor]
sources:
  - resource: src/main/agent/adapters/cursor/cursor-adapter.ts
  - resource: src/main/agent/adapters/cursor/hook-config.ts
  - resource: src/main/agent/adapters/cursor/project-mcp-config.ts
  - resource: src/main/agent/adapters/cursor/answer-workspace.ts
  - resource: src/main/agent/adapters/cursor/stream-parser.ts
  - resource: src/main/agent/adapters/cursor/session-paths.ts
  - resource: src/main/agent/adapters/cursor/transcript-parser.ts
  - resource: src/main/agent/adapters/cursor/capability-discovery.ts
---
# Cursor CLI

## CLI Detection

Detection uses the shared `AgentDetector` with binary name `cursor-agent` and `binaryAliases: ['agent']`.

Cursor installs BOTH shims, and the short one is not its alone: xAI's [Grok CLI](grok-build.md) also installs `agent`, and on Windows its `agent.exe` beats Cursor's `agent.cmd` in PATHEXT order. Detecting on `agent` therefore made Cursor **undetectable** on any machine that also had Grok - the probe resolved, ran Grok's binary, and Cursor was reported missing. Probing the unambiguous name first is the fix; the alias keeps working where only `agent` exists.

Two supporting details make the fallback safe. `parseVersion` accepts `1.0.0`, `agent 1.0.0`, or `Cursor Agent 1.0.0` and rejects anything else, so Grok's own version banner fails the probe rather than passing as Cursor. And the PATH loop CONTINUES to the next candidate when a name resolves but fails its version probe, instead of aborting - without that, finding Grok's `agent` would still end the search. Pinned by `tests/unit/cursor-grok-binary-collision.test.ts`.

## Command Building

`src/main/agent/adapters/cursor/cursor-adapter.ts`

### New Session (Interactive)

```
agent "prompt text"
```

User confirms changes in the PTY. `permissionMode === 'default'`.

### New Session (Interactive, skip approvals)

```
agent --trust --force "prompt text"
```

Selected when `permissionMode === 'acceptEdits'`. The session screen stays open. `--force` (alias `--yolo`) allows commands unless one is explicitly denied. `--trust` skips the workspace prompt. This mode prints no stream-json, so `agent about` seeds the model pill (unless the start passed `--model`, see [Model seed](#model-seed)) until the TUI status bar paints (`Composer 2.5 · 7.8%`). That bar is the live model and the occupancy percent, the same as confirm-changes. A resume is `agent --trust --force --resume="<chat-id>"`.

### New Session (Interactive, plan)

```
agent --trust --mode plan "prompt text"
```

Selected when `permissionMode === 'plan'`. Cursor's plan mode "designs your approach before coding
with clarifying questions" ([Modes](https://cursor.com/docs/cli/overview), `--mode plan` in the
[CLI parameters](https://cursor.com/docs/cli/reference/parameters), a startup flag since the
January 2026 changelog). The session screen stays open, and Cursor's own plan review and Build run
in it. No plan exit reaches Kangentic. The docs name neither the plan tool nor a plan-approval
hook, so a plan column does not auto-move and offers no Automatic approval. A resume is
`agent --trust --mode plan --resume="<chat-id>"`. The parameters page still marks `--trust`
"headless mode only", but the v2026.07.20 changelog says "Previously `--trust` required headless
mode", and skip-approvals already passes it to the session screen.

### New Session (Non-Interactive)

```
agent --trust -p "prompt text" --output-format stream-json
```

Selected when `nonInteractive` is set, and for every permission mode but `default`, `acceptEdits` and `plan`. That is `bypassPermissions`, the one such mode Cursor's list offers, and `dontAsk` and `auto`, which it does not. Cursor has no flag for either: its `approvalMode: auto-review` lives only in the global `cli-config.json` ([Configuration](https://cursor.com/docs/cli/reference/configuration)), which Kangentic does not rewrite. They stay on this path because the init event is the only documented place the model and session id arrive together. Has full write access. A directory Cursor has not seen prints "Workspace Trust Required" and exits. `--trust` skips that prompt. The NDJSON `init` event carries `session_id`, which `runtime.sessionId.fromOutput` captures for resume. A resume keeps `--trust` too. Every resume opens the session screen whatever its mode, because `buildCommand` returns before `-p` is added. A headless answer run that streams adds `--stream-partial-output`.

### Resumed Session

```
agent --resume="<chat-id>"
```

A resume from Non-Interactive mode is `agent --trust --resume="<chat-id>"` and opens the session screen, not a print run. A Skip Approvals resume is `agent --trust --force --resume="<chat-id>"`, and a plan resume is `agent --trust --mode plan --resume="<chat-id>"`. The `=` sits outside the quote boundary (`--resume='id'` on unix, `--resume="id"` on Windows).

A resume carries no prompt. Nothing Cursor documents says a prompt rides `--resume=<id>`, so the adapter declares `resumePromptDelivery: 'typed'`: Kangentic types a resume's message (a column's message, held messages) in once Cursor is ready. See [How the resume prompt arrives](../../architecture/sessions/resume.md#how-the-resume-prompt-arrives).

## Accounts

Each extra Cursor account in Settings > Accounts is a key file the user owns ([accounts](../accounts.md)). A session on one gets the file's `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` in its env, and Kangentic stores only the file's path and the names in it. The browser login is one per machine and stays account #1. A key file adds one variable to a session and moves nothing, so conversations stay where they are. Built from the documented variable and not run with a second key.

## WSL

A distro session screen's hooks run the WSL hook transport rather than the node bridge (see
[Hooks](#hooks)).

A Cursor installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts Cursor's Linux path in a `wsl -d <distro>` shell. `create-chat`, `about`, `--help`, `--list-models`, a title summary and a Knowledge Graph answer all run through `wsl.exe`. `about` asks the CLI the session was started with, not the Cursor on PATH, which on a machine with both installed reported the Windows Cursor's model for a distro session.

Kangentic's MCP server stays a static entry in the project's `.cursor/mcp.json`. On mirrored networking the distro reaches this machine's loopback, so the entry is the URL one. On NAT networking it is the WSL hook transport's stdio bridge (`CURSOR_KANGENTIC_BRIDGE_MCP_ENTRY`): `sh` with the script, `mcp` and the URL, and the token in the server's `env`. The script path, URL and token are `${env:...}` references, filled from the session's `KANGENTIC_MCP_BRIDGE_SCRIPT`, `KANGENTIC_MCP_URL` and `KANGENTIC_MCP_TOKEN`, which cross into the distro through `WSLENV`. That Cursor fills references in `command`, `args` and `env` comes from Cursor's MCP docs ("Config interpolation"); only the `url` and `headers` case was measured, by the answer path. The CLI path is the project's, so every session sharing a folder shares the entry.

A Knowledge Graph answer from a distro starts in a stable folder beside the shared answer home, `<home>-wsl-<distro>` (`cursorAnswerHome`), so its entry never overwrites the one a Cursor on this machine reads. Beside it rather than inside, in case Cursor looks for a `.cursor` folder above the one it starts in. Its chat is removed from the distro's `~/.cursor/chats`. Not yet run against a Cursor installed in a distro.

## SSH

A Cursor on a remote host over SSH (#913) runs as `cursor-agent`, found by the host's login `PATH` (`remoteCliName`). `agent`, the installer's other name, is shared with Grok's CLI, so it is not used. Cursor must be installed and logged in on the host. The spawn, files and `create-chat` path are checked against a fake host in `tests/unit/cursor-ssh-remote.test.ts`. The transcript copy is checked in `tests/unit/cursor-ssh-transcript.test.ts` against the same record shape a local transcript showed. Neither has run against a real Cursor or host.

- **Synced files.** `remoteFiles()` declares the project's `.cursor/mcp.json`, `.cursor/hooks.json` and the folder's copy of the hook transport's script (`.kangentic/cursor-wsl-hook.sh`). Kangentic's hook entries are merged beside the user's, run that script on the host, and publish only for a session that carries `KANGENTIC_EVENTS_PATH_INTERACTIVE` (set to `1`, as for a distro). They are taken out again when the session releases. In `.cursor/mcp.json` the static entry is merged beside the user's servers, and a file that is not JSON Kangentic can merge into (comments, say) is left as written and the session starts without Kangentic's tools. Trust is the `--trust` flag, so there is no trust file. The entry is the WSL hook transport's stdio bridge, and its script path, URL and token are `${env:...}` references filled from the spawn environment, so the file holds no secret. The file is restored when the session releases, and removed again if Kangentic created it.
- **Interactive starts.** `createSessionId(cliPath, workingDirectory, place)` runs `cursor-agent create-chat` on the host in the project's folder there, through the helper, when it is given the host's place. A chat made by a Cursor on this computer would be unknown to the host's Cursor. Both spawn paths pass the place to `resolveFreshAgentSessionId`, so an interactive start on a host makes its chat there.
- **Transcript.** `remoteTranscriptFiles()` names the one file Cursor appends to under `~/.cursor/projects/<slug>/agent-transcripts/<id>/`, in this computer's mirror of the host's home, filed under the slug of the folder on the host ([SSH remote hosts](../../platforms/ssh-remote.md#transcripts)). `create-chat` writes nothing until the first turn, so the copy is empty until then. The viewer, the index and the ledger then read it as they read a local one. Subagent transcripts are not carried. Activity comes from the hooks above, with the PTY and the stream-json parser as the fallback.

## Model override

`--list-models` prints `cursor-grok-4.6-high - Grok 4.6`. The picker shows the display name. A live session's stream-json init event and `agent about --format json` report that display name as `model`, not the id. A column that stored `grok 4.6 high` used to be passed through as `--model "grok 4.6 high"`, which the CLI rejects.

`resolveCursorModelId` maps the stored value onto the last `--list-models` catalog before `--model` or `/model` is emitted: exact id, display name, dashes-as-spaces, then a unique `cursor-` prefix or unique suffix. The stream-json init event, the interactive TUI status bar, and `agent about` keep the display name on the pill and store the resolved id. Display names with spaces are not written into `discoveredModelsByAgent`, so they do not reappear as picker rows.

## Permission Modes

| Mode | Behavior | Cursor Mode |
|------|----------|-------------|
| `default` | (no special flag) | Interactive (Confirm Changes) |
| `acceptEdits` | `--trust --force`, session screen stays open | Interactive (Skip Approvals) |
| `plan` | `--trust --mode plan`, session screen stays open | Plan (Read-Only) |
| `bypassPermissions` | `--trust -p ... --output-format stream-json` | Non-Interactive (Full Access) |

## Model seed

A start with a column model passes `--model <id>`, and `configuredModelFromCommand` reads it back
so the pill names that model at once, with the display name the last `--list-models` catalog gave
the id. Such a start skips the `agent about` seed, because `about` reports the account's default
model, not the one passed, and would replace the column's model until the TUI status bar paints.
The skip follows the same read of the built command as the seed, so a command it cannot read the
flag from is seeded by `about`, as a start with no model is.

## Hooks

`hook-config.ts`. Built from Cursor's [hooks reference](https://cursor.com/docs/hooks) and the
[CLI changelog](https://cursor.com/docs/cli/changelog) (hooks in the CLI since January 2026, "Hooks
fire reliably" in April 2026, post-tool hooks for subagents in v2026.10.17). It has not run against
a real Cursor, and no run is planned.

The CLI takes no flag naming a hooks file, so Kangentic merges its entries into the project's
`<cwd>/.cursor/hooks.json` (`{ "version": 1, "hooks": { "<event>": [{ "command", "timeout" }] } }`)
beside the user's own, as with `.cursor/mcp.json`. A file Kangentic creates is git-excluded and gets
the `version`. A user's file keeps its own top-level keys and hook entries through the strip, which
rewrites it as 2-space JSON and drops a `hooks` object left empty. A file left with no hooks and at
most a `version` is deleted, which also takes a user's file that held nothing else. A
file it cannot parse is left alone (that start runs on terminal activity), and the entries are
stripped when the folder's last session holding them exits. The reference says project hooks run
in a trusted workspace, so a confirm-changes session gets none until its workspace prompt is
answered.

Every command is `node "<event-bridge.js>" "env:KANGENTIC_EVENTS_PATH_INTERACTIVE" <event-type>
<directives>`. The reference says the desktop app runs hook commands through PowerShell on Windows
and names no rule for the CLI, so each command works in PowerShell, Git Bash and a POSIX shell.
`KANGENTIC_EVENTS_PATH_INTERACTIVE` is set by `buildEnv` only for a session-screen start:
confirm-changes, skip-approvals, plan, and every resume, which returns before `-p` is added and so
opens the session screen whatever its mode. A print run reports on stream-json instead,
and a user's own Cursor in the folder carries no variable, so for both the bridge writes nothing and
no tool call is counted twice. The spawn sets `KANGENTIC_EVENTS_PATH` for every session after the
adapter's variables, which is why that one cannot be the gate. The name keeps
`env:KANGENTIC_EVENTS_PATH` as its prefix, so the shared `isKangenticHookCommand` recognizes an entry
an earlier install wrote from another bridge path.

| Cursor hook | Event | Read from the payload |
|---|---|---|
| `sessionStart` | `session_start` | the whole payload as `hookContext`; `session_id` feeds `runtime.sessionId.fromHook` |
| `sessionEnd` | `session_end` | |
| `beforeSubmitPrompt` | `prompt` | replies `{ "continue": true }` |
| `preToolUse` | `tool_start` | `tool_name`, `tool_use_id` |
| `postToolUse`, `postToolUseFailure` | `tool_end` | `tool_name`, `tool_use_id` |
| `subagentStart` | `subagent_start` | `subagent_id`, `subagent_type` |
| `subagentStop` | `subagent_stop` | `subagent_type` (no id: the stop is counted, not matched) |
| `preCompact` | `compact` | |
| `stop` | `idle`; `interrupted` for `status: aborted`; `turn_failed` for `status: error` | `status` |

No hook answers for the user. `preToolUse` and `subagentStart` print nothing, because a `permission`
there would decide what confirm-changes leaves to the person. The reference blocks a permission hook
on invalid JSON, on a response that fails the hook's schema, and on exit code 2. It does not block on
silence: its `audit.sh` prints nothing from `beforeShellExecution`, also a permission hook, and
`failClosed` lists "no output" as a failure that blocks only when set. Printing `{}` would be
riskier, since `permission` is not marked optional. This has not been run.

A Cursor installed in a WSL distro may have no node, so its hooks run the WSL hook transport
instead: `if [ -n "$KANGENTIC_EVENTS_PATH_INTERACTIVE" ]; then sh '<cwd>/.kangentic/cursor-wsl-hook.sh'
event <type> <directives> || true; fi`, with the paths as the distro sees them. The folder copy of
the script finds each session's own transport folder through `KANGENTIC_WSL_HOOK_DIR`, which the
spawn sets for every distro session, print runs included, so the shell test of the gating variable
is what keeps a print run silent. There the variable is the flag `1`, since no path needs to cross.
The `|| true` keeps the hook at exit code 0. A distro's `sh` (dash) exits 2 on a script it cannot
open (measured), and an `if` returns that status, so without it a lost folder copy would deny every
tool call in the session. `beforeSubmitPrompt` prints its `{ "continue": true }` after the `if`. That
Cursor runs a hook command through a shell on Linux comes from the hooks reference ("a shell string")
and has not been run in a distro.

## Turn end

`reportsTurnEnd` is true, so a Cursor column offers On agent turn end automations and a workflow
task on Cursor advances on its own. A session screen's turn end is the `stop` hook. A print run's is
stream-json's terminal `result` event, which `stream-parser.ts` turns into an `idle` event ("The
stream ends with a terminal `result` event on success",
[Output format](https://cursor.com/docs/cli/reference/output-format)). A failed print run exits
without one, and its exit ends the session. Neither source has been seen against a real Cursor. A
missed `stop` leaves the card thinking until the stale-thinking reclaim.

## Limitations

- No wait on the user is reported. The hooks reference has no event for the AskQuestion tool or an
  approval prompt, and the April 2026 changelog reports those waits only as desktop notifications,
  so a Cursor wait stays on the envelope (GitHub #452).
- No statusline. Cursor's custom `statusLine` (April 2026 changelog) is global-only config (the
  [Configuration](https://cursor.com/docs/cli/reference/configuration) page lets a project file set
  only permissions), its payload is described only in community copies of Cursor's own skill, and a
  forum report says it replaces the native footer the stream parser reads. Interactive occupancy
  and the live model are read from the TUI status bar (`Composer 2.5 · 7.8%`) in
  `stream-parser.ts`. `agent about` is only the seed until that bar paints.
- A hook's `transcript_path` is not recorded as the session's reported history path. The reported
  path lives on the session's usage, which only a status line or stream output fills, and neither
  sees a hook payload, so recording it needs a change in the shared telemetry. The locator's derived
  `agent-transcripts` path does not need it.
- No token counts, cost or rate limits. The February 2026 changelog says stream-json carries
  per-turn input, output and cache totals, but the output-format page names no field, so nothing is
  read until a run shows them. Plan usage shows only in the `/usage` TUI (July 2026).
- `.cursor/hooks.json` holds one place's commands at a time. The last Kangentic start in a folder
  writes either the node commands or the WSL shell commands, and Kangentic's own sessions there
  share one CLI path, so they agree. A user who runs a Cursor of the other place by hand in that
  folder while a session holds the file gets hook errors there, since Windows PowerShell cannot run
  the WSL form and a distro with no node cannot run the other. A committed `.cursor/hooks.json`
  shows Kangentic's entries in `git status` while a session holds it, as a committed
  `.gemini/settings.json` does for Gemini.
- No settings file beyond the project's `.cursor/hooks.json` and `.cursor/mcp.json` entries. Workspace trust is the `--trust` flag on every spawn except confirm-changes (and on those resumes), not a file Kangentic writes. Confirm-changes leaves Cursor's own prompt so the user can decide.
- Kangentic's MCP server reaches every session through the project's `.cursor/mcp.json` (a static
  `${env:...}` entry beside the user's servers, `project-mcp-config.ts`) and `--approve-mcps`, which
  also approves the user's own project servers for that run. The entry is removed when the last
  session in the folder exits. A `.cursor/mcp.json` Kangentic cannot parse as a JSON object (one
  with comments, say) is left untouched, and that start gets neither the entry nor
  `--approve-mcps`; a workflow's agent refuses to start there and says why.
- Interactive mode prints no session id. A fresh interactive start (a task, startup recovery, a
  Command Terminal, or a workflow's agent) asks Cursor for one first: `createSessionId` runs
  `cursor-agent create-chat` in the working directory (measured: it prints the bare UUID and writes
  nothing under `~/.cursor`), and the start opens that chat with `--resume=<id>`. A print start
  (`-p` and `stream-json`) still takes the id from the init event and does not create a chat first.
  A workflow's agent creates one on every fresh start, print included. Whether `--resume` of a chat
  made this way keeps the interactive session across a Pause has not been run live yet.
- A task that leaves its column before that chat's first turn lands (a confirm-changes start
  still at Cursor's workspace prompt, say) resumes the empty chat, and the task prompt is not sent
  again. The resume guard starts over only on the agent's own report that nothing happened, and
  Cursor reports nothing, so its verdict stays `unknown`. Reading the derived `agent-transcripts`
  path as that report is the guard that #255 reverted.
- The `create-chat` wait runs inside the task lock, so it races the spawn's abort signal: a move
  that aborts the spawn stops waiting at once, and the CLI run ends on its own 20 s timeout.
- No `transcript-cleanup.ts` (uses streaming text output, not a TUI alternate screen)
- `locateSessionHistoryFile` returns
  `~/.cursor/projects/<cwd-slug>/agent-transcripts/<sessionId>/<sessionId>.jsonl` when that file
  exists, else the path the agent itself reported when that file exists. The slug is Cursor's own: non-alphanumeric characters become `-`, runs of dashes
  collapse, and case stays as the working directory was given. View conversation reads that
  JSONL. A user line's `<timestamp>` tag is dropped and not shown as a clock (`ts: 0`,
  `transcriptHasTimestamps` false), and the `<user_query>` wrapper is removed. A line whose
  whole body is one `<task>` element is unwrapped once more. There is still no
  `command-injection` verifier: the records have no timestamp field, so a confirm cannot bound
  itself to "written after send", and the stored text is not the raw submitted text. See
  [Cursor](../../architecture/automations/command-injection-support-matrix.md#cursor-located-not-yet-verified).
  The `beforeSubmitPrompt` hook writes a `prompt` event for a session screen, a candidate source
  for one if a live run ever shows it fires on a typed command.

## Built from documentation, not run against Cursor

This project has no Cursor plan, so Cursor is built from its official docs alone and no capture is
planned. Each item below comes from Cursor's docs as fetched on 2026-11-03, with the changelog at
v2026.10.22:

- The hooks file, its gating variable and the event map (`hook-config.ts`):
  [hooks reference](https://cursor.com/docs/hooks), [changelog](https://cursor.com/docs/cli/changelog)
  January 2026, April 2026, v2026.10.17.
- `reportsTurnEnd` and the `stop` hook's turn end. This turns on On agent turn end automations and
  workflow advancement for every Cursor user, and the forum has reported hooks not firing on some
  Linux and Windows builds. The terminal stays the activity fallback until a hook arrives.
- The print run's turn end on the `result` event, read only after that stream's `system/init`
  line, so a JSON line in a session screen's own text never ends a turn:
  [output format](https://cursor.com/docs/cli/reference/output-format).
- `runtime.sessionId.fromHook` on `sessionStart`'s `session_id` ("same as `conversation_id`", hooks
  reference). `create-chat` still supplies the id first. This read covers a start where it failed.
  The capture is one-shot: the session's first `sessionStart`, the main agent's own, is read, and
  an id that differs from `create-chat`'s replaces it as the CLI's own report.
  `capturesInteractiveSessionId` stays undeclared until a run shows the hook fires.
- Plan mode (`--mode plan`): [CLI parameters](https://cursor.com/docs/cli/reference/parameters),
  [Modes](https://cursor.com/docs/cli/overview), changelog January 2026 and v2026.07.20.
- The model seed from `--model`: CLI parameters.

`tests/fixtures/cursor-docs/` holds Cursor's published examples, copied verbatim on 2026-11-03: the
hooks reference's input blocks and the output format's example sequence. They are not captures.
`cursor-hook-config.test.ts` replays every hook Kangentic registers through the real event bridge,
and `cursor-stream-parser.test.ts` replays the sequence. That proves the code reads the fields
Cursor publishes. It does not prove that a given Cursor build fires a hook or sends those fields.
The hook examples are schemas with placeholders, so the docs print no real `session_id`, and its
UUID shape comes from the output format's sequence.

`reportsTurnEnd` stays true on the docs' word, because this project builds what the docs support.
The terminal carries activity until the first hook arrives, and the stale-thinking reclaim returns
the card to idle after a `stop` that never comes. That reclaim is a watchdog guess, not a turn end
(`turn-end-runner.ts`), so on a build where hooks do not fire, a Cursor column's On agent turn end
rows never run and its workflow tasks wait. The alternative was to keep it false until a capture,
which would leave every Cursor column with no On agent turn end automations and its workflow tasks
advancing only by hand.

## What a capture would check

No capture is planned. If one ever runs, these are its steps. The hooks come first, because every
turn end on a session screen rests on them. On a machine with Cursor signed in (`cursor-agent
login`, not `agent`, which can be Grok's CLI, see [CLI Detection](#cli-detection)), run one
session-screen turn and one print turn that call a shell tool, in a scratch folder whose
`.cursor/hooks.json` dumps each hook's stdin to a file.

- Confirm that the hooks fire on the session screen at all, and that a hook command inherits the
  session's environment. The reference lists the variables Cursor adds and does not say the rest
  pass through, and the gating variable rests on that.
- Confirm that Cursor loads a hooks file with no `version` key. The reference marks `version`
  required, and a user's file keeps its own keys as they are, so a session in a folder whose file
  has none may get no hooks.
- Confirm `sessionStart.session_id`, `tool_name` and `tool_use_id`, and `stop.status`
  (`completed`, `aborted`, `error`).
- Pin the sanitized payloads and the print run's `init` and `result` lines under `tests/fixtures/`
  beside the published examples, and replay them in `cursor-hook-config.test.ts` and
  `cursor-stream-parser.test.ts`.
- Fix `buildCursorHookCommands` if a field differs. If no hook fires on the session screen, set
  `reportsTurnEnd` back to false.

A CLI that is not signed in cannot stand in. On v2026.09.26 a print run with no login exits on
"Authentication required" before any hook fires, `sessionStart` included. `cursor-agent status` is
no proof of a login. It has reported one while a `-p` run in a scratch folder still stopped at
"Authentication required", so a capture would confirm its login with a `-p` run first. A capture
would then replace the sections above with what it confirmed.

These members are measured before an adapter declares them, so the docs alone do not build them:
`supportsReadOnlyLaunch` (`--mode ask`, "read-only exploration without making changes"),
`pastedImageNativeExtensions` (Ctrl+V pastes a clipboard image since April 2026, and a copied image
file attaches on macOS since v2026.06.09; a pasted path was probed negative on 2026.09.10),
a `command-injection` verifier and `canEscalateOnVerificationFailure` (on the `beforeSubmitPrompt`
event above), `consoleCloseIsGraceful`, `hungTurn`, `firstPromptMayBeTyped`,
`describeStartupFailure`, and the stream-json token field names.

## Not supported by the CLI's docs

- Plan exit, `supportsPlanAutoApproval` and `mayApprovePlanTool`: no plan tool name or plan
  approval hook is documented.
- Background commands: no background field on a Shell call's `tool_input`.
- `transcriptUsage`, `transcriptToolCounts` and the subagent transcript readers: the
  `agent-transcripts` format is undocumented (subagent files live under
  `agent-transcripts/<parent>/subagents/` since v2026.10.17, format unstated), and the records
  measured carry no usage and no tool-call ids.
- A warm answer session (`openAnswerSession`): no stdin stream-json input format.
- Effort: encoded in the model id, no flag.
- `onWorktreeRemoved` and `onProjectRelocated`: trust is the `--trust` flag with no documented
  store, `~/.cursor/projects/<slug>` is undocumented, and `--resume` reaches chats across workspaces
  since v2026.07.06.
- `stopBackgroundSession` and its siblings: Kangentic never starts `agent persist`.
- `proveConversationGone` and `locateResumeHistoryFile`: the chat store a resume reads
  (`~/.cursor/chats`) is undocumented.
- `parseTranscriptWindow`: the transcript format it would window is undocumented, and Cursor's
  records carry no per-message usage to attribute. Without it the conversation index reads the most
  recent 16 MB of a transcript.
- `supportsReadableDirectories`: no flag for another readable folder (`--workspace` names the one
  workspace; the sandbox read boundary is global config).
- `pastedImageReferenceTemplate`: whether Cursor's agent opens an image from a typed path is
  unmeasured; the path paste itself was probed and inserts text.
- A richer `getExitSequence`: Cursor documents no exit command, so Ctrl+C stays.
