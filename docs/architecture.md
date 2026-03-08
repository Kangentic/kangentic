# Architecture

## Process Model

Electron app with two processes:

- **Main process** -- Node.js runtime. Owns the database, PTY sessions, git operations, file I/O, and IPC handlers. Entry point: `src/main/index.ts`.
- **Renderer process** -- Chromium window running React. Communicates exclusively through `window.electronAPI` (context bridge). Entry point: `src/renderer/index.tsx`.
- **Preload script** -- Bridges main↔renderer via `contextBridge.exposeInMainWorld()`. Exposes typed `electronAPI` object. Entry point: `src/preload/preload.ts`.

Context isolation is enabled -- the renderer has no direct access to Node.js APIs.

## Data Flow

```
User drags task between columns
  → BoardStore.moveTask() -- optimistic UI update
  → IPC task:move
  → Main: update DB positions
  → Main: check priority rules (Backlog? Done? Active session? No session?)
  → Main: TransitionEngine executes action chain (create_worktree → spawn_agent)
  → SessionManager spawns PTY (or queues it)
  → PTY streams output → 16ms batched flush → IPC session:data → xterm render
  → Bridge scripts write status/activity/events files → fs.watch → IPC → Zustand stores
```

## IPC Channels

All channels defined in `src/shared/ipc-channels.ts`. The preload bridge in `src/preload/preload.ts` mirrors them as `window.electronAPI.*`.

### Projects (8 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `project:list` | invoke | Fetch all projects (ordered by position) |
| `project:create` | invoke | Create new project (inserted at position 0) |
| `project:delete` | invoke | Delete project and clean up resources |
| `project:open` | invoke | Open project (init DB, recover sessions) |
| `project:getCurrent` | invoke | Get currently loaded project |
| `project:openByPath` | invoke | Open project by filesystem path |
| `project:reorder` | invoke | Reorder projects by ID array |
| `project:autoOpened` | on | Event: project auto-opened on launch |

### Tasks (7 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `task:list` | invoke | Fetch tasks, optionally by swimlane |
| `task:create` | invoke | Create task with title, description, swimlane |
| `task:update` | invoke | Update task properties |
| `task:delete` | invoke | Delete task and clean up session/worktree |
| `task:move` | invoke | Move task between swimlanes (triggers transitions) |
| `task:list-archived` | invoke | Fetch archived tasks |
| `task:unarchive` | invoke | Restore archived task |

### Attachments (4 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `attachment:list` | invoke | Fetch task attachments |
| `attachment:add` | invoke | Add attachment (base64 data) |
| `attachment:remove` | invoke | Delete attachment |
| `attachment:getDataUrl` | invoke | Get data URL for display |

### Swimlanes (5 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `swimlane:list` | invoke | Fetch all swimlanes |
| `swimlane:create` | invoke | Create swimlane with name, color, icon, role |
| `swimlane:update` | invoke | Update swimlane properties |
| `swimlane:delete` | invoke | Delete swimlane (blocked if has tasks) |
| `swimlane:reorder` | invoke | Reorder swimlanes by ID array |

### Actions (4 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `action:list` | invoke | Fetch all actions |
| `action:create` | invoke | Create action with type and config |
| `action:update` | invoke | Update action |
| `action:delete` | invoke | Delete action |

### Transitions (3 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `transition:list` | invoke | Fetch all transitions |
| `transition:set` | invoke | Set action chain for lane A→B |
| `transition:getFor` | invoke | Get transitions for lane pair (exact match, then wildcard) |

### Sessions (18 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `session:spawn` | invoke | Spawn PTY session (may queue) |
| `session:kill` | invoke | Kill session |
| `session:suspend` | invoke | Suspend session (preserves for resume) |
| `session:resume` | invoke | Resume suspended session |
| `session:write` | invoke | Write to session stdin |
| `session:resize` | invoke | Resize PTY (cols/rows) |
| `session:list` | invoke | Fetch all sessions |
| `session:getScrollback` | invoke | Get terminal scrollback buffer |
| `session:getUsage` | invoke | Fetch session usage (tokens, cost). Optional `projectId` scopes to one project. |
| `session:getActivity` | invoke | Fetch activity state (thinking/idle). Optional `projectId` scopes to one project. |
| `session:getEvents` | invoke | Fetch activity log events for one session |
| `session:getEventsCache` | invoke | Fetch cached event arrays. Optional `projectId` scopes to one project. |
| `session:data` | on | Terminal output available (includes `projectId`) |
| `session:exit` | on | Session exited (includes `projectId`) |
| `session:status` | on | Session status changed (includes `projectId`) |
| `session:usage` | on | Usage data updated (includes `projectId`) |
| `session:activity` | on | Activity state changed (includes `projectId`, `taskId`, `taskTitle`) |
| `session:event` | on | Structured event (includes `projectId`) |

### Config (4 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `config:get` | invoke | Fetch global AppConfig |
| `config:set` | invoke | Update global config (partial merge) |
| `config:getProject` | invoke | Fetch project-level config overrides |
| `config:setProject` | invoke | Update project-level overrides |

### Notifications (2 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `notification:show` | send | Show native OS notification (task name + project name) |
| `notification:clicked` | on | User clicked a notification (includes projectId, taskId) |

### Claude, Shell, Dialog, Window (9 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `claude:detect` | invoke | Detect Claude CLI (path, version) |
| `shell:getAvailable` | invoke | List available shells |
| `shell:getDefault` | invoke | Get default shell |
| `shell:openPath` | invoke | Open directory in file explorer |
| `dialog:selectFolder` | invoke | OS folder picker |
| `window:minimize` | send | Minimize window |
| `window:maximize` | send | Maximize/restore window |
| `window:close` | send | Close window |
| `window:isFocused` | invoke | Check if window has focus (for notification gating) |

## Database

Two SQLite databases using better-sqlite3 with WAL mode and foreign keys enabled.

### Global DB (`<configDir>/index.db`)

Platform-dependent config directory:
- **Windows:** `%APPDATA%/kangentic/`
- **macOS:** `~/Library/Application Support/kangentic/`
- **Linux:** `$XDG_CONFIG_HOME/kangentic/` (defaults to `~/.config/kangentic/`)

Overridable via `KANGENTIC_DATA_DIR` env var.

Stores the project list. Tables:

- **projects** -- id, name, path, github_url, default_agent, last_opened, created_at
- **global_config** -- key/value store for app-wide settings

### Per-Project DB (`<configDir>/projects/<projectId>.db`)

Created on project open. Stored in the global config directory (not inside the project). Tables:

- **swimlanes** -- Kanban columns. Fields: id, name, role (`backlog`/`planning`/`done`/null), position, color, icon, is_archived, permission_strategy, auto_spawn, auto_command, created_at
- **tasks** -- Kanban cards. Fields: id, title, description, swimlane_id, position, agent, session_id, worktree_path, branch_name, pr_number, pr_url, base_branch, archived_at, created_at, updated_at
- **actions** -- Executable steps. Types: `spawn_agent`, `send_command`, `run_script`, `kill_session`, `create_worktree`, `cleanup_worktree`, `webhook`. Config stored as JSON.
- **swimlane_transitions** -- Maps lane pairs to action chains. Fields: from_swimlane_id (`*` = any), to_swimlane_id, action_id, execution_order
- **sessions** -- Session persistence for recovery/resume. Fields: id, task_id, session_type, claude_session_id, command, cwd, permission_mode, prompt, status (`running`/`suspended`/`exited`/`orphaned`), exit_code, timestamps
- **task_attachments** -- File attachments (images, etc.) stored on disk, metadata in DB

Repositories follow a simple pattern -- one class per table, all queries are synchronous (better-sqlite3). Transactions used for position shifts (task move, swimlane reorder).

## Transition Engine

`src/main/engine/transition-engine.ts`

When a task moves between swimlanes, the IPC handler checks priorities in order:

1. **Target is Backlog** → Kill session, preserve worktree
2. **Target is Done** → Suspend session (resumable), archive task
3. **Target has auto_spawn=false** → Suspend session
4. **Task has active session** → Keep it alive. If target has auto_command, inject it via CommandInjector
5. **Task has no session** → Create worktree (if enabled), execute transition action chain

Transitions only fire for case 5. The action chain runs in `execution_order`: typically `create_worktree` → `spawn_agent`.

### Action Types

| Type | What it does |
|------|-------------|
| `spawn_agent` | Build Claude CLI command, spawn PTY. Resumes if suspended session exists. |
| `send_command` | Write interpolated text to running PTY stdin |
| `run_script` | Spawn one-off shell command (no persistence) |
| `kill_session` | Suspend session, clear task.session_id |
| `create_worktree` | Create git worktree with sparse-checkout |
| `cleanup_worktree` | Remove worktree directory and optionally branch |
| `webhook` | POST to URL with interpolated body |

Template variables available: `{{title}}`, `{{description}}`, `{{taskId}}`, `{{worktreePath}}`, `{{branchName}}`, `{{attachments}}`.

## PTY Session Manager

`src/main/pty/session-manager.ts`

### Spawn Flow

1. Check concurrency limit → queue if full (returns placeholder with `status: 'queued'`)
2. Kill any existing PTY for the same task (orphan dedup)
3. Resolve shell and arguments (platform-specific)
4. Spawn PTY via node-pty
5. Start two file watchers (status, events)
6. Set up output handler (16ms batched flush)
7. After 100ms delay, write the CLI command to PTY stdin

### Output Streaming

- **Buffer:** PTY `onData` accumulates into per-session buffer
- **Flush:** 16ms interval (~60fps) emits buffered data via IPC `session:data`
- **Scrollback:** 512KB ring buffer per session. Used to restore terminal content when switching views.

### File Watchers

Two watchers per session, reading files written by bridge scripts:

| Watcher | File | Debounce | Emits |
|---------|------|----------|-------|
| Status | `status.json` | 100ms | `session:usage` -- tokens, cost, model |
| Events | `events.jsonl` | 50ms | `session:event` -- tool_start/end, prompt, idle; `session:activity` -- thinking/idle (derived) |

Events watcher uses byte offset tracking to only read new lines (no full re-read). Activity state (thinking/idle) is derived from event types -- see [Activity Detection](activity-detection.md).

### Shell Resolution

Platform-specific detection order in `src/main/pty/shell-resolver.ts`:

| Platform | Order |
|----------|-------|
| Windows | pwsh → powershell → bash → cmd → WSL distros |
| macOS | zsh → bash → fish → nushell → sh |
| Linux | bash → zsh → fish → dash → nushell → ksh → sh |

Shell-specific adaptations:
- PowerShell: `& ` prefix for command execution, `-NoLogo` flag
- WSL: shell spec split into exe + args
- bash/zsh: `--login` flag
- fish/nushell: no login flag
- Windows paths converted: Git Bash `/c/path`, WSL `/mnt/c/path`

### Key Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| MAX_SCROLLBACK | 512 KB | Terminal history per session |
| MAX_EVENTS | 500 | Activity log cap per session |
| Flush interval | 16 ms | Output batching (~60fps) |
| Status debounce | 100 ms | Usage file watch |
| Event debounce | 50 ms | Event log + activity state watch |
| Graceful shutdown | 2000 ms | Max wait for `/exit` on app close |

## Session Queue

`src/main/pty/session-queue.ts`

Limits concurrent PTY sessions (default: 5, configurable via `config.claude.maxConcurrentSessions`).

When a session is requested and the limit is reached, it gets a `queued` status placeholder. When a running session exits or suspends, `notifySlotFreed()` promotes the next queued entry.

Uses a reentrancy-safe double-check loop: a `_processing` flag prevents concurrent promotion, and a `_dirty` flag ensures re-iteration if the queue changed during a spawn await.

## Zustand Stores

All stores in `src/renderer/stores/`. They call `window.electronAPI.*` for IPC and manage local UI state.

### BoardStore (`board-store.ts`)

State: `tasks`, `swimlanes`, `archivedTasks`, `loading`, `completingTask`, `recentlyArchivedId`

- **Optimistic updates** -- all mutations update UI immediately, then sync via IPC. Errors revert via full `loadBoard()`.
- **Stale move protection** -- `moveGeneration` counter prevents older async reloads from clobbering newer moves.
- **Session cascade** -- after task move, reloads sessions to detect spawns/kills from transition engine. Auto-activates new sessions with toast notification.
- **Completion animation** -- `setCompletingTask()` captures DOM rect, `finalizeCompletion()` triggers the actual move.

### SessionStore (`session-store.ts`)

State: `sessions`, `activeSessionId`, `openTaskId`, `dialogSessionId`, `sessionUsage`, `sessionActivity`, `sessionEvents`

- **Terminal ownership handoff** -- `dialogSessionId` ensures the bottom panel and task detail dialog never render xterm simultaneously. When the dialog opens, the panel unmounts its xterm. On close, the panel recreates from scrollback.
- **Cache restoration** -- `syncSessions()` fetches usage/activity/events from main process memory, surviving renderer reloads (Vite HMR). Usage and events are scoped to the current project; activity is fetched unscoped so sidebar badges work across all projects.
- **Project switch cleanup** -- On project switch, `activeSessionId`, `dialogSessionId`, `openTaskId`, `sessionUsage`, and `sessionEvents` are cleared before re-syncing. A generation counter invalidates in-flight syncs from the previous project. `sessionActivity` and `sessions` are preserved for sidebar badge rendering. After sync completes, any `_pendingOpenTaskId` (set by notification click) is applied and cleared.
- **Event capping** -- max 500 events per session to bound DOM size in ActivityLog.
- **Queue position** -- `getQueuePosition()` returns 1-indexed position sorted by startedAt.

### ConfigStore (`config-store.ts`)

State: `config` (AppConfig), `claudeInfo`, `claudeVersionLabel`, `settingsOpen`

- **Theme subscription** -- watches theme changes, updates `<html>` class for CSS variables.
- **Claude detection** -- `detectClaude()` finds CLI path and parses version string.

### ProjectStore (`project-store.ts`)

State: `projects`, `currentProject`, `loading`

Standard CRUD. `openProject()` triggers main process initialization (DB, session recovery, worktree reconciliation).

### ToastStore (`toast-store.ts`)

State: `toasts` (max 5)

Ephemeral notifications with auto-dismiss. Called by other stores for success/error feedback.

## Claude CLI Integration

`src/main/agent/command-builder.ts`

### Command Building

Constructs the `claude` CLI invocation:

- **New session:** `claude --settings <path> --session-id <uuid> "prompt"`
- **Resume:** `claude --settings <path> --resume <uuid>` (no prompt)

### Permission Mode Flags

| Mode | Flag |
|------|------|
| `bypass-permissions` | `--dangerously-skip-permissions` |
| `default` | `--settings <path>` (uses project-settings) |
| `plan` | `--permission-mode plan` |
| `acceptEdits` | `--permission-mode acceptEdits` |
| `manual` | (none -- interactive prompts) |

### Permission Mode Resolution (priority order)

1. Swimlane's `permission_strategy` (if set)
2. Action's `permissionMode` config (if set)
3. Global `config.claude.permissionMode`

### Settings Merge

For each session, a merged settings file is created at `.kangentic/sessions/<sessionId>/settings.json`:

1. Read `.claude/settings.json` (committed project settings)
2. Read `.claude/settings.local.json` (gitignored local settings)
3. Deep-merge hooks from both
4. Inject Kangentic bridge commands into hook points
5. Write merged file, pass to CLI via `--settings`

## Session Recovery

On project open (`src/main/engine/session-recovery.ts`):

1. **Prune orphaned worktrees** -- delete tasks whose worktree directories were removed externally
2. **Mark crash recovery** -- leftover `running` DB records become `orphaned`
3. **Deduplicate** -- keep only the latest record per task_id
4. **Filter candidates** -- skip Backlog/Done, skip auto_spawn=false, skip missing CWD
5. **Resume or respawn** -- suspended sessions use `--resume`, others get fresh `--session-id`
6. **Reconcile** -- spawn fresh agents for tasks in auto_spawn columns with no session

## Performance

- **WebGL xterm** -- attempts WebGL renderer first, falls back to canvas on context loss
- **Resize debouncing** -- PTY resize calls debounced at 200ms, suppressed during panel drag
- **Activity log** -- plain DOM list instead of xterm. Events flow through JSONL files, not terminal output.
- **Terminal ownership handoff** -- one xterm instance per session at a time prevents duplicate resize calls that corrupt TUI output
- **Output batching** -- 16ms flush interval prevents per-character IPC overhead
- **Scrollback cap** -- 512KB prevents unbounded memory growth

## See Also

- [Session Lifecycle](session-lifecycle.md) -- Full state machine, spawn flow, queue, crash recovery
- [Claude Integration](claude-integration.md) -- Command building, settings merge, hooks, trust management
- [Transition Engine](transition-engine.md) -- Action types, templates, priority rules
- [Database](database.md) -- Full schema reference, migrations, repository pattern
- [Configuration](configuration.md) -- Config cascade, all settings keys
- [Cross-Platform](cross-platform.md) -- Shell resolution, path handling, packaging
- [Activity Detection](activity-detection.md) -- Event pipeline, thinking/idle state derivation
- [Worktree Strategy](worktree-strategy.md) -- Branch naming, sparse-checkout, hook delivery
