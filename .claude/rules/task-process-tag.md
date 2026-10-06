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
`Start-Process`), and died with the app. Every task session's PTY now carries
`KANGENTIC_TASK_ID=<taskId>`, which every descendant inherits however it detached, and a terminal
transition kills what the task left running (`src/main/pty/process-tag/`). The tag alone
over-reaches: a tmux server, pm2's daemon, an editor or a browser the agent happened to start first
inherits it and goes on serving the user's other work. So a kill needs more than the tag, and this
rule keeps both halves true: every spawn tags, and every reap kills only what is the task's.

## The rule

- **Only a task session spawn sets the tag.** `performSpawn` (`session-spawn-flow.ts`) adds it
  through `addTaskProcessTag` for a non-transient session, with the task id, and lists it in
  `WSLENV` on a WSL shell. A Command Terminal is the user's own shell and gets no tag of its own;
  it inherits only what main's environment holds (a tag naming the outer task when Kangentic itself
  runs from a task's terminal). Do not set `KANGENTIC_TASK_ID` anywhere else, and do not let a
  spawn path that bypasses
  `performSpawn` start task work untagged.
- **An agent CLI that can strip inherited variables from its tool shells re-injects the tag.**
  The two task spawn chokepoints pass `taskProcessTag` (the task id) on `CommandOptions`; a
  Command Terminal never does. The adapter turns it into its CLI's own mechanism, inside
  `adapters/` (Codex: `-c shell_environment_policy.set.KANGENTIC_TASK_ID=<id>`).
- **Every terminal transition calls `reapTaskLeftovers(context, projectPath, tasks)` after the
  task's sessions have exited and before any worktree removal.** Today that is the Done branch of
  `handleTaskMove`, `cleanupTaskSession` (To Do, Backlog demote, task and bulk delete, unarchive
  into To Do), the MCP `onTaskDeleted` (any task, worktree or not), `PROJECT_DELETE` (archived
  tasks included), and the startup sweep for archived and To Do tasks. A new terminal transition
  calls it too, with the project path and each task's `worktree_path`.
- **A kill needs the tag AND the task's directory, and nothing in `reap-plan.ts` may relax that.**
  In the host reap, a process is killed only when it carries the task's tag, works inside the task's project or
  worktree, nothing under it shows it is shared (a readable descendant without this task's tag, or
  one working elsewhere), and it is not protected (Kangentic's tree, a held PTY, a visible app, a
  tmux server, each with everything under them). A process whose directory cannot be read is never
  killed. Do not add a kill path that skips any of these, and do not exempt processes by name: each
  protection rests on a measured mechanism (`docs/worktree-strategy.md`, "What the reap kills").
- **On macOS a withheld orphan in the worktree is the task's.** SIP hides the environment of
  Apple's `CS_RESTRICT` tools from the kernel record, so the reap also kills a process whose
  environment was withheld, whose parent is `launchd`, and whose working directory is inside a
  reaped task's worktree. All four conditions, never fewer.
- **The in-distro WSL reap applies the tag and the directory only.** A WSL task's processes run
  inside the distro, out of the host scan's sight, so `wsl-reap.ts` scans there itself and cannot
  see the shared-subtree, visible-app or tmux signals. It runs only while the distro is running,
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
- **Environment contents never leave a reader.** A reader sees every same-user process's
  environment, which holds other applications' secrets. It matches the tag inside the raw buffer
  and returns only the tag's value. Never return, log, or retain environment text, including a
  record or line that fails to parse.
- **A command line never leaves a reader either.** It can carry a token. `describe` reads it only
  for the processes a report names, parses it in place, and returns only `labelProcess`'s result:
  the program's name and at most one more short name (an existing script's file or package name,
  the module after `-m`, or the first word of a title the process set). Do not widen the label to
  any other argument.
- **A failed reap reports a fixed code, never its text.** A reap or Stop that fails kills nothing
  after the failure: one that fails after its graceful pass skips the force pass and reports what
  it signalled as not stopped (an empty later scan is a failure too, never "all gone"). Main
  reports it once per stage and code per launch through `reportTaskReapFailure`
  (`task-reap-failure-report.ts`) with `ReapFailureCode`, `host_error` or `wsl_error`. `failureReason` stays in
  local logs: it can come from a scan. The one text that leaves is a `reader_load` error, path
  stripped, since it is about this install and not about a process.
- **A reader names the scan step that failed by type, never by message.** It throws
  `ScanStepError` (`process-scan.ts`) with a fixed code (`process_list`, `window_list`), and the
  reap maps the type to that code. The pass a reap failed in (`failurePass`: `first`, `second`,
  `last`) is sent as its own `pass` tag, outside the message and the once-per-launch key. A Stop
  returns the same code and pass (`StopProcessResult`), and main reports it as stage `stop`. A
  refusal or a survivor is an answer, and main never reports it.
- **The Windows reader opens `PROCESS_VM_READ` only on a process in the caller's Windows session
  owned by the caller's user,** and a kill re-checks the creation time on the handle it
  terminates through. A scan that cannot read the caller's own session or user fails, so the reap
  reports `reap_error`, rather than returning a table in which nothing reads as tagged.

## Enforcement (self-maintaining)

- **Test (plan):** `tests/unit/task-reap-plan.test.ts` pins every condition of a kill and every
  protection, with fixtures shaped like the processes measured on GitHub's Linux, macOS and
  Windows runners (tmux, pm2, console hosts, visible apps, daemons that move away).
  `tests/unit/task-directories.test.ts` pins the roots that are never accepted.
- **Test (wiring):** `tests/unit/session-leftover-reap-wiring.test.ts` pins the Done and
  `cleanupTaskSession` orderings (exit, then reap, then worktree removal), a Done move whose
  session ended earlier, the `auto_spawn=false` and Pause/Stop negatives, and `PROJECT_DELETE`'s
  order; `tests/unit/mcp-project-context.test.ts` pins the MCP delete, including a task with no
  worktree; `tests/unit/terminal-task-leftover-sweep.test.ts` pins the startup sweep, and
  `tests/unit/session-wsl-reap-live-task.test.ts` that the in-distro WSL reap leaves out a task
  with a live or starting session (the sweep takes no task lock) and that its `wsl.exe` carries no
  task tag. Runs in CI.
- **Test (tag):** `tests/unit/session-spawn-flow.test.ts` pins the tag on a task session, its
  absence on a transient one, and `WSLENV`. `transition-engine.test.ts` and
  `prepare-agent-spawn.test.ts` pin `taskProcessTag` on both task spawn chokepoints,
  `transient-session-spawn-shim-launch.test.ts` pins its absence on a Command Terminal, and
  `codex-adapter.test.ts` pins the Codex override.
- **Test (report and stop):** `tests/unit/task-tagged-reap.test.ts` pins the report (stopped
  roots only, survivors as not stopped, kept windows, stopping off kills nothing, each request
  gets its own tasks, a report-only request never joins a killing batch) and `stopProcessTree`
  (identity, subtree, never Kangentic's tree or a held PTY). `tests/unit/process-label.test.ts`
  pins that no argument but the script, module or title word reaches a label.
  `tests/unit/leftover-process-reports.test.ts` pins one report per burst and that a Stop
  resolves only a minted id. `tests/unit/leftover-processes-copy.test.ts` and
  `tests/ui/leftover-processes.spec.ts` pin the toast and the list.
- **Test (Windows reader gates):** `tests/unit/win32-reader-gates.test.ts` runs the Windows
  reader on a fake API on every OS: no handle for another session's process, no
  `PROCESS_VM_READ` for another user's or an untagged one, a failed scan when the caller's own
  session or user cannot be read, a kill only through a handle whose creation time matches, and
  every handle closed. It also walks a 32-bit (WOW64) PEB laid out
  from Windows' own offsets, caps an environment read at 1 MiB whatever size the PEB claims, and
  expands an 8.3 working directory.
- **Test (behavior):** `tests/unit/session-reap-real-processes.test.ts` reaps real fast-detached
  processes and spares what it must (a live child, another task, a cleared tag, a process outside
  the project, an opt-out child's parent, a tmux server, and under CI a visible app). CI's unit
  tier runs it on Linux; `.github/workflows/task-reap-real-processes.yml` runs it on Linux with a
  display, macOS on Apple silicon and Intel, and Windows whenever `process-tag/` changes (not a
  required check). GitHub's macOS runners run with SIP off, so the redaction itself is never
  observed there: `env -i` stands in for it. On macOS, `task-process-readers.test.ts` also checks
  the libproc reads (parent, uid, start time, working directory, another user's process) against
  `ps` and `lsof` on the same processes, so a wrong struct offset fails there; on Windows it runs
  the real Toolhelp listing.
- **Test (failure report):** `tests/unit/task-tagged-reap.test.ts` pins `reader_load`,
  `empty_scan`, the failing pass, and, over the macOS reader with a fake kernel, `window_list`
  and `process_list`, and a Stop's code and pass (none for a refusal or a survivor);
  `tests/unit/task-reap-failure-report.test.ts` pins the once-per-launch latch, the
  fixed message, that no other failure's text reaches the event, and SessionManager's reports,
  the WSL one included. `tests/unit/wsl-reap-script-budget.test.ts` pins that a WSL reap whose
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
