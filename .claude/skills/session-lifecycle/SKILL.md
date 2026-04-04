---
description: Session state machine, PTY lifecycle, and terminal ownership patterns
---

# Session Lifecycle

Contextual knowledge for session state management, PTY lifecycle, and terminal ownership. Reference this skill when working on session-related code to avoid the recurring bug patterns documented here.

## State Machine

```
spawn() called
    |
    v
[queued] --processQueue()--> [running] --onExit()--> [exited]
             |                  |                       |
         cancelled          suspend()            markRecordSuspended()
             |                  |                  (Done column)
             v                  v                       |
          [exited]         [suspended] <----------------+
                               |
                         retireRecord()
                               |
                               v
                           [exited]
```

All DB status transitions flow through `src/main/engine/session-lifecycle.ts` using atomic compare-and-set SQL (`compareAndUpdateStatus`) to prevent race conditions between concurrent writers.

**Legal transitions (enforced by `compareAndUpdateStatus`):**
- `queued -> running` (via `promoteRecord()`)
- `queued -> exited` (cancelled before start, via `markRecordExited()`)
- `running -> exited` (PTY process exits naturally or killed, via `markRecordExited()`)
- `running -> suspended` (explicit `suspend()` call, via `markRecordSuspended()`)
- `exited -> suspended` (preserve for future resume when moved to Done, via `markRecordSuspended()`)
- `suspended -> exited` (retired when replaced by new session, via `retireRecord()`)
- `orphaned -> exited` (recovery dedup or failed recovery, via `retireRecord()`)

**Resume check (`canResume()`):** checks `agent_session_id` existence, NOT status. Any session with an `agent_session_id` is potentially resumable regardless of whether it's `suspended` or `exited`.

**Illegal transitions (bugs if they happen):**
- `queued -> suspended` (must run first)

## handleTaskMove Priority Cascade

`src/main/ipc/handlers/tasks.ts` -- the `handleTaskMove` function (lines 22-149) determines what happens to a session when a task moves between columns. The checks execute in strict priority order -- first match wins:

1. **Same-column reorder** (line 44) -- No side effects. Return immediately.
2. **Target is Backlog** (role=`backlog`, lines 50-55) -- Cancel pending commands, kill session (hard stop), preserve worktree. Return.
3. **Target is Done** (role=`done`, lines 58-83) -- Cancel pending commands, suspend session (resumable), auto-archive task. Accepts both `running` AND `exited` sessions.
4. **Target has `auto_spawn=false`** (lines 87-100) -- Cancel pending commands, suspend if session exists, do NOT respawn. Return.
5. **Task has active session** (lines 105-114) -- If target has `auto_command`, suspend and respawn with command as resume prompt. Otherwise keep session alive (permission mode differences alone do not trigger suspend/resume).
6. **No active session** (lines 117-148) -- Create worktree, execute transitions (which may spawn), attempt resume of suspended session.

**Critical invariant:** Steps 2-4 always call `commandInjector.cancel(taskId)` BEFORE any session state change. This prevents a pending auto-command from firing after the session is killed/suspended.

## Terminal Ownership Handoff

Each PTY session spawns exactly one Claude Code CLI process. Two UI locations can display terminal output -- the bottom panel (`TerminalPanel.tsx`) and the task detail dialog -- but never simultaneously.

**Mechanism:**
- `dialogSessionId` in the session store marks which session the dialog currently owns
- When dialog opens: sets `dialogSessionId`, panel's `TerminalTab` unmounts its xterm instance (line 172 of `TerminalPanel.tsx`)
- When dialog closes: clears `dialogSessionId`, panel recreates xterm from PTY scrollback buffer
- One xterm instance at a time per session prevents duplicate resize calls (different container widths garble TUI output)

**Source:** `src/renderer/components/terminal/TerminalPanel.tsx`

## Race Condition Guards

### Session Manager (`src/main/pty/session-manager.ts`)

| Guard | Location | Purpose |
|-------|----------|---------|
| Orphaned PTY prevention | lines 116-122 | Kills existing PTY before spawning new one for same taskId |
| File cleanup race | lines 132-142 | Nulls file paths on old session BEFORE killing PTY, so async `onExit` doesn't delete new session's files |
| Flush scheduling guard | lines 269-280 | Checks session still exists before emitting buffered data (16ms window) |
| Status preservation on exit | lines 284-286 | Only sets `exited` if not already `suspended` |

### Session Queue (`src/main/pty/session-queue.ts`)

| Guard | Location | Purpose |
|-------|----------|---------|
| Reentrancy guard | lines 84-109 | `_processing` + `_dirty` loop prevents concurrent spawning |
| Await before next | line 97 | Each spawn is awaited so `getActiveCount()` reflects it before next iteration |

### Session Store (`src/renderer/stores/session-store.ts`)

| Guard | Location | Purpose |
|-------|----------|---------|
| `_syncGeneration` | line 75 | Discards stale sync results if project changed during async fetch |
| Pre/post reference compare | line 87 | Detects if IPC updated store during the async gap, keeps store-side version |
| Store data overlay | lines 96-104 | Preserves usage/activity/events from store even after sync |

### Board Store

| Guard | Purpose |
|-------|---------|
| `moveGeneration` | Prevents stale board state from overwriting a concurrent move |

## Resume Flow

Resume happens in three coordinated layers:

1. **Lifecycle check** (`src/main/engine/session-lifecycle.ts`, `canResume()`): Checks `agent_session_id` existence (not status) on the latest session record. Any session that started an agent and got an `agent_session_id` has a transcript that `--resume` can use.
2. **Transition engine** (`src/main/engine/transition-engine.ts`): Calls `canResume()`, retires the old record via `retireRecord()`, spawns a new PTY with `--resume <agent_session_id>`.
3. **Session manager** (`src/main/pty/session-manager.ts`): Preserves scrollback buffer from previous session to write into new xterm on connect.
4. **Session store** (`src/renderer/stores/session-store.ts`): `syncSessions()` reconciles main process state, handling IPC updates that arrived during the async fetch gap.

**Stale ID recovery:** If `--resume` fails silently (no JSONL found), the agent creates a fresh session with a different UUID. The `UsageTracker` detects the mismatch from the first `status.json` update and `recoverStaleSessionId()` updates the DB so the next resume uses the correct UUID.

**Key rule:** Resumed sessions get `--resume <id>` ONLY -- no prompt is passed. Fresh sessions get `--session-id <uuid>` WITH prompt.

## Subagent Activity Tracking

`src/main/pty/session-manager.ts` (lines 608-678) tracks subagent nesting depth to prevent UI flicker:

- `subagentDepth` map tracks nesting level per session
- Tool events at depth > 0 suppress `idle -> thinking` transitions (lines 658-664)
- `thinking -> idle` deferred while subagents are active via `pendingIdleWhileSubagent` flag (lines 669-674)
- Synthetic `session_end` event emitted when PTY is killed (lines 500-513)
- `pendingToolCount` map tracks in-flight tools per session (incremented on `tool_start`, decremented on `tool_end`/`interrupted`). When > 0, `checkStaleThinking()` resets its timer instead of transitioning to idle. This prevents false idle during long-running tools (e.g. Bash running `npm run build`) and subagent executions (Agent tool stays pending for the entire subagent lifetime).

## DB vs Live Session Divergence

- **DB `SessionRecord`**: Persisted state (`status`, `agent_session_id`, `command`, `prompt`, `started_at`, `suspended_at`, `exited_at`). Source of truth for resume capability.
- **Live PTY `Session`**: In-memory state with PTY handle, scrollback buffer, file watchers, event cache. Source of truth for current activity.
- **Reconciliation**: `syncSessions()` in the store merges both. DB records persist across app restarts; live sessions do not.

## Known Pitfalls

- **Rapid task moves during async gaps**: A task moved twice quickly can trigger two `handleTaskMove` calls that interleave. The `commandInjector.cancel()` ordering and generation counters mitigate this but don't fully prevent it.
- **Timestamp-based ordering nondeterminism**: Sessions sorted by `startedAt` may have identical timestamps if spawned in rapid succession. Use stable secondary sort (session ID) when ordering matters.
- **Natural agent exit vs kill**: When the agent exits naturally (user types `/exit` or task completes), the PTY fires `onExit`. The `markRecordExited()` function uses atomic `compareAndUpdateStatus` to only transition from `running`/`queued` - it never overwrites `suspended`, which may have been set by `handleTaskMove` before the async `onExit` fires.
- **Silent `--resume` failure**: When `--resume <uuid>` finds no matching JSONL file, it silently starts a fresh session with a new UUID. The `UsageTracker` detects this from the first `status.json` update and corrects the DB via `recoverStaleSessionId()`.

## Key Source Files

- `src/main/engine/session-lifecycle.ts` -- Centralized state machine (canResume, markRecordExited, markRecordSuspended, retireRecord, promoteRecord, recoverStaleSessionId)
- `src/main/pty/session-manager.ts` -- PTY lifecycle, spawn, suspend, kill, scrollback
- `src/main/pty/session-queue.ts` -- Concurrency control, max concurrent sessions
- `src/main/engine/transition-engine.ts` -- Action execution, resume logic
- `src/main/ipc/handlers/tasks.ts` -- handleTaskMove priority cascade
- `src/renderer/stores/session-store.ts` -- Zustand store, sync generation guard
- `src/renderer/components/terminal/TerminalPanel.tsx` -- Terminal ownership handoff
