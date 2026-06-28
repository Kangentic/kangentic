# Session Lifecycle

This document describes the full session state machine in Kangentic, covering how Claude Code CLI sessions are spawned, queued, suspended, resumed, and recovered.

## State Machine

There are two separate state representations:

- **`SessionStatus`** -- in-memory runtime state of a `ManagedSession` inside `SessionManager`. Values: `running`, `queued`, `exited`, `suspended`.
- **`SessionRecordStatus`** -- persisted in the SQLite database as a `SessionRecord`. Values: `running`, `queued`, `suspended`, `exited`, `orphaned`.

The in-memory `SessionStatus` does not include `orphaned` (that is a DB-only concept discovered on next launch). Both types include `queued` - the DB record is created with `status: 'queued'` at spawn time and promoted to `running` when a concurrency slot opens.

```
                  +----------+
                  |  queued  |
                  +----+-----+
                       |
              slot opens (SessionQueue promotes)
                       |
                       v
+------------+    +----------+    +-----------+
| suspended  |<---| running  |--->|  exited   |
+-----+------+    +----+-----+    +-----------+
      |                |                ^
      |                | app crashes    | killed while queued
      |                v                |
      |           +----------+    +-----+----+
      +---------->| orphaned |<---|  queued   |
   (recovery)    +----------+  (app crashes)
```

### States

| State | Scope | Description |
|-------|-------|-------------|
| `queued` | Both | Waiting for a concurrency slot to open |
| `running` | Both | PTY is live, Claude Code CLI process is active |
| `suspended` | Both | PTY killed, but session ID and files preserved for resume |
| `exited` | Both | Process exited naturally or was killed; terminal state |
| `orphaned` | DB only | App crashed while session was running; discovered on next launch |

### Transitions

| From | To | Trigger |
|------|----|---------|
| `queued` | `running` | Concurrency slot opens, `SessionQueue` promotes |
| `queued` | `exited` | Session killed while still queued |
| `running` | `suspended` | Task moved to Done or `auto_spawn=false` column |
| `running` | `exited` | Task moved to To Do (full cleanup via `cleanupTaskSession`) |
| `running` | `exited` | Process exits naturally or is killed |
| `running` | `orphaned` | App crashes, leftover `running` DB record found on next launch |
| `queued` | `orphaned` | App crashes, leftover `queued` DB record found on next launch |
| `suspended` | `running` | Task moved to active column, resumed via `--resume` |
| `suspended` | `exited` | Replaced by a new session on resume (`retireRecord`) |
| `orphaned` | `running` | Session recovery on project open |
| `orphaned` | `exited` | Recovery dedup, or failed recovery (`retireRecord`) |
| `orphaned` | `suspended` | Pause-on-restart setting upgrades a crashed session (`markRecordSuspended`) |
| `exited` | `running` | OS-killed (abnormal `exit_code`) session resumed by recovery on project open (`getInterruptedExited`) |
| `exited` | `suspended` | Interrupted-exited record CAS-upgraded by recovery (non-target / non-auto-spawn / auto-resume-off), or a PTY exit during app shutdown (onExit hardening) |
| `running` | `suspended` | App shutdown race: PTY exits while `isShuttingDown()` (onExit hardening keeps it resumable) |

## Spawn Flow

1. Transition engine triggers `spawn_agent` action.
2. `TransitionEngine.executeSpawnAgent()`:
   - Detect Claude CLI via `ClaudeDetector`
   - Resolve permission mode (swimlane override, then action config, then global)
   - Determine CWD (worktree path or project path)
   - Pre-populate `~/.claude.json` trust for worktree paths
   - Check for previous suspended session (can resume?)
   - If resuming: use existing `agent_session_id` with `--resume`, no prompt
   - If fresh: generate new UUID for `agent_session_id`, use `--session-id`, include prompt
   - Create session directory at `.kangentic/sessions/<agentSessionId>/`
   - Build agent CLI command via `CommandBuilder`
   - Call `SessionManager.spawn()`
3. `SessionManager.spawn()`:
   - Check concurrency limit; queue if full (returns `queued` placeholder)
   - If under limit, call `doSpawn()`:
     - Kill any existing PTY for the same task (orphan dedup)
     - Resolve shell and arguments (platform-specific)
     - Spawn PTY via `node-pty`
     - Start status file watcher (100ms debounce)
     - Start events file watcher (50ms debounce)
     - Set up output handler (16ms batched flush, 512KB scrollback)
     - After 100ms delay, write CLI command to PTY stdin

## Queue

- Configurable max concurrent sessions (`config.agent.maxConcurrentSessions`, config default: 8). The `SessionQueue` constructor initializes with a hardcoded limit of 5; the actual config value is applied via `setMaxConcurrent()` when config loads at startup.
- When the limit is reached, the session receives a `queued` status placeholder.
- When a running session exits or is suspended, `notifySlotFreed()` promotes the next queued entry.
- Reentrancy-safe: a `_processing` flag prevents concurrent promotion, and a `_dirty` flag ensures re-iteration if the queue changed during a spawn await.

## Suspend and Cleanup

Session teardown varies by target column:

- **To Do** (role=`todo`) -- full cleanup via `cleanupTaskSession()`: kills the PTY (via `SessionManager.remove()`), deletes session files from disk, deletes all session DB records for the task. The worktree and branch are preserved so code is not lost. Moving back to an active column spawns a fresh session.
- **Done** (role=`done`) -- suspends session (preserves for resume via `SessionManager.suspend()`), archives task. The DB record is marked `suspended` so the session can be resumed if the task is later unarchived.
- **Any column with `auto_spawn=false`** -- suspends session (same as Done, but without archiving).

### What is preserved on suspend (Done / auto_spawn=false)

- `agent_session_id` (for `--resume` on next spawn)
- Worktree directory and branch
- Session files on disk (`status.json`, `events.jsonl`, `settings.json`)
- Scrollback buffer in memory

### What is destroyed on To Do cleanup

- PTY process (force-killed)
- Session files on disk (deleted)
- All session DB records for the task (deleted)
- In-memory caches (usage, activity, events) for the session

### SessionManager.suspend() flow

1. Close file watchers
2. Null out file paths (prevents `onExit` cleanup from deleting files)
3. Emit synthetic `session_end` event
4. Clear subagent depth tracking
5. Mark status as `suspended`
6. Kill PTY
7. Emit status change
8. Notify queue (slot freed)

## Resume

When a suspended task moves to an active column:

- Command: `claude --settings <path> --resume <agentSessionId>` (no prompt)
- New PTY spawned with scrollback carried over from previous session
- New session DB record inserted, old record marked `exited`
- The destination column's settings are re-applied as CLI flags on the resume
  command: `--permission-mode` (lane override, else global default), `--model`,
  and `--effort`. A column move that changes the effective permission mode
  forces this suspend + respawn cycle, because no adapter can switch
  permission mode on a live session.
- A plan-exit auto-move (Planning -> Executing), triggered when the user
  approves the plan (the `ExitPlanMode` tool completes, not when the agent
  merely invokes it), passes a continuation prompt
  ("Proceed with implementing the approved plan.") delivered as the resumed
  session's first message when the destination column has no `auto_command`;
  the `auto_command` wins when present.
- The **first move OUT of Done** (the recovery / restore move, whatever the
  destination column) resumes the session WITHOUT injecting the destination
  column's `auto_command`. Restoring a Done task is usually to inspect the
  session or ask a question, so the column automation (e.g. `/merge-pull-request`)
  sits idle until the next move. This is unconditional and matches crash
  recovery, which also resumes command-free. The drag-out-of-Done path
  (`TASK_UNARCHIVE` / `TASK_BULK_UNARCHIVE`) suppresses it directly; a
  non-archived Done-out move (MCP `move_task`, legacy rows) suppresses it via
  `spawnAgent`'s `suppressAutoCommand`, set by `handleTaskMove` when
  `fromLane.role === 'done'`. Model / effort / permission-mode settings still
  apply on the recovery move. The next move injects per column config as usual.

## Crash Recovery (Session Recovery)

On project open (`src/main/transition-engine/session-startup/`):

1. **Prune orphaned worktrees** -- delete tasks whose worktree directories were removed externally
2. **Mark crash recovery** -- leftover `running` DB records become `orphaned` (skip records with live PTYs to handle re-entrant calls)
3. **Collect candidates** -- all `suspended` + `orphaned` agent records, plus OS-killed **interrupted-exited** records (any `session_type` except `run_script`). An interrupted-exited record is `status='exited'` with an *abnormal* code (`exit_code != 0`, cross-platform: Windows `1073807364`, Unix `137`/`143`/`130`), a captured `agent_session_id`, that is the latest record for its `(task, session_type, isolation)` group (`getInterruptedExited`). This catches a hard shutdown (OS restart, power loss, SIGKILL) where the PTY died and the onExit handler recorded `exited` before the clean-quit path could mark it `suspended`. Clean exit 0 is excluded so a deliberate `/exit` is never resurrected on startup.
4. **Deduplicate per `(task_id, isolated_swimlane_id)`** -- keep only the latest record for each parallel session (see [Isolated Sessions](#isolated-sessions-per-column-session-model)), mark older same-session duplicates as `exited`. A task may hold multiple sessions; only same-session duplicates are retired.
5. **Select the current session** -- per task, recover ONLY the session matching the task's current column strategy (`resolveIsolatedSwimlaneId`). Non-target sessions are preserved (an orphaned or interrupted-exited one is CAS-upgraded to `suspended`) so re-entering their column later continues their own conversation.
6. **Filter** -- skip tasks in non-auto-spawn columns (an interrupted-exited record there is CAS-upgraded to `suspended` for future resume, mirroring move-to-Done), skip user-paused sessions (`suspended_by = 'user'`), skip missing CWD, skip deleted/archived tasks
7. **Resume or respawn** (isolation-scoped via `getLatestForTaskByTypeAndIsolation`):
   - Suspended/orphaned/interrupted-exited with `agent_session_id` -- use `--resume` (attempts to restore conversation)
   - No session ID -- fresh `--session-id` with prompt from matching `spawn_agent` action
8. **Reconcile** -- spawn fresh agents for tasks in auto_spawn columns with no session at all (skips user-paused tasks); fresh rows are tagged with the column's `isolated_swimlane_id`

## Isolated Sessions (Per-Column Session Model)

A task can run on multiple parallel, independently-resumable sessions. Two orthogonal column fields (set on the Automation tab of the Board Manager) control the behavior; the pure rules live in `src/main/transition-engine/session-isolation.ts`:

- **`session_target`** (`main` | `isolated`, default `main`) - which session track a task runs on. `main` is the task's shared main conversation (resumed as the task moves between normal columns); `isolated` is this column's own separate, context-isolated session, keyed by the swimlane id. Resolved by `resolveSessionTarget` / `resolveIsolatedSwimlaneId`; the discriminator is `sessions.isolated_swimlane_id` (`NULL` = main, swimlane id = isolated).
- **`session_spawn_strategy`** (`create_or_resume` | `always_spawn_new`, default `create_or_resume`) - what to do with that track on entry. `create_or_resume` resumes the track's session if one exists, else spawns it; `always_spawn_new` always spawns fresh, retiring the prior session for that `(task, target)`. Resolved by `resolveForceFresh`, whose default is **context-aware**: an isolated column defaults to `always_spawn_new` (an independent pass each entry), a main column to `create_or_resume` (continuity), unless `session_spawn_strategy` is set explicitly.

The four combinations:

| `session_target` | `session_spawn_strategy` | Behavior |
|---|---|---|
| `main` | `create_or_resume` | Resume the task's main session, or start it (the default) |
| `main` | `always_spawn_new` | Restart the main session from scratch each entry (reset-main) |
| `isolated` | `create_or_resume` | Resume this column's isolated session, or start it (a persistent isolated track) |
| `isolated` | `always_spawn_new` | A fresh, independent pass every entry (the reviewer archetype) |

Both fields are enums so future tracks/strategies need no schema migration.

**An isolated session is context-isolated.** It does NOT inherit the main session's conversation. This is the point of the feature: pairing `session_target: isolated` (with the default `always_spawn_new`) and `auto_command: /code-review` yields an independent reviewer that judges the current diff without the generator's reasoning trail. (This is distinct from Claude Code's own `/fork` / `--fork-session`, which *inherit* the conversation; we deliberately do not.) "Restart the conversation" within a session is otherwise left to the agent's native `/clear` / `/compact`.

**One active PTY per task** is preserved. The worktree is shared across a task's sessions (same `task.worktree_path`), so an isolated session's edits are real and persist; the main session sees the changed tree but not the isolated conversation.

**`always_spawn_new` applies on column entry only.** An app restart / pause-resume of an in-progress session still resumes it (the recovery path is unaffected), so a crash never discards active work.

Lifecycle on task move (`task-move.ts`, the session switch branch inside Priority 3):

- **Enter an isolated column from a live main session**: suspend the main session (preserve `agent_session_id`), then Phase 3 spawns/resumes the isolated session and runs its `auto_command`. With `always_spawn_new` (the isolated default) it spawns fresh each entry, retiring the prior pass.
- **Leave an isolated column for a normal column**: suspend the isolated session (resumable), then Phase 3 resumes the **main** session.
- **Reset-main / recycle**: an `always_spawn_new` column forces a fresh spawn on its target track even when the live session is already on that track, so the switch fires on `resolveForceFresh(toLane)`, not only on a target change.
- The target + spawn policy are derived from the destination column in `resolveSpawnOverrides`, threaded through `SpawnOverrides.isolatedSwimlaneId` / `SpawnOverrides.forceFresh` into `resolveSpawnIntent` (which retires the prior record on a forced-fresh entry) and `sessionRepo.insert`. The terminal tab badges an isolated session as "Isolated" vs "Main".

## Shutdown

On app close, the `before-quit` handler calls `syncShutdownCleanup()`, which is fully synchronous. The `suspendAll()` method exists in `SessionManager` but is **never called during shutdown** -- it is async and would break the synchronous requirement.

The actual shutdown sequence (`syncShutdownCleanup()` in `src/main/index.ts`):

1. Cancel all pending command injections
2. List all in-memory sessions with `running` or `queued` status
3. For each running record, call `captureSessionMetrics()` (synchronous: in-memory cache read + better-sqlite3 writes) so cost / tokens / duration / `tool_breakdown` / `compaction_count` are flushed to the DB before the PTY is killed. The function writes to BOTH the `sessions` row (`SessionRepository.updateMetrics`) and, when `usage` is defined, to a `usage_history` row (`UsageHistoryRepository.recordSessionUsage`) so lifetime period totals survive any subsequent task deletion. Without this step every clean app close loses in-flight metrics for any session that had not yet checkpointed. (The shutdown path uses the synchronous snapshot only; the async transcript-token refinement, `refineTranscriptTokens`, runs only on the exit/suspend/move paths, never here.) A periodic snapshot timer (`startMetricsSnapshotTimer`, ~45s) also runs this same capture for live sessions during normal operation so an app/OS kill bounds the loss to one interval; it is stopped synchronously at the top of `syncShutdownCleanup`.
4. Mark each running record `suspended` (with `suspended_at` timestamp and `suspended_by = 'system'`) so sessions can resume on next launch. Queued records are marked `exited` since there is nothing to resume.
5. Call `SessionManager.killAll()` which force-kills all PTYs immediately (no graceful `/exit`, no waiting)
6. Clean up session files and clear in-memory session maps
7. Delete ephemeral project from index (if applicable)
8. Close all database connections via `closeAll()`
9. Let Electron's normal quit proceed (tears down Chromium child processes)

A hard failsafe timer (`taskkill /T /F` on Windows, 6 seconds) runs as a backstop in case Electron's shutdown hangs.

Sessions are resumable on next launch via `--resume <agent_session_id>` from the saved DB record. The 2-second graceful `/exit` window is intentionally sacrificed to keep shutdown synchronous and prevent zombie processes.

## Terminal Ownership Handoff

- Each PTY session spawns exactly one Claude Code CLI process.
- The bottom panel and the modeless task-detail windows share that process, one xterm per session at a time.
- `dialogSessionIds: string[]` in `SessionStore` lists every session owned by an open task-detail window. It replaced the scalar `dialogSessionId` once task detail became modeless and windows can stack.
- When a window claims a session: the panel unmounts that session's xterm instance.
- When the window releases it: the panel recreates xterm from the PTY scrollback buffer.
- This prevents duplicate xterm instances from sending conflicting resize calls.

## Project-Scoped Session State

Sessions from non-active projects must not interfere with the active project's terminal panel, activity icons, or store state. This is enforced at three levels:

1. **IPC event forwarding** -- All session events (`data`, `usage`, `activity`, `event`, `status`, `exit`) include the session's `projectId`. The renderer filters events by comparing against the current project.
2. **Cache getters** -- `getUsage`, `getActivity`, and `getEventsCache` accept an optional `projectId` parameter. When provided, `SessionManager` returns only data for sessions belonging to that project.
3. **Store scoping** -- `syncSessions()` fetches usage and events scoped to the current project, but activity unscoped (sidebar badges need cross-project data). On project switch, `activeSessionId`, `dialogSessionIds`, `openTaskId`, `sessionUsage`, and `sessionEvents` are cleared; `sessions` and `sessionActivity` are preserved for the sidebar. A generation counter invalidates any in-flight `syncSessions()` calls from the previous project, and a snapshot-based merge preserves IPC-delivered status updates that arrive during the async gap.

**Sidebar exception:** Activity state (`thinking`/`idle`) is always forwarded and stored regardless of project, so the sidebar can show badge counts for all projects. Auto-focus and sync triggers are gated to the current project only.

## Transcript Capture

PTY output is captured for two purposes: terminal display (via the scrollback buffer) and persistent transcript storage (via `TranscriptWriter`).

`TranscriptWriter` (`src/main/pty/transcript-writer.ts`) receives raw PTY data, strips ANSI escape sequences, and debounces writes to the `session_transcripts` table every 30 seconds. This provides a clean, searchable text transcript of the session without terminal formatting noise.

The transcript is used during cross-agent handoff: when a task moves to a column with a different agent, the `HandoffOrchestrator` reads the transcript from the database, combines it with git diff and session metrics, and packages it as handoff context for the new agent.

## Cross-Agent Handoff

When a task moves to a column where `resolveTargetAgent()` returns a different agent than the current session:

1. The current session is suspended (Priority 3a in the [Transition Engine](transition-engine.md))
2. The `HandoffOrchestrator` packages context: session transcript (from `session_transcripts`), git diff (changed files), and session metrics (tokens, cost, duration)
3. A new session is spawned with the target agent, receiving a `handoffPromptPrefix` summarizing the previous agent's work
4. A `handoff-context.md` file is written to the new session directory for reference
5. A `handoffs` record is inserted in the database tracking the from/to agents, sessions, and the full context packet

The handoff is transparent to the user - the task card shows spawn progress phases (`packaging-handoff`, `detecting-agent`, `starting-agent`) and the shimmer overlay lifts when the new agent's TUI is ready.

## Output Streaming

- PTY `onData` accumulates into a per-session buffer.
- A 16ms flush interval (~60fps) emits buffered data via IPC `session:data`.
- A 512KB scrollback ring buffer per session supports terminal restoration.

## Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| MAX_SCROLLBACK | 512 KB | Terminal history per session |
| MAX_EVENTS | 500 | Activity log cap per session |
| Flush interval | 16 ms | Output batching (~60fps) |
| Status debounce | 100 ms | Usage file watch |
| Event debounce | 50 ms | Event log + activity state watch |
| Hard shutdown deadline | 6000 ms | Failsafe timer before force-killing process tree |
| Command inject delay | 100 ms | Wait after PTY spawn before writing command |
| Idle timeout check | 60000 ms | Polling interval for `checkIdleTimeouts()` (every 60s) |
| Stale thinking threshold | 180000 ms | If no activity signal for 180s while in "thinking" state, emit synthetic idle event (v2 engine is event-driven, no polling timer) |

## Transient Sessions

Transient sessions are ephemeral Claude Code terminals spawned from the command bar (Ctrl+Shift+P). They differ from task-bound sessions in several ways:

- **No task association** - run at the project root with no Kanban task
- **No DB persistence** - no session record in the database
- **No resume capability** - killed on close, not suspendable
- **No queue** - spawned immediately regardless of concurrency limits

### Spawn Flow (`SESSION_SPAWN_TRANSIENT`)

1. Optionally checkout a target branch (falls back to current branch on failure)
2. Create a session directory at `.kangentic/sessions/<transientTaskId>/` for bridge files
3. Build Claude CLI command via `CommandBuilder` (with MCP server if enabled)
4. Call `SessionManager.spawn()` with `transient: true`

### Kill Flow (`SESSION_KILL_TRANSIENT`)

1. Remove the session from `SessionManager` (kills PTY)
2. Delete the session directory from disk (best-effort cleanup)

Transient sessions are tracked with a `transient_session_spawn` analytics event.

## AbortSignal Pattern

When a task moves rapidly between columns (e.g. drag-and-drop corrections), spawns from earlier transitions can become stale before they complete. The transition engine uses `AbortSignal` to cancel in-flight spawns:

1. Each task move creates an `AbortController` for the transition
2. If the same task moves again before the previous transition completes, the old controller is aborted
3. The `AbortSignal` is threaded through `executeTransition()`, `executeAction()`, and `executeSpawnAgent()`
4. At each async boundary (CLI detection, worktree creation, PTY spawn), the signal is checked via `signal?.throwIfAborted()`
5. If aborted, the spawn stops immediately - no PTY process is created

The `isAbortError()` utility in `src/shared/abort-utils.ts` provides a type guard for distinguishing abort errors from real errors in catch blocks.

## Terminal Paste Strategy

Terminal paste operations use xterm.js's built-in `terminal.paste()` method, which handles bracketed paste mode for the PTY. The paste path is unified:

- **Ctrl+V / Cmd+V** - intercepted by a custom key handler, reads clipboard, calls `terminal.paste()`
- **Context menu paste** - follows the same clipboard-read-then-paste path
- **Built-in xterm paste suppressed** - a `paste` event listener on the xterm helper textarea prevents the browser's native paste from double-sending text through xterm's `onData` handler

This ensures consistent behavior across keyboard shortcuts and context menu paste.

## See Also

- [Configuration](configuration.md) -- permission modes and session limits
- [Agent Integration](agent-integration.md) -- command building, hook injection, per-agent CLI details
- [Transition Engine](transition-engine.md) -- what triggers spawns and suspends
- [Activity Detection](activity-detection.md) -- thinking/idle state from hooks
