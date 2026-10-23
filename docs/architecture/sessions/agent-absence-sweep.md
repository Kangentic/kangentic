---
type: Reference
title: Agent absence sweep
description: How the bg-shell watcher's process-tree sweep retires a session whose agent exited under a surviving shell, why a Command Terminal ends but a task stays resumable, the WSL exclusion, and the measured Claude exit paths (console close, hangup, Esc sequence).
tags: [sessions, agent-exit, process-tree, command-terminal, claude]
sources:
  - resource: src/main/activity-engine/background-shell/watcher.ts
  - resource: src/main/activity-engine/background-shell/process-tree.ts
  - resource: src/main/pty/session-manager.ts
    title: isAgentAbsenceCandidate and retireAgentlessSession
  - resource: src/main/pty/host/dead-root-orphans.ts
  - resource: scripts/probe-claude-exit-paths.js
  - resource: scripts/probe-claude-exit-paths-linux.py
  - resource: scripts/probe-conpty-exit-race.js
---
# Agent absence sweep

Kangentic spawns a SHELL and writes the agent CLI command to its stdin, so the agent CLI is a
CHILD of the PTY root, never the root itself (`getSessionRootPid` returns `session.pty.pid`). When
the CLI exits on its own - a user typing `/exit`, a CLI crash, a launch that fails - the shell
survives, the PTY never fires `onExit`, and nothing marks the session finished. The record stays
`running` with `suspended_at` and `exited_at` NULL, the status bar counts a phantom agent, the card
reads active, and the bottom panel keeps a tab (its tab set is `status === 'running'`,
`derivePanelSessions`).

`assessResumeConversation` (see [Resume](resume.md#a-resume-the-cli-cannot-serve-starts-fresh-instead)) removed the two common triggers. The general case is closed by an
**agent-absence sweep**, a third tier of the bg-shell watcher
(`src/main/activity-engine/background-shell/watcher.ts`). The watcher is already registered for
every spawned session, already holds each session's root PID, and already takes one shared process
snapshot per cycle, so the sweep adds no new subsystem.

## Deciding the agent is gone

**No descendant process means no agent.** That is agent-agnostic, so it needs no adapter
capability and no agent-name branching. Two things make it correct rather than merely plausible:

- **The predicate is any-descendant, not shell-like.** `hasNoNonConsoleDescendants`
  (`process-tree.ts`) deliberately does NOT reuse `filterTopmostShellLikeDescendants`, which exists
  to HIDE the `cmd.exe` shim an agent CLI is often launched through - the opposite of what this
  question needs. Measured live: a real session tree is `pwsh -> cmd.exe -> node`, and the
  shell-like filter would treat that `cmd.exe` as a helper.
- **Console hosts are filtered as defense in depth.** Measured across three live instances, all
  nine ConPTY session shells had their `conhost.exe` parented to the ELECTRON caller (a sibling,
  not a descendant), so a bare shell's descendant set really was empty and a plain emptiness check
  would have sufficed. The filter is kept because console-host parenting is an unspecified Windows
  detail that varies by console host and launch path, and the failure is asymmetric: one stray
  console host would silently disable the sweep for that session forever, while filtering costs
  ~0.3us per cycle for a whole fleet.
- **A false positive is worse than the phantom**, so five guards must all hold: the PTY root itself
  alive (otherwise this is ordinary root death); a HEALTHY probe, reusing the watcher's existing
  discriminator that the snapshot must contain the verified-alive root (an empty or partial
  snapshot means the probe failed, not that nothing is running); two consecutive confirmations;
  past a 30s spawn grace; and the session being a `SessionManager`-approved candidate.

`SessionManager.isAgentAbsenceCandidate` owns every session-shaped arm, so the watcher needs no
session knowledge. It requires a `running` session with a live PTY, an agent adapter, a non-WSL
shell (`parseWslShellSpec`, the same detector the spawn uses), and an elapsed spawn grace. A
slow-STARTING agent is not excluded by the grace and does not need to be - its process exists, it
just has not drawn yet, which is exactly why the process tree is a safer signal than a first-output
timeout. A slow-starting SHELL is another matter, and only a Command Terminal pays for it (below).

## Command Terminals

**Command Terminals are judged too, and ended rather than kept.** A Command Terminal runs the
project's agent CLI in a shell at the project root, the same shape as a task session, so the tree
signal reads it the same way. Its row used to be excluded, which left a bare shell at the project
root after `/exit` for anyone holding the session's input, a paired phone included. Now
`retireAgentlessSession` emits `agent-absent` for it and then calls
`SessionManager.endCommandTerminal(id, { immediate: true })`: the PTY is killed, the row is removed
(a `session-removed` push, which closes the desktop window), and the session directory is deleted
after the exit. `remove()` would delete it at once through `SessionFileManager.detachAndDelete`, so
`endCommandTerminal` detaches the files first (`detachPreservingFiles`) and leaves its own
post-exit delete as the only one. A terminal has no task to resume into, so there is nothing to
keep.

Because a terminal is ended rather than kept, being judged too early costs it everything. A shell
slower than the 30s grace to reach the agent command (a heavy profile, a cold machine) shows the
same empty tree as an agent that exited, so a Command Terminal also waits for evidence that its
agent started: its first SessionStart (`agentStartObservedAt`, sticky across `/clear`) or its
first alt-screen entry (`altScreenEnteredAt`), which no shell emits. The first-output latch is not
evidence, because a pwsh preamble trips it. With neither, the sweep judges the terminal once
`COMMAND_TERMINAL_AGENT_START_CEILING_MS` (2 minutes) has passed. That ceiling is what still ends
a launch that failed and an agent with no hooks and no alt screen. Either stays up to two minutes
instead of 30 seconds. A task keeps the plain grace, since its retirement leaves a resumable row,
and so does a workflow's own agent (transient, but no Command Terminal): its retirement keeps an
exited row, which the Workflows pane reads to start it over.

The sweep's cadence alone would leave the shell for 1 to 2.5 minutes, so a Command Terminal has a
fast path. The agent's SessionEnd hook (`onEvent` in `session-manager.ts`) stamps
`agentEndSignaledAt` on the row and calls `requestAgentAbsenceCheck`, which makes the watcher
enumerate for that session on its next base-cadence cycles regardless of the sweep interval, and
the stamp waives the 30s spawn grace. The process tree still decides and the two-observation
confirm still holds, so the end lands about 4s after `/exit`. `/clear` fires SessionEnd too, but its
process stays alive, and the SessionStart that follows clears the stamp and withdraws the request
(`cancelAgentAbsenceCheck`), so the terminal is kept and the remaining fast looks are not spent. An
agent with no SessionEnd hook falls back to the plain sweep.

Where the tree cannot judge, the SessionEnd is the only signal. That is a WSL shell, and any shell
while the bg-shell watcher is off (`SessionTelemetry.hasAgentAbsenceSweep`). There the SessionEnd
arms `COMMAND_TERMINAL_AGENT_END_SETTLE_MS` (5s) instead of asking the sweep. A SessionStart inside
it cancels the end; otherwise the terminal emits `agent-absent` and is ended through
`endCommandTerminal` without `immediate`, since nothing saw the agent's process gone, so `kill()`
still gives a young session that is typed into its exit sequence and grace, and closes a session whose console close is graceful at once. This path has no tree backstop: a SessionStart that landed after the
settle would end a live agent. Measured with `scripts/probe-claude-exit-paths.js --mode clear` on
Claude Code 2.1.294, `/clear` ran SessionEnd (reason `clear`) at 574 ms and SessionStart (source
`clear`) at 722 ms, 148 ms apart, with Claude still running. In a preview on 2.1.296 under
`wsl -d Ubuntu`, main received the two events 240 ms apart and kept the terminal, and a later
`/exit` ended it through the settle. `--mode resume` on 2.1.294 measured the other live pair: a
`/resume` picker left open for 8 s ran no hook, and choosing a session ran SessionEnd (reason
`resume`) and SessionStart (source `resume`) 116 ms apart. Gemini CLI's hooks reference documents
a SessionEnd and a SessionStart for `/clear` as well, with no stated gap.

An agent with no SessionEnd hook, under WSL or with the watcher off, still outlives its agent
until its PTY exits.

A Command Terminal whose PTY exits on its own (a crash, or the shell killed) also ends: after the
`exit` emit, the spawn flow's `onPtyExited` hook removes the row and deletes the directory, so a
Command Terminal's registry row exists exactly while its PTY runs. A workflow's own agent keeps its
row through the same exit, suspended after a Pause or exited, as a task's agent does
(`isCommandTerminalSession` decides which). That removal is skipped while
SessionManager is shutting down, which keeps it out of the bounded quit drain.

## A shell that exits while its agent runs

The inverse case, a shell that exits while its agent keeps running, is the pty host's to clean up,
for task sessions and Command Terminals alike. On Windows node-pty never closes the pseudoconsole
after a natural exit (microsoft/node-pty#965), so nothing ended the agent: measured in a preview, a
killed shell's `claude.exe` was still running a minute later.

### How Claude Code ends on Windows, measured

How Claude Code itself takes each way of ending it, measured on 2.1.294 (Windows 11 build 26200,
node-pty 1.1.0, a mature idle session, a SessionEnd hook recording when it ran; reproduce with
`scripts/probe-claude-exit-paths.js`):

- `/exit` written while the shell lives: hook at 191 ms (`prompt_input_exit`), exit at 622 ms,
  three exit records added to the transcript, every line whole.
- The console closed (`kill()` on a mature session): hook at 131 ms (`other`), exit at 585 ms,
  transcript whole.
- `suspend()` (the exit sequence, then the close at 1500 ms): hook at 169 ms
  (`prompt_input_exit`), Claude gone before the close.
- Shell dead, `/exit` written to the dead shell's console input: hook ran (`prompt_input_exit`),
  exit about 600 ms after the write, three exit records, transcript whole.
- Shell dead, then TerminateProcess: no hook and no exit records; the transcript up to the last
  finished message intact.
- Shell dead, then `IPty.write()`, `kill()`, or terminating the console host: Claude kept running.

Remeasured on 2.1.302 (task #854) across the states a session can be in when it is ended, young
(its boot record still pending) and mature, with the probe's matrix (`--matrix`, or `--deciders` for the cells the exit decision rests on). A cell passes
when Claude exits by itself, runs SessionEnd, withdraws a young boot record, sends no new turn and
runs no tool:

| Way of ending | idle | thinking | draft typed | permission prompt |
|---|---|---|---|---|
| `\x03` + `/exit\r` (the old sequence) | pass | second turn, no exit | pass | tool approved, no exit |
| Console close | pass | pass | pass | pass |
| `\x03`, 300 ms, `\x03` | pass | no exit | young: 4.5 s | no exit |
| `\x04`, 300 ms, `\x04` | pass | pass | no exit | no exit |
| Esc, 400 ms, `\x03`, `/exit\r` | pass | pass | pass | pass |

"Thinking" is a turn ended 250 ms after its prompt, before any answer: Ctrl+C there puts the
prompt back in the input box, so the old sequence appended `/exit` to it and submitted the pair.
The console close exited Claude 0.3 to 0.9 s after it, tens of milliseconds after its shell, and
withdrew a young boot record within 170 ms; the Esc sequence took 0.9 to 1.3 s. With an answer
streaming every way took about 1.9 s, the close included (the shell about 1 s, SessionEnd about
1.65 s). Young streaming could not be reached: haiku's first answer to a launch prompt began about
15 s after the first frame, past the boot window.

The close held under the conditions the incident had. With a sibling holding
`~/.claude.json.lock` for 600 ms at the moment of the close (`--lock-hold-ms`), all twelve young
runs withdrew the record within 1.15 s and exited within 2.6 s; with three Claudes booting at once
(`--siblings 2`) the record went within 125 ms. On 2.1.303 with a copy of a real session's merged
settings and MCP config (`--app-settings`, `--mcp-config`), so Kangentic's own hooks and MCP
server ran in the exit, every state passed again, exiting 0.4 to 2 s after the close and once
4 s: that worst case is what `AGENT_EXIT_WAIT_MS` (8 s) is sized from. The Esc sequence,
measured under the same lock contention, overran a 1.5 s grace in ten of twelve runs.

The quit path, which the probe cannot reach, was checked in a `/preview` on 2.1.304 with
fullscreen turned on through `tui` (so the record is armed): quitting with a young task session
and a young Command Terminal open, both withdrew their records about 1.5 s after the quit, before
their 10 s timers could, and both exited. So the quit closes such a session at once too; nothing
is parked for it.

Through a dead shell's console input (`--channel orphan`) the Esc sequence ended Claude idle,
busy and with a permission prompt open, young and mature, 0.9 to 1.2 s after the write. The old
sequence approved the open prompt's tool there too.

No probe run on 2.1.302 or 2.1.303 wrote an `/exit` record into a transcript that already held an
exchange, though an app suspend on 2.1.303 did (`<command-name>/exit`, then "See ya!", two
seconds after its last turn). On Windows and Linux nothing types `/exit` into a live console any
more; a dead Windows shell's agent still gets it, and so does macOS, on purpose: of the typed
ways, the Esc sequence is the one that ended every state, and the Ctrl+C-only ways that leave no
record failed the thinking state.

### How Claude Code ends on Linux, measured

On Linux the kill is node-pty's `UnixTerminal.kill()`: a SIGHUP to the shell pid, with the
terminal's master left open while the host keeps reading it. Bash passes the hangup on to its
foreground job, Claude. `scripts/probe-claude-exit-paths-linux.py` measured it on 2.1.304 in WSL2
(Ubuntu, a Python pty under `bash --login`, the command typed into the live shell as the host
does). WSL's own Claude login had expired, so the probe ran against a local stand-in for the
Messages API (`--fake-api`, through `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`). It answers
the idle prompt at once, stays silent 1.5 s and then streams the busy prompt's numbers, and asks
for a Bash tool for the dialog prompt, so every state is Claude's own TUI with no account:

| Way of ending (Linux) | idle | thinking | streaming | draft typed | permission prompt |
|---|---|---|---|---|---|
| Hangup (`kill()`) | pass | pass | pass | pass | pass |
| Hangup, master closed as the shell exits (the quit) | pass | pass | pass | pass | pass |
| Shell killed outright (only the kernel's hangup) | pass | pass | not run | not run | pass |
| Esc, 400 ms, `\x03`, `/exit\r` | pass | pass | pass | pass | pass |
| `\x03` + `/exit\r` (the old sequence) | pass | pass | pass | pass | tool approved, no exit |

Each state ran young and mature, thinking and streaming at least twice each. The hangup ran
SessionEnd (`other`) 33 to 162 ms after it, exited Claude 0.33 to 0.71 s after it, and withdrew
every young boot record; the Esc sequence took 1.06 to 1.31 s. A `CLAUDE_CODE_NO_FLICKER=1` session entered the alt
screen and never wrote a record. The stand-in reproduced the dialog failure of the old sequence
but not its thinking failure, which needs a real model's turn, so the old sequence's thinking pass
is not evidence for it. The hangup is a signal, not keys, so that limit does not reach it.

The probe launches Claude under bash only. The shell-killed row is why that does not narrow the
result: there bash passes nothing on, and the kernel's hangup of the terminal's foreground job
alone ended Claude gracefully, which is what any shell running Claude in the foreground (zsh,
fish, nushell) leaves it with when the shell dies.

So Claude on Linux is hung up, never typed into (`consoleCloseIsGraceful`). macOS has not been
measured. The Linux probe reads processes with `ps` where `/proc` is missing (`--use-ps` forces
it, and two Linux cells passed that way), so one run on a Mac answers it. That run would still
launch Claude under bash, where a Mac user's shell is usually zsh; the shell-killed cells cover
the difference the same way.

### The fullscreen renderer

`CLAUDE_CODE_NO_FLICKER=1` (`--renderer no-flicker`) brought the fullscreen renderer up and never
wrote a boot record, in two runs on 2.1.302 and one on 2.1.303, and a young close left nothing
behind. That is the documented behavior: Claude's settings reference names the variable the
per-session override of `tui`, and its fullscreen page says a session started with it "renders
fullscreen even after a failed start, and doesn't count it". Kangentic turns fullscreen on that
way now (`rendererEnvironment` in the Claude command builder), so a Kangentic session no longer
arms the canary at all; the close and the grace above still give Claude its SessionEnd hooks and
its transcript.

The documented precedence held on 2.1.303 (`--env`, `--tui`): `CLAUDE_CODE_NO_FLICKER=1` drew
fullscreen over `tui: "default"`; `CLAUDE_CODE_NO_FLICKER=0` drew classic over `tui: "fullscreen"`;
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` drew classic over `CLAUDE_CODE_NO_FLICKER=1`. So Kangentic
sets the variable only when the project's and the user's settings name no renderer or name
fullscreen, and a user's own exported `CLAUDE_CODE_NO_FLICKER` or
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` is passed on instead of it (the spawn environment would
otherwise strip it with every inherited `CLAUDE_CODE_*` key). Inherited values are ignored when
Kangentic itself runs inside a Claude session (`CLAUDECODE` set): they are that session's.

So Claude on Windows is closed, never typed into (`consoleCloseIsGraceful`, see [SessionManager.kill()
and the young-session grace](suspend-and-cleanup.md#sessionmanagerkill-and-the-young-session-grace)), and the Esc sequence is its exit sequence where a console cannot
be closed (below) and on macOS, which neither probe has measured.

### Asking the orphaned agent to exit

So the host asks first (`src/main/pty/host/dead-root-orphans.ts`): it writes the session's exit
sequence into the dead shell's console, waits up to 10 s for the processes it found to exit, and
terminates only what is left, each through a handle whose creation time is re-checked (see
`.claude/rules/pty-teardown-grace.md` and `.claude/rules/task-process-tag.md`). It finds them by
the shell's own lifetime: the host holds a handle on every Windows PTY root from the moment
node-pty sets its pid until it handles the exit (`pinRoot`), reads the exact creation and exit
times off it, and runs no cleanup without both, so a child of an earlier or later owner of the
shell's pid is never taken for the shell's (see
[Process reaping](../worktrees/process-reaping.md#parent-pids-windows-reuses)). What outlives the
grace, a dev server the agent started included, is terminated, as a crashed pty host's tree stop
does. On POSIX the kernel hangs up the terminal's foreground process group when the shell exits.
On Linux that ends Claude gracefully: with its shell killed outright (`shell-killed` in the Linux
probe), 2.1.304 ran SessionEnd about 50 ms later and exited 0.4 to 0.6 s after the kill, idle,
thinking and with a permission prompt open, young and mature.

The dead shell's `conhost.exe` stays until the pty host exits, one per PTY that exits on its own
(about 1.5 MB private each). That is the same node-pty bug: its native exit path drops its record
of the pseudoconsole without closing it, so a later `kill()` finds nothing to close. It needs the
upstream fix, microsoft/node-pty#990. With that fix the console's close also sends a still-attached
agent `CTRL_CLOSE_EVENT`, which Claude Code 2.1.294 handles gracefully (the console-close row
above), so the host's ask and the close then work together rather than against each other.
Measured with `scripts/probe-conpty-exit-race.js --mode churn`, 1,500 of them in one process
caused no failure, so the host leaves them; restarting it to close them would end every terminal
it holds.

The PTY's conout worker thread was a second, larger leftover. node-pty ends it only in `kill()`,
and the host never killed a PTY that had exited, so each natural exit kept one: the probe's
worker process grew from 36 MB to 688 MB over 100 exits on node-pty 1.1.0, and to 690 MB on
1.2.0-beta.15. The host now kills such a PTY once nothing writes to it (`releaseExitedPty` in
`pty-host-core.ts`): after the orphan cleanup, or at the exit when none runs, and only on
Windows. With that kill the same 100 exits ended at 62 MB. The kill frees the worker and nothing
else, since node-pty's native side forgot the PTY at the exit and the console-list shortcut
returns no pid once the exit code is set.

## WSL

The **WSL exclusion covers a different failure than the others**: there the tree signal is
UNREADABLE, not empty. A WSL session's PTY root is `wsl.exe`, and the agent is not a Win32
descendant of it either way - a distro-native CLI is a Linux process in another PID namespace, and
the interop path Kangentic actually uses ([WSL runs the Windows binary (interop)](../../platforms/shells-and-paths.md#wsl-runs-the-windows-binary-interop))
launches the Windows binary through WSL's binfmt host rather than under this `wsl.exe`. Since the
Windows probe enumerates `Win32_Process`, a perfectly HEALTHY WSL agent presents an empty descendant
set and passes every other arm, so the sweep would force-kill live work. Refusing to judge it fails
safe to the pre-existing phantom instead. Note this arm is a DENYLIST and closes only the known
case; an allowlist (require that the tree showed a non-console descendant at least once before
absence can be concluded) would close the whole class of structurally invisible subtrees.

## Cadence and what a retirement does

**Cadence.** The sweep runs on its own 60s clock (`AGENT_ABSENCE_SWEEP_INTERVAL_MS`), decoupled from
the watcher's 2s/4s/6s poll backoff, and evaluates for free on any cycle that already enumerated for
bg-shell work. `listAllProcesses` is a pty host round trip that lists every process (a Toolhelp
snapshot on Windows, about 8 ms, which replaced a ~200ms PowerShell CIM query), and the watcher
deliberately skips it on idle cycles, so a per-session-per-cycle check would defeat that
optimization exactly when the machine is saturated. A sweep-only cycle neither increments nor resets
the bg-shell backoff counter. The counter counts consecutive OBSERVATIONS, not poll cycles: a
skipped cycle is neutral, because resetting on skips would mean the count could never reach two.

**What it does.** `SessionManager.retireAgentlessSession` re-checks the guard (the watcher decides
asynchronously) and routes through `kill()`, so the entire existing exit path runs: record marked
exited, queue slot freed, hooks stripped, transcript flushed, and `intentionalExit` suppressing the
renderer's false "Session crashed" toast. Once the tab is gone the leftover shell is unreachable,
so leaving it alive would only leak a process.

**It first emits `agent-absent`, so a failure the CLI named is not lost with it.** The kill's
`intentionalExit` also silences the exit listener's startup-failure read, and a CLI that ended at
boot with its own account of why (Claude's "No conversation found with session ID" on a `--resume`
whose transcript was cleaned up or whose project folder moved) reached the user as a card that
went quiet: exit code 0, no toast, a dead row (#682 follow-up). The retirement therefore announces
the absence before the kill, while the ring still holds the CLI's last words; `handlers/sessions.ts`
asks the session's adapter to read them (`AgentAdapter.describeStartupFailure`, implemented by
Claude) and raises `notifySpawnBlocked`'s "Agent did not start" notice when they name a failure. The
rare direct PTY exit (the CLI was the root, or its shell ended with it) takes the same read from the
exit listener when the exit is not intentional. Most resumes of a deleted conversation never get
here: `assessResumeConversation` ([Resume](resume.md#a-resume-the-cli-cannot-serve-starts-fresh-instead)) starts them fresh before the spawn. This notice covers what
that check cannot prove (a conversation whose evidence is gone, a WSL path), and it stays a notice
rather than a restart.

**It must also emit `session-changed`, and that emit is load-bearing.** Measured in a live preview:
with `kill()` alone, main and the DB were both correct (`exited`, code 0) while the board kept
counting the agent and the bottom panel kept its tab - the exact two symptoms the sweep exists to
remove. The renderer's `SESSION_EXIT` handler deliberately returns early on an INTENTIONAL exit
(`App.tsx`), because it cannot tell a suspend from a hard end without racing the suspended status
push, so it never runs its own `updateSessionStatus`; and both `derivePanelSessions` and the agent
count read the renderer store, not the DB. `session-changed` (broadcast as `SESSION_STATUS`) carries
a resolved status and has no such ambiguity, so the retirement announces itself there. Pinned by
`tests/unit/session-manager-agent-absence.test.ts`.

The reported exit code is forced to **0** via `ManagedSession.overrideExitCode`, which deliberately
MASKS the OS code. A force-kill reports abnormally on every platform, and `getInterruptedExited`
resumes exactly those on the next launch - so the real code would resurrect the very conversation
the user `/exit`-ed, contradicting that query's "clean exit 0 is excluded". This coupling is pinned
by `tests/unit/session-interrupted-exited-sql.test.ts`, which runs the real query over both designs.

The sweep inherits the watcher's kill switches (`disableBgShellWatcher`,
`KANGENTIC_BG_SHELL_WATCHER=0`, a missing `getSessionRootPid`); with the watcher off there is no
phantom detection, which is accepted since it is the same subsystem. Covered by the `agent-absence
sweep` block in `tests/unit/bg-shell-watcher.test.ts` and by
`tests/unit/session-manager-agent-absence.test.ts`.
