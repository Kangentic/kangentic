---
type: Reference
title: Suspend and cleanup
description: What each destination column does to a session (To Do cleanup, Done and auto_spawn=false suspend), the KANGENTIC_TASK_ID reap of leftover processes, kill() with its young-session grace, the suspend() steps and double session-changed emit, and the timing constants table.
tags: [sessions, suspend, cleanup, kill-grace, constants]
sources:
  - resource: src/main/pty/session-manager.ts
  - resource: src/main/pty/shutdown/session-suspend.ts
  - resource: src/main/pty/lifecycle/deferred-kill.ts
  - resource: src/main/pty/host/exited-root-wait.ts
  - resource: src/main/transition-engine/resource-cleanup.ts
  - resource: src/main/ipc/helpers/task-cleanup.ts
  - resource: src/main/ipc/handlers/own-call-turn-wait.ts
---
# Suspend and cleanup

Session teardown varies by target column:

- **To Do** (role=`todo`), via `TASK_MOVE` - full cleanup via `cleanupTaskResources()`: kills the PTY (via `SessionManager.remove()`), deletes session files from disk, deletes all session DB records for the task, and then removes the worktree and (when `git.autoCleanup` is on) force-deletes the branch. Its pop-out windows close and its offscreen browser lane is destroyed before the reap and the removal. The PR link goes first, in the same tick that commits the To Do lane, so a quit during the cleanup cannot leave it (`forgetPRLinkOnTodoReset`). For a task that did its own work that nulls `pr_url`, `pr_number`, `pr_state`, `pr_merge_readiness`, `pushed_branch` and `head_sha` and cancels its merge-verdict re-polls. A second pass after the cleanup clears the `head_sha` the cleanup captured. Destructive, which is why the drop is gated behind a pending-changes confirmation. Moving back to an active column spawns a fresh session.
- **To Do** (role=`todo`), via `TASK_UNARCHIVE` / `TASK_BULK_UNARCHIVE` (restore from Done) - the SESSION-only half, `cleanupTaskSession()`, which also reaps what the task's agents left running (`reapTaskLeftovers`). The worktree and branch are left alone. Without this the task keeps the session Done deliberately suspended, and since `listSessions()` has no status filter the restored card renders "Paused" for the rest of the app session. It is not the full `cleanupTaskResources()` on purpose: `deleteTaskWorktree` nulls `worktree_path` only when the Done-time removal SUCCEEDED, so a task whose worktree was pinned at Done time (routine on Windows) still carries both fields, and the full helper would re-attempt the removal and force-delete the branch holding its committed work with no confirmation on this route. It also closes the task's pop-out windows and destroys its offscreen browser lane (`closeTaskWindows`) after the sessions end and before the reap.
- **Done** (role=`done`) - suspends session (preserves for resume via `SessionManager.suspend()`), archives task, and deletes the worktree to reclaim disk while preserving `branch_name` and the session records. The worktree is renamed into `.kangentic/removed-worktrees/` at once and its files are deleted in the background, never while a Post-Worktree Script runs (see [Done removal](../worktrees/worktree-lifecycle.md#done-removal)). Only when that rename fails is it removed in place, and a removal that fails is retried once 10 s later (`scheduleDoneWorktreeRemovalRetry`), then left to the next project open. The task's pop-out windows close and its offscreen browser lane is destroyed after the session ends and before the worktree is removed. The DB record is marked `suspended` so the session can be resumed if the task is later unarchived into an auto-spawn column. That unarchive is the ONLY route back: resuming in place is refused for a Done or archived task (see [Where resume is refused](resume.md#where-resume-is-refused)), since it would recreate the worktree this move deleted.
- **Any column with `auto_spawn=false`** - suspends session (same as Done, but without archiving). A restore into such a column keeps the suspended session and its Resume affordance; only a `role=todo` target resets it. Its pop-out windows and offscreen lane stay open.

On a terminal transition the teardown runs in this order: the task's sessions are killed, awaited and removed; then the task's pop-out windows close and its offscreen browser lane is destroyed (`closeTaskWindows`, `src/main/ipc/helpers/task-windows.ts`); then `reapTaskLeftovers` kills what the agents left running; then the worktree is removed (a Done move sets it aside and deletes it in the background), and the branch too for a To Do move or a delete when `git.autoCleanup` is on. The windows close after the sessions end because a Browser pop-out closing destroys its guest, and the lane hand-off stands a lane up for a pane that unmounts while its task still has a live agent. A mid-board suspend (Pause, Stop, an `auto_spawn=false` column, an idle timeout, or quitting) closes no window.

## A call that ends the caller's own session

Two MCP calls can end the session that makes them: `kangentic_move_task` on the agent's own task, and `kangentic_pause_workflow` on its own workflow. Either way the session ends only after the turn that made the call, so the call and its reply stay in the agent's conversation.

For `kangentic_move_task`, the tool still replies at once and the move still commits at once. The wait sits in Phase 1, right before the suspend, on every branch that ends the session: Done, a column with `auto_spawn=false`, a switch into or out of an isolated or `always_spawn_new` column, an agent handoff, and a model or effort restart. It is `waitForOwnAgentTurn` (`src/main/ipc/handlers/own-call-turn-wait.ts`): idle plus 1.5 s of PTY quiet (`waitForTurnCompletion`), bounded by `OWN_CALL_TURN_WAIT_MS` (30 s). To Do does not wait, because its reset throws the conversation away.

Before this, the suspend landed 2 to 4 ms after the commit. Claude takes the console close as its graceful exit and left without writing the in-flight tool call or its result to its transcript. The next resume of that conversation had no record of the move, so the agent made it again, at the cost of a full Code Review pass each time in a Testing and Code Review loop. Measured on two Testing to Code Review moves (PostToolUse had even run) and a Merge to Done move (it had not). A move that keeps the session recorded its call normally. Waiting for the turn end is enough: the turn-end runner reads a turn's final reply from the transcript at the same point.

`kangentic_pause_workflow` used to suspend every member before it replied, the caller included, so after a Resume the agent paused its workflow again. Now `pauseWorkflow` pauses every other member at once and the caller's own member after its turn ends (`pauseOwnSessionAfterTurn`, in `src/main/workflows/workflow-service.ts`), outside the task lock, with nothing waiting on it. A Resume that lands before the turn ends leaves the agent working. The reply says "Your own session pauses when this turn ends."

More pieces make the wait safe:

- **The caller's turn end belongs to the column the task left, or to a paused workflow.** It lands while the task already sits in the new column (or its workflow is paused) and `session_id` still names the caller. The session is marked while the call takes effect (`markOwnCallSession`): for a move from the commit until Phase 1 settles, for a pause through the wait and the pause. While it is, the turn-end runner and the workflow recovery leave its turn end and idle alone, so no Move to column row sends on a card whose workflow was just paused. A move's mark starts at the commit, not at the wait, because the exit group runs between the two and a deferred exit message waits for that same turn.
- **That idle waits on nobody.** The desktop notifier raises no idle notice for it, and main flags it on the renderer's activity push (`inOwnCall`), so no "Agent finished" toast appears and the bottom panel does not move focus to it. A permission prompt in the same turn still notifies. The phone's idle push needs 45 s of idle (`IDLE_SETTLE_MS`) and is cleared when the session exits, so the suspend ends it first.
- **A move's wait holds the task lock.** Another move of the task aborts this one before it queues (`abortInFlightMove`), which ends the wait at once. A Pause or Resume queues for at most the bound. An MCP call from the caller that needs this task's lock before it can reply (`kangentic_resume_workflow` is one) cannot return until then, so its turn runs to the bound and the session ends mid-call. A pause waits outside the lock, so the caller's own `kangentic_pause_workflow` returns at once.

## Reaping what the session left running

On the TERMINAL transitions above (move to To Do or Backlog, move to Done, unarchive into To Do, task delete including the MCP delete and a move to another project, and project delete), the teardown also kills every process the task's agents left running. An agent that backgrounds a dev server leaves it running when the session ends; on Windows it then holds the worktree directory as its current directory and blocks the removal.

Every task session's PTY is spawned with `KANGENTIC_TASK_ID=<taskId>` (`src/main/pty/process-tag/`), and every process the agent starts inherits it however it detached. The teardown calls `reapTaskLeftovers()` (`src/main/ipc/helpers/task-cleanup.ts`) AFTER every session of the task has exited and before any worktree delete; the pty host then kills every process carrying the task's tag AND working inside the task's project or worktree, except what is shared (something under it is not the task's, or other Kangentic work holds a TCP connection to a port it listens on), a launcher whose every child is kept (unless it listens itself), a visible app (read only for the task's tagged processes and what runs under them, never an ancestor such as a terminal), a tmux server, Kangentic's own process tree, and any PTY it still holds. The order matters because the reap force-kills, and a young agent must get its exit grace (`.claude/rules/pty-teardown-grace.md`). A Command Terminal carries its own made-up tag and is reaped the same way 5 s after it ends (see [command-terminal.md](../renderer/command-terminal.md#leftover-processes)).

The tag is the same across every session the task ran, so a dev server started by an agent that a Code Review entry suspended long before is still reaped at Done, and it lives in the processes themselves, so a task parked across an app restart is reaped at its later terminal transition too. A startup sweep, once per project per launch, reaps archived and To Do tasks whose transition's reap was cut short by a crash. To keep one process past Done, start it with the tag cleared (`KANGENTIC_TASK_ID= npm run dev`). See [Process reaping](../worktrees/process-reaping.md#what-the-reap-kills) for what the reap kills and spares (measured on Linux, macOS and Windows), the per-platform readers, what the tag cannot see, and the removal-time backstop.

`auto_spawn=false` columns (including a Code Review entry), a user-pressed Pause or Stop, an idle-timeout suspend, and quitting the app are deliberately NOT terminal: the task is parked rather than finished, so its dev server stays up for manual testing until the task's own terminal transition. Its pop-out windows and offscreen lane stay open for the same reason.

## What is preserved on suspend (Done / auto_spawn=false)

- `agent_session_id` (for `--resume` on next spawn)
- Worktree directory and branch
- Session files on disk (`status.json`, `events.jsonl`, `settings.json`)
- Scrollback buffer in memory

## What is destroyed on To Do cleanup

- PTY process (closed or force-killed; a young session of an agent that is typed into first gets its exit sequence and the grace, see below)
- The task's pop-out windows (Browser, Changes, each file diff), closed through the normal close path, and its offscreen browser lane (`closeTaskWindows`)
- What the task's agents left running in its folders, once that PTY has exited (`reapTaskLeftovers`; see [Process reaping](../worktrees/process-reaping.md))
- Session files on disk (deleted)
- All session DB records for the task (deleted)
- The PR link (`pr_url`, `pr_number`, `pr_state`, `pr_merge_readiness`), `pushed_branch` and `head_sha`, for a task that did its own work. A link typed onto a task that never started stays. See "A To Do move forgets the PR" in [PR linking](../../integrations/pull-requests/pr-linking.md).
- In-memory caches (usage, activity, events) for the session

Before the registry row is deleted, `SessionManager.remove()` emits `session-removed` (broadcast
as `SESSION_REMOVED`) with the row's last snapshot. The renderer's `removeSession` drops the row,
the task index entry, and every per-session map entry keyed on the id (`withoutSessions` in
`session-index.ts`). Two failures shaped this:

- With no push at all, a status push landing mid-teardown (a `syncSessions()` call in the grace
  window, say) resurrected the row via `withSessionUpserted` after the renderer's SESSION_EXIT
  handler had already ignored the intentional exit, leaving a ghost `running` card and panel tab
  for an agent that no longer existed anywhere in main (#80).
- Announcing the removal as a forced-`exited` `session-changed` fixed that and caused #661: the
  status channel's only renderer handler is an upsert, so for a task moved to To Do (whose rows
  `moveTask` evicts optimistically the instant the move starts) the removal itself re-inserted an
  `exited` row for a PTY, worktree, and session directory that no longer existed, and its surviving
  `sessionUsage` entry filled a context bar under a black terminal. A removal and a status change
  cannot share one channel.

The renderer also refuses to paint anything session-shaped for a task in a `todo`-role lane, whatever
row the store holds (`laneHoldsSession` and the lane-aware `taskDetailSurfaceFor` in
`task-progress.ts`; `useTaskSessionState` resolves such a task's session to null), and both spawn
chokepoints refuse the To Do and Done roles regardless of `auto_spawn`, so that classification is
true rather than assumed.

The same contract covers a bare `kill()`: the renderer's `SESSION_EXIT` handler ignores an
intentional exit, so every kill site follows up with the push that says what happened. `remove()`
announces `session-removed`, `suspend()` announces `suspended`, and a caller that keeps the row after
`kill()` + `awaitExit()` (the `cleanup_worktree` transition action) calls
`SessionManager.announceSessionEnded()`, which re-emits the row on `session-changed` with its resolved
status. `tests/unit/session-kill-followup.test.ts` scans every kill site for one of those. The full
contract is `.claude/rules/session-replica-contract.md`; the property that ties it together is
`tests/unit/session-store-replica-convergence.test.ts`, which drives the real store over random
interleavings of pushes, optimistic evictions, and stale syncs and asserts it ends equal to main's
registry. Also pinned by `tests/unit/session-manager-remove-emit.test.ts`,
`tests/unit/session-store-remove-session.test.ts`, `tests/ui/todo-reset-no-ghost-session.spec.ts`,
and `tests/ui/todo-stale-exited-row-opens-edit.spec.ts`.

## SessionManager.kill() and the young-session grace

`kill()` is synchronous and never resumable. It marks the session `intentionalExit`, nulls
`session.pty` at once (so `write()` / `resize()` no-op and a respawn cannot find the old PTY), and
then either force-kills immediately or, for a YOUNG session of an agent that is typed into, writes
the adapter's exit sequence and parks the PTY on `DeferredKillRegistry`
(`src/main/pty/lifecycle/deferred-kill.ts`), whose timer force-kills it `KILL_GRACE_MS` (1500 ms)
later. A session whose console close is graceful is closed at once (see below).

Young means the agent may still be inside its own exit work. For Claude that is its SessionEnd hook
and its transcript write, which a cut-short exit would lose. Claude's fullscreen boot canary
(`fullscreenBootPending[pid]` in `~/.claude.json`, written at REPL mount and withdrawn 10 s after the
first frame or on a graceful exit; a dead pid found at the next launch is a strike: one is a classic
renderer for that launch, two are sticky until `/tui fullscreen`) no longer applies to a Kangentic
session: Kangentic turns fullscreen on with `CLAUDE_CODE_NO_FLICKER=1`, which writes no record.
Measured on Claude 2.1.268, before the graceful close existed, a bare `pty.kill()` gave Claude about
100 ms, and the locked withdrawal of its boot record needed 82 to 97 ms of that.
The predicate (`isYoungSession`): alt-screen entered under `YOUNG_AFTER_ALT_SCREEN_MS` (12 s) ago,
or no alt screen yet and spawned under `YOUNG_SINCE_SPAWN_MS` (60 s) ago. The first alt-screen entry
is stamped on the row as `altScreenEnteredAt` by the buffer manager's `onAltScreenEnter`.

An agent whose console close is its own graceful exit skips all of this. Its adapter says so per
platform (`consoleCloseIsGraceful`, read onto the row as `consoleCloseIsGraceful` at spawn), and
Claude does on Windows and Linux: measured on Claude Code 2.1.302 on Windows (task #854), closing
its console made it run its SessionEnd hook, withdraw its boot record within 170 ms, and exit by
itself in every state it can be in, while the typed `\x03` + `/exit\r` re-sent a thinking turn's
prompt as a second turn and approved an open permission prompt; on Linux node-pty's hangup did
the same on 2.1.304. Such a session is closed at once at any age, by `kill()`, `suspend()` and
`killAll()` alike, and nothing is typed into it. macOS is not measured and is still typed into,
and so is a WSL shell on Windows, whose close (ConPTY closing `wsl.exe`, then a hangup in the
distro) is not measured either: `performSpawn` reads the flag as false there.

The deferred PTY lives OUTSIDE the registry row on purpose: `remove()` may delete the row in the
same tick, and the respawn sibling drain hard-kills any row it finds for the task. The registry
attaches no PTY listener; the spawn flow's `onExit` stays attached (it still emits `'exit'` after
the row is gone) and the manager's own `'exit'` event cancels the timer on a natural exit.
`kill(id, { immediate: true })` skips the grace for the agent-absence sweep, whose agent is already
gone.

A caller that touches the cwd or process tree after a kill therefore waits for the PROCESS: `kill`,
capture `awaitExit` (the row must still exist), then `remove`, then await before any `rmSync`,
`removeWorktree`, or `reapTaskLeftovers`. `cleanupTaskSession`, `executeCleanupWorktree`, project
delete, project relocate, the MCP task delete, and `SESSION_KILL_TRANSIENT` all do. The rule and its
scan: `.claude/rules/pty-teardown-grace.md`.

The PTY's exit is the shell's, and the agent it started can outlive it while it runs its own exit:
0.3 to 0.9 s for Claude after a close, about 1.9 s with an answer streaming, and up to 4 s with a
real session's hooks and MCP server. The pty host keeps a ledger of task roots for that wait
(`src/main/pty/host/exited-root-wait.ts`). It records each root when its kill arrives, so a wait
posted right after the kill still finds it, or when its shell exits on its own. `awaitAgentExit`
then polls the agent that shell left running until it is gone or `AGENT_EXIT_WAIT_MS` (8 s) runs
out. The agent is the shell's children, looking through a shell or launcher among them (`cmd.exe`
under a `.cmd` shim, a Git Bash stub) to what it started, and never what the agent itself started:
a dev server it left running never exits by itself, so watching it would hold every wait to its
bound. Windows finds the agent by parentage and creation time. POSIX re-parents it when the shell
dies, so the host runs one `ps` just before it sends the hangup (shared by kills that arrive
together, the hangup held for it at most `KILL_SNAPSHOT_CAP_MS`, 250 ms) and polls those pids. For
a Windows shell that exited on its own the wait lasts until the orphan cleanup is done instead. A
quit's kills still take that listing, since they reach the host before its shutdown does: about
10 ms that no reap reads, accepted rather than a quit flag on every kill.

Three callers wait on it. `reapTaskProcesses` waits before it scans: before the wait, a reap killed
one process 1.6 to 3.2 s after each of two busy young Claudes moved back to To Do was force-killed,
and the next launch counted both boot records as failed starts. `suspend()` and `awaitExit()` wait
too for a session whose console close is graceful, since that close ends the shell at once: a
settings or model respawn would otherwise resume the agent while the old one still writes its
transcript, and a relocate would move the folder from under it.

## SessionManager.suspend() flow

1. Remove the adapter's hooks from the project settings file (idempotent with `onExit`)
2. Close file watchers and detach telemetry readers, preserving the files for resume
3. Flush the transcript to the DB
4. Emit a synthetic `session_end` event (the agent's own hook will not fire on a kill)
5. Clear subagent depth tracking
6. Mark status as `suspended`
7. **Emit `session-changed`** - before the shutdown below, not after
8. Release backpressure so the agent's exit-sequence output is not held back
9. `gracefulPtyShutdown`: send the exit sequence, wait up to 1500ms for a natural exit, then
   force-kill and wait up to 1500ms more for kill propagation. A session whose console close is
   its graceful exit (Claude on Windows and Linux) skips the keys and the first wait: the close is
   the ask, and the suspend then waits for the agent itself (`awaitAgentExit`, bounded)
10. Last-resort scrollback scan for an agent session id not yet captured
11. **Emit `session-changed` again** - now carrying the post-shutdown session
12. Notify the queue (slot freed)

Steps 7 and 11 are a deliberate DOUBLE emit, and both are load-bearing:

- Step 7 exists because the bottom panel's tab set is `status === 'running'`
  (`derivePanelSessions`). Emitting only at the end left a tab for a session the user had already
  watched leave the board, for the whole of step 9. A user-initiated Pause never showed that,
  because the renderer store writes the suspended status optimistically; a main-driven suspend
  (move to Done, idle timeout, settings restart) had no such write and wore the full delay.
- Step 11 carries state that only exists after the shutdown, including an agent session id
  recovered by step 10.

The gap between them is what sets `FINALIZE_DEBOUNCE_MS` (3500) in
`src/main/retrieval/retrieval-service.ts`: finalize indexing is debounced per session, and the
two reports can be up to 3000ms apart on a force-kill, so a shorter window would fail to coalesce
them on exactly the slow path where the later read matters most.

## Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| MAX_SCROLLBACK | 512 KB | Terminal history per session |
| MAX_EVENTS | 500 | Activity log cap per session |
| Flush interval | 16 ms | Output batching (~60fps) |
| Repaint-settle max wait | 400 ms | Ceiling for the post-resize repaint wait before sampling scrollback |
| Status debounce | 100 ms | Usage file watch |
| Event debounce | 50 ms | Event log + activity state watch |
| Hard shutdown deadline | 6000 ms | Failsafe timer before force-killing process tree |
| PTY exit-callback drain | 25 ms poll, 100 ms settle (400 ms blind), 1500 ms deadline (+ 1500 ms with a deferred kill) | `before-quit` holds the quit until the killed PTY children and the pty host are gone, so node-pty's native exit callback lands while JS is still callable. A kill whose child pid was unreadable has no probe and is waited out on the blind budget (see [Shutdown](shutdown.md)) |
| Pty host exit wait | drain deadline less 200 ms | After `shutdown`, the host exits once every PTY's exit callback has run, or at this bound |
| Pty host restart | at once, then 1, 5, 15 s; 5 crashes per 5 min | Past the cap the host core runs in main for the rest of the run |
| KILL_GRACE_MS | 1500 ms | `kill()` on a young session of an agent that is typed into: exit sequence written, force-kill deferred this long (`src/main/pty/lifecycle/deferred-kill.ts`). An agent whose close is its graceful exit (Claude on Windows and Linux) is closed at once |
| YOUNG_AFTER_ALT_SCREEN_MS | 12000 ms | A session is young this long after its first alt-screen frame (Claude's 10 s canary window plus margin) |
| YOUNG_SINCE_SPAWN_MS | 60000 ms | A session with no alt-screen frame yet is young this long after spawn |
| AGENT_EXIT_WAIT_MS | 8000 ms | How long a task reap waits for what a killed shell left running to exit by itself before it scans (`src/main/pty/host/exited-root-wait.ts`); it answers as soon as that is gone |
| AGENT_EXIT_REQUEST_TIMEOUT_MS | 15000 ms | How long main waits for the host to answer that wait: the longer of the bound and the orphan cleanup's 10 s grace, plus 5 s |
| EXITED_ROOT_LEDGER_MS | 30000 ms | How long an exited task root stays in the pty host's ledger, longer than any `awaitAgentExit` wait on it |
| KILL_SNAPSHOT_CAP_MS | 250 ms | POSIX: the longest a kill waits for the host's `ps` listing of the shell's agent before the hangup lands |
| WORKTREE_HOLDER_STOP_TIMEOUT_MS | 5000 ms | How long a worktree removal's reap waits for the host to stop one holder by pid and creation time (`src/main/pty/session-manager.ts`). The removal waits inside its project's git queue, so a hung host holds that queue this long |
| COMMAND_TERMINAL_REAP_DELAY_MS | 5000 ms | A Command Terminal's leftover reap starts this long after it ends: the backstop for a WSL shell and the in-process core, which the agent-exit wait holds no ledger for |
| Command inject delay | 100 ms | Wait after PTY spawn before writing command |
| Idle timeout check | 60000 ms | Polling interval for `checkIdleTimeouts()` (every 60s) |
| Stale thinking threshold | 180000 ms | If no activity signal for 180s while in "thinking" state, emit synthetic idle event (v2 engine is event-driven, no polling timer) |
