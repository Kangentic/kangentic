# Session Lifecycle

This document describes the full session state machine in Kangentic, covering how Claude Code CLI sessions are spawned, queued, suspended, resumed, and recovered.

## State Machine

Sessions move through five possible states:

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
      |                |
      |                | app crashes
      |                v
      |           +----------+
      +---------->| orphaned |
   (recovery)    +----------+
```

### States

| State | Description |
|-------|-------------|
| `queued` | Waiting for a concurrency slot to open |
| `running` | PTY is live, Claude Code CLI process is active |
| `suspended` | PTY killed, but session ID and files preserved for resume |
| `exited` | Process exited naturally or was killed; terminal state |
| `orphaned` | App crashed while session was running; discovered on next launch |

### Transitions

| From | To | Trigger |
|------|----|---------|
| `queued` | `running` | Concurrency slot opens, `SessionQueue` promotes |
| `queued` | `exited` | Session killed while still queued |
| `running` | `suspended` | Task moved to Backlog/Done or `auto_spawn=false` column |
| `running` | `exited` | Process exits naturally or is killed |
| `running` | `orphaned` | App crashes, leftover `running` DB record found on next launch |
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
   - If resuming: use existing `claude_session_id` with `--resume`, no prompt
   - If fresh: generate new UUID for `claude_session_id`, use `--session-id`, include prompt
   - Create session directory at `.kangentic/sessions/<claudeSessionId>/`
   - Build Claude CLI command via `CommandBuilder`
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

- Configurable max concurrent sessions (default: 8, `config.claude.maxConcurrentSessions`).
- When the limit is reached, the session receives a `queued` status placeholder.
- When a running session exits or is suspended, `notifySlotFreed()` promotes the next queued entry.
- Reentrancy-safe: a `_processing` flag prevents concurrent promotion, and a `_dirty` flag ensures re-iteration if the queue changed during a spawn await.

## Suspend

Suspend is triggered when a task moves to:

- **Backlog** (role=`backlog`) -- kills session
- **Done** (role=`done`) -- suspends session (preserves for resume), archives task
- **Any column with `auto_spawn=false`** -- suspends session

### What is preserved on suspend

- `claude_session_id` (for `--resume` on next spawn)
- Worktree directory and branch
- Session files on disk (`status.json`, `events.jsonl`, `settings.json`)
- Scrollback buffer in memory

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

- Command: `claude --settings <path> --resume <claudeSessionId>` (no prompt)
- New PTY spawned with scrollback carried over from previous session
- New session DB record inserted, old record marked `exited`

## Crash Recovery (Session Recovery)

On project open (`session-recovery.ts`):

1. **Prune orphaned worktrees** -- delete tasks whose worktree directories were removed externally
2. **Mark crash recovery** -- leftover `running` DB records become `orphaned` (skip records with live PTYs to handle re-entrant calls)
3. **Collect candidates** -- all `suspended` + `orphaned` claude_agent records
4. **Deduplicate** -- keep only the latest record per `task_id`, mark older duplicates as `exited`
5. **Filter** -- skip tasks in non-auto-spawn columns, skip missing CWD, skip deleted/archived tasks
6. **Resume or respawn**:
   - Suspended/orphaned with `claude_session_id` -- use `--resume` (attempts to restore conversation)
   - No session ID -- fresh `--session-id` with prompt from matching `spawn_agent` action
7. **Reconcile** -- spawn fresh agents for tasks in auto_spawn columns with no session at all

## Graceful Shutdown

On app close (`SessionManager.suspendAll()`):

1. Send `Ctrl+C` to each running PTY (interrupts in-progress operation)
2. Send `/exit` to each PTY (triggers Claude Code clean shutdown, flushes JSONL)
3. Wait up to 2000ms for processes to exit
4. Force-kill remaining PTYs (null file paths first to preserve files)
5. Return task IDs for DB status updates

## Terminal Ownership Handoff

- Each PTY session spawns exactly one Claude Code CLI process.
- The bottom panel and task detail dialog share that single process.
- `dialogSessionId` in `SessionStore` ensures mutual exclusion.
- When the dialog opens: the panel unmounts its xterm instance.
- When the dialog closes: the panel recreates xterm from PTY scrollback buffer.
- This prevents duplicate xterm instances from sending conflicting resize calls.

## Project-Scoped Session State

Sessions from non-active projects must not interfere with the active project's terminal panel, activity icons, or store state. This is enforced at three levels:

1. **IPC event forwarding** — All session events (`data`, `usage`, `activity`, `event`, `status`, `exit`) include the session's `projectId`. The renderer filters events by comparing against the current project.
2. **Cache getters** — `getUsage`, `getActivity`, and `getEventsCache` accept an optional `projectId` parameter. When provided, `SessionManager` returns only data for sessions belonging to that project.
3. **Store scoping** — `syncSessions()` fetches usage and events scoped to the current project, but activity unscoped (sidebar badges need cross-project data). On project switch, `activeSessionId`, `sessionUsage`, and `sessionEvents` are cleared; `sessions` and `sessionActivity` are preserved for the sidebar.

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
| Graceful shutdown | 2000 ms | Max wait for `/exit` on app close |
| Command inject delay | 100 ms | Wait after PTY spawn before writing command |

## See Also

- [Configuration](configuration.md) -- permission modes and session limits
- [Claude Integration](claude-integration.md) -- command building and hook injection
- [Transition Engine](transition-engine.md) -- what triggers spawns and suspends
- [Activity Detection](activity-detection.md) -- thinking/idle state from hooks
