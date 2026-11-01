---
type: Reference
title: Board IPC channels
description: Every project, project group, task, attachment, backlog, backlog import, workflow, swimlane, automation and board-config IPC channel with its pattern and purpose, including the quiet board-reload pushes (task:movedByAutomation, task:prLinkChanged), spawn-blocked events and Asana auth.
tags: [ipc, channels, board, tasks]
sources:
  - resource: src/shared/ipc-channels.ts
    title: IPC channel constants
  - resource: src/main/ipc/helpers/task-delete.ts
    title: The task delete TASK_DELETE and a workflow delete share
---
# Board IPC channels

## Projects (20 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `project:list` | invoke | Fetch all projects (ordered by position) |
| `project:create` | invoke | Create new project (inserted at position 0) |
| `project:delete` | invoke | Delete project, close its task windows, reap its tasks' leftover processes, and clean up resources |
| `project:open` | invoke | Open project (init DB, recover sessions) |
| `project:getCurrent` | invoke | Get currently loaded project |
| `project:openByPath` | invoke | Open project by filesystem path |
| `project:probePath` | invoke | Inspect a folder before adding it (exists, is a directory, git state, suggested name, already-registered project id) |
| `project:ensureGit` | invoke | Make sure a folder is covered by git, running `git init` when it is not |
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
| `project:listChanged` | on | Event: the project list changed server-side (a stale project pruned, or a recovered global DB); tells the renderer to refetch `project:list` and `project:getCurrent` |

## Project Groups (6 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `projectGroup:list` | invoke | Fetch all project groups (ordered by position) |
| `projectGroup:create` | invoke | Create a new project group |
| `projectGroup:update` | invoke | Rename a project group |
| `projectGroup:delete` | invoke | Delete a group (projects become ungrouped) |
| `projectGroup:reorder` | invoke | Reorder groups by ID array |
| `projectGroup:setCollapsed` | invoke | Toggle group collapsed state |

## Tasks (34 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `task:list` | invoke | Fetch tasks, optionally by swimlane |
| `task:create` | invoke | Create task with title, description, swimlane |
| `task:update` | invoke | Update task properties |
| `task:delete` | invoke | Delete task and clean up session/worktree (`deleteTaskWithCleanup`, which a workflow delete also runs for its tasks that never started) |
| `task:move` | invoke | Move task between swimlanes (triggers transitions) |
| `task:list-archived` | invoke | Fetch archived tasks |
| `task:list-archived-preview` | invoke | Fetch the newest N archived tasks plus the total archived count (cheap hydration payload; the full list loads lazily via `task:list-archived`) |
| `task:unarchive` | invoke | Restore archived task, last in the target column, or at an optional `position` inside it (the board passes the slot a card dragged out of Done opened) |
| `task:bulk-delete` | invoke | Delete multiple archived tasks by ID array |
| `task:bulk-delete-progress` | on | Event: progress payload during bulk task delete (completed/total/failures) |
| `task:bulk-unarchive` | invoke | Restore multiple archived tasks to a target swimlane |
| `task:switchBranch` | invoke | Switch base branch or enable worktree for a task |
| `task:updateFromBase` | invoke | One-click "Update from base": fetch the task's effective base and fast-forward its worktree from `origin/<base>`. Refuses while a session is running; returns a discriminated `TaskUpdateFromBaseResult` (updated / already-up-to-date / cannot-ff / dirty-tree / fetch-failed / no-remote) rather than throwing for expected outcomes |
| `task:setRuntimeOverride` | invoke | Set per-task model/effort override; restarts a live session (suspend + `--resume` with the new flags) on a change to a concrete value, otherwise persists it for the next spawn (or because the session already runs at the pick) |
| `task:resolvePr` | invoke | Authoritatively resolve and link a task's PR through the repository's PR connector (GitHub via `gh`, Azure DevOps via `az`), walking the confidence ladder in [PR linking](../../integrations/pull-requests/pr-linking.md#the-confidence-ladder) (number, worktree branch, commit, stored branch, pushed branch, remote tip); refreshes `pr_state`, `pr_merge_readiness`, `pr_url`, `pr_number`. Returns `no-anchor` only when the task has nothing to search by |
| `task:autoMoved` | on | Event: task was auto-moved by transition engine. Sent once, when the move settles, with its toast. The move's commit point sends the quiet `task:sessionResync` instead |
| `task:createdByAgent` | on | Event: task was created by an agent via MCP tool call |
| `task:updatedByAgent` | on | Event: task was updated by an agent via MCP tool call. An agent's move sends it once, when the move settles, with its toast. The move's commit point sends the quiet `task:sessionResync` instead |
| `task:deletedByAgent` | on | Event: task was deleted by an agent via MCP tool call |
| `task:sessionResync` | on | Event: quiet (toast-free) board re-sync after a session restart or respawn that cleared `task.session_id`, so the board store's stale `task.session_id` reloads. A move with origin `agent` or `auto-move` sends it at the move's commit point too, so the card leaves its column before a Done move's suspend, reap and worktree removal. That move's toasting push (`task:updatedByAgent`, `task:autoMoved`) waits for the move to settle and fires once |
| `task:prLinkChanged` | on | Event: quiet (toast-free) board re-sync after the APP reconciled a task's PR link or state - the refresh sweep, the session-idle auto-link, the `pr-candidate` resolve after an agent's PR command, the forced re-resolve that follows a link write, the task-detail "Link / refresh PR" control, or a move to To Do that dropped the task's PR link. Distinct from `task:updatedByAgent` because no agent made the change: an agent's own `update_task` / `link_pr` still goes out on that channel and still toasts. Payload is the bare `projectId` |
| `task:movedByMobile` | on | Event: quiet (toast-free) board reload after a task was moved from the paired mobile app. A third provenance, distinct from both siblings above: `task:updatedByAgent` would announce "Task updated by agent" for a card the user dragged on their own phone, and this is not the app reconciling itself either. Sent at the move's commit point and again when it settles. Payload is the bare `projectId` |
| `task:movedByAutomation` | on | Event: quiet (toast-free) board reload after Kangentic moved a task on its own, as a Move to column automation does at a turn end (move origins `automation` and `workflow`). The run log records why, so nothing toasts. Sent at the move's commit point and again when it settles, so the card moves before a Done move's cleanup finishes. Renderer subscribes via `onMovedByAutomation`. Payload is the bare `projectId` |
| `task:changedInOtherWindow` | on | Event: quiet (toast-free) board reload after the user changed a task from a window other than the main one: the detached Agent Monitor's row menu or a task detail it hosts. That window has its own stores, so main sends this to the main window once each renderer task mutation (and `backlog:demote`) whose sender is not the main window settles, whether it succeeded or not. A `task:move` sends it at the move's commit point too, so the board is current before a Done move's worktree removal. `task:setDetailViewState` is the one task mutation left out, since the board never shows the layout it saves; the main window reloads its board and backlog for the open project or invalidates the named project's warm cache. The in-app monitor, the Workflows canvas menu and the board card's session row send nothing, since main cannot tell their writes from the board's; each resyncs the board itself (`resyncBoardAfterMonitorWrite`) when its write settles, and the in-app monitor resyncs it again as it closes. Renderer subscribes via `onChangedInOtherWindow`. Payload is the bare `projectId` |
| `workflow:completed` | on | Event: every task in a workflow reached Done (`WorkflowCompletedEvent`: id, title, task count, home project). The renderer raises the Workflow Complete toast and desktop notification, each behind its `notifications.*.onWorkflowComplete` switch. Renderer subscribes via `tasks.onWorkflowCompleted` |
| `workflow:stalled` | on | Event: a running workflow stalled on a task (`WorkflowStalledEvent`: workflow id, the task's project and id, its title, why). The renderer raises the Workflow Stalled toast behind `notifications.toasts.onWorkflowStalled`, for the project on screen; main raises the desktop notification itself, so it reaches a user with no window. Renderer subscribes via `tasks.onWorkflowStalled` |
| `task:spawnBlocked` | on | Event: the task's agent could not start. Fires for three steps, and the entry points differ per step. WORKTREE and CHECKOUT: only on create, promote, unarchive, MCP auto-spawn, or the phone's `start-session`, which deliberately keep the task (a move instead rejects the invoke, which the renderer already toasts). A phone Start reaches them through `autoSpawnForTask`; a phone Resume of a paused task reports its worktree and agent steps through `resumeTaskSession`'s `onFailed` hook, because the phone was answered at acceptance and no rejection reaches a toast (the desktop Resume button still rejects instead). Any git failure at those two steps fires this, not only the case where another task holds the checkout. AGENT (the spawn itself, most often a CLI that is not installed or not on PATH): every board-driven entry point including a drag move, because `spawnAgent`'s catch swallows that error and resolves the invoke, so this event is the only user-visible notice on that path. Without it the result is indistinguishable from a healthy spawn |
| `task:spawnWarning` | on | Event: non-blocking spawn anomaly - the agent still started. The trailing `kind` argument (`SpawnWarningKind`) is `base-not-refreshed` (its base branch could not be freshened, a network or credential fetch failure, so it may run from a stale base) or `setup-script-failed` (a Post-Worktree Script failed after the agent started, with `git.holdPromptForInitScript` off; see [Worktree creation](../worktrees/worktree-creation.md#the-agent-starts-while-the-script-runs)). The message is composed in main and toasted verbatim, cooldown-guarded per project and reason class so a bulk unarchive while offline produces one toast, not one per task |
| `task:autoCommandResult` | on | Event: the outcome of a task's auto_command injection (`AutoCommandResultNotice`: state, command, reason, discardedDraft, interruptedTurn, escalated). Rationed by `shouldNotify` so a routine delivery stays silent and only a failure, an escalation, or a discarded draft reaches the user |
| `task:conversationExpired` | on | Event: a resume found the agent had deleted the task's conversation, so the spawn started a new one from a recap (`ConversationExpiredNotice`: projectId, taskId, taskTitle, lastActiveAt). Sent once the new session exists, from the board spawn and from startup recovery alike, after main queues the notice. A signal: for the current project the renderer takes the queue with `task:takeConversationExpired` and toasts what it returns. Renderer subscribes via `tasks.onConversationExpired` |
| `task:takeConversationExpired` | invoke | Returns and removes a project's queued `ConversationExpiredNotice`s, oldest first (`projectId`), leaving out any whose task was deleted or archived while it waited. Called on the push above and whenever a project becomes current, which is what delivers a startup notice the push could not. Each notice toasts on its own as one sentence with the task's title and date ("its previous one" when the date is unknown). Renderer calls `tasks.takeConversationExpired` |
| `task:spawnProgress` | on | Event: spawn progress phase label during any board-driven spawn (move, create into a spawning column, backlog promote, MCP auto-spawn, restore from Done). A staleness note may trail the label, e.g. `Starting agent... (base 3 behind)` |
| `task:getSpawnProgress` | invoke | Fetch the queryable in-flight spawn-progress map (taskId -> phase label) so `syncSessions` can reconcile after HMR / project switch |
| `task:setDetailViewState` | invoke | Persist the task-detail dialog's layout blob (debounced from the renderer) so it restores across restarts. Pass null to clear. Does not bump `updated_at`. Opens only an existing project database, so a save that arrives after a project delete is dropped instead of recreating the deleted project's database. |

## Attachments (5 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `attachment:list` | invoke | Fetch task attachments |
| `attachment:add` | invoke | Add attachment (base64 data) |
| `attachment:remove` | invoke | Delete attachment |
| `attachment:getDataUrl` | invoke | Get data URL for display |
| `attachment:open` | invoke | Open attachment in the system default application. Resolves to `''` on success or an error string the renderer surfaces as a toast; races a timeout so the invoke is always answered, and reveals the file in the file manager when no default app handles it |

## Backlog (13 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `backlog:list` | invoke | Fetch all backlog items (ordered by position) |
| `backlog:create` | invoke | Create a new backlog item |
| `backlog:update` | invoke | Update a backlog item |
| `backlog:delete` | invoke | Delete a backlog item |
| `backlog:reorder` | invoke | Reorder backlog items by ID array |
| `backlog:bulk-delete` | invoke | Delete multiple backlog items by ID array |
| `backlog:promote` | invoke | Promote backlog items to board tasks (move to a swimlane) |
| `backlog:demote` | invoke | Demote a board task back to the backlog. Takes a trailing `projectId` (the task's project, which the Agent Monitor names for a task of a project the board is not on) |
| `backlog:renameLabel` | invoke | Rename a label across all backlog items |
| `backlog:deleteLabel` | invoke | Remove a label from all backlog items |
| `backlog:remapPriorities` | invoke | Remap priority values across all backlog items |
| `backlog:changedByAgent` | on | Event: backlog was modified by an agent via MCP tool call |
| `backlog:labelColorsChanged` | on | Event: label color mappings changed by agent via MCP tool call |

## Backlog Import (7 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `backlog:importCheckCli` | invoke | Check if the CLI tool for a source is available and authenticated |
| `backlog:importGetCached` | invoke | Read the persistent remote-item cache for a source (no network), for an instant dialog paint |
| `backlog:importReconcile` | invoke | Fetch items changed since the cache high-water mark, merge and prune, and return the merged set |
| `backlog:importExecute` | invoke | Import selected items into the backlog, hydrating deferred per-item detail (e.g. Azure DevOps comments) and downloading attachments |
| `backlog:importSourcesList` | invoke | List saved import sources for the current project |
| `backlog:importSourcesAdd` | invoke | Add a new import source (persisted in project config). Providers with an optional `resolveLabel` hook (e.g. Asana) enrich the stored label with a human-readable name. |
| `backlog:importSourcesRemove` | invoke | Remove a saved import source |

## Board Auth - Asana (3 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `boards:asana:authStatus` | invoke | Report Asana connection state: `{connected, email?}` |
| `boards:asana:setPat` | invoke | Validate a Personal Access Token via `/users/me` and persist it encrypted; returns `{ok, email?, error?}` |
| `boards:asana:clearCredential` | invoke | Remove the stored Personal Access Token |

## Backlog Attachments (5 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `backlogAttachment:list` | invoke | Fetch backlog item attachments |
| `backlogAttachment:add` | invoke | Add attachment to a backlog item (base64 data) |
| `backlogAttachment:remove` | invoke | Delete backlog item attachment |
| `backlogAttachment:getDataUrl` | invoke | Get data URL for display |
| `backlogAttachment:open` | invoke | Open attachment in the system default application. Same answer-or-timeout contract and file-manager fallback as `attachment:open` |

## Workflows (20 channels)

The Workflows view. Every call names the workflow's home project; a task is addressed by its view key (its draft key before Start, its task id after). The handler routes reads and plan edits (list, supersessions, get, create, add, update and remove a task, link, route, positions) through `src/main/workflows/workflow-view-service.ts`, which shapes the read model and edits a planned workflow by key; every rule a started workflow has is enforced once, in `workflow-service.ts`, which the view service calls and the MCP tools reach directly (start, pause, resume, rename and delete go there straight).

| Channel | Pattern | Purpose |
|---------|---------|---------|
| `workflow:list` | invoke | The picker's rows: every unfinished workflow with its done, in progress, queued and blocked counts, and how many of its To Do tasks never started (`neverStartedCount`, for the Delete confirm) |
| `workflow:listSupersessions` | invoke | Every task of the project a workflow replaced at Start, by the workflow's current title and color, finished workflows included: the Done row's "Superseded by" line (`WorkflowRepository.listSupersessions`) |
| `workflow:get` | invoke | One workflow as the view draws it (`WorkflowDetail`): tasks with their route steps, links, card positions, each board's name and To Do and Done columns, and each task's plan approval (`WorkflowViewTask.planApproval`, a `TaskPlanApproval`: its own value, the value that applies, the plan columns' own, whether any plan column on its route runs an agent whose plans Kangentic can approve, the agent that cannot, or with a capable one on the route the agent whose plans still wait, the deciding column and whether the task has passed it; null with no plan column on its route) |
| `workflow:create` | invoke | New workflow, from a To Do task (its brief) or from nothing |
| `workflow:rename` | invoke | Rename a workflow |
| `workflow:setTaskPlanApproval` | invoke | A task's own Plan approval, from the inspector or task detail's Workflow panel, by task key: `automatic`, `manual`, or null to follow the plan columns on its route (`setViewPlanApproval`). The columns' own value is stored as null, except while the workflow still holds a legacy whole-workflow value, when the pick is stored as given. Before Start it edits the draft task; after, it writes the task row (`TaskRepository.setPlanApproval`), bumps the revision and announces the task's board. Refused for a task past its plan column or in Done, and any other value is refused |
| `workflow:delete` | invoke | Delete a workflow; once started, its unfinished tasks stay as ordinary tasks. With `{ deleteNeverStarted: true }`, the ones that never started are then deleted through the task delete (`deleteNeverStartedTasks`). Answers a `WorkflowDeleteReport` (`deleted`, `failed`); the renderer toasts the tasks it could not delete |
| `workflow:start` | invoke | Create the planned tasks in To Do and their links |
| `workflow:pause` | invoke | Pause every task's agent, a held task's included. Answers a `WorkflowPauseReport` (`paused`, `notLive`, `failed`); the renderer toasts the tasks it could not pause |
| `workflow:resume` | invoke | Resume every paused agent in its task's current column, and start one for an agent-column task with none (not a held task). Answers a `WorkflowResumeReport` (`resumed`, `started`, `alreadyRunning`, `failed`) |
| `workflow:addTask` | invoke | Add task: a planned task before Start, a task in To Do after |
| `workflow:updateTask` | invoke | Edit a planned task before Start |
| `workflow:removeTask` | invoke | Remove a task from the workflow (a planned one is gone; a created one stays on its board) |
| `workflow:setLink` | invoke | Link or unlink two tasks (one waits for the other to reach Done) |
| `workflow:setRoute` | invoke | A task's route, as the column ids it visits |
| `workflow:setPositions` | invoke | Where hands placed cards, or null for the automatic layout; any other payload is refused; changes no plan revision |
| `workflow:agentOpen` | invoke | The pane shows the workflow agent: an existing session as it is (a paused one stays paused), else a start that resumes its conversation by id, or continues from the saved plan when one is saved (`buildWorkflowAgentContinueMessage`), or sends the first message (`src/main/workflows/workflow-agent.ts`). A workflow with tasks and no agent ever recorded is checked first, before the setting. A start with the Workflow agent setting incomplete spawns nothing and answers `setupNeeded`, and the pane asks for the setting. A workflow with tasks and no agent ever recorded (another session created it over MCP) spawns nothing and answers `startsOnRequest`, and the pane offers Ask for changes |
| `workflow:agentResume` | invoke | The pane's Resume: start the paused agent again on its own conversation, on the Workflow agent's current model and effort, for a conversation on the chosen agent (`setupNeeded` as for an open). Also the pane's Ask for changes, which starts the agent on a saved plan no agent has seen |
| `workflow:agentPause` | invoke | The pane's Pause: suspend the agent, keeping its conversation (its spend is captured first) |
| `workflow:changed` | on | A workflow or its tasks changed, whoever changed it; an open view reloads it |

## Swimlanes (6 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `swimlane:list` | invoke | Fetch all swimlanes. An optional `projectId` reads another registered project's board (a workflow's planned task on it) |
| `swimlane:create` | invoke | Create swimlane with name, color, icon, role |
| `swimlane:update` | invoke | Update swimlane properties |
| `swimlane:delete` | invoke | Delete swimlane (blocked if has tasks) |
| `swimlane:reorder` | invoke | Reorder swimlanes by ID array |
| `swimlane:updatedByAgent` | on | Push event when an MCP agent changes a project's columns: a column create, update, or delete, or (reusing the same deliberately kind-agnostic signal) a same-column task reorder via `kangentic_reorder_tasks` / `kangentic_move_task`'s `position`, where no swimlane field itself changed |

## Automations (6 channels)

Replaced the `action:*` and `transition:*` channels, which had no renderer callers.

| Channel | Pattern | Purpose |
|---------|---------|---------|
| `automation:list` | invoke | Fetch every column's automations |
| `automation:replaceForColumn` | invoke | Replace one column's whole list (the Column Manager's Save) |
| `automation:runsForTask` | invoke | Run history for a task, newest first |
| `automation:runAgain` | invoke | Re-run ONE automation against the task's current state, writing a fresh run row |
| `automation:runFailed` | on | Push event when a run failed or was interrupted, rationed per automation |
| `automation:runsInterrupted` | on | Push event after the project-open sweep, one summary per open |

## Board Config (13 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `boardConfig:exists` | invoke | Check if `kangentic.json` exists for the active project |
| `boardConfig:export` | invoke | Export current board state to `kangentic.json` (auto-runs on project open, AFTER the open-time apply below) |
| `boardConfig:apply` | invoke | Apply pending config file changes (reconcile file into DB). The same apply also runs unprompted on project open when the file exists, before the export - see [Board Config Sync](../../settings/board-config.md#board-config-sync-kangenticjson) |
| `boardConfig:changed` | on | Event: `kangentic.json` or `kangentic.local.json` changed on disk |
| `boardConfig:warnings` | on | Event: the project-open reconcile's warnings for the board's warning banner, sent on every open (an empty list clears it) |
| `boardConfig:getLastWarnings` | invoke | The warnings of a project's last apply. The renderer fetches them each time a project becomes current, for the push it drops when it lands first (a launch restore, an open by folder path) |
| `boardConfig:getBoardProfiles` | invoke | Get the board's Board Profiles (see [Board config files](../../settings/board-config.md#board-profiles)). An optional `projectId` reads another registered project's board |
| `boardConfig:setBoardProfiles` | invoke | Replace the board's Board Profiles (team-scoped) |
| `boardConfig:boardProfilesChanged` | on | Event: an agent (MCP) rewrote this project's Board Profiles |
| `boardConfig:getShortcuts` | invoke | Get task detail dialog shortcuts |
| `boardConfig:setShortcuts` | invoke | Update task detail dialog shortcuts |
| `boardConfig:shortcutsChanged` | on | Event: shortcuts file changed |
| `boardConfig:setDefaultBaseBranch` | invoke | Set the team-shared default base branch in `kangentic.json` |
