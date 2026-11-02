---
type: Reference
title: Agent adapter interface
description: The AgentAdapter methods and required properties, the fifteen-agent matrix of resume flags and MCP delivery, which agents may take their first prompt typed, agent resolution order, per-agent first-output and exit key sequences, session history file locations, the launch overlay lift, and the task_xml prompt template.
tags: [agents, adapters]
sources:
  - resource: src/main/agent/agent-adapter.ts
    title: AgentAdapter required members
  - resource: src/main/agent/agent-registry.ts
  - resource: src/main/transition-engine/agent-resolver.ts
---
# Agent adapter interface

Kangentic supports fifteen AI coding agents: Claude Code, Codex CLI, Gemini CLI, Antigravity CLI, Qwen Code, Cursor CLI, GitHub Copilot CLI, OpenCode, Aider, Oz CLI (Warp), Kimi Code, Droid, Ollama, Grok Build, and Goose CLI. Each agent is wrapped behind a common `AgentAdapter` interface that handles CLI detection, command building, permission mapping, session lifecycle hooks, and cross-agent handoff. This concept covers the shared contract. Each agent's own details are in its concept in this folder, listed in the [index](index.md).

## Agent Adapter Interface

`src/main/agent/agent-adapter.ts`

Every agent implements the `AgentAdapter` interface. Each adapter lives in `src/main/agent/adapters/<name>/`. TUI agents also have a `transcript-cleanup.ts` file for handoff transcript processing (see [Per-Agent Transcript Cleanup](handoff.md#per-agent-transcript-cleanup)).

| Method | Purpose |
|--------|---------|
| `detect(overridePath?)` | Locate the CLI binary and return path + version |
| `invalidateDetectionCache()` | Reset cached detection (e.g. after user changes CLI path) |
| `ensureTrust(workingDirectory, place?)` | Pre-approve a directory so the agent doesn't prompt for trust, plus any other pre-spawn global-config state the adapter needs (see [Global Config Writes](claude-code.md#global-config-writes-claudejson)). `place` is the spawn's WSL target when the CLI runs in a distro, whose config files are the distro's |
| `probeAuth?(cliPath)` | Optional. Check whether the agent is authenticated. Returns `true` (logged in), `false` (installed but not authenticated), or `null` (probe unavailable / I/O error). Only called by IPC after `detect()` reports `found: true`, with the path it found, which a project's own CLI path may name, so a probe that runs the CLI runs that one rather than the one on PATH. Must never throw. For a WSL path the probe reads or runs the distro's install, never this machine's. Currently implemented by Kimi (see [Kimi Code -> Authentication](kimi-code.md#authentication)), Grok (`grok models`, whose output says "not authenticated" from local state), and OpenCode (provider keys in `auth.json`, the distro's for a WSL path). |
| `buildCommand(options)` | Build the shell command string to spawn the agent. `options.agentPath` is what `detect()` returned, except that on Windows a `.cmd` / `.bat` head is swapped by the spawn chokepoint for the sibling shim the PTY shell can run before the builder sees it (`resolveShimLaunch`, see [npm .cmd shims under PowerShell and Git Bash](../../platforms/shells-and-paths.md#npm-cmd-shims-under-powershell-and-git-bash)); builders never inspect the extension |
| `interpolateTemplate(template, variables)` | Replace `{{key}}` placeholders in prompt templates |
| `runtime` | `AdapterRuntimeStrategy` declaring activity detection + session ID capture (see [`AdapterRuntimeStrategy`](adapter-types.md#adapterruntimestrategy)) |
| `removeHooks(directory, sessionId?)` | Remove the per-directory config an adapter injected, on cleanup. `directory` is the cwd the session's command was built for (`ManagedSession.commandCwd`), not the PTY's start dir. `sessionId` is the session releasing its hold: adapters that write a file every session in a folder shares (Gemini, Qwen, Cursor, Droid, Antigravity, Grok, OpenCode, Codex) hold it per session in a `SharedFolderHolds` (`src/main/agent/shared/shared-folder-holds.ts`) and strip it when the folder's last session releases, from the folder the hold was taken in. Keyed by session, never by task: a task's sessions overlap while a killed young session's PTY exits. No `sessionId` (project delete's sweep) strips the folder whoever holds it. The payload is not only hooks: Gemini also strips its `mcpServers.kangentic` entry (which carries the per-launch token), and Droid's hold guards `<cwd>/.factory/mcp.json` rather than a hooks file. |
| `detectFirstOutput(data)` | Detect the adapter's readiness escape, which times the boot geometry re-assert. A heuristic, not proof the agent is up, so it does not lift the launch overlay - see First-Output Detection below |
| `locateSessionHistoryFile(agentSessionId, cwd, place?, reportedPath?)` | Locate the agent's native session history file on disk, in the WSL distro's home when `place` names one. `reportedPath`, here and on every transcript method, is a path the agent itself reported for the conversation (a session row's `transcript_path`, a live session's usage `transcriptPath`). It may be stale or name another id, so an adapter that reads it checks both; adapters that find their files by id ignore it |

The optional members, methods included (`discoverCapabilities`, `getExitSequence`, `summarize`, `parseTranscript` and the rest), are tabulated with their signatures in [Optional adapter properties](optional-properties.md).

### Required Properties

| Property | Type | Purpose |
|----------|------|---------|
| `name` | `string` | Unique identifier (`'claude'`, `'codex'`, `'gemini'`, `'qwen'`, `'cursor'`, `'copilot'`, `'opencode'`, `'aider'`, `'warp'`, `'kimi'`, `'droid'`, `'ollama'`, `'grok'`, `'antigravity'`, `'goose'`) |
| `displayName` | `string` | Human-readable product name |
| `sessionType` | `SessionRecord['session_type']` | Value stored in the sessions DB table |
| `supportsCallerSessionId` | `boolean` | True when the CLI accepts a caller-supplied session ID via `--session-id` (Claude). When false, Kangentic captures the agent's own ID via `runtime.sessionId` for `--resume`, or, for an adapter with `createSessionId` (Cursor's `create-chat`), asks the CLI for an ID before a fresh start. See `createSessionId` and `reportsLaunchSessionId` in [optional-properties.md](optional-properties.md). |
| `resumePromptDelivery` | `'command-line' \| 'typed' \| 'no-resume'` | How a message reaches the agent when it resumes a conversation: on the resume command, or typed in once the agent is ready. `no-resume` means the adapter never resumes, so every start is fresh and the message is its prompt or is typed after it. The Resume Prompt column below lists each agent's value (see [How the resume prompt arrives](../../architecture/sessions/resume.md#how-the-resume-prompt-arrives)) |
| `permissions` | `AgentPermissionEntry[]` | Supported permission modes with agent-specific labels |
| `defaultPermission` | `PermissionMode` | Recommended default permission mode |
| `runtime` | `AdapterRuntimeStrategy` | Activity detection + session ID capture (see [`AdapterRuntimeStrategy`](adapter-types.md#adapterruntimestrategy)) |

## Supported Agents

| Agent | Adapter | CLI Binary | Session Resume | Resume Prompt | Status/Events | Settings Merge | Kangentic MCP | Trust |
|-------|---------|-----------|----------------|---------------|---------------|----------------|---------------|-------|
| Claude Code | `claude-adapter.ts` | `claude` | `--resume <id>` | `command-line` | Yes (status.json + events.jsonl; transcript fallback for background sessions, see [Adapter Session History](session-history.md#claude)) | Yes (`--settings`) | `--mcp-config <sessionDir>/mcp.json` | Yes (`~/.claude.json`) |
| Codex CLI | `codex-adapter.ts` | `codex` | `resume <id>` | `command-line` | Yes (events.jsonl via `-c hooks.*` overrides, rollout for usage and background commands) | No | `-c mcp_servers.*` overrides + `buildEnv` token | Yes (`~/.codex/config.toml` `[projects]`) |
| Gemini CLI | `gemini-adapter.ts` | `gemini` | `--resume <id>` | `command-line` | Yes (status.json + events.jsonl) | Yes (`.gemini/settings.json`) | `mcpServers` in `.gemini/settings.json` (`httpUrl`) with `${VAR}` env refs + `buildEnv` URL/token | Yes (`~/.gemini/trustedFolders.json`) |
| Qwen Code | `qwen-adapter.ts` | `qwen` | `--session-id <uuid>` (caller-owned) / `--resume <id>` | `command-line` | Yes (events.jsonl) | Yes (`.qwen/settings.json`) | `--mcp-config <sessionDir>/mcp.json` (`httpUrl`; `.qwen/settings.json` before 0.16) | Yes (`~/.qwen/trustedFolders.json`) |
| Cursor CLI | `cursor-adapter.ts` | `cursor-agent` (alias `agent`) | `--resume="<id>"` | `typed` | No | No | `<cwd>/.cursor/mcp.json` with `${env:...}` url/token + `buildEnv` + `--approve-mcps` | No |
| GitHub Copilot CLI | `copilot-adapter.ts` | `copilot` | `--session-id <uuid>` (caller-owned) | `typed` | Partial (events.jsonl + status parser) | Per-session `--config-dir` | `--additional-mcp-config @<path>` | Runtime `--add-dir` |
| Aider | `aider-adapter.ts` | `aider` | No | `no-resume` | No | No | Not possible (CLI has no MCP client) | No |
| Oz CLI (Warp) | `warp-adapter.ts` | `oz` | No | `no-resume` | No | No | Not wired | No |
| Kimi Code | `kimi-adapter.ts` | `kimi` | `--session <uuid>` (caller-owned) | `command-line` | Yes (`wire.jsonl`) | No | `--mcp-config-file <sessionDir>/mcp.json` | No |
| Droid | `droid-adapter.ts` | `droid` | `--resume <uuid>` | `command-line` | No (PTY-only) | No (use Droid's TUI: `/model` + Ctrl+D, shift+tab) | `<cwd>/.factory/mcp.json` + `buildEnv` token | No |
| OpenCode | `opencode-adapter.ts` | `opencode` | Plugin/PTY-captured `ses_<id>` (auto-generated) | `typed` | Yes (plugin JSONL via `tool.execute.before/after` + `event` `session.*`, `question.asked` and `permission.asked`) | No (`opencode.json` + `OPENCODE_CONFIG_CONTENT` env) | `OPENCODE_CONFIG_CONTENT` (local spawns only) | No (auth via `opencode auth login` -> `~/.local/share/opencode/auth.json`) |
| Ollama | `ollama-adapter.ts` | `ollama` | No | `no-resume` | No | No | Not possible (CLI has no MCP client) | No |
| Grok Build | `grok-adapter.ts` | `grok` | `--session-id <uuid>` (caller-owned) / `--resume <id>` | `typed` | Yes (events.jsonl via Claude-compatible hooks; usage from `updates.jsonl` tail) | No (wholly-owned `.grok/hooks/kangentic.json` + `.grok/config.toml` sentinel block) | `[mcp_servers.kangentic]` block in `<cwd>/.grok/config.toml` with `${VAR}` env refs + `buildEnv` URL/token | Yes (`~/.grok/trusted_folders.toml`, cascades from project root) |
| Antigravity CLI | `antigravity-adapter.ts` | `agy` | `--conversation <id>` | `command-line` | Yes (events.jsonl via `.agents/hooks.json`) | Yes (`.agents/hooks.json`, named-hook merge) | Workspace plugin `.agents/plugins/kangentic/` (`serverUrl` + token header) | Yes (`trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`) |
| Goose CLI | `goose-adapter.ts` | `goose` | `-r -n <name>` (caller-owned name) | `command-line` | No (PTY-only) | No | Not wired | No |

The Resume Prompt column is `resumePromptDelivery`. A `command-line` agent's resume command
carries the message (a column's message, a plan continuation, a handoff pointer, held messages).
A `typed` agent's CLI takes a prompt on a new session, but its help and docs never say the prompt
runs on a resumed one, so Kangentic keeps the message off the command and types it in once the
agent is ready. A `no-resume` agent has no session id to resume by, so every start is fresh.
`tests/unit/resume-prompt-delivery-parity.test.ts` builds each adapter's real resume command with a
marked prompt and holds the value to what the builder does.

### First prompt typed (`firstPromptMayBeTyped`)

An optional method, asked per launch with the options the command is built from, lets a task's
agent start while its new worktree runs its Post-Worktree Script, with the first prompt typed in
once the script exits ([Worktree creation](../../architecture/worktrees/worktree-creation.md#the-agent-starts-while-the-script-runs)).
It answers true only for a CLI whose fresh launch with no prompt is the same interactive session,
so a prompt typed or pasted into its input box is the same first message the command line would
carry, and whose input box is drawn in the alternate screen with any screen before it (an update
offer, a sign-in, a folder trust or MCP server approval) drawn outside it. That second condition
needs a run to check. The spawn adopts the early agent only once its TUI has entered the alternate
screen, and launches it as before otherwise, because a typed prompt's Enter would answer such a
screen. A launch that will not draw in the alternate screen at all answers false and is not
started early: Claude's does on its classic renderer (a `tui` choice of `default`, or the user's
own `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`). An agent without the capability starts after the
script, as before, unless the project turns `git.holdPromptForInitScript` off, which needs no
typing.

The same answer marks the session (`SpawnSessionInput.inputInAlternateScreen`), so a background
paste (a held message, a Send message row, the setup-failure note) waits until the TUI has entered
the alternate screen or the agent has taken a prompt (`SessionManager.awaitInputReady`). An agent
left on a boot screen otherwise reads as idle once the stale-thinking reclaim fires, 3 minutes in,
and the paste would answer the screen. The answer reads the environment Kangentic runs with, and
on macOS and Linux that is only the login shell's `PATH`, so a renderer variable set only in a
shell profile reaches Claude but not the answer. Such a launch draws classic and never enters the
alternate screen, which is why a prompt the agent has taken also ends the wait.

The verdicts for the other agents were measured on 2026-10-31 by launching each installed CLI with
no prompt in a fresh git repository on Windows (120 by 32 cells), watching for 14 s; no turn ran.

| Verdict | Agents | Why |
|---|---|---|
| Declared | Claude | Seen in a preview on 2.1.316: the promptless launch enters the alternate screen at its input box and the pasted task prompt is the first message. An unapproved project MCP server's approval screen comes first and outside the alternate screen, so the spawn relaunches that agent as before |
| Not declared | Gemini, Droid, Kimi | The promptless launch never entered the alternate screen, so the spawn could never adopt it. Gemini drew its folder trust and Droid its sign-in on the main screen |
| Not declared | Codex, OpenCode, Copilot, Grok, Antigravity, Qwen | Each entered the alternate screen within 2.3 s and drew its boot screens inside it: Codex's sign-in, OpenCode's update offer, a selection menu over Copilot's input box, Grok's data-sharing opt-in, Antigravity's sign-in and folder trust. Qwen showed none in the run, but draws nothing before the alternate screen, so its recorded update and MCP approval screens are inside it too. Being in the alternate screen does not mean the input box is up |
| Not declared yet | Goose | Opens `goose session` with no prompt; not installed where the others were measured |
| Not declared | Aider | `--message` sends one message and exits; without it Aider is an interactive chat, a different run |
| Not declared | Cursor | Only its `default` permission mode is interactive; every other mode is a `stream-json` print run |
| Not declared | Ollama | A prompt is one turn that exits; without one `ollama run` opens a REPL |
| Not declared | Oz (Warp) | `oz agent run` is a one-shot runner with no input box |

`tests/unit/first-prompt-typed-parity.test.ts` holds every registered adapter to this table and
builds each declared adapter's fresh command with no prompt.

The Kangentic MCP column, by `kangenticMcp`: Claude, Codex, Copilot, Kimi, OpenCode, Grok, Cursor,
Qwen and Gemini are `'per-session'`; Droid and Antigravity are `'shared-folder'`, because each
writes the session's literal URL into a file in the working directory. Gemini moved to a fixed
`settings.json` entry whose URL and token are `${KANGENTIC_MCP_URL}` and `${KANGENTIC_MCP_TOKEN}`
(Grok's and Cursor's pattern) in task #859, measured on 0.64.0: an MCP request arrived on the path
the session environment named, and the token is no longer written to disk. Its hook commands carry
the events path the same way (`env:KANGENTIC_EVENTS_PATH`). The same move is undocumented for
Droid's `url` and for Antigravity, and each waits on a live run before it changes, since it alters
every session on that agent. Qwen moved to `--mcp-config` because its workspace MCP approval gate stopped every session
on a dialog (see [Qwen's MCP approval gate](qwen-code.md#kangentic-mcp-server-and-the-approval-gate)); that move also made it eligible as a Workflow
agent, which has not been run live. Cursor's interactive and print sessions use the same static
`${env:...}` entry its answer path measured; the interactive path has not been run live yet.
Goose's `streamable_http` extensions take `headers` with `${VAR}` (its source), but its CLI flag
takes only a URL, and a config-file entry has not been run live, so it stays unwired.
Grok reads its project block only in a folder the user trusted in Grok, which Kangentic never
decides for them.

## Agent Resolution

`src/main/transition-engine/agent-resolver.ts`

When a task moves to a column, `resolveTargetAgent()` determines which agent to spawn:

1. **Task agent_override** (`task.agent_override`, set at task creation via the New Task dialog's Advanced section) - highest priority. When set, the agent is locked for the task's entire lifetime; column moves cannot change it.
2. **Column agent_override** (per-column setting)
3. **Project default_agent** (per-project setting)
4. **Global fallback** (`DEFAULT_AGENT` constant, currently `'claude'`)

`task.agent` is intentionally NOT in the resolution chain. It records which agent last ran on the task (for resume and handoff detection), but column and project settings are the authority for which agent should run. Including `task.agent` caused bugs where tasks that previously ran Claude would always resolve to Claude even when moved to a Codex column.

**Handoff detection:** When `task.agent` is set and differs from the resolved agent, a cross-agent handoff is triggered. See [Cross-agent handoff](handoff.md) for the full context transfer flow.

## First-Output Detection

Each adapter implements `detectFirstOutput(data)` to spot its first output. A match times the
boot geometry re-assert (see [Output streaming](../../architecture/sessions/output-streaming.md#width-self-heal-and-geometry-re-assert)'s "Post-boot geometry
re-assert"). It does not lift the launch overlay for an agent session; see "The launch overlay"
below for what does.

| Agent | Detection Strategy | Rationale |
|-------|-------------------|-----------|
| Claude Code | `\x1b[?25l` (cursor hide) | The pwsh and Windows PowerShell startup frames carry the same escape, so it times the geometry re-assert only, not agent liveness (see The launch overlay) |
| Codex CLI | `\x1b[?25l` (cursor hide) | Same TUI pattern as Claude |
| Gemini CLI | `\x1b[?25l` (cursor hide) | Same TUI pattern as Claude |
| Qwen Code | `\x1b[?25l` (cursor hide) | Same TUI pattern as Claude (inherited from gemini-cli fork) |
| GitHub Copilot CLI | `\x1b[?25l` (cursor hide) | Same TUI pattern as Claude |
| Cursor CLI | `data.length > 0` | Streams output immediately (no alternate screen buffer) |
| Aider | `data.length > 0` | Aider writes output immediately (no TUI alternate screen) |
| Oz CLI (Warp) | `data.length > 0` | `oz agent run` streams output, no alternate screen |
| Kimi Code | `\x1b[?25l` (cursor hide) | TUI hides cursor when its alternate-screen buffer takes over (verified empirically with kimi v1.37.0) |
| Droid | `\x1b[?25l` (cursor hide) | Ink-based TUI, same pattern as Claude (verified empirically) |
| OpenCode | `\x1b[?25l` (cursor hide) | Full-screen TUI initializes alternate screen buffer with cursor hide on first frame |
| Ollama | `data.length > 0` | Ollama streams output immediately (no alternate screen buffer) |
| Grok Build | `\x1b[?25l` (cursor hide) | Rust alt-screen TUI; the cursor-hide arrives in the very first output chunk, before the alt-screen switch (verified via node-pty against grok 1.0.0) |
| Antigravity CLI | `data.length > 0` | First paint (logo + welcome banner) arrives as one plain-text burst well under a second after spawn (verified against agy 1.1.13) |
| Goose CLI | `data.length > 0` | Streams output immediately (no alternate screen buffer) |

**A detector match is never proof the agent is running.** A shell can emit the same escape
during its own startup: the startup frame of pwsh 7.6 and of Windows PowerShell carries
`\x1b[?25l`, so on PowerShell the latch trips on SHELL bytes tens of ms after spawn, seconds
before the agent process exists, and a `data.length > 0` detector trips on the first byte of
any shell. Anything needing "the agent is demonstrably driving the terminal" must key on the
stream's first alt-screen entry (`PtyBufferManager`'s `onAltScreenEnter`) or on the evidence
below. Misreading this latch as agent liveness is what made the task #573 spawn-race fix miss
its target on PowerShell, and what showed the PowerShell prompt for about three seconds before
Claude's TUI in a Command Terminal.

### The launch overlay

A terminal's launch overlay lifts when `SessionManager.markAgentReady` says the session's agent
is on screen. That is the `session:firstOutput` push and the renderer's `sessionFirstOutput`
map. It fires once, on the first of:

- **The agent's first text after the shell ran the spawn command.** Every agent spawn types the
  shell's own clear in front of the agent command (`buildSpawnClearPrelude`). Under Windows
  PowerShell 5.1, pwsh 7.6 and cmd, ConPTY renders that clear as line erases plus `\x1b[3J`,
  with no `\x1b[2J`. Git Bash, WSL and Linux's ncurses `clear` send `\x1b[H\x1b[2J\x1b[3J`, and a
  terminfo without the E3 capability sends the `\x1b[2J` alone. ConPTY's own startup clear is a
  `\x1b[2J` with nothing printable ahead of it. So the first visible text after either clear,
  when printable text came before that clear, is the agent's, or the shell's error when the
  agent could not start. `AgentOutputTracker` in the pty host reports it as `agentOutput`. It
  needs nothing from the adapter, which is why it covers inline agents (Aider, Cursor, Ollama,
  Goose, Warp, Antigravity) as well as TUIs.
- **The first alt-screen entry.** No shell enters the alt buffer. A fullscreen Claude Code
  enters it before it prints anything, so this is usually what fires for Claude.
- **The agent's SessionStart hook.** For an agent with hooks, measured about 0.4 s after
  Claude's alt-screen entry.
- **A 15 s ceiling** (`AGENT_READY_CEILING_MS`), the backstop for a stream none of the above
  fits. One known case: a terminfo whose clear is `\x1b[H\x1b[J` (TERM=screen, so a dev build
  launched from GNU screen) sends neither erase the handoff test matches. That pair is left out on
  purpose: it is plain cursor-home plus erase-below, and no shell's redraws before the typed
  command runs were measured free of it. The pty host stops scanning a session's output at the
  same 15 s mark.

A session with no agent keeps its raw first output: its shell is the output. Usage is not
evidence either way. The spawn seeds it with the model name from `--model`
(`configuredModelFromCommand`), seconds before the agent draws.

The terminal under the overlay mounts at once and drops PTY output until the lift, then replays
the scrollback. Mounting early is what sizes the PTY: a cold spawn starts at 120x30, and the
mount's fit resizes it to the window before the agent's first frame. Measured in a /preview, a
Command Terminal went from spawn to Claude's TUI in 3.0 to 3.1 s under Windows PowerShell with
the terminal hidden, the same as with it showing the prompt, so no boot query waits on a reply
from the hidden terminal.

## Exit Sequences

Graceful exit sequences written to the PTY before a force-kill, for every agent that is typed into. `SessionManager.suspend()` writes one for each such session; `kill()` writes one for a young one (inside the agent's boot window, see the `kill()` grace in [Shutdown](../../architecture/sessions/shutdown.md)); the quit path's `killAll()` writes one best-effort for each such session; the pty host writes one to an agent whose shell died on its own. An agent whose console close is its graceful exit (see below) gets no sequence on kill, suspend or quit. A step may be a pause (`{ delayMs }`), so keys the TUI must read apart never share a burst.

An adapter whose `consoleCloseIsGraceful(platform)` answers true is never typed into on that platform: kill, suspend and quit close its console at once, and its sequence serves only the dead-shell ask. Claude Code answers true on Windows, measured on 2.1.302 in every state a session can be in, and on Linux, where the close is node-pty's hangup, measured on 2.1.304 in the same states ([Agent absence sweep](../../architecture/sessions/agent-absence-sweep.md#how-claude-code-ends-on-windows-measured), the 2.1.302 table and the Linux table after it).

| Agent | Sequence | Notes |
|-------|----------|-------|
| Claude Code | `Esc`, 400 ms, `Ctrl+C`, `/exit` | Windows and Linux: console close or hangup instead, except for a dead Windows shell. Typed on macOS. Esc stops a running turn or declines a permission prompt, so Ctrl+C clears the input rather than interrupting a turn, which would put the prompt back with `/exit` appended and send it as a new turn |
| Codex CLI | `Ctrl+C` | API-backed sessions, no local state to flush |
| Gemini CLI | `Ctrl+C`, `/quit` | Triggers clean shutdown |
| Qwen Code | `Ctrl+C`, `/quit` | Same TUI shutdown as Gemini (fork) |
| Cursor CLI | `Ctrl+C` | No graceful exit needed |
| GitHub Copilot CLI | `Ctrl+C`, `/exit` | Same TUI exit pattern as Claude |
| Aider | `Ctrl+C`, `/exit` | `/exit` lets Aider flush `.aider.chat.history.md` before termination |
| Oz CLI (Warp) | `Ctrl+C` | No session resume mechanism |
| Kimi Code | `Ctrl+C`, `/exit` | Conventional TUI quit; flushes context.jsonl / wire.jsonl |
| Droid | `Ctrl+C`, `/quit` | Triggers clean shutdown of the Ink TUI |
| OpenCode | `Ctrl+C` | Verified 2026-04-28: PTY exits in ~1s. `/exit` and `/quit` are not recognized slash commands. |
| Ollama | `Ctrl+C`, `/bye` | `/bye` exits the interactive REPL; harmless after a one-shot run has already exited |
| Grok Build | `Ctrl+C`, `/quit` | `/quit` exits cleanly (probe-verified exit 0) and prints the conversation dump that transcript cleanup anchors on |
| Antigravity CLI | `Ctrl+C`, `Ctrl+C` | First Ctrl+C prints "press ctrl+c again to exit" (or cancels a running turn); the second exits gracefully, printing the `agy --conversation=<uuid>` resume summary (the fromOutput capture source) and flushing `cache/last_conversations.json`. No `/quit` slash command exists |
| Goose CLI | `Ctrl+C`, `/exit` | Goose's Ctrl+C is contextual: it clears the line if text is entered, interrupts the request if one is processing, and exits only when the line is already empty. A kill usually lands mid-turn, where Ctrl+C alone only interrupts, so the explicit `/exit` is what ends the session before the teardown grace expires |

A sequence that ends in Enter can answer an open permission prompt: Claude's old `\x03` + `/exit\r` approved the pending tool, because the Enter landed on the highlighted Yes. `scripts/probe-agent-dialog-exit.js` checks the other agents for that, by typing each one's sequence into its own shell-command prompt. Measured 2026-10-19 on Windows:

- Gemini CLI 0.64.0 and Copilot CLI 1.0.98 are safe. Ctrl+C cancelled the request and the tool never ran. The slash command that followed did not take, so the CLI kept running until the force-kill.
- Qwen Code, Kimi Code and Droid were not measured (not logged in on the probing machine), nor Grok 1.0.0 (the service refused the outdated version) or Aider, Goose and Ollama (not installed). Rerun the probe for one of them before changing its sequence.
- Codex, Cursor, OpenCode, Oz (Warp) and Antigravity send Ctrl+C only, with no Enter that could answer a prompt.

## Session History File Location

During cross-agent handoff, each adapter's `locateSessionHistoryFile()` finds the source agent's native session file:

| Agent | File Pattern | Method |
|-------|-------------|--------|
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl`, where the slug is the folder the conversation STARTED in | The reported path, then the cwd's slug, then each parent folder's slug, then every project folder by id (`claude/transcript-locator.ts`, see [Session history](session-history.md#where-a-claude-transcript-is)). A resume from another folder keeps writing the file it started in |
| Codex CLI | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl` | The whole date tree, newest day first, with no wait (`findCodexTranscriptFile`). The attach-time `runtime.sessionHistory.locate` polls today's and yesterday's folders for a rollout the CLI is about to write |
| Gemini CLI | `~/.gemini/tmp/<projectDir>/chats/session-<id>.json` **or** `.jsonl` | Directory scan with polling. Both extensions are live (Gemini cut over on 2026-04-28); an anchored `\.json$` matches nothing on a current install |
| Qwen Code | `~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl` | Direct path construction (the session id is caller-owned via `--session-id`). Despite being a gemini-cli fork, Qwen does NOT inherit Gemini's `tmp/<basename>/chats/session-<timestamp><shortId>.json` scheme |
| Cursor CLI | `~/.cursor/projects/<cwd-slug>/agent-transcripts/<id>/<id>.jsonl` | Direct path. The slug replaces every non-alphanumeric character with `-`, collapses runs, and keeps the working directory's case. Returned only when the file exists. View conversation reads it: the `<user_query>` wrapper comes off, a leading `<timestamp>` tag is dropped, and no clock is shown. The command-injection verifier stays unwired ([Cursor](../../architecture/automations/command-injection-support-matrix.md#cursor-located-not-yet-verified)) |
| GitHub Copilot CLI | N/A | Returns null (not yet empirically verified; activity flows through hooks JSONL) |
| Aider | `<cwd>/.aider.chat.history.md` | Direct path in the working directory, returned only when the file exists. One history file per project directory, with no session id in its name |
| Oz CLI (Warp) | N/A | Returns null (no CLI-accessible session history) |
| Kimi Code | `~/.kimi/sessions/<work_dir_hash>/<sessionId>/wire.jsonl` | Glob across all hash dirs (work_dir hash is opaque) and match on session UUID |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite `session` table) | Read-only WAL handle; match `directory == cwd` and `time_created` within spawn window |
| Droid | `~/.factory/sessions/<cwd-slug>/<sessionId>.jsonl` | Direct path construction, polled up to 10 times at 500 ms because Droid creates the file after the spawn returns |
| Ollama | N/A | Returns null (no CLI-accessible session history) |
| Grok Build | `~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/updates.jsonl` | Deterministic path construction (session id is caller-owned via `-s`) plus a strict existence check, scoped to the given cwd (the `resume-cwd-migration` reachability gate depends on a cross-cwd match NOT counting). The attach-time `runtime.sessionHistory.locate` additionally polls ~60s and falls back to a sessions-root scan for encoding mismatches |
| Antigravity CLI | `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl` | Direct path computation from the conversation id, with a short existence poll (the transcript appears when the first turn starts) |
| Goose CLI | N/A | Returns null (no transcript parsing; resume rides on the caller-supplied `--name`) |

## Prompt Templates

A legacy `spawn_agent` automation row can carry a `promptTemplate` with `{{placeholder}}` variables. Every variable is documented once, in the transition engine's [Template Variables](../../architecture/automations/transition-engine.md#template-variables) section. The two families worth calling out for prompt authoring:

- `{{task_xml}}` is the preferred default: a `<task><title>...</title><description>...</description></task>` envelope (escaped).
- `{{title}}` / `{{description}}` remain for backward compatibility with custom prose templates.

Default template: `{{task_xml}}{{workflow_xml}}{{attachments}}` (`{{workflow_xml}}` is empty, and dropped, for a task outside a workflow)

The `<task>` envelope follows Anthropic + OpenAI guidance: wrap user-authored input in XML tags so the model has a clear data/instruction boundary. Non-XML-aware agents (Aider, Codex) treat the markup as harmless prose. Attachment `@-mention` paths stay outside the envelope so Claude Code / Gemini bare-token parsers reliably auto-inject them.

A typical prompt:

```
<task>
  <title>Fix auth bug</title>
  <description>Users can't login after password reset</description>
</task>
/path/to/screenshot.png
```

Shortcut commands use a separate set of template variables. See [Board config files](../../settings/board-config.md#shortcuts) for the full list.

## CWD Strategy

All agent CLIs are invoked with `cwd` set to:
- **Worktree path** if the task has a worktree
- **Project directory** otherwise

This ensures agents load project-level configuration (`.claude/`, `.gemini/`, `CLAUDE.md`, etc.) from the correct location.

## See Also

- [Cross-agent handoff](handoff.md) - Cross-agent context transfer: extraction, packaging, delivery
- [Activity Detection](../../architecture/activity/index.md) - Event processing, state derivation, subagent-aware transitions
- [Sessions](../../architecture/sessions/index.md) - Spawn flow, resume, crash recovery
- [Worktrees](../../architecture/worktrees/index.md) - Worktree creation, sparse-checkout, hook delivery
- [Settings](../../settings/index.md) - Permission modes
