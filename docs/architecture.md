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
  → Main: check priority rules (To Do? Done? Active session? No session?)
  → Main: TransitionEngine executes action chain (create_worktree → spawn_agent)
  → SessionManager spawns PTY (or queues it)
  → PTY streams output → 16ms batched flush → IPC session:data → xterm render
  → Bridge scripts write status/activity/events files → fs.watch → IPC → Zustand stores
```

## IPC Channels

All channels defined in `src/shared/ipc-channels.ts`. The preload bridge in `src/preload/preload.ts` mirrors them as `window.electronAPI.*`.

### Projects (12 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `project:list` | invoke | Fetch all projects (ordered by position) |
| `project:create` | invoke | Create new project (inserted at position 0) |
| `project:delete` | invoke | Delete project and clean up resources |
| `project:open` | invoke | Open project (init DB, recover sessions) |
| `project:getCurrent` | invoke | Get currently loaded project |
| `project:openByPath` | invoke | Open project by filesystem path |
| `project:searchEntries` | invoke | Search files and directories within a project for mention autocomplete |
| `project:reorder` | invoke | Reorder projects by ID array |
| `project:setGroup` | invoke | Assign a project to a group (or clear group assignment) |
| `project:rename` | invoke | Rename a project |
| `project:setDefaultAgent` | invoke | Set the default agent CLI for a project |
| `project:autoOpened` | on | Event: project auto-opened on launch |

### Project Groups (6 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `projectGroup:list` | invoke | Fetch all project groups (ordered by position) |
| `projectGroup:create` | invoke | Create a new project group |
| `projectGroup:update` | invoke | Rename a project group |
| `projectGroup:delete` | invoke | Delete a group (projects become ungrouped) |
| `projectGroup:reorder` | invoke | Reorder groups by ID array |
| `projectGroup:setCollapsed` | invoke | Toggle group collapsed state |

### Tasks (16 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `task:list` | invoke | Fetch tasks, optionally by swimlane |
| `task:create` | invoke | Create task with title, description, swimlane |
| `task:update` | invoke | Update task properties |
| `task:delete` | invoke | Delete task and clean up session/worktree |
| `task:move` | invoke | Move task between swimlanes (triggers transitions) |
| `task:list-archived` | invoke | Fetch archived tasks |
| `task:unarchive` | invoke | Restore archived task |
| `task:bulk-delete` | invoke | Delete multiple archived tasks by ID array |
| `task:bulk-delete-progress` | on | Event: progress payload during bulk task delete (completed/total/failures) |
| `task:bulk-unarchive` | invoke | Restore multiple archived tasks to a target swimlane |
| `task:switchBranch` | invoke | Switch base branch or enable worktree for a task |
| `task:autoMoved` | on | Event: task was auto-moved by transition engine |
| `task:createdByAgent` | on | Event: task was created by an agent via MCP tool call |
| `task:updatedByAgent` | on | Event: task was updated by an agent via MCP tool call |
| `task:deletedByAgent` | on | Event: task was deleted by an agent via MCP tool call |
| `task:spawnProgress` | on | Event: spawn progress phase label during task move |

### Attachments (5 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `attachment:list` | invoke | Fetch task attachments |
| `attachment:add` | invoke | Add attachment (base64 data) |
| `attachment:remove` | invoke | Delete attachment |
| `attachment:getDataUrl` | invoke | Get data URL for display |
| `attachment:open` | invoke | Open attachment in the system default application |

### Backlog (13 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `backlog:list` | invoke | Fetch all backlog items (ordered by position) |
| `backlog:create` | invoke | Create a new backlog item |
| `backlog:update` | invoke | Update a backlog item |
| `backlog:delete` | invoke | Delete a backlog item |
| `backlog:reorder` | invoke | Reorder backlog items by ID array |
| `backlog:bulk-delete` | invoke | Delete multiple backlog items by ID array |
| `backlog:promote` | invoke | Promote backlog items to board tasks (move to a swimlane) |
| `backlog:demote` | invoke | Demote a board task back to the backlog |
| `backlog:renameLabel` | invoke | Rename a label across all backlog items |
| `backlog:deleteLabel` | invoke | Remove a label from all backlog items |
| `backlog:remapPriorities` | invoke | Remap priority values across all backlog items |
| `backlog:changedByAgent` | on | Event: backlog was modified by an agent via MCP tool call |
| `backlog:labelColorsChanged` | on | Event: label color mappings changed by agent via MCP tool call |

### Backlog Import (6 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `backlog:importCheckCli` | invoke | Check if the CLI tool for a source is available and authenticated |
| `backlog:importFetch` | invoke | Fetch items from an external source (GitHub Issues, GitHub Projects, Azure DevOps, Asana) |
| `backlog:importExecute` | invoke | Import selected items into the backlog with attachment download |
| `backlog:importSourcesList` | invoke | List saved import sources for the current project |
| `backlog:importSourcesAdd` | invoke | Add a new import source (persisted in project config). Providers with an optional `resolveLabel` hook (e.g. Asana) enrich the stored label with a human-readable name. |
| `backlog:importSourcesRemove` | invoke | Remove a saved import source |

### Board Auth - Asana (3 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `boards:asana:authStatus` | invoke | Report Asana connection state: `{connected, email?}` |
| `boards:asana:setPat` | invoke | Validate a Personal Access Token via `/users/me` and persist it encrypted; returns `{ok, email?, error?}` |
| `boards:asana:clearCredential` | invoke | Remove the stored Personal Access Token |

### Backlog Attachments (5 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `backlogAttachment:list` | invoke | Fetch backlog item attachments |
| `backlogAttachment:add` | invoke | Add attachment to a backlog item (base64 data) |
| `backlogAttachment:remove` | invoke | Delete backlog item attachment |
| `backlogAttachment:getDataUrl` | invoke | Get data URL for display |
| `backlogAttachment:open` | invoke | Open attachment in the system default application |

### Swimlanes (6 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `swimlane:list` | invoke | Fetch all swimlanes |
| `swimlane:create` | invoke | Create swimlane with name, color, icon, role |
| `swimlane:update` | invoke | Update swimlane properties |
| `swimlane:delete` | invoke | Delete swimlane (blocked if has tasks) |
| `swimlane:reorder` | invoke | Reorder swimlanes by ID array |
| `swimlane:updatedByAgent` | on | Push event when an MCP agent updates a swimlane |

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

### Sessions (27 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `session:spawn` | invoke | Spawn PTY session (may queue) |
| `session:kill` | invoke | Kill session |
| `session:suspend` | invoke | Suspend session (preserves for resume) |
| `session:resume` | invoke | Resume suspended session |
| `session:reset` | invoke | Reset unrecoverable session (kill PTY, mark DB exited, clear task reference) |
| `session:write` | invoke | Write to session stdin |
| `session:resize` | invoke | Resize PTY (cols/rows) |
| `session:list` | invoke | Fetch all sessions |
| `session:getScrollback` | invoke | Get terminal scrollback buffer |
| `session:getUsage` | invoke | Fetch session usage (tokens, cost). Optional `projectId` scopes to one project. |
| `session:getActivity` | invoke | Fetch activity state (thinking/idle). Optional `projectId` scopes to one project. |
| `session:getEvents` | invoke | Fetch activity log events for one session |
| `session:getEventsCache` | invoke | Fetch cached event arrays. Optional `projectId` scopes to one project. |
| `session:setFocused` | invoke | Set which sessions are visible in the renderer (optimizes IPC traffic) |
| `session:data` | on | Terminal output available (includes `projectId`) |
| `session:firstOutput` | on | Alternate screen buffer detected - TUI ready (includes `projectId`) |
| `session:exit` | on | Session exited (includes `projectId`) |
| `session:status` | on | Session changed - pushes full `Session` object (includes `projectId`) |
| `session:usage` | on | Usage data updated (includes `projectId`) |
| `session:activity` | on | Activity state changed (includes `projectId`, `taskId`, `taskTitle`) |
| `session:event` | on | Structured event (includes `projectId`) |
| `session:idleTimeout` | on | Session idle timeout fired |
| `session:getSummary` | invoke | Get summary of a single session |
| `session:listSummaries` | invoke | Get summaries of multiple sessions |
| `session:spawnTransient` | invoke | Spawn ephemeral command terminal session (no task, no DB) |
| `session:killTransient` | invoke | Kill a transient session and clean up session directory |
| `session:getPeriodStats` | invoke | Fetch aggregated usage stats (tokens, cost) for a given time period |

### Config (8 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `config:get` | invoke | Fetch effective AppConfig (global merged with project overrides) |
| `config:getGlobal` | invoke | Fetch global-only AppConfig (no project overrides) |
| `config:set` | invoke | Update global config (partial merge) |
| `config:getProject` | invoke | Fetch project-level config overrides |
| `config:setProject` | invoke | Update project-level overrides |
| `config:getProjectByPath` | invoke | Fetch project overrides by filesystem path |
| `config:setProjectByPath` | invoke | Update project overrides by filesystem path |
| `config:syncDefaultToProjects` | invoke | Sync default config values to all project configs |

### Board Config (8 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `boardConfig:exists` | invoke | Check if `kangentic.json` exists for the active project |
| `boardConfig:export` | invoke | Export current board state to `kangentic.json` (auto-runs on project open) |
| `boardConfig:apply` | invoke | Apply pending config file changes (reconcile file into DB) |
| `boardConfig:changed` | on | Event: `kangentic.json` or `kangentic.local.json` changed on disk |
| `boardConfig:getShortcuts` | invoke | Get task detail dialog shortcuts |
| `boardConfig:setShortcuts` | invoke | Update task detail dialog shortcuts |
| `boardConfig:shortcutsChanged` | on | Event: shortcuts file changed |
| `boardConfig:setDefaultBaseBranch` | invoke | Set the team-shared default base branch in `kangentic.json` |

### Notifications (2 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `notification:show` | send | Show native OS notification (task name + project name) |
| `notification:clicked` | on | User clicked a notification (includes projectId, taskId) |

### Agent (2 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `agent:detect` | invoke | Detect agent CLI (path, version) |
| `agent:listCommands` | invoke | List available agent commands and skills |

### Agents (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `agent:list` | invoke | List all detected agent CLIs as `AgentDetectionInfo` (name, displayName, found, path, version) |

### Handoffs (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `handoff:list` | handle | List handoff records for a task |

### Shell (5 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `shell:getAvailable` | invoke | List available shells |
| `shell:getDefault` | invoke | Get default shell |
| `shell:openPath` | invoke | Open directory in file explorer |
| `shell:openExternal` | invoke | Open URL in default browser |
| `shell:exec` | invoke | Execute shell command |

### Git (8 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `git:detect` | invoke | Detect git installation (path, version, minimum version check) |
| `git:listBranches` | invoke | List branches for a repository |
| `git:diffFiles` | invoke | List changed files with status and stats between base branch and HEAD/working tree |
| `git:fileContent` | invoke | Fetch original and modified file content for diff display |
| `git:diffSubscribe` | send | Subscribe to file-system watcher for live diff updates on a worktree |
| `git:diffUnsubscribe` | send | Unsubscribe from diff change watcher for a worktree |
| `git:diffChanged` | on | Debounced event fired when watched worktree files change on disk |
| `git:checkPendingChanges` | invoke | Check whether a path has uncommitted or unpushed changes |

### Dialog (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `dialog:selectFolder` | invoke | OS folder picker |

### Window (5 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `window:minimize` | send | Minimize window |
| `window:maximize` | send | Maximize/restore window |
| `window:close` | send | Close window |
| `window:flashFrame` | send | Flash taskbar icon to attract attention |
| `window:isFocused` | invoke | Check if window has focus (for notification gating) |

### Analytics (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `analytics:trackRendererError` | invoke | Report renderer-side errors to main process |

### App (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `app:getVersion` | invoke | Get Electron app version string |

### Clipboard (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `clipboard:saveImage` | invoke | Save clipboard image data to a temp file, returns file path |

### Updater (3 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `updater:check` | invoke | Check for application updates |
| `updater:install` | invoke | Install downloaded update (quit and install) |
| `updater:downloaded` | on | Event: update has been downloaded and is ready to install |

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

- **swimlanes** -- Kanban columns. Fields: id, name, role (`todo`/`done`/null), position, color, icon, is_archived, permission_mode, auto_spawn, auto_command, plan_exit_target_id, is_ghost, created_at
- **tasks** -- Kanban cards. Fields: id, display_id, title, description, swimlane_id, position, agent, session_id, worktree_path, branch_name, pr_number, pr_url, base_branch, use_worktree, labels, priority, archived_at, created_at, updated_at
- **actions** -- Executable steps. Types: `spawn_agent`, `send_command`, `run_script`, `kill_session`, `create_worktree`, `cleanup_worktree`, `create_pr`, `webhook`. Config stored as JSON.
- **swimlane_transitions** -- Maps lane pairs to action chains. Fields: from_swimlane_id (`*` = any), to_swimlane_id, action_id, execution_order
- **sessions** -- Session persistence for recovery/resume. Fields: id, task_id, session_type, agent_session_id, command, cwd, permission_mode, prompt, status (`running`/`queued`/`suspended`/`exited`/`orphaned`), exit_code, timestamps
- **task_attachments** -- File attachments (images, etc.) stored on disk, metadata in DB
- **backlog_tasks** -- Staging area tasks (Backlog View). Pre-board tasks with priority, labels, and optional external source tracking.
- **backlog_attachments** -- File attachments for backlog tasks, mirroring `task_attachments`. Copied to `task_attachments` on promote.
- **session_transcripts** -- ANSI-stripped PTY output per session. Written by `TranscriptWriter` with 30s debounced flush. Used for cross-agent handoff context. No FK; cascade via DELETE trigger on sessions.
- **handoffs** -- Cross-agent handoff records. Tracks from/to agents and sessions, stores serialized `ContextPacket` (transcript excluded). FK on task_id with CASCADE delete.

Repositories follow a simple pattern -- one class per table, all queries are synchronous (better-sqlite3). Transactions used for position shifts (task move, swimlane reorder).

## Agent Resolution

`src/main/engine/agent-resolver.ts`

`resolveTargetAgent()` determines which agent CLI to use when spawning a session. Resolution priority:

1. **Column `agent_override`** - the target swimlane's per-column agent override (if set)
2. **Project `default_agent`** - the project-level default agent setting
3. **Global fallback** - `'claude'`

This function is used by task-move (to detect cross-agent handoff), session-recovery (to respawn with the correct agent), and agent-spawn (to build the right CLI command).

## Transition Engine

`src/main/engine/transition-engine.ts`

When a task moves between swimlanes, the IPC handler checks priorities in order:

1. **Target is To Do** → Kill session, preserve worktree
2. **Target is Done** → Suspend session (resumable), archive task
3. **Target has auto_spawn=false** → Suspend session
4. **Task has active session** → If target has an `auto_command`, suspend and respawn with the command as the resume prompt. Otherwise keep session alive (permission mode differences alone do not trigger suspend/resume).
5. **Task has no session** → Create worktree (if enabled), execute transition action chain. For resumed sessions, `auto_command` is preloaded as the resume prompt. For fresh spawns, it is injected via CommandInjector.

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
| `create_pr` | Reserved. Not yet implemented. |
| `webhook` | POST to URL with interpolated body |

Template variables available: `{{title}}`, `{{description}}`, `{{taskId}}`, `{{worktreePath}}`, `{{branchName}}`, `{{prUrl}}`, `{{prNumber}}`, `{{attachments}}`.

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
| Graceful shutdown | 2000 ms | `suspendAll()` timeout (exists in code but NOT used during app quit; synchronous shutdown kills PTYs immediately) |
| Idle timeout check | 60000 ms | Polling interval for `checkIdleTimeouts()` |
| Stale thinking threshold | 45000 ms | If no activity signal for 45s while in "thinking" state, emit synthetic idle event |
| Stale thinking check | 15000 ms | How often the stale thinking timer polls |

## Session Queue

`src/main/pty/session-queue.ts`

Limits concurrent PTY sessions (default: 5, configurable via `config.agent.maxConcurrentSessions`).

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
- **HMR store re-sync** -- The `vite:afterUpdate` handler in `App.tsx` re-fetches all IPC-backed stores (project, config, board, session) after Vite HMR replaces modules, preventing stores from reverting to defaults. A unit test (`hmr-resync.test.ts`) enforces that new stores are included. Usage and events are scoped to the current project; activity is fetched unscoped so sidebar badges work across all projects.
- **Project switch cleanup** -- On project switch, `activeSessionId`, `dialogSessionId`, `openTaskId`, `sessionUsage`, and `sessionEvents` are cleared before re-syncing. A generation counter invalidates in-flight syncs from the previous project. `sessionActivity` and `sessions` are preserved for sidebar badge rendering. After sync completes, any `_pendingOpenTaskId` (set by notification click) is applied and cleared.
- **Event capping** -- max 500 events per session to bound DOM size in ActivityLog.
- **Queue position** -- `getQueuePosition()` returns 1-indexed position sorted by startedAt.

### ConfigStore (`config-store.ts`)

State: `config` (AppConfig), `globalConfig`, `appVersion`, `agentInfo`, `agentVersionNumber`, `gitInfo`, `settingsOpen`, `projectOverrides`

- **Theme subscription** -- watches theme changes, updates `<html>` class for CSS variables.
- **App version** -- `loadAppVersion()` fetches the Electron app version via IPC.
- **Agent detection** -- `detectAgent()` finds CLI path and parses version string.
- **Git detection** -- `detectGit()` checks for git installation, version, and minimum version requirement.
- **Project overrides** -- `loadProjectOverrides()`, `updateProjectOverride()`, `removeProjectOverride()` manage per-project config overrides by filesystem path.

### ProjectStore (`project-store.ts`)

State: `projects`, `currentProject`, `loading`

Standard CRUD. `openProject()` triggers main process initialization (DB open, worktree pruning). Session recovery and reconciliation run in the background (fire-and-forget) so the board renders immediately; sessions appear reactively as PTYs come online via IPC status events.

### BacklogStore (`backlog-store.ts`)

State: `items`, `loading`, `selectedIds`

- **CRUD + bulk operations** -- `createItem()`, `updateItem()`, `deleteItem()`, `bulkDelete()`, `reorderItems()`.
- **Optimistic reorder** -- `reorderItems()` reorders locally first, then syncs via IPC. Errors trigger a full `loadBacklog()` reload.
- **Promote/demote** -- `promoteItems()` optimistically removes items from the backlog, calls IPC (which returns after DB work but before agent spawn), then reloads the board. On failure, removed items are restored and a toast error is shown. `demoteTask()` adds the returned backlog item locally and reloads the board.
- **Label management** -- `renameLabel()` and `deleteLabel()` update labels across all items via IPC, then reload both the backlog and the board (since promoted tasks share label data).
- **Selection** -- `toggleSelected()`, `selectAll()`, `clearSelection()` manage a `Set<string>` of selected item IDs for bulk actions.

### ToastStore (`toast-store.ts`)

State: `toasts` (max 5)

Ephemeral notifications with auto-dismiss. Called by other stores for success/error feedback.

## Claude CLI Integration

`src/main/agent/adapters/claude/command-builder.ts`

### Command Building

Constructs the `claude` CLI invocation:

- **New session:** `claude --settings <path> --session-id <uuid> "prompt"`
- **Resume:** `claude --settings <path> --resume <uuid>` (no prompt)

### Permission Mode Flags

| Mode | Flag |
|------|------|
| `default` | `--settings <path>` (uses project-settings) |
| `plan` | `--permission-mode plan` |
| `acceptEdits` | `--permission-mode acceptEdits` |
| `dontAsk` | `--permission-mode dontAsk` |
| `bypassPermissions` | `--dangerously-skip-permissions` |

### Permission Mode Resolution (priority order)

1. Swimlane's `permission_mode` (if set)
2. Global `config.agent.permissionMode`

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
4. **Filter candidates** -- skip To Do/Done, skip auto_spawn=false, skip missing CWD
5. **Resume or respawn** -- suspended sessions use `--resume`, others get fresh `--session-id`
6. **Reconcile** -- spawn fresh agents for tasks in auto_spawn columns with no session

## Performance

- **WebGL xterm** -- attempts WebGL renderer first, falls back to canvas on context loss
- **Resize debouncing** -- PTY resize calls debounced at 200ms, suppressed during panel drag
- **Activity log** -- plain DOM list instead of xterm. Events flow through JSONL files, not terminal output.
- **Terminal ownership handoff** -- one xterm instance per session at a time prevents duplicate resize calls that corrupt TUI output
- **Output batching** -- 16ms flush interval prevents per-character IPC overhead
- **Scrollback cap** -- 512KB prevents unbounded memory growth

## Board Adapters

`src/main/boards/`

Provides external issue import (and future write-back / discovery) for board providers. Mirrors the per-agent adapter layout under `src/main/agent/adapters/`. Each provider lives in its own folder with isolated auth, fetch, and mapping logic; the central registry dispatches by `ExternalSource` id, so IPC handlers contain zero provider-specific branching.

### Layout

```
src/main/boards/
  shared/             # BoardAdapter interface + cross-provider helpers
    types.ts          # interface, Credentials, RemoteIssue, PrerequisiteResult
    auth.ts           # safeStorage credential helpers
    mapping.ts        # extractInlineImageUrls and other mapping helpers
    download-file.ts  # authenticated HTTP downloader with size cap + redirects
    rate-limit.ts     # withBackoff helper for HTTP-based providers
    source-store.ts   # ImportSourceStore + URL parser registry
  adapters/
    github-common/    # shared `gh` CLI client used by both GitHub adapters
    github-issues/    # adapter.ts, url-parser.ts (status: stable)
    github-projects/  # adapter.ts, url-parser.ts (status: stable)
    azure-devops/     # adapter.ts, client.ts, url-parser.ts (status: stable)
    asana/            # adapter.ts, client.ts, mapper.ts, url-parser.ts,
                      # credential-store.ts, ipc-handlers.ts, constants.ts
                      # (status: stable) - Personal Access Token auth;
                      # dedicated boards:asana:* IPC group
    jira/             # stub (status: stub) - tracked in #481
    linear/           # stub (status: stub) - tracked in #482
    trello/           # stub (status: stub) - tracked in #483
  board-registry.ts   # BoardRegistry + boardRegistry singleton
  index.ts            # public exports
```

### Interface

`BoardAdapter` (in `shared/types.ts`) declares:
- Required metadata: `id` (matches `ExternalSource`), `displayName`, `icon`, `status` (`'stable' | 'stub'`).
- Required setup methods: `checkPrerequisites()` (structured CLI + auth check), `checkCli()` (legacy wrapper for back-compat).
- Required import methods: `fetch()`, `downloadImages()`. Optional `downloadFileAttachments()` for providers with explicit attachment relations (Azure DevOps).
- Optional future methods: `authenticate()`, `listProjects()`, `listIssues()`, `pushUpdates()`. Reserved for live discovery and write-back. No provider implements these yet.

Stub adapters (`jira`, `linear`, `trello`) implement the required surface with method bodies that throw `Error('<Provider> adapter is not yet implemented')`. The IPC handler short-circuits stubs by checking `adapter.status === 'stub'` before dispatch, returning a structured error to the renderer.

### Adding a new provider

1. Create `src/main/boards/adapters/<provider>/` with `adapter.ts` (implementing `BoardAdapter`) and `index.ts`.
2. Extend the `ExternalSource` union in `src/shared/types.ts`. Use snake_case to match existing DB rows or plain lowercase for new providers.
3. Register the adapter in `src/main/boards/board-registry.ts`.
4. (Optional) Register a URL parser via `registerSourceUrlParser()` so user-pasted URLs route to the right adapter.

No edits to IPC handlers or the renderer are required - dispatch is registry-driven. The contract is locked in by `tests/unit/board-registry.test.ts`, which fails if a provider is added to the union but not registered.

### IPC channels

Backlog Import group (6 channels): `backlog:importCheckCli`, `backlog:importFetch`, `backlog:importExecute`, `backlog:importSourcesList`, `backlog:importSourcesAdd`, `backlog:importSourcesRemove`. All dispatch through `boardRegistry.getOrThrow(source)` in `src/main/ipc/handlers/backlog.ts`.

Asana ships an additional `boards:asana:*` group (3 channels: `authStatus`, `setPat`, `clearCredential`) for its Personal Access Token lifecycle. Handlers live in `src/main/boards/adapters/asana/ipc-handlers.ts` and are registered by `registerAsanaIpcHandlers()` from the backlog handler. Keeping the surface adapter-local means Asana specifics never leak into the generic backlog handler.

## See Also

- [Session Lifecycle](session-lifecycle.md) -- Full state machine, spawn flow, queue, crash recovery
- [Agent Integration](agent-integration.md) -- Adapter interface, per-agent CLI details, permission modes, hooks, trust
- [Board Integration](board-integration.md) -- BoardAdapter interface, registry, how to add a new provider
- [Transition Engine](transition-engine.md) -- Action types, templates, priority rules
- [Database](database.md) -- Full schema reference, migrations, repository pattern
- [Configuration](configuration.md) -- Config cascade, all settings keys
- [Cross-Platform](cross-platform.md) -- Shell resolution, path handling, packaging
- [Activity Detection](activity-detection.md) -- Event pipeline, thinking/idle state derivation
- [Worktree Strategy](worktree-strategy.md) -- Branch naming, sparse-checkout, hook delivery
