---
type: Reference
title: Droid
description: Factory's Droid, a droid --cwd command whose permission modes map to --use-spec and --auto levels, a per-session --settings file of hooks for tool calls, waits, the session id, compaction and the browser policy, a project .factory/mcp.json holding only an environment reference for the token, a model list read from droid exec --help, which behaviors were built from documentation, and why live telemetry is unsupported.
tags: [agents, adapter, droid]
sources:
  - resource: src/main/agent/adapters/droid/droid-adapter.ts
  - resource: src/main/agent/adapters/droid/detector.ts
  - resource: src/main/agent/adapters/droid/command-builder.ts
  - resource: src/main/agent/adapters/droid/hook-manager.ts
  - resource: src/main/agent/adapters/droid/session-id-capture.ts
  - resource: src/main/agent/adapters/droid/browser-servers.ts
  - resource: src/main/agent/adapters/droid/capability-discovery.ts
---
# Droid

## CLI Detection

`src/main/agent/adapters/droid/detector.ts`

Droid is Factory's coding agent CLI (the `droid` binary). Detection follows the standard `AgentDetector` flow with a `droid --version` probe. Output is either `droid <semver>` or bare `<semver>`; `parseVersion` strips the optional `droid` product prefix and returns the trimmed version string. Standard Unix fallback paths are wired via `standardUnixFallbackPaths('droid')` for cases where the binary is not on `PATH`. Refer to Factory's documentation for the current install command.

## Command Building

`src/main/agent/adapters/droid/command-builder.ts`

```
droid --cwd <cwd> [--settings <session dir>/droid-settings.json] [--use-spec | --auto <level>]
      [--append-system-prompt <browser policy>] [--resume <uuid>] "<prompt>"
```

The cwd, resume and prompt shape was validated against Droid 0.109.1 (see `scripts/probe-droid.js`). Every other flag comes from Droid 0.218.0's own `droid --help` and Factory's [CLI reference](https://docs.factory.com/droid-cli/cli-reference.md), and was not run against a signed-in TUI:

- `--settings <path>`: "Path to runtime settings file merged for this process only". The one file Kangentic passes holds its hooks and nothing else (see [Hooks](#hooks)). Model, BYOK `customModels[]` and the rest of the user's `~/.factory/settings.json` stay theirs.
- `--use-spec` and `--auto <level>`: the column's permission mode (see [Permission Modes](#permission-modes)).
- `--append-system-prompt <text>`: the Agent Browser policy, passed only while the Agent Browser is on (see [Browser policy](#browser-policy)).

Interactive `droid` 0.218.0 lists no `--model` or `--reasoning-effort` flag; only `droid exec --help` does. So a column's model and effort overrides stay hidden (`supportsModelOverride: false`, `effortLevels` empty), and the user picks the session's model in the TUI (`/model`, Ctrl+N) and its effort with Tab. An effort set for a task another way (the MCP `effortOverride`, which accepts any value for an agent that lists no levels) is not passed on: the interactive command builder has no effort option, so it is dropped. Only the headless runs take `-r` (see [Model list](#model-list)).

## Permission Modes

`droidPermissionFlags` maps each permission mode to Droid's launch flags. 0.218.0's `droid --help` lists `--use-spec` ("Start in spec mode") and `--auto <level>` ("Autonomy level: low|medium|high"); Factory's CLI reference describes the levels and [Specification Mode](https://docs.factory.com/autonomy-and-safety/specification-mode.md) describes Spec Mode.

| Permission mode | Flag | What Droid does |
|-----------------|------|-----------------|
| `default` | none | Asks before each action |
| `plan` | `--use-spec` | Starts in Spec Mode: plans first, then asks for approval through `ExitSpecMode` |
| `dontAsk` | `--use-spec` | Read-only, as Gemini's and Qwen's builders map it (not offered in the selector) |
| `acceptEdits` | `--auto low` | Safe edits and non-destructive commands |
| `auto` | `--auto medium` | Local development: installs, builds, tests, local commits |
| `bypassPermissions` | `--auto high` | Push and deploy as well |

Interactive Droid has no `--skip-permissions-unsafe` (only `droid exec` does), so bypass maps to the highest level, which still blocks what Droid blocks at every level. The TUI still changes either choice mid-session: Shift+Tab toggles Spec Mode and Ctrl+L cycles the autonomy level.

Until 2026-11-03 Droid offered one "Default" entry and left autonomy to the TUI. The decision that day was to map every launch flag its CLI documents. These are Droid's own flags, not a settings layer Kangentic writes, so `cli-features-over-custom-layers.md` allows them.

A Droid plan does not move its task on approval. Kangentic recognizes an approved plan by the plan tool's result, and no Factory doc gives what `ExitSpecMode` returns for an approved plan versus a rejected one. Factory 0.242.0 also lets an approved spec "continue in a new chat", whose id Kangentic would not follow (see [Session ID Capture](#session-id-capture)).

## Hooks

`src/main/agent/adapters/droid/hook-manager.ts`

Droid reports tool calls, the waits on the user (GitHub #452) and its session lifecycle through hooks. Kangentic writes them to a per-session settings file, `droid-settings.json` in the session's own folder beside `events.jsonl`, and passes it with `--settings`. The user's `~/.factory/settings.json` is never touched.

| Droid hook | Kangentic event |
|------------|-----------------|
| `PreToolUse` (`*`) | `tool_start` (tool, command or file path) |
| `PreToolUse` (browser servers only) | the browser policy's deny (see [Browser policy](#browser-policy)) |
| `PostToolUse` (`*`) | `tool_end`, the end of a wait on that tool |
| `UserPromptSubmit` | `prompt`, which also ends a wait whose tool never ended (a rejected prompt). A Command Terminal's session (`capturePromptText`) also gets the prompt text, to name itself |
| `Notification` | the permission `idle`, only for `notification_type` `elicitation_dialog` (the AskUser tool's question, `waitKind: 'question'`) or `permission_prompt` (a tool to allow, `'approval'`); every other type (`idle_prompt`, `auth_success`) writes nothing |
| `SessionStart` | `session_start`, which carries the session id (see [Session ID Capture](#session-id-capture)) |
| `SessionEnd` | `session_end` (log only) |
| `PreCompact` | `compact`, which counts the compaction in the session's usage |

Stop is not wired, and no hook writes a plain `idle`. An `idle` that is not a permission wait ends the turn in the activity engine and runs the column's On agent turn end automations, whatever `reportsTurnEnd` says. Droid's turn ends stay with the PTY silence timer (`reportsTurnEnd: false`, `activity: pty`): a `pty` agent's hook events never suppress its tracker, so the silence fallback keeps ending turns, and the silence timer leaves a wait alone because it fires only while the session is thinking. Under `pty` a Stop would also race the 3 s silence idle. Moving Droid to `hooks_and_pty` needs `UserPromptSubmit` to fire in the TUI, since a turn with no tool call could otherwise never start. SubagentStop is not wired either: Droid has no SubagentStart, so a stop would unbalance the subagent depth, and the `Task` tool's own PreToolUse and PostToolUse already bracket a subagent. The hooks' events reach the engine through `runtime.statusFile` (`parseEvent`; Droid writes no status line).

What was measured on Droid 0.218.0 in `droid exec`:

- A hook in the `--settings` file and one in the project's `.factory/settings.json` for the same event both ran, the runtime file's first: Droid concatenates hooks per event, so a user's own hooks keep running in a Kangentic session. (The user layer, `~/.factory/settings.json`, was not tested separately.)
- The hook command `node "<forward-slashed path>" <args>` ran on Windows, the quoting `DROID_HOOK_SHELL` produces for an ordinary path. The 0.218.0 payloads for SessionStart, PreToolUse, PostToolUse and Stop are in `tests/fixtures/droid-hooks/`.

The other events and their fields come from Factory's [hooks reference](https://docs.factory.com/reference/hooks-reference) and [hooks guide](https://docs.factory.com/harness/hooks.md), read 2026-11-03 against CLI v1.2.0. Every hook carries `session_id`, `transcript_path`, `cwd`, `permission_mode` and `hook_event_name`. UserPromptSubmit adds `prompt`, Notification adds `message` and `notification_type` (`permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`), PreCompact adds `trigger`, SessionStart adds `source` (`startup`, `resume`, `clear`, `compact`) and SessionEnd adds `reason`. The reference shows `transcript_path` under `~/.factory/projects/`, where the 0.218.0 fixtures have `~/.factory/sessions/<slug>/`. Kangentic reads its transcripts from the measured path.

What is not verified: the TUI asks for a Factory sign-in even with a BYOK model, so no TUI session has run. The Notification carries no question text. Whether the TUI fires `UserPromptSubmit` is unknown (`droid exec` did not).

## Session ID Capture

`src/main/agent/adapters/droid/hook-manager.ts`, `src/main/agent/adapters/droid/session-id-capture.ts`

The SessionStart hook names the session (`parseDroidSessionIdFromHook`, `runtime.sessionId.fromHook`). The event bridge keeps at most 2048 characters of the payload, and `transcript_path` alone can run to hundreds, so a payload cut short is read with a pattern for `session_id`, which comes first. Only a UUID is accepted.

The folder poll stays as the fallback, for a Droid that ignores `--settings` or a hook that never ran. The first id to arrive wins. `captureSessionIdFromFilesystem` polls `~/.factory/sessions/<cwd-slug>/` (up to 20 attempts at 500ms) for `<uuid>.jsonl` files whose mtime is at or above `spawnedAt - 30s`, and returns the UUID with the newest qualifying mtime. The cwd slug normalizes path separators and the drive-letter colon to `-` (e.g. `C:\Users\dev\project` -> `-C-Users-dev-project`). The poll alone could hand a session a concurrent Droid's id in the same cwd within the 30s floor; the hook closes that case when it fires.

`fromHook` captures once. A session id that changes mid-session (a SessionStart with `source: clear`, or an approved spec continued in a new chat) is not followed.

## MCP Setup

Droid CLI has no per-spawn `--mcp-config` flag, but it does expand `${NAME}` references against the process environment inside `headers` values at connect time, and never rewrites the file with the expanded value ([MCP docs](https://docs.factory.com/harness/mcp.md)). Kangentic uses that: on spawn it writes a project-scoped `<cwd>/.factory/mcp.json` holding only the environment variable NAME, and supplies the value through the adapter's `buildEnv`. `~/.factory/mcp.json` is never touched, and the token never reaches disk even though the file lives inside the user's repo.

```json
{
  "mcpServers": {
    "kangentic": {
      "type": "http",
      "url": "<kangenticMcpUrl>",
      "headers": { "X-Kangentic-Token": "${KANGENTIC_MCP_TOKEN}" }
    }
  }
}
```

User-defined servers in that file are preserved, and `removeHooks` strips only the `kangentic` entry once the folder's last session ends (deleting the file when nothing else remains). Verified against droid 0.189.0: `droid mcp list` reports `kangentic  http  connected  [project]`.

Cleanup runs from the PTY exit and suspend paths, so a hard kill (Task Manager, crash, OS reboot) leaves the entry behind pointing at a dead loopback port until the next spawn rewrites it. It holds no secret, but it is a file Kangentic wrote inside the user's tree, so when Kangentic creates it the builder seeds `.factory/mcp.json` and `.kangentic/` into `.git/info/exclude` via the shared `git-exclude.ts` mechanism (see [Antigravity](antigravity.md)) - the file never shows as untracked and cannot ride a `git add -A`. A pre-existing user `mcp.json` keeps its normal git visibility (the created-by-us carve-out). A Droid session on a project with worktrees disabled writes it into the project root rather than a worktree, which is what makes that entry matter.

## Browser policy

`src/main/agent/adapters/droid/browser-servers.ts`, `hook-manager.ts`

While the Agent Browser is on it is the only browser an agent drives (see [Browser panes](../mcp-server/browser-panes.md#the-only-browser-an-agent-drives)). Droid gets the same two halves Claude does:

- `--append-system-prompt` with `BROWSER_POLICY_PROMPT`, only while the switch is on. The flag is in 0.218.0's `droid --help`.
- A PreToolUse hook on every spawn, through `browser-policy-bridge.js`, that denies a third-party browser server's tool. The bridge reads the switch on each call. Factory's hooks reference documents the same deny reply Claude reads (`hookSpecificOutput.permissionDecision: "deny"` with a reason), MCP tool names of the form `mcp__<server>__<tool>`, and case-sensitive regex matchers. `droidBrowserServerNames` finds the browser servers in the user's `~/.factory/mcp.json` and the working directory's `.factory/mcp.json`. Servers from an ancestor folder's `.factory/mcp.json`, a plugin or the org are not read, and the shared name fragments (`playwright`, `puppeteer`, ...) cover the common ones.

Not verified: the hook's matcher keeps Kangentic's own server out with a `(?!kangentic__)` lookahead, which holds only if Droid's matcher regex supports lookahead. If it does not, the bridge still never denies Kangentic's server; the hook just runs for more calls.

## Model list

`src/main/agent/adapters/droid/capability-discovery.ts`

`droid exec --help` ends with an "Available Models:" block and a "Custom Models:" block (the user's BYOK `customModels[]`), one `<id>  <Display Name>` row each. `parseDroidExecHelpModels` reads both into `models` and `modelDisplayNames`, dropping the `(default)` marker, and the result is cached per CLI path until a model dropdown forces a refresh. A Droid in a WSL distro is asked through `wsl.exe`. The list feeds the pickers of the headless runs that take `--model` (`droid exec`: the title summary and the Knowledge Graph answer).

Effort is per model. The help's "Model details:" block gives each one's levels (`- <Display Name>: supports reasoning: Yes; supported: [off, low, ...]; default: high`), and `droid exec -r, --reasoning-effort <level>` takes them ("defaults per model"). The parser keys them by id through the display name into `effortLevelsByModel`, and skips a model that does not reason. `effortLevels` stays empty, so no agent-wide list offers a level some model refuses. The Knowledge Graph and Automation agent Effort rows offer the chosen model's levels (`effortLevelsForModel`), a run passes `-r` only for a level that model lists, and with no level set no `-r` is passed and Droid uses the model's default (`answerCapabilities.effort`, no `defaultEffort`).

## File-changing tools

`fileChangeTools` names `Create`, `Edit` and `ApplyPatch`, each by `tool_input.file_path`, which Factory's hooks guides read from all three (a `Create|Edit|ApplyPatch` matcher piping `.tool_input.file_path`). The captured transcript fixture holds only a `Read` call, so the field is from the docs alone.

## WSL

A Droid installed in a WSL distro runs there (`supportsWslCli`) when its CLI path names it (`\\wsl.localhost\<distro>\...`). The session starts Droid's Linux path in a `wsl -d <distro>` shell, with `--cwd` and `--settings` in the distro's form (`/mnt/c/...`). Its hooks run in the distro, so they publish through the WSL hook transport the builder prepares in the session's own folder (`prepareWslHookTransport`, `wslHookEventCommand`, and `wslHookReplyCommand` for the browser policy), and Kangentic does the bridges' work on what they publish. The settings file is per session, so no folder copy of the script is needed. Its session files are in the distro's `~/.factory/sessions/`, under the slug of that cwd (`-mnt-c-...`), and Kangentic reads them over the distro's share for the session id, the transcript and the Conversation viewer. On mirrored networking the distro reaches this machine's loopback and the MCP entry above is unchanged. On NAT networking it is the WSL hook transport's stdio bridge, `{"type": "stdio", "command": "sh", "args": [<script>, "mcp", <url>], "env": {"KANGENTIC_MCP_TOKEN": "${KANGENTIC_MCP_TOKEN}"}}`, where Factory's MCP docs say Droid expands `${VAR}` in `env` as in `headers`. A title summary, a Knowledge Graph answer and the model list run through `wsl.exe`. Not yet run against a Droid installed in a distro.

## Built from documentation

These behaviors were built on 2026-11-03 from Factory's docs (CLI v1.2.0) and Droid 0.218.0's `--help`, and none was run against a signed-in Droid TUI:

- The permission-mode flags (`--use-spec`, `--auto low|medium|high`).
- The SessionStart, SessionEnd and PreCompact hooks, the session id read from SessionStart, and the prompt text on UserPromptSubmit.
- The browser policy's system prompt and PreToolUse deny.
- Hooks for a Droid in a WSL distro.
- The model list and each model's effort levels read from `droid exec --help`, and the `-r` the headless runs pass.
- `fileChangeTools`.

Measuring them needs a signed-in Droid TUI, which the probe machine does not have. Each is built so a Droid that ignores it runs as it did before.

## SSH

A Droid on a remote host over SSH (#913) runs as `droid`, found by the host's login `PATH` (`remoteCliName`), so it must be installed and signed in there. It is checked only against a fake host in `tests/unit/droid-ssh-remote.test.ts`, never against a real Droid or host.

- **Synced file.** `remoteFiles()` declares only the project's `.factory/mcp.json`. Kangentic's entry is merged beside the user's servers on the host, is the WSL hook transport's stdio bridge named by its path on the host, and holds the token only as the `${KANGENTIC_MCP_TOKEN}` reference (the token rides the spawn environment). The file is restored when the session releases, and removed again if Kangentic created it.
- **Activity is PTY-only.** The hooks settings file (`droid-settings.json`, passed with `--settings`) is written only for a Droid on this computer. Sending it would need the session relay to carry one more file and `--settings` to name the host's copy, for hooks that only add tool calls and waits on top of the silence timer. So a session on a host shows the same activity as a Droid with ignored hooks.
- **No resume over SSH.** The session id comes only from `~/.factory/sessions/<slug>/<uuid>.jsonl`, which is on the host and not in this computer's mirror. No id is captured, so a resume starts a fresh conversation, with no error and no wait. The transcript and the Conversation viewer read the same mirror and show nothing.

## Limitations

### No live telemetry (model, cost, tokens, context window)

Droid has no per-session telemetry channel that Kangentic can subscribe to. The documented surfaces all sit outside the live-streaming contract that `ContextBar` requires:

- **`/cost` and `/context` slash commands** - post-hoc and user-initiated inside the TUI, not a stream Kangentic can read.
- **`OTEL_TELEMETRY_ENDPOINT`** - out-of-band OpenTelemetry export to a collector. Not a per-session signal we can subscribe to from the main process.
- **`statusLine`** - Factory's [settings reference](https://docs.factory.com/droid-cli/settings.md) documents a custom status line (`{ "command": string, "padding"?: number, "maxRows"?: number }`) whose stdout renders above the input, but not what the command receives on stdin. Claude's status line pipeline reads its telemetry from that stdin, so it cannot be built from the docs. Setting it through `--settings` would also replace a status line the user configured.
- **`~/.factory/sessions/<cwd-slug>/<uuid>.settings.json`** - written post-hoc, schema undocumented and unstable. Empirical parsing was evaluated and rejected (see "Out of scope" below).

As a result, `SessionUsage` is never populated for Droid sessions. The Droid adapter declares `liveTelemetryUnsupported` (carrying a label and tooltip) on `AgentAdapter`, the field flows to the renderer through `AgentDetectionInfo`, and `ContextBar` reads the generic capability and renders a "Telemetry: TUI only" pill (with the adapter-supplied tooltip) in place of the loading spinner. The board card and the Agent Monitor card show the same label in their footer, in place of "Starting agent..." (`TelemetryUnavailableFooter`, `task-card-view.tsx`). The renderer never branches on agent name. Users get live telemetry by running `/cost` or `/context` directly inside the Droid TUI.

Tracked upstream at [Factory-AI/factory#TBD](https://github.com/Factory-AI/factory/issues) - once a per-session streaming channel ships (a documented status line input, a named pipe, or `stream-json` on interactive `droid`), wire a `runtime.sessionHistory` (or `runtime.statusFile` / `runtime.streamOutput`) parser in `src/main/agent/adapters/droid/` and remove `liveTelemetryUnsupported` from the Droid adapter. The renderer falls back to the standard model / cost / token pills automatically.

### Other gaps

- Activity stays PTY-driven. The hooks add tool calls, the waits, the session id and compactions to the activity log, but turn ends come from terminal silence.
- No trust dialog (`ensureTrust` is a no-op; Droid does not prompt for directory approval).
- No transcript usage or tool counts: Factory does not document the session JSONL's schema, so `transcriptUsage` and `transcriptToolCounts` are not built. `parseTranscript` and `readTranscriptPage` read the message shape measured on 0.109.1 (`transcript-parser.ts`), and `locateSessionHistoryFile` returns the session file for handoffs.
- No background commands: an `Execute` with `fireAndForget` detaches (see [Background commands](background-commands.md#background-commands)).
- No warm answer session (`openAnswerSession`). `droid exec --input-format stream-jsonrpc` runs a long-lived process, but the [droid exec docs](https://docs.factory.com/droid-exec/overview.md) leave its JSON-RPC methods undocumented and point at Factory's SDKs instead. A session cannot be built from them without reading an SDK's source or capturing a run.

### Out of scope: post-hoc JSONL replay

Reading `<uuid>.settings.json` after session exit was considered as a "good enough" fallback for cost/token totals. Rejected because (a) the file schema is undocumented and observed to differ across Droid 0.10x point releases, (b) post-hoc data does not solve the live-spinner UX, only the final-row UX, and (c) Factory has signaled willingness to add a streaming channel - see upstream FR.
