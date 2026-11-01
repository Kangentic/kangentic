---
paths:
  - "src/main/pty/process-tag/**"
  - "src/main/pty/lifecycle/session-spawn-flow.ts"
  - "src/main/ipc/helpers/task-cleanup.ts"
  - "src/main/ipc/handlers/task-move.ts"
  - "src/main/ipc/handlers/projects.ts"
  - "src/main/agent/mcp-project-context.ts"
  - "src/main/transition-engine/resource-cleanup.ts"
  - "src/main/agent/adapters/codex/command-builder.ts"
---
# Rule: a task's processes carry its tag, and every terminal transition reaps what is the task's

A user moved a task to Done and the processes its agent had started kept running. The old reap
read a per-session snapshot of the PTY's descendant pids, and that snapshot was deleted at every
suspend, never held a process whose launcher exited inside one 2 s watcher cycle (`nohup X &`,
`Start-Process`), and died with the app. Every session's PTY now carries
`KANGENTIC_TASK_ID=<taskId>`, which every descendant inherits however it detached, and a terminal
transition kills what the task left running (`src/main/pty/process-tag/`). The tag alone
over-reaches: a tmux server, pm2's daemon, an editor or a browser the agent happened to start first
inherits it and goes on serving the user's other work. So a kill needs more than the tag, and this
rule keeps both halves true: every spawn tags, and every reap kills only what is the task's.

## The rule

- **Only `performSpawn` sets the tag, and it tags every session.** `performSpawn`
  (`session-spawn-flow.ts`) adds it through `addTaskProcessTag` with the session's task id and lists
  it in `WSLENV` on a WSL shell. A Command Terminal runs an agent, so it is tagged too, with its own
  made-up task id, which no other session shares; that replaces any tag main's environment carries
  (Kangentic run from a task's terminal). A workflow's own agent (`src/main/workflows/workflow-agent.ts`)
  is tagged with its workflow's id, its session's `taskId`, which no task shares, so no task's reap
  matches it. Do not set `KANGENTIC_TASK_ID` anywhere else, and do not let a spawn path that bypasses
  `performSpawn` start agent work untagged.
- **An agent CLI that can strip inherited variables from its tool shells re-injects the tag.**
  The two task spawn chokepoints pass `taskProcessTag` (the task id) on `CommandOptions`, and
  `startCommandTerminal` passes the terminal's own task id. The adapter turns it into its CLI's own
  mechanism, inside `adapters/` (Codex: `-c shell_environment_policy.set.KANGENTIC_TASK_ID=<id>`).
- **Every terminal transition calls `reapTaskLeftovers(context, projectPath, tasks)` after the
  task's sessions have exited and before any worktree removal.** Today that is the Done branch of
  `handleTaskMove`, `cleanupTaskSession` (To Do, Backlog demote, task and bulk delete, unarchive
  into To Do), the MCP `onTaskDeleted` (any task, worktree or not), `PROJECT_DELETE` (archived
  tasks included), and the startup sweep for archived and To Do tasks. A new terminal transition
  calls it too, with the project path and each task's `worktree_path`. In a dev build, with
  stopping on, `reapTaskLeftovers` first stops a `/preview` running in each task worktree through
  the launcher's stop file (`src/devtools/main/worktree-preview-stop.ts`), so its Electron quits
  through the real quit path instead of outliving a terminate on a dead dev server. That stop file
  says `worktree-removal`, so `dev.js` starts no detached trash deleter (tagged, working in the
  temp folder, it made the tab's `cmd` read as shared), and the stop waits, bounded, for the rest
  of the preview's tree from the pty host's process listing before the reap scans: `dev.js`
  exiting is not the preview being gone.
- **A task reap lets the task's own agent finish exiting first.** "The sessions have exited"
  means their shells have: the agent a killed shell started is still in its own exit.
  `reapTaskProcesses` waits, bounded, for the agent each task's killed or exited shells left
  running before it scans (`host/exited-root-wait.ts`, see [[pty-teardown-grace]]). That wait
  finds the agent by parentage and creation time on Windows, and on POSIX by the pids the host
  listed under the shell just before its hangup, never by tag, and kills nothing. It watches the
  agent alone, not what the agent started, so a dev server the task left running never holds it;
  anything left at its bound is the reap's as before. **Known gap.** A WSL root holds no ledger (its agent runs inside
  the distro, out of the host's sight), so nothing waits before the in-distro reap. That reap
  starts only after the host reap's two passes (a one second wait between them) and the
  `wsl.exe` listings, past Claude's measured 0.33 to 0.71 s exit after a hangup, but no wait
  guarantees it.
- **A Command Terminal's end reaps its leftovers, after any exiting agent has finished.**
  `CommandTerminalLeftoverReaper` (`ipc/helpers/command-terminal-leftovers.ts`) calls
  `reapTaskLeftovers` with the terminal's folder and its own task id, named for the report, on its
  `session-removed`. The reap's own agent-exit wait covers Claude's exit after a Stop and the pty
  host's orphan grace; `COMMAND_TERMINAL_REAP_DELAY_MS` (5 s, past Claude's longest measured exit
  after a close) is the backstop for a root that wait holds no ledger for, a WSL shell or the
  in-process core, so the reap never force-kills an agent mid-exit (see
  [[pty-teardown-grace]]). Its folder is never passed as a worktree, because a project root is
  shared with every task that has no worktree (so the dev-preview stop above, keyed on a task's
  worktree, never applies to one). Nothing is reaped during a quit, as for tasks.
- **A kill needs the tag AND the task's directory, and nothing in `reap-plan.ts` may relax that.**
  In the host reap, a process is killed only when it carries the task's tag, works inside the task's project or
  worktree, nothing under it shows it is shared (a readable descendant without this task's tag, or
  one working elsewhere), no other Kangentic work holds a loopback TCP connection to a port it
  listens on (a client under a live PTY, or one carrying another task's tag or a cleared one, or a
  client spared as shared itself), and it is not protected (Kangentic's tree, a held PTY, a visible app, a
  tmux server, each with everything under them). A process whose every child is kept is kept too,
  unless it listens on a port itself or the first pass already signalled it. What the first pass
  kept, the second pass keeps. A process
  whose directory cannot be read is never
  killed. Do not add a kill path that skips any of these, and do not exempt processes by name: each
  protection rests on a measured mechanism (`docs/architecture/worktrees/process-reaping.md`, "What the reap kills").
  An untagged client outside Kangentic (the user's browser, Android Studio) is no evidence, by
  decision: a dev server open in a browser tab must still stop at Done.
- **On macOS a withheld orphan in the worktree is the task's.** SIP hides the environment of
  Apple's `CS_RESTRICT` tools from the kernel record, so the reap also kills a process whose
  environment was withheld, whose parent is `launchd`, and whose working directory is inside a
  reaped task's worktree. All four conditions, never fewer.
- **The in-distro WSL reap applies the tag and the directory only.** A WSL task's processes run
  inside the distro, out of the host scan's sight, so `wsl-reap.ts` scans there itself and cannot
  see the shared-subtree, connection, visible-app or tmux signals. It runs in the configured
  shell's distro and in each distro a task's CLI ran in (`wslDistros`, from `sessions.cli_target`,
  or a Command Terminal's own shell), only while the distro is running,
  leaves out a task with a live or starting session (asked again just before the script runs),
  validates task ids before they enter the script text, and takes directories only as positional
  arguments. Do not interpolate a directory or any other caller value into the script. Its
  `wsl.exe` runs without the tag main holds when Kangentic itself runs from a task's terminal, so
  the script's own subshells never read as a task's.
- **A mid-board suspend never reaps.** Pause, Stop, an `auto_spawn=false` column (Code Review
  entry), a handoff or settings respawn, an idle-timeout suspend, and quit leave the processes
  running, by decision: the task is parked, and its dev server stays up for testing.
- **The setting gates the kill, never the report.** `reapTaskLeftovers` and the startup sweep
  read `stopLeftoverProcesses` and pass it as `stop`; with it off the host plans and reports and
  kills nothing. Every reap's result goes to `publishLeftoverProcesses`, so the user is told what
  was stopped, not stopped, and left running. A new reap path reports the same way. The startup
  sweep is the one exception: it reports only what it stopped or failed to stop, and with stopping
  off it does not scan at all, because what it leaves running was reported when its task ended
  and is still there at every launch.
- **A stop the user asks for names a reported process, never a pid.** The Stop button sends the
  id `leftover-process-reports.ts` minted; main resolves it to the pid and start key the scan saw,
  and `stopProcessTree` re-checks that identity and keeps Kangentic's tree and every held PTY out
  of reach. Do not add a path that stops a pid the renderer supplies.
- **A row that claims a live process is rechecked by identity, never by a scan.** While a kept or
  not-stopped row is on screen (its toast, or its open list), the renderer asks
  `leftoverProcesses:check` by report id; main resolves the pid and start key, and the host answers
  through the reader's `isRunning`, which reads that one process and no environment. It answers
  ended only on evidence (a changed start key, an exit code, a zombie, a pid the listing no longer
  has) and unknown when a read fails, which changes no row. A reader without `isRunning` answers
  unknown for every one: do not fall back to a scan on a timer. An ended process retries its Done
  task's worktree removal, as a Stop does.
- **The reap logs what it left running, by what the report already carries.** One
  `[TASK-REAP] kept` (or `could not stop`) line per entry (`leftoverLogLine`): the label, pid,
  short task id, place, reason, and the plan's basis for it (`KeptExplanation`: the role, or the
  pid and label of the descendant or client that made it shared, or children all kept). Nothing
  more of a command line, and `because` never reaches the renderer.
- **A Windows process still listed while it terminates is `exited`, not running.** Its exit code
  is set before it leaves the Toolhelp listing (a `/preview`'s `dev.js` was still listed at least
  75 ms after). The scan reads the exit code on the limited handle it already opens and reads nothing
  more; the process stays in the scan for the protection walks, but every survivor and identity
  check (`runningIdentitiesOf`, a Stop's target) counts it as gone. Do not drop it from the scan:
  a held PTY root that is terminating would then stop protecting what runs under it.
- **Environment contents never leave a reader.** A reader sees every same-user process's
  environment, which holds other applications' secrets. It matches the tag inside the raw buffer
  and returns only the tag's value. Never return, log, or retain environment text, including a
  record or line that fails to parse.
- **A command line never leaves a reader either.** It can carry a token. `describe` reads it only
  for the processes a report names, and for the one process behind each `shared` verdict, whose
  label goes to the local log line alone. It parses it in place, and returns only `labelProcess`'s result:
  the program's name and at most one more short name (an existing script's file or package name,
  the module after `-m`, or the first word of a title the process set). Do not widen the label to
  any other argument.
- **A connection read returns pids only.** `connections` pairs listeners and clients inside the
  reader (`local-connections.ts`) and returns `LocalConnectionRead`: the pairs and the listening
  pids. No address or port leaves a reader or reaches a log. It never spawns a tool
  (`GetExtendedTcpTable` on Windows, `/proc/net/tcp` and fd links on Linux, libproc on macOS).
- **A failed reap reports a fixed code, never its text.** A reap or Stop that fails in the host
  kills nothing after the failure: one that fails after its graceful pass skips the force pass and
  reports what it signalled as not stopped (an empty later scan is a failure too, never "all
  gone"). The exception is `host_timeout`: main stopped waiting, but the host did not stop running
  (see the late-answer bullet below). Main
  reports it once per stage and code per launch through `reportTaskReapFailure`
  (`task-reap-failure-report.ts`) with `ReapFailureCode`, a host code or `wsl_error`. `failureReason` stays in
  local logs: it can come from a scan. The one text that leaves is a `reader_load` error, path
  stripped, since it is about this install and not about a process.
- **A host request that got no result is named by the transport's error type, never its text.**
  `UtilityPtyHostTransport` rejects with `PtyHostTimeoutError` when a running host let the budget
  run out, and with `PtyHostExitedError` when the host exited first or was still down
  (`host/pty-host-request-errors.ts`). `hostFailureCodeOf` maps them to `host_timeout` and
  `host_exited`, and anything else to `host_error`. The budget (`TASK_REAP_TIMEOUT_MS`) is one
  batch's, counted from when that batch starts: the host runs reaps and Stops one at a time, posts
  `batch-started` as each starts, and the transport gives every waiting request of that method its
  full budget back. Do not time a reap or a Stop from its send: a reap queued behind a batch
  measured 7.4 to 8.2 s of waiting on one contended core.
- **A timed-out reap is still reported when it finishes.** A timeout cancels nothing in the host,
  so the reap may still kill. The transport hands its late answer to the caller
  (`onLateResult`, then `reapTaskProcesses`' `onLateEntries`), which logs and reports it as an
  answer in time would be and puts what it did in the toast. For a task it stopped something of,
  `reapTaskLeftovers` retries the Done worktree removal (`retryDoneWorktreeRemoval`), which the
  process may have failed while the reap ran. A Stop from the list is the same: it answers
  `failed` at the budget, and when the host finishes it the real outcome is pushed to its row
  (`leftoverProcesses:stopSettled`, taken only while the row still reads failed) and the removal is
  retried once the process is gone. Neither adds a notice. A late answer never comes from a host
  that exited.
- **A reader names the scan step that failed by type, never by message.** It throws
  `ScanStepError` (`process-scan.ts`) with a fixed code (`process_list`, `window_list`,
  `connection_list`), and the
  reap maps the type to that code. The pass a reap failed in (`failurePass`: `first`, `second`,
  `last`) is sent as its own `pass` tag, outside the message and the once-per-launch key. A Stop
  the user asks for from the list returns the same code and pass (`StopProcessResult`), and main
  reports it as stage `stop`. A refusal or a survivor is an answer, and main never reports it. The
  removal-failure reap's holder Stop (`SessionManager.stopProcessByCreationTime`) only logs its
  failure.
- **The dead-shell orphan cleanup is a second kill path with its own identity, not a reap.** When a
  session's shell exits on its own on Windows, `host/dead-root-orphans.ts` finds the shell's
  children created between the shell's own creation and exit, read off the handle the pty host
  holds on every Windows PTY root from its pid to its exit (`pinRoot`; without both times the
  cleanup does not run), and their descendants created after their own
  parent, through `loadWin32OrphanApi` (`win32-reader.ts`): own session and user only, never a
  protected pid (the host, main, a live PTY root), and no environment, command line or working
  directory read. It asks the agent to exit first (see [[pty-teardown-grace]]) and terminates
  only what is still alive after the grace, re-checking the creation time on the terminating
  handle. Parentage plus creation time is what names the shell's own processes, so it needs no
  tag. Whatever of that tree outlives the
  grace, a dev server the agent started included, is terminated whatever `stopLeftoverProcesses`
  says, as `stopLostPtyTree` does for a crashed host: the session is over, not parked. Do not add
  tag or directory matching to it, and do not use it as a reap: what an agent detached from its
  tree is still the reap's to find.
- **An agent CLI's own background session is stopped by the CLI, before the reap.** Claude Code's
  `/bg` moves a task's conversation into a background session its supervisor runs outside the
  task's PTY, tagged and in the task's folder, so the reap would kill it with no exit of its own.
  `reapTaskLeftovers` first calls `AgentAdapter.stopBackgroundSession` (Claude: `claude stop <id>`,
  measured to run its SessionEnd hook) for the task's newest records, naming the session by its
  exact `sessionId` and `kind: background` in the CLI's own listing, never by cwd or name. It runs
  only when the record's own events file shows the conversation in one
  (`backgroundSessionHoldingConversation`), and it is not gated on `stopLeftoverProcesses`: it ends the
  task's own agent, which every terminal transition ends. A Command Terminal has no record, so
  `CommandTerminalLeftoverReaper` starts the same stop at the removal on the agent's own files
  (`isInBackgroundSession`, no CLI), and its reap waits for it. Do not route it through the reap or
  widen its match.
- **The Windows reader opens `PROCESS_VM_READ` only on a process in the caller's Windows session
  owned by the caller's user,** and a kill re-checks the creation time on the handle it
  terminates through. A scan that cannot read the caller's own session or user fails, so the reap
  reports `reap_error`, rather than returning a table in which nothing reads as tagged.
- **No kill follows a parent pid Windows may have reused.** A Windows process keeps its dead
  parent's pid, and Windows hands that pid on. A walk that kills (a reap's targets, a Stop's
  `subtreeOf`) links a child only when it was created after its parent, and never enters a process
  with no identity, whose link cannot be checked. Every Windows tree kill is `taskkill /T /F`
  (measured: it skips a process older than its parent pid's current owner), through
  `child-tree-stop.ts` except the quit failsafe's and the E2E janitor's (`killProcess` in
  `zombie-reaper.ts`), of a pid something still pins: Node's handle on a child that has not
  exited, the pty host's `pinRoot`, or this process's own. The by-pid stops that hold no pin are
  the listed residuals (`killChildTreeByPid` after a host loss or at quit, `killProcess` for the
  janitor and where no identity Stop is registered). The removal-failure reap kills through the host's
  identity-checked Stop (`setIdentityTreeStop`). What still names a bare pid, and why, is in
  `docs/architecture/worktrees/process-reaping.md`, "Parent pids Windows reuses". Do not add a terminate primitive
  outside `process-kill-sites.test.ts`'s classified files, or a tree-kill package.

## Enforcement (self-maintaining)

- **Test (plan):** `tests/unit/task-reap-plan.test.ts` pins every condition of a kill and every
  protection, with fixtures shaped like the processes measured on GitHub's Linux, macOS and
  Windows runners (tmux, pm2, console hosts, visible apps, daemons that move away), and the
  connection evidence and kept launchers measured on a developer's Windows machine (the adb
  server, qemu, netsimd and the emulator launcher; which clients count; propagation; a listener
  that is never kept for its children). `tests/unit/local-connections.test.ts` pins the pairing.
  `tests/unit/task-directories.test.ts` pins the roots that are never accepted.
- **Test (background session):** `tests/unit/session-leftover-reap-wiring.test.ts` pins that
  `reapTaskLeftovers` stops a background session holding the conversation before the reap, with
  "Stop leftover processes" off too, and runs no CLI without the record's hook evidence;
  `tests/unit/claude-background-sessions.test.ts` pins Claude's exact match (full `sessionId`,
  `kind: background`, a live `pid`, a plain short id) and its failures reading as nothing stopped,
  and that `isInBackgroundSession` runs no CLI. `tests/unit/command-terminal-leftovers.test.ts` pins
  that a Command Terminal's reap waits for the stop, and
  `tests/unit/command-terminal-background-session.test.ts` that an ordinary end runs no CLI, not
  even `detect`.
- **Test (wiring):** `tests/unit/session-leftover-reap-wiring.test.ts` pins the Done and
  `cleanupTaskSession` orderings (exit, then reap, then worktree removal), a Done move whose
  session ended earlier, the `auto_spawn=false` and Pause/Stop negatives, and `PROJECT_DELETE`'s
  order; `tests/unit/mcp-project-context.test.ts` pins the MCP delete, including a task with no
  worktree; `tests/unit/terminal-task-leftover-sweep.test.ts` pins the startup sweep, and
  `tests/unit/session-wsl-reap-live-task.test.ts` that the in-distro WSL reap leaves out a task
  with a live or starting session (the sweep takes no task lock) and that its `wsl.exe` carries no
  task tag. Runs in CI.
- **Test (tag):** `tests/unit/session-spawn-flow.test.ts` pins the tag on a task session, a
  Command Terminal's own tag, and `WSLENV`. `transition-engine.test.ts` and
  `prepare-agent-spawn.test.ts` pin `taskProcessTag` on both task spawn chokepoints,
  `transient-session-spawn-shim-launch.test.ts` pins it on a Command Terminal (its spawn's task
  id), and `codex-adapter.test.ts` pins the Codex override.
  `tests/unit/command-terminal-leftovers.test.ts` pins that the reap's agent-exit request outlives
  the orphan grace and that the delay outlives Claude's longest measured exit, the terminal's
  folder and tag, its report name, and that a task's removal or a quit reaps nothing.
- **Test (report and stop):** `tests/unit/task-tagged-reap.test.ts` pins the report (stopped
  roots only, survivors as not stopped, kept windows, stopping off kills nothing, each request
  gets its own tasks, a report-only request never joins a killing batch) and `stopProcessTree`
  (identity, subtree, never Kangentic's tree or a held PTY). `tests/unit/process-label.test.ts`
  pins that no argument but the script, module or title word reaches a label.
  `tests/unit/leftover-process-reports.test.ts` pins one report per burst and that a Stop
  resolves only a minted id. `tests/unit/leftover-processes-copy.test.ts` and
  `tests/ui/leftover-processes.spec.ts` pin the toast and the list. The same reap test pins that
  each pass reads connections after its scan, and that the second pass keeps what the first kept
  after the client's connection is gone.
- **Test (Windows reader gates):** `tests/unit/win32-reader-gates.test.ts` runs the Windows
  reader on a fake API on every OS: no handle for another session's process, no
  `PROCESS_VM_READ` for another user's or an untagged one, a failed scan when the caller's own
  session or user cannot be read, a kill only through a handle whose creation time matches, and
  every handle closed, and the same gates for the orphan stop's `loadWin32OrphanApi`. It also walks a 32-bit (WOW64) PEB laid out
  from Windows' own offsets, caps an environment read at 1 MiB whatever size the PEB claims, and
  expands an 8.3 working directory. It reads a fake TCP table laid out from iphlpapi's headers,
  opening no process, and fails as `connection_list` when the call fails. A window makes a visible
  app only of a tagged process or one below it, never an ancestor, and only with area: the fixture
  is a measured Windows Terminal tab (Terminal's real window above the tab's shell, whose 0 by 0
  pseudo console window Terminal shows), beside a classic console window and a minimized one that
  still count, and it feeds that scan through the real plan, which must reap the tab's processes.
  Kangentic's own node-pty shells never show their pseudo console window, so only a real Windows
  Terminal reproduces the tab; the behavior test below drives one.
- **Test (reused parent pids):** `tests/unit/process-kill-sites.test.ts` fails on a terminate
  primitive (taskkill, TerminateProcess, `process.kill`, Stop-Process, `.Kill(`, wmic) outside its
  classified files, a taskkill that is not `/T /F` of one pid, a tree-kill package, and a
  `child-tree-stop.ts` header that stops naming the probe. `task-reap-plan.test.ts` pins that a
  reap and a Stop never walk through a process with no identity or to an older one through a
  reused pid; `task-tagged-reap.test.ts` and `zombie-reaper.test.ts` the removal reap's Stop by
  creation time; `dead-root-orphans.test.ts`, `exited-root-wait.test.ts` and
  `win32-reader-gates.test.ts` the pin and the exact lifetime; `child-tree-stop.test.ts`,
  `spawn-with-abort.test.ts` and `project-entry-search-tree-kill.test.ts` that no taskkill names a
  child that has exited. `task-process-readers.test.ts` and `session-reap-real-processes.test.ts`
  run the pin and the Stop by creation time on real Windows processes, and
  `taskkill-stale-parent.test.ts` reruns the taskkill probe
  (`scripts/probe-taskkill-stale-parent.mjs`) on Windows in `task-reap-real-processes.yml`,
  skipping with the reason when no pid collision comes within its budget.
- **Test (preview stop):** `tests/unit/worktree-preview-stop.test.ts` runs the dev-build preview
  stop against a real child speaking `dev.js`'s side of the stop file, pins the file names and
  bounds against the scripts, and checks that `reapTaskLeftovers` calls it under
  `__KANGENTIC_DEV__` before the host reap, with the host's listing (a source check, since unit
  tests build with the flag off). It pins the `worktree-removal` reason against
  `scripts/preview-isolation.js` (whose `isWorktreeRemovalStop` `dev.js` reads it through, run on
  real stop-file payloads by `preview-isolation.test.ts`) and that `dev.js` skips its trash move
  on it, and drives the tree wait over a scripted listing: a
  launcher `cmd` that outlives `dev.js`, a child that appears during the quit, the bound, and a
  parent that is not the launcher. `tests/unit/task-reap-plan.test.ts` replays the captured
  stopping-preview shape (tab `cmd`, exited `dev.js`, deleter in the temp folder) and pins the `because` of every
  kept kind; `task-tagged-reap.test.ts` pins `leftoverLogLine`.
- **Test (recheck):** `tests/unit/win32-reader-gates.test.ts` pins `isRunning` on the fake API
  (running, exited but openable, a reused pid, another session, unlisted, listed but refused, an
  empty listing never read as ended, an unreadable exit code read as unknown there and as not
  exited by the scan, one listing reused across a recheck and never kept when empty);
  `task-process-readers.test.ts` pins the Linux `stat` read
  and runs `isRunning` on a real child on each OS; `task-tagged-reap.test.ts` pins the macOS
  read and that `checkRunning` never scans; `pty-host-core-tagged-reap.test.ts`,
  `leftover-process-stop-handler.test.ts`, `leftover-processes-store.test.ts`,
  `leftover-processes-copy.test.ts` and `tests/ui/leftover-processes.spec.ts` pin the request, the
  handler (unknown is not ended, an unminted id is never asked), the store, the pace, and a row
  turning Ended with its toast closing. `win32-reader-gates.test.ts` pins that an exited process
  is marked and read no further, and `task-tagged-reap.test.ts` that a killed root still listed
  exited is reported stopped and a Stop of an exited process answers ended.
  `leftover-worktree-retry.test.ts` pins the Done move's one delayed removal retry, and
  `session-leftover-reap-wiring.test.ts` that the Done move schedules it only when its removal failed.
- **Test (behavior):** `tests/unit/session-reap-real-processes.test.ts` reaps real fast-detached
  processes and spares what it must (a live child, another task, a cleared tag, a process outside
  the project, an opt-out child's parent, a tmux server, a server another task holds a TCP
  connection to, and under CI a visible app), and reaps a tagged `cmd /c ping` in a Windows
  Terminal tab when `KANGENTIC_WINDOWS_TERMINAL` names a portable Terminal, which the workflow
  below unpacks (pinned to 1.24.12741.0, the version measured). `task-process-readers.test.ts`
  reads real loopback connections, a dual-stack listener included, and checks them against `ss`,
  `lsof` and `netstat`. CI's unit
  tier runs it on Linux; `.github/workflows/task-reap-real-processes.yml` runs it on Linux with a
  display, macOS on Apple silicon and Intel, and Windows whenever `process-tag/` changes (not a
  required check). GitHub's macOS runners run with SIP off, so the redaction itself is never
  observed there: `env -i` stands in for it. On macOS, `task-process-readers.test.ts` also checks
  the libproc reads (parent, uid, start time, working directory, another user's process) against
  `ps` and `lsof` on the same processes, so a wrong struct offset fails there; on Windows it runs
  the real Toolhelp listing.
- **Test (failure report):** `tests/unit/task-tagged-reap.test.ts` pins `reader_load`,
  `empty_scan`, `connection_list` in either pass, the failing pass, and, over the macOS reader
  with a fake kernel, `window_list`, `process_list` and `connection_list`, and a Stop's code and
  pass (none for a refusal or a survivor);
  `tests/unit/task-reap-failure-report.test.ts` pins the once-per-launch latch, the
  fixed message, that no other failure's text reaches the event, and SessionManager's reports,
  the WSL one included and the three host codes by error type.
  `tests/unit/utility-pty-host-transport.test.ts` pins the rejection types, that a request
  queued behind a batch inside its budget does not time out, and that a late answer reaches its
  caller once and never from a host that exited; `task-reap-failure-report.test.ts`,
  `leftover-worktree-retry.test.ts` and `terminal-task-leftover-sweep.test.ts` pin that a late
  answer is reported, reaches the toast and retries the Done worktree;
  `leftover-process-stop-handler.test.ts`, `leftover-processes-store.test.ts` and
  `tests/ui/leftover-processes.spec.ts` pin that a late Stop corrects its row and retries the
  removal; `task-tagged-reap.test.ts` and
  `pty-host-core-tagged-reap.test.ts` pin that each batch and Stop says when it starts, once,
  and that a throw there strands no request. `tests/unit/wsl-reap-script-budget.test.ts` pins that a WSL reap whose
  shared script budget runs out reports it once and still returns what earlier batches killed.
- **Packaged smoke:** `scripts/package-smoke.mjs` (`package-smoke.yml`, on Windows, macOS and
  Linux whenever `process-tag/` changes) deletes a task whose terminal left a detached process in
  the project and fails unless the packaged app stopped it, and fails on a `[TASK-REAP] reap
  failed` line. At build time, the afterPack probe (`buildPtyHostLoadScript`) loads koffi from
  where the host does, through the asar on macOS, and fails the build unless one native call
  returns its own pid.
- **Review:** the privacy bullets are judgment beyond the readers' return shape; `/code-review`
  flags any reader, log line, or error path that carries environment or command-line text.
- A new terminal transition is not caught mechanically until a wiring test names it; review is the
  backstop for that.

## Scope

The task-tag spawn, the readers and reap in `src/main/pty/process-tag/`, and the terminal
transitions that call the reap. The removal-failure backstop (`zombie-reaper.reapProcessesForWorktree`)
is a separate mechanism for holders the tag cannot see.
