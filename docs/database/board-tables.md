---
type: Reference
title: Board tables
description: Columns, defaults, indexes and write rules for the board tables, covering swimlanes, tasks (worktree, PR, override pins, workflow route), column_automations, automation_runs, background_calls, workflows, task_links, task_moves, backlog, attachments, project_meta and remote_item_cache.
tags: [database, schema, tasks, swimlanes, automations]
sources:
  - resource: src/main/db/migrations/project-schema.ts
    title: board, automation, workflow and backlog tables
  - resource: src/main/db/migrations/automations-migration.ts
  - resource: src/main/db/repositories/remote-item-cache-repository.ts
  - resource: src/main/background-calls/record-background-call.ts
---
# Board tables

## swimlanes table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| name | TEXT | NOT NULL | |
| role | TEXT | | NULL |
| position | INTEGER | NOT NULL | |
| color | TEXT | NOT NULL | '#3b82f6' |
| icon | TEXT | | NULL |
| is_archived | INTEGER | NOT NULL | 0 |
| permission_mode | TEXT | | NULL |
| auto_spawn | INTEGER | NOT NULL | 1 |
| auto_command | TEXT | | NULL (retired) |
| auto_command_mode | TEXT | NOT NULL | 'immediate' (retired) |
| plan_exit_target_id | TEXT | | NULL |
| plan_approval | TEXT | NOT NULL | 'manual' |
| is_ghost | INTEGER | NOT NULL | 0 |
| agent_override | TEXT | | NULL |
| model_override | TEXT | | NULL |
| effort_override | TEXT | | NULL |
| handoff_context | INTEGER | NOT NULL | 0 |
| session_target | TEXT | NOT NULL | 'main' |
| session_spawn_strategy | TEXT | NOT NULL | 'create_or_resume' |
| created_at | TEXT | NOT NULL | |
| description | TEXT | | NULL |

Valid role values: `todo`, `done`, or NULL (custom column). The column has no CHECK constraint, and
roles that have since left the union (`planning`, `running`, `backlog`) genuinely shipped, so the
value is never trusted on the way in or out: `applyBoardConfigToDb` normalizes a role arriving from
`kangentic.json`, `SwimlaneRepository.mapRow` narrows on read via `normalizeSwimlaneRole`, and an
unconditional migration clears any stray value already on disk (migration 59). `role` is write-once
at create and is deliberately absent from `SwimlaneUpdateInput`.

Valid permission_mode values: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`,
`auto`, or NULL when the column sets none and the global `agent.permissionMode` applies (see
[Permission Mode Resolution](../settings/cascade.md#permission-mode-resolution-priority-order)).

`auto_command` and `auto_command_mode` are RETIRED. The column's message to its agent is a
`send_message` row in `column_automations` now; the automations migration moved every non-empty
value into one, nulled the first field and reset the second, and nothing reads either any more.
They are left in place so an older build can still open the database. The per-TASK `auto_command`
on `tasks` is unaffected and still MCP-only.

`plan_approval` is who approves a plan made in this column: `manual` (the user, in the agent's
terminal) or `automatic` (Kangentic, through the agent's plan approval hook). It is read only while
the column's `permission_mode` is `plan`, and `mapRow` reads any other stored value as `manual`. A
workflow task follows its own `plan_approval` instead, else the plan columns on its route (see the
`tasks` table above), and a task with `automations_disabled` set is always `manual`.

Per-column session model (two orthogonal axes; see `src/shared/types.ts` and [Isolated Sessions](../architecture/sessions/spawn-flow.md#isolated-sessions-per-column-session-model)):
- `session_target` (renamed from the original `session_strategy`): `main` (default, the task's main session) or `isolated` (a separate, context-isolated session keyed by the swimlane id). See `SessionTarget`.
- `session_spawn_strategy`: `create_or_resume` (default, resume the target track's session or spawn one) or `always_spawn_new` (always spawn fresh on entry, retiring the prior session for that `(task, target)`). See `SessionSpawnStrategy`. The fresh-vs-resume pairing with `session_target` is applied by the writers, not by `resolveForceFresh`: this column is `NOT NULL DEFAULT 'create_or_resume'` and `SwimlaneRepository.create` writes a concrete string, so the resolver's context-aware fallback never evaluates for a stored row. The two INTERACTIVE writers, the Column Manager and the MCP `create_column` / `update_column` handlers, route through `snapSpawnStrategyToTarget`, which moves this to `always_spawn_new` when a column becomes `isolated` and back when it returns to `main`, in both cases only while it still sits at the outgoing track's default. The `kangentic.json` sync is the exception: `apply-config.ts` applies each key exactly as the file gives it, with no pairing. That is harmless for a file the app wrote, since `build-config.ts` emits both keys whenever either is non-default, but a HAND-EDITED `kangentic.json` naming only `sessionTarget: isolated` applies as `isolated` + `create_or_resume`, which resumes one long review instead of running a fresh pass per entry. Spell both keys out when editing that file by hand.

## tasks table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| display_id | INTEGER | UNIQUE INDEX | NULL |
| title | TEXT | NOT NULL | |
| description | TEXT | NOT NULL | '' |
| swimlane_id | TEXT | NOT NULL, FK->swimlanes | |
| position | INTEGER | NOT NULL | |
| agent | TEXT | | NULL |
| session_id | TEXT | | NULL |
| worktree_path | TEXT | | NULL |
| worktree_folder | TEXT | | NULL |
| worktree_skip_reason | TEXT | | NULL |
| branch_name | TEXT | | NULL |
| pr_number | INTEGER | | NULL |
| pr_url | TEXT | | NULL |
| pr_state | TEXT | | NULL |
| pr_merge_readiness | TEXT | | NULL |
| head_sha | TEXT | | NULL |
| pushed_branch | TEXT | | NULL |
| resolved_base_branch | TEXT | | NULL |
| fork_point_sha | TEXT | | NULL |
| external_id | TEXT | | NULL |
| external_source | TEXT | | NULL |
| external_url | TEXT | | NULL |
| base_branch | TEXT | | NULL |
| use_worktree | INTEGER | | NULL |
| labels | TEXT | NOT NULL | '[]' |
| priority | INTEGER | NOT NULL | 0 |
| model_override | TEXT | | NULL |
| effort_override | TEXT | | NULL |
| agent_override | TEXT | | NULL |
| permission_mode | TEXT | | NULL |
| auto_command | TEXT | | NULL |
| auto_command_state | TEXT | | NULL |
| auto_command_text | TEXT | | NULL |
| auto_command_error | TEXT | | NULL |
| auto_command_at | TEXT | | NULL |
| profile_id | TEXT | | NULL |
| run_mode | TEXT | NOT NULL | 'column_settings' |
| automations_disabled | INTEGER | NOT NULL | 0 |
| detail_view_state | TEXT | | NULL |
| workflow_id | TEXT | | NULL |
| workflow_project_id | TEXT | | NULL |
| route_start_swimlane_id | TEXT | | NULL |
| route_last_swimlane_id | TEXT | | NULL |
| skipped_swimlane_ids | TEXT | | NULL |
| canvas_x | REAL | | NULL |
| canvas_y | REAL | | NULL |
| plan_approval | TEXT | | NULL |
| archived_at | TEXT | | NULL |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

Indexes: `idx_tasks_swimlane_position` on (swimlane_id, position), `idx_tasks_display_id` on (display_id) UNIQUE, `idx_tasks_session_id` on (session_id), `idx_tasks_external` on (external_source, external_id), `idx_tasks_workflow` on (workflow_id).

Valid permission_mode values: `default`, `plan`, `acceptEdits`, `dontAsk`, `bypassPermissions`,
`auto`, or NULL when the task pins none. A set value outranks the column's for the task's whole
life.

The eight workflow columns are NULL on an ordinary task. `workflow_id` names the task's workflow and
`workflow_project_id` the project whose database holds it (the task's own project unless the
workflow put it on another board). The route is `route_start_swimlane_id` (NULL: the first column
after To Do), `route_last_swimlane_id` (NULL: the column before Done) and `skipped_swimlane_ids` (a
JSON array, NULL for none), read through `src/shared/workflow-route.ts`. `canvas_x` / `canvas_y`
are where a hand placed the card on the Workflows canvas. None of them is in `update()`'s column
list: `setWorkflowMembership`, `setRoute`, `setCanvasPosition` and `setPlanApproval` write them
without bumping `updated_at`, so a canvas drag never re-indexes the task.

`plan_approval` is a workflow task's own plan approval: `automatic`, `manual`, or NULL. NULL
follows the plan columns on its route (a route column whose permission mode, after the task's Board
Profile, is `plan`): Automatic only when every one is Automatic and runs an agent that can approve
plans, Manual otherwise (`taskPlanApproval`, `src/shared/plan-approval.ts`). Where no plan column's
agent can approve plans it reads Manual whatever is stored. A value equal to the columns' own is
stored as NULL (`normalizeTaskPlanApproval`), so the task keeps following them. While the workflow
still holds a legacy value (`workflows.plan_approval`, below), NULL would read as that value, so a
pick is stored as given and following the columns is stored as their value. A copied legacy value
is kept as it was, so each task keeps the pick it had. Leaving the workflow clears it with the
other workflow columns, and a value this build does not know reads as NULL.

`worktree_folder` is the DIRECTORY NAME of the task's worktree, written once and never rewritten
(`TaskRepository.setWorktreeFolder` guards on `worktree_folder IS NULL`). New tasks get
`String(display_id)`; tasks predating that scheme keep their legacy `<slug>-<taskId8>` name. Whenever
`worktree_path` is non-null, `basename(worktree_path)` equals it. See
[Worktree lifecycle](../architecture/worktrees/worktree-lifecycle.md#worktree-directory-naming) for why the name has to be
stored rather than recomputed.

`worktree_skip_reason` records WHY the task's last spawn ran without a worktree, i.e. in the shared
project checkout: one of `'disabled' | 'not-a-repo' | 'nested-worktree' | 'no-commits' |
'remote-agent' | 'worktree-missing'` (the `WorktreeSkipReason` union), or NULL while the task has a
worktree or no spawn has decided yet. Written only by `TaskRepository.setWorktreeSkipReason` (spawn
telemetry, so no `updated_at` bump) and cleared by `recordWorktree`, a To Do reset, and a Done move;
the generic `update()` never touches it. It is the ground truth for any surface that wants to say
"running in the checkout the app runs from" rather than infer it from a null `worktree_path`, but
today it is recorded and exposed with no renderer reader: the 12px card glyph that drew it was
reviewed out as too small to tell apart. The task card's marker and the detail header's "Project
folder" chip still read `worktree_path`.
See [Worktree lifecycle](../architecture/worktrees/worktree-lifecycle.md#when-a-worktree-is-not-created).

`fork_point_sha` is the commit the task's branch was cut from, read from the branch tip right after
`createWorktree` cuts it (null when the worktree attached to a branch that already existed, since
that branch's start is not this task's). `recordWorktree` writes it in the same transaction as the
worktree, and clears it when it records a different branch with no fork point of its own.
`update()` clears it, in the same statement, whenever `branch_name` is set to null, so it follows
the branch's lifecycle: cleared at a To Do reset and a missing-worktree cleanup, kept at Done and
through a rename. Main reads it only
through `getForkPointSha`: `rowToTask` strips it, so it is not on the shared `Task`. The completed
task resolver (`git:taskChanges`) uses it as one candidate start of an unmerged branch's range,
beside the merge-base and the reflog's creation point.

`profile_id` names a Board Profile - a team-shared, named alternate set of per-column strategy
settings the task rides as it moves (see [Board Profiles](../settings/board-config.md#board-profiles)).
There is deliberately **no foreign key**: profile *definitions* live in `kangentic.json`, not this
database, so the profile is team-shared while the assignment stays per-machine runtime state. NULL
means "Default" - every column uses its own settings - and Default is synthetic: there is no stored
Default profile, so a board that has never used the feature needs no migration or backfill. An id
pointing at a profile a teammate deleted degrades to Default and logs once, rather than wedging the
task.

`run_mode` records which of the New Task / Edit dialog's two branches the user chose:
`'column_settings'` (follow each column as the task moves; `profile_id` selects which set of column
settings applies) or `'agent_override'` (pin agent/model/effort/permission for the task's whole
life). It is stored rather than derived from "does the task carry a pin", because Agent Override with
all four fields left on inherit writes exactly the same nulls as Column Settings while meaning the
opposite - the first locks all four on first spawn or on leaving To Do, the second never locks.
Deriving it silently dropped that choice on every save. The migration backfills `'agent_override'`
for any row that
already carries one of the four pins **and** has a NULL `profile_id`, reproducing the old derivation
exactly, so upgraded boards behave identically. The `profile_id IS NULL` clause is belt-and-braces -
a profile task cannot carry a pin, so it changes no row today - but it makes the backfill correct by
construction rather than by trusting an invariant enforced in another file.

`profile_id`, `run_mode`, and the four Advanced pins (`agent_override`, `model_override`,
`effort_override`, `permission_mode`) are **mutually exclusive**, enforced at write time in
`TaskRepository` (`applyProfileExclusivity`): setting the profile nulls all four pins and forces
`run_mode = 'column_settings'`; setting any of the four (or asking for `'agent_override'` directly)
nulls the profile and sets `run_mode = 'agent_override'`. That exclusivity is what keeps
`lockAdvancedOverridesOnFirstSpawn` correct - a profile task is never in override mode, so the
lock never fires for it. `auto_command` is deliberately **not** in the exclusivity set:
it is an MCP-only escape hatch, so a task may carry both a profile and its own auto-command, and it
never implies override mode.

`automations_disabled` (0/1, read as `Task.automations_disabled: boolean`) holds the task out of
every column's automations: see [Automation triggers > Disabling automations for one
task](../architecture/automations/triggers.md#disabling-automations-for-one-task). It is written by `create()` and
`update()`, and with no caller asking it is cleared only when the task joins a workflow
(`setWorkflowMembership()`). `move()` and `unarchive()` never touch it, out of a `done` column
too. A task already in a workflow can carry it: there it is the task's own hold out of its
workflow.

## schema_meta table

Key/value flags for data migrations that cannot answer "have I run" from the data itself.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| key | TEXT | PRIMARY KEY | |
| value | TEXT | NOT NULL | |

Three keys so far. The automations migration writes `automations_migrated_at`. That migration is one-way and deliberately
leaves its source rows in `actions` and `swimlane_transitions` for an older build to read, so the
presence of converted rows proves nothing: a board could legitimately have automations and no
transitions, or both.

`tool_breakdown_duration_repair` marks the one-time repair of `sessions.tool_breakdown` durations
saved while tool events were paired by name (`ipc/helpers/tool-breakdown-repair.ts`). After a cold
project open, the retrieval worker replays each finished record's own
`.kangentic/sessions/<id>/events.jsonl`, and main patches a row's `totalDurationMs` and
`waitedCount` only where the replay saw the same call counts. A record whose log was already pruned
keeps its stored values. The key is written only after every batch succeeds and every log that
exists was read to its end, so an open with the worker down retries the whole list next time.

`tool_breakdown_duration_repair_retry` holds a JSON array of the record ids whose log exists but
could not be read to its end (a lock, a permission error). The next open replays only those, and
the key is deleted when the repair flag is written.

Distinct from `project_meta`, which holds live per-project state (the `display_id` high-water
mark) rather than migration bookkeeping.

## column_automations table

What a column does when a task enters it, when its agent finishes a turn there, and when the task leaves it. Replaces the `actions` + `swimlane_transitions`
pair, which modelled a shared action referenced by N transitions; an automation belongs to exactly
one column.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| swimlane_id | TEXT | NOT NULL, FK->swimlanes ON DELETE CASCADE | |
| name | TEXT | NOT NULL | |
| type | TEXT | NOT NULL | |
| trigger | TEXT | NOT NULL | 'enter' |
| position | INTEGER | NOT NULL | |
| enabled | INTEGER | NOT NULL | 1 |
| config_json | TEXT | NOT NULL | |
| condition | TEXT | | NULL |
| max_runs | INTEGER | | NULL |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |
| final_line | TEXT | | NULL |

Valid types: `send_message`, `run_script`, `webhook`, `notify`, `move_to_column`, plus legacy
`spawn_agent` on boards that already had one. `trigger` is `enter`, `turn_end` (each time the
column's agent finishes a turn there) or `exit`. It is TEXT rather than a boolean, so the third
trigger was a new value rather than a migration. A row read with a trigger this build does not know
is skipped with a warning, never read as `enter`.

`condition` is the row's Condition in plain words, judged by the Automation agent before the row
runs; NULL (or blank) means the row always runs. `final_line` is the other kind of Condition, a
Text match: a pattern the agent's last line must match, checked in code with no agent call
(`src/shared/final-line-match.ts`). A row holds one kind. `AutomationRepository.replaceForColumn`
stores `final_line` only on a `turn_end` row and, when it is set, stores `condition` as NULL, so a
writer that slips past the editor, the file reader and the MCP refusals still cannot leave a row
with two checks or a Text match on a trigger with no final message. `max_runs` is its Frequency,
the most times it may run on one task across every visit since a person last moved the task to
another column, or it last left Done; NULL means no limit. All three are nullable so a build from
before them still inserts into a database that has them.

`position` is assigned PER TRIGGER, so each group numbers from 0 independently and the three can
never interleave.

The foreign key is genuine and enforced (`database.ts` sets `foreign_keys = ON`). The one on
`swimlane_transitions.from_swimlane_id` had to be dropped for its `'*'` wildcard; this table has no
wildcard. `SwimlaneRepository.delete` also cascades explicitly, rather than relying on a pragma
being set.

Indices:

- `idx_column_automations_lookup` on (swimlane_id, trigger, position) - the read the engine does on
  every move.
- `idx_column_automations_name` UNIQUE on (swimlane_id, name COLLATE NOCASE) - what makes per-column
  name uniqueness TRUE rather than merely validated in the editor, so a hand-edited `kangentic.json`
  or an MCP write cannot break it. `COLLATE NOCASE` folds ASCII only while the editor's
  `toLowerCase()` folds Unicode, so the editor rejects a superset, which is the safe direction. The
  migration dedupes names BEFORE creating this index, or it fails.

## automation_runs table

One row per execution, written `running` before the attempt and closed on every exit path. This is
the durable record; the failure toast is the rationed interruption, following
`auto-command-outcome.ts`.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| automation_id | TEXT | NOT NULL | |
| automation_name | TEXT | NOT NULL | |
| type | TEXT | NOT NULL | |
| task_id | TEXT | NOT NULL, FK->tasks ON DELETE CASCADE | |
| swimlane_id | TEXT | NOT NULL | |
| trigger | TEXT | NOT NULL | |
| status | TEXT | NOT NULL | |
| detail | TEXT | | |
| attempts | INTEGER | NOT NULL | 0 |
| started_at | TEXT | NOT NULL | |
| finished_at | TEXT | | |
| condition_met | INTEGER | | NULL |
| condition_reason | TEXT | | NULL |
| background_call_id | TEXT | | NULL |
| final_line_met | INTEGER | | NULL |
| final_line_reason | TEXT | | NULL |

`status` is `running`, `succeeded`, `failed`, `skipped`, or `interrupted`. `detail` carries the skip
reason, the error, or a one-line success (`HTTP 204`, `exit 0`). `condition_met` and
`condition_reason` hold the Automation agent's answer for a row with a Condition (1 or 0, and its
one-line reason), NULL for a row without one. `final_line_met` and `final_line_reason` hold a Text
match's result the same way, the reason quoting the line it read (`The final line reads "..."`).
They are separate columns, not `condition_met`, because the task report's Background calls rows
(`task-report-assemble.ts`) read `condition_met` as an Automation agent answer, and a Text match
makes no call. `background_call_id` names the `background_calls` row
of the check that answered it, or of a check that ran without answering (a timeout), so the run log
can show the check's model and tokens. One batched check answers several rows, so several runs
share an id. No foreign key: the call record outlives the run's 200-row prune, and a run from before
calls were recorded has none.

**What counts as a run.** A row "has run" (for a turn-end row's once-per-visit rule and for
Frequency) when it has a row here with status `running`, `succeeded`, `failed` or `interrupted`. A
`skipped` row, including a Condition that answered no or a Text match that missed, is not a run, so
the next trigger checks it again. Frequency counts only the runs since the newer of two `task_moves`
rows: the newest whose origin is `renderer` or `mobile` (a person) and whose `from_swimlane_id`
differs from its `to_swimlane_id`, and the newest whose `from_swimlane_id` is a `done` column and
whose origin is not `rollback`. A task a person sends back, or a reopened task, starts its limits
over. Moves by `agent`, `automation`, `auto-move` and `workflow` keep them. The project-open prune
keeps every counted run of an automation that has a Frequency limit, on a task that is not
archived, so pruning can never reset a limit.

`automation_name` and `type` are DENORMALIZED and there is no foreign key to `column_automations`:
a run log that empties itself when you rename or delete the automation is not a log.

**A workflow's own rows.** Six types name no column automation. Each sets `automation_id` to
`<prefix>:<workflowId>` and `trigger` to `turn_end`, since a read drops any other trigger. The
prefix is `workflow-step` for `workflow_step`, `workflow-stalled` for `workflow_stalled`,
`workflow-waiting` for `workflow_waiting`, and `workflow-recovery` for the other three
(`workflow_recovery`, `workflow_recovery_start`, `workflow_interrupt`).

| `type` | Written by | What it holds |
|--------|------------|---------------|
| `workflow_step` | the step check (`recordWorkflowStep`) | Its answer: `succeeded` (done) or `skipped` (not done) with `condition_met` 1 or 0. A check that could not answer has `condition_met` NULL: `failed` when the call failed, `skipped` once a visit when no Automation agent can run one. A NULL row judged nothing, so it never counts as an answer (`hasWorkflowStepSince`). |
| `workflow_recovery` | each recovery attempt (`recordWorkflowRecovery`) | `succeeded` for a nudge sent, rewritten to `failed` when its turn failed. Also `failed` for a nudge not delivered, or one whose keys reached a permission prompt (which does not count), and `skipped` for one held off while the user was there, or held once per low spell while memory read low. A restart counts these to resume the schedule. |
| `workflow_stalled` | the stall notice (`recordWorkflowStall`) | The notice's latch and the card's "Stalled" mark (`listStalledTasks`). `condition_reason` is why, and `attempts` holds the nudges that had run by then. |
| `workflow_waiting` | a wait on the user that was told (`recordWorkflowWaiting`) | The boundary a fresh recovery counts from, and what keeps a task waiting on a question from being armed again (`isWaitingOnUser`). |
| `workflow_recovery_start` | a recovery that starts over (`recordWorkflowRecoveryStart`) | After a stall, a turn recovery did not start stopped again. The row is where the next recovery counts from, so that stall gets its own nudges and its own notice. Also written, with its reason in `detail`, when Kangentic started the agent again after a restart and when a low-memory pause stopped it. |
| `workflow_interrupt` | the hang check (`recordWorkflowInterrupt`) | A turn shown working whose agent wrote nothing past its limit, interrupted with the CLI's own key. Never counted as a recovery attempt. |

Three indices, one per question the log is asked:

| Index | Columns | Serves |
|-------|---------|--------|
| `idx_automation_runs_task` | (task_id, started_at DESC) | A task's own run history, newest first (`automation:runsForTask`) |
| `idx_automation_runs_automation` | (automation_id, started_at DESC) | Runs by automation, newest first, for the MCP run history tool's per-automation listing (`listForAutomation`) |
| `idx_automation_runs_background_call` | (background_call_id) | How many runs one check answered, for the run log's check line |

**Project-open sweep.** In the same pass that runs `retryFailedDoneCleanups`, two things happen.
`markStaleRunsInterrupted(startedBefore)` stamps every row still `running` as `interrupted`, and
`pruneTo(200)` keeps the newest 200 rows per project, because nothing else bounds the table, plus
every counted run of an automation with a Frequency limit on a task that is not archived, plus a
workflow task's own rows (the six types above) in the column it is in now, while it is not
archived. Recovery rebuilds a parked task from those rows after a restart, which is when the
prune runs, and one board wrote 136 to 169 rows a day, so the newest 200 can be a single night.
It also keeps the newest enter run of a live task with no session record in the column it is in
now, when that column is not To Do or Done. The startup reconcile reads it to leave alone a task
whose agent failed to start after its enter group ran, rather than run that group again at every
launch, and the prune runs unawaited beside that reconcile.
And it keeps every run of a task in a workflow still running or paused, or done for less than 24
hours (`workflowIdsKeepingRuns`, task #952), so the night a workflow ran can still be read the
morning after. A workflow homed on another board is read from that board's own database. When
the sweep cannot tell which workflows keep their runs, it prunes nothing that open.
The sweep is required for honesty: `synchronous-shutdown.md` forbids awaiting a drain on quit, so a
`running` row at boot is a known orphan, and without this "these always run" is false on every
restart.

`startedBefore` is the process start time, and it is load-bearing rather than defensive. The sweep
runs on a COLD project open, which includes the boot-time activation of every OTHER project five
seconds in, and inside one project's activation block the sweep is fired without awaiting while that
same project's auto-spawn runs. An unbounded sweep would stamp a genuinely in-flight enter
automation as `interrupted` and raise a toast saying it did not finish.

Nothing is retried automatically, ever. A fired webhook and a half-run script are not safe to repeat
blind, so the user gets Run again on the row instead.

## background_calls table

One row per headless agent call Kangentic makes on the user's behalf, with what the CLI reported it
cost. None of these is a session, so none reaches `usage_history`. Written by
`startRecordedCall` (`src/main/background-calls/record-background-call.ts`) when the CLI settles,
including a check whose caller stopped waiting, since that run is still paid for.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| job | TEXT | NOT NULL | |
| task_id | TEXT | | |
| swimlane_id | TEXT | | |
| agent | TEXT | NOT NULL | |
| requested_model | TEXT | | |
| model | TEXT | | |
| effort | TEXT | | |
| input_tokens | INTEGER | | |
| cache_creation_input_tokens | INTEGER | | |
| cache_read_input_tokens | INTEGER | | |
| output_tokens | INTEGER | | |
| cost_usd | REAL | | |
| duration_ms | INTEGER | NOT NULL | |
| outcome | TEXT | NOT NULL | |
| detail | TEXT | | |
| started_at | TEXT | NOT NULL | |

`job` is `condition_check`, `workflow_step`, `task_summary` (one Knowledge Graph summary batch, about
ten tasks, so no `task_id`), `task_title` or `terminal_name`. `requested_model` is what Kangentic
asked for (NULL for the agent's default); `model` is what the CLI reported answering with, kept apart
because plan mode once rerouted a Haiku request to Sonnet. The token and cost columns are NULL,
never 0, for an agent whose CLI reports no usage. Claude and Antigravity report it today.
Antigravity reports tokens but no model, price or cache write, so its rows keep `model` and
`cost_usd` NULL and `cache_creation_input_tokens` 0. `outcome` is `succeeded`, `failed` or
`timed_out`, with the error in `detail`.

No foreign key to tasks: spend outlives a deleted task, as `usage_history`'s does. Rows are kept,
like `usage_history` and the turn ledger (about 200 calls a day on a busy board, roughly 10 to 15 MB
a year). The usage dashboard reads them through `listBackgroundCallGroups`, never into the session
figures.

| Index | Columns | Serves |
|-------|---------|--------|
| `idx_background_calls_started` | (started_at) | The dashboard's windowed group read |
| `idx_background_calls_task` | (task_id, started_at DESC) | A task's own calls |

## workflows table

A set of linked tasks with its own agent, in its HOME project's database. Its tasks live on their
own boards and point back with `tasks.workflow_id` / `workflow_project_id`.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| title | TEXT | NOT NULL | |
| brief | TEXT | | NULL |
| source_task_id | TEXT | | NULL |
| state | TEXT | NOT NULL | 'draft' |
| draft_json | TEXT | | NULL |
| color_slot | INTEGER | NOT NULL | 1 |
| revision | INTEGER | NOT NULL | 1 |
| created_at | TEXT | NOT NULL | |
| started_at | TEXT | | NULL |
| finished_at | TEXT | | NULL |
| agent_name | TEXT | | NULL |
| agent_session_id | TEXT | | NULL |
| agent_cwd | TEXT | | NULL |
| agent_cli_target | TEXT | | NULL |
| agent_read_project_ids | TEXT | NOT NULL | '[]' |
| agent_pty_cols | INTEGER | | NULL |
| agent_pty_rows | INTEGER | | NULL |
| paused_at | TEXT | | NULL |
| plan_approval | TEXT | | NULL |

`state` is `draft` (not started), `running`, `paused` or `done`; a value this build does not know
reads as paused, so the engine leaves it alone. A draft keeps its planned tasks and links in
`draft_json` (`WorkflowDraft`: tasks by local key, with their project, route, an optional board
task to take in, and their run settings in the task row's own columns: `base_branch`,
`use_worktree`, `run_mode`, `profile_id` and the four override pins, which Start copies onto the
task it creates; a draft saved before those existed reads them as the defaults) rather than as
rows on any board, so no board read has to filter planned work out;
Start creates the tasks and clears it. `revision` goes up on every save and edit, and
`kangentic_save_workflow` refuses a save that carries an older one. `color_slot` is the
`--kng-chart-N` slot of the workflow's icon, the first no unfinished workflow holds.
`agent_name` and `agent_session_id` are the workflow agent's conversation: the agent that holds it
and the id it resumes by. They live here rather than in `sessions`, whose `task_id` is a foreign
key to tasks, and they change no plan, so writing them leaves `revision` alone. Both are null until
the agent first starts. `agent_session_id` is also null while the agent's own id is not yet known,
and again after a resume finds no conversation to resume; `agent_name` stays set then, so the next
start begins a new conversation from the saved plan.

`agent_cwd` is the checkout that conversation ran in, rewritten at every start. The agent CLI keeps
the history under it (Claude keys the file by it), so the conversation viewer and
`kangentic_get_transcript` read the conversation through it, with no sessions row.

`agent_cli_target` is where that conversation's CLI ran when it was not this machine, as
`StoredCliTarget` JSON (a WSL distro and its homes), rewritten at every start like `agent_cwd`. The
history is in that distro's home, so the same two readers hand it to the adapter as the place to
read. NULL for this machine.

`agent_read_project_ids` is a JSON array of project ids: the other registered projects the workflow
agent asked to read (`kangentic_request_project_access`). It reads these, and every project its
workflow's tasks are on, through the adapter's readable directories (Claude's `--add-dir`). Kept,
so every later start and resume reads them; it changes no plan, so `revision` stays.

`agent_pty_cols` / `agent_pty_rows` are the workflow agent's last PTY grid, written on every resize the
desktop makes (`persistPtyGrid`), as a task session's are on `sessions.last_pty_cols/rows`. A start
with no grid measured (after a restart) spawns at it, so the agent's first frame is drawn at the
pane's size rather than the spawn default.

`paused_at` is when a paused workflow was paused, stamped by `setState` on Pause and cleared by
every other state, so it is set only while the workflow is paused. The Workflows picker reads it
for the paused row's "Paused yesterday 18:20". A workflow paused before the column existed has none.

`plan_approval` is legacy: one plan approval for every task in the workflow, which v0.47.0 to
v0.50.0 wrote from the inspector and `kangentic_save_workflow`. Nothing writes it now; plan approval
is per task (`tasks.plan_approval`, and `plan_approval` on each draft task). The first read of a
workflow that still holds one copies it onto every draft task and every unfinished task that has
no value of its own, on whichever board each sits, then clears it (`adoptLegacyPlanApproval`,
`src/main/plan-approval/workflow-plan-approval.ts`). A per-database migration cannot do this,
since a workflow's tasks can sit in other projects' databases. A board whose database will not
read leaves the value set, so the next read retries, and until it is cleared every reader takes it
as the value of a task that has none. The copy changes nothing a task gets, so it moves no
`revision` and announces nothing.

Index: `idx_workflows_state` on (state), so the engine's "anything running?" probe is one lookup.

## task_links table

"blocked waits for blocker to reach Done", in the workflow's home database.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| workflow_id | TEXT | NOT NULL, FK->workflows ON DELETE CASCADE | |
| blocker_project_id | TEXT | NOT NULL | |
| blocker_task_id | TEXT | NOT NULL | |
| blocked_project_id | TEXT | NOT NULL | |
| blocked_task_id | TEXT | NOT NULL | |
| created_at | TEXT | NOT NULL | |

No foreign key to tasks: either end can be a task in another project's database. A task delete
removes the links that name it in its own database (`TaskRepository.delete`). When that removal
failed, the engine drops a link whose end is provably gone (`linkEndState`): the task's row is
missing, it moved to another workflow, or its project is no longer registered. A blocker whose
project's database will not open still holds its task. Indexes: `idx_task_links_workflow`,
`idx_task_links_blocker`, `idx_task_links_blocked`, and `idx_task_links_pair` UNIQUE on
(blocker_task_id, blocked_task_id).

## task_moves table

Every column a task entered, one row per entry. It is the visit boundary turn-end automations count
from ("has this row run since the task came into the column?"), and a workflow task's step history.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| task_id | TEXT | NOT NULL, FK->tasks ON DELETE CASCADE | |
| from_swimlane_id | TEXT | | NULL |
| to_swimlane_id | TEXT | NOT NULL | |
| origin | TEXT | NOT NULL | |
| reason | TEXT | | NULL |
| at | TEXT | NOT NULL | |

Written by `TaskRepository` inside the same transaction as the move (`move`, `unarchive`, and a
create into a column), so no move lands without its record, including the ones that bypass
`handleTaskMove` (the Phase 3 rollback, unarchive, create). A reorder within a column writes
nothing. `origin` is who moved it: `renderer`, `agent`, `mobile`, `auto-move`, `automation`,
`workflow`, `rollback`, `unarchive` or `create`. `reason` is the Move to column row's name, or a
workflow's step. `from_swimlane_id` is NULL for a task born into the column.

There is no foreign key to `swimlanes`: deleting a column must not delete a task's history.

Indices: `idx_task_moves_task` on (task_id, at DESC) for a task's latest entry into a column, and
`idx_task_moves_to_column` on (to_swimlane_id, at DESC).

## actions table (retired)

Kept in the schema so an older build can still open the database, and never read after the
automations migration. Was: `id`, `name`, `type`, `config_json`, `created_at`.

## swimlane_transitions table (retired)

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| from_swimlane_id | TEXT | NOT NULL | |
| to_swimlane_id | TEXT | NOT NULL, FK->swimlanes | |
| action_id | TEXT | NOT NULL, FK->actions | |
| execution_order | INTEGER | NOT NULL | 0 |

Note: `from_swimlane_id` has no foreign key constraint. This allows a wildcard value (`*`) as the source, meaning the transition fires regardless of which column the task came from.

Index: `idx_transitions_from_to` on (from_swimlane_id, to_swimlane_id).

Retired with `actions`, and for the same reason: it is left in place only so an older build can
open the database. Every row was converted to a `column_automations` row on the `to` column by the
automations migration, and nothing reads either table now.

## task_attachments table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| task_id | TEXT | NOT NULL, FK->tasks ON DELETE CASCADE | |
| filename | TEXT | NOT NULL | |
| file_path | TEXT | NOT NULL | |
| media_type | TEXT | NOT NULL | |
| size_bytes | INTEGER | NOT NULL | |
| created_at | TEXT | NOT NULL | |

Index: `idx_task_attachments_task_id` on (task_id).

## backlog_tasks table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| title | TEXT | NOT NULL | |
| description | TEXT | NOT NULL | '' |
| priority | INTEGER | NOT NULL | 0 |
| labels | TEXT | NOT NULL | '[]' |
| position | INTEGER | NOT NULL | |
| external_id | TEXT | | NULL |
| external_source | TEXT | | NULL |
| external_url | TEXT | | NULL |
| sync_status | TEXT | | NULL |
| assignee | TEXT | | NULL |
| due_date | TEXT | | NULL |
| item_type | TEXT | | NULL |
| external_metadata | TEXT | | NULL |
| attachment_count | INTEGER | NOT NULL | 0 |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

Indexes: `idx_backlog_position` on (position), `idx_backlog_external` on (external_source, external_id).

## backlog_attachments table

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| id | TEXT | PRIMARY KEY | |
| backlog_task_id | TEXT | NOT NULL, FK -> backlog_tasks(id) ON DELETE CASCADE | |
| filename | TEXT | NOT NULL | |
| file_path | TEXT | NOT NULL | |
| media_type | TEXT | NOT NULL | |
| size_bytes | INTEGER | NOT NULL | |
| created_at | TEXT | NOT NULL | |

Index: `idx_backlog_attachments_task_id` on (backlog_task_id).

Mirrors `task_attachments` for backlog tasks. Files stored at `.kangentic/backlog/<backlogTaskId>/attachments/`. When a backlog task is promoted to a task, attachments are copied to `task_attachments` and backlog attachment files are cleaned up.

## project_meta table

Key/value bookkeeping for the project itself, distinct from `memory_meta` (which is scoped to the retrieval index). Holds `display_id_high_water`: the monotonic ceiling for `tasks.display_id` allocation.

`TaskRepository.create` allocates `max(storedHighWater, MAX(display_id)) + 1`. The stored counter is what makes numbering non-recycling: `delete()` is a hard `DELETE`, so a plain `MAX(display_id) + 1` handed a deleted task's number to the next one created. Since a worktree directory is named for its task's `display_id`, a recycled number could adopt the deleted task's leftover directory. Keeping `MAX(display_id)` in the calculation lets the counter self-heal if the row is lost or the database is restored from an older copy.

| Column | Type | Constraints |
|--------|------|-------------|
| key | TEXT | PRIMARY KEY |
| value | TEXT | NOT NULL |

## remote_item_cache table

Persistent cache of remote board items for the Import dialog, keyed by `(external_source, repository, external_id)`. It lets the dialog paint instantly on open (`backlog:importGetCached`, no network) and reconcile only items changed since the cache's high-water mark (`MAX(remote_updated_at)`, via `backlog:importReconcile`). Being in the per-project DB, it survives app restart and project switch. `alreadyImported` is never stored: it is re-stamped from the live backlog (`backlog_tasks` + `tasks`) on every read.

| Column | Type | Constraints | Default |
|--------|------|-------------|---------|
| external_source | TEXT | NOT NULL, PK | |
| repository | TEXT | NOT NULL, PK | |
| external_id | TEXT | NOT NULL, PK | |
| remote_updated_at | TEXT | NOT NULL | |
| state_category | TEXT | NOT NULL | |
| payload | TEXT | NOT NULL | |
| fetched_at | TEXT | NOT NULL | |

`payload` is the JSON-serialized list-level `ExternalIssue` (body is the description only; Azure DevOps comments are deferred to import time). `state_category` is the normalized `'open' | 'closed'` bucket, kept for a future SQL-level filter; the copy the dialog actually reads is `stateCategory` inside `payload`, so treat the payload as the source of truth and write both together. The column cannot simply be dropped: the table is created with `CREATE TABLE IF NOT EXISTS`, which does not reshape a database that already has it, so removing the column from the DDL would leave a NOT NULL column that every insert then omits. Retiring it needs its own migration. `remote_updated_at` mirrors `ExternalIssue.updatedAt`, canonicalized to UTC ISO 8601 on write because the column is TEXT and its MAX is compared lexicographically; that MAX is the incremental `since` watermark. `MIN(fetched_at)` is when the cache was last known complete, which is how the reconcile decides a provider with no cheap id listing is overdue for a full pass. Timestamps are UTC ISO 8601 written via `toISOString()`. The composite PK bounds every read to one source's rows (the `(external_source, repository)` prefix scan, and the MAX watermark and DESC sort within that range), so no separate index is needed at these sizes. Repository: `RemoteItemCacheRepository` (`src/main/db/repositories/remote-item-cache-repository.ts`).
