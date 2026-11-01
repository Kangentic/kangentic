---
type: Reference
title: Crash recovery and PTY host
description: "The project-open recovery pipeline: orphan marking, getInterruptedExited records, per (task, isolated_swimlane_id) dedup, registerSuspendedPlaceholder, restoredGrid, task-locked resumes, the reconcile that leaves a task to an in-flight move and hands a never-spawned one to the board path, the pass scoped to lost sessions after a pty host crash, and what the pty host owns (renderer ports, its spawn worker)."
tags: [sessions, crash-recovery, pty-host, startup]
sources:
  - resource: src/main/transition-engine/session-startup/index.ts
  - resource: src/main/transition-engine/session-startup/resume-suspended.ts
  - resource: src/main/transition-engine/session-startup/prepare-spawn.ts
  - resource: src/main/transition-engine/session-startup/auto-spawn.ts
  - resource: src/main/transition-engine/session-startup/missing-worktree.ts
  - resource: src/main/ipc/handlers/task-move-controllers.ts
  - resource: src/main/db/repositories/session-repository.ts
    title: getInterruptedExited
  - resource: src/main/ipc/handlers/projects.ts
    title: recoverSessionsAfterPtyHostLoss
  - resource: src/main/pty/host/pty-host-client.ts
  - resource: src/main/pty/host/pty-host-core.ts
  - resource: src/main/pty/host/protocol.ts
  - resource: src/main/pty/host/pty-host-entry.ts
  - resource: src/main/pty/host/host-spawn-service.ts
  - resource: src/main/pty/host/worker-spawn-service.ts
  - resource: src/main/pty/host/spawn-worker/spawn-worker-handler.ts
  - resource: src/main/pty/host/spawn-worker/protocol.ts
  - resource: src/main/diagnostics/thread-cpu-profile.ts
---
# Crash recovery and PTY host

## Crash Recovery (Session Recovery)

On project open (`src/main/transition-engine/session-startup/`):

1. **Prune orphaned worktrees** -- delete tasks whose worktree directories were removed externally. A task in To Do is never deleted for it: a To Do move removes the directory before it clears `worktree_path`, so a quit between the two leaves that row, and the To Do sweep clears its stale fields instead. The prune also skips a workflow task and a task with a running or queued session.
2. **Mark crash recovery** -- leftover `running` DB records become `orphaned` (skip records with live PTYs to handle re-entrant calls). Before that, the first unscoped pass for a project in a launch closes the activity intervals the last quit or crash left open (`ActivityIntervalStore.closeIntervalsLeftOpen`, task #952). A session this launch already runs keeps its open row.
3. **Collect candidates** -- all `suspended` + `orphaned` agent records, plus OS-killed **interrupted-exited** records (any `session_type` except `run_script`). An interrupted-exited record is `status='exited'` with an *abnormal* code (`exit_code != 0`, cross-platform: Windows `1073807364`, Unix `137`/`143`/`130`), a captured `agent_session_id`, that is the latest record for its `(task, session_type, isolation)` group (`getInterruptedExited`). This catches a hard shutdown (OS restart, power loss, SIGKILL) where the PTY died and the onExit handler recorded `exited` before the clean-quit path could mark it `suspended`. Clean exit 0 is excluded so a deliberate `/exit` is never resurrected on startup.

   Exit code 0 no longer means only "the agent ended itself cleanly". The [agent-absence sweep](agent-absence-sweep.md) also writes 0 when it retires a session whose agent vanished under a live shell, and its trigger set is wider than `/exit`: a CLI crash and a failed launch land there too. So a retirement is never resurrected here, whatever ended the agent. That is deliberate (the alternative resurrects the conversation a user deliberately exited), but note the resulting asymmetry: a crash that KILLS the shell reports an abnormal code and IS recovered, while a crash that leaves the shell alive is reported as 0 and is not.
4. **Deduplicate per `(task_id, isolated_swimlane_id)`** -- keep only the latest record for each parallel session (see [Isolated Sessions](spawn-flow.md#isolated-sessions-per-column-session-model)), mark older same-session duplicates as `exited`. A task may hold multiple sessions; only same-session duplicates are retired.
5. **Select the current session** -- per task, recover ONLY the session matching the task's current column strategy (`resolveIsolatedSwimlaneId`). Non-target sessions are preserved (an orphaned or interrupted-exited one is CAS-upgraded to `suspended`) so re-entering their column later continues their own conversation.
6. **Filter** -- skip tasks in non-auto-spawn columns (an interrupted-exited record there is CAS-upgraded to `suspended` for future resume, mirroring move-to-Done), skip held pauses (`suspended_by` `user`, `auto` or `low_memory`, `isHeldPause`), skip missing CWD, skip deleted/archived tasks. Skipped does NOT mean invisible: a record that ends up `suspended` in a non-auto-spawn **custom** column gets a `registerSuspendedPlaceholder` entry, because the renderer derives the Resume control and the card's click target from its in-memory session list, not the DB. Without one the task presents exactly like a To Do card (click opens the edit form, no Resume anywhere) even though `SESSION_RESUME` would happily resume it. To Do and Done are excluded by ROLE, not by the `auto_spawn` flag: both deliberately hide Resume, and a To Do card relies on having no session so it opens straight into the edit form. The placeholder is idempotent per task: a live or suspended row already in the registry blocks it, and an exited row is replaced. Recovery can run twice for a project in one process (an explicit `PROJECT_OPEN` while startup activation is still working on that project), and a second placeholder used to survive the eventual spawn and sit ahead of the live PTY in the renderer's session list, which painted "Resume session" over a running agent. The in-memory registry holds ONE row per task (the task's current session; the DB keeps its other resumable records), and every spawn drains all of the task's registry rows, not the first match, to keep it that way.
7. **Resume or respawn** (isolation-scoped via `getLatestForTaskByTypeAndIsolation`):
   - Suspended/orphaned/interrupted-exited with `agent_session_id` -- use `--resume` (attempts to restore conversation; the id is first reconciled against the record's own `status.json`, see [Resume](resume.md#resume)). The spawn carries `resumedBy: 'recovery'`, which rides the `session-resumed` event, so workflow recovery knows the agent's background commands died with the old process and starts its recovery over at once (see [Workflow engine](../workflows/workflow-engine.md)). The new record keeps the replaced one's `start_head_sha`.
   - No session ID -- fresh `--session-id` with prompt from matching `spawn_agent` action
   - A resume that cannot be prepared (an unknown agent, a missing CLI, a detection or trust write that throws) keeps its conversation: the record is CAS-upgraded to `suspended` (system) and registered as a placeholder, so the card shows Resume, step 8 skips the task, and the next launch tries the resume again. Retiring it used to let step 8 start a fresh agent over it. A record with no conversation to resume (no agent session id yet) is still retired, so step 8 starts the task fresh, which is all a resume of it could have done.
   - The spawn starts at the grid recorded on the record it replaces (`last_pty_cols` / `last_pty_rows`, passed as `SpawnSessionInput.restoredGrid`). The registry is empty after a restart, so the in-memory respawn grid (see [Repaint-settled scrollback sampling](output-streaming.md#scrollback-replay)) cannot apply here, and every resume used to come up at 120x30, making a phone that opened the task pay a park mid-boot. A grid under 20 rows (the bottom panel's strip) is not restored. The same holds for a Resume or a move after a restart: `resolveSpawnIntent` carries the retired record's grid into `executeSpawnAgent`.
8. **Reconcile** -- spawn fresh agents for tasks in auto_spawn columns with no session in the registry (skips user-paused tasks); fresh rows are tagged with the column's `isolated_swimlane_id`. Three kinds of task are not started here:
   - **A task in a paused workflow** (`isTaskWorkflowPaused`). A paused workflow starts nothing by itself, and its Resume starts the agent. The pty-host-loss pass (`lostScope`) does not skip it: the agents it brings back were running, and in a paused workflow those were resumed by a person.
   - **A task a board path is working on.** A move, a resume or an `autoSpawnForTask` registers a controller for its whole run (`task-move-controllers.ts`, `session-resume-controllers.ts`). Each can sit in an unlocked gap where the row is already in its new column with no session and no worktree yet. The pass skips such a task at discovery, again under the task lock before it spawns, and again before a hand-off. On 2026-10-27 a pass ran while a workflow's moves were making their worktrees, and it started four agents with no prompt in the project root; each move then found the session and skipped its own spawn, which `task-move.ts` now logs as a warning.
   - **A task that never had an agent** (no session record: a new task, or one a move to To Do reset). A fresh spawn would start it in whatever directory the row names, with no prompt. It goes to the board path instead (`autoSpawnForTask`, wired by the three project-open callers in `handlers/projects.ts`): its worktree first, then the column's enter automations and the task prompt, as the move into the column would have done. That is what finishes a move a quit cut short after its column commit. A row whose `session_id` no record and no registry row backs has that pointer cleared under the task lock first: `spawnAgent` starts no agent for a row that names a session, yet still runs the enter automations. The hand-offs run one at a time after the pass's own spawns, and the pass awaits them, so what a caller chains after it waits too. A read that throws while the pass sorts a task skips that task, not the pass. One exception: when the column's enter automations already recorded a run on the task this visit (`AutomationRunRepository.hasEnterRunSince`, counted from `TaskMoveRepository.visitStartedAt`), the move reached its spawn and the agent failed to start, so the task is left alone rather than run those automations again at every launch. The run log is pruned to 200 rows per project on this same open, unawaited beside the pass, so `pruneTo` keeps the newest enter run of each such task in its current column; it goes once the task has a session record, moves on, or is archived. The prune also keeps every run of a task whose workflow is still going or has been done for less than a day (`workflowIdsKeepingRuns`, task #952), since the newest 200 rows were a few hours of one overnight workflow. The crash's scoped pass hands nothing off: every task it starts had a session.

The background activation of every other project (`activateAllProjects`) runs these passes once per process, 5 s after the first renderer load (`backgroundActivationScheduled` in `src/main/index.ts`). A reload or a rebuilt window does not re-run it: main's sessions and boards outlive the renderer, so a second pass would only replay startup recovery against live boards.

The same pipeline recovers what a [pty host](#pty-host) crash takes down, mid-run, scoped to
exactly those sessions: `recoverSessionsAfterPtyHostLoss` passes the lost session ids, so step 3's
gather is filtered to them and step 2 orphans nothing. Without the scope, an agent that exited
non-zero on its own earlier in the run, or one suspended this run, would be woken with them.
Step 8 runs scoped too, to the lost sessions' tasks. A lost session with no `agent_session_id` yet
has nothing to resume (the interrupted-exited gather requires one), so its task starts a fresh
agent there, as it would at startup. Its lost row is still in the registry, exited, so in this pass
every row but the lost ones counts as the task having a session: a resumed session, a paused
placeholder that keeps its Resume, and a resume whose spawn failed, whose exited row a fresh agent
must not replace.

Both passes spawn each task under its lifecycle lock (`withTaskLock`), after reading the task again,
because their preparation awaits the shell and every agent's detection. A task is skipped when its
column changed or its `session_id` changed (a Reset clears it). A resume is also skipped when the
task gained a live session, its record is gone, or its record's status moved (a user's Resume retires
it). A fresh agent is also skipped when the task gained any session row (in the crash path, any row
but the lost ones), or when its worktree is no longer the one it was prepared in (a move to To Do and
back removes it). A resume skipped because the task moved into a custom column that starts no agent
keeps its record resumable with a placeholder, as step 6 does for a record it finds there: that move
had no session to suspend, so the card would otherwise offer no Resume until the next launch. A resume
whose preparation failed is kept resumable (step 7) under the same lock and the same re-check, since
its preparation awaited too: a record a Resume retired meanwhile is exited, and an unlocked CAS would
have taken it back to suspended under the live agent and cleared that agent's `session_id`.

## PTY host

Every PTY runs in the `kangentic-pty-host` utility process (`src/main/pty/host/`), as VS Code runs
its terminals, so terminal output never crosses main's event loop. The host core
(`pty-host-core.ts`) owns node-pty, the headless buffer and scrollback ring, backpressure, the raw
transcript writer and the adapters' output detectors. `SessionManager` stays the facade and talks to
it through `PtyHostClient`: ordered commands, id-matched requests, ordered events (`protocol.ts`).

- **What main keeps.** The session registry, the activity engine and every push to the renderer.
  It mirrors the alt-screen state and buffer width from host events, and reads scrollback, the
  serialized frame, the phone's seed frame (`getSeedFrame`: that frame, the parser offset it
  covers, and the time its settle and serialize took), raw scrollback, the output peek and
  diagnostics by request.
- **Where output goes.** A renderer's output never reaches main: the host sends each flush on the
  port of every renderer that shows the session (`setRendererFocus`, kept per renderer), and that
  renderer's keystrokes come back on the same port (see
  [Input and echo path](output-streaming.md#input-and-echo-path)). Main gets `tap` for the
  sessions a phone streams (`subscribeDataTap`, reference counted, so a reader that needs raw output
  briefly subscribes for that long; each `tap` chunk carries its cumulative parser offset,
  `endOffset`, and `SessionManager` re-emits it with no focus gate as
  `data-tap(sessionId, data, endOffset)`), and otherwise only a coalesced `outputSeen` with no
  bytes.
- **A host crash.** Main first stops the process tree each PTY left behind, by pid
  (`stopLostPtyTree`): a closed pseudo console or a hangup usually ends the agent, but nothing
  guarantees it, and one still running would edit its worktree beside the session that resumes. Each
  PTY is then reported through its own exit listener with
  `PTY_HOST_LOST_EXIT_CODE` (-2), so the session ends exactly as a PTY exit ends it. The renderer and
  the desktop notifier fold those exits into one "Terminals restarted" notice. The host restarts at
  once (then after 1, 5 and 15 s). Every renderer's port died with the old host, so main issues each
  a new one (`renderer-ports-lost`), then replays each renderer's focus set and the tap set, and the
  lost agent sessions resume (see Crash Recovery above). A preload whose port is replaced fails the
  scrollback requests the old host never answered, which the renderer's existing rejection paths
  handle. After five crashes the same core runs in main for the rest of the run, which is how
  terminals ran before the host existed; each renderer's port then ends in main, so only there does
  typing cross main's loop.
- **Off-main spawns.** One-shot child processes (`off-main-exec.ts`), the probes' raw PTYs
  (`off-main-pty.ts`), the agent CLIs' headless runs (`off-main-cli.ts`) and the background-shell
  watcher's process table run in the host too, since a Windows spawn's CreateProcess is synchronous
  on the calling thread. A CLI run is a command, so `spawnCli` gets its handle at once; a host crash
  fails a running one (it is never rerun, which would be a second paid answer) and main stops the
  orphaned CLI's tree. At quit both sides stop every run still going: the host in its shutdown, and
  main by pid, since with no terminal open the quit does not wait for the host. A spawn used to
  hold the host's only thread, the one that flushes every terminal: on the dogfooding machine
  `cli:spawn` held it 105 times in 20 hours, for 16 to 291 ms each (2026-10-24), and under disk load
  one git start held it 454 ms. So every one of them now starts on the host's spawn worker
  (`spawn-worker/`), a `worker_threads` Worker that loads only `node:` built-ins and pure modules,
  reached through `HostSpawnService`. The worker reports its spans to the host, which relays them
  as `spawn-worker:<kind>:spawn:<program>:<caller>` (a dev build names the caller), so they still
  show in a stall report without counting as stalls of the I/O thread. The I/O thread keeps the
  pin a tree stop needs (`pinRun`). After three worker crashes, or a worker that fails to start,
  the host starts processes itself again. Only node-pty stays on the I/O thread, since a PTY's
  handle belongs to the thread that spawned it: `pty:spawn` and `pty:spawnRaw`, 5 to 38 ms under
  load.
- **Dev diagnostics.** A dev build's host runs its own event-loop monitor and answers four `dev*`
  requests, which a production host refuses: `devLagReport` (its stalls, delay windows, GC pauses
  and every span per label, which the inspection server's event-loop-lag route serves as
  `ptyHost`), `devArmRoundTripProbe` and `devReadRoundTripProbe` (the scroll-latency probe, see
  [Output streaming](output-streaming.md)), and `devCpuProfile` (a CPU profile of its thread).
- **Task leftover reap.** The host also scans for and stops what a task's agents left running
  (`reapTaggedProcesses`), stops one reported process when the user asks (`stopReportedProcess`), stops a worktree holder the removal-failure reap found by the pid and creation time its scan read (`SessionManager.stopProcessByCreationTime`, 5 s budget), and answers which reported processes have ended (`checkReportedProcesses`, by pid and start key, never a scan).
  It also answers `awaitAgentExit`, bounded, once the agent a task's killed or exited shell left running has exited (`src/main/pty/host/exited-root-wait.ts`); a task reap waits on it before it scans.
  It reads the `KANGENTIC_TASK_ID` tag through koffi on Windows and macOS and `/proc` on Linux. See
  [Process reaping](../worktrees/process-reaping.md).

See `.claude/rules/pty-host-out-of-process.md`.
