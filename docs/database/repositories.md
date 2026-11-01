---
type: Reference
title: Repositories
description: Every repository class and its methods, including Project, Task (move, recordWorktree, archive, workflow membership), Swimlane, Automation and AutomationRun, Session, UsageHistory (per-leg delta SQL), Handoff, Transcript, attachments, backlog and DevPort (fails soft).
tags: [database, repositories, queries]
sources:
  - resource: src/main/db/repositories/
---
# Repositories

One repository class per table. All queries are synchronous (better-sqlite3). Transactions are used for position shifts (task move, task reorder, swimlane reorder, project reorder) to ensure consistent ordering. Task move and task reorder differ: `move()` shifts positions arithmetically and can leave gaps (archiving never renumbers), while `reorderWithinSwimlane()` rewrites a swimlane's positions densely to 0..N-1 in one pass, healing any gaps in the column it touches.

## ProjectRepository

Operates on the global DB. Uses `getGlobalDb()` internally -- no constructor argument needed.

| Method | Description |
|--------|-------------|
| `list()` | All projects ordered by position ASC |
| `getById(id)` | Single project by ID |
| `create(input)` | Insert at position 0, shifting all existing projects down |
| `getLastOpened()` | Most recently opened project (by `last_opened` DESC) |
| `updateLastOpened(id)` | Set `last_opened` to now |
| `rename(id, name)` | Rename a project |
| `delete(id)` | Delete and reindex positions to keep them contiguous (0..N-1) |
| `reorder(ids)` | Set positions from the ordered array of IDs |

## TaskRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `list(swimlaneId?)` | Active (non-archived) tasks, optionally filtered by swimlane. Includes `attachment_count` via LEFT JOIN on `task_attachments`. |
| `getById(id)` | Single task by ID (includes `attachment_count`) |
| `getBySessionId(sessionId)` | Find the active (non-archived) task that owns a given PTY session |
| `getByDisplayId(displayId)` | Single task by its `#N` display id, archived or not |
| `getByBranchName(branchName)` | The active (non-archived) task owning a local branch, most recently updated first. Maps a branch back to a task with no live session |
| `listByPRNumber(prNumber)` | Every task, archived included, whose `pr_number` is the given number, newest `updated_at` first. The PR linker's inferred tiers read it to refuse a PR another task on the board already holds; archived rows count because a Done task keeps its link |
| `listByBranchOrPushedBranch(branchName)` | Every task, archived included, holding the name as its `branch_name` or its `pushed_branch`, newest first. The PR linker's remote-tip tier reads it to refuse a branch another task owns before any PR exists for it |
| `create(input)` | Insert at the end of the target swimlane (next position). Transactional: allocates a monotonic `display_id` from `project_meta` in the same transaction as the INSERT |
| `nextPositionInSwimlane(swimlaneId)` | The raw append position past everything in a swimlane, archived rows included. `create()`'s append anchor, and what MCP task placement resolves an out-of-range ordinal slot against |
| `update(input)` | Partial update -- only provided fields are changed |
| `recordWorktree(id, path, branch, folder, resolvedBaseBranch?)` | Transactional write of `worktree_path`, `branch_name` and the write-once `worktree_folder` together, clearing `worktree_skip_reason` in the same transaction. Separate statements would leave a crash window where the path is set and the folder is not, which a later Done move would turn into permanent loss. The 5th parameter carries `createWorktree`'s observed base into `resolved_base_branch`, and is OMITTED from the write rather than nulled when absent, so a reattach that cannot observe a base (the pre-existing-branch path reports none) never erases what an earlier real creation recorded |
| `setWorktreeFolder(id, folder)` | Record the worktree's directory name. Write-once: guarded on `worktree_folder IS NULL`, so a task's worktree can never be relocated by a later write |
| `setWorktreeSkipReason(id, reason)` | Record why the last spawn ran without a worktree (a `WorktreeSkipReason`), or null once it has one. Does NOT bump `updated_at`: spawn telemetry must not reorder the board |
| `recoverLegacyWorktreeFolder(taskId, worktreesRoot)` | For a pre-numeric-scheme task whose `worktree_path` was already cleared by a Done move, recover and persist its original directory name from the newest `sessions.cwd`. Accepts only a direct child of `worktreesRoot`, so a project that is itself checked out at a worktree path cannot claim the enclosing worktree's name |
| `move(input, provenance)` | Transactional move: shift positions in old and new swimlanes, update task, and write the `task_moves` row in the same transaction. `provenance` (`{ origin, reason? }`) is required, so no caller moves a task without saying who moved it; a reorder within the column records nothing |
| `setWorkflowMembership(taskId, membership)` | Put a task in a workflow with its route and own plan approval, or take it out (`null`, which also clears its route, canvas place and plan approval). Does not bump `updated_at` |
| `setRoute(taskId, route)` | A workflow task's route (`route_start_swimlane_id`, `route_last_swimlane_id`, `skipped_swimlane_ids`). Does not bump `updated_at` |
| `setCanvasPosition(taskId, canvasX, canvasY)` | Where a hand placed the card on the Workflows canvas, or `null, null` for the auto layout. Never bumps `updated_at`, so a card drag costs no re-index |
| `setPlanApproval(taskId, planApproval)` | A workflow task's own plan approval (`plan_approval`), or null to follow the plan columns on its route. Does not bump `updated_at` |
| `listByWorkflow(workflowId)` | Every task of a workflow on this board, archived (Done) included, by display id |
| `listWorkflowMemberships()` | Distinct `{ workflow_id, workflow_project_id }` of this board's workflow tasks, archived included. What a project delete reads before its database goes |
| `releaseAllWorkflowMembers()` | Take every task on this board out of its workflow (the deleted board's own tasks, on a project delete). Returns the count; no `updated_at` |
| `releaseMembersOfHome(homeProjectId)` | Take this board's tasks out of every workflow homed in a deleted project, Done and archived included. Returns the count; no `updated_at` |
| `workflowIdsOnBoard()` | The ids of every workflow a task on this board belongs to, archived tasks and finished workflows included, as one covering read of `idx_tasks_workflow`. Its statement is prepared once per connection. The workflow engine asks it of each open board on every pass while a running or paused workflow exists, and runs `listByWorkflow` only where such a workflow's id comes back |
| `reorderWithinSwimlane(swimlaneId, orderedTaskIds)` | Dense rewrite of one swimlane's task order to 0..N-1 in a single transaction. The write behind `kangentic_reorder_tasks`, `kangentic_move_task`'s same-column `position`, and a restore from Done (`task:unarchive` and `task:bulk-unarchive` call it right after `unarchive()`, so a restored card lands at its slot or last, even on a lane with position gaps). Unlike `move()`'s two-shift arithmetic it heals position gaps left by archiving; a stray id from another swimlane is a no-op (`swimlane_id` guard), and re-issuing the same order writes nothing (`position != ?` guard, so `updated_at` moves only on rows that actually shift) |
| `archive(id)` | Set `archived_at` to now (soft-delete for Done column) |
| `unarchive(id, targetSwimlaneId, position)` | Clear `archived_at`, move to target swimlane and position |
| `clearArchived(id)` | Clear `archived_at` WITHOUT moving the task. The exact inverse of `archive(id)`, used by `task-move`s move-out-of-Done path, which has already placed the row and would fight `move()`s sibling reordering if it re-ran the placement |
| `listArchived()` | All archived tasks ordered by `archived_at` DESC |
| `listArchivedPreview(limit)` | The newest `limit` archived tasks plus the total archived count; cheap hydration for the Done column (full list loads lazily via `listArchived`) |
| `countAll()` | Bare `COUNT(*)` over every task, active and archived. For a caller that needs only the number: `list()` materializes every row plus the attachment-count join just to take `.length` |
| `countArchived()` | Bare `COUNT(*)` over archived tasks, the `listArchived()` counterpart of `countAll()`. `kangentic_list_columns` and `kangentic_get_column_detail` call it to report the done column's completed count (`kangentic_board_summary` prints the same number from the `listArchived()` it already loads for its label tally). A project-wide count stands in for one lane's because `archive()` has a single caller, the move-to-Done branch in `ipc/handlers/task-move.ts`, which runs only once the task's `swimlane_id` is the `role = 'done'` lane |
| `delete(id)` | Hard delete with position shift in the owning swimlane. Deletes the task's `session_messages_sent` rows first, held ones included, in the same transaction, without relying on the cascade |

## SwimlaneRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `list()` | All swimlanes ordered by position ASC. Maps integer columns to booleans (`is_archived`, `auto_spawn`). |
| `getById(id)` | Single swimlane by ID |
| `create(input)` | Insert before the `done` column (if any), otherwise at the end, shifting existing columns right. An explicit `position` is taken raw with no shift -- the caller (e.g. `handleCreateColumn`) is responsible for making room. |
| `update(input)` | Partial update -- only provided fields are changed |
| `reorder(ids)` | Set positions from ordered array. Enforces constraints: todo must be position 0, custom columns (role=null) cannot be position 0. |
| `delete(id)` | Delete a custom column. System columns (`todo`, `done`) cannot be deleted. Columns with tasks cannot be deleted. Also cleans up related transitions and dangling `plan_exit_target_id` references. |

## AutomationRepository

Operates on a per-project DB. Takes over from `ActionRepository`, whose IPC handlers were deleted.

| Method | Description |
|--------|-------------|
| `listAll()` | Every column's automations, which is what the renderer store holds |
| `listForColumn(columnId)` | One column's rows, all three groups, ordered by trigger then position |
| `getById(automationId)` | One automation by id, or null |
| `getForTrigger(columnId, trigger)` | That trigger's ENABLED rows in run order. The read the engine does on a move. |
| `replaceForColumn(columnId, automations)` | Whole-column delete-and-insert. `position` is assigned PER TRIGGER, so the three groups number from 0 independently and can never interleave. A supplied `id` is kept, so a row keeps its identity and its run history across an edit. |
| `deleteForColumn(columnId)` | Drop a column's rows. `SwimlaneRepository.delete` calls it explicitly, even though the foreign key cascades too. |

## AutomationRunRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `start(run)` | Write the `running` row before the attempt |
| `finish(id, status, detail, attempts)` | Close it on every exit path |
| `recordSkipped(run, reason)` | Write a row that opens and closes at once. A skip never ran, so it has no window to be interrupted in. |
| `recordDeliveredByCaller(run, detail)` | Write a `succeeded` row for a message the move delivered itself, in its own keystroke burst, so the run log shows it like every other run. |
| `hasWorkflowStepSince(taskId, swimlaneId, since)` | Has a workflow step check answered for this task in this column since `since`? A check writes its row after the reply it judged, so a resumed task's catch-up asks it with the reply's time to tell a judged reply from one a Pause or a quit left unjudged. |
| `recordWorkflowStep({ taskId, swimlaneId, workflowId, met, reason, detail, backgroundCallId })` | Record a workflow step check's answer, so "why did the task not move on" has an answer in the same log. Its automation id is `workflow-step:<workflowId>` and its type `workflow_step`, neither of which names a column automation; a yes that moved the task is `succeeded`, a no is `skipped`, each with the answer's reason and the detail the log shows. `backgroundCallId` names the check that gave the answer (`background_calls.id`): the retry's, when the first reply skipped the step. |
| `hasRunSince(automationId, taskId, since)` | Whether the automation has run on the task since `since`, the task's entry into the column. Counts executed runs only (`running`, `succeeded`, `failed`, `interrupted`), never a skip. A null `since` (no recorded entry) counts every run. The turn-end group's once-per-visit check. |
| `hasSkipSince(automationId, taskId, since, detail)` | Whether a `skipped` row with exactly this `detail` exists since `since`. A null `since` counts every such skip. Lets a turn-end group record "Set up an Automation agent", or a spent Frequency, once per visit rather than at every turn end. |
| `countRuns(automationId, taskId)` | How many executed runs the automation has on the task, across every visit since the newer of two `task_moves` rows: its newest move by a person (origin `renderer` or `mobile`) to another column, and its newest non-`rollback` row out of a `done` column. What Frequency (`max_runs`) checks. |
| `listForTask(taskId, limit)` | Everything that ran for one card, newest first, each with the check that answered it (`AutomationRun.check`, joined from `background_calls`) |
| `listForAutomation(automationId, limit)` | Every run of one automation, newest first, with its check. Across ALL tasks: it answers "did my automation work", not "what happened to this card". |
| `markStaleRunsInterrupted(startedBefore)` | Stamp every row still `running` and started before this time as `interrupted`. Returns the count, so the caller raises ONE summary push rather than one per row. |
| `pruneTo(limit, keepWorkflowIds)` | Keep the newest N rows, plus every counted run of an automation with a Frequency limit on a task that is not archived, so pruning never resets a limit, plus a workflow task's own rows in the column it is in now while it is not archived, so a restart's recovery rebuild still finds them, plus the newest enter run of a live task with no session record in the column it is in now (To Do and Done excepted), so the startup reconcile still sees that the column's enter group ran, plus every run of a task in one of `keepWorkflowIds` (default none). Nothing else bounds the table. The startup sweep (`sweepAutomationRuns` in `src/main/transition-engine/resource-cleanup.ts`) passes `workflowIdsKeepingRuns`, and prunes nothing on an open where that read fails, since a prune cannot be undone. |
| `workflowIdsKeepingRuns(now, keptElsewhere)` | The workflows whose tasks on this board keep every run (task #952): one still running or paused, or done for less than `WORKFLOW_RUNS_KEPT_AFTER_DONE_MS` (24 hours, `workflowKeepsRuns`), so the night a workflow ran can still be read the morning after. In an overnight workflow the newest 200 rows covered a few hours, and by morning the rest of the night was pruned. A workflow homed on this board is read here; one homed elsewhere is asked of `keptElsewhere`, which the sweep answers from the home's own database without creating one. A home that is gone keeps nothing, and one that cannot be read keeps everything. |
| `hasEnterRunSince(taskId, swimlaneId, since)` | Whether any enter automation of the column recorded a run on the task since `since` (the task's entry into the column; null counts every run), whatever its status. The startup reconcile reads it before it hands a task that never had an agent to the board path: a recorded run means the move reached its spawn and the agent failed to start, so the enter group must not run again. |

## BackgroundCallRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `record(call)` | Write one finished background call: job, task and column, agent, requested and reported model, effort, the four token counts and cost (NULL when the agent reports none), duration, outcome |
| `listGroups(since, until, groupMs)` | Calls grouped to fixed UTC buckets by job, agent and model (reported, else requested), with call, failure and reported counts and the summed tokens and cost. Empty when the table does not exist yet. The usage dashboard's Background read (`ProjectUsageReader.listBackgroundCallGroups`). |
| `listForTask(taskId)` | Every call made for one task, oldest first, with its job, column, model, effort, summed tokens, cost and duration. Empty when the table does not exist yet. The completed task view's Background calls card reads it for the calls no automation run names, except unnamed condition checks and workflow steps, which the card drops (a title, a task summary, or a terminal name). |

## TaskMoveRepository

Operates on a per-project DB. Reads `task_moves` only: `TaskRepository` writes the rows inside the
move's own transaction, so a move cannot land without its record.

| Method | Description |
|--------|-------------|
| `visitStartedAt(taskId, swimlaneId)` | When the task last entered this column (the newest row, rowid breaking a same-millisecond tie), or null when no entry was recorded. The visit boundary `hasRunSince` and `hasSkipSince` count from. It is `currentVisit`'s `at`. |
| `currentVisit(taskId, swimlaneId)` | The same newest row as `{ at, origin, from_swimlane_id }`, or null. The turn-end runner reads the origin so a plan approval's `auto-move` does not drop the turn it lands in as carried in from the last column, and the column the move came from so a drag into that column's plan exit target, made after the agent left plan mode, does not either. The startup To Do sweep reads it too, and keeps the worktree and branch of a task whose visit opened with `unarchive`. |
| `columnAt(taskId, atIso)` | The column the task's last recorded move at or before `atIso` took it to (rowid breaking a same-millisecond tie), or null when no move was recorded by then. `kangentic_move_task` reads it to find the column an agent's current turn began in, and refuses a `"next"` from the task's own agent once the task has left it. |
| `hasEnteredOtherLane(taskId, swimlaneId)` | Whether any recorded move took the task into a column other than this one. A move back to To Do wipes a task's sessions and worktree, so this is what `isNeverStarted` (`src/main/workflows/workflow-never-started.ts`) reads to keep a workflow task that once left To Do. |
| `listForTask(taskId)` | Every recorded move of one task, oldest first |
| `recentFinishedColumnVisits(doneSwimlaneId, limit)` | For the `limit` tasks that most recently entered Done, how many entered each column on the way. What `{{columns}}` tells a workflow's agent about how work moves through this board. |

## WorkflowRepository

Operates on the workflow's home project DB.

| Method | Description |
|--------|-------------|
| `getById(id)` | One workflow, or undefined |
| `listAll()` | Every workflow, newest first. MCP's `kangentic_list_workflows` with `includeFinished` |
| `listOpen()` | Every workflow not finished, newest first: the picker's rows |
| `listSupersessions()` | Every task a started workflow (running, paused or done) replaced at Start, as `{ sourceTaskId, workflowId, title, colorSlot }` with the workflow's current title. Read from `task_moves`: the source's latest move into a Done column must be Start's (origin `workflow`, reason beginning `SUPERSEDED_MOVE_REASON_PREFIX`, at or after `started_at`), credited to the workflow that started last at or before it. A source that left To Do before Start and was completed by hand is not listed |
| `hasActive()` | One indexed probe for a running or paused workflow, the engine's fast path for a board with no workflow to read. Its statement is prepared once per connection, since the engine asks it of every open board on every pass |
| `create({ title, brief, sourceTaskId })` | A new not-started workflow with an empty plan, "Untitled workflow" when no title, and the first free color slot |
| `saveDraft(id, draft, { title, expectedRevision })` | Replace a not-started workflow's plan (and title). A stale `expectedRevision` throws `StaleWorkflowRevisionError`, so the user's edits since the caller read it win |
| `writeDraftLayout(id, draft)` | Store where hands placed a not-started workflow's cards, leaving the revision alone: a card move changes no plan |
| `rename(id, title)` | Rename, bumping the revision |
| `markStarted(id)` | Running, the plan spent (its tasks now exist), `started_at` stamped |
| `setState(id, state)` | Running, paused or done; done stamps `finished_at`, paused stamps `paused_at`, and any other state clears it |
| `bumpRevision(id)` | Any change to a started workflow's tasks, links or routes |
| `setAgentConversation(id, conversation)` | The workflow agent's conversation (`agent_name`, `agent_session_id`, `agent_cwd`, and `agent_cli_target` when its CLI ran in a WSL distro), or null to forget it so the next open starts a new one. A null `agentSessionId` records an agent whose id is not known yet. The revision stays |
| `forgetAgentSessionId(id)` | Clear `agent_session_id` only, after a resume finds no conversation: the agent stays recorded, so the next start continues from the saved plan. The revision stays |
| `addAgentReadProject(id, projectId)` | Let the workflow agent read another registered project from now on; false when it already could. The revision stays |
| `setAgentGrid(id, grid)` / `getAgentGrid(id)` | The workflow agent's last PTY grid (`agent_pty_cols/rows`), or null before it has one. The revision stays |
| `writeAdoptedDraft(id, draft)` | Store a not-started workflow's plan with the legacy whole-workflow plan approval copied onto its tasks, leaving the revision alone: what each task gets did not change |
| `clearLegacyPlanApproval(id)` | Clear the legacy whole-workflow `plan_approval` once every task has its copy. The revision stays |
| `delete(id)` | Delete; its links cascade |

## TaskLinkRepository

Operates on the workflow's home project DB. Either end of a link can be a task in another
project's database, so nothing here reads a task.

| Method | Description |
|--------|-------------|
| `listForWorkflow(workflowId)` | A workflow's links, oldest first |
| `listBlockersOf(blockedTaskId)` | What a task waits for |
| `listBlockedBy(blockerTaskId)` | What waits for a task |
| `insert(link)` | Add a link; the same pair twice returns the link already there |
| `delete(blockerTaskId, blockedTaskId)` | Remove one link; true when there was one |
| `deleteForTask(taskId)` | Every link naming a task, either end (Remove from workflow) |
| `deleteForProject(projectId)` | Every link with an end on a deleted project's board; returns the workflows that lost one, read in the same transaction |

## ActionRepository (legacy, still present)

The reader and writer for `actions` and `swimlane_transitions`. Its IPC handlers are gone with the
`ACTION_*` and `TRANSITION_*` channels, which had zero renderer callers; `AUTOMATION_LIST` and
`AUTOMATION_REPLACE_FOR_COLUMN` took their place, and no move path reads these two tables any more.

The class itself is not deleted. Two callers remain: `apply-config.ts` still reconciles a
`kangentic.json` that carries the legacy `actions` and `transitions` keys, and
`automations-migration.ts` reads both tables once to convert them. A file written by an older build
therefore still round-trips, which is why `BoardConfig.actions` and `.transitions` became optional
rather than being removed.

## SessionRepository

Operates on a per-project DB.

| Method | Description |
|--------|-------------|
| `insert(record)` | Insert a new session record. Caller provides the `id` (PTY session ID = DB primary key, enabling unified session identity across the in-memory PTY layer and the database). `cli_target` and `start_head_sha` are optional and default to NULL. |
| `updateStatus(id, status, extra?)` | Update session status with optional `exit_code`, `suspended_at`, `exited_at`, `suspended_by` |
| `getResumable()` | Get suspended agent sessions that can be resumed (any `session_type` except `run_script`) |
| `markAllRunningAsOrphaned()` | Mark all `running` sessions as `orphaned` (crash recovery on startup) |
| `markRunningAsOrphanedExcluding(excludeTaskIds)` | Same as above but skips sessions whose task_id is in the exclusion set (prevents HMR re-entrant recovery from orphaning active sessions) |
| `getOrphaned()` | Get orphaned agent sessions (any `session_type` except `run_script`) |
| `deleteByTaskId(taskId)` | Delete all session records for a given task |
| `getLatestForTask(taskId)` | Find the most recent session record for a task (by `started_at` DESC) |
| `listForTaskNewestFirst(taskId)` | All session records for a task, newest first. Used by `captureGitChurn` to enumerate the full record-id list for `setTaskGitStats`. |
| `listTaskReportRecords(taskId)` | Every record of a task, newest first, with only the columns the completed task view's report reads (`TaskReportSessionRecord`). Leaves out `prompt` and `command`, which the report never reads. |
| `getLatestAgentSessionForTask(taskId)` | The newest record of a task that has an `agent_session_id`, with only `session_type`, `agent_session_id`, `cwd` and `cli_target`: what the completed task view's last-message read needs to find the transcript, in a WSL distro's home when the CLI ran there. Skips a newer record with no conversation id. |
| `listCliTargetsOfTasks(taskIds)` | The distinct stored `cli_target` JSON values the given tasks' sessions ran under, null left out. The task reap runs its in-distro pass in each WSL distro they name, which a session that ended before a restart still does. Queried in chunks, past SQLite's limit on bound parameters. |
| `getHeldPausedTaskIds()` | Get task IDs whose latest session is a held pause (`suspended_by` in `HELD_PAUSE_SOURCES`: `user`, `auto`, `low_memory`) |
| `listMemoryPausedTasks()` | Tasks whose latest session is a low-memory pause (`status = 'suspended'`, `suspended_by = 'low_memory'`), with `suspended_at`, oldest first. The workflow's memory resume reads it on each memory sampler tick to bring a running workflow's paused tasks back one at a time (`src/main/workflows/workflow-memory-resume.ts`). |
| `listIsolatedSince(taskId, sinceIso)` | The task's isolated-column sessions (`isolated_swimlane_id IS NOT NULL`) that started at or after `sinceIso`, oldest first, with only `id`, `isolated_swimlane_id`, `agent_session_id`, `start_head_sha` and `started_at` (`IsolatedRunRecord`). What ran while the task's main conversation was away, for its return recap ([Resume](../architecture/sessions/resume.md#a-return-to-the-main-conversation-opens-on-a-recap)). A column re-entered after a send-back, and two isolated columns in a row, are each one of them. |
| `listAllSessionIds()` | Get all distinct session record IDs (for stale session directory cleanup) |
| `updateGitStats(id, stats)` | Update `lines_added`, `lines_removed`, `files_changed` for a single session record, unconditionally. |
| `updatePtyGrid(id, grid)` | Write `last_pty_cols` / `last_pty_rows` for one record. Called from the `pty-resize` listener (`ipc/handlers/session-grid-persistence.ts`). Matches no row for a spawn announced before its insert, or for a Command Terminal session; both are harmless no-ops. |
| `listEarlierRunRecords(taskId, isolatedSwimlaneId, excludeRecordId)` | Every record on a session track (the task plus its isolated swimlane, null = main, any agent) except the live one, oldest first. Selects only the columns the track's totals and the Tokens fill read (`EarlierRunRecord`), since the tool-call popover reads its track on every tool call. |
| `getEarlierRunToolTotals(taskId, isolatedSwimlaneId, excludeRecordId)` | The summed `tool_call_count` and merged `tool_breakdown` of those records: what the context bar adds to the live run. |
| `hasEarlierRecordOfConversation(recordId, agentSessionId)` | Whether an earlier record shares this record's agent conversation, making it a resume. Gates the run-end count backfill for agents that cannot scope a transcript read. |
| `mergeTranscriptResultTokens(id, resultTokensByTool)` | Set transcript-derived `resultTokens` onto a record's stored rows by tool name, touching nothing else. Sets, never adds, so two writers of the same run cannot double it. |
| `markResultTokensRead(id)` | Stamp `result_tokens_read_at` after a Tokens read that answered but left the record nothing to keep. |
| `setTaskGitStats(recordIds, canonicalRecordId, stats)` | Mirrors `UsageHistoryRepository.setTaskGitStats`: writes churn to `canonicalRecordId` only and zeros every other id in `recordIds`, so `getSummaryForTask` / `listAllSummaries`'s `SUM(lines_added)` reflects the branch's actual churn instead of double-counting it across `--resume` records. |
| `getSummaryForTask(taskId)` / `listAllSummaries()` | One task's `SessionSummary`, or every task's keyed by id, from one shared statement: per conversation the `MAX` of the running cost and runtime, then summed across conversations; tokens from each conversation's latest row that reported tokens; churn over every row. See the `total_cost_usd` paragraph under the [`sessions` table](session-tables.md#sessions-table). |

## AttachmentRepository

Operates on a per-project DB. Manages both database records and files on disk under `<projectPath>/.kangentic/tasks/<taskId>/attachments/`.

| Method | Description |
|--------|-------------|
| `list(taskId)` | All attachments for a task ordered by `created_at` ASC |
| `getById(id)` | Single attachment by ID |
| `add(projectPath, taskId, filename, base64Data, mediaType)` | Decode base64 data, write file to disk, insert DB record. Filename is sanitized and prefixed with the attachment UUID. |
| `remove(id)` | Delete file from disk and DB record |
| `deleteByTaskId(taskId)` | Delete all attachments for a task (files + DB records). Attempts to clean up empty directories. |
| `getPathsForTask(taskId)` | Get file paths for all attachments on a task (for passing to Claude CLI) |
| `getDataUrl(id)` | Read file from disk and return as a `data:` URL with the correct media type |

## BacklogRepository

Operates on a per-project DB. Manages items in the Backlog View staging area.

| Method | Description |
|--------|-------------|
| `list()` | All backlog items ordered by position ASC |
| `getById(id)` | Single backlog item by ID |
| `create(input)` | Insert at the end (next position) |
| `update(input)` | Partial update - only provided fields are changed |
| `delete(id)` | Delete and shift positions to keep them contiguous |
| `reorder(ids)` | Set positions from ordered array of IDs |
| `bulkDelete(ids)` | Delete multiple items and reindex positions |
| `renameLabel(oldName, newName)` | Rename a label across all items |
| `deleteLabel(name)` | Remove a label from all items |
| `remapPriorities(mapping)` | Remap priority values across all items using a mapping |

## TranscriptRepository

Operates on a per-project DB. Manages ANSI-stripped session transcripts, stored as ordered pieces
in `session_transcript_chunks`; a legacy `session_transcripts` row not yet converted reads as the
oldest part. While such a row exists, every reader leaves out the pieces its conversion has
written so far (below seq 0, stamped with the row's `created_at` or `updated_at`), so a read
during the conversion returns that text once.

| Method | Description |
|--------|-------------|
| `appendChunk(sessionId, chunk)` | Insert one flush as the session's next piece (`seq` one past the last, never below 0), with its character and byte counts |
| `getTranscriptText(sessionId)` | The whole transcript, oldest first: any legacy row, then the pieces in `seq` order. Null when nothing was captured |
| `getTranscriptTail(sessionId, maxChars)` | The last `maxChars` characters plus the full length, size and dates. Reads the newest pieces until the budget is met, then a legacy row's own tail (`substr`) only if the budget still wants more, so a multi-MB transcript is never materialized |
| `getSizeBytes(sessionId)` | The transcript size in bytes (the pieces' sums plus any legacy row) without loading the content |

## HandoffRepository

Operates on a per-project DB. Tracks cross-agent context handoffs.

| Method | Description |
|--------|-------------|
| `insert(record)` | Insert a new handoff record |
| `updateToSession(id, toSessionId)` | Update the target session ID after the handoff spawn completes |
| `listByTaskId(taskId)` | List all handoff records for a task (ordered by `created_at` ASC) |
| `getLatestForTask(taskId)` | Get the most recent handoff record for a task |
| `getByFromSession(sessionId)` | Forward lookup: where did this session's context go? |
| `getByToSession(sessionId)` | Backward lookup: where did this session's context come from? |

## SentSessionMessageRepository

Operates on a per-project DB. The log of every message sent to a task's agent, and the store for messages held for a task with no running agent. Every status change on a held row is a compare-and-swap on `status = 'held'`, so a clear that ran first is never undone.

| Method | Description |
|--------|-------------|
| `insert(record)` | Record one send attempt against a session; `task_id` comes from the session row. Returns null and writes nothing when the session does not exist |
| `insertHeld(input)` | Hold a message for a task's next agent: a `held` row with a NULL `session_id` |
| `listHeldForTask(taskId)` | A task's `held` rows, oldest first, the order they go out in |
| `markDeliveredFromHold(ids, sessionId)` | Mark held rows `delivered_from_hold` and record the session that got them |
| `markHeldFailed(ids, error)` | Mark held rows `failed` when delivery began and did not finish |
| `markClearedForTask(taskId)` | Mark every row still `held` for the task `cleared` |
| `listForSession(sessionId)` | Every send attempt against a session, oldest first |
| `listForTask(taskId)` | Every send attempt across all of a task's sessions, held rows included |

## BacklogAttachmentRepository

Operates on a per-project DB. Manages both database records and files on disk under `<projectPath>/.kangentic/backlog/<backlogTaskId>/attachments/`. Mirrors `AttachmentRepository` for backlog tasks.

| Method | Description |
|--------|-------------|
| `list(backlogTaskId)` | All attachments for a backlog task ordered by `created_at` ASC |
| `getById(id)` | Single attachment by ID |
| `add(projectPath, backlogTaskId, filename, base64Data, mediaType)` | Decode base64 data, write file to disk, insert DB record. Syncs `attachment_count` on the parent backlog task. |
| `remove(id)` | Delete file from disk and DB record. Syncs `attachment_count`. |
| `deleteByTaskId(backlogTaskId)` | Delete all attachments for a backlog task (files + DB records). Attempts to clean up empty directories. |
| `getPathsForTask(backlogTaskId)` | Get file paths for all attachments on a backlog task |
| `getDataUrl(id)` | Read file from disk and return as a `data:` URL with the correct media type |

## UsageHistoryRepository

Operates on a per-project DB. Append-only ledger of finalized session usage. Decoupled from `sessions` and `tasks` so lifetime cost and token totals survive task deletion, bulk-archive, and revert-to-backlog.

| Method | Description |
|--------|-------------|
| `recordSessionUsage(input)` | Insert or UPSERT a history row keyed by `session_record_id`. UPSERT updates cost / tokens / duration / tool count / model / compaction-count fields on conflict but intentionally excludes git stat columns from the `DO UPDATE SET` clause (those are owned by `setTaskGitStats`). Called from `captureSessionMetrics` whenever `usage` is defined - including subscription-user sessions where `cost = 0` with real token counts. Takes the agent's RAW cumulative cost/duration readings plus the conversation lineage, then rewrites this leg AND every later leg of that lineage into per-leg deltas via `LINEAGE_DELTA_SET_SQL` (see the per-leg-delta paragraph in the [`usage_history` table](session-tables.md#usage_history-table) for why a flat SUM of the raw readings double-counted every `--resume`). Token columns hold the per-capture context-window SNAPSHOT, which is not a token count either; the dashboard reads `conversation_turn_usage` for tokens. |
| `updateGitStats(sessionRecordId, stats)` | Update `lines_added`, `lines_removed`, `files_changed` for a single history row, unconditionally. Silent no-op if no row exists for the given `sessionRecordId`. Superseded as the churn-write entry point by `setTaskGitStats` below; kept as the low-level single-row primitive. |
| `setTaskGitStats(recordIds, canonicalRecordId, stats)` | Write git churn to exactly ONE row per task lineage: `canonicalRecordId` gets `stats`, every other id in `recordIds` is zeroed. Called from `captureGitChurn` in `src/main/ipc/handlers/git-stats-capture.ts`, fired on every session finalization (suspend, move, handoff, respawn, natural exit) - not just move-to-Done - alongside the matching `SessionRepository.setTaskGitStats` call. Prevents the dashboard's flat SUM from double-counting a branch's cumulative churn across `--resume` records; a canonical row with no history entry (`changes === 0`) leaves siblings untouched rather than zeroing a real earlier capture. `captureGitChurn` writes nothing once the work has landed: when the task's `pr_state` is `merged`, or the task is archived and a non-zero capture is already stored. A branch reset onto its base after a merge would otherwise measure only what landed on top: one dogfooding task stored +38 -1 over its real +52,801 -2,054. |
| `getUsageTotals(since, until?)` | One-row SUM/COUNT/MIN/MAX aggregate over the `[since, until)` window (pass `null` since for "All Time"). Feeds the dashboard KPI totals, previous-period deltas, and per-project summaries. All read queries here filter on `session_started_at` (when work happened), not `recorded_at` (when metrics flushed), so Today/Week/Month semantics are preserved across midnight boundaries. |
| `listUsageRollup(since, until?, sinceMs?, untilMs?)` | `GROUP BY (model_id, model_display_name, agent, effort)` rollup over the window, ordered by each combo's earliest session. Feeds the by-model / by-agent / by-effort breakdowns (base-model-id merging stays in JS over O(dimension-combos) rows). COST comes from `usage_history` (the per-leg deltas); TOKENS come from a `conversation_turn_usage` CTE LEFT JOINed on the session and filtered `subagent_id IS NULL`, which is why both window forms are passed: the two ledgers key their windows differently (`session_started_at` ISO here, `ts` integer there). Known gap: a turn whose session has no ledger row in the window is dropped by the join, so a breakdown's tokens can fall slightly short of the Tokens tile, which counts every turn. |
| `listUsageCostGroups(since, until, groupMs)` | Window rows grouped to fixed UTC buckets of `groupMs` (15 minutes) per model - the cost-series input, folded to local chart buckets by `src/main/usage-stats/bucketing.ts`. |
| `countSessionsRepresented(since, until, ids)` | COUNT of the given `session_record_id`s already in the window's ledger - the live-session dedup for the SESSIONS KPI. |
| `sumSessionsRepresented(since, until, ids)` | The cost/token sibling of the COUNT above: how much the window's ledger ALREADY holds for those same live ids, returned as `UsageDashboardStats.liveLedgerBaseline`. The renderer subtracts it before layering its in-memory overlay, because the 45s metrics timer has already written a running session's reading into the ledger; without it the Cost tile counted every running session twice and floated above the breakdowns, which get no overlay. |

The aggregation is pushed into SQL (replacing the old raw-row `listRowsAfter` + JS fold) so the synchronous main-process JS work is O(buckets), not O(historical rows); the remaining folds live in the pure functions of `src/main/usage-stats/bucketing.ts`, consumed by the `USAGE_GET_DASHBOARD_STATS` IPC handler and the `kangentic_get_usage_stats` MCP tool via `usageStatsService`.

Each read is a retrieval worker call (`usage.read`), so two failures look alike and are handled apart. In an app-wide read, a project whose database read throws is listed in `skippedProjects`, and none of its reads reach the totals, because a project's reads join them only after every one has answered. A `RetrievalUnavailableError` is not that project's fault, since the worker answers every project or none. The service stops at the first one, logs a single line, and flags the payload `indexRestarting`. The dashboard keeps its last figures under one line saying the index is restarting, and its regular refetch picks the worker back up. The MCP tool returns an error.

## DevPortRepository

Operates on the global DB (`getGlobalDb()`), like `ProjectRepository`. Deliberately
narrow: every method has a live caller, and reads this table could support but
nothing asks for are left unwritten rather than kept warm.

| Method | Description |
|--------|-------------|
| `listForTask(taskId)` | Every port a task holds, lowest first |
| `getByTaskId(taskId)` | The task's lowest-numbered reservation, or null (what `{{port}}` resolves to) |
| `getByPort(port)` | The reservation on a port, or null |
| `claim(port, projectId, taskId)` | `INSERT OR IGNORE`; false when the port was taken between the caller's probe and this write, so a racing allocator retries the next candidate instead of throwing |
| `releaseByTaskId(taskId)` | Release every port a task holds |

Project removal releases that project's ports too, but does so with raw SQL inside
`ProjectRepository.delete`'s transaction (both tables live in the global DB and the
delete has to be atomic with it), so there is deliberately no `releaseForProject`
here.

Every method above **fails soft**: if the global database cannot be opened, each
returns its empty answer (`[]`, `null`, `false`) and logs once, rather than
throwing. That is a design property, not a convenience. This table is in the
GLOBAL database while its callers are per-project TASK paths - resolving
`{{port}}`, deleting a task - so a throw here would take an unrelated task
operation down with it. A row is advisory anyway (the bind probe is the
authority), so "the ledger is unreachable" correctly reads as "this task holds
no reservations".
