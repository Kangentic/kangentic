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
| `orphaned` | `running` | Session recovery on project open |

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

- Configurable max concurrent sessions (`config.claude.maxConcurrentSessions`, config default: 8). The `SessionQueue` constructor initializes with a hardcoded limit of 5; the actual config value is applied via `setMaxConcurrent()` when config loads at startup.
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

## Crash Recovery (Session Recovery)

On project open (`session-recovery.ts`):

1. **Prune orphaned worktrees** -- delete tasks whose worktree directories were removed externally
2. **Mark crash recovery** -- leftover `running` DB records become `orphaned` (skip records with live PTYs to handle re-entrant calls)
3. **Collect candidates** -- all `suspended` + `orphaned` agent records (any `session_type` except `run_script`)
4. **Deduplicate** -- keep only the latest record per `task_id`, mark older duplicates as `exited`
5. **Filter** -- skip tasks in non-auto-spawn columns, skip user-paused sessions (`suspended_by = 'user'`), skip missing CWD, skip deleted/archived tasks
6. **Resume or respawn**:
   - Suspended/orphaned with `agent_session_id` -- use `--resume` (attempts to restore conversation)
   - No session ID -- fresh `--session-id` with prompt from matching `spawn_agent` action
7. **Reconcile** -- spawn fresh agents for tasks in auto_spawn columns with no session at all (skips user-paused tasks)

## Shutdown

On app close, the `before-quit` handler calls `syncShutdownCleanup()`, which is fully synchronous. The `suspendAll()` method exists in `SessionManager` but is **never called during shutdown** -- it is async and would break the synchronous requirement.

The actual shutdown sequence (`syncShutdownCleanup()` in `src/main/index.ts`):

1. Cancel all pending command injections
2. List all in-memory sessions with `running` or `queued` status
3. For each, find the corresponding DB record and mark it `suspended` (with `suspended_at` timestamp and `suspended_by = 'system'`) so sessions can resume on next launch
4. Call `SessionManager.killAll()` which force-kills all PTYs immediately (no graceful `/exit`, no waiting)
5. Clean up session files and clear in-memory session maps
6. Delete ephemeral project from index (if applicable)
7. Close all database connections via `closeAll()`
8. Let Electron's normal quit proceed (tears down Chromium child processes)

A hard failsafe timer (`taskkill /T /F` on Windows, 6 seconds) runs as a backstop in case Electron's shutdown hangs.

Sessions are resumable on next launch via `--resume <agent_session_id>` from the saved DB record. The 2-second graceful `/exit` window is intentionally sacrificed to keep shutdown synchronous and prevent zombie processes.

## Terminal Ownership Handoff

- Each PTY session spawns exactly one Claude Code CLI process.
- The bottom panel and task detail dialog share that single process.
- `dialogSessionId` in `SessionStore` ensures mutual exclusion.
- When the dialog opens: the panel unmounts its xterm instance.
- When the dialog closes: the panel recreates xterm from PTY scrollback buffer.
- This prevents duplicate xterm instances from sending conflicting resize calls.

## Project-Scoped Session State

Sessions from non-active projects must not interfere with the active project's terminal panel, activity icons, or store state. This is enforced at three levels:

1. **IPC event forwarding** -- All session events (`data`, `usage`, `activity`, `event`, `status`, `exit`) include the session's `projectId`. The renderer filters events by comparing against the current project.
2. **Cache getters** -- `getUsage`, `getActivity`, and `getEventsCache` accept an optional `projectId` parameter. When provided, `SessionManager` returns only data for sessions belonging to that project.
3. **Store scoping** -- `syncSessions()` fetches usage and events scoped to the current project, but activity unscoped (sidebar badges need cross-project data). On project switch, `activeSessionId`, `dialogSessionId`, `openTaskId`, `sessionUsage`, and `sessionEvents` are cleared; `sessions` and `sessionActivity` are preserved for the sidebar. A generation counter invalidates any in-flight `syncSessions()` calls from the previous project, and a snapshot-based merge preserves IPC-delivered status updates that arrive during the async gap.

**Sidebar exception:** Activity state (`thinking`/`idle`) is always forwarded and stored regardless of project, so the sidebar can show badge counts for all projects. Auto-focus and sync triggers are gated to the current project only.

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
| Stale thinking threshold | 45000 ms | If no activity signal for 45s while in "thinking" state, emit synthetic idle event |
| Stale thinking check | 15000 ms | How often the stale thinking timer polls |

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
- [Claude Integration](claude-integration.md) -- command building and hook injection
- [Transition Engine](transition-engine.md) -- what triggers spawns and suspends
- [Activity Detection](activity-detection.md) -- thinking/idle state from hooks
