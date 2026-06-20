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

All DB status transitions flow through `src/main/transition-engine/session-lifecycle.ts` using atomic compare-and-set SQL (`compareAndUpdateStatus`) to prevent race conditions between concurrent writers.

**Legal transitions (enforced by `compareAndUpdateStatus`):**
- `queued -> running` (via `promoteRecord()`)
- `queued -> exited` (cancelled before start, via `markRecordExited()`)
- `running -> exited` (PTY process exits naturally or killed, via `markRecordExited()`)
- `running -> suspended` (explicit `suspend()` call, via `markRecordSuspended()`)
- `exited -> suspended` (preserve for future resume when moved to Done, via `markRecordSuspended()`)
- `suspended -> exited` (retired when replaced by new session, via `retireRecord()`)
- `orphaned -> exited` (recovery dedup or failed recovery, via `retireRecord()`)

**Resume check (`canResume()`):** a cheap DB-only gate on `agent_session_id` existence, NOT status. Any session with an `agent_session_id` is *potentially* resumable regardless of whether it's `suspended` or `exited`. Note that Claude resolves its transcript by the agent's current cwd, so the worktree path must stay stable across Done round-trips for `--resume` to find it (see "Resume Flow").

**Illegal transitions (bugs if they happen):**
- `queued -> suspended` (must run first)

## handleTaskMove Priority Cascade

`src/main/ipc/handlers/task-move.ts` -- the `handleTaskMove` function determines what happens to a session when a task moves between columns. It runs in three phases: Phase 1 (under `withTaskLock`: DB mutations + PTY suspend/kill dispatch), Phase 2 (unlocked: worktree git I/O), Phase 3 (locked: spawn). Phase 1 evaluates priorities in strict order -- first match wins:

1. **Same-column reorder** -- No side effects. Return.
2. **Priority 1 - Target is To Do** (role=`todo`) -- Cancel pending commands, kill session, full cleanup (remove worktree + delete branch). Return.
3. **Priority 2 - Target is Done** (role=`done`) -- Cancel pending commands, suspend session (resumable), auto-archive, delete the worktree directory while preserving `branch_name` + session records. Accepts both `running` AND `exited` sessions. Return.
4. **Priority 2.5 - Target has `auto_spawn=false`** -- Cancel pending commands, suspend if a session exists, do NOT respawn. Return.
5. **Priority 3 - Task has active session** -- Agent change → suspend + handoff; same-agent live-swap → inject commands; model/effort delta with no live-swap → suspend + respawn; otherwise keep the session alive.
6. **Priority 4 - No active session** -- Return a plan; Phase 2 (re)creates the worktree, Phase 3 spawns/resumes.

**Critical invariant:** state-changing branches call `terminalSubmitScheduler.cancel(taskId)` BEFORE the change, so a pending auto-command can't fire after the session is killed/suspended.

**Worktree path stability (session-loss fix):** Priority 2 deletes the worktree directory and nulls `worktree_path` but preserves `branch_name`. On move-out, Phase 2 recreates the worktree -- and `WorktreeManager.createWorktree` derives the folder name from the TITLE for auto-generated branches so the recreated path is identical to the original. This matters because Claude keys its transcript by cwd; a path change (e.g. re-slugifying the branch name and doubling the `-<shortId>` suffix) orphans the transcript. See "Resume Flow".

## Terminal Ownership Handoff

Each PTY session spawns exactly one Claude Code CLI process. Two UI locations can display terminal output -- the bottom panel (`TerminalPanel.tsx`) and the task detail dialog -- but never simultaneously.

**Mechanism:**
- `dialogSessionIds` (a string array) in the session store lists every session owned by an open task-detail window. It replaced the scalar `dialogSessionId` once task detail became modeless and multiple windows can stack.
- When a window claims a session (`claimDialogSession`): the panel's `TerminalTab` unmounts that session's xterm instance
- When a window releases a session (`releaseDialogSession` on close/unmount): the panel recreates the xterm from the PTY scrollback buffer
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

Claude stores each transcript at `~/.claude/projects/<slug-of-cwd>/<agentSessionId>.jsonl`,
keyed by the working directory (`slug = cwd.replace(/[/\\:.]/g, '-')`). `--resume <id>` only
succeeds when run from the cwd the original session ran in. Resume happens in coordinated
layers:

1. **Lifecycle check** (`src/main/transition-engine/session-lifecycle.ts`, `canResume()` / `isResumeEligible()`): cheap DB-only gate on `agent_session_id` existence (not status).
2. **Transition engine** (`src/main/transition-engine/transition-engine.ts`): retires the old record via `retireRecord()`, spawns a new PTY with `--resume <agent_session_id>` in the task's worktree cwd.
3. **Session manager / store**: scrollback preservation + `syncSessions()` reconciliation.

**Worktree path must stay stable.** Because the transcript is cwd-keyed, the worktree must be recreated at the SAME path across a Done round-trip. `WorktreeManager.createWorktree` derives the folder from the title for auto-generated branches to guarantee this. A regression here (e.g. re-slugifying the preserved branch name, which already ends in `-<shortId>`, and appending the suffix again -> `foo-abcd1234-abcd1234`) changes the cwd and silently orphans the session.

**`--resume` failure is loud, not silent.** When Claude can't find the transcript under the current cwd it prints `No conversation found with session ID: <id>` and EXITS -- it does NOT start a fresh session. The wrapping shell PTY stays alive and idle (the "N idle" phantom on the project). `recoverStaleSessionId()` therefore cannot heal this case (no agent ever starts to report a new id); the transcript-presence guard prevents the doomed `--resume` in the first place.

**Key rule:** A genuine resume gets `--resume <id>` ONLY -- no prompt. Fresh sessions (including a guard-triggered downgrade) get `--session-id <uuid>` WITH the task prompt.

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
- **`--resume` failure is loud, not silent**: When `--resume <uuid>` finds no transcript under the current cwd, Claude prints `No conversation found` and EXITS (no fresh-session fallback), leaving an idle shell PTY. `recoverStaleSessionId()` cannot help because no agent starts to report a new id. The cwd-keyed transcript model plus stable worktree naming (`createWorktree` derives the folder from the title for auto-generated branches) keep the cwd constant across Done round-trips so `--resume` finds the transcript. See "Resume Flow".

## Key Source Files

- `src/main/transition-engine/session-lifecycle.ts` -- Centralized state machine (canResume, markRecordExited, markRecordSuspended, retireRecord, promoteRecord, recoverStaleSessionId)
- `src/main/pty/session-manager.ts` -- PTY lifecycle, spawn, suspend, kill, scrollback
- `src/main/pty/session-queue.ts` -- Concurrency control, max concurrent sessions
- `src/main/transition-engine/transition-engine.ts` -- Action execution, resume logic
- `src/main/ipc/handlers/task-move.ts` -- handleTaskMove priority cascade
- `src/main/git/worktree-manager.ts` -- `createWorktree` (stable, title-derived folder naming)
- `src/renderer/stores/session-store.ts` -- Zustand store, sync generation guard
- `src/renderer/components/terminal/TerminalPanel.tsx` -- Terminal ownership handoff
