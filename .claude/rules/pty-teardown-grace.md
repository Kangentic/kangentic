---
paths:
  - "src/main/pty/**"
  - "src/main/ipc/**"
  - "src/main/transition-engine/**"
  - "src/main/agent/**"
---
# Rule: an agent ends the way it was measured to end safely, never cut short

Claude Code keeps a boot canary in `~/.claude.json`: `fullscreenBootPending[pid]` is written at
REPL mount and withdrawn 10 s after the first rendered frame, or on a graceful exit (`/exit`,
Ctrl+C, Ctrl+D). A record whose pid is dead at the next launch is a strike. One strike runs that
launch on the classic renderer and prints "fullscreen renderer didn't finish starting last time";
two make the classic renderer sticky on the machine until `/tui fullscreen` or a Claude update.
Kangentic turns fullscreen on for every user without a `/tui` choice, so a strike silently
brings back the scrollback duplication fullscreen was adopted to fix. Two busy young Claudes moved
back to To Do did exactly that on 2026-10-19 (task #854).

A bare `pty.kill()` is ClosePseudoConsole on Windows. Claude gets about 100 ms, and the locked
withdrawal of the record (a 1.4 MB read, parse, rewrite under `~/.claude.json.lock`) lands at
82 to 97 ms on an idle machine, so load or a sibling Claude holding the lock leaves the record
behind. This shipped: a Command Terminal stopped inside its first seconds, and every later launch
on the dogfooding machine printed the fallback line. The 1500 ms `suspend()` already gave every
session is what `kill()` now gives a young one.

That 100 ms was measured on Claude Code 2.1.268. On 2.1.302 (Windows 11 build 26200, node-pty
1.1.0, `scripts/probe-claude-exit-paths.js`, task #854) the console close is Claude's graceful
exit in every state measured, young and mature: idle, a turn still thinking, an answer streaming,
a draft typed, a permission prompt open. Claude ran its SessionEnd hook (reason `other`),
withdrew its boot record within 170 ms of the close, and exited 0.3 to 0.9 s after it (about
1.9 s while streaming). The typed `\x03` + `/exit\r` failed two of those states: a turn still
thinking took Ctrl+C as an interrupt that put its prompt back, so `/exit` was appended and sent as
a second paid turn and Claude never exited, and an open permission prompt took the Enter as yes
and ran the tool. The close also held with a sibling holding `~/.claude.json.lock` for 600 ms
(record withdrawn within 1.15 s, exit within 2.6 s), with three Claudes booting at once, and on
2.1.303 with a real session's hooks and MCP server (exit 0.4 to 2 s, once 4 s). So Claude on
Windows is closed, never typed into.

On Linux node-pty's kill is a SIGHUP to the shell, which bash passes on to Claude. Measured on
2.1.304 in WSL2 (`scripts/probe-claude-exit-paths-linux.py`, against a local stand-in for the API,
so the states are Claude's own TUI with no account), the hangup is Claude's graceful exit in the
same states and ages: SessionEnd (`other`) within 162 ms, exit 0.33 to 0.71 s after it, every
young record withdrawn, no second turn, no tool run. It held with the terminal's master closed
the moment the shell exited, which is the quit, and with the shell killed outright, where only
the kernel's hangup reaches Claude. That last case is why the result does not rest on bash
passing the signal on: any shell that runs Claude as the terminal's foreground job (zsh, fish,
nushell) gets it hung up by the kernel when the shell dies. So Claude on Linux is hung up, never
typed into, too.

The fullscreen renderer is also turned on without the canary: Kangentic sets
`CLAUDE_CODE_NO_FLICKER=1` in the spawn environment instead of `tui: "fullscreen"` in
`--settings` (`rendererEnvironment` in the Claude command builder). Claude's docs make that
variable the per-session override of `tui`, and say a session started with it renders fullscreen
even after a failed start "and doesn't count it". Measured on 2.1.302 and 2.1.303 on Windows and
2.1.304 on Linux, such a session draws in the alt screen and never writes a `fullscreenBootPending`
record, so no death of a Kangentic session can strike the renderer. The variable outranks even
`tui: "default"`, so it is set only when no renderer was chosen or fullscreen was, and a user's own
exported `CLAUDE_CODE_NO_FLICKER` or `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` is passed on in its
place. A WSL shell's spawn lists the variable in `WSLENV`, or it never reaches the distro. The
grace and the close still matter for SessionEnd hooks and the transcript, and for a user whose own
`tui` choice Kangentic leaves alone.

## The rule

- **An agent whose console close is its graceful exit is closed, never typed into.** The adapter
  says so per platform (`consoleCloseIsGraceful`, read onto the session at spawn); Claude does on
  Windows and Linux. `kill()`, `suspend()` (`gracefulPtyShutdown`) and `killAll()` then write
  nothing and close at once, at any age: no exit sequence, no natural-exit wait, nothing parked.
  Its exit sequence is kept for the one console that cannot be closed, a Windows shell that died
  on its own (below). Do not answer that flag with true for an agent and platform the probe has
  not measured in every state: keys and a close are each safe only where measured. For the same
  reason a WSL shell on Windows is typed into whatever the adapter says (`performSpawn`): ConPTY
  closing `wsl.exe`, then a hangup in the distro, is a chain neither probe ran. **Known gap.**
  macOS is unmeasured (no machine to run the Linux probe on), so Claude there is still typed
  into, with the Esc sequence. On Windows that sequence overran a 1.5 s grace in ten of
  twelve runs under lock contention, so a macOS young kill or suspend can land its hangup while
  Claude is still in its SessionEnd hooks or writing its transcript. The Linux probe reads
  processes with `ps` where `/proc` is missing, so closing the gap is one run of it on a Mac. The
  boot canary is not at stake there: the
  `CLAUDE_CODE_NO_FLICKER` default ships on every platform, and Claude's fullscreen docs say such
  sessions are not counted.
- **Every force-kill of a session PTY goes through `SessionManager.kill()`, `suspend()`, or
  `killAll()`.** For an agent that is typed into, `kill()` writes the adapter's exit sequence and
  parks the PTY on `DeferredKillRegistry` (`src/main/pty/lifecycle/deferred-kill.ts`) for
  `KILL_GRACE_MS` when `isYoungSession` says the agent may still be inside the canary window
  (alt-screen entered under 12 s ago, or no alt screen yet and spawned under 60 s ago); a mature
  session is killed at once. An exit sequence may hold pauses (`{ delayMs }`, written by
  `shutdown/exit-sequence.ts`), so keys the TUI must read apart, Esc and the text after it, never
  share a burst.
  `session.pty` is nulled synchronously either way, so a deferred PTY lives outside the registry
  row and no respawn or reset can cut its grace short. Do not add a direct `pty.kill()` /
  `safeKillPty()` on a session PTY anywhere else, and do not add a caller that knows better
  without the `immediate` option and a reason (the agent-absence sweep is the one that exists:
  its agent is already gone, and it stamps `exited` at once). The PTY itself lives in the pty host
  ([[pty-host-out-of-process]]): `session.pty` is a `RemotePty` handle, a kill is a command the
  host carries out, and the grace timer stays on main. The host's own `kill` handling is
  allowlisted in `pty-host-core.ts`, and its `shutdown` kills nothing, so a parked PTY's grace is
  never cut short there. The file's other `.kill()` is `releaseExitedPty`, which runs only on a
  Windows PTY whose process already exited on its own (see the next bullet), so it ends nothing.
- **An agent whose shell exited on its own is asked to exit before anything is terminated
  (Windows).** node-pty never closes the pseudoconsole after a natural exit (microsoft/node-pty#965),
  so the agent the shell started keeps running with no session. The pty host ends it in
  `host/dead-root-orphans.ts`: it writes the session's exit sequence into the dead shell's
  still-open console input (`spawn/exited-console-input.ts`, the one channel that reaches it),
  waits up to `DEAD_ROOT_ORPHAN_EXIT_GRACE_MS` (10 s) for the processes it found to exit by
  themselves, and only then terminates what is left, by identity, each through a handle whose
  creation time is re-checked. The shell's own lifetime bounds what counts as its child: the host
  holds a handle on every Windows PTY root from its pid to its exit (`pinRoot`) and reads the exact
  creation and exit times off it, and without them the cleanup does not run. The exited-root wait
  uses the pinned creation time too, and the spawn clock without one, since it only waits.
  Measured on Claude Code 2.1.294: asked this way, Claude ran its SessionEnd hook and exited
  about 600 ms after the write with its transcript whole; terminated,
  it runs no SessionEnd hook and writes no exit records. On 2.1.302 Claude's Esc, pause, Ctrl+C,
  `/exit` sequence written this way ended it idle, busy and with a permission prompt open, young
  and mature, 0.9 to 1.2 s after the write; the old `\x03` + `/exit\r` approved the open prompt's
  tool and left Claude running. `IPty.write()` after the exit, `kill()`
  after the exit, and terminating the console host all leave it running, so none of them can
  replace the ask. Do not shorten the grace below Claude's SessionEnd budget (1.5 s by default,
  raised by a hook's own timeout). It runs in the utility host only (never the in-process core,
  whose fake PTYs carry real-looking pids), and never after a kill the host was sent, during a
  quit, or for a WSL root.
- **A PTY that exited on its own is released once nothing writes to it (Windows).** node-pty ends
  a ConPTY's conout worker thread only in `kill()`, so the host kept one per natural exit:
  measured at about 6.5 MB each, 36 MB to 690 MB over 100 exits, on node-pty 1.1.0 and
  1.2.0-beta.15 alike. `releaseExitedPty` kills the exited PTY after the orphan cleanup is done
  with its console, or at the exit when none runs. That kill frees the worker and nothing else:
  node-pty dropped its native handle at the exit, and the console-list shortcut returns no pid
  once `_exitCode` is set. Never on POSIX, where a kill after the exit signals a pid that may name
  another process by then. The pseudoconsole itself stays open until the host exits (#965): one
  console host per natural exit, and 1,500 of them in one process measured no failure. Restarting
  the host to close them was the alternative, rejected because it ends every terminal it holds.
  Background: `docs/architecture/sessions/suspend-and-cleanup.md` (the kill and the young-session
  grace). Measurements of each way Claude Code exits: `docs/architecture/sessions/agent-absence-sweep.md`.
- **A reap, a suspend and `awaitExit` wait for the agent a closed shell left running.** A PTY's
  exit is its shell's: a kill ends the shell at once, and the agent the shell started is still
  running its own exit (SessionEnd hooks, transcript, boot record) when the PTY's exit lands.
  Tagged and in the task's directory, it is a leftover to the reap; in the session's cwd, it
  overlaps a resume or a folder move. So `reapTaskProcesses` asks the host to `awaitAgentExit`
  for its tasks (`host/exited-root-wait.ts`) before it scans, and `suspend()` and `awaitExit()`
  ask for a session whose console close is graceful before they resolve. The host records each
  task root the moment its kill arrives (so a wait posted right after the kill still finds it), or
  when its shell exits on its own, and polls the agent that root left running until it is gone or
  `AGENT_EXIT_WAIT_MS` runs out. The agent is the shell's children, looking through a shell or
  launcher among them (`cmd.exe` under a `.cmd` shim, a Git Bash stub), and never what the agent
  itself started: a dev server it left running never exits by itself, and a mid-board suspend
  leaves it up by decision, so watching it would hold every wait to its bound. On Windows the host
  finds the agent by parentage and creation time, as the orphan cleanup does. On POSIX the
  shell's death re-parents it, so the host lists it just before it sends the hangup (one `ps`
  shared by kills that arrive together, the hangup held for it at most `KILL_SNAPSHOT_CAP_MS`) and
  polls those pids. For a Windows shell that exited on its own it waits for the orphan cleanup to
  finish instead. It asks nothing and terminates nothing; what outlives the bound is reaped as
  before. Do not shorten the bound below Claude's SessionEnd budget. A WSL root and the in-process
  core hold no ledger, so a Command Terminal's reap keeps a short fixed delay as their backstop
  ([[task-process-tag]]).
- **A caller that touches the session's cwd or process tree after a kill waits for the process,
  not for the call.** `kill(id)`, then capture `awaitExit(id)`, THEN `remove(id)` (the row must
  still exist when the promise is made), then await it before any `rmSync`, `removeWorktree`, or
  `reapTaskLeftovers`. That reap force-kills the task's tagged processes in its directories, so it also waits
  for `removeByTaskId` to settle; the pty host protecting any PTY it still holds is the second
  line, not the first. The reap also waits on its own for a PTY of its tasks still parked on the
  deferred kill (`DeferredKillRegistry.sessionsAwaitingExit`, bounded by the grace plus 1500 ms):
  a Done move right after a young session was stopped finds no PTY for `suspend()` to wait on,
  and the host would protect the still-running agent and its children. Kill every session first
  and `Promise.all` the waits, so N young sessions cost one grace. Never await the exit inside the
  per-project worktree queue.
- **The quit path defers only where the drain follows.** `killAll({ allowGrace: true })` is
  passed only from `before-quit` (unless a Windows session-end disarmed the drain) and the
  powerMonitor shutdown; a signal handler or session-end calls it bare and gets the instant kill
  plus a flush of every parked PTY. The report's `deferredCount` extends the drain's deadline by
  the grace; at 1500 ms each, an unextended deadline would fire as the deferred kill lands.
  `SessionManager.dispose()` never touches the registry: it runs one statement after `killAll()`.
- **A short-lived probe PTY runs Claude on the classic renderer**
  (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, which never arms the canary) and exits it with
  `/exit`, waiting on the PTY's own `onExit` before the fallback kill. The model picker probe is
  the one that exists. It writes Esc and `/exit` only after its own `/model` was submitted, and
  not when a dialog replaced the picker. A dialog takes typed keys as its answer, so a run that
  never got `/model` into the input box, or whose Enter opened a dialog, ends on the plain kill,
  which the classic renderer makes safe.
- **Every Kangentic read-modify-write of `~/.claude.json` runs under `withClaudeJsonLock`**
  (`src/main/agent/adapters/claude/claude-json-lock.ts`), which takes Claude's own
  `~/.claude.json.lock` as well as the in-process chain, and reads inside it. A write that
  straddles Claude's locked withdrawal of the record resurrects it. On a final `ELOCKED` the
  writer skips, as Claude does.

## Enforcement (self-maintaining)

- **Test (static scan):** `tests/unit/pty-teardown-grace.test.ts` scans `src/main/**` and fails
  on a `safeKillPty(` call, or a `.kill()` call in a file that imports `node-pty`, outside the
  allowlisted teardown modules; and on a `~/.claude.json` writer under `adapters/claude/` that
  does not go through `withClaudeJsonLock`. Runs in CI via `npm run test:unit`.
- **Tests (behavior):** `tests/unit/deferred-kill.test.ts` pins `isYoungSession`'s two bounds and
  the registry's timer, cancel, and flush; `tests/unit/session-manager-deferred-kill.test.ts`
  pins `kill()`'s exit sequence, the synchronous `session.pty = null`, the deferred force-kill,
  the cancel on a natural exit, the `immediate` option, and `killAll`'s report;
  `tests/unit/session-shutdown-flow.test.ts` pins the quit-path deferral and flush; the same three
  files pin that a session whose console close is graceful is closed at once with nothing typed
  and nothing parked, and `tests/unit/claude-exit-behavior.test.ts` pins Claude's answer (Windows
  and Linux, not macOS) and its typed sequence; `tests/unit/exit-sequence.test.ts` pins the pauses;
  `tests/unit/pty-exit-callback-drain.test.ts` pins the deadline extension;
  `tests/unit/claude-model-picker-probe.test.ts` pins the probe's env, its graceful exit, and its
  no-key-into-a-dialog guards;
  `tests/unit/claude-json-lock.test.ts` pins the file lock's acquire, wait, stale break, and
  ELOCKED skip. `tests/unit/dead-root-orphans.test.ts` pins the orphan cleanup's identity window
  (the pinned creation and exit, the pin taken and released, no cleanup without one),
  that it asks before it terminates and terminates nothing that exits within the grace, and that a
  kill, a quit, a WSL root, POSIX and the in-process core never run it;
  `tests/unit/exited-console-input.test.ts` pins the node-pty fields the ask writes through.
  `tests/unit/exited-root-wait.test.ts` pins the agent-exit wait: the early answer once the
  agent is gone whatever it left running, the look-through of a launcher that exits first, the
  bound, the identity window, a reap asked for before the shell has exited, the wait on an orphan
  cleanup still asking, the ledger's prune, the POSIX pre-kill listing (the hangup held for it,
  its cap, one listing for kills that arrive together, the wait by pid), and that the in-process
  core, a quit and a PTY with no task never wait. `session-reap-parked-exit.test.ts` pins that the
  reap waits on it before it scans and still reaps when it fails;
  `session-manager-deferred-kill.test.ts` that `suspend()` and `awaitExit()` of a graceful-close
  session wait on it and of any other never do; `session-spawn-flow.test.ts` that a WSL shell is
  typed into and lists the renderer variables in `WSLENV`.
  `tests/unit/pty-host-core.test.ts` pins the post-exit release (Windows only, once, never after
  a kill main sent, raw PTYs too), and `dead-root-orphans.test.ts` pins that it waits for the
  orphan cleanup to finish with the console.
- **Review:** the `awaitExit` ordering is control flow the scan cannot see; `/code-review` flags a
  kill followed by filesystem work with no exit barrier.

## Scope

Session PTY teardown in the main process (`src/main/pty/**` and its callers under `src/main/ipc/**`,
`src/main/transition-engine/**`, `src/main/agent/**`), the Claude adapter's probe PTY, and the
Claude adapter's `~/.claude.json` writers. The respawn sibling drain in `session-spawn-flow.ts`
keeps its direct kill: it only ever finds a row whose `pty` is already null, since every kill path
nulls it first, and `SessionManager.spawn` ends a task's hidden early agent through `kill()` before
any other spawn for that task reaches it. Two more direct kills in that file kill with no grace for one reason: a spawn
abandoned because a teardown overtook its host round trip (`abandonCancelledSpawn`), and one
overtaken by the quit. The host started that PTY one round trip ago, before the agent reaches its
boot canary. Not covered: a dev restart that terminates Electron without `before-quit`, which no
app-side code can reach.
