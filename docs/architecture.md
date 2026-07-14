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

### Projects (17 channels)
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
| `project:setDefaultModel` | invoke | Set the default model for a project (or clear to NULL) |
| `project:setDefaultEffort` | invoke | Set the default reasoning effort for a project (or clear to NULL) |
| `project:relocate` | invoke | Relocate a project: `repoint` mode re-points at a folder already moved outside Kangentic (Locate Folder / Change); `move` mode has Kangentic move the folder itself (one-step Move). Both preserve tasks and history, rewrite stored paths, and call the `onProjectRelocated` adapter hook. Returns `ProjectRelocateResult` (`{ project, warnings }`) |
| `project:moveProgress` | on | Event: progress during a one-step project move (`phase`: `moving`/`copying`, `copiedEntries`, `totalEntries`) |
| `project:autoOpened` | on | Event: project auto-opened on launch |
| `project:pathMissing` | on | Event: a registered project path no longer exists on disk |

### Dev-only (preview)
Build-excluded from production via `__KANGENTIC_DEV__` (esbuild dead-code elimination); present only in `npm start` and `/preview` builds, never in shipped installers. Registered from `src/devtools/`, so it is not counted in the production channel totals above.

| Channel | Pattern | Purpose |
|---------|---------|---------|
| `dev:createEphemeralProject` | invoke | Clone the current worktree into an isolated, throwaway preview project (TestHarness "Create Project" button); fills its working tree in the background and returns the usable `Project` |
| `dev:seedGitChanges` | invoke | Seed a realistic all-scopes / all-statuses git changeset (committed, staged, working) into each ephemeral preview repo (active task worktrees plus the project) so the Changes tab has content to exercise; silently skips any path outside the preview-projects root. Returns `DevSeedGitChangesResult` |
| `dev:seedEmbeddingBacklog` | invoke | Seed synthetic pending chunks (`embedded_model = NULL`) into the current project's conversation-memory index via the real chunk-write path, then flag the project dirty (TestHarness "Seed Embedding Backlog" button) - a fast path to a realistic embedding backlog for exercising the central embedding engine's drain loop without needing that many real agent turns. Returns `DevSeedEmbeddingBacklogResult` |
| `dev:seedLargeConversation` | invoke | Seed a throwaway task backed by a synthetic multi-thousand-turn Claude JSONL transcript (TestHarness "Seed Large Conversation" button; appends more turns on re-click) and open it in the Conversation viewer, for exercising the viewer's virtualization, in-viewer search, and open-at-position behavior against a realistic long transcript. Returns `DevSeedLargeConversationResult` |
| `dev:seedUsageData` | invoke | Seed days of realistic synthetic usage (sessions across several agents/models plus per-turn time series) into every registered project's usage ledgers via the real capture repositories, at descending volume per project (TestHarness "Seed Usage Data" button; appends another batch on re-click), so the usage dashboard has rich charts in a preview. Returns `DevSeedUsageDataResult` |

### Project Groups (6 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `projectGroup:list` | invoke | Fetch all project groups (ordered by position) |
| `projectGroup:create` | invoke | Create a new project group |
| `projectGroup:update` | invoke | Rename a project group |
| `projectGroup:delete` | invoke | Delete a group (projects become ungrouped) |
| `projectGroup:reorder` | invoke | Reorder groups by ID array |
| `projectGroup:setCollapsed` | invoke | Toggle group collapsed state |

### Tasks (23 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `task:list` | invoke | Fetch tasks, optionally by swimlane |
| `task:create` | invoke | Create task with title, description, swimlane |
| `task:update` | invoke | Update task properties |
| `task:delete` | invoke | Delete task and clean up session/worktree |
| `task:move` | invoke | Move task between swimlanes (triggers transitions) |
| `task:cancelSpawn` | invoke | Abort an in-flight spawn for a task (e.g. while parked in the git queue or fetching); aborts the move's AbortController and rolls the move back |
| `task:list-archived` | invoke | Fetch archived tasks |
| `task:list-archived-preview` | invoke | Fetch the newest N archived tasks plus the total archived count (cheap hydration payload; the full list loads lazily via `task:list-archived`) |
| `task:unarchive` | invoke | Restore archived task |
| `task:bulk-delete` | invoke | Delete multiple archived tasks by ID array |
| `task:bulk-delete-progress` | on | Event: progress payload during bulk task delete (completed/total/failures) |
| `task:bulk-unarchive` | invoke | Restore multiple archived tasks to a target swimlane |
| `task:switchBranch` | invoke | Switch base branch or enable worktree for a task |
| `task:setRuntimeOverride` | invoke | Set per-task model/effort override; applies live via slash injection, suspend+respawn, or persisted-only depending on session state and adapter capability |
| `task:resolvePr` | invoke | Authoritatively resolve and link the PR for a task's branch via the gh CLI; refreshes `pr_state`, `pr_url`, `pr_number` |
| `task:autoMoved` | on | Event: task was auto-moved by transition engine |
| `task:createdByAgent` | on | Event: task was created by an agent via MCP tool call |
| `task:updatedByAgent` | on | Event: task was updated by an agent via MCP tool call |
| `task:deletedByAgent` | on | Event: task was deleted by an agent via MCP tool call |
| `task:sessionResync` | on | Event: quiet (toast-free) board re-sync after a column model-change session restart, so the board store's stale `task.session_id` reloads |
| `task:spawnProgress` | on | Event: spawn progress phase label during task move |
| `task:getSpawnProgress` | invoke | Fetch the queryable in-flight spawn-progress map (taskId -> phase label) so `syncSessions` can reconcile after HMR / project switch |
| `task:setDetailViewState` | invoke | Persist the task-detail dialog's layout blob (debounced from the renderer) so it restores across restarts. Pass null to clear. Does not bump `updated_at`. |

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

### Sessions (35 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `session:spawn` | invoke | Spawn PTY session (may queue) |
| `session:kill` | invoke | Kill session |
| `session:suspend` | invoke | Suspend session (preserves for resume) |
| `session:resume` | invoke | Resume suspended session |
| `session:reconcile` | invoke | Targeted self-heal probe: returns the live registry session for a task (or null) and clears stale `task.session_id`. Used by the task detail dialog to heal a renderer cache that drifted to `suspended`. |
| `session:reset` | invoke | Reset unrecoverable session (kill PTY, mark DB exited, clear task reference) |
| `session:write` | invoke | Write to session stdin |
| `session:resize` | invoke | Resize PTY (cols/rows) |
| `session:list` | invoke | Fetch all sessions |
| `session:getScrollback` | invoke | Get terminal scrollback buffer |
| `session:getFirstOutput` | invoke | Fetch the first-output cache (sessionId -> true) so `syncSessions` can rebuild `sessionFirstOutput` after an HMR reload |
| `session:getUsage` | invoke | Fetch session usage (tokens, cost). Optional `projectId` scopes to one project. |
| `session:getActivity` | invoke | Fetch activity state (thinking/idle). Optional `projectId` scopes to one project. |
| `session:getActivityReason` | invoke | Fetch the current `ActivityReason` discriminated-union value for one session |
| `session:getActivityReasons` | invoke | Fetch a `Record<sessionId, ActivityReason>` for batch reconcile after HMR / full reload. Optional `projectId` scopes to one project. |
| `session:getActivityStats` | invoke | Fetch a raw engine-counter snapshot for the debug overlay |
| `session:getEvents` | invoke | Fetch activity log events for one session |
| `session:getEventsCache` | invoke | Fetch cached event arrays. Optional `projectId` scopes to one project. |
| `session:setFocused` | invoke | Set which sessions are visible in the renderer (optimizes IPC traffic) |
| `session:notifyUserInterrupt` | invoke | Notify telemetry of a user Ctrl+C; arms the 3-second settle timer that synthesizes Interrupted if hooks don't recover |
| `session:data` | on | Terminal output available (includes `projectId`) |
| `session:drainAck` | send | Renderer-to-main flow-control ack for per-session PTY backpressure; fire-and-forget (no projectId) |
| `session:firstOutput` | on | Alternate screen buffer detected - TUI ready (includes `projectId`) |
| `session:exit` | on | Session exited (includes `projectId`) |
| `session:status` | on | Session changed - pushes full `Session` object (includes `projectId`) |
| `session:usage` | on | Usage data updated (includes `projectId`) |
| `session:activity` | on | Activity state changed (includes `projectId`, `taskId`, `taskTitle`) |
| `session:event` | on | Structured event (includes `projectId`) |
| `session:idleTimeout` | on | Session idle timeout fired |
| `session:getSummary` | invoke | Get summary of a single session |
| `session:listSummaries` | invoke | Get summaries of multiple sessions |
| `session:getToolBreakdown` | invoke | Fetch live per-tool call breakdown for an active session (from the in-memory accumulator, not the DB) |
| `session:spawnTransient` | invoke | Spawn ephemeral command terminal session (no task, no DB) |
| `session:killTransient` | invoke | Kill a transient session and clean up session directory |
| `session:injectSettings` | invoke | Inject a model/effort change into a live transient session's PTY via slash commands. Session-keyed (no task row, no DB persistence); backs the command-terminal context bar picker. |

### Usage Stats (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `usage:getDashboardStats` | invoke | Composite usage-statistics payload for the dashboard (KPIs, bucketed token/cost time series, by-model / by-agent breakdowns), for one project or rolled up across every registered project, over the Live/Today/Week/Month/All Time ranges. Sources from the append-only `usage_history` + `conversation_turn_usage` ledgers so totals survive task deletion, bulk-archive, and revert-to-backlog; also merges in-flight sessions from the live `SessionManager` on top (skipped for a day drill or custom window, which are pure ledger accounting) so the SESSIONS KPI and Live view are not undercounted. Read-only; the explicit scope argument carries the project id. |

### Config (10 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `config:get` | invoke | Fetch effective AppConfig (global merged with project overrides) |
| `config:getGlobal` | invoke | Fetch global-only AppConfig (no project overrides) |
| `config:set` | invoke | Update global config (partial merge) |
| `config:setSync` | sendSync | Update global config synchronously (blocks the renderer until the fs write completes); used on window close to persist the workspace layout before the renderer tears down |
| `config:getProject` | invoke | Fetch project-level config overrides |
| `config:setProject` | invoke | Update project-level overrides |
| `config:getProjectByPath` | invoke | Fetch project overrides by filesystem path |
| `config:setProjectByPath` | invoke | Update project overrides by filesystem path |
| `config:syncDefaultToProjects` | invoke | Sync default config values to all project configs |
| `config:changed` | on | Bare-signal event fanned to every window (main + open pop-outs) after any `config:set` persists; subscribers re-fetch via `config:get` so theme/settings sync live across windows |

### Keybindings (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `keybindings:probeGlobal` | invoke | Probe whether each canonical combo can be claimed as a system-wide global shortcut (via Electron `globalShortcut`); returns `Record<combo, 'available' \| 'taken' \| 'unsupported'>`. Used by the Hotkeys settings tab to warn when a combo is already owned by the OS or another app. |

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

### Mobile Bridge (10 channels)
Machine-global (like Config), not project-scoped - backs the Mobile Devices settings tab. See [Mobile Bridge](mobile-bridge.md) for the pairing ceremony, roster, capability verbs, and relay transport this group fronts.
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `mobile:getStatus` | invoke | Report bridge status: enabled, secure-storage availability, identity fingerprint, relay URL, paired device count, pairing-in-progress |
| `mobile:startPairing` | invoke | Mint a pairing token, connect the pairing relay slot, and return the QR payload URI |
| `mobile:confirmPairing` | invoke | Confirm the SAS matched; signs the phone's static key into the roster with the given display name and capabilities |
| `mobile:cancelPairing` | invoke | Cancel an in-progress pairing ceremony |
| `mobile:listDevices` | invoke | List paired devices (id, display name, capabilities, paired-at) |
| `mobile:revokeDevice` | invoke | Revoke a paired device: drop it from the signed roster and tear down its session |
| `mobile:setDeviceCapabilities` | invoke | Update a paired device's granted capability verbs (re-signs the roster entry) |
| `mobile:pairingSas` | on | Event: the SAS (digits + emoji) to display for the current pairing ceremony |
| `mobile:pairingEnded` | on | Event: pairing cancelled or failed, with a reason |
| `mobile:stateChanged` | on | Event: status or device list changed (confirm/revoke/capability update) |

### Notifications (2 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `notification:show` | send | Show native OS notification (task name + project name) |
| `notification:clicked` | on | User clicked a notification (includes projectId, taskId) |

### Agent (3 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `agent:detect` | invoke | Detect agent CLI (path, version) |
| `agent:listCommands` | invoke | List available agent commands and skills |
| `agent:summarize` | invoke | Summarize a free-form prompt into a short task title via the active project's default agent (or `input.agentName`). Returns `{ ok, title } \| { ok: false, reason }`. Sliding-window rate limit per `AppConfig.autoNameRateLimitPerHour`. |

### Agents (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `agent:list` | invoke | List all detected agent CLIs as `AgentDetectionInfo` (name, displayName, found, path, version, authenticated, permissions, defaultPermission, liveTelemetryUnsupported, reportsRateLimits, pastedImageReferenceTemplate, supportsSummarize) |

### Handoffs (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `handoff:list` | handle | List handoff records for a task |

### Shell (6 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `shell:getAvailable` | invoke | List available shells |
| `shell:getDefault` | invoke | Get default shell |
| `shell:openPath` | invoke | Open directory in file explorer |
| `shell:openExternal` | invoke | Open URL in default browser |
| `shell:showItemInFolder` | invoke | Reveal a file or directory in the native file manager (Explorer on Windows, Finder on macOS); the path is normalized to platform separators before dispatch |
| `shell:exec` | invoke | Execute shell command |

### Git (12 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `git:detect` | invoke | Detect git installation (path, version, minimum version check) |
| `git:listBranches` | invoke | List branches for a repository |
| `git:diffFiles` | invoke | List changed files with status and stats for a scope (working / staged / branch), or for a single commit (`<oid>^..<oid>`) when `commitOid` is set, overriding `scope` |
| `git:fileContent` | invoke | Fetch original and modified file content for diff display (per scope, or for a single commit when `commitOid` is set) |
| `git:diffSubscribe` | send | Subscribe to file-system watcher for live diff updates on a worktree (working tree plus git metadata) |
| `git:diffUnsubscribe` | send | Unsubscribe from diff change watcher for a worktree |
| `git:diffChanged` | on | Debounced event fired when watched worktree files or git metadata change on disk |
| `git:checkPendingChanges` | invoke | Check whether a path has uncommitted or unpushed changes |
| `git:branchSummary` | invoke | Lightweight branch summary for the Changes panel header: current branch, ahead/behind commit counts vs the base branch, and the HEAD tip commit (hash, subject, timestamp). Cheap enough to run on every panel open and watcher fire |
| `git:commitGraph` | invoke | Topo-ordered commit history (commits with parent links plus resolved tip / base / merge-base anchors) for the Changes panel's commit-history browser. Local-only and fail-safe, like `git:branchSummary` |
| `git:fileHistory` | invoke | Commits touching a single file (`git log --follow`), newest first, for the Changes panel's per-file history popover. Local-only and fail-safe |
| `git:blame` | invoke | Per-line blame (`git blame --line-porcelain`) - short hash, author, date per line of the file's current content - for the DiffViewer blame gutter. Local-only and fail-safe |

### Dialog (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `dialog:selectFolder` | invoke | OS folder picker |

### Window (5 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `window:minimize` | send | Minimize the sending window (resolved via `BrowserWindow.fromWebContents(event.sender)`, so this operates on whichever window - main or a pop-out - actually called it) |
| `window:maximize` | send | Maximize/restore the sending window |
| `window:close` | send | Close the sending window |
| `window:flashFrame` | send | Flash the sending window's taskbar icon to attract attention |
| `window:isFocused` | invoke | Check if the sending window has focus (for notification gating) |

### Pop-out Windows (6 channels)
Detach a registered UI surface (usage stats, git changes, the task Browser pane) into its own OS-level `BrowserWindow`. See `src/shared/pop-out.ts` for the surface registry (`PopOutKind`, params, per-surface push fan-out) and `src/main/pop-out/` for the window manager + broadcast helper. Distinct from the in-app DOM window manager (`src/renderer/window-manager/`), which tiles movable panes inside the single main `BrowserWindow`.
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `popOut:open` | invoke | Open a surface's pop-out window (kind + params), or focus it if already open |
| `popOut:close` | invoke | Close a surface's pop-out window |
| `popOut:focus` | invoke | Focus (and restore if minimized) a surface's pop-out window |
| `popOut:isOpen` | invoke | Whether a surface's pop-out window is currently open |
| `popOut:listOpen` | invoke | List the instance keys of every currently-open pop-out window |
| `popOut:changed` | on | Event: the set of open pop-out windows changed; pushed to the main window only, mirrored into `pop-out-store.ts` so in-app triggers (title bar, headers) flip between "open" and "focus" |

### Analytics (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `analytics:trackRendererError` | invoke | Report renderer-side errors to main process |

### App (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `app:getVersion` | invoke | Get Electron app version string |

### Clipboard (2 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `clipboard:readImage` | invoke | Read the native clipboard image, save it to a temp file, returns file path or null |
| `clipboard:writeText` | invoke | Write text to the native clipboard (focus-independent; used by terminal copy and the OSC 52 handler) |

### Browser pane (8 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `browser:captureSend` | invoke | Composite the embedded webview frame + draw overlay + picked element into a PNG, write it to the session captures dir, and submit a structured prompt to the agent's PTY via PasteEngine |
| `browser:urlGet` | invoke | Get the project default URL and per-task URL override for a given task |
| `browser:urlSetTask` | invoke | Persist a per-task URL override |
| `browser:urlClearTask` | invoke | Remove the per-task URL override (falls back to project default) |
| `browser:clearStorage` | invoke | Wipe cookies, localStorage, IndexedDB, service workers, and HTTP/auth caches across the per-worktree embedded browser partitions (and the legacy shared jar). Saved URLs are kept. |
| `browser:zoomChanged` | push | Broadcast the new zoom factor after Ctrl+wheel is applied in the main process (the webview's `zoom-changed` event lives on WebContents, not the DOM tag, so the renderer learns about wheel zoom only via this push) |
| `browser:paneRegister` | invoke | Register an open Browser pane's guest webContents (taskId, sessionId, webContentsId, url) with the main-process pane registry so the `kangentic_browser_*` MCP tools can target it |
| `browser:paneUnregister` | invoke | Unregister a Browser pane on unmount, scoped to the webContentsId that instance registered with (compare-and-delete) so an out-of-order unmount between the in-app pane and its pop-out cannot clobber a newer registration; the guest's own `destroyed` event is the backstop |

### Updater (3 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `updater:check` | invoke | Check for application updates |
| `updater:install` | invoke | Install downloaded update (quit and install) |
| `updater:downloaded` | on | Event: update has been downloaded and is ready to install |

### Search (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `search:everything` | invoke | Unified search across tasks, backlog items, session events (`events.jsonl`), and registered projects. Powers the global search palette (Ctrl+Shift+F / Ctrl+F). |

### Transcript (2 channels)
Read-only structured-transcript access for the conversation viewer. Prefer the explicit `projectId`, falling back to the ambient current project.
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `transcript:get` | invoke | Return the structured (tool_use / tool_result) transcript for a session. Powers the conversation viewer. |
| `transcript:listSessions` | invoke | List the sessions that have a readable transcript, for the viewer's session picker. |

### Memory (2 channels)
Conversation-memory semantic layer (Smart-mode search). See the Memory settings tab.
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `memory:status` | invoke | Report the conversation-memory index status for the Smart-mode palette UI. |
| `memory:rebuildIndex` | invoke | Purge the current project's conversation index and re-run the backfill sweep (recovery from a corrupt/stale index; Memory settings "Rebuild index"). |

### Diagnostics (2 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `diagnostics:logAppend` | invoke | Renderer / preload forwards a `LogEntry` to the main process. The main-side log mirror persists `error` and `warn` levels unconditionally and `info` / `debug` / `log` when `developer.persistConsoleLogs` is on. NDJSON written to `<projectRoot>/.kangentic/logs/<YYYY-MM-DD>.log`. |
| `diagnostics:crashReport` | invoke | Renderer forwards a `CrashRecord` (window.onerror, unhandledrejection) to the main process. Crash capture writes one JSON file per record to `<projectRoot>/.kangentic/logs/crashes/<ts>.json`. Always-on - no toggle. |

### Dictation (14 channels)
By-session-id, not task-scoped (no `projectId`), in the same category as `session:write`.
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `transcribe:start` | invoke | Begin a dictation session; resolves the engine + model from config + hardware. Returns `{ dictationSessionId, engineId, modelId, needsDownload }` |
| `transcribe:stop` | invoke | Finalize and return the committed text. Passes the renderer's sent-frame count so the decode drains all in-flight audio first (the tail is never clipped) |
| `transcribe:cancel` | invoke | Abort a session without committing |
| `transcribe:commit` | invoke | Inject finalized text into the focused terminal WITHOUT submitting (no Enter) |
| `transcribe:submit` | invoke | Auto-submit: erase the live preview, then paste + submit the refined text via the paste engine (settle -> separate Enter -> submission evidence with retry) |
| `transcribe:getInfo` | invoke | Hardware profile + engines + installed models + per-slot model lists (settings panel) |
| `transcribe:partial` | on | Push: live revising hypothesis to the renderer |
| `transcribe:final` | on | Push: finalized text to the renderer |
| `transcribe:audioChunk` | on | Stream one PCM frame into the funnel (fire-and-forget, no round-trip) |
| `transcribe:requestMic` | invoke | Ensure microphone access (macOS TCC prompt on first use) |
| `transcribe:modelProgress` | on | Push: first-use model download progress |
| `transcribe:downloadModel` | invoke | Pre-download the selected model from settings |
| `transcribe:liveWrite` | on | Live experience: write raw bytes (text + backspaces) straight into the focused terminal as the user speaks (fire-and-forget) |
| `transcribe:prewarm` | on | Pre-load the selected engine so the next press is instant; `null` releases the warm engines (fire-and-forget) |

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
- **project_groups** -- sidebar grouping for projects. Fields: id, name, position, collapsed

### Per-Project DB (`<configDir>/projects/<projectId>.db`)

Created on project open. Stored in the global config directory (not inside the project). Tables:

- **swimlanes** -- Kanban columns. Fields: id, name, role (`todo`/`done`/null), position, color, icon, is_archived, permission_mode, auto_spawn, auto_command, agent_override, model_override, effort_override, handoff_context, plan_exit_target_id, session_target, session_spawn_strategy, is_ghost, created_at
- **tasks** -- Kanban cards. Fields: id, display_id, title, description, swimlane_id, position, agent, agent_override, model_override, effort_override, session_id, worktree_path, branch_name, pr_number, pr_url, pr_state, head_sha, base_branch, use_worktree, labels, priority, external_id, external_source, external_url, detail_view_state, archived_at, created_at, updated_at
- **actions** -- Executable steps. Types: `spawn_agent`, `send_command`, `run_script`, `kill_session`, `create_worktree`, `cleanup_worktree`, `create_pr`, `webhook`. Config stored as JSON.
- **swimlane_transitions** -- Maps lane pairs to action chains. Fields: from_swimlane_id (`*` = any), to_swimlane_id, action_id, execution_order
- **sessions** -- Session persistence for recovery/resume. Fields: id, task_id, session_type, agent_session_id, command, cwd, permission_mode, prompt, status (`running`/`queued`/`suspended`/`exited`/`orphaned`), exit_code, timestamps
- **task_attachments** -- File attachments (images, etc.) stored on disk, metadata in DB
- **backlog_tasks** -- Staging area tasks (Backlog View). Pre-board tasks with priority, labels, and optional external source tracking.
- **backlog_attachments** -- File attachments for backlog tasks, mirroring `task_attachments`. Copied to `task_attachments` on promote.
- **session_transcripts** -- ANSI-stripped PTY output per session. Written by `TranscriptWriter` with a 30s debounced flush (early-flushed at 256KB pending). Used for cross-agent handoff context. No FK; cascade via DELETE trigger on sessions.
- **handoffs** -- Cross-agent handoff records. Tracks from/to agents and sessions, stores serialized `ContextPacket` (transcript excluded). FK on task_id with CASCADE delete.
- **usage_history** -- Append-only ledger of finalized session usage (cost, tokens, duration, tool count, git stats, model, agent). No FK to `tasks` or `sessions`, so rows survive task deletion, bulk-archive cleanup, and revert-to-backlog. Backs the usage dashboard's period totals, cost-per-day series, and by-model / by-agent breakdowns (Live/Today/Week/Month/All Time) via `usage:getDashboardStats` and the `kangentic_get_usage_stats` MCP tool. Written by `captureSessionMetrics` (UPSERT on `session_record_id`) and `captureGitChurn` (`src/main/ipc/handlers/git-stats-capture.ts`, fired on every session finalization - suspend, move, handoff, respawn, natural exit - not just move-to-Done; writes to exactly one record per task lineage via `setTaskGitStats` to avoid double-counting branch-cumulative churn across `--resume` records). The dashboard's SESSIONS KPI and Live view additionally merge in-flight sessions from the live `SessionManager` (deduped by `session_record_id` against the ledger) so running sessions are not undercounted before they finalize.

Repositories follow a simple pattern -- one class per table, all queries are synchronous (better-sqlite3). Transactions used for position shifts (task move, swimlane reorder).

## Agent Resolution

`src/main/transition-engine/agent-resolver.ts`

`resolveTargetAgent()` determines which agent CLI to use when spawning a session. Resolution priority:

1. **Task `agent_override`** - per-task override set at creation time (highest priority)
2. **Column `agent_override`** - the target swimlane's per-column agent override (if set)
3. **Project `default_agent`** - the project-level default agent setting
4. **Global fallback** - `'claude'`

This function is used by task-move (to detect cross-agent handoff), session-recovery (to respawn with the correct agent), and agent-spawn (to build the right CLI command).

## Transition Engine

`src/main/transition-engine/transition-engine.ts`

When a task moves between swimlanes, the IPC handler checks priorities in order:

1. **Target is To Do** → Kill session, preserve worktree
2. **Target is Done** → Suspend session (resumable), archive task
3. **Target has auto_spawn=false** → Suspend session
4. **Task has active session** → A permission-mode delta (destination's effective mode differs from the session record's spawn-time mode) suspends and respawns so the new `--permission-mode` / `--model` / `--effort` land as CLI flags. Otherwise live-inject model/effort/auto_command when the adapter supports it, respawn on a concrete model/effort delta without live-swap, or keep the session alive. See [Transition Engine](transition-engine.md) Priority 3 for the full sub-case order.
5. **Task has no session** → Create worktree (if enabled), execute transition action chain. For resumed sessions, `auto_command` is preloaded as the resume prompt. For fresh spawns, it is injected via `TerminalSubmitScheduler.scheduleKeystrokes`.

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

Template variables available: `{{title}}`, `{{description}}`, `{{task_xml}}`, `{{taskId}}`, `{{worktreePath}}`, `{{branchName}}`, `{{baseBranch}}`, `{{prUrl}}`, `{{prNumber}}`, `{{attachments}}`.

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

Platform-specific detection order in `src/main/pty/spawn/shell-resolver.ts`:

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
| Repaint-settle max wait | 400 ms | Ceiling for the post-resize repaint wait before sampling scrollback |
| Status debounce | 100 ms | Usage file watch |
| Event debounce | 50 ms | Event log + activity state watch |
| Graceful shutdown | 2000 ms | `suspendAll()` timeout (exists in code but NOT used during app quit; synchronous shutdown kills PTYs immediately) |
| Idle timeout check | 60000 ms | Polling interval for `checkIdleTimeouts()` |

Stale-thinking detection is no longer a `SessionManager` constant. It now lives in the activity engine watchdog (`src/main/activity-engine/engine/`), which emits a synthetic idle transition after `DEFAULT_STALE_THINKING_TIMEOUT_MS` (180000 ms) of no activity signal while in the "thinking" state. The engine is event-driven, so there is no separate polling timer. See [Activity Detection](activity-detection.md).

## Session Queue

`src/main/pty/session-queue.ts`

Limits concurrent PTY sessions (default: 5, configurable via `config.agent.maxConcurrentSessions`).

When a session is requested and the limit is reached, it gets a `queued` status placeholder. When a running session exits or suspends, `notifySlotFreed()` promotes the next queued entry.

Uses a reentrancy-safe double-check loop: a `_processing` flag prevents concurrent promotion, and a `_dirty` flag ensures re-iteration if the queue changed during a spawn await.

## Zustand Stores

All stores in `src/renderer/stores/`. They call `window.electronAPI.*` for IPC and manage local UI state.

### BoardStore (`board-store.ts`)

State: `tasks`, `swimlanes`, `archivedTasks`, `loading`, `completingTask`, `completingTaskIds`, `completionGates`, `recentlyArchivedId`

- **Optimistic updates** -- all mutations update UI immediately, then sync via IPC. Errors revert via full `loadBoard()`.
- **Stale move protection** -- `moveGeneration` counter prevents older async reloads from clobbering newer moves.
- **Session cascade** -- after task move, reloads sessions to detect spawns/kills from transition engine. Auto-activates new sessions with toast notification.
- **Completion animation** -- `setCompletingTask()` mounts the FlyingCard with the captured drop rect; a per-task completion gate joins the fly finishing (`markCompletionAnimationDone`) and the move being approved (`approveCompletion`, after a clean worktree probe or a confirmed dialog), and `persistCompletion` runs the actual move once both signals land.

### SessionStore (`session-store.ts`)

State: `sessions`, `activeSessionId`, `openTaskId`, `dialogSessionIds`, `sessionUsage`, `sessionActivity`, `sessionEvents`

- **Terminal ownership handoff** -- `dialogSessionIds` (a string array) lists every session owned by an open task-detail window, so the bottom panel never renders an xterm for a session a window already owns (one xterm per PTY). It replaced the scalar `dialogSessionId` once task detail became modeless and multiple windows can stack. When a window claims a session, the panel unmounts that session's xterm; on release, the panel recreates from scrollback.
- **HMR store re-sync** -- The `vite:afterUpdate` handler in `App.tsx` re-fetches all IPC-backed stores (project, config, board, session) after Vite HMR replaces modules, preventing stores from reverting to defaults. A unit test (`hmr-resync.test.ts`) enforces that new stores are included. Usage and events are scoped to the current project; activity is fetched unscoped so sidebar badges work across all projects.
- **Project switch cleanup** -- On project switch, `activeSessionId`, `dialogSessionIds`, `openTaskId`, `sessionUsage`, and `sessionEvents` are cleared before re-syncing. A generation counter invalidates in-flight syncs from the previous project. `sessionActivity` and `sessions` are preserved for sidebar badge rendering. After sync completes, any `_pendingOpenTaskId` (set by notification click) is applied and cleared.
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
| `auto` | `--permission-mode auto` |
| `bypassPermissions` | `--dangerously-skip-permissions` |

### Permission Mode Resolution (priority order)

See [Permission Mode Resolution](configuration.md#permission-mode-resolution-priority-order) in configuration.md.

### Settings Merge

For each session, a merged settings file is created at `.kangentic/sessions/<sessionId>/settings.json`:

1. Read `.claude/settings.json` (committed project settings)
2. Read `.claude/settings.local.json` (gitignored local settings)
3. Deep-merge hooks from both
4. Inject Kangentic bridge commands into hook points
5. When the MCP server is attached, append `mcp__kangentic` to `permissions.allow` (append-if-absent) so kangentic's own tools never prompt in default mode
6. Write merged file, pass to CLI via `--settings`

## Session Recovery

On project open (`src/main/transition-engine/session-startup/`):

1. **Prune orphaned worktrees** -- delete tasks whose worktree directories were removed externally
2. **Mark crash recovery** -- leftover `running` DB records become `orphaned`
3. **Deduplicate** -- keep only the latest record per task_id
4. **Filter candidates** -- skip To Do/Done, skip auto_spawn=false, skip missing CWD
5. **Resume or respawn** -- suspended sessions use `--resume`, others get fresh `--session-id`
6. **Reconcile** -- spawn fresh agents for tasks in auto_spawn columns with no session

## Performance

- **WebGL xterm with an attachment budget** - attempts the WebGL renderer first and recovers from context loss (2s/10s retries, then permanent DOM fallback). Live WebGL attachments are capped at `WEBGL_ATTACH_BUDGET` (8) page-wide, below Chromium's ~16-context limit: a coordinator (`useFocusedSessionsSync`) keeps the most-recently-focused terminal windows on WebGL and temporarily suspends the rest to the DOM renderer (`suspendedByBudget` in the renderer report - not a context loss, never escalates to the permanent fallback), re-attaching on focus (`src/renderer/utils/terminal-webgl.ts`, `terminal-visibility.ts`)
- **Parked-window write gating** - a terminal window that is off-view (board layer parked on the Backlog view, or occluded by a maximized same-layer window) leaves the focused-session set, so main stops emitting its PTY data at the source; any stragglers are acked-and-dropped by the renderer queue (never parsed, never wedging backpressure). On reveal the terminal repaints from the scrollback ring via `reloadScrollback` (`src/renderer/utils/parked-terminals.ts`, `focused-sessions.ts`)
- **Resize debouncing** -- PTY resize calls debounced at 200ms, suppressed during panel drag
- **Repaint-settled scrollback** - after a width-changing resize, `getScrollback` waits for the agent TUI's async repaint to land before sampling, so a restored terminal never replays a stale narrow frame; while the agent is actively streaming (never quiesces) the wait settles early on the post-resize repaint marker instead of burning the max-wait ceiling (see [session-lifecycle](session-lifecycle.md))
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

## Mobile Bridge

`src/main/mobile-bridge/`

Desktop half of the mobile companion app's secure pairing/transport link, consuming the shared `@kangentic/protocol` package (`packages/protocol/`). Owns the device identity, signed device roster, QR pairing ceremony, capability-verb router, and the outbound relay transport client. Constructed in `src/main/ipc/register-all.ts`, torn down synchronously in `src/main/index.ts`'s `clearPendingTimers`. Machine-global (not project-scoped), backing the Mobile Devices settings tab via the `mobile:*` IPC group above.

Phase 1 (shipped) covers identity/roster/pairing/transport and the deny-by-default capability router. Phase 2 (shipped) wires all 9 capability-verb handlers to their live main-process data feeds (SessionManager's unfiltered output tap, the transcript service, repositories, `DiffService`, the activity engine's permission-prompt state) and the board/task MCP surface; notifications and a direct P2P transport upgrade are later phases. See [Mobile Bridge](mobile-bridge.md) for the full pairing ceremony, SAS confirmation, roster revocation model, capability verb list, data feeds, ongoing-session crypto, relay transport contract, and phase scope.

## See Also

- [Session Lifecycle](session-lifecycle.md) -- Full state machine, spawn flow, queue, crash recovery
- [Agent Integration](agent-integration.md) -- Adapter interface, per-agent CLI details, permission modes, hooks, trust
- [Board Integration](board-integration.md) -- BoardAdapter interface, registry, how to add a new provider
- [Mobile Bridge](mobile-bridge.md) - Pairing ceremony, signed device roster, capability verbs, relay transport
- [Transition Engine](transition-engine.md) -- Action types, templates, priority rules
- [Database](database.md) -- Full schema reference, migrations, repository pattern
- [Configuration](configuration.md) -- Config cascade, all settings keys
- [Cross-Platform](cross-platform.md) -- Shell resolution, path handling, packaging
- [Activity Detection](activity-detection.md) -- Event pipeline, thinking/idle state derivation
- [Worktree Strategy](worktree-strategy.md) -- Branch naming, sparse-checkout, hook delivery
